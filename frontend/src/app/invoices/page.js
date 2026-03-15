'use client';

import { useEffect, useState, useCallback } from 'react';
import { Table, Button, Space, Tag, Input, Select, DatePicker, Drawer, Descriptions, Divider, Spin, Popover, Radio, Checkbox, Tooltip, message, Modal } from 'antd';
import { PlusOutlined, FilterOutlined, FileTextOutlined, PrinterOutlined, EditOutlined, DeleteOutlined, SearchOutlined, ExclamationCircleOutlined, MailOutlined } from '@ant-design/icons';
import { useRouter } from 'next/navigation';
import dayjs from 'dayjs';
import Link from 'next/link';
import MainLayout, { useAuth } from '../../components/Layout';
import { invoice, accountingApi, property as propertyApi } from '../../lib/api';

const { confirm } = Modal;

const { RangePicker } = DatePicker;

// Search field options matching original Tenafy
const SEARCH_FIELD_OPTIONS = [
  { label: 'Contact', value: 'tenantName' },
  { label: 'Property', value: 'propertyUnit' },
  { label: 'Category', value: 'category' },
  { label: 'Notes', value: 'note' },
  { label: 'Invoice ID', value: 'invoice' },
];

export default function InvoicesPage() {
  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pagination, setPagination] = useState({ current: 1, pageSize: 50, total: 0 });
  const [search, setSearch] = useState('');
  const [searchFields, setSearchFields] = useState(['tenantName']); // default: Contact checked
  const [searchDropdownOpen, setSearchDropdownOpen] = useState(false);
  const [dateRange, setDateRange] = useState(() => [dayjs().subtract(1, 'month'), dayjs()]);
  const [activeDateFilter, setActiveDateFilter] = useState('1M');
  const [sortInfo, setSortInfo] = useState({ field: 'due_on', order: 'descend' });
  const [summary, setSummary] = useState({ outstanding_outflow: 0, outstanding_inflow: 0, paid: 0 });
  const router = useRouter();
  const { hasPermission } = useAuth();
  const canDelete = hasPermission('LANDLORD/INVOICE_DELETE');

  const handleDeleteInvoice = (inv) => {
    confirm({
      title: 'Are you sure you want to delete this invoice?',
      icon: <ExclamationCircleOutlined />,
      content: 'Please note that any deleted invoices can not be recovered.',
      okText: 'Delete',
      okType: 'danger',
      cancelText: 'Cancel',
      onOk: async () => {
        try {
          const res = await invoice.delete(inv.id);
          if (res.data.code === 200) {
            message.success('Delete Invoice Success!');
            closeDrawer();
            loadInvoices();
          } else {
            message.error(res.data.message || 'Failed to delete invoice');
          }
        } catch (err) {
          message.error('Failed to delete invoice');
        }
      },
    });
  };

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
  }, [pagination.current, pagination.pageSize, search, dateRange, filters, sortInfo]);

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
      if (search) {
        body.search = search;
        // Send selected search fields to backend
        if (searchFields.length > 0) {
          body.searchFields = searchFields;
        }
      }
      if (dateRange && dateRange[0]) body.startDate = dateRange[0].format('YYYY-MM-DD');
      if (dateRange && dateRange[1]) body.endDate = dateRange[1].format('YYYY-MM-DD');

      const queryParams = { page: pagination.current, limit: pagination.pageSize };
      if (sortInfo.field) queryParams.sort = sortInfo.field;
      if (sortInfo.order) queryParams.order = sortInfo.order;
      const response = await invoice.list(body, queryParams);
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
    setActiveDateFilter(period);
    setPagination(p => ({ ...p, current: 1 }));
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

  const quickDateButtons = [
    { label: 'ALL', key: 'ALL' }, { label: '1M', key: '1M' }, { label: 'LAST M', key: 'LAST_M' },
    { label: '3M', key: '3M' }, { label: '1Y', key: '1Y' }, { label: 'LAST Y', key: 'LAST_Y' },
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
        <Button size="small" onClick={resetFilters}>Clear All</Button>
        <Button size="small" type="primary" onClick={applyFilters}>Apply Filters</Button>
      </div>
    </div>
  );

  // Search field checkboxes dropdown content
  const searchFieldContent = (
    <div style={{ padding: '4px 0' }}>
      <Checkbox.Group
        value={searchFields}
        onChange={(checkedValues) => setSearchFields(checkedValues)}
        style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
      >
        {SEARCH_FIELD_OPTIONS.map(opt => (
          <Checkbox key={opt.value} value={opt.value}>{opt.label}</Checkbox>
        ))}
      </Checkbox.Group>
    </div>
  );

  // Perform search
  const doSearch = (val) => {
    setSearch(val);
    setPagination(p => ({ ...p, current: 1 }));
  };

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

  const getStatusLabel = (s, r) => {
    const n = Number(s);
    // Show "Partial" when some payment made but not fully paid
    if (r) {
      const amt = Number(r.amount) || 0;
      const paid = Number(r.amount_paid) || 0;
      if (n === 1 && paid >= amt) return { text: 'Paid', color: '#389e0d' };
      if (paid > 0 && paid < amt) return { text: 'Partial', color: '#faad14' };
    }
    if (n === 0) return { text: 'Open', color: '#1890ff' };
    if (n === 1) return { text: 'Paid', color: '#389e0d' };
    if (n === 2) return { text: 'Overdue', color: '#cf1322' };
    return { text: 'Unknown', color: '#999' };
  };
  const hasOutstanding = (r) => {
    const amt = Number(r.amount) || 0;
    const paid = Number(r.amount_paid) || 0;
    return amt > paid;
  };

  const getDaysLate = (due_on, status) => {
    if (Number(status) === 1) return 0;
    if (!due_on) return 0;
    const diff = dayjs().diff(dayjs(due_on), 'day');
    return diff > 0 ? diff : 0;
  };

  // Table columns matching original exactly
  const columns = [
    {
      title: 'STATUS', dataIndex: 'status', key: 'status', width: 80,
      sorter: true,
      sortOrder: sortInfo.field === 'status' ? sortInfo.order : null,
      render: (s, r) => {
        const st = getStatusLabel(s, r);
        return <span style={{ color: st.color, fontWeight: 500 }}>{st.text}</span>;
      },
    },
    {
      title: 'INVOICE #', dataIndex: 'invoice_code', key: 'invoice_code', width: 140,
      render: (code, r) => code ? (
        <Button type="link" size="small" style={{ padding: 0 }} onClick={() => openDrawer(r)}>
          {code}
        </Button>
      ) : '-',
    },
    {
      title: 'DUE DATE', dataIndex: 'due_on', key: 'due_on', width: 110,
      sorter: true,
      sortOrder: sortInfo.field === 'due_on' ? sortInfo.order : null,
      render: (v) => v ? dayjs(v).format('YYYY-MM-DD') : '-',
    },
    {
      title: 'CONTACT', dataIndex: 'contact', key: 'contact', width: 160,
      sorter: true,
      sortOrder: sortInfo.field === 'contact' ? sortInfo.order : null,
      render: (_, r) => {
        const name = [r.tenant_first_name, r.tenant_last_name].filter(Boolean).join(' ');
        return name ? <Link href={`/contacts/tenant/${r.tenant_id}/detail`} style={{ color: '#1890ff' }}>{name}</Link> : '-';
      },
    },
    {
      title: 'PROPERTY (Unit)', dataIndex: 'property_unit', key: 'property_unit', width: 200,
      sorter: true,
      sortOrder: sortInfo.field === 'property_unit' ? sortInfo.order : null,
      render: (_, r) => {
        const prop = r.property_name || '';
        const unit = r.unit_name ? `(${r.unit_name})` : '';
        return <span>{prop} {unit}</span> || '-';
      },
    },
    {
      title: 'TOTAL / PAID', key: 'total_paid', width: 220,
      render: (_, r) => {
        const sign = Number(r.type) === 1 ? '-' : '+';
        const total = Number(r.amount || 0);
        const paid = Number(r.amount_paid || 0);
        return `${sign} ${formatCurrency(total)} / ${formatCurrency(paid)}`;
      },
    },
    {
      title: 'OUTSTANDING', dataIndex: 'outstanding', key: 'outstanding', width: 130, align: 'right',
      sorter: true,
      sortOrder: sortInfo.field === 'outstanding' ? sortInfo.order : null,
      render: (_, r) => {
        const outstanding = Number(r.outstanding || 0);
        return outstanding > 0 ? formatCurrency(outstanding) : formatCurrency(0);
      },
    },
    {
      title: 'DAYS LATE', dataIndex: 'days_late', key: 'days_late', width: 90, align: 'center',
      sorter: true,
      sortOrder: sortInfo.field === 'days_late' ? sortInfo.order : null,
      render: (_, r) => Number(r.days_late || 0),
    },
    {
      title: 'CATEGORY', dataIndex: 'category_name', key: 'category', width: 130,
      render: (v) => v || '-',
    },
    {
      title: 'NOTES', dataIndex: 'note', key: 'note', width: 60, align: 'center',
      render: (v) => v ? (
        <Tooltip title={v} placement="topRight">
          <FileTextOutlined style={{ color: '#1890ff', cursor: 'pointer' }} />
        </Tooltip>
      ) : '—',
    },
    {
      title: 'ACTION', key: 'actions', width: 130, fixed: 'right',
      render: (_, r) => {
        const canPay = hasOutstanding(r);
        return (
        <Space size="small">
          <Button
            size="small"
            disabled={!canPay}
            onClick={() => router.push(`/accounting/invoices/payment/create?invoiceId=${r.id}`)}
            style={{
              borderRadius: 4, padding: '0 10px', fontSize: 13,
              color: !canPay ? '#ccc' : '#666',
              borderColor: !canPay ? '#eee' : '#d9d9d9',
              background: 'transparent',
            }}
          >
            Pay
          </Button>
          <Button type="link" size="small" style={{ padding: 0 }} onClick={() => openDrawer(r)}>
            View &gt;
          </Button>
        </Space>
        );
      },
    },
  ];

  return (
    <MainLayout>
      <h1 style={{ marginBottom: 16 }}>Invoices</h1>

      {/* Filters Row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
        <div style={{ color: '#666' }}>{pagination.total} Total</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {/* Search input with column-selection dropdown */}
          <Popover
            content={searchFieldContent}
            trigger="click"
            placement="bottomLeft"
            open={searchDropdownOpen}
            onOpenChange={setSearchDropdownOpen}
          >
            <Input.Search
              placeholder="Type here to search"
              style={{ width: 250 }}
              allowClear
              onSearch={doSearch}
              onFocus={() => setSearchDropdownOpen(true)}
            />
          </Popover>
          <RangePicker
            value={dateRange}
            onChange={(v) => { setDateRange(v); setActiveDateFilter(null); }}
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
        onChange={(pag, _filters, sorter) => {
          setPagination(p => ({ ...p, current: pag.current, pageSize: pag.pageSize }));
          if (sorter && sorter.field) {
            setSortInfo({ field: sorter.field, order: sorter.order || 'descend' });
          } else if (sorter && !sorter.order) {
            // User clicked to remove sort — revert to default
            setSortInfo({ field: 'due_on', order: 'descend' });
          }
        }}
        pagination={{
          ...pagination,
          showSizeChanger: true,
          pageSizeOptions: ['20', '50', '100'],
          showTotal: (total) => `${total} items`,
        }}
      />

      {/* Invoice Detail Drawer */}
      <Drawer
        title={
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>Invoice</span>
            {selectedInvoice && (
              <Button type="default" size="small"
                disabled={!hasOutstanding(selectedInvoice)}
                onClick={() => router.push(`/accounting/invoices/payment/create?invoiceId=${selectedInvoice.id}`)}>
                Pay
              </Button>
            )}
          </div>
        }
        placement="right"
        width={440}
        onClose={closeDrawer}
        open={drawerOpen}
        footer={selectedInvoice ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Button type="primary" icon={<MailOutlined />} block
              onClick={() => { closeDrawer(); router.push(`/contacts/email/send?category=invoice&invoiceId=${selectedInvoice.id}&leaseId=${selectedInvoice.leasing_id || ''}&invoiceCode=${selectedInvoice.invoice_code || ''}`); }}>
              Send Email
            </Button>
            <Button type="primary" icon={<PrinterOutlined />} block onClick={() => window.print()}>
              Print
            </Button>
            <Button type="primary" icon={<EditOutlined />} block style={{ background: '#52c41a', borderColor: '#52c41a' }}
              onClick={() => { closeDrawer(); router.push(`/invoices/${selectedInvoice.id}/edit`); }}>
              Edit
            </Button>
            {canDelete && (
              <Button danger type="primary" icon={<DeleteOutlined />} block onClick={() => handleDeleteInvoice(selectedInvoice)}>
                Delete
              </Button>
            )}
            <Button block onClick={closeDrawer}>
              Close
            </Button>
          </div>
        ) : null}
      >
        {drawerLoading ? (
          <div style={{ textAlign: 'center', padding: 60 }}><Spin size="large" /></div>
        ) : selectedInvoice ? (
          <>
            {/* Invoice Details */}
            <Descriptions column={1} size="small" labelStyle={{ width: 130, fontWeight: 600, color: '#555', textAlign: 'right', paddingRight: 12 }} contentStyle={{ fontWeight: 400 }}>
              <Descriptions.Item label="ENTRY TYPE:">
                {Number(selectedInvoice.type) === 0 ? 'Inflow' : 'Outflow'}
              </Descriptions.Item>
              <Descriptions.Item label="STATUS:">
                {getStatusLabel(Number(selectedInvoice.status)).text}
              </Descriptions.Item>
            </Descriptions>
            <Divider style={{ margin: '12px 0' }} />
            <Descriptions column={1} size="small" labelStyle={{ width: 130, fontWeight: 600, color: '#555', textAlign: 'right', paddingRight: 12 }} contentStyle={{ fontWeight: 400 }}>
              <Descriptions.Item label="Invoice ID:">
                {selectedInvoice.invoice_code || '-'}
              </Descriptions.Item>
              <Descriptions.Item label="Contact:">
                {(() => {
                  if (Number(selectedInvoice.tenant_type) === 1 && selectedInvoice.tenant_company_name) {
                    return selectedInvoice.tenant_company_name;
                  }
                  return [selectedInvoice.tenant_first_name, selectedInvoice.tenant_last_name].filter(Boolean).join(' ') || '-';
                })()}
              </Descriptions.Item>
              <Descriptions.Item label="Due Date:">
                {selectedInvoice.due_on ? dayjs(selectedInvoice.due_on).format('YYYY-MM-DD') : '-'}
              </Descriptions.Item>
              <Descriptions.Item label="Amount:">
                {formatCurrency(selectedInvoice.amount)}
              </Descriptions.Item>
              <Descriptions.Item label="Amount Paid:">
                {formatCurrency(selectedInvoice.amount_paid)}
              </Descriptions.Item>
              <Descriptions.Item label="Outstanding:">
                {formatCurrency(selectedInvoice.outstanding)}
              </Descriptions.Item>
            </Descriptions>

            {/* Property + Unit side by side */}
            <div style={{ display: 'flex', margin: '8px 0', paddingLeft: 0 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, color: '#555', fontSize: 13 }}>Property:</div>
                <div>{selectedInvoice.property_name || '-'}</div>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, color: '#555', fontSize: 13 }}>Unit:</div>
                <div>{selectedInvoice.unit_name || '-'}</div>
              </div>
            </div>

            {/* Notes */}
            <div style={{ margin: '12px 0' }}>
              <div style={{ fontWeight: 600, color: '#555', fontSize: 13 }}>Notes:</div>
              <div style={{ color: '#1890ff' }}>{selectedInvoice.note || '-'}</div>
            </div>

            {/* Files */}
            <div style={{ margin: '12px 0' }}>
              <div style={{ fontWeight: 600, color: '#555', fontSize: 13 }}>Files:</div>
              <div>—</div>
            </div>

            {/* Payment Activity */}
            <Divider style={{ margin: '16px 0 12px' }} />
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 12 }}>Payment Activity</div>
            {selectedInvoice.payments && selectedInvoice.payments.length > 0 ? (
              selectedInvoice.payments.map((p, idx) => (
                <div key={idx} style={{ marginBottom: 16, borderBottom: '1px solid #f0f0f0', paddingBottom: 12 }}>
                  <Descriptions column={1} size="small" labelStyle={{ width: 130, fontWeight: 600, color: '#555', textAlign: 'right', paddingRight: 12 }} contentStyle={{ fontWeight: 400 }}>
                    <Descriptions.Item label="Transaction ID:">
                      {p.transaction_code || '-'}
                    </Descriptions.Item>
                    <Descriptions.Item label="Date:">
                      {p.payment_date ? dayjs(p.payment_date).format('YYYY-MM-DD') : '-'}
                    </Descriptions.Item>
                    <Descriptions.Item label="Contact:">
                      {[p.contact_first_name, p.contact_last_name].filter(Boolean).join(' ') || '-'}
                    </Descriptions.Item>
                    <Descriptions.Item label="Method:">
                      {p.payment_method_name || '-'}
                    </Descriptions.Item>
                    <Descriptions.Item label="Category:">
                      {p.payment_category_name || '—'}
                    </Descriptions.Item>
                    <Descriptions.Item label="Amount Paid:">
                      {formatCurrency(p.amount)}
                    </Descriptions.Item>
                  </Descriptions>
                  <div style={{ margin: '8px 0 4px' }}>
                    <div style={{ fontWeight: 600, color: '#555', fontSize: 13 }}>Notes:</div>
                    <div>{p.note || '-'}</div>
                  </div>
                  <div style={{ margin: '8px 0 4px' }}>
                    <div style={{ fontWeight: 600, color: '#555', fontSize: 13 }}>Files:</div>
                    <div>—</div>
                  </div>
                </div>
              ))
            ) : (
              <div style={{ textAlign: 'center', color: '#999', padding: '12px 0' }}>No payment activity</div>
            )}

            {/* Submitted Payments */}
            <Divider style={{ margin: '16px 0 12px' }} />
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 12 }}>Submitted Payments</div>
            <div style={{ textAlign: 'center', color: '#999', padding: '20px 0' }}>
              <div style={{ fontSize: 40, marginBottom: 4 }}>✉</div>
              No Data
            </div>
          </>
        ) : (
          <div style={{ textAlign: 'center', color: '#999', padding: 60 }}>No invoice selected</div>
        )}
      </Drawer>
    </MainLayout>
  );
}
