'use client';

import { useEffect, useState } from 'react';
import dayjs from 'dayjs';
import { Table, Card, Tag, Typography, Space, Input, Select, message, Tooltip, Modal, Form, DatePicker, Checkbox, Popconfirm } from 'antd';
import { HomeOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import Link from 'next/link';
import MainLayout from '../../../components/Layout';
import { advertisingApi } from '../../../lib/api';

const { Title, Text } = Typography;
const { RangePicker } = DatePicker;

// Renewal-intent colours + human labels.
const INTENT_META = {
  NR: { color: 'red', label: 'NR · Not Renewing' },
  UC: { color: 'orange', label: 'UC · Unconfirmed' },
  MR: { color: 'blue', label: 'MR · May Renew' },
  MTM: { color: 'purple', label: 'MTM · Month-to-Month' },
  Unset: { color: 'default', label: 'Unset' },
};

// One place decides how a renewal sequence reads, so the row and the off-page card can
// never describe the same state differently.
const ASK_STATUS_META = {
  // "Unsure" lands here rather than under replied_*: the tenant has not decided, so the
  // sequence is still running and the row must not read as settled. The vague answer is
  // still shown, because staff seeing "they said they're not sure" is the point.
  awaiting_reply: {
    color: 'blue',
    label: (a) => (a.reply === 'unsure' ? `Not sure yet · asked ${a.asks_delivered}/3` : `Asked ${a.asks_delivered}/3`),
    help: (a) => `Asked ${a.asks_delivered} of 3 by ${a.channel || 'message'}${a.last_delivered_on ? `, last on ${a.last_delivered_on}` : ''}. `
      + (a.reply === 'unsure'
          ? 'The tenant answered but has not decided, so we keep asking. Record Extend or Leaving here if they tell you.'
          : 'Waiting for a reply.'),
  },
  could_not_reach_them:        { color: 'orange', label: () => 'Could not reach them',        help: () => 'We tried, but nothing was delivered. Check the phone number or email on the tenant.' },
  no_answer_call_them:         { color: 'red',    label: () => 'No answer · call them',        help: () => 'Three asks, no reply. Someone should phone the tenant.' },
  extend_pending_paperwork:    { color: 'gold',   label: () => 'Extend · paperwork due',      help: () => 'The tenant chose Extend. Not offered to customers. Extend the lease to clear this.' },
  // The relay captured a message it could not attribute safely — a group thread, a
  // forward, wording that only reads as an answer in context. Asking again is paused
  // for a week so we do not nag someone who has replied; nothing has acted. Someone
  // has to read it, and if the week lapses with no decision the sequence resumes.
  possible_reply_check_it:     { color: 'geekblue', label: () => 'Possibly answered · read it', help: () => 'A message may be this tenant\u2019s answer, but it could not be attributed with confidence. Asking is paused for 7 days and nothing has changed. Read it and record Extend or Leaving, or leave it to resume.' },
  replied_needs_review:        { color: 'purple', label: (a) => `Replied: ${a.reply}`,        help: () => 'The tenant replied. Nothing has changed for customers — confirm the renewal intent yourself.' },
  replied_but_stale_check_lease: { color: 'volcano', label: () => 'Replied · lease changed',  help: (a) => `The tenant replied, but the lease changed after we asked (${a.reply_stale_reason || 'changed'}), so we did not act on it. Check the lease.` },
};

// Staff-side answer entry. The tenant may reply to a person rather than to the bot, and
// without a way to record that they would keep being asked and then be escalated as
// unresponsive — the worst outcome of the whole sequence.
function RenewalReplyControls({ ask, onRecord, busy }) {
  // Hidden once a DEFINITE answer exists. A vague one leaves the controls up: staff who
  // hear "actually we're staying" must be able to record it, exactly as the relay can.
  if (!ask?.latest_ask_id || (ask.reply && ask.reply !== 'unsure')) return null;
  return (
    <Space size={4} wrap>
      <Text type="secondary" style={{ fontSize: 12 }}>They told us:</Text>
      {[['extend', 'Extending'], ['leaving', 'Leaving'], ['unsure', 'Not sure']].map(([value, label]) => (
        <Popconfirm
          key={value}
          title={value === 'extend'
            ? 'Record that the tenant is extending? The unit stops being offered to customers straight away.'
            : `Record that the tenant said "${label.toLowerCase()}"? Nothing changes for customers until you set the renewal intent.`}
          okText="Record"
          onConfirm={() => onRecord(ask.latest_ask_id, value)}
        >
          <a style={{ fontSize: 12, pointerEvents: busy ? 'none' : undefined, opacity: busy ? 0.5 : 1 }}>{label}</a>
        </Popconfirm>
      ))}
    </Space>
  );
}

function RenewalAskTag({ ask }) {
  const meta = ASK_STATUS_META[ask.status];
  if (!meta) return null;
  return (
    <Tooltip title={meta.help(ask)}>
      <Tag color={meta.color} style={{ fontWeight: ask.status === 'extend_pending_paperwork' ? 600 : 400 }}>
        {meta.label(ask)}
      </Tag>
    </Tooltip>
  );
}

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
  const [asOf, setAsOf] = useState(dayjs().format('YYYY-MM-DD'));
  const [leadDays, setLeadDays] = useState(60);
  const [defaultLeadDays, setDefaultLeadDays] = useState(60);
  const [maxLeadDays, setMaxLeadDays] = useState(730);
  const [counts, setCounts] = useState({ vacant: 0, expiring: 0, manual: 0 });
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState(null);        // null = All
  const [upcomingFilter, setUpcomingFilter] = useState('open');  // default: things not yet filled
  const [intentFilter, setIntentFilter] = useState([]);          // multi-select renewal intents
  const [openingRange, setOpeningRange] = useState(null);
  const [openingMode, setOpeningMode] = useState('opens');
  const [pageSize, setPageSize] = useState(50);
  const [overrideRows, setOverrideRows] = useState([]);
  const [renewalAsks, setRenewalAsks] = useState([]);
  const [recordingReply, setRecordingReply] = useState(false);
  const [overrideModal, setOverrideModal] = useState(null);       // { row }
  const [savingOverride, setSavingOverride] = useState(false);
  const [overrideForm] = Form.useForm();

  const load = async (range = openingRange) => {
    setLoading(true);
    try {
      const params = {};
      const rangeEnd = range?.[1] ? dayjs(range[1]).format('YYYY-MM-DD') : null;
      const normalThrough = dayjs(asOf).add(defaultLeadDays, 'day').format('YYYY-MM-DD');
      if (rangeEnd && rangeEnd > normalThrough) params.through = rangeEnd;
      const [res, overridesRes, asksRes] = await Promise.all([
        advertisingApi.getVacancies(Object.keys(params).length ? params : undefined),
        advertisingApi.listVacancyOverrides(),
        advertisingApi.getRenewalAsks().catch(() => ({ data: { code: 200, data: [] } })),
      ]);
      if (asksRes?.data?.code === 200) setRenewalAsks(asksRes.data.data || []);
      if (res.data.code === 200) {
        const d = res.data.data;
        setRows(d.vacancies || []);
        if (d.as_of) setAsOf(d.as_of);
        if (d.lead_days) setLeadDays(d.lead_days);
        if (d.default_lead_days) setDefaultLeadDays(d.default_lead_days);
        if (d.max_lead_days) setMaxLeadDays(d.max_lead_days);
        setCounts({ vacant: d.vacant_count || 0, expiring: d.expiring_count || 0, manual: d.manual_count || 0 });
      } else {
        message.error(res.data.message || 'Failed to load vacancies');
      }
      if (overridesRes.data.code === 200) {
        setOverrideRows(overridesRes.data.data || []);
      }
    } catch (e) {
      message.error('Failed to load vacancies');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const overrideById = new Map(overrideRows.map(o => [String(o.id), o]));
  // Keyed by lease: a renewal sequence belongs to the lease we asked about, and the same
  // unit may have had an earlier one.
  const askByLease = new Map(renewalAsks.map(a => [String(a.lease_id), a]));
  // Sequences whose lease never reaches this page — too far out, or the unit is re-let.
  // Without surfacing them here they would run entirely unobserved.
  // Settled asks (lease renewed, ended or gone) are history, not "in flight".
  const offPageAsks = renewalAsks.filter(a => !a.settled && !rows.some(r => String(r.lease_id) === String(a.lease_id)));
  const todayForOpenDates = asOf || dayjs().format('YYYY-MM-DD');

  const opensOn = (r) => {
    if (r.source === 'manual') {
      const override = r.override_id ? overrideById.get(String(r.override_id)) : null;
      return override?.available_from || (r.end_date ? dayjs(r.end_date).add(1, 'day').format('YYYY-MM-DD') : null);
    }
    if (r.status === 'vacant') return r.vacant_since || todayForOpenDates;
    return r.end_date || null;
  };

  const rangeFrom = openingRange?.[0] ? dayjs(openingRange[0]).format('YYYY-MM-DD') : null;
  const rangeTo = openingRange?.[1] ? dayjs(openingRange[1]).format('YYYY-MM-DD') : null;
  const hasOpeningRange = !!(rangeFrom && rangeTo);

  const openOverrideModal = (row) => {
    const override = row?.override_id ? overrideById.get(String(row.override_id)) : null;
    setOverrideModal({ row });
    overrideForm.setFieldsValue({
      available_from: dayjs(override?.available_from || row.end_date).add(override?.available_from ? 0 : 1, 'day'),
      expires_on: dayjs(override?.expires_on || row.expires_on),
      reason: override?.reason || row.reason || '',
      offered: override ? !!(override.advertising_enabled || override.inquiry_enabled) : true,
    });
  };

  const saveOverride = async () => {
    try {
      const vals = await overrideForm.validateFields();
      setSavingOverride(true);
      await advertisingApi.saveVacancyOverride({
        unit_id: overrideModal.row.unit_id,
        available_from: dayjs(vals.available_from).format('YYYY-MM-DD'),
        expires_on: dayjs(vals.expires_on).format('YYYY-MM-DD'),
        reason: vals.reason || null,
        advertising_enabled: !!vals.offered,
        inquiry_enabled: !!vals.offered,
      });
      message.success('Saved');
      setOverrideModal(null);
      await load(openingRange);
    } catch (e) {
      if (!e?.errorFields) message.error(e.response?.data?.message || 'Failed to save vacancy override');
    } finally {
      setSavingOverride(false);
    }
  };

  const recordRenewalReply = async (askId, intent) => {
    setRecordingReply(true);
    try {
      const res = await advertisingApi.recordRenewalReply(askId, { intent });
      const d = res.data?.data;
      if (d?.applied === false && d?.stale_reason) {
        message.warning('Recorded, but the lease changed since we asked — check it before acting.');
      } else if (d?.withdrawn_from_offers) {
        message.success('Recorded. The unit is no longer offered to customers — extend the lease to finish.');
      } else {
        message.success('Recorded. Nothing has changed for customers.');
      }
      await load(openingRange);
    } catch (e) {
      message.error(e.response?.data?.message || 'Failed to record the reply');
    } finally {
      setRecordingReply(false);
    }
  };

  const clearOverride = async (id) => {
    try {
      await advertisingApi.clearVacancyOverride(id);
      message.success('Cleared');
      await load(openingRange);
    } catch (e) {
      message.error(e.response?.data?.message || 'Failed to clear vacancy override');
    }
  };

  const matchesNonDateFilters = (r) => {
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
  };

  const matchesOpeningRange = (r) => {
    if (!hasOpeningRange) return true;
    const date = opensOn(r);
    if (!date) return false;
    if (openingMode === 'by') return date <= rangeTo;
    return date >= rangeFrom && date <= rangeTo;
  };

  const filteredBeforeDates = rows.filter(matchesNonDateFilters);
  const filtered = filteredBeforeDates.filter(matchesOpeningRange);
  const outsideDateCount = hasOpeningRange ? filteredBeforeDates.length - filtered.length : 0;

  const handleOpeningRangeChange = (nextRange) => {
    setOpeningRange(nextRange);
    load(nextRange);
  };

  const activeRangeText = hasOpeningRange
    ? openingMode === 'by'
      ? <>Showing every unit free by <b>{rangeTo}</b> — including ones already empty. Switch to <i>Opens in range</i> for only the ones becoming free between {rangeFrom} and {rangeTo}.</>
      : <>Showing units becoming free between <b>{rangeFrom}</b> and <b>{rangeTo}</b>. Switch to <i>Available by range end</i> to also include units that are already empty.</>
    : null;

  const columns = [
    {
      title: 'Status',
      key: 'status',
      width: 150,
      render: (_, r) => {
        if (r.source === 'manual') {
          const override = r.override_id ? overrideById.get(String(r.override_id)) : null;
          const offered = override
            ? !!(override.advertising_enabled || override.inquiry_enabled)
            : !!(r.advertising_enabled || r.inquiry_enabled);
          const manualTag = (
            <Tag color="purple" style={{ fontWeight: 600 }}>Manual</Tag>
          );
          return (
            <Space direction="vertical" size={4}>
              <div>{r.reason ? <Tooltip title={r.reason}>{manualTag}</Tooltip> : manualTag}</div>
              <div>{offered ? <Tag color="green">Offered</Tag> : <Tag>Not offered yet</Tag>}</div>
              {r.lease_changed && (
                <Tooltip title="The lease for this unit changed after this was added, so it is no longer being offered. Check it still applies.">
                  <Tag color="red">Lease changed — review</Tag>
                </Tooltip>
              )}
            </Space>
          );
        }
        if (r.status === 'vacant') {
          if (r.days_vacant == null) {
            return <Tag color="volcano">Vacant · never leased</Tag>;
          }
          return <Tag color="red" style={{ fontWeight: 600 }}>Vacant {r.days_vacant}d</Tag>;
        }
        const expiring = <Tag color={daysColor(r.days_left)} style={{ fontWeight: 600 }}>Expiring · {r.days_left}d</Tag>;
        const ask = r.lease_id ? askByLease.get(String(r.lease_id)) : null;
        const askTag = ask ? <RenewalAskTag ask={ask} /> : null;
        // The tenant told us they are staying, so this is off the market for customers
        // already — but the lease still has to be extended, and this page is where that
        // job lives. Deliberately louder than the row it replaces.
        if (Number(r.renewal_reply) === 1) {
          return (
            <Space direction="vertical" size={4}>
              <div>{expiring}</div>
              <Tooltip title="The tenant chose Extend. Not offered to customers. Extend the lease to clear this.">
                <Tag color="gold" style={{ fontWeight: 600 }}>Extend · paperwork due</Tag>
              </Tooltip>
            </Space>
          );
        }
        if (askTag) {
          return (
            <Space direction="vertical" size={4}>
              <div>{expiring}</div>
              {askTag}
              <RenewalReplyControls ask={ask} onRecord={recordRenewalReply} busy={recordingReply} />
            </Space>
          );
        }
        return expiring;
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
        if (r.source === 'manual') {
          const override = r.override_id ? overrideById.get(String(r.override_id)) : null;
          const availableFrom = override?.available_from || (r.end_date ? dayjs(r.end_date).add(1, 'day').format('YYYY-MM-DD') : null);
          const expiresOn = override?.expires_on || r.expires_on;
          const expiresIn = expiresOn ? dayjs(expiresOn).startOf('day').diff(dayjs().startOf('day'), 'day') : null;
          return (
            <div>
              {availableFrom ? `Available from ${availableFrom}` : <Text type="secondary">—</Text>}
              {expiresOn && (
                <div>
                  <Text type="secondary" style={{ fontSize: 12 }}>Expires {expiresOn}</Text>
                  {expiresIn === 0 && <Tag color="red" style={{ marginLeft: 6 }}>Expires today</Tag>}
                  {expiresIn > 0 && expiresIn <= 2 && <Tag color="orange" style={{ marginLeft: 6 }}>Expires soon</Tag>}
                </div>
              )}
            </div>
          );
        }
        const money = (n) => `HK$${Number(n).toLocaleString()}`;
        if (r.status === 'vacant') {
          return (
            <div>
              {r.vacant_since
                ? <Tooltip title="Vacant since"><Text type="secondary">since {r.vacant_since}</Text></Tooltip>
                : <Text type="secondary">—</Text>}
              {r.rent != null && (
                <div><Text type="secondary" style={{ fontSize: 12 }}>Last rent {money(r.rent)}</Text></div>
              )}
            </div>
          );
        }
        // current_rent is the lease the unit is on TODAY. On a back-to-back row the
        // row itself is the next tenant's lease, so its rent is shown separately.
        const currentRent = r.current_rent != null ? r.current_rent : r.rent;
        const nextDiffers = r.current_lease_is_row === false && r.rent != null && r.rent !== currentRent;
        // A lease with no invoicing schedule stores the whole stay as one figure
        // (FLT 1F: HK$25,376.61 for Sep-Dec), so calling it monthly rent would lie.
        const wholeStay = r.current_lease_is_row !== false && (r.invoicing == null || String(r.invoicing).trim() === '');
        return (
          <div>
            {r.end_date || '—'}
            {currentRent != null && (
              <div>
                <Text type="secondary" style={{ fontSize: 12 }}>{wholeStay ? 'Lease total' : 'Current rent'} {money(currentRent)}</Text>
                {nextDiffers && (
                  <div><Text type="secondary" style={{ fontSize: 12 }}>Next lease {money(r.rent)}</Text></div>
                )}
              </div>
            )}
          </div>
        );
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
      title: 'Posting Rent',
      dataIndex: 'posting_rent',
      key: 'posting_rent',
      width: 140,
      align: 'right',
      // Same figure the Scheduler posts: the unit's asking range, top while the
      // flat is still let, mid once it is empty. Without a range the post uses the
      // lease rent, shown greyed so the missing range is noticed.
      render: (v, r) => {
        if (v == null) return '—';
        const label = `HK$${Number(v).toLocaleString()}`;
        if (!r.posting_tier) {
          return <Tooltip title="No asking rent range on this unit — the post uses the lease rent"><Text type="secondary">{label}</Text></Tooltip>;
        }
        return (
          <span>
            {label} <Tag color={r.posting_tier === 'mid' ? 'blue' : 'green'} style={{ marginRight: 0 }}>{r.posting_tier}</Tag>
          </span>
        );
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
    {
      title: '',
      key: 'actions',
      width: 110,
      render: (_, r) => {
        if (r.source !== 'manual') return null;
        return (
          <Space size="small">
            <a onClick={() => openOverrideModal(r)}>Edit</a>
            <Popconfirm title="Stop showing this unit as possibly available?" onConfirm={() => clearOverride(r.override_id)} okText="Clear">
              <a>Clear</a>
            </Popconfirm>
          </Space>
        );
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
            within <Tag color="blue">{leadDays}d</Tag>), and <Tag color="purple">Manual</Tag> (created from a
            lease via Request Exit, managed here, and expires on its own). The <b>Next Move-In</b> columns show a booked
            incoming tenant. Defaults to <b>Open</b> (not yet filled) — switch <i>Upcoming booking</i> to see
            booked units.
          </Text>
          {activeRangeText && (
            <div style={{ marginTop: 8 }}>
              <Text style={{ color: '#1677ff' }}>{activeRangeText}</Text>
            </div>
          )}
        </div>

        {offPageAsks.length > 0 && (
          <Card
            size="small"
            style={{ marginBottom: 16, borderColor: '#ffe58f', background: '#fffbe6' }}
            title={`${offPageAsks.length} renewal ${offPageAsks.length === 1 ? 'ask' : 'asks'} in flight on leases not listed below`}
          >
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
              These leases end further out than this page shows, or the unit has already been re-let —
              so they would otherwise be invisible while we are messaging the tenant.
            </Text>
            <Space direction="vertical" size={4} style={{ width: '100%' }}>
              {offPageAsks.map(a => (
                <div key={a.lease_id}>
                  <b>{a.label}</b>{a.tenant_name ? ` · ${a.tenant_name}` : ''} — lease ends {a.lease_end}{' '}
                  <RenewalAskTag ask={a} />
                  <div style={{ marginTop: 2 }}>
                    <RenewalReplyControls ask={a} onRecord={recordRenewalReply} busy={recordingReply} />
                  </div>
                </div>
              ))}
            </Space>
          </Card>
        )}

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
                { value: 'manual', label: `Manual (${counts.manual})` },
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
            <RangePicker
              allowClear
              format="YYYY-MM-DD"
              value={openingRange}
              onChange={handleOpeningRangeChange}
              presets={[
                { label: 'This month', value: [dayjs(todayForOpenDates).startOf('month'), dayjs(todayForOpenDates).endOf('month')] },
                { label: 'Next month', value: [dayjs(todayForOpenDates).add(1, 'month').startOf('month'), dayjs(todayForOpenDates).add(1, 'month').endOf('month')] },
                { label: 'Next 3 months', value: [dayjs(todayForOpenDates), dayjs(todayForOpenDates).add(3, 'month').endOf('month')] },
              ]}
              placeholder={['Opening from', 'to']}
              // Past the server's cap the window is clamped, so a further-out range
              // would come back quietly half-answered. Better to not offer the date.
              disabledDate={(d) => d && d.isAfter(dayjs(todayForOpenDates).add(maxLeadDays, 'day'), 'day')}
            />
            <Select
              value={openingMode}
              onChange={setOpeningMode}
              disabled={!hasOpeningRange}
              style={{ width: 210 }}
              options={[
                { value: 'opens', label: 'Opens in range' },
                { value: 'by', label: 'Available by range end' },
              ]}
            />
            <a onClick={() => load(openingRange)}><ReloadOutlined /> Refresh</a>
            <Text type="secondary">
              {filtered.length} unit{filtered.length === 1 ? '' : 's'}
              {hasOpeningRange ? ` · ${outsideDateCount} outside the dates` : ''}
              {' '}({counts.vacant} vacant · {counts.expiring} expiring · {counts.manual} manual)
            </Text>
          </Space>

          <Table
            rowKey={(r) => r.lease_id || `unit-${r.unit_id}`}
            columns={columns}
            dataSource={filtered}
            loading={loading}
            pagination={{
              // Keep this controlled; antd otherwise reverts page size on filter re-render.
              pageSize,
              showSizeChanger: true,
              pageSizeOptions: ['20', '50', '100'],
              showTotal: (total, range) => `${range[0]}-${range[1]} of ${total}`,
              onChange: (_page, size) => { if (size !== pageSize) setPageSize(size); },
              onShowSizeChange: (_page, size) => setPageSize(size),
            }}
            size="middle"
            scroll={{ x: 'max-content' }}
          />
        </Card>

        <Modal
          title="Edit early exit request"
          open={!!overrideModal}
          onCancel={() => setOverrideModal(null)}
          onOk={saveOverride}
          confirmLoading={savingOverride}
          okText="Save"
        >
          <Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
            For a tenant who says they might leave early. This does not change the lease, invoices or the calendar — it only affects what we offer people and what you see here.
          </Text>
          <Form form={overrideForm} layout="vertical">
            <Form.Item name="available_from" label="Available from" rules={[{ required: true, message: 'Available from is required' }]}>
              <DatePicker style={{ width: '100%' }} format="YYYY-MM-DD" />
            </Form.Item>
            <Form.Item
              name="expires_on"
              label="Stop showing after"
              dependencies={['available_from']}
              rules={[
                { required: true, message: 'Stop showing after is required' },
                ({ getFieldValue }) => ({
                  validator(_, value) {
                    const availableFrom = getFieldValue('available_from');
                    if (!value || !availableFrom || !dayjs(value).isBefore(dayjs(availableFrom), 'day')) {
                      return Promise.resolve();
                    }
                    return Promise.reject(new Error('Stop showing after must be on or after Available from'));
                  },
                }),
              ]}
            >
              <DatePicker style={{ width: '100%' }} format="YYYY-MM-DD" />
            </Form.Item>
            <Form.Item name="reason" label="Reason" extra="Staff only — never shown to customers.">
              <Input maxLength={255} />
            </Form.Item>
            <Form.Item
              name="offered"
              valuePropName="checked"
              extra="Untick to just note it for now — it stays on this page but is not offered to anyone."
            >
              <Checkbox>Offer to advertising and inquiries</Checkbox>
            </Form.Item>
          </Form>
        </Modal>
      </div>
    </MainLayout>
  );
}
