'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  Table, Button, Input, Popover, Checkbox, Row, Col, Select, Badge, message, DatePicker,
  Card, Tag, Typography, Space,
} from 'antd';
import { PlusOutlined, SearchOutlined, FilterOutlined } from '@ant-design/icons';
import { useRouter } from 'next/navigation';
import dayjs from 'dayjs';
import MainLayout from '../../components/Layout';
import useIsMobile from '../../hooks/useIsMobile';
import MobileCardList from '../../components/mobile/MobileCardList';
import { service } from '../../lib/api';

const { Text } = Typography;

const STATUS_MAP = {
  0: { label: 'Pending' },
  1: { label: 'In Progress' },
  2: { label: 'Completed' },
  3: { label: 'Cancelled' },
};

const STATUS_TABS = [
  { key: 'all', label: 'ALL' },
  { key: '0', label: 'Pending' },
  { key: '1', label: 'In Progress' },
  { key: '2', label: 'Completed' },
  { key: '3', label: 'Cancelled' },
];

const STATUS_OPTIONS = [
  { label: 'Pending', value: 0 },
  { label: 'In Progress', value: 1 },
  { label: 'Completed', value: 2 },
  { label: 'Cancelled', value: 3 },
];

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
  const [sortField, setSortField] = useState('created_at');
  const [sortOrder, setSortOrder] = useState('DESC');

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
  const { isMobile } = useIsMobile();

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
  }, [pagination.current, pagination.pageSize, search, searchFields, statusFilter, filterCategory, filterProperty, sortField, sortOrder]);

  const loadServices = async (page) => {
    try {
      setLoading(true);
      const body = {};
      if (search) body.search = search;
      if (searchFields.length > 0) body.searchFields = searchFields;
      if (statusFilter !== 'all') body.status = Number(statusFilter);
      if (filterCategory) body.category = [filterCategory];
      if (filterProperty) body.property = [filterProperty];
      if (sortField) body.sortField = sortField;
      if (sortOrder) body.sortOrder = sortOrder;

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

  // ─── Inline update helper ───────────────────────────────────────────────────
  const handleInlineUpdate = async (record, field, value) => {
    try {
      const payload = { [field]: value };
      await service.patch(record.id, payload);
      message.success('Updated');
      loadServices();
    } catch (error) {
      message.error('Failed to update');
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

  // ─── Table columns ────────────────────────────────────────────────────────
  const columns = [
    {
      title: 'Submission Date', dataIndex: 'created_at', key: 'created_at', width: 130, sorter: true,
      sortOrder: sortField === 'created_at' ? (sortOrder === 'ASC' ? 'ascend' : 'descend') : null,
      render: (v) => v ? dayjs(v).format('YYYY-MM-DD') : '-',
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
      title: 'Status', dataIndex: 'status', key: 'status', width: 140,
      render: (v, r) => (
        <Select
          size="small"
          value={Number(v)}
          options={STATUS_OPTIONS}
          style={{ width: 120 }}
          onChange={(val) => handleInlineUpdate(r, 'status', val)}
          onClick={(e) => e.stopPropagation()}
        />
      ),
    },
    {
      title: 'Assigned To', key: 'assigned_to', width: 160,
      render: (_, r) => {
        const v1 = (r.assignee_name || '').trim();
        const v2 = (r.assignee_2_name || '').trim();
        if (v1 && v2) return `${v1}, ${v2}`;
        return v1 || v2 || '-';
      },
    },
    {
      title: 'Category', dataIndex: 'category', key: 'category', width: 160, sorter: true,
      sortOrder: sortField === 'category' ? (sortOrder === 'ASC' ? 'ascend' : 'descend') : null,
      render: (v) => v ? v.toUpperCase() : '-',
    },
    {
      title: 'Date Started', dataIndex: 'service_date_start', key: 'service_date_start', width: 150, sorter: true,
      sortOrder: sortField === 'service_date_start' ? (sortOrder === 'ASC' ? 'ascend' : 'descend') : null,
      render: (v, r) => (
        <DatePicker
          size="small"
          value={v ? dayjs(v) : null}
          format="YYYY-MM-DD"
          allowClear
          style={{ width: 130 }}
          onChange={(date) => handleInlineUpdate(r, 'service_date_start', date ? date.format('YYYY-MM-DD HH:mm:ss') : null)}
          onClick={(e) => e.stopPropagation()}
        />
      ),
    },
    {
      title: 'Date Completed', dataIndex: 'service_date_end', key: 'service_date_end', width: 150, sorter: true,
      sortOrder: sortField === 'service_date_end' ? (sortOrder === 'ASC' ? 'ascend' : 'descend') : null,
      render: (v, r) => (
        <DatePicker
          size="small"
          value={v ? dayjs(v) : null}
          format="YYYY-MM-DD"
          allowClear
          style={{ width: 130 }}
          onChange={(date) => handleInlineUpdate(r, 'service_date_end', date ? date.format('YYYY-MM-DD HH:mm:ss') : null)}
          onClick={(e) => e.stopPropagation()}
        />
      ),
    },
    {
      title: 'Reported By', key: 'reported_by_name', width: 150,
      render: (_, r) => (r.reported_by_name || '').trim() || '-',
    },
    {
      title: 'Action', key: 'action', width: 70, fixed: 'right',
      render: (_, r) => <a style={{ color: '#1890ff' }} onClick={() => router.push(`/services/${r.id}/detail`)}>View</a>,
    },
  ];

  // ─── Mobile card renderer ──────────────────────────────────────────────────
  const STATUS_COLOR_MAP = { 0: 'orange', 1: 'blue', 2: 'green', 3: 'red' };

  const renderServiceCard = (record) => {
    const prop = record.property_name || '';
    const unit = record.unit_name || '';
    const propertyLabel = prop && unit ? `${prop} / ${unit}` : prop || unit || '-';
    const statusInfo = STATUS_MAP[record.status] || { label: 'Unknown' };
    const v1 = (record.assignee_name || '').trim();
    const v2 = (record.assignee_2_name || '').trim();
    const assignedTo = v1 && v2 ? `${v1}, ${v2}` : v1 || v2 || '-';

    return (
      <Card
        size="small"
        hoverable
        onClick={() => router.push(`/services/${record.id}/detail`)}
        style={{ borderRadius: 8 }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
          <Text strong style={{ fontSize: 14, flex: 1, marginRight: 8 }}>{propertyLabel}</Text>
          <Tag color={STATUS_COLOR_MAP[record.status] || 'default'}>{statusInfo.label}</Tag>
        </div>

        {record.category && (
          <div style={{ marginBottom: 6 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>Category: </Text>
            <Text style={{ fontSize: 12 }}>{record.category.toUpperCase()}</Text>
          </div>
        )}

        <div style={{ marginBottom: 4 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>Assigned: </Text>
          <Text style={{ fontSize: 12 }}>{assignedTo}</Text>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
          <div>
            <Text type="secondary" style={{ fontSize: 11 }}>Submitted: </Text>
            <Text style={{ fontSize: 11 }}>{record.created_at ? dayjs(record.created_at).format('YYYY-MM-DD') : '-'}</Text>
          </div>
          {record.service_date_start && (
            <div>
              <Text type="secondary" style={{ fontSize: 11 }}>Started: </Text>
              <Text style={{ fontSize: 11 }}>{dayjs(record.service_date_start).format('YYYY-MM-DD')}</Text>
            </div>
          )}
        </div>

        {record.reported_by_name && (
          <div style={{ marginTop: 4 }}>
            <Text type="secondary" style={{ fontSize: 11 }}>Reported by: </Text>
            <Text style={{ fontSize: 11 }}>{record.reported_by_name.trim()}</Text>
          </div>
        )}
      </Card>
    );
  };

  return (
    <MainLayout>
      <h1 style={{ marginBottom: 16 }}>Service</h1>

      <div style={{ background: '#fff', border: '1px solid #f0f0f0', borderRadius: 8 }}>
        {/* ── Top bar: Total + Search + Filter + Add Request ── */}
        <div style={{
          padding: '12px 20px',
          display: 'flex',
          flexDirection: isMobile ? 'column' : 'row',
          alignItems: isMobile ? 'stretch' : 'center',
          justifyContent: 'space-between',
          gap: isMobile ? 10 : 0,
          borderBottom: '1px solid #f0f0f0',
        }}>
          {/* Left: total count */}
          <div style={{ display: 'flex', justifyContent: isMobile ? 'space-between' : 'flex-start', alignItems: 'center' }}>
            <div>
              <span style={{ color: '#1890ff', fontSize: 16, fontWeight: 700, marginRight: 4 }}>
                {pagination.total}
              </span>
              <span style={{ fontWeight: 500 }}>Total</span>
            </div>
            {isMobile && (
              <Button type="primary" icon={<PlusOutlined />} size="small" onClick={() => router.push('/services/create')}>
                Add Request
              </Button>
            )}
          </div>

          {/* Right: search + filter + buttons */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: isMobile ? 'wrap' : 'nowrap' }}>
            {/* Search with column checkboxes */}
            <Popover content={searchPopoverContent} trigger="click" placement="bottomRight">
              <Input
                placeholder="Type here to search"
                suffix={<SearchOutlined style={{ color: '#bbb' }} />}
                style={{ width: isMobile ? '100%' : 220, flex: isMobile ? 1 : undefined }}
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

            {/* Add Request — desktop only */}
            {!isMobile && (
              <Button type="primary" icon={<PlusOutlined />} onClick={() => router.push('/services/create')}>
                Add Request
              </Button>
            )}
          </div>
        </div>

        {/* ── Status tabs: ALL | Pending | In Progress | Completed | Cancelled ── */}
        <div style={{
          padding: '8px 20px', display: 'flex', gap: isMobile ? 12 : 20,
          borderBottom: '1px solid #f0f0f0', background: '#fafafa',
          overflowX: isMobile ? 'auto' : 'visible',
          whiteSpace: 'nowrap',
        }}>
          {STATUS_TABS.map(tab => (
            <span
              key={tab.key}
              onClick={() => {
                setStatusFilter(tab.key);
                setPagination(prev => ({ ...prev, current: 1 }));
                // Default sort: Completed = most recent completion date desc, In Progress = most recent start desc, others = earliest start asc
                if (tab.key === '2') {
                  setSortField('service_date_end');
                  setSortOrder('DESC');
                } else if (tab.key === '1') {
                  setSortField('service_date_start');
                  setSortOrder('DESC');
                } else if (tab.key === '0') {
                  setSortField('service_date_start');
                  setSortOrder('ASC');
                } else {
                  setSortField('created_at');
                  setSortOrder('DESC');
                }
              }}
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

        {/* ── Table / Mobile Cards ── */}
        {isMobile ? (
          <div style={{ padding: 12 }}>
            <MobileCardList
              dataSource={services}
              renderCard={renderServiceCard}
              loading={loading}
              pagination={{
                current: pagination.current,
                pageSize: pagination.pageSize,
                total: pagination.total,
                onChange: (page, pageSize) => {
                  setPagination(prev => ({ ...prev, current: page, pageSize }));
                },
              }}
              rowKey="id"
              emptyText="No services found"
            />
          </div>
        ) : (
        <Table
          columns={columns}
          dataSource={services}
          rowKey="id"
          loading={loading}
          onChange={(pag, filters, sorter, extra) => {
            if (extra.action === 'sort') {
              if (sorter.order) {
                setSortField(sorter.field);
                setSortOrder(sorter.order === 'ascend' ? 'ASC' : 'DESC');
              } else {
                // Sorter cleared — revert to default for current tab
                if (statusFilter === '2') {
                  setSortField('service_date_end');
                  setSortOrder('DESC');
                } else if (statusFilter === '1') {
                  setSortField('service_date_start');
                  setSortOrder('DESC');
                } else if (statusFilter === '0') {
                  setSortField('service_date_start');
                  setSortOrder('ASC');
                } else {
                  setSortField('created_at');
                  setSortOrder('DESC');
                }
              }
              setPagination(prev => ({ ...prev, current: 1 }));
            }
          }}
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
          scroll={{ x: 1300 }}
          size="small"
        />
        )}
      </div>
    </MainLayout>
  );
}
