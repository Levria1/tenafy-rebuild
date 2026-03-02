'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Card, Descriptions, Button, Space, Tag, Tabs, Table, message } from 'antd';
import { EditOutlined, ArrowLeftOutlined, FilePdfOutlined } from '@ant-design/icons';
import MainLayout from '../../../../components/Layout';
import { leasing, tenant, pdf } from '../../../../lib/api';

export default function LeasingDetailPage() {
  const [lease, setLease] = useState(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const params = useParams();
  const leaseId = params.id;

  useEffect(() => {
    loadLease();
  }, [leaseId]);

  const loadLease = async () => {
    try {
      const response = await leasing.get(leaseId);
      if (response.data.code === 200) {
        setLease(response.data.data);
      }
    } catch (error) {
      message.error('Failed to load lease');
    } finally {
      setLoading(false);
    }
  };

  const getStatusColor = (status) => {
    const colors = { ACTIVE: 'green', EXPIRED: 'red', PENDING: 'orange', TERMINATED: 'default' };
    return colors[status] || 'default';
  };

  const paymentColumns = [
    { title: 'Date', dataIndex: 'payment_date', key: 'payment_date' },
    { title: 'Amount', dataIndex: 'amount', key: 'amount', render: (val) => `$${val?.toLocaleString()}` },
    { title: 'Method', dataIndex: 'payment_method', key: 'payment_method' },
    { title: 'Status', dataIndex: 'status', key: 'status', render: (s) => <Tag color={s === 'PAID' ? 'green' : 'red'}>{s}</Tag> },
  ];

  const tabItems = [
    {
      key: 'details',
      label: 'Details',
      children: (
        <Descriptions bordered column={2}>
          <Descriptions.Item label="Lease ID">{lease?.id}</Descriptions.Item>
          <Descriptions.Item label="Property">{lease?.property_name}</Descriptions.Item>
          <Descriptions.Item label="Unit">{lease?.unit_number}</Descriptions.Item>
          <Descriptions.Item label="Tenant">{lease?.tenant_name}</Descriptions.Item>
          <Descriptions.Item label="Start Date">{lease?.start_date}</Descriptions.Item>
          <Descriptions.Item label="End Date">{lease?.end_date}</Descriptions.Item>
          <Descriptions.Item label="Monthly Rent">${lease?.monthly_rent?.toLocaleString()}</Descriptions.Item>
          <Descriptions.Item label="Security Deposit">${lease?.deposit?.toLocaleString() || '-'}</Descriptions.Item>
          <Descriptions.Item label="Status"><Tag color={getStatusColor(lease?.status)}>{lease?.status}</Tag></Descriptions.Item>
          <Descriptions.Item label="Move-in Date">{lease?.move_in_date || '-'}</Descriptions.Item>
          <Descriptions.Item label="Move-out Date">{lease?.move_out_date || '-'}</Descriptions.Item>
          <Descriptions.Item label="Terms" span={2}>{lease?.terms || '-'}</Descriptions.Item>
        </Descriptions>
      ),
    },
    {
      key: 'payments',
      label: 'Payments',
      children: (
        <Table columns={paymentColumns} dataSource={lease?.payments || []} rowKey="id" />
      ),
    },
  ];

  return (
    <MainLayout>
      <Space direction="vertical" style={{ width: '100%' }} size="large">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Button icon={<ArrowLeftOutlined />} onClick={() => router.push('/leasing')}>Back to Leases</Button>
          <Space>
            <Button icon={<FilePdfOutlined />} onClick={() => window.open(pdf.leaseUrl(leaseId), '_blank')}>View PDF</Button>
            <Button type="primary" icon={<EditOutlined />} onClick={() => router.push(`/leasing/${leaseId}/edit`)}>Edit Lease</Button>
          </Space>
        </div>
        <Card title={`Lease #${leaseId}`} loading={loading}>
          {lease && <Tabs items={tabItems} />}
        </Card>
      </Space>
    </MainLayout>
  );
}
