'use client';

import { useEffect, useState } from 'react';
import { Table, Tag, Typography, Card, message } from 'antd';
import { tenantPortal } from '../../../lib/tenantApi';

const { Title } = Typography;

export default function TenantInvoicesPage() {
  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pagination, setPagination] = useState({
    current: 1,
    pageSize: 20,
    total: 0,
  });

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
        setPagination((prev) => ({
          ...prev,
          current: currentPage,
          total: totalElements,
        }));
      } else {
        message.error(response.data.message || 'Failed to load invoices');
      }
    } catch (error) {
      message.error(error.response?.data?.message || 'Failed to load invoices');
    } finally {
      setLoading(false);
    }
  };

  const handleTableChange = (pag) => {
    loadInvoices(pag.current, pag.pageSize);
  };

  const formatDate = (dateStr) => {
    if (!dateStr) return 'N/A';
    return new Date(dateStr).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  const formatCurrency = (amount) => {
    if (amount == null) return 'N/A';
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
  };

  const columns = [
    {
      title: 'Invoice Code',
      dataIndex: 'invoice_code',
      key: 'invoice_code',
      render: (val) => val || 'N/A',
    },
    {
      title: 'Description',
      dataIndex: 'description',
      key: 'description',
      render: (val) => val || '-',
      ellipsis: true,
    },
    {
      title: 'Amount',
      dataIndex: 'amount',
      key: 'amount',
      render: (val) => formatCurrency(val),
      align: 'right',
    },
    {
      title: 'Due Date',
      dataIndex: 'due_date',
      key: 'due_date',
      render: (val) => formatDate(val),
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      render: (val) => {
        if (val === 1) return <Tag color="green">Paid</Tag>;
        return <Tag color="red">Unpaid</Tag>;
      },
    },
  ];

  return (
    <div>
      <Title level={2} style={{ marginBottom: 24, marginTop: 0 }}>
        My Invoices
      </Title>

      <Card style={{ borderRadius: 8 }}>
        <Table
          columns={columns}
          dataSource={invoices}
          rowKey="id"
          loading={loading}
          onChange={handleTableChange}
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
    </div>
  );
}
