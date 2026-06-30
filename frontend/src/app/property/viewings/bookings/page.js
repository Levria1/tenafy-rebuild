'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Card, Table, Tag, Space, Button, Input, Select, DatePicker, Typography,
  message, Popconfirm, Modal, Descriptions, Empty,
} from 'antd';
import {
  SearchOutlined, ReloadOutlined, CloseCircleOutlined, EyeOutlined,
  SwapOutlined, CopyOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import MainLayout from '../../../../components/Layout';
import useIsMobile from '../../../../hooks/useIsMobile';
import { viewingApi, user as userApi } from '../../../../lib/api';

const { Text, Title } = Typography;
const { RangePicker } = DatePicker;

const STATUS_META = {
  0: { label: 'Pending',    color: 'gold'   },
  1: { label: 'Confirmed',  color: 'green'  },
  2: { label: 'Declined',   color: 'red'    },
  3: { label: 'Cancelled',  color: 'default' },
};

const DECISION_META = {
  0: { label: '—',        color: 'default' },
  1: { label: 'Approved', color: 'green'   },
  2: { label: 'Declined', color: 'red'     },
  3: { label: 'Skipped',  color: 'default' },
};

const AWAITING_META = {
  tenant:   { label: 'Waiting on tenant',   color: 'orange' },
  prospect: { label: 'Waiting on prospect', color: 'blue'   },
};

const SOURCE_META = {
  web:    { label: 'Web link' },
  invite: { label: 'Prospect invite' },
  manual: { label: 'Staff-created' },
};

const fmtDt = (dt) => (dt ? dayjs(dt).format('MMM D · h:mm A') : '');

function employeeLabel(emp) {
  if (!emp) return '—';
  return [emp.first_name, emp.last_name].filter(Boolean).join(' ') || '—';
}

export default function ViewingBookingsPage() {
  const { isMobile } = useIsMobile();
  const [bookings, setBookings] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(false);

  // Filters
  const [status, setStatus] = useState('0,1'); // default: pending + confirmed
  const [employeeId, setEmployeeId] = useState(null);
  const [dateRange, setDateRange] = useState(null);
  const [search, setSearch] = useState('');
  const [sourceFilter, setSourceFilter] = useState(null);
  const [awaitingFilter, setAwaitingFilter] = useState(null);

  // Detail modal
  const [detail, setDetail] = useState(null);
  // Reschedule result modal (shows the fresh prospect link)
  const [rescheduleResult, setRescheduleResult] = useState(null);
  const [actionId, setActionId] = useState(null);

  const reload = useCallback(() => {
    setLoading(true);
    const params = {};
    if (status && status !== 'all') params.status = status;
    if (employeeId) params.employee_id = employeeId;
    if (sourceFilter) params.source = sourceFilter;
    if (awaitingFilter) params.awaiting = awaitingFilter;
    if (dateRange && dateRange[0]) params.from = dateRange[0].format('YYYY-MM-DD');
    if (dateRange && dateRange[1]) params.to   = dateRange[1].format('YYYY-MM-DD');
    viewingApi.listAllBookings(params)
      .then((r) => setBookings(r.data.data || []))
      .catch(() => setBookings([]))
      .finally(() => setLoading(false));
  }, [status, employeeId, dateRange, sourceFilter, awaitingFilter]);

  const loadUsers = useCallback(() => {
    userApi.listUsers({}, { page: 1, limit: 500 })
      .then((r) => setUsers(r?.data?.data?.content || []))
      .catch(() => setUsers([]));
  }, []);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => { loadUsers(); }, [loadUsers]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return bookings;
    return bookings.filter(b => {
      const hay = [
        b.viewer_name, b.viewer_email, b.viewer_phone,
        b.unit?.name, b.property?.name,
        employeeLabel(b.employee),
      ].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [bookings, search]);

  const handleCancel = async (id) => {
    setActionId(id);
    try {
      await viewingApi.cancelBooking(id);
      message.success('Booking cancelled — prospect and tenant notified');
      reload();
    } catch (e) {
      message.error(e?.response?.data?.message || 'Cancel failed');
    } finally {
      setActionId(null);
    }
  };

  const handleReschedule = async (id) => {
    setActionId(id);
    try {
      const res = await viewingApi.rescheduleBooking(id);
      setRescheduleResult(res.data.data);
      message.success('Cancelled and a fresh link was sent to the prospect');
      reload();
    } catch (e) {
      message.error(e?.response?.data?.message || 'Reschedule failed');
    } finally {
      setActionId(null);
    }
  };

  const copyLink = (url) => {
    if (navigator?.clipboard) {
      navigator.clipboard.writeText(url).then(
        () => message.success('Link copied'),
        () => message.warning('Copy failed — select and copy manually')
      );
    }
  };

  const columns = [
    {
      title: 'When',
      dataIndex: 'proposed_datetime',
      width: 190,
      render: (dt, r) => (
        <div>
          <div>{dt ? dayjs(dt).format('MMM D, YYYY · h:mm A') : '—'}</div>
          {r.status === 0 && (r.candidate_times?.length > 1) && (
            <Text style={{ color: '#1677ff', fontSize: 12 }}>
              {r.candidate_times.length} times proposed
            </Text>
          )}
        </div>
      ),
      sorter: (a, b) => new Date(a.proposed_datetime) - new Date(b.proposed_datetime),
    },
    {
      title: 'Viewer',
      render: (_, r) => (
        <div>
          <div style={{ fontWeight: 500 }}>{r.viewer_name}</div>
          <div style={{ color: '#888', fontSize: 12 }}>{r.viewer_email}</div>
          {r.viewer_phone ? <div style={{ color: '#888', fontSize: 12 }}>{r.viewer_phone}</div> : null}
        </div>
      ),
    },
    {
      title: 'Unit / Property',
      render: (_, r) => (
        <div>
          <div style={{ fontWeight: 500 }}>{r.unit?.name || '—'}</div>
          <div style={{ color: '#888', fontSize: 12 }}>{r.property?.name || '—'}</div>
        </div>
      ),
    },
    {
      title: 'Host',
      render: (_, r) => employeeLabel(r.employee),
      width: 140,
    },
    {
      title: 'Status',
      dataIndex: 'status',
      width: 150,
      render: (s, r) => {
        const meta = STATUS_META[s] || STATUS_META[0];
        const aw = r.awaiting && AWAITING_META[r.awaiting];
        return (
          <Space direction="vertical" size={2}>
            <Tag color={meta.color}>{meta.label}</Tag>
            {aw && <Tag color={aw.color} style={{ fontSize: 11, margin: 0 }}>{aw.label}</Tag>}
          </Space>
        );
      },
      filters: Object.entries(STATUS_META).map(([k, v]) => ({ text: v.label, value: Number(k) })),
      onFilter: (v, r) => r.status === v,
    },
    {
      title: 'Decisions',
      width: 180,
      render: (_, r) => (
        <Space size={4} wrap>
          <Tag color={DECISION_META[r.tenant_decision]?.color}>
            Tenant: {DECISION_META[r.tenant_decision]?.label}
          </Tag>
          <Tag color={DECISION_META[r.employee_decision]?.color}>
            Host: {DECISION_META[r.employee_decision]?.label}
          </Tag>
        </Space>
      ),
    },
    {
      title: 'Actions',
      width: 280,
      fixed: 'right',
      render: (_, r) => (
        <Space wrap>
          <Button size="small" icon={<EyeOutlined />} onClick={() => setDetail(r)}>View</Button>
          {(r.status === 0 || r.status === 1) && (
            <Popconfirm
              title="Reschedule this viewing?"
              description="Cancels this booking and sends the prospect a fresh link to pick new times."
              onConfirm={() => handleReschedule(r.id)}
              okText="Reschedule"
              cancelText="No"
            >
              <Button size="small" icon={<SwapOutlined />} loading={actionId === r.id}>Reschedule</Button>
            </Popconfirm>
          )}
          {(r.status === 0 || r.status === 1) && (
            <Popconfirm
              title="Cancel this viewing?"
              description="The prospect and tenant will be notified."
              onConfirm={() => handleCancel(r.id)}
              okText="Cancel booking"
              cancelText="Keep"
            >
              <Button size="small" danger icon={<CloseCircleOutlined />} loading={actionId === r.id}>Cancel</Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  return (
    <MainLayout>
      <Card
        title={<Title level={4} style={{ margin: 0 }}>Viewing Bookings</Title>}
        extra={
          <Button icon={<ReloadOutlined />} onClick={reload} loading={loading}>
            Refresh
          </Button>
        }
      >
        <Space wrap style={{ marginBottom: 16 }}>
          <Input
            prefix={<SearchOutlined />}
            placeholder="Search viewer, unit, property…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: 240 }}
            allowClear
          />
          <Select
            value={status}
            onChange={setStatus}
            style={{ width: 180 }}
            options={[
              { value: '0,1',   label: 'Active (pending + confirmed)' },
              { value: '0',     label: 'Pending only' },
              { value: '1',     label: 'Confirmed only' },
              { value: '2',     label: 'Declined' },
              { value: '3',     label: 'Cancelled' },
              { value: 'all',   label: 'All' },
            ]}
          />
          <Select
            placeholder="Any host"
            allowClear
            value={employeeId}
            onChange={setEmployeeId}
            style={{ width: 180 }}
            options={users.map(u => ({
              value: String(u.id),
              label: [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username,
            }))}
          />
          <Select
            placeholder="Any source"
            allowClear
            value={sourceFilter}
            onChange={setSourceFilter}
            style={{ width: 150 }}
            options={Object.entries(SOURCE_META).map(([k, v]) => ({ value: k, label: v.label }))}
          />
          <Select
            placeholder="Waiting on…"
            allowClear
            value={awaitingFilter}
            onChange={setAwaitingFilter}
            style={{ width: 160 }}
            options={Object.entries(AWAITING_META).map(([k, v]) => ({ value: k, label: v.label }))}
          />
          <RangePicker
            value={dateRange}
            onChange={setDateRange}
            format="YYYY-MM-DD"
          />
        </Space>

        {filtered.length === 0 && !loading ? (
          <Empty description="No bookings match these filters" />
        ) : (
          <Table
            rowKey="id"
            dataSource={filtered}
            columns={columns}
            loading={loading}
            pagination={{ pageSize: 20, showSizeChanger: true }}
            scroll={{ x: 1300 }}
            size="middle"
          />
        )}
      </Card>

      <Modal
        open={!!detail}
        title={detail ? `Viewing — ${detail.unit?.name || ''}` : ''}
        onCancel={() => setDetail(null)}
        footer={[
          <Button key="close" onClick={() => setDetail(null)}>Close</Button>,
          detail && (detail.status === 0 || detail.status === 1) && (
            <Popconfirm
              key="reschedule"
              title="Reschedule this viewing?"
              description="Cancels this and sends the prospect a fresh link."
              onConfirm={async () => { await handleReschedule(detail.id); setDetail(null); }}
              okText="Reschedule"
              cancelText="No"
            >
              <Button icon={<SwapOutlined />}>Reschedule</Button>
            </Popconfirm>
          ),
          detail && (detail.status === 0 || detail.status === 1) && (
            <Popconfirm
              key="cancel"
              title="Cancel this viewing?"
              onConfirm={async () => { await handleCancel(detail.id); setDetail(null); }}
              okText="Cancel booking"
              cancelText="Keep"
            >
              <Button danger>Cancel Booking</Button>
            </Popconfirm>
          ),
        ]}
        width={640}
      >
        {detail && (
          <Descriptions bordered size="small" column={1}>
            <Descriptions.Item label="Status">
              <Tag color={STATUS_META[detail.status]?.color}>{STATUS_META[detail.status]?.label}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="When">
              {dayjs(detail.proposed_datetime).format('dddd, MMM D, YYYY · h:mm A')} ({detail.duration_minutes} min)
            </Descriptions.Item>
            <Descriptions.Item label="Property">{detail.property?.name}</Descriptions.Item>
            <Descriptions.Item label="Unit">{detail.unit?.name}</Descriptions.Item>
            <Descriptions.Item label="Host">{employeeLabel(detail.employee)}</Descriptions.Item>
            <Descriptions.Item label="Viewer">
              <div>{detail.viewer_name}</div>
              <div style={{ color: '#888' }}>{detail.viewer_email}</div>
              {detail.viewer_phone && <div style={{ color: '#888' }}>{detail.viewer_phone}</div>}
            </Descriptions.Item>
            {detail.viewer_message && (
              <Descriptions.Item label="Message">
                <div style={{ whiteSpace: 'pre-wrap' }}>{detail.viewer_message}</div>
              </Descriptions.Item>
            )}
            <Descriptions.Item label="Tenant Decision">
              <Tag color={DECISION_META[detail.tenant_decision]?.color}>
                {DECISION_META[detail.tenant_decision]?.label}
              </Tag>
            </Descriptions.Item>
            <Descriptions.Item label="Host Decision">
              <Tag color={DECISION_META[detail.employee_decision]?.color}>
                {DECISION_META[detail.employee_decision]?.label}
              </Tag>
            </Descriptions.Item>
            {detail.candidate_times?.length > 0 && (
              <Descriptions.Item label="Proposed times">
                <Space size={[8, 8]} wrap>
                  {detail.candidate_times.map((c, i) => {
                    const picked = detail.status === 1 &&
                      dayjs(c).valueOf() === dayjs(detail.proposed_datetime).valueOf();
                    return <Tag key={i} color={picked ? 'green' : 'default'}>{fmtDt(c)}{picked ? ' ✓' : ''}</Tag>;
                  })}
                </Space>
              </Descriptions.Item>
            )}
            <Descriptions.Item label="Source">
              {SOURCE_META[detail.source]?.label || detail.source || 'web'}
            </Descriptions.Item>
            <Descriptions.Item label="Submitted">
              {dayjs(detail.created_at).format('MMM D, YYYY · h:mm A')}
            </Descriptions.Item>
          </Descriptions>
        )}
      </Modal>

      <Modal
        open={!!rescheduleResult}
        title="Fresh viewing link created"
        onCancel={() => setRescheduleResult(null)}
        footer={[<Button key="done" type="primary" onClick={() => setRescheduleResult(null)}>Done</Button>]}
        width={560}
      >
        {rescheduleResult && (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Text>
              The previous booking was cancelled and the prospect has been sent a new link
              to pick fresh times. You can also copy it here:
            </Text>
            <Space.Compact style={{ width: '100%' }}>
              <Input readOnly value={rescheduleResult.invite_url} />
              <Button icon={<CopyOutlined />} onClick={() => copyLink(rescheduleResult.invite_url)}>
                Copy
              </Button>
            </Space.Compact>
          </Space>
        )}
      </Modal>
    </MainLayout>
  );
}
