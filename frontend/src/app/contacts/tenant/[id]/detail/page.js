'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter, useParams, useSearchParams } from 'next/navigation';
import {
  Card, Descriptions, Button, Space, Tag, Tabs, Table, message,
  Avatar, Typography, Statistic, Row, Col, Divider, Spin, Empty,
} from 'antd';
import {
  ArrowLeftOutlined, EditOutlined, UserOutlined, MailOutlined,
  PhoneOutlined, FileTextOutlined, DollarOutlined, CalendarOutlined,
  CheckCircleFilled, CloseCircleFilled, HomeOutlined,
} from '@ant-design/icons';
import MainLayout from '../../../../../components/Layout';
import { tenant } from '../../../../../lib/api';

const { Text, Title } = Typography;

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
  const [leasesLoading, setLeasesLoading] = useState(false);
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
    setLeasesLoading(true);
    try {
      const res = await tenant.getLeases(tenantId);
      if (res.data.code === 200) setLeases(res.data.data || []);
    } catch (err) {
      console.error('Failed to load leases:', err);
    } finally {
      setLeasesLoading(false);
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
  useEffect(() => { loadInvoices(); }, [loadInvoices]);

  const statusMap = { 0: { text: 'Open', color: 'blue' }, 1: { text: 'Paid', color: 'green' }, 2: { text: 'Overdue', color: 'red' } };

  // ---- Profile Tab ----
  const ProfileTab = () => (
    <div>
      <Row gutter={[24, 24]}>
        <Col span={24}>
          <Card size="small" title="Personal Information">
            <Descriptions column={{ xs: 1, sm: 2 }} size="small">
              <Descriptions.Item label="Full Name">
                {tenantData ? `${tenantData.first_name} ${tenantData.last_name}` : '-'}
              </Descriptions.Item>
              <Descriptions.Item label="Email">{tenantData?.email || '-'}</Descriptions.Item>
              <Descriptions.Item label="Phone">{tenantData?.phone || '-'}</Descriptions.Item>
              <Descriptions.Item label="Date of Birth">
                {tenantData?.birth_date ? new Date(tenantData.birth_date).toLocaleDateString() : '-'}
              </Descriptions.Item>
              <Descriptions.Item label="Company">{tenantData?.company_name || '-'}</Descriptions.Item>
              <Descriptions.Item label="ID Card">{tenantData?.id_card || '-'}</Descriptions.Item>
            </Descriptions>
          </Card>
        </Col>
        <Col span={24}>
          <Card size="small" title="Employment">
            <Descriptions column={{ xs: 1, sm: 2 }} size="small">
              <Descriptions.Item label="Profession">{tenantData?.profession || '-'}</Descriptions.Item>
              <Descriptions.Item label="Employer">{tenantData?.employer || '-'}</Descriptions.Item>
              <Descriptions.Item label="Salary">
                {tenantData?.salary ? `$${Number(tenantData.salary).toLocaleString()}` : '-'}
              </Descriptions.Item>
              <Descriptions.Item label="Referral">{tenantData?.referral || '-'}</Descriptions.Item>
            </Descriptions>
          </Card>
        </Col>
        <Col span={24}>
          <Card size="small" title="Emergency Contact">
            <Descriptions column={{ xs: 1, sm: 2 }} size="small">
              <Descriptions.Item label="Contact">{tenantData?.emergency_contact || '-'}</Descriptions.Item>
            </Descriptions>
          </Card>
        </Col>
      </Row>
    </div>
  );

  // ---- Leases Tab ----
  const leaseColumns = [
    {
      title: 'Property',
      dataIndex: 'property_name',
      key: 'property_name',
      render: (name) => name || '-',
    },
    {
      title: 'Unit',
      dataIndex: 'unit_name',
      key: 'unit_name',
      render: (name) => name || '-',
    },
    {
      title: 'Start Date',
      dataIndex: 'start_date',
      key: 'start_date',
      render: (d) => d ? new Date(d).toLocaleDateString() : '-',
    },
    {
      title: 'End Date',
      dataIndex: 'end_date',
      key: 'end_date',
      render: (d) => d ? new Date(d).toLocaleDateString() : '-',
    },
    {
      title: 'Rent',
      dataIndex: 'amount',
      key: 'amount',
      render: (v) => v ? `$${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2 })}` : '-',
    },
    {
      title: 'Type',
      dataIndex: 'type',
      key: 'type',
      render: (t) => t === 1 ? <Tag>Month-to-Month</Tag> : <Tag color="blue">Fixed Term</Tag>,
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      render: (s) => s === 1 ? <Tag color="green">Active</Tag> : <Tag color="default">Expired</Tag>,
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_, r) => (
        <Button type="link" size="small" onClick={() => router.push(`/leasing/${r.id}`)}>View</Button>
      ),
    },
  ];

  const LeasesTab = () => {
    const activeLease = leases.find(l => l.status === 1);
    return (
      <div>
        {activeLease && (
          <Card
            size="small"
            style={{ marginBottom: 16, borderLeft: '4px solid #52c41a' }}
          >
            <Row gutter={16} align="middle">
              <Col flex="auto">
                <Space direction="vertical" size={0}>
                  <Text strong style={{ fontSize: 15 }}>
                    <HomeOutlined style={{ marginRight: 8, color: '#52c41a' }} />
                    {activeLease.property_name} — {activeLease.unit_name}
                  </Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {new Date(activeLease.start_date).toLocaleDateString()} → {activeLease.end_date ? new Date(activeLease.end_date).toLocaleDateString() : 'Ongoing'}
                  </Text>
                </Space>
              </Col>
              <Col>
                <Statistic
                  title="Monthly Rent"
                  value={activeLease.amount || 0}
                  prefix="$"
                  precision={2}
                  valueStyle={{ fontSize: 18 }}
                />
              </Col>
              <Col>
                <Tag color="green" style={{ fontSize: 13, padding: '2px 12px' }}>
                  {activeLease.type === 1 ? 'Month-to-Month' : 'Fixed Term'}
                </Tag>
              </Col>
            </Row>
          </Card>
        )}
        <Table
          columns={leaseColumns}
          dataSource={leases}
          rowKey="id"
          loading={leasesLoading}
          size="small"
          pagination={false}
          locale={{ emptyText: 'No leases found' }}
        />
      </div>
    );
  };

  // ---- Accounting Tab ----
  const invoiceColumns = [
    {
      title: 'Invoice Code',
      dataIndex: 'invoice_code',
      key: 'invoice_code',
      render: (code, r) => (
        <Button type="link" size="small" onClick={() => router.push(`/invoices/${r.id}`)}>
          {code || `INV-${r.id}`}
        </Button>
      ),
    },
    {
      title: 'Description',
      dataIndex: 'description',
      key: 'description',
      ellipsis: true,
    },
    {
      title: 'Amount',
      dataIndex: 'amount',
      key: 'amount',
      render: (v) => `$${Number(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}`,
    },
    {
      title: 'Due Date',
      dataIndex: 'due_on',
      key: 'due_on',
      render: (d) => d ? new Date(d).toLocaleDateString() : '-',
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      render: (s) => {
        const cfg = statusMap[s] || { text: 'Unknown', color: 'default' };
        return <Tag color={cfg.color}>{cfg.text}</Tag>;
      },
    },
    {
      title: 'Created',
      dataIndex: 'created_at',
      key: 'created_at',
      render: (d) => d ? new Date(d).toLocaleDateString() : '-',
    },
  ];

  const AccountingTab = () => (
    <div>
      {/* Summary cards */}
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={8}>
          <Card size="small">
            <Statistic
              title="Outstanding"
              value={profileSum?.outstanding || 0}
              prefix="$"
              precision={2}
              valueStyle={{ color: '#cf1322' }}
            />
          </Card>
        </Col>
        <Col span={8}>
          <Card size="small">
            <Statistic
              title="Total Paid"
              value={profileSum?.paid || 0}
              prefix="$"
              precision={2}
              valueStyle={{ color: '#3f8600' }}
            />
          </Card>
        </Col>
        <Col span={8}>
          <Card size="small">
            <Statistic
              title="Active Leases"
              value={profileSum?.activeLeases || 0}
              valueStyle={{ color: '#1677ff' }}
            />
          </Card>
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

  const tabItems = [
    { key: 'profile', label: 'Profile', children: <ProfileTab /> },
    { key: 'leases', label: `Leases (${leases.length})`, children: <LeasesTab /> },
    { key: 'accounting', label: 'Accounting', children: <AccountingTab /> },
  ];

  if (loading) {
    return (
      <MainLayout>
        <div style={{ padding: 48, textAlign: 'center' }}><Spin size="large" /></div>
      </MainLayout>
    );
  }

  const hasActiveLease = leases.some(l => l.status === 1);

  return (
    <MainLayout>
      {/* Back + Edit buttons */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => router.push('/contacts/tenants')}>
          Back to Tenants
        </Button>
        <Space>
          <Button icon={<MailOutlined />} onClick={() => {
            if (tenantData?.email) {
              router.push(`/contacts/email/send?to=${encodeURIComponent(tenantData.email)}&name=${encodeURIComponent(tenantData.first_name + ' ' + tenantData.last_name)}`);
            } else {
              message.warning('No email address');
            }
          }}>
            Email
          </Button>
          <Button icon={<FileTextOutlined />}
            onClick={() => router.push(`/invoices/create?tenantId=${tenantId}&tenantName=${encodeURIComponent((tenantData?.first_name || '') + ' ' + (tenantData?.last_name || ''))}`)}>
            Add Invoice
          </Button>
          <Button type="primary" icon={<EditOutlined />}
            onClick={() => router.push(`/contacts/tenant/${tenantId}/edit`)}>
            Edit
          </Button>
        </Space>
      </div>

      {/* Tenant header card */}
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
          <Avatar size={64} icon={<UserOutlined />} style={{ backgroundColor: '#e6f4ff', flexShrink: 0 }} />
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
              <Title level={4} style={{ margin: 0 }}>
                {tenantData?.first_name} {tenantData?.last_name}
              </Title>
              {hasActiveLease ? (
                <Tag icon={<CheckCircleFilled />} color="success">Active Lease</Tag>
              ) : (
                <Tag icon={<CloseCircleFilled />} color="error">No Active Lease</Tag>
              )}
            </div>
            <Space split={<Divider type="vertical" />} size={4} wrap>
              {tenantData?.email && (
                <Text type="secondary"><MailOutlined style={{ marginRight: 4 }} />{tenantData.email}</Text>
              )}
              {tenantData?.phone && (
                <Text type="secondary"><PhoneOutlined style={{ marginRight: 4 }} />{tenantData.phone}</Text>
              )}
              {tenantData?.company_name && (
                <Text type="secondary">{tenantData.company_name}</Text>
              )}
            </Space>
          </div>
          <div style={{ textAlign: 'right' }}>
            {profileSum && (
              <Space size={24}>
                <div>
                  <Text type="secondary" style={{ fontSize: 12 }}>Outstanding</Text>
                  <br />
                  <Text strong style={{ fontSize: 16, color: profileSum.outstanding > 0 ? '#cf1322' : '#595959' }}>
                    ${Number(profileSum.outstanding || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                  </Text>
                </div>
                <div>
                  <Text type="secondary" style={{ fontSize: 12 }}>Paid</Text>
                  <br />
                  <Text strong style={{ fontSize: 16, color: '#3f8600' }}>
                    ${Number(profileSum.paid || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                  </Text>
                </div>
              </Space>
            )}
          </div>
        </div>
      </Card>

      {/* Tabs */}
      <Card>
        <Tabs activeKey={activeTab} onChange={setActiveTab} items={tabItems} />
      </Card>
    </MainLayout>
  );
}
