'use client';

import { useEffect, useState } from 'react';
import { Table, Card, Button, DatePicker, Select, Row, Col, Space, message } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import { useRouter } from 'next/navigation';
import dayjs from 'dayjs';
import MainLayout from '../../../components/Layout';
import { accounting, property } from '../../../lib/api';

const { RangePicker } = DatePicker;

export default function AccountingLinesPage() {
  const [lines, setLines] = useState([]);
  const [loading, setLoading] = useState(true);
  const [categories, setCategories] = useState([]);
  const [properties, setProperties] = useState([]);
  const [pagination, setPagination] = useState({ current: 1, pageSize: 20, total: 0 });
  const [filters, setFilters] = useState({
    dateRange: null,
    category: null,
    property: null,
  });
  const router = useRouter();

  useEffect(() => {
    loadFilterOptions();
  }, []);

  useEffect(() => {
    loadLines();
  }, [pagination.current, pagination.pageSize, filters]);

  const loadFilterOptions = async () => {
    try {
      const [catRes, propRes] = await Promise.all([
        accounting.getCategories(),
        property.getAll(),
      ]);

      if (catRes.data.code === 200) {
        setCategories(catRes.data.data || []);
      }
      if (propRes.data.code === 200) {
        setProperties(propRes.data.data || []);
      }
    } catch (error) {
      console.error('Failed to load filter options:', error);
    }
  };

  const loadLines = async () => {
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
      if (filters.property) {
        body.property_id = filters.property;
      }

      const response = await accounting.getLines(body, {
        page: pagination.current,
        limit: pagination.pageSize,
      });

      if (response.data.code === 200) {
        setLines(response.data.data.content || []);
        setPagination((prev) => ({
          ...prev,
          total: response.data.data.totalElements || 0,
        }));
      }
    } catch (error) {
      console.error('Failed to load line items:', error);
      message.error('Failed to load line items');
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

  const handlePropertyChange = (value) => {
    setFilters((prev) => ({ ...prev, property: value }));
    setPagination((prev) => ({ ...prev, current: 1 }));
  };

  const clearFilters = () => {
    setFilters({ dateRange: null, category: null, property: null });
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
      dataIndex: 'payment_date',
      key: 'payment_date',
      render: formatDate,
      sorter: (a, b) => new Date(a.payment_date) - new Date(b.payment_date),
    },
    {
      title: 'Transaction Code',
      dataIndex: 'transaction_code',
      key: 'transaction_code',
      render: (v) => v || '-',
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
      title: 'Unit',
      dataIndex: 'unit_name',
      key: 'unit_name',
      render: (v) => v || '-',
    },
    {
      title: 'Amount',
      dataIndex: 'amount',
      key: 'amount',
      render: formatCurrency,
      align: 'right',
    },
    {
      title: 'Invoice Code',
      dataIndex: 'invoice_code',
      key: 'invoice_code',
      render: (v) => v || '-',
    },
  ];

  return (
    <MainLayout>
      <Space direction="vertical" style={{ width: '100%' }} size="large">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Space>
            <Button icon={<ArrowLeftOutlined />} onClick={() => router.push('/accounting')}>
              Back to Accounting
            </Button>
            <h1 style={{ margin: 0 }}>Transaction Line Items</h1>
          </Space>
        </div>

        <Card>
          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col xs={24} sm={12} md={6}>
              <label style={{ display: 'block', marginBottom: 4, fontWeight: 500 }}>Date Range</label>
              <RangePicker
                style={{ width: '100%' }}
                onChange={handleDateRangeChange}
                value={filters.dateRange}
              />
            </Col>
            <Col xs={24} sm={12} md={6}>
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
            <Col xs={24} sm={12} md={6}>
              <label style={{ display: 'block', marginBottom: 4, fontWeight: 500 }}>Property</label>
              <Select
                style={{ width: '100%' }}
                placeholder="All Properties"
                allowClear
                showSearch
                optionFilterProp="label"
                onChange={handlePropertyChange}
                value={filters.property}
                options={properties.map((prop) => ({
                  label: prop.name,
                  value: prop.id,
                }))}
              />
            </Col>
            <Col xs={24} sm={12} md={6} style={{ display: 'flex', alignItems: 'flex-end' }}>
              <Button onClick={clearFilters}>
                Clear Filters
              </Button>
            </Col>
          </Row>

          <Table
            columns={columns}
            dataSource={lines}
            rowKey={(record) => record.id || `${record.transaction_code}-${record.amount}-${Math.random()}`}
            loading={loading}
            pagination={{
              ...pagination,
              showSizeChanger: true,
              showTotal: (total, range) => `${range[0]}-${range[1]} of ${total} line items`,
            }}
            onChange={handleTableChange}
          />
        </Card>
      </Space>
    </MainLayout>
  );
}
