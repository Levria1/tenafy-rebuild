'use client';

import { useEffect, useState, useCallback } from 'react';
import { Table, Button, Space, Tag, Card, Input, Select, DatePicker, Row, Col, Tabs, message, Drawer, Descriptions, Divider, Popover, Radio, Checkbox, Spin } from 'antd';
import { PlusOutlined, FilterOutlined, PrinterOutlined, EditOutlined, DeleteOutlined, CloseOutlined } from '@ant-design/icons';
import { useRouter, useSearchParams } from 'next/navigation';
import dayjs from 'dayjs';
import MainLayout from '../../components/Layout';
import { accounting, accountingApi } from '../../lib/api';

const { RangePicker } = DatePicker;

export default function AccountingPage() {
  const [activeTab, setActiveTab] = useState('accounts');
  const [transactions, setTransactions] = useState([]);
  const [lines, setLines] = useState([]);
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState({ inflow: 0, outflow: 0, net: 0 });
  const [lineSummary, setLineSummary] = useState({ inflow: 0, outflow: 0, net: 0 });
  const [pagination, setPagination] = useState({ current: 1, pageSize: 50, total: 0 });
  const [linePagination, setLinePagination] = useState({ current: 1, pageSize: 50, total: 0 });
  const [accounts, setAccounts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [paymentMethods, setPaymentMethods] = useState([]);
  const [filters, setFilters] = useState({});
  const [search, setSearch] = useState('');
  const [dateRange, setDateRange] = useState(() => [dayjs().subtract(3, 'month'), dayjs()]);
  const [selectedAccounts, setSelectedAccounts] = useState([]);
  const [activeDateFilter, setActiveDateFilter] = useState('3M');
  const [sortInfo, setSortInfo] = useState({ field: null, order: null });
  const router = useRouter();
  const searchParams = useSearchParams();
  const propertyIdParam = searchParams.get('propertyId');

  // Drawer state
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerLoading, setDrawerLoading] = useState(false);
  const [selectedTransaction, setSelectedTransaction] = useState(null);

  // Filter popover state
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterType, setFilterType] = useState(null); // null = all, 0 = inflow, 1 = outflow
  const [filterCategory, setFilterCategory] = useState(null);
  const [filterPaymentMethod, setFilterPaymentMethod] = useState(null);

  useEffect(() => {
    loadSettings();
  }, []);

  useEffect(() => {
    if (activeTab === 'accounts') {
      loadTransactions();
      loadSummary();
    } else {
      loadLines();
    }
  }, [activeTab, pagination.current, pagination.pageSize, linePagination.current, linePagination.pageSize, filters, search, dateRange, selectedAccounts, sortInfo]);

  const loadSettings = async () => {
    try {
      const [catRes, acctRes, pmRes] = await Promise.all([
        accountingApi.getCategories(),
        accountingApi.getAccounts(),
        accountingApi.getPaymentMethods(),
      ]);
      if (catRes.data.code === 200) setCategories(catRes.data.data || []);
      if (acctRes.data.code === 200) setAccounts(acctRes.data.data || []);
      if (pmRes.data.code === 200) setPaymentMethods(pmRes.data.data || []);
    } catch (e) {
      console.error('Failed to load settings');
    }
  };

  const buildFilters = useCallback(() => {
    const f = { ...filters };
    if (search) f.search = search;
    if (dateRange && dateRange[0]) f.startDate = dateRange[0].format('YYYY-MM-DD');
    if (dateRange && dateRange[1]) f.endDate = dateRange[1].format('YYYY-MM-DD');
    if (selectedAccounts.length > 0) f.account_setting_ids = selectedAccounts;
    if (propertyIdParam) f.property_id = propertyIdParam;
    if (sortInfo.field) { f.sortField = sortInfo.field; f.sortOrder = sortInfo.order; }
    return f;
  }, [filters, search, dateRange, selectedAccounts, propertyIdParam, sortInfo]);

  const loadTransactions = async () => {
    setLoading(true);
    try {
      const f = buildFilters();
      const response = await accounting.list(f, { page: pagination.current, limit: pagination.pageSize });
      if (response.data.code === 200) {
        setTransactions(response.data.data.content || []);
        setPagination(prev => ({ ...prev, total: response.data.data.totalElements || 0 }));
      }
    } catch (error) {
      console.error('Failed to load transactions:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadSummary = async () => {
    try {
      const f = buildFilters();
      const response = await accounting.getInflowOutflow(f);
      if (response.data.code === 200) {
        setSummary(response.data.data);
      }
    } catch (e) {
      console.error('Failed to load summary');
    }
  };

  const loadLines = async () => {
    setLoading(true);
    try {
      const f = buildFilters();
      const response = await accounting.getLines(f, { page: linePagination.current, limit: linePagination.pageSize });
      if (response.data.code === 200) {
        setLines(response.data.data.content || []);
        setLinePagination(prev => ({ ...prev, total: response.data.data.totalElements || 0 }));
        if (response.data.data.summary) {
          setLineSummary(response.data.data.summary);
        }
      }
    } catch (error) {
      console.error('Failed to load lines:', error);
    } finally {
      setLoading(false);
    }
  };

  const formatCurrency = (val) => {
    if (val === null || val === undefined) return '—';
    return 'HK$' + Number(val).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  const handleQuickDateFilter = (period) => {
    setActiveDateFilter(period);
    setPagination(p => ({ ...p, current: 1 }));
    setLinePagination(p => ({ ...p, current: 1 }));
    const now = dayjs();
    switch (period) {
      case 'ALL': setDateRange(null); break;
      case '1M': setDateRange([now.subtract(1, 'month'), now]); break;
      case 'LAST_M': setDateRange([now.subtract(1, 'month').startOf('month'), now.subtract(1, 'month').endOf('month')]); break;
      case '3M': setDateRange([now.subtract(3, 'month'), now]); break;
      case '1Y': setDateRange([now.subtract(1, 'year'), now]); break;
      case 'LAST_Y': setDateRange([now.subtract(1, 'year').startOf('year'), now.subtract(1, 'year').endOf('year')]); break;
    }
  };

  // === Drawer functions ===
  const openDrawer = async (record) => {
    setDrawerOpen(true);
    setDrawerLoading(true);
    setSelectedTransaction(null);
    try {
      const res = await accounting.get(record.id);
      if (res.data.code === 200) {
        setSelectedTransaction(res.data.data);
      } else {
        message.error('Failed to load transaction details');
      }
    } catch (error) {
      console.error('Failed to load transaction:', error);
      message.error('Failed to load transaction details');
    } finally {
      setDrawerLoading(false);
    }
  };

  const closeDrawer = () => {
    setDrawerOpen(false);
    setSelectedTransaction(null);
  };

  const handleDeleteTransaction = async () => {
    if (!selectedTransaction) return;
    try {
      const res = await accounting.delete(selectedTransaction.id);
      if (res.data.code === 200) {
        message.success('Transaction deleted');
        closeDrawer();
        loadTransactions();
        loadSummary();
      } else {
        message.error('Failed to delete transaction');
      }
    } catch (error) {
      message.error('Failed to delete transaction');
    }
  };

  // === Filter functions ===
  const activeFilterCount = [filterType !== null ? 1 : 0, filterCategory ? 1 : 0, filterPaymentMethod ? 1 : 0].reduce((a, b) => a + b, 0);

  const applyFilters = () => {
    const newFilters = {};
    if (filterType !== null) newFilters.type = filterType;
    if (filterCategory) newFilters.category = filterCategory;
    if (filterPaymentMethod) newFilters.payment_setting_id = filterPaymentMethod;
    setFilters(newFilters);
    setPagination(p => ({ ...p, current: 1 }));
    setFilterOpen(false);
  };

  const clearFilters = () => {
    setFilterType(null);
    setFilterCategory(null);
    setFilterPaymentMethod(null);
    setFilters({});
    setPagination(p => ({ ...p, current: 1 }));
    setFilterOpen(false);
  };

  const filterContent = (
    <div style={{ width: 300 }}>
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Entry Type</div>
        <Radio.Group value={filterType} onChange={(e) => setFilterType(e.target.value)}>
          <Radio.Button value={null}>All</Radio.Button>
          <Radio.Button value={0}>Inflow (CR)</Radio.Button>
          <Radio.Button value={1}>Outflow (DR)</Radio.Button>
        </Radio.Group>
      </div>

      <div style={{ marginBottom: 16 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Category</div>
        <Select
          placeholder="All Categories"
          allowClear
          style={{ width: '100%' }}
          value={filterCategory}
          onChange={setFilterCategory}
          options={categories.map(c => ({ label: c.name, value: c.id }))}
        />
      </div>

      <div style={{ marginBottom: 16 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Payment Method</div>
        <Select
          placeholder="All Methods"
          allowClear
          style={{ width: '100%' }}
          value={filterPaymentMethod}
          onChange={setFilterPaymentMethod}
          options={paymentMethods.map(m => ({ label: m.name, value: m.id }))}
        />
      </div>

      <Divider style={{ margin: '12px 0' }} />

      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <Button size="small" onClick={clearFilters}>Clear All</Button>
        <Button size="small" type="primary" onClick={applyFilters}>Apply Filters</Button>
      </div>
    </div>
  );

  // === Table columns ===
  const accountColumns = [
    {
      title: 'Payment Date', dataIndex: 'payment_date', key: 'payment_date', width: 120,
      sorter: true,
      render: (v) => v ? dayjs(v).format('YYYY-MM-DD') : '-',
    },
    {
      title: 'Contact', key: 'contact', width: 140, sorter: true,
      render: (_, r) => [r.tenant_first_name, r.tenant_last_name].filter(Boolean).join(' ') || r.note?.substring(0, 20) || '-',
    },
    {
      title: 'Property (Unit)', key: 'property', width: 180, sorter: true,
      render: (_, r) => {
        let text = r.property_name || '';
        if (r.unit_name) text += ` (${r.unit_name})`;
        return text || '-';
      },
    },
    {
      title: 'Payment Account', dataIndex: 'account_name', key: 'account_name', width: 160, sorter: true,
      render: (v) => v || '-',
    },
    {
      title: 'Payment Method', dataIndex: 'payment_method_name', key: 'payment_method', width: 130, sorter: true,
      render: (v) => v || '-',
    },
    {
      title: 'Category', dataIndex: 'category_name', key: 'category_name', width: 110, sorter: true,
      render: (v) => v || '-',
    },
    {
      title: 'Outflow', key: 'outflow', width: 110, align: 'right', sorter: true,
      render: (_, r) => r.type === 1 ? <span style={{ color: '#cf1322' }}>{formatCurrency(r.amount)}</span> : '—',
    },
    {
      title: 'Inflow', key: 'inflow', width: 110, align: 'right', sorter: true,
      render: (_, r) => r.type === 0 ? <span style={{ color: '#389e0d' }}>{formatCurrency(r.amount)}</span> : '—',
    },
    {
      title: 'Notes', dataIndex: 'note', key: 'note', ellipsis: true, sorter: true,
      render: (v) => v || '-',
    },
    {
      title: 'Action', key: 'actions', width: 80, fixed: 'right',
      render: (_, r) => (
        <Button type="link" size="small" onClick={() => openDrawer(r)}>
          View &gt;
        </Button>
      ),
    },
  ];

  const lineColumns = [
    {
      title: 'Payment Date', dataIndex: 'payment_date', key: 'payment_date', width: 120,
      sorter: true,
      render: (v) => v ? dayjs(v).format('YYYY-MM-DD') : '-',
    },
    {
      title: 'Contact', key: 'contact', width: 140, sorter: true,
      render: (_, r) => [r.tenant_first_name, r.tenant_last_name].filter(Boolean).join(' ') || '-',
    },
    {
      title: 'Property (Unit)', key: 'property', width: 180, sorter: true,
      render: (_, r) => {
        let text = r.property_name || '';
        if (r.unit_name) text += ` (${r.unit_name})`;
        return text || '-';
      },
    },
    {
      title: 'Payment Account', dataIndex: 'account_name', key: 'account_name', width: 160, sorter: true,
      render: (v) => v || '-',
    },
    {
      title: 'Payment Method', dataIndex: 'payment_method_name', key: 'payment_method', width: 130, sorter: true,
      render: (v) => v || '-',
    },
    {
      title: 'Category', dataIndex: 'category_name', key: 'category_name', width: 110, sorter: true,
      render: (v) => v || '-',
    },
    {
      title: 'Outflow', key: 'outflow', width: 110, align: 'right', sorter: true,
      render: (_, r) => r.type === 1 ? <span style={{ color: '#cf1322' }}>{formatCurrency(r.amount)}</span> : '—',
    },
    {
      title: 'Inflow', key: 'inflow', width: 110, align: 'right', sorter: true,
      render: (_, r) => r.type === 0 ? <span style={{ color: '#389e0d' }}>{formatCurrency(r.amount)}</span> : '—',
    },
    {
      title: 'Notes', key: 'note', ellipsis: true, sorter: true,
      render: (_, r) => r.transaction_note || '-',
    },
  ];

  // Account Line columns for drawer
  const drawerLineColumns = [
    {
      title: 'Amount', dataIndex: 'amount', key: 'amount', width: 120,
      render: (v) => formatCurrency(v),
    },
    {
      title: 'Category', dataIndex: 'category_name', key: 'category', width: 120,
      render: (v) => v || '-',
    },
    {
      title: 'Property', dataIndex: 'property_name', key: 'property',
      render: (v) => v || '-',
    },
    {
      title: 'Unit', dataIndex: 'unit_name', key: 'unit',
      render: (v) => v || '-',
    },
  ];

  const quickDateButtons = [
    { label: 'ALL', key: 'ALL' },
    { label: '1M', key: '1M' },
    { label: 'LAST M', key: 'LAST_M' },
    { label: '3M', key: '3M' },
    { label: '1Y', key: '1Y' },
    { label: 'LAST Y', key: 'LAST_Y' },
  ];

  return (
    <MainLayout>
      <h1 style={{ marginBottom: 8 }}>{activeTab === 'accounts' ? 'Account' : 'Account line'}</h1>

      <Tabs
        activeKey={activeTab}
        onChange={(key) => setActiveTab(key)}
        items={[
          { key: 'accounts', label: 'ACCOUNTS' },
          { key: 'lines', label: 'ACCOUNT LINE' },
        ]}
        style={{ marginBottom: 16 }}
      />

      {activeTab === 'accounts' && (
        <>
          {/* Filters Row */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
            <div style={{ color: '#666' }}>{pagination.total} Total</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <Select
                placeholder="All Accounts"
                mode="multiple"
                allowClear
                maxTagCount={1}
                maxTagTextLength={12}
                style={{ minWidth: 160, maxWidth: 300 }}
                value={selectedAccounts}
                onChange={(v) => { setSelectedAccounts(v); setPagination(p => ({ ...p, current: 1 })); }}
                options={accounts.map(a => ({ label: a.name, value: a.id }))}
              />
              <Input.Search
                placeholder="Type here to search"
                style={{ width: 200 }}
                allowClear
                onSearch={(v) => { setSearch(v); setPagination(p => ({ ...p, current: 1 })); }}
              />
              <Popover
                content={filterContent}
                title="Filters"
                trigger="click"
                open={filterOpen}
                onOpenChange={setFilterOpen}
                placement="bottomRight"
              >
                <Button icon={<FilterOutlined />}>
                  Filter {activeFilterCount > 0 ? activeFilterCount : ''}
                </Button>
              </Popover>
              <RangePicker
                value={dateRange}
                onChange={(v) => { setDateRange(v); setActiveDateFilter(null); }}
                placeholder={['Start date', 'End date']}
              />
              <Button type="primary" icon={<PlusOutlined />} onClick={() => router.push('/accounting/accounts/create')}>
                Add Inflow / Outflow
              </Button>
            </div>
          </div>

          {/* Quick date filters */}
          <div style={{ marginBottom: 16, display: 'flex', gap: 8 }}>
            {quickDateButtons.map(b => (
              <a key={b.key} onClick={() => handleQuickDateFilter(b.key)} style={{
                cursor: 'pointer', fontSize: 12, color: '#1890ff',
                fontWeight: activeDateFilter === b.key ? 'bold' : 'normal',
                textDecoration: activeDateFilter === b.key ? 'underline' : 'none',
              }}>
                {b.label}
              </a>
            ))}
          </div>

          {/* Summary Cards */}
          <Row gutter={0} style={{ marginBottom: 16 }}>
            <Col span={8}>
              <Card size="small" style={{ borderRadius: 0 }}>
                <div style={{ fontSize: 13, color: '#666' }}>Outflow (DR)</div>
                <div style={{ fontSize: 18, fontWeight: 600, color: '#cf1322' }}>- {formatCurrency(summary.outflow)}</div>
              </Card>
            </Col>
            <Col span={8}>
              <Card size="small" style={{ borderRadius: 0 }}>
                <div style={{ fontSize: 13, color: '#666' }}>Inflow (CR)</div>
                <div style={{ fontSize: 18, fontWeight: 600, color: '#389e0d' }}>{formatCurrency(summary.inflow)}</div>
              </Card>
            </Col>
            <Col span={8}>
              <Card size="small" style={{ borderRadius: 0 }}>
                <div style={{ fontSize: 13, color: '#666' }}>Balance</div>
                <div style={{ fontSize: 18, fontWeight: 600, color: '#1890ff' }}>{formatCurrency(summary.net)}</div>
              </Card>
            </Col>
          </Row>

          {/* Transactions Table */}
          <Table
            columns={accountColumns}
            dataSource={transactions}
            rowKey="id"
            loading={loading}
            scroll={{ x: 1200 }}
            onChange={(pag, _filters, sorter) => {
              setPagination(p => ({ ...p, current: pag.current, pageSize: pag.pageSize }));
              setSortInfo(sorter.order ? { field: sorter.columnKey || sorter.field, order: sorter.order } : { field: null, order: null });
            }}
            pagination={{
              ...pagination,
              showSizeChanger: true,
              pageSizeOptions: ['20', '50', '100'],
              showTotal: (total) => `${total} items`,
            }}
          />
        </>
      )}

      {activeTab === 'lines' && (
        <>
          {/* Filters Row */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
            <div style={{ color: '#666' }}>{linePagination.total} Total</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <Select
                placeholder="All Accounts"
                mode="multiple"
                allowClear
                maxTagCount={1}
                maxTagTextLength={12}
                style={{ minWidth: 160, maxWidth: 300 }}
                value={selectedAccounts}
                onChange={(v) => { setSelectedAccounts(v); setLinePagination(p => ({ ...p, current: 1 })); }}
                options={accounts.map(a => ({ label: a.name, value: a.id }))}
              />
              <Input.Search
                placeholder="Type here to search"
                style={{ width: 200 }}
                allowClear
                onSearch={(v) => { setSearch(v); setLinePagination(p => ({ ...p, current: 1 })); }}
              />
              <Popover
                content={filterContent}
                title="Filters"
                trigger="click"
                open={filterOpen}
                onOpenChange={setFilterOpen}
                placement="bottomRight"
              >
                <Button icon={<FilterOutlined />}>
                  Filter {activeFilterCount > 0 ? activeFilterCount : ''}
                </Button>
              </Popover>
              <RangePicker
                value={dateRange}
                onChange={(v) => { setDateRange(v); setActiveDateFilter(null); }}
                placeholder={['Start date', 'End date']}
              />
              <Button type="primary" icon={<PlusOutlined />} onClick={() => router.push('/accounting/accounts/create')}>
                Add Inflow / Outflow
              </Button>
            </div>
          </div>

          {/* Quick date filters */}
          <div style={{ marginBottom: 16, display: 'flex', gap: 8 }}>
            {quickDateButtons.map(b => (
              <a key={b.key} onClick={() => handleQuickDateFilter(b.key)} style={{
                cursor: 'pointer', fontSize: 12, color: '#1890ff',
                fontWeight: activeDateFilter === b.key ? 'bold' : 'normal',
                textDecoration: activeDateFilter === b.key ? 'underline' : 'none',
              }}>
                {b.label}
              </a>
            ))}
          </div>

          {/* Summary Cards */}
          <Row gutter={0} style={{ marginBottom: 16 }}>
            <Col span={8}>
              <Card size="small" style={{ borderRadius: 0 }}>
                <div style={{ fontSize: 13, color: '#666' }}>Outflow (DR)</div>
                <div style={{ fontSize: 18, fontWeight: 600, color: '#cf1322' }}>- {formatCurrency(lineSummary.outflow)}</div>
              </Card>
            </Col>
            <Col span={8}>
              <Card size="small" style={{ borderRadius: 0 }}>
                <div style={{ fontSize: 13, color: '#666' }}>Inflow (CR)</div>
                <div style={{ fontSize: 18, fontWeight: 600, color: '#389e0d' }}>{formatCurrency(lineSummary.inflow)}</div>
              </Card>
            </Col>
            <Col span={8}>
              <Card size="small" style={{ borderRadius: 0 }}>
                <div style={{ fontSize: 13, color: '#666' }}>Balance</div>
                <div style={{ fontSize: 18, fontWeight: 600, color: '#1890ff' }}>{formatCurrency(lineSummary.net)}</div>
              </Card>
            </Col>
          </Row>

          {/* Lines Table */}
          <Table
            columns={lineColumns}
            dataSource={lines}
            rowKey="id"
            loading={loading}
            scroll={{ x: 1200 }}
            onChange={(pag, _filters, sorter) => {
              setLinePagination(p => ({ ...p, current: pag.current, pageSize: pag.pageSize }));
              setSortInfo(sorter.order ? { field: sorter.columnKey || sorter.field, order: sorter.order } : { field: null, order: null });
            }}
            pagination={{
              ...linePagination,
              showSizeChanger: true,
              pageSizeOptions: ['20', '50', '100'],
              showTotal: (total) => `${total} items`,
            }}
          />
        </>
      )}

      {/* Transaction Detail Drawer */}
      <Drawer
        title="Transaction"
        placement="right"
        width={520}
        onClose={closeDrawer}
        open={drawerOpen}
        extra={
          <Button type="text" icon={<CloseOutlined />} onClick={closeDrawer} />
        }
        footer={
          selectedTransaction && (
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <Space>
                <Button icon={<PrinterOutlined />} onClick={() => window.print()}>Print</Button>
                <Button icon={<EditOutlined />} onClick={() => router.push(`/accounting/accounts/${selectedTransaction.id}/edit`)}>Edit</Button>
                <Button danger icon={<DeleteOutlined />} onClick={handleDeleteTransaction}>Delete</Button>
              </Space>
              <Button onClick={closeDrawer}>Close</Button>
            </div>
          )
        }
      >
        {drawerLoading ? (
          <div style={{ textAlign: 'center', padding: 60 }}>
            <Spin size="large" />
          </div>
        ) : selectedTransaction ? (
          <>
            {/* Entry Type Badge */}
            <div style={{ marginBottom: 20 }}>
              <Tag
                color={selectedTransaction.type === 0 ? 'green' : 'red'}
                style={{ fontSize: 14, padding: '4px 12px' }}
              >
                {selectedTransaction.type === 0 ? 'Inflow (CR)' : 'Outflow (DR)'}
              </Tag>
            </div>

            {/* Transaction Details */}
            <Descriptions column={1} bordered size="small" labelStyle={{ width: 160, fontWeight: 500 }}>
              <Descriptions.Item label="Entry Type">
                {selectedTransaction.type === 0 ? 'Inflow (CR)' : 'Outflow (DR)'}
              </Descriptions.Item>
              <Descriptions.Item label="Transaction ID">
                {selectedTransaction.transaction_code || '-'}
              </Descriptions.Item>
              <Descriptions.Item label="Payment Date">
                {selectedTransaction.payment_date ? dayjs(selectedTransaction.payment_date).format('YYYY-MM-DD') : '-'}
              </Descriptions.Item>
              <Descriptions.Item label="Payment Account">
                {selectedTransaction.account_name || '-'}
              </Descriptions.Item>
              <Descriptions.Item label="Payment Method">
                {selectedTransaction.payment_method_name || '-'}
              </Descriptions.Item>
              <Descriptions.Item label="Category">
                {selectedTransaction.category_name || '-'}
              </Descriptions.Item>
              <Descriptions.Item label="Amount">
                <span style={{ color: selectedTransaction.type === 0 ? '#389e0d' : '#cf1322', fontWeight: 600, fontSize: 16 }}>
                  {formatCurrency(selectedTransaction.amount)}
                </span>
              </Descriptions.Item>
              <Descriptions.Item label="Property">
                {selectedTransaction.property_name || '-'}
              </Descriptions.Item>
              <Descriptions.Item label="Unit">
                {selectedTransaction.unit_name || '-'}
              </Descriptions.Item>
              <Descriptions.Item label="Contact">
                {[selectedTransaction.tenant_first_name, selectedTransaction.tenant_last_name].filter(Boolean).join(' ') || '-'}
              </Descriptions.Item>
              <Descriptions.Item label="Notes">
                {selectedTransaction.note || '-'}
              </Descriptions.Item>
              <Descriptions.Item label="Invoice Code">
                {selectedTransaction.invoice_code || '-'}
              </Descriptions.Item>
            </Descriptions>

            {/* Account Lines */}
            {selectedTransaction.lines && selectedTransaction.lines.length > 0 && (
              <>
                <Divider orientation="left" style={{ marginTop: 24 }}>Account Line</Divider>
                <Table
                  columns={drawerLineColumns}
                  dataSource={selectedTransaction.lines}
                  rowKey="id"
                  size="small"
                  pagination={false}
                  scroll={{ x: 400 }}
                />
              </>
            )}

            {/* Files section placeholder */}
            <Divider orientation="left" style={{ marginTop: 24 }}>Files</Divider>
            <div style={{ color: '#999', fontSize: 13 }}>No files attached</div>
          </>
        ) : (
          <div style={{ textAlign: 'center', color: '#999', padding: 60 }}>
            No transaction selected
          </div>
        )}
      </Drawer>
    </MainLayout>
  );
}
