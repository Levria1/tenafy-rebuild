'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Card, DatePicker, Empty, Segmented, Select, Space, Spin, Tag, Typography, message } from 'antd';
import { KeyOutlined, LoginOutlined, LogoutOutlined, ReloadOutlined, SwapOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import Link from 'next/link';
import MainLayout from '../../../components/Layout';
import { leasing, property as propertyApi } from '../../../lib/api';
import { formatDoorCode } from '../../../lib/format';
import useIsMobile from '../../../hooks/useIsMobile';

const { Text, Title } = Typography;
const { RangePicker } = DatePicker;

const DEFAULT_DAYS = 30;

// One place decides how an arrival and a departure look, so the desktop row and the
// phone card can never colour the same event differently.
const TYPE_META = {
  in: { label: 'CHECK IN', colour: '#389e0d', tint: '#f6ffed', border: '#b7eb8f', Icon: LoginOutlined },
  out: { label: 'CHECK OUT', colour: '#d46b08', tint: '#fff7e6', border: '#ffd591', Icon: LogoutOutlined },
};

function TypeTag({ type }) {
  const meta = TYPE_META[type];
  if (!meta) return null;
  const { Icon } = meta;
  return (
    <Tag
      icon={<Icon />}
      style={{ color: meta.colour, background: meta.tint, borderColor: meta.border, fontWeight: 600, margin: 0 }}
    >
      {meta.label}
    </Tag>
  );
}

// "Today" and "Tomorrow" beat a date string for the two days staff actually act on.
function dayHeading(date) {
  const d = dayjs(date);
  const diff = d.startOf('day').diff(dayjs().startOf('day'), 'day');
  const stamp = d.format('ddd D MMM YYYY');
  if (diff === 0) return { stamp, relative: 'Today', urgent: true };
  if (diff === 1) return { stamp, relative: 'Tomorrow', urgent: true };
  return { stamp, relative: `in ${diff} days`, urgent: false };
}

export default function CheckInCheckOutPage() {
  const { isMobile } = useIsMobile();
  const [rows, setRows] = useState([]);
  const [counts, setCounts] = useState({ in: 0, out: 0 });
  const [loading, setLoading] = useState(true);
  const [properties, setProperties] = useState([]);
  const [propertyId, setPropertyId] = useState(null);
  const [range, setRange] = useState([dayjs(), dayjs().add(DEFAULT_DAYS, 'day')]);
  const [typeFilter, setTypeFilter] = useState('all');

  useEffect(() => {
    propertyApi.getAll()
      .then((res) => { if (res.data.code === 200) setProperties(res.data.data || []); })
      .catch(() => { /* the filter just stays empty */ });
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (range?.[0]) params.from = range[0].format('YYYY-MM-DD');
      if (range?.[1]) params.to = range[1].format('YYYY-MM-DD');
      if (propertyId) params.propertyId = propertyId;
      const res = await leasing.getCheckInOut(params);
      if (res.data.code === 200) {
        setRows(res.data.data.rows || []);
        setCounts(res.data.data.counts || { in: 0, out: 0 });
      } else {
        message.error(res.data.message || 'Failed to load');
      }
    } catch (e) {
      message.error(e?.response?.data?.message || 'Failed to load check-ins and check-outs');
    } finally {
      setLoading(false);
    }
  }, [range, propertyId]);

  useEffect(() => { load(); }, [load]);

  const visible = useMemo(
    () => (typeFilter === 'all' ? rows : rows.filter((r) => r.type === typeFilter)),
    [rows, typeFilter]
  );

  // The backend already returns the rows in the order they should be read, so grouping
  // is a single pass and same-day turnovers stay adjacent inside their day.
  const days = useMemo(() => {
    const out = [];
    for (const row of visible) {
      const last = out[out.length - 1];
      if (last && last.date === row.date) last.rows.push(row);
      else out.push({ date: row.date, rows: [row] });
    }
    return out;
  }, [visible]);

  const filters = (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 16 }}>
      <Select
        allowClear
        showSearch
        optionFilterProp="label"
        placeholder="All properties"
        value={propertyId}
        onChange={setPropertyId}
        style={{ width: isMobile ? '100%' : 240 }}
        options={properties.map((p) => ({ value: String(p.id), label: p.display_name }))}
      />
      <RangePicker
        value={range}
        onChange={(v) => setRange(v)}
        allowClear={false}
        format="YYYY-MM-DD"
        style={{ width: isMobile ? '100%' : undefined, flex: isMobile ? undefined : '0 0 auto' }}
      />
      <Segmented
        block={isMobile}
        value={typeFilter}
        onChange={setTypeFilter}
        style={{ width: isMobile ? '100%' : undefined }}
        options={[
          { label: `All (${rows.length})`, value: 'all' },
          { label: `In (${counts.in})`, value: 'in' },
          { label: `Out (${counts.out})`, value: 'out' },
        ]}
      />
      <a onClick={load} style={{ whiteSpace: 'nowrap' }}><ReloadOutlined /> Refresh</a>
    </div>
  );

  return (
    <MainLayout>
      <div style={{ marginBottom: 4 }}>
        <Title level={4} style={{ margin: 0 }}>Check In / Check Out</Title>
      </div>
      <Text type="secondary" style={{ display: 'block', marginBottom: 16, fontSize: 13 }}>
        Everyone moving in or out from today onwards, earliest first.
      </Text>

      {filters}

      {loading ? (
        <div style={{ padding: 48, textAlign: 'center' }}><Spin /></div>
      ) : days.length === 0 ? (
        <Empty description="Nothing scheduled in this window" style={{ padding: '48px 0' }} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 900 }}>
          {days.map((day) => {
            const heading = dayHeading(day.date);
            return (
              <div key={day.date}>
                {/* Day heading */}
                <div
                  style={{
                    display: 'flex', alignItems: 'baseline', gap: 8,
                    paddingBottom: 6, marginBottom: 10, borderBottom: '1px solid #f0f0f0',
                  }}
                >
                  <Text strong style={{ fontSize: 15 }}>{heading.stamp}</Text>
                  <Text style={{ fontSize: 12, color: heading.urgent ? '#d4380d' : '#999' }}>
                    {heading.relative}
                  </Text>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {day.rows.map((row) => (
                    <MovementCard key={row.id} row={row} isMobile={isMobile} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </MainLayout>
  );
}

function MovementCard({ row, isMobile }) {
  const meta = TYPE_META[row.type];
  const doorCode = formatDoorCode(row.door_code);
  return (
    <Link href={`/leasing/${row.lease_id}/detail`} style={{ color: 'inherit' }}>
      <Card
        size="small"
        hoverable
        style={{ borderRadius: 8, borderLeft: `4px solid ${meta.colour}` }}
        bodyStyle={{ padding: isMobile ? '10px 12px' : '10px 16px' }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: isMobile ? 'column' : 'row',
            alignItems: isMobile ? 'flex-start' : 'center',
            gap: isMobile ? 6 : 16,
          }}
        >
          <div style={{ flex: isMobile ? undefined : '0 0 130px' }}>
            <TypeTag type={row.type} />
          </div>

          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {row.tenant_name || 'Unnamed tenant'}
            </div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {row.property_name || 'Unknown property'}
              {row.unit_name ? ` · ${row.unit_name}` : ''}
            </Text>
            {/* Under the unit, because on an inspection the unit and its code are
                one question. Omitted entirely when the lease records none — an
                empty row here would read as "no code needed", which is not the
                same thing as "nobody wrote it down". */}
            {doorCode && (
              <div
                style={{
                  fontSize: 12, color: '#595959', marginTop: 2,
                  fontFamily: doorCode.collapsed ? undefined : 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}
                title={doorCode.full}
              >
                <KeyOutlined style={{ marginInlineEnd: 6, color: '#8c8c8c' }} />
                {doorCode.short}
              </div>
            )}
          </div>

          {row.turnover && (
            <Tag
              icon={<SwapOutlined />}
              color="blue"
              style={{ margin: 0, alignSelf: isMobile ? 'flex-start' : 'center' }}
            >
              Same-day turnover
            </Tag>
          )}
        </div>
      </Card>
    </Link>
  );
}
