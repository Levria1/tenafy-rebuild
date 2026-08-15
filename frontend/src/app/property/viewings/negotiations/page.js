'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Card, Table, Tag, Space, Button, Input, Select, Typography, message,
  Drawer, Segmented, InputNumber, TimePicker, Checkbox, Empty, Popconfirm, Switch, Alert,
} from 'antd';
import {
  ReloadOutlined, SearchOutlined, SettingOutlined, SendOutlined,
  CheckOutlined, StopOutlined, CommentOutlined, PlayCircleOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import MainLayout from '../../../../components/Layout';
import { viewingApi } from '../../../../lib/api';

const { Text, Title } = Typography;

// state → { label, color }
const STATE_META = {
  RESOLVE_UNIT: { label: 'Identifying unit', color: 'cyan' },
  CONFIRM_UNIT: { label: 'Confirming unit', color: 'cyan' },
  ASK_PROSPECT_DAY: { label: 'Asking prospect', color: 'blue' },
  CHECK_STAFF: { label: 'Checking calendar', color: 'geekblue' },
  AWAIT_TENANT: { label: 'Awaiting tenant', color: 'orange' },
  ASK_TENANT_ALT: { label: 'Asking tenant', color: 'orange' },
  RELAY_TO_PROSPECT: { label: 'Relaying to prospect', color: 'purple' },
  CONFIRM_TIME: { label: 'Confirming time', color: 'geekblue' },
  CONFIRMED: { label: 'Confirmed', color: 'green' },
  // Booked because the occupant stayed silent past the internal response window.
  // Distinguished from CONFIRMED on purpose: nobody explicitly agreed, so
  // it is the one confirmed state that can still be reversed by the tenant.
  AUTO_CONFIRMED: { label: 'Auto-confirmed', color: 'green' },
  TENANT_CANCELS_AFTER_X: { label: 'Tenant reversed', color: 'red' },
  RESCHEDULE_AFTER_COMMIT: { label: 'Reschedule needed', color: 'volcano' },
  NEEDS_STAFF: { label: 'Needs staff', color: 'red' },
  CANCELLED: { label: 'Cancelled', color: 'default' },
};
const AWAITING_META = {
  prospect: { label: 'Waiting on prospect', color: 'blue' },
  tenant: { label: 'Waiting on tenant', color: 'orange' },
  staff: { label: 'Waiting on staff', color: 'red' },
};
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function stateTag(s) {
  const m = STATE_META[s] || { label: s, color: 'default' };
  return <Tag color={m.color}>{m.label}</Tag>;
}
function fmt(dt) {
  return dt ? dayjs(dt).format('ddd, MMM D, h:mm A') : '';
}

export default function ViewingNegotiationsPage() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [stateFilter, setStateFilter] = useState('');
  const [awaitingFilter, setAwaitingFilter] = useState('');
  const [draftsOnly, setDraftsOnly] = useState(false);

  // Detail drawer
  const [detailOpen, setDetailOpen] = useState(false);
  const [detail, setDetail] = useState(null); // { negotiation, events }
  const [detailLoading, setDetailLoading] = useState(false);
  const [msgParty, setMsgParty] = useState('prospect');
  const [msgText, setMsgText] = useState('');
  const [sending, setSending] = useState(false);

  // Setup drawer (relay settings + roster)
  const [setupOpen, setSetupOpen] = useState(false);

  const reload = useCallback(() => {
    setLoading(true);
    const params = {};
    if (stateFilter) params.state = stateFilter;
    if (awaitingFilter) params.awaiting = awaitingFilter;
    if (draftsOnly) params.has_draft = 1;
    if (search.trim()) params.q = search.trim();
    viewingApi.listNegotiations(params)
      .then((r) => setRows(r.data.data || []))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [stateFilter, awaitingFilter, draftsOnly, search]);

  useEffect(() => { reload(); }, [reload]);

  const openDetail = useCallback((id) => {
    setDetailOpen(true);
    setDetailLoading(true);
    setDetail(null);
    viewingApi.getNegotiation(id)
      .then((r) => setDetail(r.data.data))
      .catch(() => message.error('Failed to load negotiation'))
      .finally(() => setDetailLoading(false));
  }, []);

  const refreshDetail = useCallback(() => {
    if (detail?.negotiation?.id) openDetail(detail.negotiation.id);
    reload();
  }, [detail, openDetail, reload]);

  const approveMsg = async (eventId) => {
    try {
      await viewingApi.approveNegotiationMessage(detail.negotiation.id, eventId);
      message.success('Message sent');
      refreshDetail();
    } catch (e) {
      message.error(e?.response?.data?.message || 'Failed to send');
    }
  };

  const sendStaffMsg = async () => {
    if (!msgText.trim()) return;
    setSending(true);
    try {
      const r = await viewingApi.sendNegotiationMessage(detail.negotiation.id, msgParty, msgText.trim());
      if (r.data.data?.status === 'sent') message.success('Sent');
      else message.warning('Queued (WhatsApp not configured for this recipient)');
      setMsgText('');
      refreshDetail();
    } catch (e) {
      message.error(e?.response?.data?.message || 'Failed to send');
    } finally {
      setSending(false);
    }
  };

  const cancelNeg = async () => {
    try {
      await viewingApi.cancelNegotiation(detail.negotiation.id);
      message.success('Cancelled');
      refreshDetail();
    } catch (e) {
      message.error('Failed to cancel');
    }
  };

  const proceedNeg = async () => {
    try {
      const r = await viewingApi.proceedNegotiation(detail.negotiation.id);
      message.success(r.data.data?.events?.[0]?.status === 'sent' ? 'Viewing started — prospect asked for a day' : 'Viewing started (message queued for approval)');
      refreshDetail();
    } catch (e) {
      message.error(e?.response?.data?.message || 'Failed to start viewing');
    }
  };

  const columns = [
    {
      title: 'Prospect', dataIndex: 'prospect_name', key: 'prospect',
      render: (v, r) => (
        <Space direction="vertical" size={0}>
          <Text strong>{v || 'Prospect'}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>{r.prospect_phone || ''}</Text>
        </Space>
      ),
    },
    {
      title: 'Unit', key: 'unit',
      render: (_, r) => (
        r.unit_name ? (
          <Space direction="vertical" size={0}>
            <Text>{r.unit_name}</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>{r.property_name}</Text>
          </Space>
        ) : (
          <Text type="secondary" italic>“{r.pending_unit_text || '…'}” <Text type="secondary" style={{ fontSize: 11 }}>(identifying)</Text></Text>
        )
      ),
    },
    { title: 'Status', dataIndex: 'state', key: 'state', render: (s) => stateTag(s) },
    {
      // In manual relay mode every outbound is a draft, and the hourly cron creates
      // them on its own (nudges, booking-confirmed, reversal notices). Without a
      // column you had to open each row's drawer to discover a message was waiting.
      title: 'To send', dataIndex: 'pending_draft_count', key: 'drafts', align: 'center', width: 90,
      render: (n) => (Number(n) > 0
        ? <Tag color="gold">{n} waiting</Tag>
        : <Text type="secondary">—</Text>),
    },
    {
      title: 'Waiting on', dataIndex: 'awaiting', key: 'awaiting',
      render: (a) => a && AWAITING_META[a] ? <Tag color={AWAITING_META[a].color}>{AWAITING_META[a].label}</Tag> : '-',
    },
    {
      title: 'Proposed', dataIndex: 'current_proposed_datetime', key: 'proposed',
      render: (v) => v ? <Text>{fmt(v)}</Text> : <Text type="secondary">—</Text>,
    },
    { title: 'Rounds', dataIndex: 'round_count', key: 'rounds', align: 'center', width: 80 },
    {
      title: 'Updated', dataIndex: 'updated_at', key: 'updated',
      render: (v) => <Text type="secondary" style={{ fontSize: 12 }}>{dayjs(v).format('MMM D, h:mm A')}</Text>,
    },
  ];

  return (
    <MainLayout>
      <div style={{ padding: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div>
            <Title level={3} style={{ margin: 0 }}>Viewing Requests</Title>
            <Text type="secondary">Live viewing negotiations relayed between prospects and tenants over WhatsApp.</Text>
          </div>
          <Space>
            <Button icon={<SettingOutlined />} onClick={() => setSetupOpen(true)}>Setup</Button>
            <Button icon={<ReloadOutlined />} onClick={reload}>Refresh</Button>
          </Space>
        </div>

        <Card size="small" style={{ marginBottom: 16 }}>
          <Space wrap>
            <Input
              allowClear prefix={<SearchOutlined />} placeholder="Search prospect / unit / property"
              value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 260 }}
            />
            <Select
              allowClear placeholder="All statuses" style={{ width: 190 }}
              value={stateFilter || undefined} onChange={(v) => setStateFilter(v || '')}
              options={Object.entries(STATE_META).map(([k, v]) => ({ value: k, label: v.label }))}
            />
            <Select
              allowClear placeholder="Waiting on anyone" style={{ width: 190 }}
              value={awaitingFilter || undefined} onChange={(v) => setAwaitingFilter(v || '')}
              options={Object.entries(AWAITING_META).map(([k, v]) => ({ value: k, label: v.label }))}
            />
            <Space size={6}>
              <Switch checked={draftsOnly} onChange={setDraftsOnly} />
              <Text>Only ones with a message to send</Text>
            </Space>
          </Space>
        </Card>

        <Card size="small">
          <Table
            rowKey="id" size="middle" loading={loading} columns={columns} dataSource={rows}
            pagination={{ pageSize: 20, showSizeChanger: false }}
            onRow={(r) => ({ onClick: () => openDetail(r.id), style: { cursor: 'pointer' } })}
            locale={{ emptyText: <Empty description="No viewing requests yet" /> }}
          />
        </Card>
      </div>

      <NegotiationDrawer
        open={detailOpen} onClose={() => setDetailOpen(false)}
        detail={detail} loading={detailLoading}
        onApprove={approveMsg} onCancel={cancelNeg} onProceed={proceedNeg}
        msgParty={msgParty} setMsgParty={setMsgParty}
        msgText={msgText} setMsgText={setMsgText} sending={sending} onSend={sendStaffMsg}
      />

      <SetupDrawer open={setupOpen} onClose={() => setSetupOpen(false)} />
    </MainLayout>
  );
}

// ── Detail drawer: event log + approve drafts + staff message + cancel ────────
function NegotiationDrawer({
  open, onClose, detail, loading, onApprove, onCancel, onProceed,
  msgParty, setMsgParty, msgText, setMsgText, sending, onSend,
}) {
  const neg = detail?.negotiation;
  const events = detail?.events || [];
  // AUTO_CONFIRMED counts as closed — it has a booking. TENANT_CANCELS_AFTER_X and
  // RESCHEDULE_AFTER_COMMIT deliberately do NOT: the booking has been pulled and
  // staff still have to resolve them, so the action buttons must stay available.
  const closed = neg && ['CONFIRMED', 'AUTO_CONFIRMED', 'CANCELLED'].includes(neg.state);
  const offWindow = neg && neg.state === 'NEEDS_STAFF' && neg.needs_staff_reason === 'off_window';
  const multiUnit = neg && neg.state === 'NEEDS_STAFF' && neg.needs_staff_reason === 'multi_unit';

  return (
    <Drawer
      title={neg ? `${neg.prospect_name || 'Prospect'} — ${neg.unit_name || neg.pending_unit_text || 'identifying unit'}` : 'Viewing request'}
      width={560} open={open} onClose={onClose}
      extra={neg && !closed ? (
        <Popconfirm title="Cancel this viewing request?" onConfirm={onCancel} okText="Cancel it" cancelText="No">
          <Button danger size="small" icon={<StopOutlined />}>Cancel request</Button>
        </Popconfirm>
      ) : null}
    >
      {loading || !neg ? <Text type="secondary">Loading…</Text> : (
        <>
          <Space wrap style={{ marginBottom: 12 }}>
            {stateTag(neg.state)}
            {neg.awaiting && AWAITING_META[neg.awaiting] &&
              <Tag color={AWAITING_META[neg.awaiting].color}>{AWAITING_META[neg.awaiting].label}</Tag>}
            <Tag>Round {neg.round_count}</Tag>
            {!neg.has_tenant && <Tag color="gold">Vacant (host)</Tag>}
          </Space>

          {offWindow && (
            <Alert
              type="warning" showIcon style={{ marginBottom: 12 }}
              message="Held — outside the tenant-contact window"
              description="This unit's current lease doesn't end soon enough to contact the tenant yet. Start the viewing anyway to ask the prospect for a day and reach out to the tenant now."
              action={
                <Button type="primary" size="small" icon={<PlayCircleOutlined />} onClick={onProceed}>
                  Start viewing anyway
                </Button>
              }
            />
          )}
          {multiUnit && (
            <Alert
              type="info" showIcon style={{ marginBottom: 12 }}
              message="Held — prospect asked for more than one unit"
              description={`Their message${neg.pending_unit_text ? ` (“${neg.pending_unit_text}”)` : ''} named multiple units. Multi-unit viewings aren't auto-arranged yet — reply manually to sort out which unit(s) and when.`}
            />
          )}
          <div style={{ marginBottom: 8 }}>
            {neg.unit_id
              ? (<><Text type="secondary">Property: </Text><Text>{neg.property_name}</Text><br /></>)
              : (neg.pending_unit_text && (<><Text type="secondary">Identifying: </Text><Text>“{neg.pending_unit_text}”</Text><br /></>))}
            {neg.current_proposed_datetime && (<><Text type="secondary">Proposed: </Text><Text>{fmt(neg.current_proposed_datetime)}</Text></>)}
          </div>

          <Title level={5} style={{ marginTop: 16 }}><CommentOutlined /> Conversation</Title>
          <div style={{ maxHeight: 360, overflowY: 'auto', border: '1px solid #f0f0f0', borderRadius: 6, padding: 12 }}>
            {events.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No messages yet" /> :
              events.map((e) => <EventBubble key={e.id} e={e} onApprove={onApprove} />)}
          </div>

          {!closed && (
            <div style={{ marginTop: 16 }}>
              <Text strong>Send a message (staff takeover)</Text>
              <Space.Compact style={{ display: 'flex', marginTop: 8 }}>
                <Select value={msgParty} onChange={setMsgParty} style={{ width: 130 }}
                  options={[{ value: 'prospect', label: 'To prospect' }, { value: 'tenant', label: 'To tenant' }]} />
                <Input
                  placeholder="Type a message…" value={msgText}
                  onChange={(e) => setMsgText(e.target.value)} onPressEnter={onSend}
                />
                <Button type="primary" icon={<SendOutlined />} loading={sending} onClick={onSend}>Send</Button>
              </Space.Compact>
            </div>
          )}
        </>
      )}
    </Drawer>
  );
}

function EventBubble({ e, onApprove }) {
  const inbound = e.direction === 'in';
  const isDraft = e.status === 'draft';
  const who = e.party === 'prospect' ? 'Prospect' : e.party === 'tenant' ? 'Tenant' : e.party === 'staff' ? 'Staff' : 'System';
  const align = inbound ? 'flex-start' : 'flex-end';
  const bg = inbound ? '#f5f5f5' : (isDraft ? '#fffbe6' : '#e6f4ff');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: align, marginBottom: 10 }}>
      <div style={{ maxWidth: '85%', background: bg, borderRadius: 8, padding: '8px 12px', border: isDraft ? '1px solid #ffe58f' : 'none' }}>
        <Text type="secondary" style={{ fontSize: 11 }}>
          {inbound ? `${who} →` : `→ ${who}`} · {dayjs(e.created_at).format('MMM D, h:mm A')}
          {isDraft && <Tag color="warning" style={{ marginLeft: 6 }}>Draft</Tag>}
        </Text>
        <div style={{ whiteSpace: 'pre-wrap', marginTop: 2 }}>{e.body}</div>
        {isDraft && (
          <Button type="primary" size="small" icon={<CheckOutlined />} style={{ marginTop: 6 }}
            onClick={() => onApprove(e.id)}>Approve &amp; Send</Button>
        )}
      </div>
    </div>
  );
}

