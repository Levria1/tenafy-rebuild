'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter, useParams, useSearchParams } from 'next/navigation';
import {
  Button, Space, Tag, Table, message, Spin, Empty, Dropdown,
  Typography, Statistic, Row, Col, Divider, Avatar,
} from 'antd';
import {
  EditOutlined, UserOutlined, MailOutlined,
  FileTextOutlined, DollarOutlined,
  DownOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import MainLayout from '../../../../../components/Layout';
import { tenant } from '../../../../../lib/api';

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
  const [invoicePagination, setInvoicePagination] = useState({ current: 1, pageSize: 20, total: 0 });
  const [activeTab, setActiveTab] = useState(initialTab);

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
      const res = await tenant.getAccountingList(tenantId, {}, { page, limit: 20 });
      if (res.data.code === 200) {
        setInvoices(res.data.data.content || []);
        setInvoicePagination(prev => ({
          ...prev,
          current: page,
          total: res.data.data.totalElements || 0,
        }));
      }
    } catch (err) {
      console.error('Failed to load invoices:', err);
    } finally {
      setInvoicesLoading(false);
    }
  }, [tenantId]);

  useEffect(() => { loadTenant(); }, [loadTenant]);
  useEffect(() => { loadLeases(); }, [loadLeases]);
  useEffect(() => {
    if (activeTab === 'accounting') loadInvoices();
  }, [activeTab, loadInvoices]);

  const statusMap = { 0: { text: 'Open', color: 'blue' }, 1: { text: 'Paid', color: 'green' }, 2: { text: 'Overdue', color: 'red' } };
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
              <FieldValue label="Additional Tenant" value="—" />
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
          </div>
        )}
      </div>
    );
  };

  // =========================================================================
  // ACCOUNTING TAB CONTENT
  // =========================================================================
  const invoiceColumns = [
    {
      title: 'Invoice Code', dataIndex: 'invoice_code', key: 'invoice_code',
      render: (code, r) => (
        <Button type="link" size="small" onClick={() => router.push(`/invoices/${r.id}`)}>
          {code || `INV-${r.id}`}
        </Button>
      ),
    },
    { title: 'Description', dataIndex: 'description', key: 'description', ellipsis: true },
    {
      title: 'Amount', dataIndex: 'amount', key: 'amount',
      render: (v) => fmt(v),
    },
    {
      title: 'Due Date', dataIndex: 'due_on', key: 'due_on',
      render: (d) => d ? dayjs(d).format('YYYY-MM-DD') : '—',
    },
    {
      title: 'Status', dataIndex: 'status', key: 'status',
      render: (s) => {
        const cfg = statusMap[s] || { text: 'Unknown', color: 'default' };
        return <Tag color={cfg.color}>{cfg.text}</Tag>;
      },
    },
    {
      title: 'Created', dataIndex: 'created_at', key: 'created_at',
      render: (d) => d ? dayjs(d).format('YYYY-MM-DD') : '—',
    },
  ];

  const AccountingContent = () => (
    <div>
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={8}>
          <div style={{ background: '#fff', border: '1px solid #f0f0f0', borderRadius: 6, padding: 16 }}>
            <Statistic title="Outstanding" value={profileSum?.outstanding || 0} prefix="$" precision={2} valueStyle={{ color: '#cf1322' }} />
          </div>
        </Col>
        <Col span={8}>
          <div style={{ background: '#fff', border: '1px solid #f0f0f0', borderRadius: 6, padding: 16 }}>
            <Statistic title="Total Paid" value={profileSum?.paid || 0} prefix="$" precision={2} valueStyle={{ color: '#3f8600' }} />
          </div>
        </Col>
        <Col span={8}>
          <div style={{ background: '#fff', border: '1px solid #f0f0f0', borderRadius: 6, padding: 16 }}>
            <Statistic title="Active Leases" value={profileSum?.activeLeases || 0} valueStyle={{ color: '#1677ff' }} />
          </div>
        </Col>
      </Row>

      <Table
        columns={invoiceColumns}
        dataSource={invoices}
        rowKey="id"
        loading={invoicesLoading}
        size="small"
        pagination={{
          ...invoicePagination,
          onChange: (page) => loadInvoices(page),
          showSizeChanger: false,
          showTotal: (total) => `Total ${total} invoices`,
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
