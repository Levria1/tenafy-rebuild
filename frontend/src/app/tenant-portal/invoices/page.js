'use client';

import { useEffect, useState } from 'react';
import { Table, Tag, Typography, Card, Button, Space, Tooltip, Spin, message } from 'antd';
import { FilePdfOutlined, DownloadOutlined } from '@ant-design/icons';
import { tenantPortal } from '../../../lib/tenantApi';
import { formatDateOnly } from '../../../lib/dateOnly';

const { Title, Text } = Typography;

// A blob download rather than a link: both endpoints send
// Content-Disposition: attachment, and going through axios keeps the 401 interceptor
// in play so an expired session lands on the login page instead of saving a JSON
// error body under a .pdf name.
async function saveBlob(request, filename) {
  const response = await request;
  const blob = new Blob([response.data], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on the next tick; revoking immediately cancels the download in Safari.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function TenantInvoicesPage() {
  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [payments, setPayments] = useState({});      // invoiceId -> array
  const [loadingPayments, setLoadingPayments] = useState({});
  const [pagination, setPagination] = useState({ current: 1, pageSize: 20, total: 0 });

  useEffect(() => {
    loadInvoices(1, 20);
  }, []);

  const loadInvoices = async (page, pageSize) => {
    setLoading(true);
    try {
      const response = await tenantPortal.getInvoices({ page, limit: pageSize });
      if (response.data.code === 200) {
        const { content, totalElements, currentPage } = response.data.data;
        setInvoices(content || []);
        setPagination((prev) => ({ ...prev, current: currentPage, total: totalElements }));
      } else {
        message.error(response.data.message || 'Failed to load invoices');
      }
    } catch (error) {
      message.error(error.response?.data?.message || 'Failed to load invoices');
    } finally {
      setLoading(false);
    }
  };

  const handleTableChange = (pag) => loadInvoices(pag.current, pag.pageSize);

  const downloadInvoice = async (invoice) => {
    setBusyId(invoice.id);
    try {
      await saveBlob(
        tenantPortal.downloadInvoicePdf(invoice.id),
        `invoice-${invoice.invoice_code || invoice.id}.pdf`
      );
    } catch (error) {
      message.error('We could not produce that invoice. Please contact us.');
    } finally {
      setBusyId(null);
    }
  };

  const downloadReceipt = async (payment) => {
    setBusyId(payment.id);
    try {
      await saveBlob(
        tenantPortal.downloadReceiptPdf(payment.id),
        `receipt-${payment.transaction_code || payment.id}.pdf`
      );
    } catch (error) {
      message.error('We could not produce that receipt. Please contact us.');
    } finally {
      setBusyId(null);
    }
  };

  // Loaded on expand, not for every row up front. Most people open one.
  const loadPayments = async (invoiceId) => {
    if (payments[invoiceId]) return;
    setLoadingPayments((prev) => ({ ...prev, [invoiceId]: true }));
    try {
      const response = await tenantPortal.getInvoicePayments(invoiceId);
      if (response.data.code === 200) {
        setPayments((prev) => ({ ...prev, [invoiceId]: response.data.data || [] }));
      }
    } catch (error) {
      message.error('Failed to load payment activity');
    } finally {
      setLoadingPayments((prev) => ({ ...prev, [invoiceId]: false }));
    }
  };

  const formatDate = (dateStr) => formatDateOnly(dateStr, { fallback: '-' });

  const formatCurrency = (amount) => {
    if (amount == null) return '-';
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
  };

  const columns = [
    { title: 'Invoice', dataIndex: 'invoice_code', key: 'invoice_code', render: (v) => v || '-' },
    // `note` and `due_on` are what the API sends. This table asked for `description`
    // and `due_date`, so both columns had been blank since the portal went live.
    { title: 'Description', dataIndex: 'note', key: 'note', render: (v) => v || '-', ellipsis: true },
    {
      title: 'Amount', dataIndex: 'amount', key: 'amount', align: 'right',
      render: (v) => formatCurrency(v),
    },
    {
      title: 'Paid', dataIndex: 'amount_paid', key: 'amount_paid', align: 'right',
      render: (v) => (Number(v) > 0 ? formatCurrency(v) : <Text type="secondary">-</Text>),
    },
    {
      // The number that answers "what do I still owe". Emphasised when it is not zero,
      // because a part-paid invoice used to read as though nothing had arrived.
      title: 'Outstanding', dataIndex: 'outstanding', key: 'outstanding', align: 'right',
      render: (v) => (Number(v) > 0
        ? <Text strong style={{ color: '#cf1322' }}>{formatCurrency(v)}</Text>
        : <Text type="secondary">{formatCurrency(0)}</Text>),
    },
    { title: 'Due', dataIndex: 'due_on', key: 'due_on', render: (v) => formatDate(v) },
    {
      title: 'Status', dataIndex: 'status', key: 'status',
      render: (v) => {
        const n = Number(v);
        if (n === 1) return <Tag color="green">Paid</Tag>;
        if (n === 2) return <Tag color="red">Overdue</Tag>;
        return <Tag color="blue">Open</Tag>;
      },
    },
    {
      title: '', key: 'actions', width: 130, align: 'right',
      render: (_, r) => (
        <Button
          size="small"
          icon={<FilePdfOutlined />}
          loading={busyId === r.id}
          onClick={() => downloadInvoice(r)}
        >
          Invoice
        </Button>
      ),
    },
  ];

  const renderPayments = (invoice) => {
    if (loadingPayments[invoice.id]) {
      return <div style={{ padding: '8px 0' }}><Spin size="small" /></div>;
    }
    const rows = payments[invoice.id];
    if (!rows) return null;
    if (rows.length === 0) {
      return <Text type="secondary">No payments recorded against this invoice yet.</Text>;
    }
    return (
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Text strong style={{ fontSize: 13 }}>Payments received</Text>
        {rows.map((p) => (
          <div
            key={p.id}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              gap: 16, flexWrap: 'wrap', padding: '8px 12px',
              background: '#fafafa', borderRadius: 6,
            }}
          >
            <Space size={16} wrap>
              <Text>{formatDate(p.payment_date)}</Text>
              <Text strong>{formatCurrency(p.amount)}</Text>
              {p.payment_method_name && <Text type="secondary">{p.payment_method_name}</Text>}
              {p.transaction_code && <Text type="secondary">Ref {p.transaction_code}</Text>}
            </Space>
            {p.receipt_available ? (
              <Button
                size="small"
                type="link"
                icon={<DownloadOutlined />}
                loading={busyId === p.id}
                onClick={() => downloadReceipt(p)}
              >
                Receipt
              </Button>
            ) : (
              <Tooltip title="This payment was recorded in a way we cannot receipt automatically. Contact us and we will send you a copy.">
                <Text type="secondary" style={{ fontSize: 12 }}>Receipt on request</Text>
              </Tooltip>
            )}
          </div>
        ))}
      </Space>
    );
  };

  return (
    <div>
      <Title level={2} style={{ marginBottom: 24, marginTop: 0 }}>My Invoices</Title>

      <Card style={{ borderRadius: 8 }}>
        <Table
          columns={columns}
          dataSource={invoices}
          rowKey="id"
          loading={loading}
          onChange={handleTableChange}
          expandable={{
            expandedRowRender: (record) => renderPayments(record),
            onExpand: (expanded, record) => { if (expanded) loadPayments(record.id); },
          }}
          pagination={{
            current: pagination.current,
            pageSize: pagination.pageSize,
            total: pagination.total,
            showSizeChanger: false,
            showTotal: (total) => `Total ${total} invoices`,
          }}
          locale={{ emptyText: 'No invoices found' }}
        />
      </Card>

      <Text type="secondary" style={{ display: 'block', marginTop: 16, fontSize: 12 }}>
        Open a row to see the payments received against that invoice and download a receipt.
        A payment made through a booking platform may arrive as part of a larger transfer,
        so it can appear a few days after the date you paid.
      </Text>
    </div>
  );
}
