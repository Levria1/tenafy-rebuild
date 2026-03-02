'use client';

import { useEffect, useState } from 'react';
import { Card, Table, Button, Space, Tag, Row, Col, Statistic, message } from 'antd';
import { PayCircleOutlined } from '@ant-design/icons';
import { useRouter } from 'next/navigation';
import MainLayout from '../../components/Layout';
import { invoice, tenant } from '../../lib/api';
import Cookies from 'js-cookie';

export default function PaymentPage() {
  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({ total: 0, paid: 0, pending: 0 });
  const router = useRouter();
  const tenantId = Cookies.get('tenant_id');

  useEffect(() => {
    loadInvoices();
  }, []);

  const loadInvoices = async () => {
    try {
      const response = await invoice.list({ tenant_id: tenantId, status: 'PENDING' }, { page: 1, limit: 50 });
      if (response.data.code === 200) {
        const data = response.data.data.content || [];
        setInvoices(data);
        const total = data.reduce((sum, inv) => sum + (inv.amount || 0), 0);
        setStats({ total, paid: 0, pending: total });
      }
    } catch (error) {
      console.error('Failed to load invoices:', error);
    } finally {
      setLoading(false);
    }
  };

  const handlePay = (invoiceId) => {
    router.push(`/payment/create?invoiceId=${invoiceId}`);
  };

  const columns = [
    { title: 'Invoice #', dataIndex: 'invoice_code', key: 'invoice_code' },
    { title: 'Property', dataIndex: 'property_name', key: 'property_name' },
    { title: 'Unit', dataIndex: 'unit_name', key: 'unit_name' },
    { title: 'Amount', dataIndex: 'amount', key: 'amount', render: (v) => `$${v?.toLocaleString()}` },
    { title: 'Due Date', dataIndex: 'due_date', key: 'due_date' },
    { title: 'Status', dataIndex: 'status', key: 'status', render: (s) => <Tag color="orange">{s}</Tag> },
    { title: 'Actions', key: 'actions', render: (_, r) => (
      <Button type="primary" icon={<PayCircleOutlined />} onClick={() => handlePay(r.id)}>Pay Now</Button>
    )},
  ];

  return (
    <MainLayout>
      <h1 style={{ marginBottom: 16 }}>Payment Portal</h1>
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={8}><Card><Statistic title="Total Due" value={stats.total} prefix="$" valueStyle={{ color: '#faad14' }} /></Card></Col>
        <Col span={8}><Card><Statistic title="Paid" value={stats.paid} prefix="$" valueStyle={{ color: '#52c41a' }} /></Card></Col>
        <Col span={8}><Card><Statistic title="Pending" value={stats.pending} prefix="$" valueStyle={{ color: '#1890ff' }} /></Card></Col>
      </Row>
      <Card title="Outstanding Invoices">
        <Table columns={columns} dataSource={invoices} rowKey="id" loading={loading} />
      </Card>
    </MainLayout>
  );
}
