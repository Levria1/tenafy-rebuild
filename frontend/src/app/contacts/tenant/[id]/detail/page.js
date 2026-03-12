'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter, useParams, useSearchParams } from 'next/navigation';
import {
  Button, Space, Tag, Table, message, Spin, Empty, Dropdown, Tooltip,
  Typography, Statistic, Row, Col, Divider, Avatar, Drawer, Descriptions,
} from 'antd';
import {
  EditOutlined, UserOutlined, MailOutlined,
  FileTextOutlined, DollarOutlined, PrinterOutlined,
  DownOutlined, EyeOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import MainLayout from '../../../../../components/Layout';
import { tenant, invoice } from '../../../../../lib/api';

const { Text } = Typography;

const CONTRACT_TYPES = { 0: 'Standard', 1: 'Commercial', 2: 'Residential', 3: 'Short Term' };
const GENDER_MAP = { 0: '—', 1: 'MALE', 2: 'FEMALE' };
const INVOICING_MAP = { 'weekly': 'Weekly', 'bi-weekly': 'Bi-Weekly', 'monthly': 'Monthly', 'quarterly': 'Quarterly', 'bi-annually': 'Bi-Annually', '7': 'Weekly', '14': 'Bi-Weekly', '30': 'Monthly', '90': 'Quarterly', '180': 'Bi-Annually' };

function capitalize(s) {
  if (!s) return '—';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------------------
// Reusable field/value display
// ---------------------------------------------------------------------------
function FieldValue({ label, value }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {label}
      </div>
      <div style={{ fontSize: 14, color: '#333', marginTop: 2 }}>
        {value || '—'}
      </div>
    </div>
  );
}

function SectionHeader({ title }) {
  return (
    <div style={{
      fontSize: 13, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5,
      color: '#333', borderBottom: '1px solid #d9d9d9', paddingBottom: 8, marginBottom: 16, marginTop: 8,
    }}>
      {title}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------
export default function TenantDetailPage() {
  const router = useRouter();
  const params = useParams();
  const searchParams = useSearchParams();
  const tenantId = params.id;
  const initialTab = searchParams.get('tab') || 'profile';

  const [tenantData, setTenantData] = useState(null);
  const [profileSum, setProfileSum] = useState(null);
  const [leases, setLeases] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [invoicesLoading, setInvoicesLoading] = useState(false);
  const [invoicePagination, setInvoicePagination] = useState({ current: 1, pageSize: 10, total: 0 });
  const [accountingSum, setAccountingSum] = useState(null);
  const [activeTab, setActiveTab] = useState(initialTab);
  const [publishLoading, setPublishLoading] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerLoading, setDrawerLoading] = useState(false);
  const [selectedInvoice, setSelectedInvoice] = useState(null);

  const loadTenant = useCallback(async () => {
    try {
      const [profileRes, sumRes] = await Promise.all([
        tenant.getProfile(tenantId),
        tenant.getProfileSum(tenantId),
      ]);
      if (profileRes.data.code === 200) setTenantData(profileRes.data.data);
      if (sumRes.data.code === 200) setProfileSum(sumRes.data.data);
    } catch (err) {
      message.error('Failed to load tenant');
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  const loadLeases = useCallback(async () => {
    try {
      const res = await tenant.getLeases(tenantId);
      if (res.data.code === 200) setLeases(res.data.data || []);
    } catch (err) {
      console.error('Failed to load leases:', err);
    }
  }, [tenantId]);

  const loadInvoices = useCallback(async (page = 1) => {
    setInvoicesLoading(true);
    try {
      const [listRes, sumRes] = await Promise.all([
        tenant.getAccountingList(tenantId, {}, { page, limit: 10 }),
        page === 1 ? tenant.getAccountingSum(tenantId, {}) : Promise.resolve(null),
      ]);
      if (listRes.data.code === 200) {
        setInvoices(listRes.data.data.content || []);
        setInvoicePagination(prev => ({
          ...prev,
          current: page,
          total: listRes.data.data.totalElements || 0,
        }));
      }
      if (sumRes && sumRes.data.code === 200) {
        setAccountingSum(sumRes.data.data);
      }
    } catch (err) {
      console.error('Failed to load invoices:', err);
    } finally {
      setInvoicesLoading(false);
    }
  }, [tenantId]);

  const openInvoiceDrawer = async (record) => {
    setDrawerOpen(true);
    setDrawerLoading(true);
    setSelectedInvoice(null);
    try {
      const res = await invoice.get(record.id);
      if (res.data.code === 200) setSelectedInvoice(res.data.data);
    } catch (err) {
      message.error('Failed to load invoice details');
    } finally {
      setDrawerLoading(false);
    }
  };

  const closeDrawer = () => { setDrawerOpen(false); setSelectedInvoice(null); };

  useEffect(() => { loadTenant(); }, [loadTenant]);
  useEffect(() => { loadLeases(); }, [loadLeases]);
  useEffect(() => {
    if (activeTab === 'accounting') loadInvoices();
  }, [activeTab, loadInvoices]);

  const statusMap = { 0: { text: 'Open', color: 'blue' }, 1: { text: 'Paid', color: 'green' }, 2: { text: 'Overdue', color: 'red' } };
  // Compute effective status: show "Partial" when partially paid
  const getEffectiveStatus = (r) => {
    const amt = Number(r.amount) || 0;
    const paid = Number(r.amount_paid) || 0;
    const status = Number(r.status);
    if (status === 1 && paid >= amt) return { text: 'Paid', color: 'green' };
    if (paid > 0 && paid < amt) return { text: 'Partial', color: 'orange' };
    if (status === 2) return { text: 'Overdue', color: 'red' };
    return { text: 'Open', color: 'blue' };
  };
  const hasOutstanding = (r) => {
    const amt = Number(r.amount) || 0;
    const paid = Number(r.amount_paid) || 0;
    return amt > paid;
  };
  const hasActiveLease = leases.some(l => l.status === 1);
  const fmt = (v) => v != null ? `$${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2 })}` : '—';

  const actionsMenu = {
    items: [
      { key: 'edit', label: 'Edit Tenant', icon: <EditOutlined /> },
      { key: 'email', label: 'Send Email', icon: <MailOutlined /> },
      { key: 'invoice', label: 'Create Invoice', icon: <FileTextOutlined /> },
    ],
    onClick: ({ key }) => {
      if (key === 'edit') router.push(`/contacts/tenant/${tenantId}/edit`);
      else if (key === 'email' && tenantData?.email) {
        router.push(`/contacts/email/send?to=${encodeURIComponent(tenantData.email)}&name=${encodeURIComponent(tenantData.first_name + ' ' + tenantData.last_name)}`);
      } else if (key === 'invoice') {
        router.push(`/invoices/create?tenantId=${tenantId}&tenantName=${encodeURIComponent((tenantData?.first_name || '') + ' ' + (tenantData?.last_name || ''))}`);
      }
    },
  };

  // ---- Tab labels ----
  const tabs = [
    { key: 'profile', label: 'Profile' },
    { key: 'leases', label: 'Leases' },
    { key: 'accounting', label: 'Accounting' },
  ];

  // ---- Age from birth_date ----
  const calcAge = (bd) => {
    if (!bd) return '—';
    const age = dayjs().diff(dayjs(bd), 'year');
    return age > 0 ? age.toString() : '—';
  };

  if (loading) {
    return (
      <MainLayout>
        <div style={{ padding: 48, textAlign: 'center' }}><Spin size="large" /></div>
      </MainLayout>
    );
  }

  // =========================================================================
  // PROFILE TAB CONTENT
  // =========================================================================
  const ProfileContent = () => (
    <div>
      {/* GENERAL INFORMATION */}
      <SectionHeader title="General Information" />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0 24px' }}>
        <FieldValue label="First Name" value={tenantData?.first_name} />
        <FieldValue label="Last Name" value={tenantData?.last_name} />
        <FieldValue label="Middle Name" value={tenantData?.middle_name} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '0 24px' }}>
        <FieldValue label="Company Name" value={tenantData?.company_name} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0 24px' }}>
        <FieldValue label="Date of Birth" value={tenantData?.birth_date || '—'} />
        <FieldValue label="Age" value={calcAge(tenantData?.birth_date)} />
        <FieldValue label="Gender" value={GENDER_MAP[tenantData?.sex] || '—'} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0 24px' }}>
        <FieldValue label="Email" value={tenantData?.email} />
        <FieldValue label="Secondary Email" value={tenantData?.secondary_email} />
        <FieldValue label="Phone" value={tenantData?.phone} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '0 24px' }}>
        <FieldValue label="ID / Passport" value={tenantData?.id_card} />
      </div>

      {/* ADDITIONAL INFORMATION */}
      <SectionHeader title="Additional Information" />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0 24px' }}>
        <FieldValue label="Profession" value={tenantData?.profession} />
        <FieldValue label="Budget" value={tenantData?.budget} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0 24px' }}>
        <FieldValue label="Employer" value={tenantData?.employer} />
        <FieldValue label="Salary" value={tenantData?.salary} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0 24px' }}>
        <FieldValue label="Emergency Contact" value={tenantData?.emergency_contact} />
        <FieldValue label="Referral" value={tenantData?.referral} />
      </div>

      {/* NOTES */}
      <SectionHeader title="Notes" />
      <div style={{ fontSize: 14, color: '#333', marginBottom: 16 }}>
        {tenantData?.notes || '—'}
      </div>

      {/* ATTACHMENTS */}
      <SectionHeader title="Attachments" />
      <div style={{ fontSize: 14, color: '#333' }}>
        {tenantData?.file ? tenantData.file : '—'}
      </div>
    </div>
  );

  // =========================================================================
  // LEASES TAB CONTENT
  // =========================================================================
  const LeasesContent = () => {
    if (leases.length === 0) {
      return <Empty description="No leases found" />;
    }

    // Find the active lease (last one with status=1)
    const activeLease = leases.find(l => l.status === 1);

    return (
      <div>
        {leases.map((lease, idx) => (
          <div key={lease.id} style={{ marginBottom: 32 }}>
            {/* UNIT INFORMATION */}
            <SectionHeader title="Unit Information" />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0 24px' }}>
              <FieldValue label="Property Name" value={lease.property_name} />
              <FieldValue label="Unit Name" value={lease.unit_name} />
              <FieldValue label="Unit Type" value={capitalize(lease.unit_type)} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '0 24px' }}>
              <FieldValue label="Address" value={lease.property_address} />
            </div>

            {/* LEASE DETAILS */}
            <SectionHeader title="Lease Details" />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0 24px' }}>
              <FieldValue label="Lease#" value={lease.lease_no} />
              <FieldValue label="Start Date" value={lease.start_date ? dayjs(lease.start_date).format('YYYY-MM-DD') : '—'} />
              <FieldValue label="End Date" value={lease.end_date ? dayjs(lease.end_date).format('YYYY-MM-DD') : '—'} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0 24px' }}>
              <FieldValue label="Lease Type" value={lease.type === 1 ? 'Month-to-Month' : 'Fixed'} />
              <FieldValue label="Invoicing" value={INVOICING_MAP[String(lease.invoicing)] || capitalize(lease.invoicing)} />
              <FieldValue label="Contract Type" value={CONTRACT_TYPES[lease.contract_type] || '—'} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0 24px' }}>
              <FieldValue label="Rent" value={lease.amount ? fmt(lease.amount) : '—'} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '0 24px' }}>
              <FieldValue
                label="Additional Tenants"
                value={
                  lease.additional_tenants?.length > 0
                    ? lease.additional_tenants.map(t => t.display_name?.trim()).join(', ')
                    : '—'
                }
              />
            </div>
          </div>
        ))}

        {/* LEASE TRANSACTIONS - show for the active lease */}
        {activeLease && (
          <div>
            <SectionHeader title="Lease Transactions" />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0 24px' }}>
              <FieldValue label="Rent" value={activeLease.amount ? fmt(activeLease.amount) : '—'} />
              <FieldValue label="Due Date" value={activeLease.due_date ? `${activeLease.due_date}${getOrdinalSuffix(activeLease.due_date)}` : '—'} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0 24px' }}>
              <FieldValue label="First Rent Invoice Date" value={activeLease.first_invoice_date ? dayjs(activeLease.first_invoice_date).format('YYYY-MM-DD') : '—'} />
              <FieldValue label="Next Invoice Publish Date" value={activeLease.next_invoice_date ? dayjs(activeLease.next_invoice_date).format('YYYY-MM-DD') : '—'} />
            </div>
            {activeLease.next_invoice_date && (
              <div style={{ marginTop: 8 }}>
                <Button
                  type="primary"
                  icon={<DollarOutlined />}
                  loading={publishLoading}
                  onClick={async () => {
                    try {
                      setPublishLoading(true);
                      const res = await invoice.publish({
                        tenant_id: tenantId,
                        unit_id: activeLease.unit_id || null,
                        leasing_id: activeLease.id,
                        property_id: activeLease.property_id || null,
                        amount: activeLease.amount || activeLease.price || 0,
                        due_date: dayjs(activeLease.next_invoice_date).format('YYYY-MM-DD'),
                        type: 0,
                      });
                      if (res.data.code === 200) {
                        message.success(`Invoice ${res.data.data?.invoice_code || ''} published successfully`);
                        loadLeases();
                      } else {
                        message.error(res.data.message || 'Failed to publish invoice');
                      }
                    } catch (err) {
                      const errMsg = err.response?.data?.message || 'Failed to publish invoice';
                      if (err.response?.status === 409) {
                        message.warning(errMsg);
                      } else {
                        message.error(errMsg);
                      }
                    } finally {
                      setPublishLoading(false);
                    }
                  }}
                  style={{
                    background: '#d4880f',
                    borderColor: '#d4880f',
                    fontWeight: 600,
                    height: 36,
                  }}
                >
                  Publish Invoice
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  // =========================================================================
  // ACCOUNTING TAB CONTENT
  // =========================================================================
  // Currency symbol lookup
  const currencySymbolMap = { HKD: 'HK$', USD: '$', EUR: '€', GBP: '£', JPY: '¥', CNY: '¥', CAD: 'C$', AUD: 'A$', SGD: 'S$', TWD: 'NT$' };
  const getCurSymbol = (code) => currencySymbolMap[code] || code || 'HK$';

  const fmtCur = (v, symbolOrCode) => {
    if (v == null) return '—';
    const symbol = symbolOrCode || 'HK$';
    return `${symbol}${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  const getContactName = (r) => {
    if (Number(r.tenant_type) === 1 && r.tenant_company_name) return r.tenant_company_name;
    return [r.tenant_first_name, r.tenant_middle_name, r.tenant_last_name].filter(Boolean).join(' ') || '—';
  };

  const getDaysLate = (r) => {
    if (Number(r.status) !== 2) return 0;
    const due = dayjs(r.due_on);
    if (!due.isValid()) return 0;
    const diff = dayjs().diff(due, 'day');
    return diff > 0 ? diff : 0;
  };

  const invoiceColumns = [
    {
      title: 'STATUS', dataIndex: 'status', key: 'status', width: 80,
      render: (_, r) => {
        const cfg = getEffectiveStatus(r);
        return <span style={{ fontSize: 13, color: cfg.color === 'blue' ? '#1890ff' : cfg.color === 'green' ? '#389e0d' : cfg.color === 'red' ? '#cf1322' : '#faad14' }}>{cfg.text}</span>;
      },
    },
    {
      title: 'DUE DATE', dataIndex: 'due_on', key: 'due_on', width: 110,
      render: (d) => d ? dayjs(d).format('YYYY-MM-DD') : '—',
    },
    {
      title: 'CONTACT', key: 'contact', width: 170, ellipsis: true,
      render: (_, r) => getContactName(r),
    },
    {
      title: 'PROPERTY (Unit)', key: 'property_unit', width: 150, ellipsis: true,
      render: (_, r) => {
        if (!r.property_name && !r.unit_name) return '—';
        if (r.property_name && r.unit_name) return `${r.property_name} (${r.unit_name})`;
        return r.property_name || r.unit_name;
      },
    },
    {
      title: 'TOTAL / PAID', key: 'total_paid', width: 200,
      render: (_, r) => {
        const sym = getCurSymbol(r.property_currency);
        const amt = Number(r.amount) || 0;
        const paid = Number(r.amount_paid) || 0;
        const isInflow = Number(r.type) === 0 || r.type === null || r.type === undefined;
        const sign = isInflow ? '+' : '-';
        const color = isInflow ? '#389e0d' : '#cf1322';
        return (
          <span style={{ color, fontWeight: 500 }}>
            {sign} {sym}{amt.toLocaleString(undefined, { minimumFractionDigits: 0 })} / {sym}{paid.toLocaleString(undefined, { minimumFractionDigits: 0 })}
          </span>
        );
      },
    },
    {
      title: 'OUTSTANDING', key: 'outstanding', width: 140,
      render: (_, r) => {
        const sym = getCurSymbol(r.property_currency);
        const amt = Number(r.amount) || 0;
        const paid = Number(r.amount_paid) || 0;
        const outstanding = Number(r.status) === 1 ? 0 : Math.max(amt - paid, 0);
        return fmtCur(outstanding, sym);
      },
    },
    {
      title: 'DAYS LATE', key: 'days_late', width: 90, align: 'center',
      render: (_, r) => getDaysLate(r),
    },
    {
      title: 'CATEGORY', dataIndex: 'category_name', key: 'category_name', width: 130,
      ellipsis: true,
      render: (v) => v || '—',
    },
    {
      title: 'NOTES', dataIndex: 'note', key: 'note', width: 60, align: 'center',
      render: (v) => v ? (
        <Tooltip title={v} placement="topRight">
          <FileTextOutlined style={{ color: '#1890ff', cursor: 'pointer' }} />
        </Tooltip>
      ) : '—',
    },
    {
      title: 'ACTION', key: 'action', width: 130, fixed: 'right',
      render: (_, r) => {
        const canPay = hasOutstanding(r);
        return (
        <Space size="small">
          <Button
            size="small"
            disabled={!canPay}
            onClick={() => router.push(`/accounting/invoices/payment/create?invoiceId=${r.id}`)}
            style={{
              borderRadius: 4, padding: '0 10px', fontSize: 13,
              color: !canPay ? '#ccc' : '#666',
              borderColor: !canPay ? '#eee' : '#d9d9d9',
              background: 'transparent',
            }}
          >
            Pay
          </Button>
          <Button type="link" size="small" style={{ padding: 0 }} onClick={() => openInvoiceDrawer(r)}>
            View &gt;
          </Button>
        </Space>
        );
      },
    },
  ];

  const AccountingContent = () => (
    <div>
      {/* Summary cards matching original: Outstanding Outflow | Outstanding Inflow | Paid */}
      <div style={{
        display: 'flex', border: '1px solid #e8e8e8', borderRadius: 6,
        marginBottom: 16, background: '#fafafa',
      }}>
        <div style={{ flex: 1, padding: '12px 20px', borderRight: '1px solid #e8e8e8' }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#888', textTransform: 'uppercase' }}>Outstanding Outflow</div>
          <div style={{ fontSize: 16, fontWeight: 600, color: '#cf1322', marginTop: 4 }}>
            {fmtCur(accountingSum?.outstanding_outflow || 0, 'HK$ ')}
          </div>
        </div>
        <div style={{ flex: 1, padding: '12px 20px', borderRight: '1px solid #e8e8e8' }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#888', textTransform: 'uppercase' }}>Outstanding Inflow</div>
          <div style={{ fontSize: 16, fontWeight: 600, color: '#cf1322', marginTop: 4 }}>
            {fmtCur(accountingSum?.outstanding_inflow || 0, 'HK$ ')}
          </div>
        </div>
        <div style={{ flex: 1, padding: '12px 20px' }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#888', textTransform: 'uppercase' }}>Paid</div>
          <div style={{ fontSize: 16, fontWeight: 600, color: '#389e0d', marginTop: 4 }}>
            {fmtCur(accountingSum?.paid || 0, 'HK$ ')}
          </div>
        </div>
      </div>

      <Table
        columns={invoiceColumns}
        dataSource={invoices}
        rowKey="id"
        loading={invoicesLoading}
        size="small"
        scroll={{ x: 1300 }}
        pagination={{
          ...invoicePagination,
          onChange: (page) => loadInvoices(page),
          showSizeChanger: false,
          showTotal: (total, range) => `${range[0]}-${range[1]} of ${total}`,
          pageSize: 10,
        }}
        locale={{ emptyText: 'No invoices found' }}
      />
    </div>
  );

  // =========================================================================
  // RENDER
  // =========================================================================
  return (
    <MainLayout>
      {/* Page title + Actions */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>
          {activeTab === 'profile' ? 'Profile' : activeTab === 'leases' ? 'Leases' : 'Accounting'}
        </h1>
        <Dropdown menu={actionsMenu}>
          <Button>Actions <DownOutlined /></Button>
        </Dropdown>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 24, borderBottom: '1px solid #e8e8e8', marginBottom: 24 }}>
        {tabs.map(t => (
          <div
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            style={{
              padding: '8px 0',
              cursor: 'pointer',
              fontSize: 13,
              fontWeight: activeTab === t.key ? 600 : 400,
              color: activeTab === t.key ? '#1890ff' : '#888',
              borderBottom: activeTab === t.key ? '2px solid #1890ff' : '2px solid transparent',
            }}
          >
            {t.label}
          </div>
        ))}
      </div>

      {/* Two-column layout */}
      <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start' }}>
        {/* LEFT SIDEBAR */}
        <div style={{ width: 380, flexShrink: 0 }}>
          <div style={{ background: '#fff', border: '1px solid #e8e8e8', borderRadius: 8, overflow: 'hidden' }}>
            {/* Avatar area */}
            <div style={{ background: '#f5f5f5', padding: '40px 20px 30px', textAlign: 'center' }}>
              <div style={{
                width: 180, height: 180, margin: '0 auto 20px', borderRadius: 8,
                background: '#eee', display: 'flex', alignItems: 'center', justifyContent: 'center',
                border: '2px solid #ddd',
              }}>
                <UserOutlined style={{ fontSize: 80, color: '#bbb' }} />
              </div>

              {/* Name + status dot */}
              <div style={{ fontSize: 16, fontWeight: 600, color: '#333' }}>
                {tenantData?.first_name} {tenantData?.last_name}
                {' '}
                <span style={{
                  display: 'inline-block', width: 12, height: 12, borderRadius: '50%',
                  background: hasActiveLease ? '#52c41a' : '#ff4d4f',
                  border: `2px solid ${hasActiveLease ? '#389e0d' : '#cf1322'}`,
                  verticalAlign: 'middle', marginLeft: 4,
                }} />
              </div>
              {tenantData?.email && (
                <div style={{ fontSize: 13, color: '#888', marginTop: 4 }}>{tenantData.email}</div>
              )}
            </div>

            {/* Buttons + Financial info */}
            <div style={{ padding: '16px 20px' }}>
              {/* Active/Inactive button */}
              <div style={{
                width: '100%', padding: '8px 0', textAlign: 'center',
                background: hasActiveLease ? '#f6ffed' : '#f5f5f5',
                border: `1px solid ${hasActiveLease ? '#b7eb8f' : '#d9d9d9'}`,
                borderRadius: 4, fontWeight: 600, fontSize: 13,
                color: hasActiveLease ? '#389e0d' : '#888', marginBottom: 8,
              }}>
                {hasActiveLease ? 'Active' : 'Inactive'}
              </div>

              {/* Create Deposit Refund - only on profile tab */}
              {activeTab === 'profile' && (
                <div
                  onClick={() => {
                    const name = `${tenantData?.first_name || ''} ${tenantData?.last_name || ''}`.trim();
                    const activeLease = leases.find(l => l.status === 1);
                    const params = new URLSearchParams({
                      tenantId,
                      tenantName: name,
                      category: 'deposit-refund',
                    });
                    if (activeLease) {
                      if (activeLease.unit_id) params.set('unitId', activeLease.unit_id);
                      if (activeLease.property_id) params.set('propertyId', activeLease.property_id);
                      if (activeLease.id) params.set('leasingId', activeLease.id);
                    }
                    router.push(`/invoices/create?${params.toString()}`);
                  }}
                  style={{
                    width: '100%', padding: '8px 0', textAlign: 'center',
                    background: '#f5f5f5', border: '1px solid #d9d9d9', borderRadius: 4,
                    fontWeight: 600, fontSize: 13, color: '#333', marginBottom: 16, cursor: 'pointer',
                  }}
                >
                  Create Deposit Refund
                </div>
              )}

              {activeTab !== 'profile' && <div style={{ height: 8 }} />}

              {/* Financial summary - varies by tab */}
              {activeTab === 'profile' && (
                <>
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#1890ff' }}>Deposits</div>
                    <div style={{ fontSize: 14, color: '#1890ff' }}>{fmt(profileSum?.deposits)}</div>
                  </div>
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#333' }}>Outstanding</div>
                    <div style={{ fontSize: 14, color: '#1890ff' }}>{fmt(profileSum?.outstanding)}</div>
                  </div>
                  <div style={{ marginBottom: 4 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#333' }}>Credits</div>
                    <div style={{ fontSize: 14, color: '#333' }}>
                      {profileSum?.credits ? `-${fmt(profileSum.credits)}` : '—'}
                    </div>
                  </div>
                </>
              )}

              {activeTab === 'leases' && (
                <>
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#333' }}>Outstanding</div>
                    <div style={{ fontSize: 14, color: '#1890ff' }}>{fmt(profileSum?.outstanding)}</div>
                  </div>
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#333' }}>Paid</div>
                    <div style={{ fontSize: 14, color: '#1890ff' }}>{fmt(profileSum?.paid)}</div>
                  </div>
                  <div style={{ marginBottom: 4 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#333' }}>Credits</div>
                    <div style={{ fontSize: 14, color: '#333' }}>
                      {profileSum?.credits ? `-${fmt(profileSum.credits)}` : '—'}
                    </div>
                  </div>
                </>
              )}

              {activeTab === 'accounting' && (
                <>
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#333' }}>Outstanding</div>
                    <div style={{ fontSize: 14, color: '#cf1322' }}>{fmt(profileSum?.outstanding)}</div>
                  </div>
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#333' }}>Total Paid</div>
                    <div style={{ fontSize: 14, color: '#3f8600' }}>{fmt(profileSum?.paid)}</div>
                  </div>
                  <div style={{ marginBottom: 4 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#333' }}>Active Leases</div>
                    <div style={{ fontSize: 14, color: '#1677ff' }}>{profileSum?.activeLeases || 0}</div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {/* RIGHT CONTENT */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ background: '#fff', border: '1px solid #e8e8e8', borderRadius: 8, padding: '20px 28px' }}>
            {activeTab === 'profile' && <ProfileContent />}
            {activeTab === 'leases' && <LeasesContent />}
            {activeTab === 'accounting' && <AccountingContent />}
          </div>
        </div>
      </div>
      {/* Invoice Detail Drawer */}
      <Drawer
        title={
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>Accounting</span>
            {selectedInvoice && (
              <Button type="default" size="small"
                disabled={!hasOutstanding(selectedInvoice)}
                onClick={() => router.push(`/accounting/invoices/payment/create?invoiceId=${selectedInvoice.id}`)}>
                Pay
              </Button>
            )}
          </div>
        }
        placement="right"
        width={440}
        onClose={closeDrawer}
        open={drawerOpen}
        footer={selectedInvoice ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Button type="primary" icon={<PrinterOutlined />} block onClick={() => window.print()}>
              Print
            </Button>
            <Button type="primary" icon={<EditOutlined />} block style={{ background: '#52c41a', borderColor: '#52c41a' }}
              onClick={() => { closeDrawer(); router.push(`/invoices/${selectedInvoice.id}/edit`); }}>
              Edit
            </Button>
            <Button block onClick={closeDrawer}>
              Close
            </Button>
          </div>
        ) : null}
      >
        {drawerLoading ? (
          <div style={{ textAlign: 'center', padding: 60 }}><Spin size="large" /></div>
        ) : selectedInvoice ? (
          <>
            <Descriptions column={1} size="small" labelStyle={{ width: 130, fontWeight: 600, color: '#555', textAlign: 'right', paddingRight: 12 }} contentStyle={{ fontWeight: 400 }}>
              <Descriptions.Item label="ENTRY TYPE:">
                {Number(selectedInvoice.type) === 0 ? 'Inflow' : 'Outflow'}
              </Descriptions.Item>
              <Descriptions.Item label="STATUS:">
                {(() => { const s = Number(selectedInvoice.status); return s === 0 ? 'Open' : s === 1 ? 'Paid' : s === 2 ? 'Overdue' : 'Unknown'; })()}
              </Descriptions.Item>
            </Descriptions>
            <Divider style={{ margin: '12px 0' }} />
            <Descriptions column={1} size="small" labelStyle={{ width: 130, fontWeight: 600, color: '#555', textAlign: 'right', paddingRight: 12 }} contentStyle={{ fontWeight: 400 }}>
              <Descriptions.Item label="Invoice ID:">
                {selectedInvoice.invoice_code || '-'}
              </Descriptions.Item>
              <Descriptions.Item label="Contact:">
                {(() => {
                  if (Number(selectedInvoice.tenant_type) === 1 && selectedInvoice.tenant_company_name) return selectedInvoice.tenant_company_name;
                  return [selectedInvoice.tenant_first_name, selectedInvoice.tenant_last_name].filter(Boolean).join(' ') || '-';
                })()}
              </Descriptions.Item>
              <Descriptions.Item label="Due Date:">
                {selectedInvoice.due_on ? dayjs(selectedInvoice.due_on).format('YYYY-MM-DD') : '-'}
              </Descriptions.Item>
              <Descriptions.Item label="Amount:">
                {fmtCur(selectedInvoice.amount, getCurSymbol(selectedInvoice.property_currency))}
              </Descriptions.Item>
              <Descriptions.Item label="Amount Paid:">
                {fmtCur(selectedInvoice.amount_paid, getCurSymbol(selectedInvoice.property_currency))}
              </Descriptions.Item>
              <Descriptions.Item label="Outstanding:">
                {fmtCur(selectedInvoice.outstanding, getCurSymbol(selectedInvoice.property_currency))}
              </Descriptions.Item>
            </Descriptions>

            <div style={{ display: 'flex', margin: '8px 0', paddingLeft: 0 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, color: '#555', fontSize: 13 }}>Property:</div>
                <div>{selectedInvoice.property_name || '-'}</div>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, color: '#555', fontSize: 13 }}>Unit:</div>
                <div>{selectedInvoice.unit_name || '-'}</div>
              </div>
            </div>

            <div style={{ margin: '12px 0' }}>
              <div style={{ fontWeight: 600, color: '#555', fontSize: 13 }}>Notes:</div>
              <div style={{ color: '#1890ff' }}>{selectedInvoice.note || '-'}</div>
            </div>

            <div style={{ margin: '12px 0' }}>
              <div style={{ fontWeight: 600, color: '#555', fontSize: 13 }}>Files:</div>
              <div>—</div>
            </div>

            <Divider style={{ margin: '16px 0 12px' }} />
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 12 }}>Payment Activity</div>
            {selectedInvoice.payments && selectedInvoice.payments.length > 0 ? (
              selectedInvoice.payments.map((p, idx) => (
                <div key={idx} style={{ marginBottom: 16, borderBottom: '1px solid #f0f0f0', paddingBottom: 12 }}>
                  <Descriptions column={1} size="small" labelStyle={{ width: 130, fontWeight: 600, color: '#555', textAlign: 'right', paddingRight: 12 }} contentStyle={{ fontWeight: 400 }}>
                    <Descriptions.Item label="Transaction ID:">{p.transaction_code || '-'}</Descriptions.Item>
                    <Descriptions.Item label="Date:">{p.payment_date ? dayjs(p.payment_date).format('YYYY-MM-DD') : '-'}</Descriptions.Item>
                    <Descriptions.Item label="Contact:">{[p.contact_first_name, p.contact_last_name].filter(Boolean).join(' ') || '-'}</Descriptions.Item>
                    <Descriptions.Item label="Method:">{p.payment_method_name || '-'}</Descriptions.Item>
                    <Descriptions.Item label="Amount Paid:">{fmtCur(p.amount, getCurSymbol(selectedInvoice.property_currency))}</Descriptions.Item>
                  </Descriptions>
                  <div style={{ margin: '8px 0 4px' }}>
                    <div style={{ fontWeight: 600, color: '#555', fontSize: 13 }}>Notes:</div>
                    <div>{p.note || '-'}</div>
                  </div>
                  <div style={{ margin: '8px 0 4px' }}>
                    <div style={{ fontWeight: 600, color: '#555', fontSize: 13 }}>Files:</div>
                    <div>—</div>
                  </div>
                </div>
              ))
            ) : (
              <div style={{ textAlign: 'center', color: '#999', padding: '12px 0' }}>No payment activity</div>
            )}

            <Divider style={{ margin: '16px 0 12px' }} />
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 12 }}>Submitted Payments</div>
            <div style={{ textAlign: 'center', color: '#999', padding: '20px 0' }}>
              <div style={{ fontSize: 40, marginBottom: 4 }}>&#9993;</div>
              No Data
            </div>
          </>
        ) : (
          <div style={{ textAlign: 'center', color: '#999', padding: 60 }}>No invoice selected</div>
        )}
      </Drawer>
    </MainLayout>
  );
}

// Helper for ordinal suffix (1st, 2nd, 3rd, etc.)
function getOrdinalSuffix(n) {
  const num = Number(n);
  if (!num) return '';
  const s = ['th', 'st', 'nd', 'rd'];
  const v = num % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}
