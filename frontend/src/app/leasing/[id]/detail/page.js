'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Card, Descriptions, Button, Space, Tag, Tabs, Table, message } from 'antd';
import { EditOutlined, ArrowLeftOutlined, FilePdfOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import MainLayout from '../../../../components/Layout';
import { leasing, pdf } from '../../../../lib/api';

const LEASE_TYPE_MAP = { 0: 'Fixed', 1: 'Month-to-Month' };
const CONTRACT_TYPE_MAP = { 0: 'Standard', 1: 'Commercial', 2: 'Residential', 3: 'Short Term' };
const INVOICING_MAP = {
  'weekly': 'Weekly', '7': 'Weekly',
  'bi-weekly': 'Bi-Weekly', '14': 'Bi-Weekly',
  'monthly': 'Monthly', '30': 'Monthly',
  'quarterly': 'Quarterly', '90': 'Quarterly',
  'bi-annually': 'Bi-Annually', '180': 'Bi-Annually',
};

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

  const formatDate = (d) => {
    if (!d) return '-';
    return dayjs(d).format('YYYY-MM-DD');
  };

  const formatCurrency = (amount) => {
    if (amount == null || amount === '' || amount === 0) return '-';
    return `$${Number(amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  const statusLabel = lease?.status === 1 ? 'Active' : lease?.status === 0 ? 'Inactive' : '-';
  const statusColor = lease?.status === 1 ? 'green' : 'red';

  const tabItems = [
    {
      key: 'details',
      label: 'Details',
      children: (
        <Descriptions bordered column={2}>
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
          <Descriptions.Item label="Contract Type">{CONTRACT_TYPE_MAP[lease?.contract_type] || '-'}</Descriptions.Item>
          <Descriptions.Item label="Status"><Tag color={statusColor}>{statusLabel}</Tag></Descriptions.Item>
          <Descriptions.Item label="Start Date">{formatDate(lease?.start_date)}</Descriptions.Item>
          <Descriptions.Item label="End Date">{formatDate(lease?.end_date)}</Descriptions.Item>
          <Descriptions.Item label="Monthly Rent">{formatCurrency(lease?.amount || lease?.price)}</Descriptions.Item>
          <Descriptions.Item label="Security Deposit">{formatCurrency(lease?.deposit)}</Descriptions.Item>
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
          {lease?.note && (
            <Descriptions.Item label="Notes" span={2}>{lease.note}</Descriptions.Item>
          )}
        </Descriptions>
      ),
    },
    {
      key: 'payments',
      label: 'Payments',
      children: (
        <Table
          columns={[
            { title: 'Date', dataIndex: 'payment_date', key: 'payment_date', render: (v) => formatDate(v) },
            { title: 'Amount', dataIndex: 'amount', key: 'amount', render: (v) => formatCurrency(v) },
            { title: 'Method', dataIndex: 'payment_method', key: 'payment_method', render: (v) => v || '-' },
            { title: 'Status', dataIndex: 'status', key: 'status', render: (s) => <Tag color={s === 'PAID' ? 'green' : 'red'}>{s}</Tag> },
          ]}
          dataSource={lease?.payments || []}
          rowKey="id"
          locale={{ emptyText: 'No payments recorded' }}
        />
      ),
    },
  ];

  const leaseTitle = lease?.lease_no || `#${leaseId}`;

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
        <Card title={`Lease ${leaseTitle}`} loading={loading}>
          {lease && <Tabs items={tabItems} />}
        </Card>
      </Space>
    </MainLayout>
  );
}
