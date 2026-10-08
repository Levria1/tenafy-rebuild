'use client';

import { useEffect, useMemo, useState } from 'react';
import { Card, Col, DatePicker, Input, Row, Select, Space, Statistic, Table, Tag, Tooltip, Typography, message } from 'antd';
import dayjs from 'dayjs';
import Link from 'next/link';
import MainLayout from '../../../components/Layout';
import MobileCardList from '../../../components/mobile/MobileCardList';
import useIsMobile from '../../../hooks/useIsMobile';
import { leasing } from '../../../lib/api';

const { RangePicker } = DatePicker;
const { Text, Title } = Typography;
const STATUS_OPTIONS = [
  { value: 'unsigned', label: 'Unsigned' },
  { value: 'pending', label: 'Pending Signing' },
  { value: 'expired', label: 'Expired link' },
  { value: 'signed', label: 'Signed' },
  { value: 'declined', label: 'Declined' },
  { value: 'ota', label: 'OTA (no signing)' },
];
const STATUS_LABELS = Object.fromEntries(STATUS_OPTIONS.map(option => [option.value, option.label]));

function DateText({ value, wholeLease }) {
  return (
    <div>
      <div>{value ? dayjs(value).format('MMMM D, YYYY') : '—'}</div>
      {wholeLease && <Text type="secondary" italic style={{ fontSize: 11 }}>(whole lease)</Text>}
    </div>
  );
}

function SignedStatus({ row }) {
  const meta = {
    unsigned: { color: 'red', label: 'Unsigned' },
    pending: { color: 'blue', label: 'Pending Signing' },
    expired: { color: 'orange', label: 'Expired link' },
    signed: { color: 'green', label: 'Signed' },
    declined: { color: 'magenta', label: 'Declined' },
    ota: { color: 'default', label: 'OTA — no signing needed' },
  }[row.signed_status];
  if (!meta) return '—';
  let detail = '';
  if (row.signed_status === 'pending' && row.sent_at) detail = `sent ${dayjs(row.sent_at).format('D MMM')}`;
  if (row.signed_status === 'expired' && row.expires_at) detail = `expired ${dayjs(row.expires_at).format('D MMM')}`;
  if (row.signed_status === 'signed') {
    detail = `· ${row.signed_method === 'paper' ? 'Paper' : 'E-sign'}`;
    if (row.signed_at) detail += ` · ${dayjs(row.signed_at).format('D MMM')}`;
  }
  const kind = row.kind === 'extension' ? 'Extension' : row.kind === 'new_lease' ? 'New lease' : null;
  return (
    <Space size={5} wrap>
      <Tag color={meta.color} style={{ margin: 0 }}>{meta.label}</Tag>
      {detail && <Text type="secondary" style={{ fontSize: 11 }}>{detail}</Text>}
      {kind && <Text type="secondary" style={{ fontSize: 11 }}>{kind}</Text>}
    </Space>
  );
}

function Building({ row }) {
  return [row.property_name, row.unit_name].filter(Boolean).join(' ') || '—';
}

