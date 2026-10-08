'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button, Card, Col, DatePicker, Input, Modal, Row, Select, Space, Statistic, Table, Tag, Tooltip, Typography, message } from 'antd';
import dayjs from 'dayjs';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import MainLayout from '../../../components/Layout';
import MobileCardList from '../../../components/mobile/MobileCardList';
import useIsMobile from '../../../hooks/useIsMobile';
import { leasing, signature } from '../../../lib/api';

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

// Most urgent first when the status column is sorted ascending.
const STATUS_ORDER = ['unsigned', 'expired', 'declined', 'pending', 'signed', 'ota'];
const byText = (a, b) => String(a || '').localeCompare(String(b || ''));
const buildingText = row => [row.property_name, row.unit_name].filter(Boolean).join(' ');

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

  const router = useRouter();
  const [resendingKey, setResendingKey] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = await leasing.signingTracking({ from: '2026-09-01' });
      if (res.data.code === 200) setRows(res.data.data.rows || []);
    } catch (error) {
      message.error(error?.response?.data?.message || 'Failed to load signing tracker');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // Resend THIS row's request with a fresh link. The server refuses (409) when another
  // live request on the lease covers an overlapping period; offer to replace it — the
  // same choice the lease page gives.
  const resend = async (row, data = {}) => {
    setResendingKey(row.key);
    try {
      const res = await signature.resendRequest(row.request_id, data);
      if (res.data?.code === 200) {
        const exp = res.data.data?.expires_at ? dayjs(res.data.data.expires_at).format('D MMM YYYY') : null;
        message.success(`New link sent to ${row.tenant_name || 'the signer'}.${exp ? ` Valid until ${exp}.` : ''}`);
        await load();
      } else {
        message.error(res.data?.message || 'Failed to resend');
      }
    } catch (err) {
      const conflictData = err.response?.data?.data;
      if (err.response?.status === 409 && conflictData?.reason === 'overlapping_request') {
        Modal.confirm({
          title: 'Another document is already out for signature',
          content: (
            <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>
              {(conflictData.conflicts || []).map(conflict => (
                <li key={conflict.id}>
                  {conflict.term_start && conflict.term_end
                    ? `${dayjs(conflict.term_start).format('D MMM YYYY')} – ${dayjs(conflict.term_end).format('D MMM YYYY')}`
                    : 'Period not recorded'}
                  {conflict.sent_at ? ` · sent ${dayjs(conflict.sent_at).format('D MMM YYYY')}` : ''}
                </li>
              ))}
            </ul>
          ),
          okText: 'Cancel it and resend',
          okButtonProps: { danger: true },
          onOk: () => resend(row, { replace_overlapping: true }),
        });
        return;
      }
      message.error(err.response?.data?.message || 'Failed to resend');
    } finally {
      setResendingKey(null);
    }
  };

  // Pending / expired rows have a request to revive. Unsigned / declined rows need a new
  // document; review-and-send prefills the uncovered period from the server.
  const statusAction = (row) => {
    if ((row.signed_status === 'pending' || row.signed_status === 'expired') && row.request_id) {
      return (
        <Button size="small" type={row.signed_status === 'expired' ? 'primary' : 'default'}
          loading={resendingKey === row.key} onClick={() => resend(row)}>
          {row.signed_status === 'expired' ? 'Resend new link' : 'Resend'}
        </Button>
      );
    }
    if (row.signed_status === 'unsigned' || row.signed_status === 'declined') {
      return (
        <Button size="small" type="primary" onClick={() => router.push(`/leasing/${row.lease_id}/review-and-send`)}>
          Send for signing
        </Button>
      );
    }
    return null;
  };

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
    { title: 'Lease Created', dataIndex: 'lease_created_at', width: 130, defaultSortOrder: 'descend',
      sorter: (a, b) => byText(a.lease_created_at, b.lease_created_at) || byText(a.period_start, b.period_start),
      render: value => (value ? dayjs(value).format('MMM D, YYYY') : '—') },
    { title: 'Tenant Name', dataIndex: 'tenant_name', width: 170, sorter: (a, b) => byText(a.tenant_name, b.tenant_name), render: value => value || '—' },
    { title: 'Property / Building', key: 'building', width: 190, sorter: (a, b) => byText(buildingText(a), buildingText(b)), render: (_, row) => <Building row={row} /> },
    { title: 'Source', key: 'source', width: 120, sorter: (a, b) => byText(a.platform_name, b.platform_name), render: (_, row) => row.source_missing ? <Tag color="orange">Not set</Tag> : row.platform_name },
    { title: 'Lease Start', dataIndex: 'period_start', width: 155, sorter: (a, b) => byText(a.period_start, b.period_start), render: (value, row) => <DateText value={value} wholeLease={!row.period_recorded} /> },
    { title: 'Lease End', dataIndex: 'period_end', width: 155, sorter: (a, b) => byText(a.period_end, b.period_end), render: (value, row) => <DateText value={value} wholeLease={!row.period_recorded} /> },
    { title: 'Signed Status', key: 'signed', width: 330,
      sorter: (a, b) => STATUS_ORDER.indexOf(a.signed_status) - STATUS_ORDER.indexOf(b.signed_status),
      render: (_, row) => <Space size={8} wrap><SignedStatus row={row} />{statusAction(row)}</Space> },
    { title: 'Stamp Status', key: 'stamp', width: 100, render: () => <Tooltip title="Coming soon"><Text type="secondary">—</Text></Tooltip> },
    { title: 'Lease', key: 'lease', width: 110, fixed: 'right', sorter: (a, b) => byText(a.lease_no, b.lease_no), render: (_, row) => <Link href={`/leasing/${row.lease_id}/detail`}>{row.lease_no || 'Lease'} →</Link> },
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
                <Space size={8} wrap><SignedStatus row={row} />{statusAction(row)}</Space>
                {row.lease_created_at && <Text type="secondary" style={{ fontSize: 12 }}>Lease created {dayjs(row.lease_created_at).format('D MMM YYYY')}</Text>}
                <Text>{dayjs(row.period_start).format('D MMM YYYY')} – {row.period_end ? dayjs(row.period_end).format('D MMM YYYY') : 'Open ended'}</Text>
                <Space><Text type="secondary">{row.source_missing ? 'Not set' : row.platform_name}</Text><Link href={`/leasing/${row.lease_id}/detail`}>{row.lease_no || 'Lease'} →</Link></Space>
              </Space>
            </Card>
          )}
        />
      ) : (
        <Table columns={columns} dataSource={visible} rowKey="key" loading={loading} pagination={{ pageSize: 100, showSizeChanger: false }} scroll={{ x: 1460, y: 'calc(100vh - 390px)' }} />
      )}
    </MainLayout>
  );
}
