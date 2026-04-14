'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Card, Descriptions, Button, Space, Tag, Tabs, Table, message, Input, Divider } from 'antd';
import { EditOutlined, ArrowLeftOutlined, FilePdfOutlined, SaveOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import MainLayout, { useAuth } from '../../../../components/Layout';
import useIsMobile from '../../../../hooks/useIsMobile';
import MobileCardList from '../../../../components/mobile/MobileCardList';
import { leasing, pdf, utility } from '../../../../lib/api';

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
        if (data.unit_id) loadReadings(data.unit_id);
      }
    } catch (error) {
      message.error('Failed to load lease');
    } finally {
      setLoading(false);
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

  const loadReadings = async (unitId) => {
    setReadingsLoading(true);
    try {
      const res = await utility.getUnitReadings({ unit_id: unitId });
      setReadings(res.data?.data || []);
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
  const statusLabel = leaseStatus === 2 ? 'Upcoming' : leaseStatus === 1 ? 'Active' : 'Inactive';
  const statusColor = leaseStatus === 2 ? 'blue' : leaseStatus === 1 ? 'green' : 'red';

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
          {(lease?.booking_platform_name || lease?.sales_agent_name) && (
            <>
              <Descriptions.Item label="Booking Platform">{lease?.booking_platform_name || '-'}</Descriptions.Item>
              <Descriptions.Item label="Sales Agent">{lease?.sales_agent_name || '-'}</Descriptions.Item>
            </>
          )}
          {lease?.note && (
            <Descriptions.Item label="Notes" span={2}>{lease.note}</Descriptions.Item>
          )}
        </Descriptions>
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
            <Button icon={<FilePdfOutlined />} onClick={() => window.open(pdf.leaseUrl(leaseId), '_blank')}>View PDF</Button>
            {canEdit && <Button type="primary" icon={<EditOutlined />} onClick={() => router.push(`/leasing/${leaseId}/edit`)}>Edit Lease</Button>}
          </Space>
        </div>
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
