'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter, useParams } from 'next/navigation';
import {
  Card, Descriptions, Button, Space, Tag, message, Row, Col, Tabs, Table,
  Input, InputNumber, Typography, Popconfirm, DatePicker, Select, Spin, Empty,
  Statistic, Avatar, Divider, Tooltip,
} from 'antd';
import {
  EditOutlined, ArrowLeftOutlined, UserOutlined, CloseOutlined, CheckOutlined,
  PlusOutlined, DeleteOutlined, SearchOutlined, MailOutlined, FilterOutlined, CopyOutlined,
} from '@ant-design/icons';
import MainLayout, { useAuth } from '../../../../../components/Layout';
import useIsMobile from '../../../../../hooks/useIsMobile';
import MobileCardList from '../../../../../components/mobile/MobileCardList';
import UnitViewingsTab from '../../../../../components/viewings/UnitViewingsTab';
import { property as propertyApi, service as serviceApi } from '../../../../../lib/api';
import { formatBeds, formatUnitType, bedSizeFromAmenities, formatDoorCode } from '../../../../../lib/format';

const { Text, Title } = Typography;

const descStyle = { labelStyle: { color: '#000', fontWeight: 600 }, contentStyle: { color: '#000' } };

// ===========================
// GENERAL INFORMATION TAB
// ===========================
function GeneralInfoTab({ unit, propertyInfo, amenities, leaseData }) {
  const currentLease = leaseData?.current;
  const nextLease = leaseData?.next;

  const formatBool = (val) => val ? 'YES' : 'NO';

  return (
    <div>
      {/* GENERAL INFORMATION */}
      <Card size="small" title="GENERAL INFORMATION" style={{ marginBottom: 16 }} headStyle={{ color: '#000' }}>
        <Descriptions column={{ xs: 1, sm: 2, md: 3 }} size="small" {...descStyle}>
          <Descriptions.Item label="Property Name">{propertyInfo?.display_name || '-'}</Descriptions.Item>
          <Descriptions.Item label="Year Built">{propertyInfo?.year_built || '-'}</Descriptions.Item>
          <Descriptions.Item label="Property ID#">{propertyInfo?.property_code || '-'}</Descriptions.Item>
        </Descriptions>
        <Descriptions column={1} size="small" {...descStyle}>
          <Descriptions.Item label="Address">
            {propertyInfo?.street_address || '-'}
          </Descriptions.Item>
        </Descriptions>
        <Descriptions column={{ xs: 1, sm: 2, md: 4 }} size="small" {...descStyle}>
          <Descriptions.Item label="City">{propertyInfo?.city || '-'}</Descriptions.Item>
          <Descriptions.Item label="State / Province">{propertyInfo?.state || '-'}</Descriptions.Item>
          <Descriptions.Item label="Zip">{propertyInfo?.zip || '-'}</Descriptions.Item>
          <Descriptions.Item label="Country">{propertyInfo?.country || '-'}</Descriptions.Item>
        </Descriptions>
      </Card>

      {/* UNIT INFORMATION */}
      <Card size="small" title="UNIT INFORMATION" style={{ marginBottom: 16 }} headStyle={{ color: '#000' }}>
        {/* 2 columns — Bedrooms sits under Type, Bathrooms under Room Size */}
        <Descriptions column={{ xs: 1, sm: 2, md: 2, lg: 2, xl: 2, xxl: 2 }} size="small" {...descStyle}>
          <Descriptions.Item label="Type">{formatUnitType(unit?.type)}</Descriptions.Item>
          <Descriptions.Item label="Room Size">
            {unit?.size ? `${unit.size} ${unit.size_unit || 'sqft'}` : '-'}
          </Descriptions.Item>
          <Descriptions.Item label="Bedrooms">{formatBeds(unit?.beds)}</Descriptions.Item>
          <Descriptions.Item label="Bathrooms">{unit?.baths ?? '-'}</Descriptions.Item>
          <Descriptions.Item label="Bed Size">{bedSizeFromAmenities(amenities) || '-'}</Descriptions.Item>
          <Descriptions.Item label="Occupancy">
            {Number(unit?.status) === 1 ? 'Occupied' : 'Vacant'}
          </Descriptions.Item>
          <Descriptions.Item label="Link" span={2}>
            {unit?.listing_url ? (
              <a href={unit.listing_url} target="_blank" rel="noreferrer" style={{ color: '#1677ff', wordBreak: 'break-all' }}>
                {unit.listing_url}
              </a>
            ) : (
              <Text type="secondary">Not set</Text>
            )}
          </Descriptions.Item>
        </Descriptions>
      </Card>

      {/* INTERIOR AMENITIES */}
      <Card size="small" title="INTERIOR AMENITIES" style={{ marginBottom: 16 }} headStyle={{ color: '#000' }}>
        {amenities && amenities.filter(a => Number(a.selected) === 1).length > 0 ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 24px' }}>
            {amenities.filter(a => Number(a.selected) === 1).map((a) => (
              <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 180 }}>
                <CheckOutlined style={{ color: '#52c41a', fontSize: 12 }} />
                <Text style={{ fontSize: 13 }}>{a.display_name}</Text>
              </div>
            ))}
          </div>
        ) : (
          <Text type="secondary">No amenities configured</Text>
        )}
      </Card>

      {/* AMENITY DETAILS */}
      <Card size="small" title="AMENITY DETAILS" style={{ marginBottom: 16 }} headStyle={{ color: '#000' }}>
        <Text style={{ whiteSpace: 'pre-wrap' }}>{unit?.amenity_detail || '--'}</Text>
      </Card>

      {/* UNIT ACCESS INFORMATION */}
      <Card size="small" title="UNIT ACCESS INFORMATION" style={{ marginBottom: 16 }} headStyle={{ color: '#000' }}>
        <Text style={{ whiteSpace: 'pre-wrap' }}>{unit?.access_information || '--'}</Text>
      </Card>

      {/* DOOR CODE — from the lease running TODAY, not from the unit.
          unit.key_code used to fill this card and had gone stale: it still showed
          664851# for Cleverly 8B while the tenant in residence had 439012#. A code
          changes with the tenant, so it belongs to the lease; reading the current
          one means this card re-dates itself every time occupancy turns over, with
          nobody having to remember to edit the unit. Blank between tenancies,
          which is the honest answer — there is no code to give out. */}
      <Card size="small" title="DOOR CODE" style={{ marginBottom: 16 }} headStyle={{ color: '#000' }}>
        {(() => {
          const code = formatDoorCode(currentLease?.unit_information);
          if (!code) return <Text type="secondary">--</Text>;
          if (!code.collapsed) return <Text style={{ whiteSpace: 'pre-wrap' }}>{code.label}</Text>;
          return (
            <>
              <Tag color="blue">{code.label}</Tag>
              <Text type="secondary" style={{ fontSize: 12 }}>app access, no code to read out</Text>
            </>
          );
        })()}
      </Card>

      {/* WIFI INFORMATION */}
      <Card size="small" title="WIFI INFORMATION" style={{ marginBottom: 16 }} headStyle={{ color: '#000' }}>
        <Text style={{ whiteSpace: 'pre-wrap' }}>{unit?.wifi_information || '--'}</Text>
      </Card>

      {/* PAYMENT INFORMATION */}
      <Card size="small" title="PAYMENT INFORMATION" style={{ marginBottom: 16 }} headStyle={{ color: '#000' }}>
        <div style={{ marginBottom: 8 }}>
          <Text strong style={{ fontSize: 12, color: '#999' }}>Bank Account Name</Text>
          <br />
          <Text>{unit?.account_name || '--'}</Text>
        </div>
        <div>
          <Text strong style={{ fontSize: 12, color: '#999' }}>Bank Details</Text>
          <br />
          <Text style={{ whiteSpace: 'pre-wrap' }}>{unit?.bank_details || '--'}</Text>
        </div>
      </Card>

      {/* INTERNAL NOTES */}
      <Card size="small" title="INTERNAL NOTES" style={{ marginBottom: 16 }} headStyle={{ color: '#000' }}>
        <Text style={{ whiteSpace: 'pre-wrap' }}>{unit?.internal_note || '--'}</Text>
      </Card>

      {/* RENT RANGE */}
      <Card size="small" title="RENT RANGE" style={{ marginBottom: 16 }} headStyle={{ color: '#000' }}>
        <Text>
          {unit?.rent_price_min || unit?.rent_price_max
            ? `${unit.rent_price_min ? '$' + Number(unit.rent_price_min).toLocaleString() : '-'} — ${unit.rent_price_max ? '$' + Number(unit.rent_price_max).toLocaleString() : '-'}`
            : '--'}
        </Text>
      </Card>

      {/* ATTACHMENTS */}
      <Card size="small" title="ATTACHMENTS" style={{ marginBottom: 16 }} headStyle={{ color: '#000' }}>
        <Text>--</Text>
      </Card>

      {/* CURRENT LEASE */}
      <Card size="small" title="CURRENT LEASE" style={{ marginBottom: 16 }} headStyle={{ color: '#000' }}>
        {currentLease ? (
          <Descriptions column={{ xs: 1, sm: 2, md: 4 }} size="small" {...descStyle}>
            <Descriptions.Item label="Tenant">
              {currentLease.first_name} {currentLease.last_name}
            </Descriptions.Item>
            <Descriptions.Item label="Start Date">
              {currentLease.start_date ? new Date(currentLease.start_date).toLocaleDateString() : '-'}
            </Descriptions.Item>
            <Descriptions.Item label="End Date">
              {currentLease.end_date ? new Date(currentLease.end_date).toLocaleDateString() : '-'}
            </Descriptions.Item>
            <Descriptions.Item label="Status">
              <Tag color="green">active</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="Rent">
              {currentLease.currency_symbol || 'HK$'}{Number(currentLease.amount || 0).toLocaleString()}
            </Descriptions.Item>
            <Descriptions.Item label="Unit Information">
              {currentLease.unit_information || '-'}
            </Descriptions.Item>
          </Descriptions>
        ) : (
          <Text type="secondary">No active lease</Text>
        )}
      </Card>

      {/* NEXT LEASE */}
      <Card size="small" title="NEXT LEASE" style={{ marginBottom: 0 }} headStyle={{ color: '#000' }}>
        {nextLease ? (
          <Descriptions column={3} size="small" {...descStyle}>
            <Descriptions.Item label="Tenant">{nextLease.first_name} {nextLease.last_name}</Descriptions.Item>
            <Descriptions.Item label="Start Date">{nextLease.start_date ? new Date(nextLease.start_date).toLocaleDateString() : '-'}</Descriptions.Item>
            <Descriptions.Item label="End Date">{nextLease.end_date ? new Date(nextLease.end_date).toLocaleDateString() : '-'}</Descriptions.Item>
          </Descriptions>
        ) : (
          <Text type="secondary">No upcoming lease</Text>
        )}
      </Card>
    </div>
  );
}

