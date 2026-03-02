'use client';

import { useEffect, useState } from 'react';
import { Table, Card, Tag, Button, DatePicker, Select, Row, Col, Space, message } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import { useRouter } from 'next/navigation';
import dayjs from 'dayjs';
import MainLayout from '../../../components/Layout';
import { accounting, settings } from '../../../lib/api';

const { RangePicker } = DatePicker;

export default function OwnerAccountingPage() {
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [categories, setCategories] = useState([]);
  const [pagination, setPagination] = useState({ current: 1, pageSize: 20, total: 0 });
  const [filters, setFilters] = useState({
    dateRange: null,
    category: null,
  });
  const router = useRouter();

  useEffect(() => {
    loadCategories();
  }, []);

  useEffect(() => {
    loadTransactions();
  }, [pagination.current, pagination.pageSize, filters]);

  const loadCategories = async () => {
    try {
      const response = await settings.getCategories();
      if (response.data.code === 200) {
        setCategories(response.data.data || []);
      }
    } catch (error) {
      console.error('Failed to load categories:', error);
    }
  };

  const loadTransactions = async () => {
    try {
      setLoading(true);
      const body = {};

      if (filters.dateRange && filters.dateRange[0] && filters.dateRange[1]) {
        body.start_date = filters.dateRange[0].format('YYYY-MM-DD');
        body.end_date = filters.dateRange[1].format('YYYY-MM-DD');
      }
      if (filters.category) {
        body.category_id = filters.category;
      }

      const response = await accounting.list(body, {
        page: pagination.current,
        limit: pagination.pageSize,
      });

      if (response.data.code === 200) {
        setTransactions(response.data.data.content || []);
        setPagination((prev) => ({
          ...prev,
          total: response.data.data.totalElements || 0,
        }));
      }
    } catch (error) {
      console.error('Failed to load transactions:', error);
      message.error('Failed to load transactions');
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

  const handleDateRangeChange = (dates) => {
    setFilters((prev) => ({ ...prev, dateRange: dates }));
    setPagination((prev) => ({ ...prev, current: 1 }));
  };

  const handleCategoryChange = (value) => {
    setFilters((prev) => ({ ...prev, category: value }));
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

  const columns = [
    {
      title: 'Date',
      dataIndex: 'transaction_date',
      key: 'transaction_date',
      render: formatDate,
      sorter: (a, b) => new Date(a.transaction_date) - new Date(b.transaction_date),
    },
    {
      title: 'Transaction Code',
      dataIndex: 'transaction_code',
      key: 'transaction_code',
    },
    {
      title: 'Amount',
      dataIndex: 'amount',
      key: 'amount',
      render: formatCurrency,
      align: 'right',
    },
    {
      title: 'Type',
      dataIndex: 'type',
      key: 'type',
      render: (type) => {
        const isInflow = type === 'INFLOW' || type === 'income' || type === 'INCOME';
        return (
          <Tag color={isInflow ? 'green' : 'red'}>
            {isInflow ? 'Inflow' : 'Outflow'}
          </Tag>
        );
      },
    },
    {
      title: 'Category',
      dataIndex: 'category_name',
      key: 'category_name',
      render: (v) => v || '-',
    },
    {
      title: 'Property',
      dataIndex: 'property_name',
      key: 'property_name',
      render: (v) => v || '-',
    },
    {
      title: 'Note',
      dataIndex: 'description',
      key: 'description',
      ellipsis: true,
      render: (v) => v || '-',
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
            <h1 style={{ margin: 0 }}>Owner Accounting</h1>
          </Space>
        </div>

        <Card>
          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col xs={24} sm={12} md={8}>
              <label style={{ display: 'block', marginBottom: 4, fontWeight: 500 }}>Date Range</label>
              <RangePicker
                style={{ width: '100%' }}
                onChange={handleDateRangeChange}
                value={filters.dateRange}
              />
            </Col>
            <Col xs={24} sm={12} md={8}>
              <label style={{ display: 'block', marginBottom: 4, fontWeight: 500 }}>Category</label>
              <Select
                style={{ width: '100%' }}
                placeholder="All Categories"
                allowClear
                onChange={handleCategoryChange}
                value={filters.category}
                options={categories.map((cat) => ({
                  label: cat.name,
                  value: cat.id,
                }))}
              />
            </Col>
            <Col xs={24} sm={12} md={8} style={{ display: 'flex', alignItems: 'flex-end' }}>
              <Button
                onClick={() => {
                  setFilters({ dateRange: null, category: null });
                  setPagination((prev) => ({ ...prev, current: 1 }));
                }}
              >
                Clear Filters
              </Button>
            </Col>
          </Row>

          <Table
            columns={columns}
            dataSource={transactions}
            rowKey="id"
            loading={loading}
            pagination={{
              ...pagination,
              showSizeChanger: true,
              showTotal: (total, range) => `${range[0]}-${range[1]} of ${total} transactions`,
            }}
            onChange={handleTableChange}
          />
        </Card>
      </Space>
    </MainLayout>
  );
}
