'use client';

import { useEffect, useState } from 'react';
import { Table, Card, Tag, Typography, Space, Input, Select, message, Tooltip } from 'antd';
import { HomeOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import Link from 'next/link';
import MainLayout from '../../../components/Layout';
import { advertisingApi } from '../../../lib/api';

const { Title, Text } = Typography;

// Renewal-intent colours + human labels.
const INTENT_META = {
  NR: { color: 'red', label: 'NR · Not Renewing' },
  UC: { color: 'orange', label: 'UC · Unconfirmed' },
  MR: { color: 'blue', label: 'MR · May Renew' },
  MTM: { color: 'purple', label: 'MTM · Month-to-Month' },
  Unset: { color: 'default', label: 'Unset' },
};

// Days-left urgency colour (positive = days until vacant).
function daysColor(d) {
  if (d == null) return 'default';
  if (d <= 7) return 'red';
  if (d <= 20) return 'orange';
  return 'green';
}

export default function VacancyPage() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [leadDays, setLeadDays] = useState(60);
  const [counts, setCounts] = useState({ vacant: 0, expiring: 0 });
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState(null);        // null = All
  const [upcomingFilter, setUpcomingFilter] = useState('open');  // default: things not yet filled
  const [intentFilter, setIntentFilter] = useState([]);          // multi-select renewal intents

  const load = async () => {
    setLoading(true);
    try {
      const res = await advertisingApi.getVacancies();
      if (res.data.code === 200) {
        const d = res.data.data;
        setRows(d.vacancies || []);
        if (d.lead_days) setLeadDays(d.lead_days);
        setCounts({ vacant: d.vacant_count || 0, expiring: d.expiring_count || 0 });
      } else {
        message.error(res.data.message || 'Failed to load vacancies');
      }
    } catch (e) {
      message.error('Failed to load vacancies');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const filtered = rows.filter(r => {
    if (statusFilter && r.status !== statusFilter) return false;
    const hasUpcoming = !!r.next_move_in_date;
    if (upcomingFilter === 'has' && !hasUpcoming) return false;
    if (upcomingFilter === 'open' && hasUpcoming) return false;
    // Renewal intent only exists on occupied/expiring rows — selecting any intent
    // drops vacant-now units (they have no current lease, so no intent).
    if (intentFilter.length && (!r.intent || !intentFilter.includes(r.intent))) return false;
    if (search) {
      const q = search.toLowerCase();
      return (
        (r.property_name || '').toLowerCase().includes(q) ||
        (r.unit_name || '').toLowerCase().includes(q) ||
        (r.tenant_name || '').toLowerCase().includes(q) ||
        (r.next_tenant_name || '').toLowerCase().includes(q)
      );
    }
    return true;
  });

  const columns = [
    {
      title: 'Status',
      key: 'status',
      width: 150,
      render: (_, r) => {
        if (r.status === 'vacant') {
          if (r.days_vacant == null) {
            return <Tag color="volcano">Vacant · never leased</Tag>;
          }
          return <Tag color="red" style={{ fontWeight: 600 }}>Vacant {r.days_vacant}d</Tag>;
        }
        return <Tag color={daysColor(r.days_left)} style={{ fontWeight: 600 }}>Expiring · {r.days_left}d</Tag>;
      },
    },
    {
      title: 'Property / Unit',
      key: 'unit',
      render: (_, r) => (
        <div>
          <Link href={`/property`} style={{ fontWeight: 500 }}>{r.property_name}</Link>
          <div><Text type="secondary" style={{ fontSize: 12 }}>Unit {r.unit_name}{r.unit_type ? ` · ${r.unit_type}` : ''}</Text></div>
        </div>
      ),
    },
    {
      title: 'Tenant',
      key: 'tenant_name',
      render: (_, r) => {
        if (!r.tenant_name) return <Text type="secondary">—</Text>;
        const hasMoveOutInfo = !!r.moveout_notes || !!r.moved_out_early;
        const tooltipTitle = (r.status === 'vacant' || hasMoveOutInfo) ? (
          <div style={{ maxWidth: 320, whiteSpace: 'pre-wrap' }}>
            {r.status === 'vacant' && <div>Previous tenant</div>}
            {r.moved_out_early && <div style={{ fontWeight: 600 }}>Moved out early</div>}
            {r.moveout_notes && <div>{r.moveout_notes}</div>}
          </div>
        ) : null;
        const inner = r.tenant_id
          ? <Link href={`/contacts/tenants/${r.tenant_id}`}>{r.tenant_name}</Link>
          : <Text type="secondary">{r.tenant_name}</Text>;
        const nameContent = r.status === 'vacant'
          ? <><Text type="secondary" style={{ fontSize: 12 }}>Last: </Text>{inner}</>
          : inner;
        const nameEl = tooltipTitle
          ? <Tooltip title={tooltipTitle}>{nameContent}</Tooltip>
          : nameContent;
        return (
          <div>
            {nameEl}
            {r.moved_out_early && (
              <div><Text type="secondary" style={{ fontSize: 12, color: '#d48806' }}>Moved out early</Text></div>
            )}
            {r.notice_period_days != null && (
              <div><Text type="secondary" style={{ fontSize: 12 }}>Notice Period ({r.notice_period_days} days)</Text></div>
            )}
          </div>
        );
      },
    },
    {
      title: 'Renewal Intent',
      dataIndex: 'intent',
      key: 'intent',
      width: 130,
      render: (v) => {
        if (!v) return <Text type="secondary">—</Text>;
        const m = INTENT_META[v] || INTENT_META.Unset;
        return <Tooltip title={m.label}><Tag color={m.color}>{v}</Tag></Tooltip>;
      },
    },
    {
      title: 'Ends / Vacant Since',
      key: 'date',
      width: 150,
      render: (_, r) => {
        if (r.status === 'vacant') {
          return r.vacant_since
            ? <Tooltip title="Vacant since"><Text type="secondary">since {r.vacant_since}</Text></Tooltip>
            : <Text type="secondary">—</Text>;
        }
        return r.end_date || '—';
      },
    },
    {
      title: 'Next Move-In',
      key: 'next_move_in',
      width: 160,
      render: (_, r) => {
        if (!r.next_move_in_date) return <Text type="secondary">—</Text>;
        const d = r.days_to_move_in;
        const rel = d == null ? '' : d <= 0 ? ' · today' : ` · in ${d}d`;
        return (
          <span>
            {r.next_move_in_date}
            <Text type="secondary" style={{ fontSize: 12 }}>{rel}</Text>
          </span>
        );
      },
    },
    {
      title: 'Next Tenant',
      key: 'next_tenant',
      width: 160,
      render: (_, r) => {
        if (!r.next_tenant_name) return <Text type="secondary">—</Text>;
        return r.next_tenant_id
          ? <Link href={`/contacts/tenants/${r.next_tenant_id}`}>{r.next_tenant_name}</Link>
          : <Text type="secondary">{r.next_tenant_name}</Text>;
      },
    },
    {
      title: 'Rent',
      dataIndex: 'rent',
      key: 'rent',
      width: 120,
      align: 'right',
      render: (v, r) => {
        if (v == null) return '—';
        const label = `HK$${Number(v).toLocaleString()}`;
        return r.status === 'vacant'
          ? <Tooltip title="Last lease rent"><Text type="secondary">{label}</Text></Tooltip>
          : label;
      },
    },
    {
      title: 'Beds / Baths / Size',
      key: 'specs',
      width: 150,
      render: (_, r) => {
        const parts = [];
        if (r.beds != null) parts.push(`${r.beds} bd`);
        if (r.baths != null) parts.push(`${r.baths} ba`);
        if (r.size != null) parts.push(`${r.size} ft²`);
        return parts.length ? <Text type="secondary" style={{ fontSize: 12 }}>{parts.join(' · ')}</Text> : '—';
      },
    },
  ];

  return (
    <MainLayout>
      <div style={{ padding: 24 }}>
        <Space align="center" style={{ marginBottom: 4 }}>
          <HomeOutlined style={{ fontSize: 22, color: '#1677ff' }} />
          <Title level={3} style={{ margin: 0 }}>Vacancy</Title>
        </Space>
        <div style={{ marginBottom: 16 }}>
          <Text type="secondary">
            Units that are or will soon be available — <Tag color="red">Vacant now</Tag> (empty today,
            even if a move-in is booked), then <Tag color="green">Expiring</Tag> (occupied, lease ending
            within <Tag color="blue">{leadDays}d</Tag>). The <b>Next Move-In</b> columns show a booked
            incoming tenant. Defaults to <b>Open</b> (not yet filled) — switch <i>Upcoming booking</i> to see
            booked units.
          </Text>
        </div>

        <Card styles={{ body: { padding: 16 } }} style={{ borderColor: '#e8e8e8' }}>
          <Space style={{ marginBottom: 16 }} wrap>
            <Input
              placeholder="Search property, unit or tenant"
              prefix={<SearchOutlined />}
              allowClear
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ width: 260 }}
            />
            <Select
              placeholder="All statuses"
              allowClear
              value={statusFilter}
              onChange={setStatusFilter}
              style={{ width: 170 }}
              options={[
                { value: 'vacant', label: `Vacant now (${counts.vacant})` },
                { value: 'expiring', label: `Expiring soon (${counts.expiring})` },
              ]}
            />
            <Select
              value={upcomingFilter}
              onChange={setUpcomingFilter}
              style={{ width: 200 }}
              options={[
                { value: 'open', label: 'Open · no upcoming' },
                { value: 'has', label: 'Has upcoming move-in' },
                { value: 'any', label: 'Any booking status' },
              ]}
            />
            <Select
              mode="multiple"
              allowClear
              placeholder="Renewal intent"
              value={intentFilter}
              onChange={setIntentFilter}
              style={{ minWidth: 200 }}
              options={[
                { value: 'NR', label: 'NR · Not Renewing' },
                { value: 'MR', label: 'MR · May Renew' },
                { value: 'MTM', label: 'MTM · Month-to-Month' },
                { value: 'UC', label: 'UC · Unconfirmed' },
              ]}
            />
            <a onClick={load}><ReloadOutlined /> Refresh</a>
            <Text type="secondary">
              {filtered.length} unit{filtered.length === 1 ? '' : 's'}
              {' '}({counts.vacant} vacant · {counts.expiring} expiring)
            </Text>
          </Space>

          <Table
            rowKey={(r) => r.lease_id || `unit-${r.unit_id}`}
            columns={columns}
            dataSource={filtered}
            loading={loading}
            pagination={{ pageSize: 20, showSizeChanger: true }}
            size="middle"
            scroll={{ x: 'max-content' }}
          />
        </Card>
      </div>
    </MainLayout>
  );
}
