'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Card, Descriptions, Button, Space, Tag, Tabs, Table, message, Input, Divider, Popconfirm, Modal, DatePicker, Alert, Checkbox, InputNumber } from 'antd';
import { EditOutlined, ArrowLeftOutlined, FilePdfOutlined, SaveOutlined, MailOutlined, LogoutOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import MainLayout, { useAuth } from '../../../../components/Layout';
import useIsMobile from '../../../../hooks/useIsMobile';
import MobileCardList from '../../../../components/mobile/MobileCardList';
import SignStatusTag from '../../../../components/SignStatusTag';
import { leasing, pdf, utility, signature } from '../../../../lib/api';

const LEASE_TYPE_MAP = { 0: 'Fixed', 1: 'Month-to-Month' };
const CONTRACT_TYPE_MAP = { 1: 'MR (May Renew)', 2: 'MTM (Month To Month)', 3: 'NR (Not Renewing)', 4: 'UC (Unconfirmed)' };
const INVOICING_MAP = {
  'weekly': 'Weekly', '7': 'Weekly',
  'bi-weekly': 'Bi-Weekly', '14': 'Bi-Weekly',
  'monthly': 'Monthly', '30': 'Monthly',
  'quarterly': 'Quarterly', '90': 'Quarterly',
  'bi-annually': 'Bi-Annually', '180': 'Bi-Annually',
};

const READING_TYPE_LABELS = { 0: 'Move-In', 1: 'Move-Out', 2: 'Billing', 3: 'Monthly' };

export default function LeasingDetailPage() {
  const [lease, setLease] = useState(null);
  const [readings, setReadings] = useState([]);
  const [readingsLoading, setReadingsLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [settlement, setSettlement] = useState(null);
  const [settlementLoading, setSettlementLoading] = useState(false);
  const [settlementNotes, setSettlementNotes] = useState('');
  const [notesSaving, setNotesSaving] = useState(false);
  const [revisions, setRevisions] = useState([]);
  const [resendingSig, setResendingSig] = useState(false);
  const [sendingCheckin, setSendingCheckin] = useState(false);
  const [moveOutOpen, setMoveOutOpen] = useState(false);
  const [moveOutDate, setMoveOutDate] = useState(dayjs());
  const [moveOutNotes, setMoveOutNotes] = useState('');
  const [recordingMoveOut, setRecordingMoveOut] = useState(false);
  const [pushRows, setPushRows] = useState([]);          // rent still owed
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState(null);
  const router = useRouter();
  const params = useParams();
  const { hasPermission } = useAuth();
  const { isMobile } = useIsMobile();
  const canEdit = hasPermission ? hasPermission('LANDLORD/LEASING_EDIT') : false;
  const leaseId = params.id;

  useEffect(() => {
    loadLease();
  }, [leaseId]);

  const loadLease = async () => {
    try {
      const response = await leasing.get(leaseId);
      if (response.data.code === 200) {
        const data = response.data.data;
        setLease(data);
        if (data.unit_id) loadReadings(data.unit_id, data);
      }
    } catch (error) {
      message.error('Failed to load lease');
    } finally {
      setLoading(false);
    }
    // Load scheduled revisions in parallel; failure is non-fatal
    try {
      const res = await leasing.listRevisions(leaseId);
      if (res.data.code === 200) setRevisions(res.data.data || []);
    } catch (err) {
      // Likely the lease_revision table doesn't exist yet — silently ignore so
      // the page still renders pre-migration.
    }
  };

  // Resend the lease for signing — finds the most recent (pending) signature
  // request for this lease and re-emails it, REVIVING the link with a fresh
  // 14-day window even if the original one expired.
  const handleResendSignature = async () => {
    setResendingSig(true);
    try {
      const listRes = await signature.listForLease(leaseId);
      const requests = listRes.data?.data || [];
      // Most recent first; pick the active (sent/viewed) one.
      const active = requests.find(r => Number(r.status) === 1 || Number(r.status) === 2);
      if (!active) {
        message.info('No active signing request to resend. Use "Send Again" to create a new one.');
        return;
      }
      const res = await signature.resendRequest(active.id);
      if (res.data?.code === 200) {
        const exp = res.data.data?.expires_at ? dayjs(res.data.data.expires_at).format('YYYY-MM-DD') : null;
        message.success(`Resent to signer(s).${exp ? ` Link now valid until ${exp}.` : ''}`);
      } else {
        message.error(res.data?.message || 'Failed to resend');
      }
    } catch (err) {
      message.error(err.response?.data?.message || 'Failed to resend');
    } finally {
      setResendingSig(false);
    }
  };

  // Manually send the check-in email to the tenant now. Bypasses the
  // tenant_checkin toggle + the scheduler's date window — the click is the
  // intent. Can be re-sent.
  const handleSendCheckin = async () => {
    setSendingCheckin(true);
    try {
      const res = await leasing.sendCheckin(leaseId);
      if (res.data?.code === 200) {
        message.success(`Check-in email sent to ${res.data.data?.sent_to || 'tenant'}.`);
      } else {
        message.error(res.data?.message || 'Failed to send check-in email');
      }
    } catch (err) {
      message.error(err.response?.data?.message || 'Failed to send check-in email');
    } finally {
      setSendingCheckin(false);
    }
  };

  // Rent the tenant still owes for the rest of the ORIGINAL term. These invoices
  // don't exist yet (the scheduler only generates up to today) and could never be
  // created once end_date is shortened, so they're pushed as part of moving out.
  const previewSeq = useRef(0);
  const loadMoveOutPreview = async (d) => {
    const seq = ++previewSeq.current;      // ignore out-of-order responses
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const r = await leasing.moveOutPreview(leaseId, (d || dayjs()).format('YYYY-MM-DD'));
      if (seq !== previewSeq.current) return;
      const rows = r.data?.data?.invoices || [];
      setPushRows(rows.map(x => ({ ...x, selected: true })));
    } catch (e) {
      if (seq !== previewSeq.current) return;
      // An EMPTY list and a FAILED lookup must never look the same — otherwise
      // staff could close out a move-out believing no rent is owed.
      setPushRows([]);
      setPreviewError(e?.response?.data?.message || 'Could not check what rent is still owed.');
    } finally {
      if (seq === previewSeq.current) setPreviewLoading(false);
    }
  };

  const handleOpenMoveOut = () => {
    const today = dayjs();
    setMoveOutDate(today);
    setMoveOutNotes('');
    setPushRows([]);
    setMoveOutOpen(true);
    loadMoveOutPreview(today);
  };

  const handleRecordMoveOut = async () => {
    if (!moveOutDate) {
      message.error('Move-out date is required');
      return;
    }
    setRecordingMoveOut(true);
    try {
      const r = await leasing.moveOut(leaseId, {
        move_out_date: moveOutDate.format('YYYY-MM-DD'),
        notes: moveOutNotes,
        push_invoices: pushRows
          .filter(x => x.selected && Number(x.amount) > 0)
          .map(x => ({ due_on: x.due_on, amount: Number(x.amount) })),
      });
      const n = r.data?.data?.pushed_invoices?.length || 0;
      message.success(n > 0
        ? `Move-out recorded — ${n} invoice${n === 1 ? '' : 's'} issued for rent still owed`
        : 'Move-out recorded');
      setMoveOutOpen(false);
      loadLease();
    } catch (err) {
      message.error(err?.response?.data?.message || 'Failed to record move-out');
    } finally {
      setRecordingMoveOut(false);
    }
  };

  const loadSettlement = async () => {
    if (settlement) return; // already loaded
    setSettlementLoading(true);
    try {
      const res = await leasing.getSettlement(leaseId);
      if (res.data.code === 200) {
        setSettlement(res.data.data);
        setSettlementNotes(res.data.data.settlement_notes || '');
      }
    } catch (err) {
      message.error('Failed to load settlement data');
    } finally {
      setSettlementLoading(false);
    }
  };

  const saveNotes = async () => {
    setNotesSaving(true);
    try {
      await leasing.saveSettlementNotes(leaseId, settlementNotes);
      message.success('Notes saved');
    } catch (err) {
      message.error('Failed to save notes');
    } finally {
      setNotesSaving(false);
    }
  };

  const loadReadings = async (unitId, leaseData) => {
    setReadingsLoading(true);
    try {
      const res = await utility.getUnitReadings({ unit_id: unitId });
      const allReadings = res.data?.data || [];
      // Filter to only show readings within the lease period
      let filtered = allReadings;
      if (leaseData?.start_date) {
        const leaseStart = dayjs(leaseData.start_date).startOf('day');
        const leaseEnd = leaseData.end_date ? dayjs(leaseData.end_date).endOf('day') : null;
        filtered = allReadings.filter(r => {
          const readingDate = dayjs(r.reading_date);
          if (readingDate.isBefore(leaseStart)) return false;
          if (leaseEnd && readingDate.isAfter(leaseEnd)) return false;
          return true;
        });
      }
      // Add check-in meter as a Move-In reading if it exists
      if (leaseData?.check_in_meter != null) {
        filtered = [
          ...filtered,
          {
            id: `checkin-${leaseData.id}`,
            reading_date: leaseData.start_date,
            reading_value: leaseData.check_in_meter,
            reading_type: 0,
            meter_number: filtered[0]?.meter_number || '-',
            notes: 'Lease check-in meter',
          }
        ];
      }
      // Sort by date descending
      filtered.sort((a, b) => new Date(b.reading_date) - new Date(a.reading_date));
      setReadings(filtered);
    } catch (err) {
      // silently fail — unit may not have meters
    } finally {
      setReadingsLoading(false);
    }
  };

  const formatDate = (d) => {
    if (!d) return '-';
    return dayjs(d).format('YYYY-MM-DD');
  };

  const formatCurrency = (amount) => {
    if (amount == null || amount === '' || amount === 0) return '-';
    return `$${Number(amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  const leaseStatus = lease?.lease_status ?? (lease?.status === 1 ? 1 : 0);
  const isPending = lease?.lease_state === 'pending';
  const statusLabel = isPending ? 'PENDING' : leaseStatus === 2 ? 'Upcoming' : leaseStatus === 1 ? 'Active' : 'Inactive';
  const statusColor = isPending ? 'gold' : leaseStatus === 2 ? 'blue' : leaseStatus === 1 ? 'green' : 'red';
  const originalEndDate = lease?.end_date ? dayjs(lease.end_date) : null;
  const isEarlyMoveOut = originalEndDate && moveOutDate && originalEndDate.startOf('day').isAfter(moveOutDate.startOf('day'));

  // Confirm a pending lease: flips lease_state to 'active', fires deferred
  // rent + deposit invoices. Re-runs the overlap check first, so a friendly
  // error appears if a competing lease got confirmed in the meantime.
  const onConfirmLease = async () => {
    try {
      const r = await leasing.confirm(lease.id);
      if (r.data?.code === 200) {
        message.success('Lease confirmed — invoices will be generated.');
        loadLease();
      } else {
        message.error(r.data?.message || 'Failed to confirm lease');
      }
    } catch (e) {
      message.error(e.response?.data?.message || 'Failed to confirm lease');
    }
  };

  // Settlement tab content
  const renderSettlement = () => {
    if (settlementLoading) return <Card loading />;
    if (!settlement) return <div style={{ padding: 24, textAlign: 'center', color: '#999' }}>Loading settlement data...</div>;

    const s = settlement;
    // Negative = green, -1% to 1.5% = yellow, above 1.5% = red
    const pct = s.rent_diff_percent;
    const rentDiffColor = pct < 0 ? '#fff' : pct <= 1.5 ? '#000' : '#fff';
    const rentDiffBg = pct < 0 ? '#52c41a' : pct <= 1.5 ? '#ffffb8' : '#ff4d4f';

    const STATUS_MAP = { 0: { text: 'Open', color: 'blue' }, 1: { text: 'Paid', color: 'green' }, 2: { text: 'Overdue', color: 'red' } };
    const invoiceColumns = [
      {
        title: 'Status', dataIndex: 'status', key: 'status', width: 90,
        render: v => { const s = STATUS_MAP[Number(v)] || { text: '-', color: 'default' }; return <Tag color={s.color}>{s.text}</Tag>; }
      },
      { title: 'Date', dataIndex: 'due_on', key: 'due_on', width: 110, render: v => formatDate(v) },
      { title: 'Invoice #', dataIndex: 'invoice_code', key: 'invoice_code', width: 110 },
      {
        title: 'Category', dataIndex: 'category_name', key: 'category_name', width: 130,
        render: v => v || '-'
      },
      {
        title: 'Invoice Amount', dataIndex: 'amount', key: 'amount', width: 130, align: 'right',
        render: (v, row) => {
          const amt = Number(v);
          const isOutflow = Number(row.type) === 1;
          const display = formatCurrency(amt);
          return isOutflow ? <span style={{ color: '#ff4d4f' }}>-{display}</span> : display;
        }
      },
      {
        title: 'Payment Method', key: 'payment_method', width: 130,
        render: (_, row) => {
          if (!row.payments || row.payments.length === 0) return '-';
          return row.payments.map(p => p.payment_method_name || '-').join(', ');
        }
      },
      {
        title: 'Inflow / Outflow', key: 'inflow_outflow', width: 130, align: 'right',
        render: (_, row) => {
          if (!row.payments || row.payments.length === 0) return '-';
          const total = row.payments.reduce((sum, p) => sum + Number(p.amount), 0);
          const isOutflow = Number(row.type) === 1;
          const display = formatCurrency(total);
          return isOutflow ? <span style={{ color: '#ff4d4f' }}>-{display}</span> : display;
        }
      },
      {
        title: 'Notes', key: 'note', width: 200,
        render: (_, row) => {
          const notes = (row.payments || [])
            .map(p => p.payment_note)
            .filter(Boolean);
          if (notes.length === 0) return <span style={{ color: '#ccc' }}>-</span>;
          const text = notes.join(' | ');
          return (
            <div style={{ maxHeight: 60, overflowY: 'auto', fontSize: 12, lineHeight: '1.4' }}>
              {text}
            </div>
          );
        }
      },
      {
        // Pay button — opens the same payment-create page the tenant detail
        // page uses. Only shown for unpaid invoices (status !== 1). Status 1
        // is Paid; we display "-" instead of a redundant Pay action.
        title: 'Action', key: 'action', width: 80, align: 'center', fixed: 'right',
        render: (_, row) => {
          if (Number(row.status) === 1) return <span style={{ color: '#ccc' }}>-</span>;
          return (
            <Button
              type="link"
              size="small"
              onClick={() => router.push(`/accounting/invoices/payment/create?invoiceId=${row.id}`)}
            >
              Pay
            </Button>
          );
        }
      },
    ];

    const labelStyle = { fontWeight: 'bold', width: isMobile ? 140 : 220, padding: '6px 12px', fontSize: isMobile ? 12 : undefined };
    const valueStyle = { padding: '6px 12px', fontSize: isMobile ? 12 : undefined };

    return (
      <div>
        {/* Header Info */}
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: '0', border: '1px solid #f0f0f0', borderRadius: 6, marginBottom: 24 }}>
          <div style={{ display: 'flex', borderBottom: '1px solid #f0f0f0' }}>
            <div style={labelStyle}>Tenant:</div>
            <div style={valueStyle}>{s.tenant}</div>
          </div>
          <div style={{ display: 'flex', borderBottom: '1px solid #f0f0f0' }}>
            <div style={labelStyle}>Move-In Date:</div>
            <div style={valueStyle}>{formatDate(s.start_date)}</div>
          </div>
          <div style={{ display: 'flex', borderBottom: '1px solid #f0f0f0' }}>
            <div style={labelStyle}>Property:</div>
            <div style={valueStyle}>{s.property}</div>
          </div>
          <div style={{ display: 'flex', borderBottom: '1px solid #f0f0f0' }}>
            <div style={labelStyle}>Move-Out Date:</div>
            <div style={valueStyle}>{formatDate(s.end_date)}</div>
          </div>
          <div style={{ display: 'flex', borderBottom: '1px solid #f0f0f0' }}>
            <div style={labelStyle}>Unit:</div>
            <div style={valueStyle}>{s.unit}</div>
          </div>
          <div style={{ display: 'flex', borderBottom: '1px solid #f0f0f0' }}>
            <div style={labelStyle}>Rental Days:</div>
            <div style={valueStyle}>{s.rental_days}</div>
          </div>
          <div style={{ display: 'flex', borderBottom: '1px solid #f0f0f0' }}>
            <div style={labelStyle}>Monthly Rent:</div>
            <div style={valueStyle}>{formatCurrency(s.monthly_rent)}</div>
          </div>
          <div style={{ display: 'flex', borderBottom: '1px solid #f0f0f0' }}>
            <div style={labelStyle}>Check In Meter:</div>
            <div style={valueStyle}>{s.check_in_meter != null ? Number(s.check_in_meter).toLocaleString() : '-'}</div>
          </div>
          <div style={{ display: 'flex', borderBottom: '1px solid #f0f0f0' }}>
            <div style={labelStyle}>Check Out Meter:</div>
            <div style={valueStyle}>{s.check_out_meter != null ? Number(s.check_out_meter).toLocaleString() : '-'}</div>
          </div>
          <div style={{ display: 'flex', borderBottom: '1px solid #f0f0f0' }}>
            <div style={labelStyle}>Average Unit $/rate:</div>
            <div style={valueStyle}>{s.avg_unit_rate != null ? `$${s.avg_unit_rate.toFixed(2)}` : '-'}</div>
          </div>
          <div style={{ display: 'flex' }}>
            <div style={labelStyle}>Utility Usage:</div>
            <div style={valueStyle}>
              {s.total_utility_usage != null
                ? `${Number(s.total_utility_usage).toLocaleString()} kW`
                : '-'}
              {s.total_utility_cost != null ? ` (${formatCurrency(s.total_utility_cost)})` : ''}
            </div>
          </div>
        </div>

        {/* Invoices Table */}
        <h4 style={{ fontWeight: 'bold', marginBottom: 12 }}>INVOICES</h4>
        {isMobile ? (
          <MobileCardList
            dataSource={s.invoices}
            rowKey="id"
            emptyText="No invoices found for this lease"
            style={{ marginBottom: 24 }}
            renderCard={(row) => {
              const st = STATUS_MAP[Number(row.status)] || { text: '-', color: 'default' };
              const isOutflow = Number(row.type) === 1;
              const amt = formatCurrency(Number(row.amount));
              return (
                <Card size="small" styles={{ body: { padding: 12 } }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <Tag color={st.color}>{st.text}</Tag>
                    <span style={{ fontWeight: 500, color: isOutflow ? '#ff4d4f' : undefined }}>{isOutflow ? `-${amt}` : amt}</span>
                  </div>
                  <div style={{ fontSize: 12, color: '#666' }}>
                    <div>{row.invoice_code} {row.category_name ? `- ${row.category_name}` : ''}</div>
                    <div>{formatDate(row.due_on)}</div>
                    {row.payments && row.payments.length > 0 && (
                      <div style={{ marginTop: 4 }}><strong>Method:</strong> {row.payments.map(p => p.payment_method_name || '-').join(', ')}</div>
                    )}
                  </div>
                </Card>
              );
            }}
          />
        ) : (
          <Table
            columns={invoiceColumns}
            dataSource={s.invoices}
            rowKey="id"
            size="small"
            pagination={false}
            bordered
            style={{ marginBottom: 24 }}
            locale={{ emptyText: 'No invoices found for this lease' }}
          />
        )}

        {/* Summary Section */}
        <div style={{ maxWidth: isMobile ? '100%' : 600 }}>
          {/* Estimated Total Rent */}
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6, flexWrap: isMobile ? 'wrap' : undefined }}>
            <div style={{ fontWeight: 'bold', width: isMobile ? '100%' : 260, fontSize: isMobile ? 13 : undefined }}>ESTIMATED Total Rent:</div>
            <div style={{ padding: '4px 12px', background: '#52c41a', color: '#fff', fontWeight: 'bold', minWidth: isMobile ? 0 : 120, textAlign: 'right' }}>
              {formatCurrency(s.estimated_total_rent)}
            </div>
          </div>

          {/* Rent Received */}
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6, flexWrap: isMobile ? 'wrap' : undefined }}>
            <div style={{ fontWeight: 'bold', width: isMobile ? '100%' : 260, fontSize: isMobile ? 13 : undefined }}>RENT RECEIVED:</div>
            <div style={{ padding: '4px 12px', minWidth: isMobile ? 0 : 120, textAlign: 'right' }}>
              {formatCurrency(s.rent_received)}
            </div>
          </div>

          {/* Rent Received Difference */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 2, flexWrap: isMobile ? 'wrap' : undefined }}>
              <div style={{ fontWeight: 'bold', width: isMobile ? '100%' : 260, fontSize: isMobile ? 13 : undefined }}>RENT RECEIVED DIFFERENCE:</div>
              <div style={{
                padding: '4px 12px',
                background: rentDiffBg,
                color: Math.abs(s.rent_diff_percent) > 1 ? rentDiffColor : '#000',
                fontWeight: 'bold',
                minWidth: isMobile ? 0 : 120,
                textAlign: 'right',
              }}>
                {s.rent_diff_percent.toFixed(2)}%
              </div>
            </div>
            {s.rent_diff_percent > 1.5 && (
              <div style={{ marginLeft: isMobile ? 0 : 260, color: '#ff4d4f', fontSize: 12, fontStyle: 'italic' }}>
                *Make sure this number is NOT ABOVE 1.5%, Highlight to Chris / Alex if not*
              </div>
            )}
          </div>

          <Divider style={{ margin: '12px 0' }} />

          {/* Payments Received */}
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6, flexWrap: isMobile ? 'wrap' : undefined }}>
            <div style={{ fontWeight: 'bold', width: isMobile ? '100%' : 260, fontSize: isMobile ? 13 : undefined }}>PAYMENTS RECEIVED:</div>
            <div style={{ padding: '4px 12px', background: '#e6fffb', minWidth: isMobile ? 0 : 120, textAlign: 'right' }}>
              {formatCurrency(s.payments_received)}
            </div>
          </div>

          {/* Outstanding Payments */}
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16, flexWrap: isMobile ? 'wrap' : undefined }}>
            <div style={{ fontWeight: 'bold', width: isMobile ? '100%' : 260, fontSize: isMobile ? 13 : undefined }}>OUTSTANDING PAYMENTS:</div>
            <div style={{ padding: '4px 12px', minWidth: isMobile ? 0 : 120, textAlign: 'right' }}>
              {formatCurrency(s.outstanding_payments)}
            </div>
          </div>

          <Divider style={{ margin: '12px 0' }} />

          {/* Tenant Credits */}
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6, flexWrap: isMobile ? 'wrap' : undefined }}>
            <div style={{ fontWeight: 'bold', width: isMobile ? '100%' : 260, fontSize: isMobile ? 13 : undefined }}>TENANT CREDITS:</div>
            <div style={{ padding: '4px 12px', minWidth: isMobile ? 0 : 120, textAlign: 'right', color: s.tenant_credits < 0 ? '#ff4d4f' : undefined }}>
              {s.tenant_credits < 0 ? `-${formatCurrency(Math.abs(s.tenant_credits))}` : formatCurrency(s.tenant_credits)}
            </div>
          </div>

          {/* Security Deposit */}
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6, flexWrap: isMobile ? 'wrap' : undefined }}>
            <div style={{ fontWeight: 'bold', width: isMobile ? '100%' : 260, fontSize: isMobile ? 13 : undefined }}>SECURITY DEPOSIT:</div>
            <div style={{ padding: '4px 12px', background: '#e6fffb', minWidth: isMobile ? 0 : 120, textAlign: 'right' }}>
              {formatCurrency(s.security_deposit)}
            </div>
          </div>

          {/* Security Deposit Return */}
          <div style={{ marginBottom: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 2, flexWrap: isMobile ? 'wrap' : undefined }}>
              <div style={{ fontWeight: 'bold', width: isMobile ? '100%' : 260, fontSize: isMobile ? 13 : undefined }}>SECURITY DEPOSIT RETURN:</div>
              <div style={{ padding: '4px 12px', background: '#ffffb8', minWidth: isMobile ? 0 : 120, textAlign: 'right' }}>
                {formatCurrency(s.security_deposit_return)}
              </div>
            </div>
            {s.security_deposit_return > s.security_deposit && (
              <div style={{ marginLeft: isMobile ? 0 : 260, color: '#ff4d4f', fontSize: 12, fontStyle: 'italic' }}>
                *Security Deposit Return should ALMOST NEVER be more than the Security Deposit. Highlight to Chris / Alex if not*
              </div>
            )}
          </div>
        </div>

        <Divider style={{ margin: '16px 0' }} />

        {/* Notes Section */}
        <h4 style={{ fontWeight: 'bold', marginBottom: 12 }}>NOTES</h4>
        <Input.TextArea
          rows={4}
          value={settlementNotes}
          onChange={e => setSettlementNotes(e.target.value)}
          placeholder="Enter settlement notes..."
          style={{ marginBottom: 12, maxWidth: isMobile ? '100%' : 600 }}
        />
        <div>
          <Button
            type="primary"
            icon={<SaveOutlined />}
            onClick={saveNotes}
            loading={notesSaving}
          >
            Save Notes
          </Button>
        </div>
      </div>
    );
  };

  const tabItems = [
    {
      key: 'details',
      label: 'Details',
      children: (
        <>
        <Descriptions bordered column={isMobile ? 1 : 2}>
          <Descriptions.Item label="Lease No">{lease?.lease_no || '-'}</Descriptions.Item>
          <Descriptions.Item label="Property">{lease?.property_name || '-'}</Descriptions.Item>
          <Descriptions.Item label="Unit">{lease?.unit_name || '-'}</Descriptions.Item>
          <Descriptions.Item label="Primary Tenant">{[lease?.tenant_first_name, lease?.tenant_last_name].filter(Boolean).join(' ') || '-'}</Descriptions.Item>
          <Descriptions.Item label="Additional Tenants">
            {lease?.additional_tenants?.length > 0
              ? lease.additional_tenants.map(t => t.display_name?.trim()).join(', ')
              : '—'}
          </Descriptions.Item>
          <Descriptions.Item label="Lease Type">{LEASE_TYPE_MAP[lease?.type] || '-'}</Descriptions.Item>
          <Descriptions.Item label="Tenant Status">{CONTRACT_TYPE_MAP[lease?.contract_type] || '-'}</Descriptions.Item>
          <Descriptions.Item label="Status"><Tag color={statusColor}>{statusLabel}</Tag></Descriptions.Item>
          <Descriptions.Item label="Start Date">{formatDate(lease?.start_date)}</Descriptions.Item>
          <Descriptions.Item label="End Date">{formatDate(lease?.end_date)}</Descriptions.Item>
          <Descriptions.Item label="Monthly Rent">{formatCurrency(lease?.amount || lease?.price)}</Descriptions.Item>
          <Descriptions.Item label="Security Deposit">{formatCurrency(lease?.deposit)}</Descriptions.Item>
          <Descriptions.Item label="Monthly Utility Credit">{formatCurrency(lease?.utility_credit)}</Descriptions.Item>
          <Descriptions.Item label="Check In Meter">{lease?.check_in_meter != null ? Number(lease.check_in_meter).toLocaleString() : '-'}</Descriptions.Item>
          <Descriptions.Item label="Check Out Meter">{lease?.check_out_meter != null ? Number(lease.check_out_meter).toLocaleString() : '-'}</Descriptions.Item>
          {lease?.invoicing && (
            <Descriptions.Item label="Invoice Schedule">{INVOICING_MAP[String(lease.invoicing)] || lease.invoicing}</Descriptions.Item>
          )}
          {lease?.due_date && (
            <Descriptions.Item label="Due Date (Day of Month)">{lease.due_date}</Descriptions.Item>
          )}
          {lease?.first_invoice_date && (
            <Descriptions.Item label="First Invoice Date">{formatDate(lease.first_invoice_date)}</Descriptions.Item>
          )}
          {lease?.credits && (
            <Descriptions.Item label="Credits">{lease.credits}</Descriptions.Item>
          )}
          <Descriptions.Item label="Contact Phone">{lease?.contact_phone || lease?.tenant_phone || '-'}</Descriptions.Item>
          <Descriptions.Item label="Tenant Email">{lease?.tenant_email || '-'}</Descriptions.Item>
          <Descriptions.Item label="Booking Platform">{lease?.booking_platform_name || '-'}</Descriptions.Item>
          <Descriptions.Item label="Sales Agent">{lease?.sales_agent_name || '-'}</Descriptions.Item>
          {lease?.note && (
            <Descriptions.Item label="Notes" span={2}>{lease.note}</Descriptions.Item>
          )}
        </Descriptions>
        {revisions.length > 0 && (
          <div style={{ marginTop: 24, padding: 16, background: '#fafafa', border: '1px solid #f0f0f0', borderRadius: 6 }}>
            <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 12, color: '#555' }}>
              ⏰ Scheduled Rate Changes
            </div>
            {(() => {
              const today = new Date().toISOString().split('T')[0];
              const fmt = (n) => n == null ? '—' : `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
              const fmtDate = (d) => {
                if (!d) return '';
                const s = d instanceof Date ? d.toISOString().split('T')[0] : String(d).split('T')[0];
                return s;
              };
              const daysAway = (d) => {
                const s = fmtDate(d);
                if (!s) return 0;
                return Math.round((new Date(s) - new Date(today)) / 86400000);
              };
              return revisions.map(r => {
                const eff = fmtDate(r.effective_from);
                const isPast = eff <= today;
                const days = daysAway(eff);
                return (
                  <div key={r.id} style={{
                    padding: '10px 12px', marginBottom: 8, background: isPast ? '#fff' : '#fffbe6',
                    border: `1px solid ${isPast ? '#f0f0f0' : '#ffe58f'}`, borderRadius: 4, opacity: isPast ? 0.7 : 1
                  }}>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>
                      {isPast
                        ? `Past — effective ${eff} (superseded)`
                        : `Effective ${eff} (${days} day${days !== 1 ? 's' : ''} away)`}
                    </div>
                    <div style={{ marginTop: 4, fontSize: 13, color: '#555' }}>
                      {r.price != null && <div>Rent: <strong>{fmt(r.price)}</strong></div>}
                      {r.utility_credit != null && <div>Utility credit: <strong>{fmt(r.utility_credit)}</strong></div>}
                      {r.credits && <div>Credits: <strong>{r.credits}</strong></div>}
                      {r.deposit != null && <div>Deposit: <strong>{fmt(r.deposit)}</strong></div>}
                      {r.note && <div style={{ fontStyle: 'italic', color: '#888', marginTop: 4 }}>{r.note}</div>}
                    </div>
                  </div>
                );
              });
            })()}
            <div style={{ marginTop: 8, fontSize: 12, color: '#999' }}>
              Edit scheduled changes from the lease edit page.
            </div>
          </div>
        )}
        </>
      ),
    },
    {
      key: 'payments',
      label: 'Payments',
      children: renderSettlement(),
    },
    {
      key: 'meter-readings',
      label: 'Meter Readings',
      children: (
        <div>
          {(lease?.check_in_meter != null || lease?.check_out_meter != null) && (
            <div style={{ marginBottom: 16, padding: 12, background: '#fafafa', borderRadius: 6 }}>
              <Space size={isMobile ? 'middle' : 'large'} direction={isMobile ? 'vertical' : 'horizontal'}>
                {lease?.check_in_meter != null && (
                  <span><strong>Check In Meter:</strong> {Number(lease.check_in_meter).toLocaleString()}</span>
                )}
                {lease?.check_out_meter != null && (
                  <span><strong>Check Out Meter:</strong> {Number(lease.check_out_meter).toLocaleString()}</span>
                )}
                {lease?.check_in_meter != null && lease?.check_out_meter != null && (
                  <span><strong>Total Usage:</strong> {(Number(lease.check_out_meter) - Number(lease.check_in_meter)).toLocaleString()} kW</span>
                )}
              </Space>
            </div>
          )}
          {isMobile ? (
            <MobileCardList
              dataSource={readings}
              rowKey="id"
              loading={readingsLoading}
              emptyText="No meter readings recorded"
              renderCard={(row) => (
                <Card size="small" styles={{ body: { padding: 12 } }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span style={{ fontWeight: 500 }}>{dayjs(row.reading_date).format('MMM D, YYYY')}</span>
                    <Tag>{READING_TYPE_LABELS[Number(row.reading_type)] || '-'}</Tag>
                  </div>
                  <div style={{ fontSize: 12, color: '#666' }}>
                    <div><strong>Meter #:</strong> {row.meter_number}</div>
                    <div><strong>Reading:</strong> {Number(row.reading_value).toLocaleString()}</div>
                    {row.notes && <div><strong>Notes:</strong> {row.notes}</div>}
                  </div>
                </Card>
              )}
            />
          ) : (
            <Table
              columns={[
                { title: 'Date', dataIndex: 'reading_date', key: 'date', render: v => dayjs(v).format('MMM D, YYYY') },
                { title: 'Meter #', dataIndex: 'meter_number', key: 'meter' },
                { title: 'Reading', dataIndex: 'reading_value', key: 'value', render: v => Number(v).toLocaleString() },
                { title: 'Type', dataIndex: 'reading_type', key: 'type', render: v => <Tag>{READING_TYPE_LABELS[Number(v)] || '-'}</Tag> },
                { title: 'Notes', dataIndex: 'notes', key: 'notes', render: v => v || '-' },
              ]}
              dataSource={readings}
              rowKey="id"
              size="small"
              loading={readingsLoading}
              locale={{ emptyText: 'No meter readings recorded' }}
            />
          )}
        </div>
      ),
    },
  ];

  const leaseTitle = lease?.lease_no || `#${leaseId}`;

  return (
    <MainLayout>
      <Space direction="vertical" style={{ width: '100%' }} size="large">
        <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', justifyContent: 'space-between', alignItems: isMobile ? 'stretch' : 'center', gap: isMobile ? 8 : 0 }}>
          <Button icon={<ArrowLeftOutlined />} onClick={() => router.push('/leasing')}>Back to Leases</Button>
          <Space wrap>
            <Button icon={<FilePdfOutlined />} onClick={() => window.open(pdf.leaseUrl(leaseId), '_blank')}>View Lease</Button>
            {lease?.pdf_status && <SignStatusTag status={lease.pdf_status} />}
            <Button
              icon={<FilePdfOutlined />}
              onClick={() => router.push(`/leasing/${leaseId}/review-and-send`)}
              type={isPending ? 'primary' : 'default'}
            >
              {lease?.signed_file_id ? 'View Signed Lease' : 'Generate Lease for E-Signature'}
            </Button>
            <Popconfirm
              title="Send check-in email now?"
              description={`This emails the check-in details to ${lease?.tenant_first_name || 'the tenant'} immediately, regardless of the scheduled timing.`}
              okText="Send"
              onConfirm={handleSendCheckin}
            >
              <Button icon={<MailOutlined />} loading={sendingCheckin}>Send Check-in Email</Button>
            </Popconfirm>
            {canEdit && <Button icon={<LogoutOutlined />} onClick={handleOpenMoveOut}>Move out</Button>}
            {canEdit && <Button type="primary" icon={<EditOutlined />} onClick={() => router.push(`/leasing/${leaseId}/edit`)}>Edit Lease</Button>}
          </Space>
        </div>
        <Modal
          title="Record move-out"
          open={moveOutOpen}
          onCancel={() => setMoveOutOpen(false)}
          onOk={handleRecordMoveOut}
          okText="Record move-out"
          confirmLoading={recordingMoveOut}
        >
          <Space direction="vertical" style={{ width: '100%' }} size="middle">
            <div>
              <div style={{ marginBottom: 6, fontWeight: 500 }}>Move-out date</div>
              <DatePicker
                value={moveOutDate}
                onChange={(d) => { setMoveOutDate(d); if (d) loadMoveOutPreview(d); }}
                style={{ width: '100%' }}
              />
            </div>

            {/* Rent still owed for the rest of the original term. These invoices
                don't exist yet and can't be created once the lease is shortened,
                so they're issued here. Amounts are editable — the settlement is
                negotiated case by case. */}
            {previewError && (
              <Alert
                type="warning"
                showIcon
                message={`${previewError} Check the tenant's invoices manually before finalising — this is NOT a confirmation that nothing is owed.`}
              />
            )}

            {(previewLoading || pushRows.length > 0) && (
              <div>
                <div style={{ marginBottom: 6, fontWeight: 500 }}>
                  Rent still owed {previewLoading && <span style={{ fontWeight: 400, color: '#999' }}>· loading…</span>}
                </div>
                {pushRows.length > 0 && (
                  <>
                    <div style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>
                      These invoices haven&apos;t been issued yet. Tick the ones to bill —
                      once the lease is shortened they can no longer be generated.
                    </div>
                    <div style={{ border: '1px solid #f0f0f0', borderRadius: 4 }}>
                      {pushRows.map((row, i) => (
                        <div key={row.due_on} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderBottom: i < pushRows.length - 1 ? '1px solid #f5f5f5' : 'none' }}>
                          <Checkbox
                            checked={row.selected}
                            onChange={(e) => setPushRows(rows => rows.map((r, j) => j === i ? { ...r, selected: e.target.checked } : r))}
                          />
                          <span style={{ flex: 1, fontSize: 13 }}>
                            Due {row.due_on}
                            <span style={{ color: '#999', marginLeft: 6, fontSize: 11 }}>
                              {row.period_start} → {row.period_end}
                            </span>
                          </span>
                          <InputNumber
                            size="small"
                            style={{ width: 120 }}
                            min={0}
                            value={row.amount}
                            onChange={(v) => setPushRows(rows => rows.map((r, j) => j === i ? { ...r, amount: v } : r))}
                          />
                        </div>
                      ))}
                    </div>
                    <div style={{ textAlign: 'right', marginTop: 6, fontSize: 13, fontWeight: 600 }}>
                      Total to bill: HK${pushRows.filter(r => r.selected).reduce((s, r) => s + (Number(r.amount) || 0), 0).toLocaleString()}
                    </div>
                  </>
                )}
              </div>
            )}
            <div>
              <div style={{ marginBottom: 6, fontWeight: 500 }}>Notes</div>
              <Input.TextArea
                rows={4}
                value={moveOutNotes}
                onChange={(e) => setMoveOutNotes(e.target.value)}
                placeholder="e.g. Moved out early, paid until 31 Aug, keys returned, forwarding address ..."
              />
            </div>
            {isEarlyMoveOut && (
              <Alert
                type="warning"
                showIcon
                message={`This lease runs to ${originalEndDate.format('DD MMM YYYY')}. Moving out earlier stops future rent invoices from being generated — if the tenant still owes rent for that period, issue those invoices before completing the move-out.`}
              />
            )}
          </Space>
        </Modal>
        {/* E-Signature status card — visible only when there's any signing
            activity. Status badge + link to view signed PDF (if completed) or
            the active signing request. */}
        {(lease?.signature_status && lease.signature_status !== 'none') && (
          <Card size="small" style={{ borderColor: lease.signature_status === 'signed' ? '#52c41a' : '#1677ff' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div>
                <strong>E-Signature:</strong>{' '}
                {lease.signature_status === 'pending' && <Tag color="blue">Pending — waiting for signers</Tag>}
                {lease.signature_status === 'signed' && <Tag color="green">Signed{lease.signed_at ? ` on ${dayjs(lease.signed_at).format('YYYY-MM-DD')}` : ''}</Tag>}
                {lease.signature_status === 'declined' && <Tag color="red">Declined</Tag>}
              </div>
              <Space>
                {lease.signed_file_id && (
                  <Button onClick={() => window.open(`/api/file/preview/${lease.signed_file_id}`, '_blank')}>
                    View Signed Lease
                  </Button>
                )}
                {lease.signature_status === 'pending' && (
                  <Button loading={resendingSig} onClick={handleResendSignature}>
                    Resend to Signer
                  </Button>
                )}
                <Button onClick={() => router.push(`/leasing/${leaseId}/review-and-send`)}>
                  {lease.signature_status === 'pending' ? 'Manage Request' : 'Send Again'}
                </Button>
              </Space>
            </div>
          </Card>
        )}

        {/* Pending banner — prominently flags drafts that haven't been
            confirmed. Clicking "Confirm Lease" flips state to active and
            fires the deferred rent + deposit invoices. */}
        {isPending && (
          <Card
            size="small"
            style={{ background: '#fffbe6', borderColor: '#faad14' }}
            bodyStyle={{ padding: '12px 16px' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div>
                <Tag color="gold" style={{ fontWeight: 600, marginRight: 8 }}>PENDING</Tag>
                <span style={{ color: '#874d00' }}>
                  This lease is a draft. Invoices haven't been generated yet. Click <strong>Confirm Lease</strong> once the deposit is received and the agreement is signed.
                </span>
              </div>
              <Popconfirm
                title="Confirm this lease?"
                description="This will generate rent + deposit invoices and mark the lease active. Cannot be undone (you'd need to delete invoices manually)."
                okText="Confirm Lease"
                okType="primary"
                onConfirm={onConfirmLease}
              >
                <Button type="primary">Confirm Lease</Button>
              </Popconfirm>
            </div>
          </Card>
        )}

        <Card title={`Lease ${leaseTitle}`} loading={loading}>
          {lease && (
            <Tabs
              items={tabItems}
              onChange={(key) => {
                if (key === 'payments') loadSettlement();
              }}
            />
          )}
        </Card>
      </Space>
    </MainLayout>
  );
}
