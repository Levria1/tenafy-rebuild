'use client';

import { useEffect, useState } from 'react';
import { Table, Button, Space, Input, Select, DatePicker, Popover, Radio, Divider, message, Modal, Card, Tag, Typography } from 'antd';
import { PlusOutlined, FilterOutlined, CalendarOutlined } from '@ant-design/icons';
import { useRouter } from 'next/navigation';
import dayjs from 'dayjs';
import Link from 'next/link';
import MainLayout, { useAuth } from '../../components/Layout';
import { leasing, property as propertyApi } from '../../lib/api';
import useIsMobile from '../../hooks/useIsMobile';
import MobileCardList from '../../components/mobile/MobileCardList';

const { RangePicker } = DatePicker;
const { Text } = Typography;

export default function LeasingPage() {
  const [leases, setLeases] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pagination, setPagination] = useState({ current: 1, pageSize: 10, total: 0 });
  const [search, setSearch] = useState('');
  const [dateRange, setDateRange] = useState(null);
  const [sorter, setSorter] = useState({ field: 'start_date', order: 'descend' });
  const [properties, setProperties] = useState([]);
  const router = useRouter();
  const { hasPermission } = useAuth();
  const { isMobile } = useIsMobile();
  const canEdit = hasPermission ? hasPermission('LANDLORD/LEASING_EDIT') : false;
  const canDelete = hasPermission ? hasPermission('LANDLORD/LEASING_DELETE') : false;
  const canCreate = hasPermission ? hasPermission('LANDLORD/LEASING_CREATE') : false;

  // Filter state
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterStatus, setFilterStatus] = useState(null);
  const [filterType, setFilterType] = useState(null);
  const [filterTenantStatus, setFilterTenantStatus] = useState(null);
  const [filterProperty, setFilterProperty] = useState(null);
  const [filterUnit, setFilterUnit] = useState(null);
  const [units, setUnits] = useState([]);
  const [unitsLoading, setUnitsLoading] = useState(false);
  const [filters, setFilters] = useState({});

  useEffect(() => {
    loadProperties();
  }, []);

  useEffect(() => {
    loadLeases();
  }, [pagination.current, pagination.pageSize, search, dateRange, filters, sorter]);

  const loadProperties = async () => {
    try {
      const res = await propertyApi.getAll();
      if (res.data.code === 200) setProperties(res.data.data || []);
    } catch (e) { /* ignore */ }
  };

  const loadUnits = async (propertyId) => {
    if (!propertyId) { setUnits([]); return; }
    setUnitsLoading(true);
    try {
      const res = await propertyApi.getUnits(propertyId);
      if (res.data.code === 200) setUnits(res.data.data || []);
    } catch (e) { setUnits([]); }
    finally { setUnitsLoading(false); }
  };

  const loadLeases = async () => {
    try {
      setLoading(true);
      const body = { ...filters };
      if (search) body.search = search;
      if (dateRange && dateRange[0]) body.startDate = dateRange[0].format('YYYY-MM-DD');
      if (dateRange && dateRange[1]) body.endDate = dateRange[1].format('YYYY-MM-DD');
      if (sorter.field) {
        body.sortField = sorter.field;
        body.sortOrder = sorter.order;
      }

      const response = await leasing.list(body, { page: pagination.current, limit: pagination.pageSize });
      if (response.data.code === 200) {
        setLeases(response.data.data.content || []);
        setPagination(prev => ({ ...prev, total: response.data.data.totalElements || 0 }));
      }
    } catch (error) {
      console.error('Failed to load leases:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleTableChange = (pag, _filters, sort) => {
    setPagination(p => ({ ...p, current: pag.current, pageSize: pag.pageSize }));
    if (sort.field) {
      setSorter({ field: sort.field, order: sort.order });
    } else {
      setSorter({ field: null, order: null });
    }
  };

  const handleDelete = async (id) => {
    Modal.confirm({
      title: 'Delete Lease',
      content: 'Are you sure you want to delete this lease?',
      okText: 'Delete',
      okType: 'danger',
      onOk: async () => {
        try {
          const res = await leasing.delete(id);
          if (res.data.code === 200) {
            message.success('Lease deleted');
            loadLeases();
          } else {
            message.error('Failed to delete lease');
          }
        } catch (e) {
          message.error('Failed to delete lease');
        }
      },
    });
  };

  // Filter
  const activeFilterCount = [filterStatus, filterType, filterTenantStatus, filterProperty, filterUnit].filter(v => v !== null).length;

  const applyFilters = () => {
    const f = {};
    if (filterStatus !== null) f.status = filterStatus;
    if (filterType !== null) f.type = filterType;
    if (filterTenantStatus !== null) f.tenantStatus = filterTenantStatus;
    if (filterProperty !== null) f.propertyId = filterProperty;
    if (filterUnit !== null) f.unitId = filterUnit;
    setFilters(f);
    setPagination(p => ({ ...p, current: 1 }));
    setFilterOpen(false);
  };

  const resetFilters = () => {
    setFilterStatus(null);
    setFilterType(null);
    setFilterTenantStatus(null);
    setFilterProperty(null);
    setFilterUnit(null);
    setUnits([]);
    setFilters({});
    setPagination(p => ({ ...p, current: 1 }));
  };

  const filterContent = (
    <div style={{ width: 280, maxHeight: 500, overflowY: 'auto' }}>
      {/* Lease Status */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Lease Status</div>
        <Radio.Group value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
          <Space wrap>
            <Radio value={null}>All</Radio>
            <Radio value={1}>Active</Radio>
            <Radio value={2}>Upcoming</Radio>
            <Radio value={0}>Inactive</Radio>
          </Space>
        </Radio.Group>
      </div>

      {/* Lease Type */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Lease Type</div>
        <Radio.Group value={filterType} onChange={(e) => setFilterType(e.target.value)}>
          <Space wrap>
            <Radio value={null}>All</Radio>
            <Radio value={0}>Fixed</Radio>
            <Radio value={1}>Month-to-Month</Radio>
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

      {/* Property & Units */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Property</div>
        <Select
          placeholder="All Properties"
          allowClear
          style={{ width: '100%' }}
          value={filterProperty}
          onChange={(v) => {
            setFilterProperty(v ?? null);
            setFilterUnit(null);
            if (v) { loadUnits(v); } else { setUnits([]); }
          }}
          showSearch
          optionFilterProp="children"
        >
          {properties.map(p => (
            <Select.Option key={p.id} value={p.id}>{p.display_name}</Select.Option>
          ))}
        </Select>
      </div>

      {filterProperty && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Unit</div>
          <Select
            placeholder="All Units"
            allowClear
            style={{ width: '100%' }}
            value={filterUnit}
            onChange={(v) => setFilterUnit(v ?? null)}
            showSearch
            optionFilterProp="children"
            loading={unitsLoading}
            notFoundContent={unitsLoading ? 'Loading...' : 'No units'}
          >
            {units.map(u => (
              <Select.Option key={u.id} value={u.id}>{u.name}</Select.Option>
            ))}
          </Select>
        </div>
      )}

      <Divider style={{ margin: '12px 0' }} />
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <Button size="small" type="primary" onClick={resetFilters}>Reset</Button>
        <Button size="small" onClick={() => { applyFilters(); }}>Close</Button>
      </div>
    </div>
  );

  const getStatusTag = (s) => {
    if (s === 2) return <Tag color="blue">Upcoming</Tag>;
    if (s === 1) return <Tag color="green">Active</Tag>;
    return <Tag>Inactive</Tag>;
  };

  const renderLeaseCard = (record) => {
    const tenantName = [record.tenant_first_name, record.tenant_last_name].filter(Boolean).join(' ');
    const propertyUnit = record.property_name ? `${record.property_name}/${record.unit_name || ''}` : '-';
    const startDate = record.start_date ? dayjs(record.start_date).format('YYYY-MM-DD') : '-';
    const endDate = record.end_date ? dayjs(record.end_date).format('YYYY-MM-DD') : '-';
    const price = record.price ? `HK$${Number(record.price).toLocaleString(undefined, { minimumFractionDigits: 2 })}` : '-';

    return (
      <Card
        size="small"
        style={{ borderRadius: 8 }}
        bodyStyle={{ padding: '12px 16px' }}
        onClick={() => router.push(`/leasing/${record.id}/detail`)}
      >
        {/* Top row: lease number + status */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <Text strong style={{ fontSize: 14, color: '#1890ff' }}>{record.lease_no || '-'}</Text>
          {getStatusTag(record.lease_status)}
        </div>

        {/* Tenant name */}
        {tenantName && (
          <div style={{ marginBottom: 4 }}>
            <Text style={{ color: '#333' }}>{tenantName}</Text>
          </div>
        )}

        {/* Property / Unit */}
        <div style={{ marginBottom: 8 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>{propertyUnit}</Text>
        </div>

        {/* Dates */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>{startDate} &rarr; {endDate}</Text>
        </div>

        {/* Amount + actions */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
          <Text style={{ fontWeight: 500 }}>{price}</Text>
          <Space size="small">
            {canEdit && <Button type="link" size="small" onClick={(e) => { e.stopPropagation(); router.push(`/leasing/${record.id}/edit`); }}>Edit</Button>}
            {canDelete && <Button type="link" size="small" danger onClick={(e) => { e.stopPropagation(); handleDelete(record.id); }}>Delete</Button>}
          </Space>
        </div>
      </Card>
    );
  };

  const columns = [
    {
      title: 'Lease #', dataIndex: 'lease_no', key: 'lease_no', width: 120,
      sorter: true,
      render: (v, r) => <Link href={`/leasing/${r.id}/detail`} style={{ color: '#1890ff' }}>{v || '-'}</Link>,
    },
    {
      title: 'Tenants', key: 'tenant', width: 200,
      sorter: true,
      render: (_, r) => {
        const name = [r.tenant_first_name, r.tenant_last_name].filter(Boolean).join(' ');
        return <Link href={`/contacts/tenant/${r.tenant_id}/detail`} style={{ color: '#1890ff' }}>{name || '-'}</Link>;
      },
    },
    {
      title: 'Property', key: 'property', width: 200,
      sorter: true,
      render: (_, r) => {
        const text = r.property_name ? `${r.property_name}/${r.unit_name || ''}` : '-';
        return <Link href={`/property/${r.unit_id}`} style={{ color: '#1890ff' }}>{text}</Link>;
      },
    },
    {
      title: 'Start Date', dataIndex: 'start_date', key: 'start_date', width: 120,
      sorter: true, defaultSortOrder: 'descend',
      render: (v) => v ? dayjs(v).format('YYYY-MM-DD') : '-',
    },
    {
      title: 'End Date', dataIndex: 'end_date', key: 'end_date', width: 120,
      sorter: true,
      render: (v) => v ? dayjs(v).format('YYYY-MM-DD') : '-',
    },
    {
      title: 'Status', dataIndex: 'lease_status', key: 'status', width: 100,
      sorter: true,
      render: (s) => s === 2
        ? <span style={{ color: '#1677ff' }}>upcoming</span>
        : s === 1
          ? <span style={{ color: '#389e0d' }}>active</span>
          : <span style={{ color: '#999' }}>inactive</span>,
    },
    {
      title: 'Price', dataIndex: 'price', key: 'price', width: 120,
      sorter: true,
      render: (v) => v ? `HK$${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2 })}` : '-',
    },
    {
      title: 'Phone', key: 'phone', width: 160,
      sorter: true,
      render: (_, r) => r.contact_phone || r.tenant_phone || '-',
    },
    {
      title: 'Action', key: 'actions', width: 180,
      render: (_, r) => (
        <Space size="small">
          {canEdit && <Button type="link" size="small" onClick={() => router.push(`/leasing/${r.id}/edit`)}>Edit</Button>}
          <Button type="link" size="small" onClick={() => router.push(`/leasing/${r.id}/detail`)}>Detail</Button>
          {canDelete && <Button type="link" size="small" danger onClick={() => handleDelete(r.id)}>Delete</Button>}
        </Space>
      ),
    },
  ];

  return (
    <MainLayout>
      <h1 style={{ marginBottom: 16 }}>Leasing</h1>

      {/* Filters Row */}
      {isMobile ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ color: '#666' }}>{pagination.total} Total</div>
            <Space size="small">
              {canCreate && (
                <Button type="primary" icon={<PlusOutlined />} size="small" onClick={() => router.push('/leasing/create')}>
                  Add
                </Button>
              )}
              <Button icon={<CalendarOutlined />} size="small" onClick={() => router.push('/leasing/calendar')} />
            </Space>
          </div>
          <Input.Search
            placeholder="Type here to search"
            allowClear
            onSearch={(v) => { setSearch(v); setPagination(p => ({ ...p, current: 1 })); }}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <RangePicker
              value={dateRange}
              onChange={setDateRange}
              placeholder={['Start', 'End']}
              style={{ flex: 1 }}
              size="small"
            />
            <Popover content={filterContent} trigger="click" open={filterOpen} onOpenChange={setFilterOpen} placement="bottomRight">
              <Button icon={<FilterOutlined />} size="small">Filter {activeFilterCount > 0 ? activeFilterCount : '0'}</Button>
            </Popover>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
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
            <Popover content={filterContent} trigger="click" open={filterOpen} onOpenChange={setFilterOpen} placement="bottomRight">
              <Button icon={<FilterOutlined />}>Filter {activeFilterCount > 0 ? activeFilterCount : '0'}</Button>
            </Popover>
            <Button icon={<CalendarOutlined />} onClick={() => router.push('/leasing/calendar')}>
              Calendar View
            </Button>
            {canCreate && <Button type="primary" icon={<PlusOutlined />} onClick={() => router.push('/leasing/create')}>
              ADD LEASE
            </Button>}
          </div>
        </div>
      )}

      {/* Table / Mobile Cards */}
      {isMobile ? (
        <MobileCardList
          dataSource={leases}
          renderCard={renderLeaseCard}
          loading={loading}
          pagination={{
            current: pagination.current,
            pageSize: pagination.pageSize,
            total: pagination.total,
            onChange: (page) => setPagination(p => ({ ...p, current: page })),
          }}
          rowKey="id"
          emptyText="No leases found"
        />
      ) : (
        <Table
          columns={columns}
          dataSource={leases}
          rowKey="id"
          loading={loading}
          scroll={{ x: 1200 }}
          onChange={handleTableChange}
          pagination={{
            current: pagination.current,
            pageSize: pagination.pageSize,
            total: pagination.total,
            showSizeChanger: true,
            showTotal: (total) => `${total} items`,
          }}
        />
      )}
    </MainLayout>
  );
}
