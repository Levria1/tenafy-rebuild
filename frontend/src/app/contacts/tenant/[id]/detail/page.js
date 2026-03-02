'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Card, Descriptions, Button, Space, Tag, Tabs, Table, message } from 'antd';
import { EditOutlined, ArrowLeftOutlined } from '@ant-design/icons';
import MainLayout from '../../../../../components/Layout';
import { tenant, leasing, invoice } from '../../../../../lib/api';

export default function TenantDetailPage() {
  const [tenantData, setTenantData] = useState(null);
  const [leases, setLeases] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [invoicesLoading, setInvoicesLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const params = useParams();
  const tenantId = params.id;

  useEffect(() => {
    loadTenant();
    loadLeases();
    loadInvoices();
  }, [tenantId]);

  const loadTenant = async () => {
    try {
      const response = await tenant.get(tenantId);
      if (response.data.code === 200) {
        setTenantData(response.data.data);
      }
    } catch (error) {
      message.error('Failed to load tenant');
    } finally {
      setLoading(false);
    }
  };

  const loadLeases = async () => {
    try {
      const response = await tenant.getLeases(tenantId);
      if (response.data.code === 200) {
        setLeases(response.data.data || []);
      }
    } catch (error) {
      console.error('Failed to load leases');
    }
  };

  const loadInvoices = async () => {
    setInvoicesLoading(true);
    try {
      const response = await invoice.list({ tenantId: tenantId });
      if (response.data.code === 200) {
        setInvoices(response.data.data?.list || response.data.data || []);
      }
    } catch (error) {
      console.error('Failed to load invoices');
    } finally {
      setInvoicesLoading(false);
    }
  };

  const invoiceColumns = [
    { title: 'Invoice Code', dataIndex: 'invoice_code', key: 'invoice_code' },
    { title: 'Amount', dataIndex: 'amount', key: 'amount', render: (v) => `$${Number(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}` },
    { title: 'Due Date', dataIndex: 'due_date', key: 'due_date', render: (v) => v ? new Date(v).toLocaleDateString() : '-' },
    {
      title: 'Status', dataIndex: 'status', key: 'status',
      render: (s) => {
        const colorMap = { PAID: 'green', UNPAID: 'red', PARTIALLY_PAID: 'orange', DRAFT: 'default', OVERDUE: 'volcano' };
        return <Tag color={colorMap[s] || 'default'}>{s || '-'}</Tag>;
      },
    },
    { title: 'Created At', dataIndex: 'created_at', key: 'created_at', render: (v) => v ? new Date(v).toLocaleDateString() : '-' },
    {
      title: 'Actions', key: 'actions',
      render: (_, r) => (
        <Button type="link" onClick={() => router.push(`/invoice/${r.id}/detail`)}>View</Button>
      ),
    },
  ];

  const leaseColumns = [
    { title: 'Property', dataIndex: 'property_name', key: 'property_name' },
    { title: 'Unit', dataIndex: 'unit_number', key: 'unit_number' },
    { title: 'Start Date', dataIndex: 'start_date', key: 'start_date' },
    { title: 'End Date', dataIndex: 'end_date', key: 'end_date' },
    { title: 'Monthly Rent', dataIndex: 'monthly_rent', key: 'monthly_rent', render: (v) => `$${v?.toLocaleString()}` },
    { title: 'Status', dataIndex: 'status', key: 'status', render: (s) => <Tag color={s === 'ACTIVE' ? 'green' : 'red'}>{s}</Tag> },
    { title: 'Actions', key: 'actions', render: (_, r) => (
      <Button type="link" onClick={() => router.push(`/leasing/${r.id}/detail`)}>View</Button>
    )},
  ];

  const tabItems = [
    {
      key: 'profile',
      label: 'Profile',
      children: (
        <Descriptions bordered column={2}>
          <Descriptions.Item label="Name">{tenantData ? `${tenantData.first_name} ${tenantData.last_name}` : ''}</Descriptions.Item>
          <Descriptions.Item label="Email">{tenantData?.email}</Descriptions.Item>
          <Descriptions.Item label="Phone">{tenantData?.phone}</Descriptions.Item>
          <Descriptions.Item label="Status"><Tag color={tenantData?.status === 1 ? 'green' : 'red'}>{tenantData?.status === 1 ? 'Active' : 'Inactive'}</Tag></Descriptions.Item>
          <Descriptions.Item label="ID Type">{tenantData?.id_type || '-'}</Descriptions.Item>
          <Descriptions.Item label="ID Number">{tenantData?.id_number || '-'}</Descriptions.Item>
          <Descriptions.Item label="Emergency Contact" span={2}>{tenantData?.emergency_contact || '-'}</Descriptions.Item>
          <Descriptions.Item label="Emergency Phone" span={2}>{tenantData?.emergency_phone || '-'}</Descriptions.Item>
          <Descriptions.Item label="Address" span={2}>{tenantData?.address || '-'}</Descriptions.Item>
          <Descriptions.Item label="Notes" span={2}>{tenantData?.notes || '-'}</Descriptions.Item>
        </Descriptions>
      ),
    },
    {
      key: 'leases',
      label: 'Leases',
      children: (
        <Table columns={leaseColumns} dataSource={leases} rowKey="id" />
      ),
    },
    {
      key: 'accounting',
      label: 'Accounting',
      children: (
        <Table
          columns={invoiceColumns}
          dataSource={invoices}
          rowKey="id"
          loading={invoicesLoading}
          locale={{ emptyText: 'No invoices found' }}
        />
      ),
    },
  ];

  return (
    <MainLayout>
      <Space direction="vertical" style={{ width: '100%' }} size="large">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Button icon={<ArrowLeftOutlined />} onClick={() => router.push('/contacts')}>Back to Contacts</Button>
          <Button type="primary" icon={<EditOutlined />} onClick={() => router.push(`/contacts/tenant/${tenantId}/edit`)}>Edit Tenant</Button>
        </div>
        <Card title={tenantData ? `${tenantData.first_name} ${tenantData.last_name}` : 'Tenant Details'} loading={loading}>
          {tenantData && <Tabs items={tabItems} />}
        </Card>
      </Space>
    </MainLayout>
  );
}
