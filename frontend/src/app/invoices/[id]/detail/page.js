'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Card, Descriptions, Button, Space, Tag, Tabs, Table, message, Row, Col, Statistic, Divider } from 'antd';
import { EditOutlined, ArrowLeftOutlined, FilePdfOutlined, DollarOutlined } from '@ant-design/icons';
import MainLayout, { useAuth } from '../../../../components/Layout';
import useIsMobile from '../../../../hooks/useIsMobile';
import MobileCardList from '../../../../components/mobile/MobileCardList';
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
  const { hasPermission } = useAuth();
  const { isMobile } = useIsMobile();
  const canEdit = hasPermission ? hasPermission('LANDLORD/INVOICE_EDIT') : false;
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

  const openReceipt = async (paymentId) => {
    try {
      const res = await pdf.fetchReceipt(paymentId);
      const blob = new Blob([res.data], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
    } catch (err) {
      message.error('Failed to generate receipt');
    }
  };

  return (
    <MainLayout>
      <Space direction="vertical" style={{ width: '100%' }} size="large">
        <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', justifyContent: 'space-between', alignItems: isMobile ? 'stretch' : 'center', gap: isMobile ? 8 : 0 }}>
          <Button icon={<ArrowLeftOutlined />} onClick={() => router.push('/invoices')}>Back to Invoices</Button>
          <Space wrap>
            <Button icon={<FilePdfOutlined />} onClick={() => window.open(pdf.invoiceUrl(invoiceId), '_blank')}>View PDF</Button>
            {canEdit && <Button type="primary" icon={<EditOutlined />} onClick={() => router.push(`/invoices/${invoiceId}/edit`)}>Edit Invoice</Button>}
          </Space>
        </div>

        <Row gutter={[16, isMobile ? 8 : 16]}>
          <Col xs={12} sm={12} md={6}>
            <Card loading={loading}>
              <Statistic title="Invoice Amount" value={inv?.amount || 0} prefix="$" />
            </Card>
          </Col>
          <Col xs={12} sm={12} md={6}>
            <Card loading={loading}>
              <Statistic title="Amount Paid" value={inv?.amount_paid || 0} prefix="$" valueStyle={{ color: '#3f8600' }} />
            </Card>
          </Col>
          <Col xs={12} sm={12} md={6}>
            <Card loading={loading}>
              <Statistic title="Outstanding" value={inv?.outstanding || 0} prefix="$" valueStyle={{ color: (inv?.outstanding || 0) > 0 ? '#cf1322' : '#3f8600' }} />
            </Card>
          </Col>
          <Col xs={12} sm={12} md={6}>
            <Card loading={loading}>
              <Statistic title="Status" value={statusInfo.label} valueStyle={{ color: statusInfo.color === 'green' ? '#3f8600' : statusInfo.color === 'red' ? '#cf1322' : '#d48806' }} />
            </Card>
          </Col>
        </Row>

        <Card title={`Invoice ${inv?.invoice_code || '#' + invoiceId}`} loading={loading}>
          {inv && (
            <Descriptions bordered column={isMobile ? 1 : 2}>
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

        {inv?.payments && inv.payments.length > 0 && (
          <Card title={<span><DollarOutlined /> Payment History</span>}>
            {isMobile ? (
              <MobileCardList
                dataSource={inv.payments}
                rowKey={(r, i) => r.id + '-' + i}
                emptyText="No payments"
                renderCard={(r) => (
                  <Card size="small" styles={{ body: { padding: 12 } }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                      <span style={{ fontWeight: 500 }}>{formatDate(r.payment_date)}</span>
                      <span style={{ fontWeight: 600 }}>{formatCurrency(r.amount)}</span>
                    </div>
                    <div style={{ fontSize: 12, color: '#666' }}>
                      {r.transaction_code && <div><strong>Txn:</strong> {r.transaction_code}</div>}
                      <div><strong>Contact:</strong> {[r.contact_first_name, r.contact_last_name].filter(Boolean).join(' ') || '-'}</div>
                      <div><strong>Method:</strong> {r.payment_method_name || '-'}</div>
                      {r.payment_category_name && <div><strong>Category:</strong> {r.payment_category_name}</div>}
                    </div>
                    <div style={{ marginTop: 6 }}>
                      <Button type="link" size="small" icon={<FilePdfOutlined />}
                        style={{ color: '#52c41a', padding: 0 }}
                        onClick={() => openReceipt(r.id)}>
                        Receipt
                      </Button>
                    </div>
                  </Card>
                )}
              />
            ) : (
              <Table
                dataSource={inv.payments}
                rowKey={(r, i) => r.id + '-' + i}
                pagination={false}
                size="small"
                columns={[
                  {
                    title: 'Date',
                    dataIndex: 'payment_date',
                    render: (d) => formatDate(d),
                  },
                  {
                    title: 'Transaction ID',
                    dataIndex: 'transaction_code',
                  },
                  {
                    title: 'Contact',
                    render: (_, r) => [r.contact_first_name, r.contact_last_name].filter(Boolean).join(' ') || '-',
                  },
                  {
                    title: 'Payment Method',
                    dataIndex: 'payment_method_name',
                    render: (v) => v || '-',
                  },
                  {
                    title: 'Category',
                    dataIndex: 'payment_category_name',
                    render: (v) => v || '-',
                  },
                  {
                    title: 'Amount',
                    dataIndex: 'amount',
                    render: (v) => formatCurrency(v),
                    align: 'right',
                  },
                  {
                    title: '',
                    key: 'receipt',
                    width: 80,
                    render: (_, r) => (
                      <Button type="link" size="small" icon={<FilePdfOutlined />}
                        style={{ color: '#52c41a', padding: 0 }}
                        onClick={() => openReceipt(r.id)}>
                        Receipt
                      </Button>
                    ),
                  },
                ]}
              />
            )}
            <Divider style={{ margin: '12px 0' }} />
            <Row>
              <Col xs={24} md={12}>
                <strong>Total Paid: </strong>{formatCurrency(inv.amount_paid)}
              </Col>
              <Col xs={24} md={12} style={{ textAlign: isMobile ? 'left' : 'right' }}>
                <strong>Outstanding: </strong>
                <span style={{ color: inv.outstanding > 0 ? '#cf1322' : '#3f8600' }}>
                  {formatCurrency(inv.outstanding)}
                </span>
              </Col>
            </Row>
          </Card>
        )}
      </Space>
    </MainLayout>
  );
}
