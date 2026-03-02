'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Card, Descriptions, Button, Space, Tag, Tabs, Table, message, Row, Col, Statistic } from 'antd';
import { EditOutlined, ArrowLeftOutlined, FilePdfOutlined } from '@ant-design/icons';
import MainLayout from '../../../../components/Layout';
import { invoice, pdf } from '../../../../lib/api';

const STATUS_MAP = {
  0: { label: 'Open', color: 'orange' },
  1: { label: 'Paid', color: 'green' },
  2: { label: 'Overdue', color: 'red' },
  '-1': { label: 'Deleted', color: 'default' },
};

const TYPE_MAP = { 0: 'Inflow', 1: 'Outflow' };

export default function InvoiceDetailPage() {
  const [inv, setInv] = useState(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const params = useParams();
  const invoiceId = params.id;

  useEffect(() => {
    loadInvoice();
  }, [invoiceId]);

  const loadInvoice = async () => {
    try {
      const response = await invoice.get(invoiceId);
      if (response.data.code === 200) {
        setInv(response.data.data);
      }
    } catch (error) {
      message.error('Failed to load invoice');
    } finally {
      setLoading(false);
    }
  };

  const formatDate = (d) => {
    if (!d) return '-';
    return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  };

  const formatCurrency = (amount) => {
    if (amount == null) return '$0.00';
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
  };

  const statusInfo = STATUS_MAP[inv?.status] || { label: 'Unknown', color: 'default' };

  return (
    <MainLayout>
      <Space direction="vertical" style={{ width: '100%' }} size="large">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Button icon={<ArrowLeftOutlined />} onClick={() => router.push('/invoices')}>Back to Invoices</Button>
          <Space>
            <Button icon={<FilePdfOutlined />} onClick={() => window.open(pdf.invoiceUrl(invoiceId), '_blank')}>View PDF</Button>
            <Button type="primary" icon={<EditOutlined />} onClick={() => router.push(`/invoices/${invoiceId}/edit`)}>Edit Invoice</Button>
          </Space>
        </div>

        <Row gutter={16}>
          <Col span={8}>
            <Card loading={loading}>
              <Statistic title="Invoice Amount" value={inv?.amount || 0} prefix="$" />
            </Card>
          </Col>
          <Col span={8}>
            <Card loading={loading}>
              <Statistic title="Type" value={TYPE_MAP[inv?.type] || 'Inflow'} />
            </Card>
          </Col>
          <Col span={8}>
            <Card loading={loading}>
              <Statistic title="Status" value={statusInfo.label} valueStyle={{ color: statusInfo.color === 'green' ? '#3f8600' : statusInfo.color === 'red' ? '#cf1322' : '#d48806' }} />
            </Card>
          </Col>
        </Row>

        <Card title={`Invoice ${inv?.invoice_code || '#' + invoiceId}`} loading={loading}>
          {inv && (
            <Descriptions bordered column={2}>
              <Descriptions.Item label="Invoice Code">{inv.invoice_code || '-'}</Descriptions.Item>
              <Descriptions.Item label="Status"><Tag color={statusInfo.color}>{statusInfo.label}</Tag></Descriptions.Item>
              <Descriptions.Item label="Tenant">{[inv.tenant_first_name, inv.tenant_last_name].filter(Boolean).join(' ') || '-'}</Descriptions.Item>
              <Descriptions.Item label="Tenant Email">{inv.tenant_email || '-'}</Descriptions.Item>
              <Descriptions.Item label="Property">{inv.property_name || '-'}</Descriptions.Item>
              <Descriptions.Item label="Unit">{inv.unit_name || '-'}</Descriptions.Item>
              <Descriptions.Item label="Due Date">{formatDate(inv.due_on)}</Descriptions.Item>
              <Descriptions.Item label="Amount">{formatCurrency(inv.amount)}</Descriptions.Item>
              <Descriptions.Item label="Type">{TYPE_MAP[inv.type] || 'Inflow'}</Descriptions.Item>
              <Descriptions.Item label="Created">{formatDate(inv.created_at)}</Descriptions.Item>
              <Descriptions.Item label="Notes" span={2}>{inv.note || '-'}</Descriptions.Item>
            </Descriptions>
          )}
        </Card>
      </Space>
    </MainLayout>
  );
}