export default function SigningTrackingPage() {
  const { isMobile } = useIsMobile();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState(null);
  const [statuses, setStatuses] = useState([]);
  const [propertyName, setPropertyName] = useState(null);
  const [source, setSource] = useState(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    let live = true;
    setLoading(true);
    leasing.signingTracking({ from: '2026-09-01' })
      .then((res) => {
        if (live && res.data.code === 200) setRows(res.data.data.rows || []);
      })
      .catch((error) => message.error(error?.response?.data?.message || 'Failed to load signing tracker'))
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);

  const propertyOptions = useMemo(() => [...new Set(rows.map(row => row.property_name).filter(Boolean))]
    .sort().map(value => ({ value, label: value })), [rows]);
  const sourceOptions = useMemo(() => [
    { value: '__missing__', label: 'Not set' },
    ...[...new Set(rows.map(row => row.platform_name).filter(Boolean))].sort().map(value => ({ value, label: value })),
  ], [rows]);

  const withoutStatus = useMemo(() => rows.filter((row) => {
    if (range?.[0] && dayjs(row.period_start).isBefore(range[0], 'day')) return false;
    if (range?.[1] && dayjs(row.period_start).isAfter(range[1], 'day')) return false;
    if (propertyName && row.property_name !== propertyName) return false;
    if (source === '__missing__' && !row.source_missing) return false;
    if (source && source !== '__missing__' && row.platform_name !== source) return false;
    const needle = search.trim().toLowerCase();
    return !needle || [row.tenant_name, row.unit_name, row.lease_no]
      .some(value => String(value || '').toLowerCase().includes(needle));
  }), [rows, range, propertyName, source, search]);

  const visible = useMemo(() => statuses.length
    ? withoutStatus.filter(row => statuses.includes(row.signed_status))
    : withoutStatus, [withoutStatus, statuses]);
  const counts = useMemo(() => Object.fromEntries(['unsigned', 'pending', 'expired', 'signed', 'ota']
    .map(status => [status, withoutStatus.filter(row => row.signed_status === status).length])), [withoutStatus]);

  const columns = [
    { title: 'Property / Building', key: 'building', width: 190, render: (_, row) => <Building row={row} /> },
    { title: 'Tenant Name', dataIndex: 'tenant_name', width: 170, render: value => value || '—' },
    { title: 'Source', key: 'source', width: 120, render: (_, row) => row.source_missing ? <Tag color="orange">Not set</Tag> : row.platform_name },
    { title: 'Lease Start', dataIndex: 'period_start', width: 155, render: (value, row) => <DateText value={value} wholeLease={!row.period_recorded} /> },
    { title: 'Lease End', dataIndex: 'period_end', width: 155, render: (value, row) => <DateText value={value} wholeLease={!row.period_recorded} /> },
    { title: 'Signed Status', key: 'signed', width: 230, render: (_, row) => <SignedStatus row={row} /> },
    { title: 'Stamp Status', key: 'stamp', width: 100, render: () => <Tooltip title="Coming soon"><Text type="secondary">—</Text></Tooltip> },
    { title: 'Lease', key: 'lease', width: 110, fixed: 'right', render: (_, row) => <Link href={`/leasing/${row.lease_id}/detail`}>{row.lease_no || 'Lease'} →</Link> },
  ];

  const counters = [
    { key: null, title: 'Total', value: withoutStatus.length },
    ...['unsigned', 'pending', 'expired', 'signed', 'ota'].map(key => ({ key, title: STATUS_LABELS[key], value: counts[key] || 0 })),
  ];

  return (
    <MainLayout>
      <Title level={4} style={{ margin: 0 }}>Signing & Stamp Tracking</Title>
      <Text type="secondary" style={{ display: 'block', marginBottom: 16, fontSize: 13 }}>
        Contract periods starting from 1 Sep 2026. Airbnb, Agoda and other platforms that don&apos;t require signing show as OTA.
      </Text>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
        <RangePicker allowClear value={range} onChange={setRange} placeholder={['Period start from', 'Period start to']} style={{ width: isMobile ? '100%' : 280 }} />
        <Select mode="multiple" allowClear placeholder="Signed status" value={statuses} onChange={setStatuses} options={STATUS_OPTIONS} style={{ minWidth: 210, flex: isMobile ? '1 1 100%' : undefined }} />
        <Select allowClear showSearch optionFilterProp="label" placeholder="Property" value={propertyName} onChange={setPropertyName} options={propertyOptions} style={{ width: isMobile ? '100%' : 180 }} />
        <Select allowClear showSearch optionFilterProp="label" placeholder="Source" value={source} onChange={setSource} options={sourceOptions} style={{ width: isMobile ? '100%' : 160 }} />
        <Input.Search allowClear placeholder="Tenant, unit or lease no." value={search} onChange={event => setSearch(event.target.value)} style={{ width: isMobile ? '100%' : 220 }} />
      </div>

      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        {counters.map(counter => (
          <Col xs={12} sm={8} md={4} key={counter.title}>
            <Card
              size="small"
              hoverable
              onClick={() => setStatuses(counter.key ? [counter.key] : [])}
              style={{ cursor: 'pointer', borderColor: counter.key && statuses.length === 1 && statuses[0] === counter.key ? '#1677ff' : undefined }}
            >
              <Statistic title={counter.title} value={counter.value} valueStyle={{ fontSize: 22 }} />
            </Card>
          </Col>
        ))}
      </Row>

      {isMobile ? (
        <MobileCardList
          dataSource={visible}
          loading={loading}
          rowKey="key"
          emptyText="No contract periods found"
          renderCard={row => (
            <Card size="small">
              <Space direction="vertical" size={5} style={{ width: '100%' }}>
                <Text strong>{row.tenant_name || 'Unnamed tenant'}</Text>
                <Text type="secondary"><Building row={row} /></Text>
                <SignedStatus row={row} />
                <Text>{dayjs(row.period_start).format('D MMM YYYY')} – {row.period_end ? dayjs(row.period_end).format('D MMM YYYY') : 'Open ended'}</Text>
                <Space><Text type="secondary">{row.source_missing ? 'Not set' : row.platform_name}</Text><Link href={`/leasing/${row.lease_id}/detail`}>{row.lease_no || 'Lease'} →</Link></Space>
              </Space>
            </Card>
          )}
        />
      ) : (
        <Table columns={columns} dataSource={visible} rowKey="key" loading={loading} pagination={{ pageSize: 100, showSizeChanger: false }} scroll={{ x: 1230, y: 'calc(100vh - 390px)' }} />
      )}
    </MainLayout>
  );
}
