'use client';

import { useEffect, useState } from 'react';
import { Table, Card, Tag, Button, Select, Space, message } from 'antd';
import { ArrowLeftOutlined, EyeOutlined } from '@ant-design/icons';
import { useRouter } from 'next/navigation';
import dayjs from 'dayjs';
import MainLayout from '../../../components/Layout';
import { invoice } from '../../../lib/api';

export default function OwnerInvoicesPage() {
  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pagination, setPagination] = useState({ current: 1, pageSize: 20, total: 0 });
  const [statusFilter, setStatusFilter] = useState(null);
  const router = useRouter();

  useEffect(() => {
    loadInvoices();
  }, [pagination.current, pagination.pageSize, statusFilter]);

  const loadInvoices = async () => {
    try {
      setLoading(true);
      const body = {};

      if (statusFilter) {
        body.status = statusFilter;
      }

      const response = await invoice.list(body, {
        page: pagination.current,
        limit: pagination.pageSize,
      });

      if (response.data.code === 200) {
        setInvoices(response.data.data.content || []);
        setPagination((prev) => ({
          ...prev,
          total: response.data.data.totalElements || 0,
        }));
      }
    } catch (error) {
      console.error('Failed to load invoices:', error);
      message.error('Failed to load invoices');
    } finally {
      setLoading(false);
    }
  };

  const handleTableChange = (pag) => {
    setPagination((prev) => ({
      ...prev,
      current: pag.current,
      pageSize: pag.pageSize,
    }));
  };

  const handleStatusChange = (value) => {
    setStatusFilter(value);
    setPagination((prev) => ({ ...prev, current: 1 }));
  };

  const formatDate = (dateStr) => {
    if (!dateStr) return '-';
    return dayjs(dateStr).format('MMM DD, YYYY');
  };

  const formatCurrency = (value) => {
    if (value == null) return '-';
    return `$${Number(value).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  };

  const getStatusColor = (status) => {
    const colors = {
      PAID: 'green',
      OPEN: 'blue',
      PENDING: 'orange',
      OVERDUE: 'red',
      CANCELLED: 'default',
      DRAFT: 'default',
    };
    return colors[status] || 'default';
  };

  const columns = [
    {
      title: 'Invoice Code',
      dataIndex: 'invoice_code',
      key: 'invoice_code',
    },
    {
      title: 'Property',
      dataIndex: 'property_name',
      key: 'property_name',
      render: (v) => v || '-',
    },
    {
      title: 'Unit',
      dataIndex: 'unit_name',
      key: 'unit_name',
      render: (v) => v || '-',
    },
    {
      title: 'Tenant',
      key: 'tenant',
      render: (_, record) => {
        const first = record.tenant_first_name || '';
        const last = record.tenant_last_name || '';
        return (first || last) ? `${first} ${last}`.trim() : '-';
      },
    },
    {
      title: 'Amount',
      dataIndex: 'amount',
      key: 'amount',
      render: formatCurrency,
      align: 'right',
    },
    {
      title: 'Due Date',
      dataIndex: 'due_date',
      key: 'due_date',
      render: formatDate,
      sorter: (a, b) => new Date(a.due_date) - new Date(b.due_date),
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      render: (status) => (
        <Tag color={getStatusColor(status)}>
          {status || 'N/A'}
        </Tag>
      ),
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_, record) => (
        <Button
          type="link"
          icon={<EyeOutlined />}
          onClick={() => router.push(`/invoices/${record.id}/detail`)}
        >
          View
        </Button>
      ),
    },
  ];

  return (
    <MainLayout>
      <Space direction="vertical" style={{ width: '100%' }} size="large">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Space>
            <Button icon={<ArrowLeftOutlined />} onClick={() => router.push('/owner')}>
              Back to Dashboard
            </Button>
            <h1 style={{ margin: 0 }}>Owner Invoices</h1>
          </Space>
        </div>

        <Card>
          <div style={{ marginBottom: 16, display: 'flex', gap: 16, alignItems: 'center' }}>
            <div>
              <label style={{ display: 'block', marginBottom: 4, fontWeight: 500 }}>Status</label>
              <Select
                style={{ width: 200 }}
                placeholder="All Statuses"
                allowClear
                onChange={handleStatusChange}
                value={statusFilter}
                options={[
                  { label: 'Open', value: 'OPEN' },
                  { label: 'Paid', value: 'PAID' },
                  { label: 'Overdue', value: 'OVERDUE' },
                  { label: 'Pending', value: 'PENDING' },
                  { label: 'Cancelled', value: 'CANCELLED' },
                ]}
              />
            </div>
            <div style={{ alignSelf: 'flex-end' }}>
              <Button
                onClick={() => {
                  setStatusFilter(null);
                  setPagination((prev) => ({ ...prev, current: 1 }));
                }}
              >
                Clear Filter
              </Button>
            </div>
          </div>

          <Table
            columns={columns}
            dataSource={invoices}
            rowKey="id"
            loading={loading}
            pagination={{
              ...pagination,
              showSizeChanger: true,
              showTotal: (total, range) => `${range[0]}-${range[1]} of ${total} invoices`,
            }}
            onChange={handleTableChange}
          />
        </Card>
      </Space>
    </MainLayout>
  );
}