// ===========================
// FURNISHING TAB
// ===========================
function FurnishingTab({ unitId, isMobile }) {
  const { hasPermission } = useAuth();
  const canEditProp = hasPermission ? hasPermission('LANDLORD/PROPERTY_EDIT') : false;
  const canDeleteProp = hasPermission ? hasPermission('LANDLORD/PROPERTY_DELETE') : false;
  const [items, setItems] = useState([]);
  const [totalSum, setTotalSum] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [editingKey, setEditingKey] = useState('');
  const [editRow, setEditRow] = useState({});
  const [newRow, setNewRow] = useState({ item_name: '', quantity: 1, item_price: 0, note: '' });

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      const res = await propertyApi.getFurnishing(unitId, search ? { search } : undefined);
      if (res.data.code === 200) {
        setItems(res.data.data.items || []);
        setTotalSum(res.data.data.totalSum || 0);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [unitId, search]);

  useEffect(() => { loadData(); }, [loadData]);

  const handleAdd = async () => {
    if (!newRow.item_name?.trim()) return message.warning('Item name is required');
    try {
      await propertyApi.createFurnishing(unitId, newRow);
      message.success('Item added');
      setNewRow({ item_name: '', quantity: 1, item_price: 0, note: '' });
      loadData();
    } catch (err) {
      message.error('Failed to add item');
    }
  };

  const handleEdit = (record) => {
    setEditingKey(record.id);
    setEditRow({ ...record });
  };

  const handleSave = async () => {
    try {
      await propertyApi.updateFurnishing(editingKey, editRow);
      message.success('Updated');
      setEditingKey('');
      loadData();
    } catch (err) {
      message.error('Failed to update');
    }
  };

  const handleDelete = async (id) => {
    try {
      await propertyApi.deleteFurnishing(id);
      message.success('Deleted');
      loadData();
    } catch (err) {
      message.error('Failed to delete');
    }
  };

  const columns = [
    {
      title: 'Item Name', dataIndex: 'item_name', key: 'item_name', width: 220,
      render: (val, r) => editingKey === r.id
        ? <Input size="small" value={editRow.item_name} onChange={e => setEditRow(p => ({ ...p, item_name: e.target.value }))} />
        : val,
    },
    {
      title: 'Quantity', dataIndex: 'quantity', key: 'quantity', width: 100,
      render: (val, r) => editingKey === r.id
        ? <InputNumber size="small" min={1} value={editRow.quantity} onChange={v => setEditRow(p => ({ ...p, quantity: v }))} />
        : val,
    },
    {
      title: 'Item Price', dataIndex: 'item_price', key: 'item_price', width: 120,
      render: (val, r) => editingKey === r.id
        ? <InputNumber size="small" min={0} value={editRow.item_price} onChange={v => setEditRow(p => ({ ...p, item_price: v }))} prefix="$" />
        : val != null ? `HK$${Number(val).toLocaleString()}` : '-',
    },
    {
      title: 'Last Updated', dataIndex: 'updated_at', key: 'updated_at', width: 180,
      render: (d) => d ? new Date(d).toLocaleString() : '-',
    },
    {
      title: 'Notes', dataIndex: 'note', key: 'note',
      render: (val, r) => editingKey === r.id
        ? <Input size="small" value={editRow.note || ''} onChange={e => setEditRow(p => ({ ...p, note: e.target.value }))} />
        : val || '',
    },
    {
      title: 'Operation', key: 'actions', width: 140,
      render: (_, r) => editingKey === r.id ? (
        <Space>
          <Button type="link" size="small" onClick={handleSave}>Save</Button>
          <Button type="link" size="small" onClick={() => setEditingKey('')}>Cancel</Button>
        </Space>
      ) : (
        <Space>
          {canEditProp && <Button type="link" size="small" onClick={() => handleEdit(r)}>Edit</Button>}
          {canDeleteProp && <Popconfirm title="Delete this item?" onConfirm={() => handleDelete(r.id)}>
            <Button type="link" size="small" danger>Delete</Button>
          </Popconfirm>}
        </Space>
      ),
    },
  ];

  // Add row at top of data
  const addRowData = [{
    id: '__new__',
    item_name: (
      <Input size="small" placeholder="Enter item name" value={newRow.item_name}
        onChange={e => setNewRow(p => ({ ...p, item_name: e.target.value }))}
        onPressEnter={handleAdd} />
    ),
    quantity: (
      <InputNumber size="small" min={1} value={newRow.quantity}
        onChange={v => setNewRow(p => ({ ...p, quantity: v }))} />
    ),
    item_price: (
      <InputNumber size="small" min={0} value={newRow.item_price}
        onChange={v => setNewRow(p => ({ ...p, item_price: v }))} prefix="$" />
    ),
    updated_at: null,
    note: (
      <Input size="small" placeholder="" value={newRow.note}
        onChange={e => setNewRow(p => ({ ...p, note: e.target.value }))} />
    ),
    _isNew: true,
  }];

  const renderFurnishingCard = (record) => (
    <div style={{ background: '#fff', border: '1px solid #f0f0f0', borderRadius: 8, padding: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <Text strong style={{ fontSize: 13 }}>{record.item_name}</Text>
        <Text style={{ color: '#1677ff', fontSize: 12 }}>
          {record.item_price != null ? `HK$${Number(record.item_price).toLocaleString()}` : '-'}
        </Text>
      </div>
      <div style={{ display: 'flex', gap: 16, fontSize: 12, color: '#666', marginBottom: 6 }}>
        <span>Qty: <strong>{record.quantity}</strong></span>
        <span>Updated: {record.updated_at ? new Date(record.updated_at).toLocaleDateString() : '-'}</span>
      </div>
      {record.note && <div style={{ fontSize: 12, color: '#888' }}>{record.note}</div>}
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        {canEditProp && <Button type="link" size="small" style={{ padding: 0 }} onClick={() => handleEdit(record)}>Edit</Button>}
        {canDeleteProp && (
          <Popconfirm title="Delete this item?" onConfirm={() => handleDelete(record.id)}>
            <Button type="link" size="small" danger style={{ padding: 0 }}>Delete</Button>
          </Popconfirm>
        )}
      </div>
    </div>
  );

  return (
    <div>
      {/* Header with total + search */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: isMobile ? 'wrap' : 'nowrap', gap: isMobile ? 8 : 0 }}>
        <Text strong>Total Sum: <Text style={{ color: '#1677ff' }}>HK$ {Number(totalSum).toLocaleString()}</Text></Text>
        <Space>
          <Input
            placeholder="Type here to search..."
            prefix={<SearchOutlined />}
            value={search}
            onChange={e => setSearch(e.target.value)}
            onPressEnter={() => loadData()}
            style={{ width: isMobile ? 160 : 200 }}
            allowClear
            size="small"
          />
        </Space>
      </div>

      {isMobile ? (
        <>
          {/* Mobile add form */}
          <div style={{ background: '#fafafa', border: '1px solid #f0f0f0', borderRadius: 8, padding: 12, marginBottom: 12 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Input size="small" placeholder="Item name" value={newRow.item_name}
                onChange={e => setNewRow(p => ({ ...p, item_name: e.target.value }))} />
              <div style={{ display: 'flex', gap: 8 }}>
                <InputNumber size="small" min={1} value={newRow.quantity} placeholder="Qty"
                  onChange={v => setNewRow(p => ({ ...p, quantity: v }))} style={{ flex: 1 }} />
                <InputNumber size="small" min={0} value={newRow.item_price} placeholder="Price" prefix="$"
                  onChange={v => setNewRow(p => ({ ...p, item_price: v }))} style={{ flex: 1 }} />
              </div>
              <Input size="small" placeholder="Note" value={newRow.note}
                onChange={e => setNewRow(p => ({ ...p, note: e.target.value }))} />
              <Button type="primary" size="small" onClick={handleAdd}>Add Item</Button>
            </div>
          </div>
          <MobileCardList
            dataSource={items}
            renderCard={renderFurnishingCard}
            loading={loading}
            rowKey="id"
            emptyText="No furnishing items"
          />
        </>
      ) : (
        <>
          {/* Table with inline add row */}
          <Table
            columns={[
              {
                title: 'Item Name', key: 'item_name', width: 220,
                render: (_, r) => r._isNew ? r.item_name : undefined,
                dataIndex: 'item_name',
              },
              {
                title: 'Quantity', key: 'quantity', width: 100,
                render: (_, r) => r._isNew ? r.quantity : undefined,
                dataIndex: 'quantity',
              },
              {
                title: 'Item Price', key: 'item_price', width: 120,
                render: (_, r) => r._isNew ? r.item_price : undefined,
                dataIndex: 'item_price',
              },
              { title: 'Last Updated', key: 'updated_at', width: 180, render: () => '' },
              {
                title: 'Notes', key: 'note',
                render: (_, r) => r._isNew ? r.note : undefined,
                dataIndex: 'note',
              },
              {
                title: 'Operation', key: 'actions', width: 140,
                render: () => <Button type="link" size="small" onClick={handleAdd}>Add</Button>,
              },
            ]}
            dataSource={addRowData}
            rowKey="id"
            pagination={false}
            size="small"
            showHeader={false}
            style={{ marginBottom: 0 }}
          />
          <Table
            columns={columns}
            dataSource={items}
            rowKey="id"
            loading={loading}
            size="small"
            pagination={false}
            locale={{ emptyText: 'No furnishing items' }}
          />
        </>
      )}
    </div>
  );
}

// ===========================
// SERVICE HISTORY TAB
// ===========================
function ServiceHistoryTab({ unitId, isMobile }) {
  const router = useRouter();
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState(undefined);
  const [search, setSearch] = useState('');

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      const params = {};
      if (statusFilter !== undefined) params.status = statusFilter;
      const res = await propertyApi.getUnitServices(unitId, params);
      if (res.data.code === 200) {
        let data = res.data.data || [];
        if (search) {
          const s = search.toLowerCase();
          data = data.filter(d => (d.category || '').toLowerCase().includes(s) || (d.code || '').toLowerCase().includes(s));
        }
        setServices(data);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [unitId, statusFilter, search]);

  useEffect(() => { loadData(); }, [loadData]);

  const statusMap = {
    0: { text: 'Pending', color: 'orange' },
    1: { text: 'In Progress', color: 'blue' },
    2: { text: 'Completed', color: 'green' },
  };

  const columns = [
    { title: 'ID', dataIndex: 'code', key: 'code', width: 100 },
    {
      title: 'Submission Date', dataIndex: 'created_at', key: 'created_at', width: 180,
      render: (d) => d ? new Date(d).toLocaleString() : '-',
      sorter: (a, b) => new Date(a.created_at) - new Date(b.created_at),
    },
    {
      title: 'Status', dataIndex: 'status', key: 'status', width: 120,
      render: (s) => {
        const cfg = statusMap[s] || { text: 'Unknown', color: 'default' };
        return <Tag color={cfg.color}>{cfg.text}</Tag>;
      },
    },
    { title: 'Category', dataIndex: 'category', key: 'category', width: 140 },
    {
      title: 'Preferred Date', dataIndex: 'preferred_date_first_start', key: 'preferred', width: 160,
      render: (d) => d ? new Date(d).toLocaleDateString() : '-',
    },
    {
      title: 'Optional Date', dataIndex: 'preferred_date_second_start', key: 'optional', width: 160,
      render: (d) => d ? new Date(d).toLocaleDateString() : '-',
    },
    {
      title: 'Tenant', key: 'tenant', width: 150,
      render: (_, r) => r.tenant_first ? `${r.tenant_first} ${r.tenant_last}` : '-',
    },
    { title: 'Contact Phone', dataIndex: 'tenant_phone', key: 'phone', width: 140, render: (v) => v || '-' },
    {
      title: 'Action', key: 'actions', width: 100,
      render: (_, r) => (
        <Button type="link" size="small" onClick={() => router.push(`/service?id=${r.id}`)}>View</Button>
      ),
    },
  ];

  const renderServiceCard = (record) => {
    const cfg = statusMap[record.status] || { text: 'Unknown', color: 'default' };
    const tenant = record.tenant_first ? `${record.tenant_first} ${record.tenant_last}` : '-';
    return (
      <div style={{ background: '#fff', border: '1px solid #f0f0f0', borderRadius: 8, padding: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <Text strong style={{ fontSize: 13 }}>{record.code || '-'}</Text>
          <Tag color={cfg.color}>{cfg.text}</Tag>
        </div>
        <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>
          Category: <strong>{record.category || '-'}</strong>
        </div>
        <div style={{ display: 'flex', gap: 16, fontSize: 12, color: '#666', marginBottom: 4, flexWrap: 'wrap' }}>
          <span>Submitted: {record.created_at ? new Date(record.created_at).toLocaleDateString() : '-'}</span>
          <span>Preferred: {record.preferred_date_first_start ? new Date(record.preferred_date_first_start).toLocaleDateString() : '-'}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: '#666' }}>Tenant: {tenant}</span>
          <Button type="link" size="small" onClick={() => router.push(`/service?id=${record.id}`)}>View</Button>
        </div>
      </div>
    );
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: isMobile ? 'wrap' : 'nowrap', gap: isMobile ? 8 : 0 }}>
        <Text strong>{services.length} Total</Text>
        <Space>
          <Input placeholder="Type here to search..." prefix={<SearchOutlined />} value={search}
            onChange={e => setSearch(e.target.value)} style={{ width: isMobile ? 140 : 200 }} size="small" allowClear />
          <Button type="primary" size="small" onClick={() => router.push(`/service/create?unitId=${unitId}`)}>
            {isMobile ? 'Add' : 'Add Request'}
          </Button>
        </Space>
      </div>
      <div style={{ marginBottom: 12 }}>
        <Space wrap>
          {[undefined, 0, 1, 2].map(s => (
            <Button key={String(s)} type={statusFilter === s ? 'primary' : 'text'} size="small"
              onClick={() => setStatusFilter(s)}>
              {s === undefined ? 'All' : statusMap[s]?.text}
            </Button>
          ))}
        </Space>
      </div>
      {isMobile ? (
        <MobileCardList
          dataSource={services}
          renderCard={renderServiceCard}
          loading={loading}
          rowKey="id"
          emptyText="No Data"
        />
      ) : (
        <Table
          columns={columns}
          dataSource={services}
          rowKey="id"
          loading={loading}
          size="small"
          pagination={{ pageSize: 20 }}
          locale={{ emptyText: <Empty description="No Data" /> }}
        />
      )}
    </div>
  );
}

// ===========================
// SERVICE COST TAB
// ===========================
function ServiceCostTab({ unitId, isMobile }) {
  const router = useRouter();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [summary, setSummary] = useState({ inflow: 0, outflow: 0, balance: 0 });
  const [pagination, setPagination] = useState({ current: 1, pageSize: 20, total: 0 });
  const [period, setPeriod] = useState(undefined);

  const loadData = useCallback(async (page = 1) => {
    try {
      setLoading(true);
      const body = {};
      if (search) body.search = search;

      // Period filter
      if (period) {
        const now = new Date();
        let start;
        if (period === '1M') { start = new Date(now); start.setMonth(start.getMonth() - 1); }
        else if (period === 'LAST_M') { start = new Date(now.getFullYear(), now.getMonth() - 1, 1); body.endDate = new Date(now.getFullYear(), now.getMonth(), 0).toISOString().split('T')[0]; }
        else if (period === '6M') { start = new Date(now); start.setMonth(start.getMonth() - 6); }
        else if (period === '1Y') { start = new Date(now); start.setFullYear(start.getFullYear() - 1); }
        if (start && !body.endDate) body.startDate = start.toISOString().split('T')[0];
        else if (start) body.startDate = start.toISOString().split('T')[0];
      }

      const res = await propertyApi.getUnitServiceCosts(unitId, body, { page, limit: 20 });
      if (res.data.code === 200) {
        setRows(res.data.data.content || []);
        setSummary({
          inflow: res.data.data.inflow || 0,
          outflow: res.data.data.outflow || 0,
          balance: res.data.data.balance || 0,
        });
        setPagination(p => ({ ...p, current: page, total: res.data.data.totalElements || 0 }));
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [unitId, search, period]);

  useEffect(() => { loadData(); }, [loadData]);

  const periodOptions = [
    { value: undefined, label: 'ALL' },
    { value: '1M', label: '1M' },
    { value: 'LAST_M', label: 'LAST M' },
    { value: '6M', label: '6M' },
    { value: '1Y', label: '1Y' },
  ];

  const columns = [
    {
      title: 'Payment Date', dataIndex: 'payment_date', key: 'payment_date', width: 130,
      render: (d) => d ? new Date(d).toLocaleDateString() : '-',
    },
    {
      title: 'Tenant', key: 'tenant', width: 150,
      render: (_, r) => r.tenant_first ? `${r.tenant_first} ${r.tenant_last}` : '-',
    },
    { title: 'Notes', dataIndex: 'description', key: 'notes', ellipsis: true },
    {
      title: 'Property(Unit)', key: 'property_unit', width: 180,
      render: (_, r) => r.property_name ? `${r.property_name}(${r.unit_name || ''})` : '-',
    },
    { title: 'Account', dataIndex: 'account_name', key: 'account', width: 130, render: (v) => v || '-' },
    { title: 'Category', dataIndex: 'category_name', key: 'category', width: 130, render: (v) => v || '-' },
    {
      title: 'Outflow', key: 'outflow', width: 110,
      render: (_, r) => r.line_type === 0 ? <Text type="danger">${Number(r.line_amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</Text> : '-',
    },
    {
      title: 'Inflow', key: 'inflow', width: 110,
      render: (_, r) => r.line_type === 1 ? <Text style={{ color: '#3f8600' }}>${Number(r.line_amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</Text> : '-',
    },
    {
      title: 'Actions', key: 'actions', width: 80,
      render: (_, r) => <Button type="link" size="small" onClick={() => router.push(`/accounting/${r.id}`)}>View</Button>,
    },
  ];

  const renderCostCard = (record) => {
    const tenant = record.tenant_first ? `${record.tenant_first} ${record.tenant_last}` : '-';
    const isOutflow = record.line_type === 0;
    const amount = Number(record.line_amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 });
    return (
      <div style={{ background: '#fff', border: '1px solid #f0f0f0', borderRadius: 8, padding: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <Text strong style={{ fontSize: 13 }}>
            {record.payment_date ? new Date(record.payment_date).toLocaleDateString() : '-'}
          </Text>
          <Text style={{ fontWeight: 600, color: isOutflow ? '#ff4d4f' : '#3f8600', fontSize: 13 }}>
            {isOutflow ? '-' : '+'}${amount}
          </Text>
        </div>
        <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>
          {record.description || '-'}
        </div>
        <div style={{ display: 'flex', gap: 12, fontSize: 12, color: '#888', flexWrap: 'wrap', marginBottom: 4 }}>
          <span>Tenant: {tenant}</span>
          {record.category_name && <span>Cat: {record.category_name}</span>}
          {record.account_name && <span>Acc: {record.account_name}</span>}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: '#999' }}>
            {record.property_name ? `${record.property_name}(${record.unit_name || ''})` : '-'}
          </span>
          <Button type="link" size="small" onClick={() => router.push(`/accounting/${record.id}`)}>View</Button>
        </div>
      </div>
    );
  };

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: isMobile ? 'wrap' : 'nowrap', gap: isMobile ? 8 : 0 }}>
        <Text strong>{pagination.total} Total</Text>
        <Space>
          <Input placeholder="Type here to search..." prefix={<SearchOutlined />} value={search}
            onChange={e => setSearch(e.target.value)} style={{ width: isMobile ? 140 : 200 }} size="small" allowClear />
          <Button type="primary" size="small" onClick={() => router.push('/accounting/create')}>
            {isMobile ? 'Add' : 'Add Inflow / Outflow'}
          </Button>
        </Space>
      </div>
      {/* Period filters */}
      <div style={{ marginBottom: 12 }}>
        <Space wrap>
          {periodOptions.map(opt => (
            <Button key={String(opt.value)} type={period === opt.value ? 'link' : 'text'} size="small"
              onClick={() => setPeriod(opt.value)}
              style={period === opt.value ? { color: '#1677ff' } : {}}>
              {opt.label}
            </Button>
          ))}
        </Space>
      </div>
      {/* Summary row */}
      <div style={{
        display: 'flex', flexDirection: isMobile ? 'column' : 'row', gap: 0, marginBottom: 16, borderRadius: 6, overflow: 'hidden', border: '1px solid #f0f0f0',
      }}>
        <div style={{ flex: 1, padding: isMobile ? '10px 14px' : '12px 24px', borderRight: isMobile ? 'none' : '1px solid #f0f0f0', borderBottom: isMobile ? '1px solid #f0f0f0' : 'none' }}>
          <Text type="secondary" style={{ fontSize: 12 }}>Outflow (DR)</Text>
          <div><Text type="danger" strong>${Number(summary.outflow).toLocaleString(undefined, { minimumFractionDigits: 2 })}</Text></div>
        </div>
        <div style={{ flex: 1, padding: isMobile ? '10px 14px' : '12px 24px', borderRight: isMobile ? 'none' : '1px solid #f0f0f0', borderBottom: isMobile ? '1px solid #f0f0f0' : 'none' }}>
          <Text type="secondary" style={{ fontSize: 12 }}>Inflow (CR)</Text>
          <div><Text style={{ color: '#3f8600', fontWeight: 600 }}>${Number(summary.inflow).toLocaleString(undefined, { minimumFractionDigits: 2 })}</Text></div>
        </div>
        <div style={{ flex: 1, padding: isMobile ? '10px 14px' : '12px 24px' }}>
          <Text type="secondary" style={{ fontSize: 12 }}>Balance</Text>
          <div><Text strong>${Number(summary.balance).toLocaleString(undefined, { minimumFractionDigits: 2 })}</Text></div>
        </div>
      </div>
      {/* Table / Cards */}
      {isMobile ? (
        <MobileCardList
          dataSource={rows}
          renderCard={renderCostCard}
          loading={loading}
          rowKey={(r, i) => r.id + '-' + i}
          emptyText="No Data"
          pagination={{
            current: pagination.current,
            pageSize: pagination.pageSize,
            total: pagination.total,
            onChange: (page) => loadData(page),
          }}
        />
      ) : (
        <Table
          columns={columns}
          dataSource={rows}
          rowKey={(r, i) => r.id + '-' + i}
          loading={loading}
          size="small"
          pagination={{
            ...pagination,
            onChange: (page) => loadData(page),
            showSizeChanger: false,
          }}
          locale={{ emptyText: <Empty description="No Data" /> }}
        />
      )}
    </div>
  );
}

// ===========================
// MAIN UNIT DETAIL PAGE
// ===========================
export default function UnitDetailPage() {
  const { hasPermission } = useAuth();
  const { isMobile } = useIsMobile();
  const canEditUnit = hasPermission ? hasPermission('LANDLORD/UNIT_EDIT') : false;
  // See the note on canClone in the property detail page: UNIT_CLONE predates the
  // feature, so roles that can create a unit can clone one.
  const canCloneUnit = hasPermission
    ? (hasPermission('LANDLORD/UNIT_CLONE') || hasPermission('LANDLORD/UNIT_CREATE'))
    : false;
  const [unit, setUnit] = useState(null);
  const [propertyInfo, setPropertyInfo] = useState(null);
  const [amenities, setAmenities] = useState([]);
  const [leaseData, setLeaseData] = useState(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const params = useParams();
  const propertyId = params.id;
  const unitId = params.unitid;

  useEffect(() => {
    loadAll();
  }, [unitId]);

  const loadAll = async () => {
    try {
      const [unitRes, propRes, amenRes, leaseRes] = await Promise.all([
        propertyApi.getUnit(unitId),
        propertyApi.getUnitPropertyInfo(unitId),
        propertyApi.getUnitAmenities(unitId),
        propertyApi.getUnitCurrentLease(unitId),
      ]);
      if (unitRes.data.code === 200) setUnit(unitRes.data.data);
      if (propRes.data.code === 200) setPropertyInfo(propRes.data.data);
      if (amenRes.data.code === 200) setAmenities(amenRes.data.data || []);
      if (leaseRes.data.code === 200) setLeaseData(leaseRes.data.data);
    } catch (err) {
      message.error('Failed to load unit');
    } finally {
      setLoading(false);
    }
  };

  if (loading) return <MainLayout><div style={{ padding: 48, textAlign: 'center' }}><Spin size="large" /></div></MainLayout>;
  if (!unit) return <MainLayout><Card>Unit not found</Card></MainLayout>;

  const tabItems = [
    {
      key: 'general',
      label: 'GENERAL INFORMATION',
      children: <GeneralInfoTab unit={unit} propertyInfo={propertyInfo} amenities={amenities} leaseData={leaseData} />,
    },
    {
      key: 'furnishing',
      label: 'Furnishing',
      children: <FurnishingTab unitId={unitId} isMobile={isMobile} />,
    },
    {
      key: 'service-history',
      label: 'Service History',
      children: <ServiceHistoryTab unitId={unitId} isMobile={isMobile} />,
    },
    {
      key: 'service-cost',
      label: 'Service Cost',
      children: <ServiceCostTab unitId={unitId} isMobile={isMobile} />,
    },
    {
      key: 'viewings',
      label: 'Viewings',
      children: <UnitViewingsTab unitId={unitId} isMobile={isMobile} />,
    },
  ];

  return (
    <MainLayout>
      {/* Page title + top buttons */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Title level={4} style={{ margin: 0 }}>General Information</Title>
        <Space>
          <Button onClick={() => router.push(`/property/${propertyId}`)}>Close</Button>
          {canCloneUnit && <Button icon={<CopyOutlined />} onClick={() => router.push(`/property/${propertyId}/unit/create?copyFrom=${unitId}`)}>
            Clone
          </Button>}
          {canEditUnit && <Button type="primary" icon={<EditOutlined />} onClick={() => router.push(`/property/${propertyId}/unit/${unitId}/edit`)}>
            Edit
          </Button>}
        </Space>
      </div>

      {/* Main layout: left photo + right tabs */}
      <Row gutter={24}>
        {/* Left column: photo + status */}
        <Col xs={24} md={8} lg={6}>
          <Card bodyStyle={{ padding: 16, textAlign: 'center' }}>
            <div style={{
              width: '100%', paddingTop: '100%', position: 'relative',
              background: '#f5f5f5', borderRadius: 8, marginBottom: 16,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <div style={{
                position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <img
                  src="/house-placeholder.png"
                  alt="Unit"
                  style={{ maxWidth: '70%', maxHeight: '70%', objectFit: 'contain', opacity: 0.4 }}
                  onError={e => e.target.style.display = 'none'}
                />
              </div>
            </div>
            <Text strong style={{ fontSize: 14 }}>{unit.name}</Text>
            <br />
            <Text type="secondary" style={{ fontSize: 12 }}>
              {propertyInfo?.display_name}, {propertyInfo?.street_address}
            </Text>
            <Divider style={{ margin: '12px 0' }} />
            <div style={{ textAlign: 'left' }}>
              <Text type="secondary" style={{ fontSize: 12 }}>Status:</Text>
              <br />
              <Tag color={Number(unit.active_status) === 1 ? 'green' : 'default'} style={{ marginTop: 4 }}>
                {Number(unit.active_status) === 1 ? 'Active' : 'Inactive'}
              </Tag>
            </div>
            <Button block style={{ marginTop: 16 }} onClick={() => router.push(`/property/${propertyId}`)}>
              Return ↩
            </Button>
          </Card>
        </Col>

        {/* Right column: tabs */}
        <Col xs={24} md={16} lg={18}>
          <Card bodyStyle={{ padding: '4px 16px 16px' }}>
            <Tabs items={tabItems} size="small" />
          </Card>
        </Col>
      </Row>
    </MainLayout>
  );
}
