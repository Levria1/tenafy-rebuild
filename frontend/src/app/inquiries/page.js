'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  Table, Input, Button, Space, Select, Tag, Card, Empty, message,
  Popconfirm, Typography, Tooltip, Switch, DatePicker,
} from 'antd';
import {
  PlusOutlined, SearchOutlined, UserAddOutlined, CalendarOutlined,
  DeleteOutlined, EyeOutlined, EditOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import MainLayout from '../../components/Layout';
import MobileCardList from '../../components/mobile/MobileCardList';
import useIsMobile from '../../hooks/useIsMobile';
import { inquiry, settings } from '../../lib/api';
import CreateViewingModal from './CreateViewingModal';

const { Text } = Typography;

const STATUS_LABELS = { 0: 'Open', 1: 'Converted', 2: 'Closed' };
const STATUS_COLORS = { 0: 'blue', 1: 'green', 2: 'default' };

export default function InquiriesPage() {
  const router = useRouter();
  const { isMobile } = useIsMobile();
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [leadSourceFilter, setLeadSourceFilter] = useState('');
  // Desired-move-in date range filter — null when not active.
  // [dayjs|null, dayjs|null] from the RangePicker.
  const [desiredRange, setDesiredRange] = useState(null);
  const [leadSources, setLeadSources] = useState([]);
  const [viewingModal, setViewingModal] = useState({ open: false, inquiry: null });
  const [showDelete, setShowDelete] = useState(false);

  useEffect(() => {
    settings.getLeadSources().then(r => {
      if (r.data?.code === 200) setLeadSources(r.data.data || []);
    }).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = { page, limit: pageSize };
      if (search) params.search = search;
      if (statusFilter !== '') params.status = statusFilter;
      if (leadSourceFilter) params.leadSourceId = leadSourceFilter;
      if (desiredRange?.[0]) params.desiredStartFrom = desiredRange[0].format('YYYY-MM-DD');
      if (desiredRange?.[1]) params.desiredStartTo   = desiredRange[1].format('YYYY-MM-DD');
      const r = await inquiry.list(params);
      if (r.data?.code === 200) {
        setData(r.data.data.content || []);
        setTotal(r.data.data.totalElements || 0);
      }
    } catch (e) {
      message.error('Failed to load inquiries');
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, search, statusFilter, leadSourceFilter, desiredRange]);

  useEffect(() => { load(); }, [load]);

  // Route to the tenant create form pre-filled with the inquiry's data.
  // The tenant is only persisted when staff clicks Save on that form; if
  // they cancel, the inquiry stays open and no contact is created.
  const onConvertToContact = (record) => {
    const params = new URLSearchParams({ inquiry_id: String(record.id) });
    if (record.first_name) params.set('first_name', record.first_name);
    if (record.last_name) params.set('last_name', record.last_name);
    if (record.email) params.set('email', record.email);
    if (record.phone) params.set('phone', record.phone);
    if (record.notes) params.set('notes', record.notes);
    if (record.lead_source_id) params.set('lead_source_id', String(record.lead_source_id));
    router.push(`/contacts/tenant/create?${params.toString()}`);
  };

  const onCreateViewing = (record) => {
    setViewingModal({ open: true, inquiry: record });
  };

  const onDelete = async (id) => {
    try {
      await inquiry.delete(id);
      message.success('Inquiry deleted');
      load();
    } catch (e) {
      message.error('Failed to delete inquiry');
    }
  };

  const columns = [
    {
      title: 'Date',
      dataIndex: 'inquiry_date',
      width: 130,
      render: (v) => v ? dayjs(v).format('YYYY-MM-DD') : '—',
    },
    {
      title: 'Source',
      dataIndex: 'lead_source_name',
      width: 130,
      render: (v, r) => {
        // Prefer a configured lead source (manual entries); otherwise show the
        // inbound channel for auto-captured inquiries.
        if (v) return v;
        const src = (r.source || '').toLowerCase();
        const META = {
          whatsapp: { color: 'green', label: 'WhatsApp' },
          email:    { color: 'blue',  label: 'Email' },
          web:      { color: 'cyan',  label: 'Web' },
        };
        const m = META[src];
        return m ? <Tag color={m.color}>{m.label}</Tag> : <Text type="secondary">—</Text>;
      },
    },
    { title: 'First Name', dataIndex: 'first_name', width: 130 },
    { title: 'Last Name', dataIndex: 'last_name', width: 130 },
    {
      title: 'Start',
      dataIndex: 'desired_start_date',
      width: 120,
      render: (v) => v ? dayjs(v).format('YYYY-MM-DD') : <Text type="secondary">—</Text>,
    },
    {
      title: 'Budget',
      dataIndex: 'budget',
      width: 110,
      render: (v) => v != null && v !== '' ? Number(v).toLocaleString() : <Text type="secondary">—</Text>,
    },
    {
      title: 'Email',
      dataIndex: 'email',
      ellipsis: true,
      render: (v) => v || <Text type="secondary">—</Text>,
    },
    {
      title: 'Notes',
      dataIndex: 'notes',
      ellipsis: true,
      render: (v) => v
        ? <Tooltip title={<div style={{ whiteSpace: 'pre-wrap', maxWidth: 400 }}>{v}</div>}><span>{v}</span></Tooltip>
        : <Text type="secondary">—</Text>,
    },
    { title: 'Phone Number', dataIndex: 'phone', width: 140 },
    {
      title: 'User',
      dataIndex: 'created_by_name',
      width: 140,
      render: (v, r) => (v && v.trim()) || r.created_by_email || <Text type="secondary">—</Text>,
    },
    {
      title: 'Status',
      dataIndex: 'status',
      width: 110,
      render: (v) => <Tag color={STATUS_COLORS[v]}>{STATUS_LABELS[v]}</Tag>,
    },
    {
      title: 'Actions',
      width: showDelete ? 300 : 260,
      fixed: 'right',
      render: (_, r) => (
        <Space size={4}>
          <Tooltip title="View">
            <Button size="small" icon={<EyeOutlined />} onClick={() => router.push(`/inquiries/${r.id}`)} />
          </Tooltip>
          <Tooltip title="Edit">
            <Button size="small" icon={<EditOutlined />} onClick={() => router.push(`/inquiries/${r.id}/edit`)} />
          </Tooltip>
          <Button
            size="small"
            icon={<CalendarOutlined />}
            onClick={() => onCreateViewing(r)}
          >
            Viewing
          </Button>
          <Button
            size="small"
            type="primary"
            icon={<UserAddOutlined />}
            disabled={!!r.tenant_id}
            onClick={() => onConvertToContact(r)}
          >
            Contact
          </Button>
          {showDelete && (
            <Popconfirm title="Delete this inquiry?" onConfirm={() => onDelete(r.id)}>
              <Button size="small" danger icon={<DeleteOutlined />} />
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  const renderMobileCard = (r) => (
    <Card
      key={r.id}
      size="small"
      style={{ marginBottom: 8, borderRadius: 8 }}
      bodyStyle={{ padding: '12px 14px' }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <Text strong style={{ fontSize: 14 }} onClick={() => router.push(`/inquiries/${r.id}`)}>
          {[r.first_name, r.last_name].filter(Boolean).join(' ') || '(no name)'}
        </Text>
        <Tag color={STATUS_COLORS[r.status]}>{STATUS_LABELS[r.status]}</Tag>
      </div>
      <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>
        {r.email && <div>{r.email}</div>}
        {r.phone && <div>{r.phone}</div>}
      </div>
      <div style={{ fontSize: 11, color: '#999', marginBottom: 8 }}>
        {r.lead_source_name
          ? <span>{r.lead_source_name} · </span>
          : (r.source && r.source !== 'manual' && <span>{r.source} · </span>)}
        {dayjs(r.inquiry_date).format('YYYY-MM-DD')}
      </div>
      <Space size={4} wrap>
        <Button size="small" onClick={() => router.push(`/inquiries/${r.id}`)}>View</Button>
        <Button size="small" icon={<EditOutlined />} onClick={() => router.push(`/inquiries/${r.id}/edit`)}>Edit</Button>
        <Button size="small" icon={<CalendarOutlined />} onClick={() => onCreateViewing(r)}>
          Viewing
        </Button>
        <Button size="small" type="primary" icon={<UserAddOutlined />}
                disabled={!!r.tenant_id} onClick={() => onConvertToContact(r)}>
          Contact
        </Button>
        {showDelete && (
          <Popconfirm title="Delete this inquiry?" onConfirm={() => onDelete(r.id)}>
            <Button size="small" danger icon={<DeleteOutlined />}>Delete</Button>
          </Popconfirm>
        )}
      </Space>
    </Card>
  );

  return (
    <MainLayout>
      <div style={{ padding: '0 0 24px 0' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
          <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0, color: '#333' }}>Inquiry List</h2>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => router.push('/inquiries/create')}>
            Add Inquiry
          </Button>
        </div>

        <Space wrap style={{ marginBottom: 16 }}>
          <Input
            placeholder="Search name, email, phone"
            prefix={<SearchOutlined />}
            allowClear
            style={{ width: 260 }}
            onChange={(e) => { setPage(1); setSearch(e.target.value); }}
          />
          <Select
            placeholder="Status"
            allowClear
            style={{ width: 140 }}
            value={statusFilter || undefined}
            onChange={(v) => { setPage(1); setStatusFilter(v ?? ''); }}
            options={[
              { label: 'Open', value: 0 },
              { label: 'Converted', value: 1 },
              { label: 'Closed', value: 2 },
            ]}
          />
          <Select
            placeholder="Lead Source"
            allowClear
            style={{ width: 200 }}
            value={leadSourceFilter || undefined}
            onChange={(v) => { setPage(1); setLeadSourceFilter(v || ''); }}
            options={leadSources.map(s => ({ label: s.name, value: String(s.id) }))}
          />
          {/* Desired-move-in date range. Filters inquiries by the prospect's
              stated desired_start_date — useful for triaging prospects who
              want to move in a particular month. Either end can be left blank
              for an open-ended range. */}
          <DatePicker.RangePicker
            placeholder={['Move-in from', 'Move-in to']}
            value={desiredRange}
            onChange={(v) => { setPage(1); setDesiredRange(v); }}
            format="YYYY-MM-DD"
            allowEmpty={[true, true]}
            style={{ width: 280 }}
          />
          <span style={{ marginLeft: 8, fontSize: 12, color: '#666' }}>
            <Switch size="small" checked={showDelete} onChange={setShowDelete} style={{ marginRight: 6 }} />
            Show Delete
          </span>
        </Space>

        {isMobile ? (
          <MobileCardList
            dataSource={data}
            renderCard={renderMobileCard}
            loading={loading}
            pagination={{ current: page, pageSize, total, onChange: setPage }}
            rowKey="id"
            emptyText="No inquiries yet"
          />
        ) : (
          <Table
            rowKey="id"
            columns={columns}
            dataSource={data}
            loading={loading}
            scroll={{ x: 1500 }}
            pagination={{
              current: page,
              pageSize,
              total,
              showSizeChanger: false,
              onChange: setPage,
            }}
            locale={{ emptyText: <Empty description="No inquiries yet" /> }}
          />
        )}
      </div>
      <CreateViewingModal
        open={viewingModal.open}
        inquiry={viewingModal.inquiry}
        onClose={() => setViewingModal({ open: false, inquiry: null })}
        onCreated={load}
      />
    </MainLayout>
  );
}
