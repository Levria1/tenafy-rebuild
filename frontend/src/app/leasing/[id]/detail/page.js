'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Card, Descriptions, Button, Space, Tag, Tabs, Table, message, Input, Divider, Popconfirm, Modal, DatePicker, Alert, Checkbox, InputNumber, Upload, Dropdown, Menu, Tooltip } from 'antd';
import { EditOutlined, ArrowLeftOutlined, FilePdfOutlined, SaveOutlined, MailOutlined, LogoutOutlined, CalendarOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import MainLayout, { useAuth } from '../../../../components/Layout';
import useIsMobile from '../../../../hooks/useIsMobile';
import MobileCardList from '../../../../components/mobile/MobileCardList';
import SignStatusTag from '../../../../components/SignStatusTag';
import { leasing, pdf, utility, signature, file as fileApi, advertisingApi } from '../../../../lib/api';

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
  const [cancellingSig, setCancellingSig] = useState(false);
  const [sendingCheckin, setSendingCheckin] = useState(false);
  const [moveOutOpen, setMoveOutOpen] = useState(false);
  const [moveOutDate, setMoveOutDate] = useState(dayjs());
  const [moveOutNotes, setMoveOutNotes] = useState('');
  const [recordingMoveOut, setRecordingMoveOut] = useState(false);
  const [undoingMoveOut, setUndoingMoveOut] = useState(false);
  const [moveOutMenuOpen, setMoveOutMenuOpen] = useState(false);
  const [exitRequestOpen, setExitRequestOpen] = useState(false);
  const [exitAvailableFrom, setExitAvailableFrom] = useState(null);
  const [exitReason, setExitReason] = useState('');
  const [exitOfferEnabled, setExitOfferEnabled] = useState(true);
  const [savingExitRequest, setSavingExitRequest] = useState(false);
  const [withdrawingExitRequest, setWithdrawingExitRequest] = useState(false);
  const [vacancyOverride, setVacancyOverride] = useState(null);
  const [pushRows, setPushRows] = useState([]);          // rent still owed
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState(null);
  // "Record signed on paper" — a document signed in ink against its period.
  const [paperOpen, setPaperOpen] = useState(false);
  const [paperSaving, setPaperSaving] = useState(false);
  const [paperFrom, setPaperFrom] = useState(null);
  const [paperTo, setPaperTo] = useState(null);
  const [paperSignedAt, setPaperSignedAt] = useState(null);
  const [paperFileId, setPaperFileId] = useState(null);
  const router = useRouter();
  const params = useParams();
  const { hasPermission } = useAuth();
  const { isMobile } = useIsMobile();
  const canEdit = hasPermission ? hasPermission('LANDLORD/LEASING_EDIT') : false;
  const leaseId = params.id;

  useEffect(() => {
    loadLease();
    loadVacancyOverride();
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

  const loadVacancyOverride = async () => {
    try {
      const res = await advertisingApi.listVacancyOverrides({ lease_id: leaseId });
      if (res.data?.code === 200) {
        const overrides = res.data?.data || [];
        const active = overrides.find(row => (
          !row.expires_on || !dayjs(row.expires_on).isBefore(dayjs(), 'day')
        ));
        setVacancyOverride(active || null);
      }
    } catch (err) {
      setVacancyOverride(null);
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
      // Newest active request, chosen explicitly. The list is ordered by PERIOD
      // now (a lease can hold one document per period), so position no longer
      // implies recency.
      const active = requests
        .filter(r => Number(r.status) === 1 || Number(r.status) === 2)
        .sort((a, b) => new Date(b.sent_at || 0) - new Date(a.sent_at || 0))[0];
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

  // Cancel ONE request from the documents ledger. handleCancelSignature below
  // cancels every open request on the lease, which was right when a lease had a
  // single document but is too broad now that each period has its own.
  const handleCancelRequest = async (requestId) => {
    setCancellingSig(true);
    try {
      const res = await signature.cancelRequest(requestId);
      if (res.data?.code !== 200) throw new Error(res.data?.message || 'Failed to cancel');
      message.success('Request cancelled. The signer link no longer works.');
      await loadLease();
    } catch (err) {
      message.error(err?.response?.data?.message || err.message || 'Failed to cancel');
    } finally {
      setCancellingSig(false);
    }
  };

  // Prefilled from the server's uncovered period so staff never retype dates.
  const openPaperModal = () => {
    const gap = lease?.paperwork?.uncovered;
    setPaperFrom(gap?.from ? dayjs(gap.from) : (lease?.start_date ? dayjs(lease.start_date) : null));
    setPaperTo(gap?.to ? dayjs(gap.to) : (lease?.end_date ? dayjs(lease.end_date) : null));
    setPaperSignedAt(dayjs());
    setPaperFileId(null);
    setPaperOpen(true);
  };

  const handleRecordPaper = async () => {
    if (!paperFrom || !paperTo) return message.warning('Set the period this document covers.');
    if (!paperSignedAt) return message.warning('Set the date it was signed.');
    setPaperSaving(true);
    try {
      const res = await signature.recordPaper({
        lease_id: leaseId,
        term_start: paperFrom.format('YYYY-MM-DD'),
        term_end: paperTo.format('YYYY-MM-DD'),
        signed_at: paperSignedAt.format('YYYY-MM-DD'),
        file_id: paperFileId,
      });
      if (res.data?.code === 200) {
        message.success('Recorded.');
        setPaperOpen(false);
        await loadLease();
      } else {
        message.error(res.data?.message || 'Failed to record');
      }
    } catch (err) {
      message.error(err?.response?.data?.message || 'Failed to record');
    } finally {
      setPaperSaving(false);
    }
  };

  // Cancel EVERY outstanding e-signature request on the lease. Kept for the
  // blunt "signed on paper, clear it all" case; the ledger's per-row Cancel is
  // the precise one.
  const handleCancelSignature = async () => {
    setCancellingSig(true);
    try {
      const listRes = await signature.listForLease(leaseId);
      const requests = listRes.data?.data || [];
      // Anything still open: created(0), sent(1) or viewed(2). Never a signed one.
      const open = requests.filter(r => [0, 1, 2].includes(Number(r.status)));
      if (open.length === 0) {
        message.info('No open signing request to cancel.');
        return;
      }
      for (const r of open) {
        const res = await signature.cancelRequest(r.id);
        if (res.data?.code !== 200) throw new Error(res.data?.message || 'Failed to cancel');
      }
      message.success(
        open.length > 1
          ? `Cancelled ${open.length} signing requests. The signer links no longer work.`
          : 'Signing request cancelled. The signer link no longer works.'
      );
      await loadLease();
    } catch (err) {
      message.error(err?.response?.data?.message || err.message || 'Failed to cancel the signing request');
    } finally {
      setCancellingSig(false);
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

  const handleOpenExitRequest = () => {
    setExitAvailableFrom(null);
    setExitReason('');
    setExitOfferEnabled(true);
    setExitRequestOpen(true);
  };

  const handleSaveExitRequest = async () => {
    if (!exitAvailableFrom) {
      message.error('They want to leave on is required');
      return;
    }
    setSavingExitRequest(true);
    try {
      const res = await advertisingApi.saveVacancyOverride({
        lease_id: leaseId,
        available_from: dayjs(exitAvailableFrom).format('YYYY-MM-DD'),
        reason: exitReason.trim() || undefined,
        advertising_enabled: exitOfferEnabled,
        inquiry_enabled: exitOfferEnabled,
        // expires_on is intentionally omitted; the server derives the 3-day window.
      });
      if (res.data?.code === 200) {
        message.success('Exit request recorded.');
        setExitRequestOpen(false);
        await loadVacancyOverride();
      } else {
        message.error(res.data?.message || 'Failed to record exit request');
      }
    } catch (err) {
      message.error(err.response?.data?.message || 'Failed to record exit request');
    } finally {
      setSavingExitRequest(false);
    }
  };

  const handleWithdrawExitRequest = async () => {
    if (!vacancyOverride?.id) return;
    setWithdrawingExitRequest(true);
    try {
      const res = await advertisingApi.clearVacancyOverride(vacancyOverride.id);
      if (res.data?.code === 200) {
        message.success('Exit request withdrawn.');
        await loadVacancyOverride();
      } else {
        message.error(res.data?.message || 'Failed to withdraw exit request');
      }
    } catch (err) {
      message.error(err.response?.data?.message || 'Failed to withdraw exit request');
    } finally {
      setWithdrawingExitRequest(false);
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

  // Re-opening after a move-out is already recorded acts as an EDIT: prefill the
  // recorded date and notes. Previously both were reset (date to today, notes to
  // blank), so amending a note meant retyping it in full — and leaving the date
  // untouched silently re-shortened the lease to today.
  const handleOpenMoveOut = () => {
    const existing = lease?.moveout || null;
    const when = existing?.requested_date ? dayjs(existing.requested_date) : dayjs();
    setMoveOutDate(when);
    setMoveOutNotes(existing?.notes || '');
    setPushRows([]);
    setMoveOutOpen(true);
    loadMoveOutPreview(when);
  };

  const handleUndoMoveOut = async () => {
    setUndoingMoveOut(true);
    try {
      const r = await leasing.moveOutUndo(leaseId);
      const d = r.data?.data || {};
      message.success(`Move-out undone — lease end restored to ${d.restored_end_date || 'its original date'}`);
      if (Number(d.pushed_invoices_remaining) > 0) {
        // Never silently leave money on the books without saying so.
        message.warning(
          `${d.pushed_invoices_remaining} invoice(s) raised for rent after the move-out still stand. ` +
          `Write them off or delete them if they shouldn't.`,
          8
        );
      }
      await loadLease();
    } catch (err) {
      message.error(err?.response?.data?.message || 'Failed to undo move-out');
    } finally {
      setUndoingMoveOut(false);
    }
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
          {/* Sales agent, followed by when the lease record was created — handy
              for telling a freshly-entered lease from a long-standing one. */}
          <Descriptions.Item label="Sales Agent">
            {lease?.sales_agent_name || '-'}
            {lease?.created_at && (
              <span style={{ color: '#888', marginLeft: 8 }}>
                · Created {dayjs(lease.created_at).format('D MMM YYYY')}
              </span>
            )}
          </Descriptions.Item>
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
  const cardTitle = (
    <Space wrap>
      <span>{`Lease ${leaseTitle}`}</span>
      {/* Status belongs with the lease identity; inline with buttons it reads like an action. */}
      {lease?.pdf_status && <SignStatusTag status={lease.pdf_status} />}
      {vacancyOverride && (
        <Tag color="processing">Exit requested: {formatDate(vacancyOverride.available_from)}</Tag>
      )}
    </Space>
  );

  return (
    <MainLayout>
      <Space direction="vertical" style={{ width: '100%' }} size="large">
        <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', justifyContent: 'space-between', alignItems: isMobile ? 'stretch' : 'center', gap: isMobile ? 8 : 0 }}>
          <Button icon={<ArrowLeftOutlined />} onClick={() => router.push('/leasing')}>Back to Leases</Button>
          {/* Document actions deliberately do NOT live here. This bar acts on the
              TENANCY (check-in, exit, move-out, edit); everything that produces or
              opens a document belongs in the Documents & Signatures card, next to
              the documents themselves. The two buttons that used to sit here both
              misled: "View Lease" re-renders the WHOLE tenancy on the fly, so an
              extension's row looked like it covered the full term, and it outranked
              the real signed documents by sitting in the primary bar. The other
              relabelled itself "View Signed Lease" once a lease had a signed file
              but still navigated to the composer — a document promised, a send form
              delivered. */}
          <Space wrap>
            <Popconfirm
              title="Send check-in email now?"
              description={`This emails the check-in details to ${lease?.tenant_first_name || 'the tenant'} immediately, regardless of the scheduled timing.`}
              okText="Send"
              onConfirm={handleSendCheckin}
            >
              <Button icon={<MailOutlined />} loading={sendingCheckin}>Send Check-in Email</Button>
            </Popconfirm>
            {vacancyOverride ? (
              <Popconfirm
                title="Withdraw this exit request?"
                description="The unit stops showing as possibly available to inquiries and advertising. The lease and invoicing are not affected."
                okText="Withdraw"
                onConfirm={handleWithdrawExitRequest}
              >
                <Button icon={<CalendarOutlined />} loading={withdrawingExitRequest}>Withdraw request</Button>
              </Popconfirm>
            ) : (
              <Button icon={<CalendarOutlined />} onClick={handleOpenExitRequest}>
                Request Exit
              </Button>
            )}
            {canEdit && (
              <Dropdown trigger={['click']} open={moveOutMenuOpen} onOpenChange={setMoveOutMenuOpen} dropdownRender={() => (
                  <Menu selectable={false}>
                    <Menu.Item key="record-move-out" onClick={() => { setMoveOutMenuOpen(false); handleOpenMoveOut(); }}>
                      <div>
                        <div>{lease?.moveout ? 'Edit move-out date' : 'Record move-out'}</div>
                        <div style={{ color: '#8c8c8c', fontSize: 12 }}>Ends the lease and updates invoicing.</div>
                      </div>
                    </Menu.Item>
                    {lease?.moveout && <Menu.Divider />}
                    {lease?.moveout && (
                      <Menu.Item key="undo-move-out" danger>
                        <Popconfirm
                          title="Undo this move-out?"
                          description={`The lease end date goes back to ${lease.moveout.original_end_date || 'its original date'} and the move-out is removed. Any invoices already raised for rent after the move-out are NOT deleted.`}
                          okText="Undo move-out"
                          okButtonProps={{ danger: true }}
                          onConfirm={() => { setMoveOutMenuOpen(false); handleUndoMoveOut(); }}
                        >
                          <div onClick={(e) => e.stopPropagation()} style={{ minWidth: 220 }}>
                            {undoingMoveOut ? 'Undoing move-out...' : 'Undo move-out'}
                          </div>
                        </Popconfirm>
                      </Menu.Item>
                    )}
                  </Menu>
                )}>
                {/* Static label prevents row reflow when move-out state changes or undo appears. */}
                <Button icon={<LogoutOutlined />}>Move-out</Button>
              </Dropdown>
            )}
            {canEdit && <Button type="primary" icon={<EditOutlined />} onClick={() => router.push(`/leasing/${leaseId}/edit`)}>Edit Lease</Button>}
          </Space>
        </div>
        <Modal
          title={lease?.moveout ? 'Edit move-out' : 'Record move-out'}
          open={moveOutOpen}
          onCancel={() => setMoveOutOpen(false)}
          onOk={handleRecordMoveOut}
          okText={lease?.moveout ? 'Save changes' : 'Record move-out'}
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

        <Modal title="Request Exit" open={exitRequestOpen} onCancel={() => setExitRequestOpen(false)} onOk={handleSaveExitRequest} okText="Save" confirmLoading={savingExitRequest}>
          <Space direction="vertical" style={{ width: '100%' }} size="middle">
            <div style={{ color: '#666' }}>
              The tenant has asked to leave before the lease ends. This does not change the lease, invoices or the calendar — it only affects what we tell people who ask about availability.
            </div>
            <div>
              <div style={{ marginBottom: 6, fontWeight: 500 }}>They want to leave on</div>
              <DatePicker value={exitAvailableFrom} onChange={setExitAvailableFrom} style={{ width: '100%' }} />
            </div>
            <div>
              <div style={{ marginBottom: 6, fontWeight: 500 }}>Reason <span style={{ fontWeight: 400 }}>(optional)</span></div>
              <Input value={exitReason} onChange={(e) => setExitReason(e.target.value)} maxLength={255} />
              <div style={{ color: '#8c8c8c', fontSize: 12, marginTop: 4 }}>Staff only — never shown to customers.</div>
            </div>
            <div>
              <Checkbox checked={exitOfferEnabled} onChange={(e) => setExitOfferEnabled(e.target.checked)}>
                Offer it to advertising and inquiries
              </Checkbox>
              <div style={{ color: '#8c8c8c', fontSize: 12, marginTop: 4 }}>Untick to just record it for now.</div>
            </div>
          </Space>
        </Modal>

        {/* Record a document signed in ink. Without this the only option was
            cancelling the request, which reset the lease to 'none' — an
            ink-signed lease then looked identical to one nobody ever sent, with
            no scan stored anywhere. */}
        <Modal
          title="Record a document signed on paper"
          open={paperOpen}
          onOk={handleRecordPaper}
          confirmLoading={paperSaving}
          okText="Record"
          onCancel={() => setPaperOpen(false)}
        >
          <Space direction="vertical" style={{ width: '100%' }} size="middle">
            <div>
              <div style={{ marginBottom: 4 }}>Period this document covers</div>
              <Space>
                <DatePicker value={paperFrom} onChange={setPaperFrom} placeholder="From" />
                <DatePicker value={paperTo} onChange={setPaperTo} placeholder="To" />
              </Space>
            </div>
            <div>
              <div style={{ marginBottom: 4 }}>Date signed</div>
              <DatePicker value={paperSignedAt} onChange={setPaperSignedAt} />
            </div>
            <div>
              <div style={{ marginBottom: 4 }}>Scan (optional)</div>
              <Upload
                maxCount={1}
                customRequest={async ({ file, onSuccess, onError }) => {
                  try {
                    const fd = new FormData();
                    fd.append('file', file);
                    const r = await fileApi.upload(fd);
                    const id = r.data?.data?.id || r.data?.data;
                    setPaperFileId(id);
                    onSuccess({ id });
                  } catch (err) {
                    message.error('Upload failed');
                    onError(err);
                  }
                }}
              >
                <Button size="small">Upload scan</Button>
              </Upload>
            </div>
          </Space>
        </Modal>

        {/* Documents & Signatures — one row per period of the tenancy.
            Extending a lease by editing its end date leaves the new period
            undocumented; this is where each signed document lives, whether
            e-signed or signed on paper.

            Rendered UNCONDITIONALLY. It used to appear only once a document
            existed, which was survivable while the send button lived in the top
            bar — now that this card owns every document action, hiding it would
            leave a lease with no paperwork yet (computePaperworkState returns
            needs_document:false for reason 'no_documents') with no way to send
            one at all. The empty state below is what a fresh lease sees. */}
        <Card size="small" title="Documents & Signatures">
            <Table
              size="small"
              pagination={false}
              rowKey="id"
              dataSource={lease?.documents || []}
              locale={{ emptyText: 'No documents yet. Send one for e-signature, or record one signed on paper.' }}
              columns={[
                {
                  title: 'Period',
                  key: 'period',
                  render: (_, d) => (d.term_start && d.term_end
                    ? `${dayjs(d.term_start).format('D MMM YYYY')} \u2013 ${dayjs(d.term_end).format('D MMM YYYY')}`
                    : <span style={{ color: '#999' }}>Period not recorded</span>),
                },
                {
                  title: 'Status',
                  key: 'status',
                  render: (_, d) => {
                    const st = Number(d.status);
                    if (st === 3) {
                      return (
                        <Tag color="green">
                          {d.signature_method === 'paper' ? 'Signed on paper' : 'E-signed'}
                          {d.completed_at ? ` \u00b7 ${dayjs(d.completed_at).format('D MMM YYYY')}` : ''}
                        </Tag>
                      );
                    }
                    if (st === 1 || st === 2) return <Tag color="blue">Out for signature</Tag>;
                    if (st === 4) return <Tag color="red">Declined</Tag>;
                    if (st === 5) return <Tag>Expired</Tag>;
                    return <Tag>Cancelled</Tag>;
                  },
                },
                {
                  // The card this replaced carried Resend / Cancel / Send Again.
                  // Those controls survive per row rather than being dropped.
                  title: '',
                  key: 'actions',
                  align: 'right',
                  render: (_, d) => {
                    const st = Number(d.status);
                    return (
                      <Space>
                        {/* One verb, three states: "View signed" is the executed document,
                            "View sent" is what the signer received, "Preview full-term draft"
                            (below the table) is neither. Previously "View PDF" / "View sent" /
                            "View Lease" / "View Signed Lease" — four names for looking at a
                            document, only two of which were the same kind of thing. */}
                        {d.signed_file_id && (
                          <Button size="small" onClick={() => window.open(`/api/file/preview/${d.signed_file_id}`, '_blank')}>
                            View signed
                          </Button>
                        )}
                        {/* The document as it was SENT. Without this there is no way to check what
                            a signer actually received until they sign — and the full-term draft is
                            not it: that re-renders the whole tenancy from the lease record, so an
                            extension's document appears to cover the full term. Shown only when
                            there is no signed copy, since the signed one supersedes it. */}
                        {!d.signed_file_id && d.original_file_id && (
                          <Button size="small" onClick={() => window.open(`/api/file/preview/${d.original_file_id}`, '_blank')}>
                            View sent
                          </Button>
                        )}
                        {/* A signed row with no file behind it. The scan is optional on
                            "Record signed on paper", so this is a legitimate state — but an
                            empty action cell reads as a broken row rather than as a document
                            that exists only on paper. Say which it is. */}
                        {st === 3 && !d.signed_file_id && !d.original_file_id && (
                          <span style={{ color: '#999', fontSize: 12 }}>No scan on file</span>
                        )}
                        {(st === 1 || st === 2) && (
                          <Button size="small" loading={resendingSig} onClick={handleResendSignature}>
                            Resend
                          </Button>
                        )}
                        {(st === 0 || st === 1 || st === 2 || st === 4) && (
                          <Popconfirm
                            title="Cancel this signing request?"
                            description="The signer's link stops working. Use this when the document was signed on paper instead — then record the scan below."
                            okText="Cancel request"
                            okButtonProps={{ danger: true }}
                            onConfirm={() => handleCancelRequest(d.id)}
                          >
                            <Button size="small" danger loading={cancellingSig}>Cancel</Button>
                          </Popconfirm>
                        )}
                      </Space>
                    );
                  },
                },
              ]}
            />

            {/* The gap. Only ever shown when the uncovered stretch reaches a
                month — the SERVER decides, so this can never disagree with the
                prompt shown after saving an extension. */}
            {lease?.paperwork?.needs_document && (
              <Alert
                type="warning"
                showIcon
                style={{ marginTop: 12 }}
                message={lease?.paperwork?.reason === 'period_not_recorded'
                  ? 'A signed document exists but the period it covers was never recorded.'
                  : `No signed document covers ${dayjs(lease?.paperwork?.uncovered?.from).format('D MMM YYYY')} \u2013 ${dayjs(lease?.paperwork?.uncovered?.to).format('D MMM YYYY')}.`}
                action={
                  <Space>
                    <Button size="small" type="primary" onClick={() => router.push(`/leasing/${leaseId}/review-and-send`)}>
                      Send for e-signature
                    </Button>
                    <Button size="small" onClick={openPaperModal}>Record signed on paper</Button>
                  </Space>
                }
              />
            )}

            {/* Under a month uncovered: informational, never a warning. */}
            {!lease?.paperwork?.needs_document && lease?.paperwork?.reason === 'under_a_month' && (
              <div style={{ marginTop: 12, color: '#888', fontSize: 12 }}>
                {dayjs(lease?.paperwork?.uncovered?.from).format('D MMM YYYY')} \u2013 {dayjs(lease?.paperwork?.uncovered?.to).format('D MMM YYYY')}
                {' '}\u00b7 no paperwork required (under a month)
              </div>
            )}

            <div style={{ marginTop: 12 }}>
              <Space wrap>
                {/* Primary only when the alert above is absent, so exactly one
                    "Send for e-signature" on screen is ever emphasised. */}
                <Button
                  size="small"
                  type={lease?.paperwork?.needs_document ? 'default' : 'primary'}
                  onClick={() => router.push(`/leasing/${leaseId}/review-and-send`)}
                >
                  Send for e-signature
                </Button>
                <Button size="small" onClick={openPaperModal}>Record signed on paper</Button>
                {/* Deliberately NOT called "View Lease". Nothing is stored and nothing is
                    signed: this re-renders the lease record over the WHOLE tenancy, so on
                    an extended lease it shows the full term rather than the extension. It
                    is a draft to read or print, which is why it sits last and plain while
                    the real documents are in the table above. */}
                <Tooltip title="Renders the whole tenancy from the lease record. Not a signed document, and not what any signer received.">
                  <Button size="small" icon={<FilePdfOutlined />} onClick={() => window.open(pdf.leaseUrl(leaseId), '_blank')}>
                    Preview full-term draft
                  </Button>
                </Tooltip>
              </Space>
            </div>
        </Card>
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

        <Card title={cardTitle} loading={loading}>
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
