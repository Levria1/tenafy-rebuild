'use client';

import { useEffect, useState } from 'react';
import { Table, Button, Space, Tag, Input, Select, DatePicker, Drawer, Descriptions, Divider, Spin, Popover, Radio, message } from 'antd';
import { PlusOutlined, FilterOutlined, FileTextOutlined } from '@ant-design/icons';
import { useRouter } from 'next/navigation';
import dayjs from 'dayjs';
import Link from 'next/link';
import MainLayout from '../../components/Layout';
import { invoice, accountingApi, property as propertyApi } from '../../lib/api';

const { RangePicker } = DatePicker;

export default function InvoicesPage() {
  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pagination, setPagination] = useState({ current: 1, pageSize: 10, total: 0 });
  const [search, setSearch] = useState('');
  const [dateRange, setDateRange] = useState(null);
  const [summary, setSummary] = useState({ outstanding_outflow: 0, outstanding_inflow: 0, paid: 0 });
  const router = useRouter();

  // Settings data for filters
  const [categories, setCategories] = useState([]);
  const [properties, setProperties] = useState([]);

  // Drawer state
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerLoading, setDrawerLoading] = useState(false);
  const [selectedInvoice, setSelectedInvoice] = useState(null);

  // Filter state
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterStatus, setFilterStatus] = useState(null);
  const [filterType, setFilterType] = useState(null);
  const [filterTenantStatus, setFilterTenantStatus] = useState(null);
  const [filterCategory, setFilterCategory] = useState(null);
  const [filterProperty, setFilterProperty] = useState(null);
  const [filters, setFilters] = useState({});

  useEffect(() => {
    loadSettings();
  }, []);

  useEffect(() => {
    loadInvoices();
  }, [pagination.current, pagination.pageSize, search, dateRange, filters]);

  const loadSettings = async () => {
    try {
      const [catRes, propRes] = await Promise.all([
        accountingApi.getCategories(),
        propertyApi.getAll(),
      ]);
      if (catRes.data.code === 200) setCategories(catRes.data.data || []);
      if (propRes.data.code === 200) setProperties(propRes.data.data || []);
    } catch (e) { /* ignore */ }
  };

  const loadInvoices = async () => {
    try {
      setLoading(true);
      const body = { ...filters };
      if (search) body.search = search;
      if (dateRange && dateRange[0]) body.startDate = dateRange[0].format('YYYY-MM-DD');
      if (dateRange && dateRange[1]) body.endDate = dateRange[1].format('YYYY-MM-DD');

      const response = await invoice.list(body, { page: pagination.current, limit: pagination.pageSize });
      if (response.data.code === 200) {
        setInvoices(response.data.data.content || []);
        setPagination(prev => ({ ...prev, total: response.data.data.totalElements || 0 }));
        if (response.data.data.summary) setSummary(response.data.data.summary);
      }
    } catch (error) {
      console.error('Failed to load invoices:', error);
    } finally {
      setLoading(false);
    }
  };

  const formatCurrency = (val) => {
    if (val === null || val === undefined) return 'HK$0.00';
    return 'HK$' + Number(val).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  // Quick date filters
  const handleQuickDateFilter = (period) => {
    const now = dayjs();
    switch (period) {
      case 'ALL': setDateRange(null); break;
      case '1M': setDateRange([now.subtract(1, 'month'), now]); break;
      case 'LAST_M': setDateRange([now.subtract(1, 'month').startOf('month'), now.subtract(1, 'month').endOf('month')]); break;
      case '3M': setDateRange([now.subtract(3, 'month'), now]); break;
      case 'LAST_Q': {
        const q = now.subtract(1, 'quarter');
        setDateRange([q.startOf('quarter'), q.endOf('quarter')]);
        break;
      }
      case '1Y': setDateRange([now.subtract(1, 'year'), now]); break;
      case 'LAST_Y': setDateRange([now.subtract(1, 'year').startOf('year'), now.subtract(1, 'year').endOf('year')]); break;
    }
  };

  const quickDateButtons = [
    { label: 'ALL', key: 'ALL' }, { label: '1M', key: '1M' }, { label: 'LAST M', key: 'LAST_M' },
    { label: '3M', key: '3M' }, { label: 'LAST Q', key: 'LAST_Q' }, { label: '1Y', key: '1Y' }, { label: 'LAST Y', key: 'LAST_Y' },
  ];

  // Filter
  const activeFilterCount = [filterStatus, filterType, filterTenantStatus, filterCategory, filterProperty].filter(v => v !== null).length;

  const applyFilters = () => {
    const f = {};
    if (filterStatus !== null) f.status = filterStatus;
    if (filterType !== null) f.type = filterType;
    if (filterTenantStatus !== null) f.tenantStatus = filterTenantStatus;
    if (filterCategory !== null) f.category = filterCategory;
    if (filterProperty !== null) f.propertyId = filterProperty;
    setFilters(f);
    setPagination(p => ({ ...p, current: 1 }));
    setFilterOpen(false);
  };

  const resetFilters = () => {
    setFilterStatus(null);
    setFilterType(null);
    setFilterTenantStatus(null);
    setFilterCategory(null);
    setFilterProperty(null);
    setFilters({});
    setPagination(p => ({ ...p, current: 1 }));
  };

  const filterContent = (
    <div style={{ width: 280, maxHeight: 500, overflowY: 'auto' }}>
      {/* Invoices Status */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Invoices Status</div>
        <Radio.Group value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
          <Space wrap>
            <Radio value={null}>All</Radio>
            <Radio value={0}>Open</Radio>
            <Radio value={1}>Paid</Radio>
            <Radio value={2}>Overdue</Radio>
          </Space>
        </Radio.Group>
      </div>

      {/* Invoice Type */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Invoice Type</div>
        <Radio.Group value={filterType} onChange={(e) => setFilterType(e.target.value)}>
          <Space wrap>
            <Radio value={null}>All</Radio>
            <Radio value={0}>Inflow</Radio>
            <Radio value={1}>Outflow</Radio>
          </Space>
        </Radio.Group>
      </div>

      {/* Tenant Status */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Tenant Status</div>
        <Radio.Group value={filterTenantStatus} onChange={(e) => setFilterTenantStatus(e.target.value)}>
          <Space wrap>
            <Radio value={null}>All</Radio>
            <Radio value={1}>Active</Radio>
            <Radio value={0}>Inactive</Radio>
          </Space>
        </Radio.Group>
      </div>

      {/* Category */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Category</div>
        <Select
          placeholder="All Category"
          allowClear
          style={{ width: '100%' }}
          value={filterCategory}
          onChange={(v) => setFilterCategory(v ?? null)}
        >
          {categories.map(c => (
            <Select.Option key={c.id} value={c.id}>{c.name}</Select.Option>
          ))}
        </Select>
      </div>

      {/* Property & Units */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Property & Units</div>
        <Select
          placeholder="All Property"
          allowClear
          style={{ width: '100%' }}
          value={filterProperty}
          onChange={(v) => setFilterProperty(v ?? null)}
          showSearch
          optionFilterProp="children"
        >
          {properties.map(p => (
            <Select.Option key={p.id} value={p.id}>{p.display_name}</Select.Option>
          ))}
        </Select>
      </div>

      <Divider style={{ margin: '12px 0' }} />
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <Button size="small" type="primary" onClick={resetFilters}>Reset</Button>
        <Button size="small" onClick={() => setFilterOpen(false)}>Close</Button>
      </div>
    </div>
  );

  // Drawer
  const openDrawer = async (record) => {
    setDrawerOpen(true);
    setDrawerLoading(true);
    setSelectedInvoice(null);
    try {
      const res = await invoice.get(record.id);
      if (res.data.code === 200) {
        setSelectedInvoice(res.data.data);
      }
    } catch (error) {
      message.error('Failed to load invoice details');
    } finally {
      setDrawerLoading(false);
    }
  };

  const closeDrawer = () => {
    setDrawerOpen(false);
    setSelectedInvoice(null);
  };

  const getStatusLabel = (s) => {
    if (s === 0) return { text: 'Open', color: '#1890ff' };
    if (s === 1) return { text: 'Paid', color: '#389e0d' };
    if (s === 2) return { text: 'Overdue', color: '#cf1322' };
    return { text: 'Unknown', color: '#999' };
  };

  const getDaysLate = (due_on, status) => {
    if (status === 1) return 0;
    if (!due_on) return 0;
    const diff = dayjs().diff(dayjs(due_on), 'day');
    return diff > 0 ? diff : 0;
  };

  // Table columns matching original exactly
  const columns = [
    {
      title: 'STATUS', dataIndex: 'status', key: 'status', width: 80,
      sorter: true,
      render: (s) => {
        const st = getStatusLabel(s);
        return <span style={{ color: st.color, fontWeight: 500 }}>{st.text}</span>;
      },
    },
    {
      title: 'DUE DATE', dataIndex: 'due_on', key: 'due_on', width: 110,
      sorter: true,
      render: (v) => v ? dayjs(v).format('YYYY-MM-DD') : '-',
    },
    {
      title: 'CONTACT', key: 'contact', width: 160,
      sorter: true,
      render: (_, r) => {
        const name = [r.tenant_first_name, r.tenant_last_name].filter(Boolean).join(' ');
        return name ? <Link href={`/contacts/tenant/${r.tenant_id}/detail`} style={{ color: '#1890ff' }}>{name}</Link> : '-';
      },
    },
    {
      title: 'PROPERTY (Unit)', key: 'property_unit', width: 200,
      sorter: true,
      render: (_, r) => {
        const prop = r.property_name || '';
        const unit = r.unit_name ? `(${r.unit_name})` : '';
        return <span>{prop} {unit}</span> || '-';
      },
    },
    {
      title: 'TOTAL / PAID', key: 'total_paid', width: 220,
      render: (_, r) => {
        const sign = r.type === 1 ? '-' : '+';
        const total = Number(r.amount || 0);
        const paid = Number(r.amount_paid || 0);
        return `${sign} ${formatCurrency(total)} / ${formatCurrency(paid)}`;
      },
    },
    {
      title: 'OUTSTANDING', key: 'outstanding', width: 130, align: 'right',
      sorter: true,
      render: (_, r) => {
        const outstanding = Number(r.amount || 0) - Number(r.amount_paid || 0);
        return outstanding > 0 ? formatCurrency(outstanding) : formatCurrency(0);
      },
    },
    {
      title: 'DAYS LATE', key: 'days_late', width: 90, align: 'center',
      sorter: true,
      render: (_, r) => getDaysLate(r.due_on, r.status),
    },
    {
      title: 'CATEGORY', dataIndex: 'category_name', key: 'category', width: 130,
      render: (v) => v || '-',
    },
    {
      title: 'NOTES', dataIndex: 'note', key: 'note', width: 60, align: 'center',
      render: (v) => v ? <FileTextOutlined style={{ color: '#1890ff' }} title={v} /> : '—',
    },
    {
      title: 'ACTION', key: 'actions', width: 120, fixed: 'right',
      render: (_, r) => (
        <Space size="small">
          {r.status !== 1 && (
            <Button type="link" size="small" style={{ color: '#999', padding: 0 }}
              onClick={() => router.push(`/accounting/accounts/create?invoice=${r.invoice_code}`)}>
              Pay
            </Button>
          )}
          <Button type="link" size="small" style={{ padding: 0 }} onClick={() => openDrawer(r)}>
            View &gt;
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <MainLayout>
      <h1 style={{ marginBottom: 16 }}>Invoices</h1>

      {/* Filters Row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
        <div style={{ color: '#666' }}>{pagination.total} Total</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Input.Search
            placeholder="Type here to search"
            style={{ width: 200 }}
            allowClear
            onSearch={(v) => { setSearch(v); setPagination(p => ({ ...p, current: 1 })); }}
          />
          <RangePicker
            value={dateRange}
            onChange={setDateRange}
            placeholder={['Start date', 'End date']}
          />
          <Popover content={filterContent} title="Filters" trigger="click" open={filterOpen} onOpenChange={setFilterOpen} placement="bottomRight">
            <Button icon={<FilterOutlined />}>Filter {activeFilterCount > 0 ? activeFilterCount : '0'}</Button>
          </Popover>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => router.push('/invoices/create')}>
            Create Invoice
          </Button>
        </div>
      </div>

      {/* Quick date filters */}
      <div style={{ marginBottom: 16, display: 'flex', gap: 12 }}>
        {quickDateButtons.map(b => (
          <a key={b.key} onClick={() => handleQuickDateFilter(b.key)} style={{ cursor: 'pointer', fontSize: 12, color: '#1890ff' }}>
            {b.label}
          </a>
        ))}
      </div>

      {/* Summary Cards */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 20, border: '1px solid #f0f0f0', borderRadius: 4 }}>
        <div style={{ flex: 1, padding: '16px 24px', borderRight: '1px solid #f0f0f0' }}>
          <div style={{ color: '#666', fontSize: 13, marginBottom: 4 }}>Outstanding Outflow</div>
          <div style={{ fontSize: 18, fontWeight: 600, color: '#cf1322' }}>{formatCurrency(summary.outstanding_outflow)}</div>
        </div>
        <div style={{ flex: 1, padding: '16px 24px', borderRight: '1px solid #f0f0f0' }}>
          <div style={{ color: '#666', fontSize: 13, marginBottom: 4 }}>Outstanding Inflow</div>
          <div style={{ fontSize: 18, fontWeight: 600, color: '#d48806' }}>{formatCurrency(summary.outstanding_inflow)}</div>
        </div>
        <div style={{ flex: 1, padding: '16px 24px' }}>
          <div style={{ color: '#666', fontSize: 13, marginBottom: 4 }}>Paid</div>
          <div style={{ fontSize: 18, fontWeight: 600, color: '#389e0d' }}>{formatCurrency(summary.paid)}</div>
        </div>
      </div>

      {/* Table */}
      <Table
        columns={columns}
        dataSource={invoices}
        rowKey="id"
        loading={loading}
        scroll={{ x: 1400 }}
        pagination={{
          ...pagination,
          showSizeChanger: true,
          showTotal: (total) => `${total} items`,
          onChange: (page, pageSize) => setPagination(p => ({ ...p, current: page, pageSize })),
        }}
      />

      {/* Invoice Detail Drawer */}
      <Drawer
        title={
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>Invoice</span>
            {selectedInvoice && selectedInvoice.status !== 1 && (
              <Button type="default" size="small" onClick={() => router.push(`/accounting/accounts/create?invoice=${selectedInvoice.invoice_code}`)}>Pay</Button>
            )}
          </div>
        }
        placement="right"
        width={440}
        onClose={closeDrawer}
        open={drawerOpen}
      >
        {drawerLoading ? (
          <div style={{ textAlign: 'center', padding: 60 }}><Spin size="large" /></div>
        ) : selectedInvoice ? (
          <>
            <Descriptions column={1} size="small" labelStyle={{ width: 130, fontWeight: 500, color: '#888', textAlign: 'right', paddingRight: 12 }} contentStyle={{ fontWeight: 400 }}>
              <Descriptions.Item label="ENTRY TYPE">
                <span style={{ color: selectedInvoice.type === 0 ? '#389e0d' : '#cf1322' }}>
                  {selectedInvoice.type === 0 ? 'Inflow' : 'Outflow'}
                </span>
              </Descriptions.Item>
              <Descriptions.Item label="STATUS">
                <span style={{ color: getStatusLabel(selectedInvoice.status).color }}>
                  {getStatusLabel(selectedInvoice.status).text}
                </span>
              </Descriptions.Item>
              <Descriptions.Item label="Invoice ID">
                {selectedInvoice.invoice_code || '-'}
              </Descriptions.Item>
              <Descriptions.Item label="Contact">
                <span style={{ color: '#1890ff' }}>
                  {[selectedInvoice.tenant_first_name, selectedInvoice.tenant_last_name].filter(Boolean).join(' ') || '-'}
                </span>
              </Descriptions.Item>
              <Descriptions.Item label="Due Date">
                <span style={{ color: '#1890ff' }}>
                  {selectedInvoice.due_on ? dayjs(selectedInvoice.due_on).format('YYYY-MM-DD') : '-'}
                </span>
              </Descriptions.Item>
              <Descriptions.Item label="Amount">
                <span style={{ color: '#389e0d' }}>{formatCurrency(selectedInvoice.amount)}</span>
              </Descriptions.Item>
              <Descriptions.Item label="Amount Paid">
                <span style={{ color: '#389e0d' }}>{formatCurrency(selectedInvoice.amount_paid)}</span>
              </Descriptions.Item>
              <Descriptions.Item label="Outstanding">
                <span style={{ color: '#cf1322' }}>{formatCurrency(selectedInvoice.outstanding)}</span>
              </Descriptions.Item>
              <Descriptions.Item label="Property">
                <span style={{ color: '#1890ff' }}>{selectedInvoice.property_name || '-'}</span>
              </Descriptions.Item>
              <Descriptions.Item label="Unit">
                <span style={{ color: '#1890ff' }}>{selectedInvoice.unit_name || '-'}</span>
              </Descriptions.Item>
              <Descriptions.Item label="Notes">
                <span style={{ color: '#1890ff' }}>{selectedInvoice.note || '-'}</span>
              </Descriptions.Item>
              <Descriptions.Item label="Files">—</Descriptions.Item>
            </Descriptions>

            {/* Payment Activity */}
            {selectedInvoice.payments && selectedInvoice.payments.length > 0 && (
              <>
                <Divider orientation="left" style={{ marginTop: 24, fontWeight: 600 }}>Payment Activity</Divider>
                {selectedInvoice.payments.map((p, idx) => (
                  <div key={idx} style={{ marginBottom: 20, borderBottom: '1px solid #f0f0f0', paddingBottom: 16 }}>
                    <Descriptions column={1} size="small" labelStyle={{ width: 130, fontWeight: 500, color: '#888', textAlign: 'right', paddingRight: 12 }} contentStyle={{ fontWeight: 400 }}>
                      <Descriptions.Item label="Transaction ID">
                        <span style={{ color: '#1890ff' }}>{p.transaction_code || '-'}</span>
                      </Descriptions.Item>
                      <Descriptions.Item label="Date">
                        <span style={{ color: '#1890ff' }}>{p.payment_date ? dayjs(p.payment_date).format('YYYY-MM-DD') : '-'}</span>
                      </Descriptions.Item>
                      <Descriptions.Item label="Contact">
                        <span style={{ color: '#1890ff' }}>{[p.contact_first_name, p.contact_last_name].filter(Boolean).join(' ') || '-'}</span>
                      </Descriptions.Item>
                      <Descriptions.Item label="Method">
                        <span style={{ color: '#1890ff' }}>{p.payment_method_name || '-'}</span>
                      </Descriptions.Item>
                      <Descriptions.Item label="Category">
                        {p.payment_category_name || '—'}
                      </Descriptions.Item>
                      <Descriptions.Item label="Amount Paid">
                        <span style={{ color: '#389e0d' }}>{formatCurrency(p.amount)}</span>
                      </Descriptions.Item>
                      <Descriptions.Item label="Notes">
                        <span style={{ color: '#1890ff' }}>{p.note || '-'}</span>
                      </Descriptions.Item>
                      <Descriptions.Item label="Files">—</Descriptions.Item>
                    </Descriptions>
                  </div>
                ))}
              </>
            )}

            {/* Submitted Payments */}
            <Divider orientation="left" style={{ marginTop: 24, fontWeight: 600 }}>Submitted Payments</Divider>
            <div style={{ textAlign: 'center', color: '#999', padding: '20px 0' }}>No Data</div>
          </>
        ) : (
          <div style={{ textAlign: 'center', color: '#999', padding: 60 }}>No invoice selected</div>
        )}
      </Drawer>
    </MainLayout>
  );
}
