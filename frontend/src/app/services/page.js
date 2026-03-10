'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  Table, Button, Input, Popover, Checkbox, Row, Col, Select, Badge, message,
} from 'antd';
import { PlusOutlined, SearchOutlined, FilterOutlined } from '@ant-design/icons';
import { useRouter } from 'next/navigation';
import dayjs from 'dayjs';
import MainLayout from '../../components/Layout';
import { service } from '../../lib/api';

const STATUS_MAP = {
  0: { label: 'Pending' },
  1: { label: 'In Progress' },
  2: { label: 'Completed' },
};

const STATUS_TABS = [
  { key: 'all', label: 'ALL' },
  { key: '0', label: 'Pending' },
  { key: '1', label: 'In Progress' },
  { key: '2', label: 'Completed' },
];

// ---------------------------------------------------------------------------
// Format datetime range like "Feb 27, 2020 11:25 - 11:30"
// ---------------------------------------------------------------------------
function fmtDateRange(start, end) {
  if (!start) return '';
  const s = dayjs(start);
  if (!s.isValid()) return '';
  const datePart = s.format('MMM DD, YYYY');
  const startTime = s.format('HH:mm');
  if (!end) return `${datePart} ${startTime}`;
  const e = dayjs(end);
  if (!e.isValid()) return `${datePart} ${startTime}`;
  return `${datePart} ${startTime} - ${e.format('HH:mm')}`;
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------
export default function ServicesPage() {
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pagination, setPagination] = useState({ current: 1, pageSize: 10, total: 0 });
  const [search, setSearch] = useState('');
  const [searchFields, setSearchFields] = useState([]);
  const [statusFilter, setStatusFilter] = useState('0');

  // Filter state
  const [filterCategory, setFilterCategory] = useState(undefined);
  const [filterProperty, setFilterProperty] = useState(undefined);
  const [filterVisible, setFilterVisible] = useState(false);
  // Pending filter values (only applied on close/reset)
  const [pendingCategory, setPendingCategory] = useState(undefined);
  const [pendingProperty, setPendingProperty] = useState(undefined);

  // Dropdown data
  const [categories, setCategories] = useState([]);
  const [properties, setProperties] = useState([]);

  const router = useRouter();

  // Load dropdown data on mount
  useEffect(() => {
    (async () => {
      try {
        const [catRes, propRes] = await Promise.all([
          service.getCategories(),
          service.getPropertyList(),
        ]);
        if (catRes.data.code === 200) setCategories(catRes.data.data || []);
        if (propRes.data.code === 200) setProperties(propRes.data.data || []);
      } catch (e) { console.error('Failed to load filter data:', e); }
    })();
  }, []);

  useEffect(() => {
    loadServices(pagination.current);
  }, [pagination.current, pagination.pageSize, search, searchFields, statusFilter, filterCategory, filterProperty]);

  const loadServices = async (page) => {
    try {
      setLoading(true);
      const body = {};
      if (search) body.search = search;
      if (searchFields.length > 0) body.searchFields = searchFields;
      if (statusFilter !== 'all') body.status = Number(statusFilter);
      if (filterCategory) body.category = [filterCategory];
      if (filterProperty) body.property = [filterProperty];

      const response = await service.list(body, { page, limit: pagination.pageSize });
      if (response.data.code === 200) {
        setServices(response.data.data.content || []);
        setPagination(prev => ({ ...prev, current: page, total: response.data.data.totalElements || 0 }));
      }
    } catch (error) {
      console.error('Failed to load services:', error);
    } finally {
      setLoading(false);
    }
  };

  // Count active filters
  const filterCount = [filterCategory, filterProperty].filter(Boolean).length;

  // ─── Search popover content ────────────────────────────────────────────────
  const searchPopoverContent = (
    <div style={{ width: 130 }}>
      <Checkbox.Group
        value={searchFields}
        onChange={(vals) => setSearchFields(vals)}
        style={{ width: '100%' }}
      >
        <Row>
          <Col span={24}><Checkbox value="propertyName">Property</Checkbox></Col>
          <Col span={24}><Checkbox value="tenantName">Tenant</Checkbox></Col>
        </Row>
      </Checkbox.Group>
    </div>
  );

  // ─── Filter popover content ────────────────────────────────────────────────
  const filterPopoverContent = (
    <div style={{ width: 220, padding: '4px 0' }}>
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>Category</div>
      <Select
        placeholder="All Category"
        allowClear
        style={{ width: '100%', marginBottom: 16 }}
        value={pendingCategory}
        onChange={(v) => setPendingCategory(v)}
        options={categories.map(c => ({ label: c.category, value: c.category }))}
      />

      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>Property &amp; Units</div>
      <Select
        placeholder="All Property"
        allowClear
        style={{ width: '100%', marginBottom: 16 }}
        value={pendingProperty}
        onChange={(v) => setPendingProperty(v)}
        options={properties.map(p => ({ label: p.display_name, value: p.id }))}
      />

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <Button type="primary" size="small" onClick={() => {
          setPendingCategory(undefined);
          setPendingProperty(undefined);
          setFilterCategory(undefined);
          setFilterProperty(undefined);
          setPagination(prev => ({ ...prev, current: 1 }));
        }}>Reset</Button>
        <Button size="small" onClick={() => {
          setFilterCategory(pendingCategory);
          setFilterProperty(pendingProperty);
          setPagination(prev => ({ ...prev, current: 1 }));
          setFilterVisible(false);
        }}>Close</Button>
      </div>
    </div>
  );

  // ─── Table columns matching original ────────────────────────────────────────
  const columns = [
    {
      title: 'ID', dataIndex: 'code', key: 'code', width: 80, sorter: true,
      render: (v) => <span style={{ color: '#1890ff' }}>{v}</span>,
    },
    {
      title: 'Submission Date', dataIndex: 'created_at', key: 'created_at', width: 170, sorter: true,
      render: (v) => v ? dayjs(v).format('YYYY-MM-DD HH:mm:ss') : '-',
    },
    {
      title: 'Property Name', key: 'property_name', width: 200,
      render: (_, r) => {
        const prop = r.property_name || '';
        const unit = r.unit_name || '';
        return prop && unit ? `${prop} / ${unit}` : prop || unit || '-';
      },
    },
    {
      title: 'Status', dataIndex: 'status', key: 'status', width: 100,
      render: (v) => (STATUS_MAP[Number(v)] || { label: 'Unknown' }).label,
    },
    {
      title: 'Category', dataIndex: 'category', key: 'category', width: 160, sorter: true,
      render: (v) => v ? v.toUpperCase() : '-',
    },
    {
      title: 'Preferred Date', key: 'preferred_date', width: 220, sorter: true,
      render: (_, r) => fmtDateRange(r.preferred_date_first_start, r.preferred_date_first_end) || '-',
    },
    {
      title: 'Optional Date', key: 'optional_date', width: 220, sorter: true,
      render: (_, r) => fmtDateRange(r.preferred_date_second_start, r.preferred_date_second_end) || '-',
    },
    {
      title: 'Tenant', dataIndex: 'tenant_name', key: 'tenant_name', width: 140,
      render: (v) => v && v.trim() ? v.trim() : '',
    },
    {
      title: 'Contact Phone', dataIndex: 'tenant_phone', key: 'tenant_phone', width: 130,
      render: (v) => v || '',
    },
    {
      title: 'Action', key: 'action', width: 70, fixed: 'right',
      render: (_, r) => <a style={{ color: '#1890ff' }} onClick={() => router.push(`/services/${r.id}/detail`)}>View</a>,
    },
  ];

  return (
    <MainLayout>
      <h1 style={{ marginBottom: 16 }}>Service</h1>

      <div style={{ background: '#fff', border: '1px solid #f0f0f0', borderRadius: 8 }}>
        {/* ── Top bar: Total + Search + Filter + Add Request + List View ── */}
        <div style={{
          padding: '12px 20px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          borderBottom: '1px solid #f0f0f0',
        }}>
          {/* Left: total count */}
          <div>
            <span style={{ color: '#1890ff', fontSize: 16, fontWeight: 700, marginRight: 4 }}>
              {pagination.total}
            </span>
            <span style={{ fontWeight: 500 }}>Total</span>
          </div>

          {/* Right: search + filter + buttons */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {/* Search with column checkboxes */}
            <Popover content={searchPopoverContent} trigger="click" placement="bottomRight">
              <Input
                placeholder="Type here to search"
                suffix={<SearchOutlined style={{ color: '#bbb' }} />}
                style={{ width: 220 }}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onPressEnter={() => setPagination(prev => ({ ...prev, current: 1 }))}
                allowClear
                onClear={() => { setSearch(''); setPagination(prev => ({ ...prev, current: 1 })); }}
              />
            </Popover>

            {/* Filter button */}
            <Popover
              content={filterPopoverContent}
              trigger="click"
              placement="bottomRight"
              open={filterVisible}
              onOpenChange={(vis) => {
                setFilterVisible(vis);
                if (vis) {
                  // Sync pending with current
                  setPendingCategory(filterCategory);
                  setPendingProperty(filterProperty);
                }
              }}
            >
              <Badge count={filterCount} size="small" offset={[-4, 0]}>
                <Button icon={<FilterOutlined />}>
                  Filter{filterCount > 0 ? ` ${filterCount}` : ''}
                </Button>
              </Badge>
            </Popover>

            {/* Add Request */}
            <Button type="primary" icon={<PlusOutlined />} onClick={() => router.push('/services/create')}>
              Add Request
            </Button>

            {/* List View (just label, already in list view) */}
            <Button>List View</Button>
          </div>
        </div>

        {/* ── Status tabs: ALL | Pending | In Progress | Completed ── */}
        <div style={{
          padding: '8px 20px', display: 'flex', gap: 20,
          borderBottom: '1px solid #f0f0f0', background: '#fafafa',
        }}>
          {STATUS_TABS.map(tab => (
            <span
              key={tab.key}
              onClick={() => { setStatusFilter(tab.key); setPagination(prev => ({ ...prev, current: 1 })); }}
              style={{
                cursor: 'pointer', fontSize: 13, fontWeight: 500,
                color: statusFilter === tab.key ? '#1890ff' : '#888',
                borderBottom: statusFilter === tab.key ? '2px solid #1890ff' : '2px solid transparent',
                paddingBottom: 4,
              }}
            >
              {tab.label}
            </span>
          ))}
        </div>

        {/* ── Table ── */}
        <Table
          columns={columns}
          dataSource={services}
          rowKey="id"
          loading={loading}
          pagination={{
            current: pagination.current,
            pageSize: pagination.pageSize,
            total: pagination.total,
            showSizeChanger: true,
            pageSizeOptions: ['10', '20', '50'],
            onChange: (page, pageSize) => {
              setPagination(prev => ({ ...prev, current: page, pageSize }));
            },
          }}
          scroll={{ x: 1500 }}
          size="small"
        />
      </div>
    </MainLayout>
  );
}