// ── Setup drawer: relay settings + property × weekday roster ───────────────────
function SetupDrawer({ open, onClose }) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [settings, setSettings] = useState(null);
  const [roster, setRoster] = useState({ entries: [], properties: [], staff: [] });
  // grid[property_id][weekday] = employee_id
  const [grid, setGrid] = useState({});

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      viewingApi.getViewingSettings().catch(() => ({ data: { data: null } })),
      viewingApi.getRoster().catch(() => ({ data: { data: { entries: [], properties: [], staff: [] } } })),
    ]).then(([s, r]) => {
      // Deliberately NO hardcoded fallback defaults here. GET /settings always
      // returns a full object (the backend substitutes its own defaults when the org
      // has no viewing_setting row yet), so a null means the request FAILED. Inventing
      // values here would show plausible settings that aren't the org's, and saving
      // would then write those invented values over the real ones. Leave it null so the
      // drawer says so and Save stays disabled.
      setSettings(s.data.data || null);
      const rd = r.data.data || { entries: [], properties: [], staff: [] };
      setRoster(rd);
      const g = {};
      (rd.entries || []).forEach((e) => {
        g[e.property_id] = g[e.property_id] || {};
        g[e.property_id][e.weekday] = e.employee_id;
      });
      setGrid(g);
    }).finally(() => setLoading(false));
  }, []);

  useEffect(() => { if (open) load(); }, [open, load]);

  const setCell = (propId, weekday, empId) => {
    setGrid((prev) => {
      const next = { ...prev, [propId]: { ...(prev[propId] || {}) } };
      if (empId) next[propId][weekday] = empId; else delete next[propId][weekday];
      return next;
    });
  };

  const daysArr = (settings?.viewing_days || '1,2,3,4,5,6').split(',').map((n) => Number(n)).filter((n) => !isNaN(n));

  const save = async () => {
    setSaving(true);
    try {
      await viewingApi.updateViewingSettings({
        relay_mode: settings.relay_mode,
        max_rounds: settings.max_rounds,
        read_back: settings.read_back ? 1 : 0,
        viewing_days: settings.viewing_days,
        viewing_start: settings.viewing_start,
        viewing_end: settings.viewing_end,
        lead_days_nr: settings.lead_days_nr,
        lead_days_other: settings.lead_days_other,
        customer_nudge_1_hours: settings.customer_nudge_1_hours,
        customer_nudge_2_hours: settings.customer_nudge_2_hours,
        customer_nudge_cap: settings.customer_nudge_cap,
        customer_timeout_hours: settings.customer_timeout_hours,
        tenant_opt_out_hours: settings.tenant_opt_out_hours,
        tenant_explicit_timeout_hours: settings.tenant_explicit_timeout_hours,
        tenant_nudge_cap: settings.tenant_nudge_cap,
        auto_send_nudges: settings.auto_send_nudges ? 1 : 0,
        respect_quiet_hours: settings.respect_quiet_hours ? 1 : 0,
      });
      const entries = [];
      Object.entries(grid).forEach(([propId, days]) => {
        Object.entries(days).forEach(([wd, empId]) => {
          if (empId) entries.push({ property_id: propId, weekday: Number(wd), employee_id: empId });
        });
      });
      await viewingApi.updateRoster(entries);
      message.success('Saved');
      onClose();
    } catch (e) {
      message.error(e?.response?.data?.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      title="Viewing Relay Setup" width={720} open={open} onClose={onClose}
      extra={<Button type="primary" loading={saving} onClick={save} disabled={!settings}>Save</Button>}
    >
      {loading ? <Text type="secondary">Loading…</Text> : !settings ? (
        <Space direction="vertical">
          <Text type="danger">Couldn&apos;t load the current settings.</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            Saving is disabled until they load, so a failed read can&apos;t overwrite your real settings.
          </Text>
          <Button onClick={load}>Retry</Button>
        </Space>
      ) : (
        <>
          <Title level={5}>Relay mode</Title>
          <Segmented
            value={settings.relay_mode}
            onChange={(v) => setSettings({ ...settings, relay_mode: v })}
            options={[
              { label: 'Staff approves each message', value: 'manual' },
              { label: 'Fully automatic', value: 'auto' },
            ]}
          />
          <div style={{ marginTop: 6 }}>
            <Text type="secondary">
              {settings.relay_mode === 'manual'
                ? 'Every outbound message waits for your approval on this dashboard before it is sent.'
                : 'The bot sends every message immediately. You can still watch and step in here.'}
            </Text>
          </div>

          <Title level={5} style={{ marginTop: 20 }}>Rules</Title>
          <div style={{ marginBottom: 12 }}>
            <Space>
              <Switch checked={!!settings.read_back}
                onChange={(v) => setSettings({ ...settings, read_back: v ? 1 : 0 })} />
              <Text>Read-back confirmation</Text>
            </Space>
            <div><Text type="secondary" style={{ fontSize: 12 }}>
              When someone proposes a time, echo it back (“view %Unit% on %Time%? reply YES”) and wait for
              confirmation before checking the calendar / messaging the other party. Catches mis-parsed times.
            </Text></div>
          </div>
          <Space size="large" wrap>
            <div>
              <div><Text type="secondary">Escalate to staff after</Text></div>
              <InputNumber min={1} max={10} value={settings.max_rounds}
                onChange={(v) => setSettings({ ...settings, max_rounds: v })} addonAfter="counter-offers" />
            </div>
            <div>
              <div><Text type="secondary">Viewing hours</Text></div>
              <Space>
                <TimePicker
                  format="HH:mm" minuteStep={15} allowClear={false}
                  value={dayjs(settings.viewing_start, 'HH:mm:ss')}
                  onChange={(t) => setSettings({ ...settings, viewing_start: t.format('HH:mm:00') })}
                />
                <span>to</span>
                <TimePicker
                  format="HH:mm" minuteStep={15} allowClear={false}
                  value={dayjs(settings.viewing_end, 'HH:mm:ss')}
                  onChange={(t) => setSettings({ ...settings, viewing_end: t.format('HH:mm:00') })}
                />
              </Space>
            </div>
          </Space>
          <div style={{ marginTop: 12 }}>
            <div><Text type="secondary">Viewing days</Text></div>
            <Checkbox.Group
              value={daysArr}
              onChange={(vals) => setSettings({ ...settings, viewing_days: [...vals].sort((a, b) => a - b).join(',') })}
              options={WEEKDAYS.map((d, i) => ({ label: d, value: i }))}
            />
          </div>

          <Title level={5} style={{ marginTop: 20 }}>Contact the tenant only within</Title>
          <Text type="secondary" style={{ fontSize: 12 }}>
            Every unit is viewable, but we only message the current tenant when their lease is ending soon.
            A request that arrives earlier is held for staff (“Start viewing anyway” on the request).
          </Text>
          <Space size="large" wrap style={{ marginTop: 8 }}>
            <div>
              <div><Text type="secondary">Not Renewing leases</Text></div>
              <InputNumber min={1} max={365} value={settings.lead_days_nr}
                onChange={(v) => setSettings({ ...settings, lead_days_nr: v })} addonAfter="days before end" />
            </div>
            <div>
              <div><Text type="secondary">All other statuses</Text></div>
              <InputNumber min={1} max={365} value={settings.lead_days_other}
                onChange={(v) => setSettings({ ...settings, lead_days_other: v })} addonAfter="days before end" />
            </div>
          </Space>

          <Title level={5} style={{ marginTop: 20 }}>Chasing a quiet viewer</Title>
          <Text type="secondary" style={{ fontSize: 12 }}>
            After we ask the viewer to confirm a time, nudge them on this schedule. Once the escalation
            time is reached the request is handed to staff and nudging stops — so the second nudge must
            be sooner than that, or it can never be sent.
          </Text>
          <Space size="large" wrap style={{ marginTop: 8 }}>
            <div>
              <div><Text type="secondary">First nudge</Text></div>
              <InputNumber min={1} max={168} value={settings.customer_nudge_1_hours}
                onChange={(v) => setSettings({ ...settings, customer_nudge_1_hours: v })} addonAfter="hours" />
            </div>
            <div>
              <div><Text type="secondary">Second nudge</Text></div>
              <InputNumber min={1} max={168} value={settings.customer_nudge_2_hours}
                onChange={(v) => setSettings({ ...settings, customer_nudge_2_hours: v })} addonAfter="hours" />
            </div>
            <div>
              <div><Text type="secondary">Max nudges</Text></div>
              <InputNumber min={0} max={5} value={settings.customer_nudge_cap}
                onChange={(v) => setSettings({ ...settings, customer_nudge_cap: v })} />
            </div>
            <div>
              <div><Text type="secondary">Hand to staff after</Text></div>
              <InputNumber min={1} max={336} value={settings.customer_timeout_hours}
                onChange={(v) => setSettings({ ...settings, customer_timeout_hours: v })} addonAfter="hours" />
            </div>
          </Space>
          {settings.customer_nudge_2_hours >= settings.customer_timeout_hours ? (
            <div style={{ marginTop: 6 }}>
              <Text type="danger" style={{ fontSize: 12 }}>
                The second nudge ({settings.customer_nudge_2_hours}h) is not before the escalation
                ({settings.customer_timeout_hours}h), so it would never be sent.
              </Text>
            </div>
          ) : null}

          <Title level={5} style={{ marginTop: 20 }}>Asking the current tenant</Title>
          <Text type="secondary" style={{ fontSize: 12 }}>
            Once the viewer confirms, we notify the occupant. If they say nothing during the response
            window, the viewing is confirmed automatically. Per-tenant overrides (a longer
            window, or requiring an explicit yes) take priority over these.
          </Text>
          <Space size="large" wrap style={{ marginTop: 8 }}>
            <div>
              <div><Text type="secondary">Tenant response window</Text></div>
              <InputNumber min={1} max={48} value={settings.tenant_opt_out_hours}
                onChange={(v) => setSettings({ ...settings, tenant_opt_out_hours: v })} addonAfter="hours" />
            </div>
            <div>
              <div><Text type="secondary">If an explicit yes is required, give up after</Text></div>
              <InputNumber min={1} max={336} value={settings.tenant_explicit_timeout_hours}
                onChange={(v) => setSettings({ ...settings, tenant_explicit_timeout_hours: v })} addonAfter="hours" />
            </div>
            <div>
              <div><Text type="secondary">Max tenant nudges</Text></div>
              <InputNumber min={0} max={5} value={settings.tenant_nudge_cap}
                onChange={(v) => setSettings({ ...settings, tenant_nudge_cap: v })} />
            </div>
          </Space>
          <div style={{ marginTop: 6 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              An occupant on the auto-confirm path is never nudged; silence is already a valid
              answer. Nudges only apply when an explicit yes is required.
            </Text>
          </div>

          <Title level={5} style={{ marginTop: 20 }}>Sending nudges without approval</Title>
          <div style={{ marginBottom: 4 }}>
            <Space>
              <Switch checked={!!settings.auto_send_nudges}
                onChange={(v) => setSettings({ ...settings, auto_send_nudges: v ? 1 : 0 })} />
              <Text>Send nudges automatically</Text>
            </Space>
            <div><Text type="secondary" style={{ fontSize: 12 }}>
              Off by default. Nudges only — messages that confirm, change or cancel a viewing always wait
              for your approval, even with this on.
            </Text></div>
          </div>
          <div>
            <Space>
              <Switch checked={!!settings.respect_quiet_hours}
                onChange={(v) => setSettings({ ...settings, respect_quiet_hours: v ? 1 : 0 })} />
              <Text>Hold automatic nudges outside viewing hours</Text>
            </Space>
            <div><Text type="secondary" style={{ fontSize: 12 }}>
              A nudge due at 3am waits until your viewing hours resume instead of waking someone.
            </Text></div>
          </div>

          <Title level={5} style={{ marginTop: 24 }}>Responsible staff (property × day)</Title>
          <Text type="secondary">The person on duty for a property that weekday is whose Google calendar is checked.</Text>
          {roster.properties.length === 0 ? (
            <Empty style={{ marginTop: 16 }} description="No properties" />
          ) : (
            <div style={{ overflowX: 'auto', marginTop: 12 }}>
              <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid #f0f0f0' }}>Property</th>
                    {WEEKDAYS.map((d) => (
                      <th key={d} style={{ padding: '6px 4px', borderBottom: '1px solid #f0f0f0', fontWeight: 500 }}>{d}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {roster.properties.map((p) => (
                    <tr key={p.id}>
                      <td style={{ padding: '4px 8px', borderBottom: '1px solid #fafafa', whiteSpace: 'nowrap' }}>{p.name}</td>
                      {WEEKDAYS.map((d, wd) => (
                        <td key={wd} style={{ padding: '2px 3px', borderBottom: '1px solid #fafafa' }}>
                          <Select
                            allowClear size="small" style={{ width: 110 }} placeholder="—"
                            value={grid[p.id]?.[wd] || undefined}
                            onChange={(v) => setCell(p.id, wd, v || null)}
                            options={roster.staff.map((s) => ({ value: s.id, label: s.name }))}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Drawer>
  );
}
