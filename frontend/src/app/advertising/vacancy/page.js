'use client';

import { useEffect, useState } from 'react';
import { Table, Card, Tag, Typography, Space, Input, Select, message, Tooltip } from 'antd';
import { SoundOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
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

// Days-left urgency colour.
function daysColor(d) {
  if (d == null) return 'default';
  if (d <= 7) return 'red';
  if (d <= 20) return 'orange';
  return 'green';
}

export default function VacancyPage() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [leadDays, setLeadDays] = useState({ NR: 45, UC: 30, DEFAULT: 20 });
  const [search, setSearch] = useState('');
  const [intentFilter, setIntentFilter] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = await advertisingApi.getVacancies();
      if (res.data.code === 200) {
        setRows(res.data.data.vacancies || []);
        if (res.data.data.lead_days) setLeadDays(res.data.data.lead_days);
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
    if (intentFilter && r.intent !== intentFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      return (
        (r.property_name || '').toLowerCase().includes(q) ||
        (r.unit_name || '').toLowerCase().includes(q) ||
        (r.tenant_name || '').toLowerCase().includes(q)
      );
    }
    return true;
  });

  const columns = [
    {
      title: 'Days Left',
      dataIndex: 'days_left',
      key: 'days_left',
      width: 110,
      defaultSortOrder: 'ascend',
      sorter: (a, b) => (a.days_left ?? 9999) - (b.days_left ?? 9999),
      render: (d) => <Tag color={daysColor(d)} style={{ fontWeight: 600 }}>{d} days</Tag>,
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
      sorter: (a, b) => (a.property_name || '').localeCompare(b.property_name || ''),
    },
    {
      title: 'Current Tenant',
      dataIndex: 'tenant_name',
      key: 'tenant_name',
      render: (v, r) => r.tenant_id
        ? <Link href={`/contacts/tenants/${r.tenant_id}`}>{v}</Link>
        : <Text type="secondary">{v}</Text>,
    },
    {
      title: 'Renewal Intent',
      dataIndex: 'intent',
      key: 'intent',
      width: 150,
      render: (v) => {
        const m = INTENT_META[v] || INTENT_META.Unset;
        return <Tooltip title={m.label}><Tag color={m.color}>{v}</Tag></Tooltip>;
      },
    },
    {
      title: 'Lease Ends',
      dataIndex: 'end_date',
      key: 'end_date',
      width: 120,
      render: (v) => v || '—',
    },
    {
      title: 'Rent',
      dataIndex: 'rent',
      key: 'rent',
      width: 120,
      align: 'right',
      sorter: (a, b) => (a.rent ?? 0) - (b.rent ?? 0),
      render: (v) => v != null ? `HK$${Number(v).toLocaleString()}` : '—',
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
          <SoundOutlined style={{ fontSize: 22, color: '#1677ff' }} />
          <Title level={3} style={{ margin: 0 }}>Vacancy</Title>
        </Space>
        <div style={{ marginBottom: 16 }}>
          <Text type="secondary">
            Units whose current lease is expiring and needs advertising, soonest first.
            Shown once inside the lead window: <Tag color="red">NR {leadDays.NR}d</Tag>
            <Tag color="orange">UC {leadDays.UC}d</Tag>
            <Tag color="blue">MR / MTM / Unset {leadDays.DEFAULT}d</Tag>
            before the lease ends. Units already re-let are excluded.
          </Text>
        </div>

        <Card
          styles={{ body: { padding: 16 } }}
          style={{ borderColor: '#e8e8e8' }}
        >
          <Space style={{ marginBottom: 16 }} wrap>
            <Input
              placeholder="Search property, unit or tenant"
              prefix={<SearchOutlined />}
              allowClear
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ width: 280 }}
            />
            <Select
              placeholder="All intents"
              allowClear
              value={intentFilter}
              onChange={setIntentFilter}
              style={{ width: 180 }}
              options={[
                { value: 'NR', label: 'NR · Not Renewing' },
                { value: 'UC', label: 'UC · Unconfirmed' },
                { value: 'MR', label: 'MR · May Renew' },
                { value: 'MTM', label: 'MTM · Month-to-Month' },
                { value: 'Unset', label: 'Unset' },
              ]}
            />
            <a onClick={load}><ReloadOutlined /> Refresh</a>
            <Text type="secondary">{filtered.length} unit{filtered.length === 1 ? '' : 's'}</Text>
          </Space>

          <Table
            rowKey="lease_id"
            columns={columns}
            dataSource={filtered}
            loading={loading}
            pagination={{ pageSize: 20, showSizeChanger: true }}
            size="middle"
          />
        </Card>
      </div>
    </MainLayout>
  );
}
