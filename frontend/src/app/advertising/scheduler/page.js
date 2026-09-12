'use client';

import { useEffect, useState } from 'react';
import dayjs from 'dayjs';
import {
  Table, Card, Typography, Space, Tag, message, Button, Modal, Form,
  Select, Input, Popconfirm, Empty, Tooltip, DatePicker, Alert,
} from 'antd';
import {
  SoundOutlined, ReloadOutlined, ThunderboltOutlined, PlusOutlined, DeleteOutlined,
  EyeOutlined, CopyOutlined,
} from '@ant-design/icons';
import MainLayout from '../../../components/Layout';
import { advertisingApi } from '../../../lib/api';

const { Title, Text } = Typography;
// Mon–Sat first, then Sunday last. Sunday MUST be included: the seeded schedule puts
// slots 16–20 there, and a Mon–Sat-only view would silently hide them.
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

export default function SchedulerPage() {
  const [slots, setSlots] = useState([]);
  const [urgent, setUrgent] = useState([]);
  const [meta, setMeta] = useState({ filled: 0, overflow: 0, slot_count: 20 });
  const [loading, setLoading] = useState(true);
  const [planLoading, setPlanLoading] = useState(true);
  const [planDate, setPlanDate] = useState(dayjs());
  const [plan, setPlan] = useState(null);
  const [grid, setGrid] = useState({ days: [], unscheduled: [] });
  const [week, setWeek] = useState({ days: [], weekly_totals: [] });
  const [violations, setViolations] = useState([]);
  // Per-violation pending choice: { [slot_key]: { forum_id, account_id } }
  const [fixChoice, setFixChoice] = useState({});
  const [applyingKey, setApplyingKey] = useState(null);
  const [properties, setProperties] = useState([]); // for the urgent picker

  // Urgent add modal
  const [addOpen, setAddOpen] = useState(false);
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  // Post preview modal — holds the plan row being previewed, or null.
  const [previewPost, setPreviewPost] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const [res, gridRes, weekRes, violRes] = await Promise.all([
        advertisingApi.getScheduler(),
        advertisingApi.scheduleGrid(),
        advertisingApi.schedule(),
        advertisingApi.scheduleViolations(),
      ]);
      if (gridRes.data.code === 200) setGrid(gridRes.data.data || { days: [], unscheduled: [] });
      if (weekRes.data.code === 200) setWeek(weekRes.data.data || { days: [], weekly_totals: [] });
      if (violRes.data.code === 200) setViolations(violRes.data.data?.violations || []);
      if (res.data.code === 200) {
        const d = res.data.data;
        setSlots(d.slots || []);
        setUrgent(d.urgent || []);
        setMeta({ filled: d.filled || 0, overflow: d.overflow || 0, slot_count: d.slot_count || 20 });
        // Property options for the urgent picker come from the filled slots.
        const props = (d.slots || []).filter(s => s.property_id)
          .map(s => ({ value: s.property_id, label: s.property_name }));
        setProperties(props);
      } else {
        message.error(res.data.message || 'Failed to load scheduler');
      }
    } catch (e) {
      message.error('Failed to load scheduler');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const loadPlan = async (date) => {
    setPlanLoading(true);
    try {
      const res = await advertisingApi.postingPlan(date.format('YYYY-MM-DD'));
      if (res.data.code === 200) setPlan(res.data.data);
      else message.error(res.data.message || 'Failed to load posting plan');
    } catch (e) {
      message.error('Failed to load posting plan');
    } finally {
      setPlanLoading(false);
    }
  };

  useEffect(() => { loadPlan(planDate); }, [planDate]);

  const addUrgent = async () => {
    try {
      const vals = await form.validateFields();
      setSaving(true);
      await advertisingApi.addUrgent(vals);
      message.success('Urgent entry added');
      setAddOpen(false);
      form.resetFields();
      load();
    } catch (e) {
      if (e?.errorFields) return;
      message.error('Failed to add urgent entry');
    } finally {
      setSaving(false);
    }
  };

  // Apply a suggested replacement group/account to every row of a violating slot.
  // A violation spans 2-3 scheduled rows (the repeats); rewriting the surplus ones is
  // what removes the repeat, so leave the FIRST row alone and change the rest.
  const applyFix = async (v) => {
    const choice = fixChoice[v.slot_key];
    if (!choice?.forum_id || !choice?.account_id) {
      message.warning('Pick a replacement group and account first');
      return;
    }
    setApplyingKey(v.slot_key);
    try {
      const surplus = (v.rows || []).slice(1);
      for (const row of surplus) {
        await advertisingApi.updateScheduleRow(row.id, {
          forum_id: choice.forum_id,
          account_id: choice.account_id,
        });
      }
      const target = (v.suggestions || []).find(s => String(s.forum_id) === String(choice.forum_id));
      message.success(`${v.slot_label}: ${surplus.length} posting${surplus.length === 1 ? '' : 's'} moved to ${target?.forum_name || 'the selected group'}`);
      setFixChoice(prev => ({ ...prev, [v.slot_key]: undefined }));
      await Promise.all([load(), loadPlan(planDate)]);
    } catch (e) {
      message.error(e?.response?.data?.message || e.message || 'Failed to apply the change');
    } finally {
      setApplyingKey(null);
    }
  };

  // We ask the top of the range until the unit is actually standing empty, then
  // drop to the midpoint. The tag is not decoration: it is how the operator spots
  // at a glance that a unit has gone vacant and is now being advertised for less.
  // low/discount are retired tiers, kept here so old screenshots still read.
  const TIER_COLOR = { high: 'green', mid: 'blue', low: 'orange', discount: 'red' };
  const TIER_HINT = {
    high: 'Top of range — not vacant yet',
    mid: 'Midpoint — already standing empty',
    low: 'Retired tier (bottom of range)',
    discount: 'Retired tier (10% under bottom of range)',
  };
  const money = (n) => (n == null ? null : `HK$${Number(n).toLocaleString('en-US')}`);

  // One price row per unit: the figure that actually appears in the post.
  const renderPrices = (prices) => {
    if (!prices || prices.length === 0) return <Text type="secondary">—</Text>;
    return (
      <Space direction="vertical" size={2}>
        {prices.map(p => (
          <span key={p.unit_id}>
            {p.posting_rent == null
              ? <Tooltip title="No advertised rent range set on this unit"><Text type="secondary">— no price —</Text></Tooltip>
              : <Text strong style={{ fontVariantNumeric: 'tabular-nums' }}>{money(p.posting_rent)}</Text>}
            {p.posting_tier && (
              <Tooltip title={TIER_HINT[p.posting_tier]}>
                <Tag color={TIER_COLOR[p.posting_tier]} style={{ marginLeft: 6 }}>{p.posting_tier}</Tag>
              </Tooltip>
            )}
          </span>
        ))}
      </Space>
    );
  };

  const slotColumns = [
    {
      title: '#',
      dataIndex: 'position',
      key: 'position',
      width: 60,
      render: (v) => <Text strong>{v}</Text>,
    },
    {
      title: 'Property',
      dataIndex: 'property_name',
      key: 'property_name',
      render: (v) => v || <Text type="secondary" style={{ fontStyle: 'italic' }}>— empty —</Text>,
    },
    {
      title: 'Units',
      dataIndex: 'unit_names',
      key: 'unit_names',
      render: (v, r) => v
        ? <Space size={[4, 4]} wrap>{r.units.map(u => (
            <Tag key={u.unit_id} color={u.status === 'vacant' ? 'red' : 'green'}>{u.unit_name}</Tag>
          ))}</Space>
        : <Text type="secondary">—</Text>,
    },
    {
      title: 'Template',
      key: 'template',
      width: 180,
      render: (_, r) => {
        if (!r.property_id) return <Text type="secondary">—</Text>;
        return r.template_id
          ? <Tag color="geekblue">{r.template_name}</Tag>
          : <Tooltip title="Unit isn't assigned a template — it can't be bundled or posted yet"><Tag color="orange">needs template</Tag></Tooltip>;
      },
    },
    {
      title: 'Posting Price',
      key: 'posting_price',
      width: 190,
      // The roster rows already carry posting_rent/posting_tier per unit, so this
      // reads the same shape the plan table does.
      render: (_, r) => renderPrices(r.units),
    },
    {
      title: 'Vacant Date',
      dataIndex: 'vacant_date',
      key: 'vacant_date',
      width: 140,
      render: (v) => v || <Text type="secondary">—</Text>,
    },
  ];

  const planColumns = [
    {
      title: 'Slot',
      dataIndex: 'slot_label',
      key: 'slot_label',
      width: 100,
      render: (v) => v ? <Tag color={String(v).startsWith('Urgent') ? 'gold' : 'default'}>{v}</Tag> : <Text type="secondary">—</Text>,
    },
    {
      title: 'Property',
      dataIndex: 'property_name',
      key: 'property_name',
      render: (v, r) => (
        <div>
          <Text strong>{v}</Text>
          <div>
            <Space size={[4, 4]} wrap>{(r.unit_names || []).map(u => <Tag key={u}>{u}</Tag>)}</Space>
          </div>
        </div>
      ),
    },
    {
      title: 'Posting Price',
      key: 'unit_prices',
      width: 190,
      render: (_, r) => renderPrices(r.unit_prices),
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 150,
      render: (v, r) => {
        if (v === 'ready') return <Tag color="green">ready</Tag>;
        if (v === 'no_forum') return <Tooltip title={r.reason}><Tag color="red">no forum</Tag></Tooltip>;
        return <Tooltip title={r.reason}><Tag color="orange">{v}</Tag></Tooltip>;
      },
    },
    {
      title: 'Forum',
      key: 'forum',
      render: (_, r) => r.forum
        ? <a href={r.forum.url || '#'} target="_blank" rel="noreferrer">{r.forum.forum_name}</a>
        : <Text type="secondary">—</Text>,
    },
    {
      title: 'Account',
      key: 'account',
      width: 220,
      render: (_, r) => r.account ? (r.account.name || r.account.email) : <Text type="secondary">—</Text>,
    },
    {
      title: 'Post',
      key: 'preview',
      width: 100,
      render: (_, r) => (r.post_text
        ? <a onClick={() => setPreviewPost(r)}><EyeOutlined /> Preview</a>
        : <Tooltip title={r.reason || 'Nothing rendered for this row yet'}><Text type="secondary">—</Text></Tooltip>),
    },
  ];

  const scheduledDays = DAY_ORDER.map(day => (grid.days || []).find(d => d.day === day) || { day, name: '', forums: [] });
  // The slot-level sheet: this is what the operator actually works from (slot -> group
  // -> account), so it drives the week view. `grid` is still loaded because it is the
  // only source of the "forums with no days set" warning below.
  const weekDays = DAY_ORDER.map(day => (week.days || []).find(d => d.weekday === day)
    || { weekday: day, name: '', slots: [] });

  return (
    <MainLayout>
      <div style={{ padding: 24 }}>
        <Space align="center" style={{ marginBottom: 4 }}>
          <SoundOutlined style={{ fontSize: 22, color: '#1677ff' }} />
          <Title level={3} style={{ margin: 0 }}>Scheduler</Title>
        </Space>
        <div style={{ marginBottom: 16 }}>
          <Text type="secondary">
            A rolling roster of {meta.slot_count} slots, auto-ranked by how long each property has been
            vacant (longest first). Regenerates from live vacancy data. Urgent entries below are manual
            and carry their own forum rule.
          </Text>
        </div>

        <Card
          title={<Space><Text strong>Posting Plan</Text>{plan?.day_name && <Tag color="blue">{plan.day_name}</Tag>}</Space>}
          extra={
            <Space>
              <DatePicker
                value={planDate}
                onChange={(d) => d && setPlanDate(d)}
                allowClear={false}
              />
              <a onClick={() => loadPlan(planDate)}><ReloadOutlined /> Refresh</a>
            </Space>
          }
          styles={{ body: { padding: 16 } }}
          style={{ borderColor: '#e8e8e8', marginBottom: 24 }}
        >
          {plan?.unscheduled_forum_count > 0 && (
            <Alert
              type="warning"
              showIcon
              message={`${plan.unscheduled_forum_count} active forum${plan.unscheduled_forum_count === 1 ? '' : 's'} have no posting days set`}
              style={{ marginBottom: 12 }}
            />
          )}
          <Space size={[8, 8]} wrap style={{ marginBottom: 12 }}>
            <Tag>{plan?.date || planDate.format('YYYY-MM-DD')}</Tag>
            <Tag color="geekblue">{plan?.scheduled_forum_count || 0} scheduled forums</Tag>
            <Tag>{plan?.forum_count || 0} usable forums</Tag>
          </Space>
          <Table
            rowKey={(r) => `${r.property_id || 'missing'}-${(r.unit_ids || []).join('-')}`}
            columns={planColumns}
            dataSource={plan?.posts || []}
            loading={planLoading}
            pagination={false}
            size="small"
            locale={{ emptyText: <Empty description="No posts in this plan" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
          />
          {(plan?.unfilled_slots || []).length > 0 && (
            <div style={{ marginTop: 12 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                Spare capacity — {plan.unfilled_slots.length} slot{plan.unfilled_slots.length === 1 ? '' : 's'} scheduled
                for {plan.day_name} with no vacancy to fill:
              </Text>
              <div style={{ marginTop: 6 }}>
                <Space size={[4, 4]} wrap>
                  {plan.unfilled_slots.map(s => (
                    <Tooltip key={s.id || `${s.slot_label}-${s.position}`} title={`${s.forum?.forum_name || ''} · ${s.account?.email || ''}`}>
                      <Tag>{s.slot_label}</Tag>
                    </Tooltip>
                  ))}
                </Space>
              </div>
            </div>
          )}
        </Card>

        <Card
          title={<Text strong>Posting Sheet</Text>}
          styles={{ body: { padding: 16 } }}
          style={{ borderColor: '#e8e8e8', marginBottom: 24 }}
        >
          <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(200px, 1fr))', gap: 12, minWidth: 1400 }}>
              {weekDays.map(day => (
                <div key={day.weekday} style={{ border: '1px solid #f0f0f0', borderRadius: 6, padding: 12, minHeight: 120 }}>
                  <Space size={6}>
                    <Text strong>{day.name || scheduledDays.find(d => d.day === day.weekday)?.name || ''}</Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>{day.slots.length}</Text>
                  </Space>
                  <div style={{ marginTop: 8 }}>
                    {day.slots.length ? (
                      <Space direction="vertical" size={6} style={{ width: '100%' }}>
                        {day.slots.map(s => (
                          <div key={s.id} style={{ borderBottom: '1px solid #f5f5f5', paddingBottom: 6 }}>
                            <Space size={4} wrap>
                              <Tag color={s.slot_kind === 'urgent' ? 'gold' : 'default'} style={{ marginInlineEnd: 0 }}>{s.slot_label}</Tag>
                              {Number(s.forum?.is_owned) === 1 && <Tag color="green" style={{ marginInlineEnd: 0 }}>owned</Tag>}
                            </Space>
                            <div><Text style={{ fontSize: 12 }}>{s.forum?.forum_name}</Text></div>
                            <Text type="secondary" style={{ fontSize: 11 }}>{s.account?.email}</Text>
                          </div>
                        ))}
                      </Space>
                    ) : <Text type="secondary">—</Text>}
                  </div>
                </div>
              ))}
            </div>
          </div>
          {(week.weekly_totals || []).length > 0 && (
            <div style={{ marginTop: 12 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>Posts per group per week</Text>
              <div style={{ marginTop: 6 }}>
                <Space size={[6, 6]} wrap>
                  {week.weekly_totals.map(t => (
                    <Tag
                      key={t.forum_id}
                      color={t.over_cap ? 'red' : (Number(t.is_owned) === 1 ? 'green' : 'default')}
                    >
                      {t.forum_name}: {t.count}
                      {t.max_per_week != null ? ` / ${t.max_per_week}` : ''}
                      {t.over_cap ? ' — over cap' : ''}
                    </Tag>
                  ))}
                </Space>
              </div>
            </div>
          )}
          {(grid.unscheduled || []).length > 0 && (
            <Alert
              type="warning"
              showIcon
              message="Forums with no days set"
              description={<Space size={[4, 4]} wrap>{grid.unscheduled.map(f => <Tag key={f.forum_id} color="warning">{f.forum_name}</Tag>)}</Space>}
              style={{ marginTop: 12 }}
            />
          )}
        </Card>

        {violations.length > 0 && (
          <Card
            title={
              <Space>
                <Text strong>Same property repeating in one group</Text>
                <Tag color="orange">{violations.length}</Tag>
              </Space>
            }
            styles={{ body: { padding: 16 } }}
            style={{ borderColor: '#e8e8e8', marginBottom: 24 }}
          >
            <Text type="secondary" style={{ fontSize: 12 }}>
              A slot posts the same property into the same group more than once a week. Repeated
              impressions on one audience are worth less than the same effort spread across several,
              so pointing the surplus at another group costs nothing and widens reach.
            </Text>
            <Space direction="vertical" size={12} style={{ width: '100%', marginTop: 12 }}>
              {violations.map(v => {
                const choice = fixChoice[v.slot_key] || {};
                const chosen = (v.suggestions || []).find(s => String(s.forum_id) === String(choice.forum_id));
                return (
                  <div key={v.slot_key} style={{ border: '1px solid #f0f0f0', borderRadius: 6, padding: 12 }}>
                    <Space size={6} wrap style={{ marginBottom: 8 }}>
                      <Tag color={v.slot_label?.startsWith('Urgent') ? 'gold' : 'default'}>{v.slot_label}</Tag>
                      <Text strong>{v.forum_name}</Text>
                      <Tag color="red">×{v.count}</Tag>
                      {Number(v.is_owned) === 1
                        ? <Tag color="green">owned</Tag>
                        : <Tooltip title="Someone else's group, so frequency matters more here"><Tag color="volcano">external</Tag></Tooltip>}
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {(v.rows || []).map(r => r.day_name).join(', ')}
                      </Text>
                    </Space>
                    <Space wrap>
                      <Select
                        style={{ minWidth: 280 }}
                        placeholder="Move the surplus posting(s) to…"
                        value={choice.forum_id}
                        onChange={(forum_id) => setFixChoice(prev => ({ ...prev, [v.slot_key]: { forum_id } }))}
                        options={(v.suggestions || []).map(s => ({
                          value: s.forum_id,
                          label: `${s.forum_name}${Number(s.is_owned) === 1 ? ' (owned)' : ''} — ${s.weekly_count}/wk`,
                        }))}
                      />
                      <Select
                        style={{ minWidth: 240 }}
                        placeholder="Account"
                        value={choice.account_id}
                        disabled={!chosen}
                        onChange={(account_id) => setFixChoice(prev => ({ ...prev, [v.slot_key]: { ...prev[v.slot_key], account_id } }))}
                        options={(chosen?.accounts || []).map(a => ({ value: a.id, label: a.email }))}
                      />
                      <Button
                        type="primary"
                        size="small"
                        loading={applyingKey === v.slot_key}
                        disabled={!choice.forum_id || !choice.account_id}
                        onClick={() => applyFix(v)}
                      >
                        Apply
                      </Button>
                    </Space>
                  </div>
                );
              })}
            </Space>
          </Card>
        )}

        <Card
          title={<Space><Text strong>Roster</Text><Tag color="blue">{meta.filled}/{meta.slot_count} filled</Tag>{meta.overflow > 0 && <Tooltip title="Vacancies beyond the 20 slots"><Tag color="orange">+{meta.overflow} waiting</Tag></Tooltip>}</Space>}
          extra={<a onClick={load}><ReloadOutlined /> Refresh</a>}
          styles={{ body: { padding: 0 } }}
          style={{ borderColor: '#e8e8e8', marginBottom: 24 }}
        >
          <Table
            rowKey="position"
            columns={slotColumns}
            dataSource={slots}
            loading={loading}
            pagination={false}
            size="small"
            rowClassName={(r) => (r.property_id ? '' : 'scheduler-empty-row')}
          />
        </Card>

        <Card
          title={<Space><ThunderboltOutlined style={{ color: '#faad14' }} /><Text strong>Urgent</Text><Text type="secondary" style={{ fontSize: 12 }}>manual — extra postings, own forum rule</Text></Space>}
          extra={<Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => setAddOpen(true)}>Add Urgent</Button>}
          styles={{ body: { padding: 16 } }}
          style={{ borderColor: '#e8e8e8' }}
        >
          {urgent.length === 0 ? (
            <Empty description="No urgent entries" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          ) : (
            <Table
              rowKey="id"
              pagination={false}
              size="small"
              dataSource={urgent}
              columns={[
                { title: 'Property / Label', key: 'what', render: (_, r) => r.property_name || r.label || <Text type="secondary">—</Text> },
                { title: 'Units', key: 'units', render: (_, r) => r.unit_ids?.length ? <Tag>{r.unit_ids.length} unit{r.unit_ids.length === 1 ? '' : 's'}</Tag> : <Text type="secondary">—</Text> },
                { title: 'Forum Rule', dataIndex: 'forum_rule', key: 'forum_rule', render: (v) => v || <Text type="secondary">— not set —</Text> },
                { title: 'Note', dataIndex: 'note', key: 'note', render: (v) => v || <Text type="secondary">—</Text> },
                {
                  title: '', key: 'actions', width: 50, render: (_, r) => (
                    <Popconfirm title="Remove this urgent entry?" onConfirm={async () => { await advertisingApi.deleteUrgent(r.id); message.success('Removed'); load(); }} okText="Remove" okButtonProps={{ danger: true }}>
                      <Button size="small" danger icon={<DeleteOutlined />} />
                    </Popconfirm>
                  ),
                },
              ]}
            />
          )}
        </Card>
      </div>

      <Modal
        title="Add Urgent Entry"
        open={addOpen}
        onCancel={() => setAddOpen(false)}
        onOk={addUrgent}
        confirmLoading={saving}
        okText="Add"
      >
        <Form form={form} layout="vertical">
          <Form.Item name="property_id" label="Property (optional)"
            tooltip="Pick a property currently in the roster, or leave blank and use a label.">
            <Select allowClear showSearch optionFilterProp="label" placeholder="Select a property" options={properties} />
          </Form.Item>
          <Form.Item name="label" label="Label (if no property)">
            <Input placeholder="e.g. Mercer 4A — urgent" />
          </Form.Item>
          <Form.Item name="forum_rule" label="Forum rule"
            tooltip="Which forum/account this urgent posting goes to. Free text for now — structured forum picker comes with the forum list.">
            <Input placeholder="e.g. Post daily to Group X on Account 1" />
          </Form.Item>
          <Form.Item name="note" label="Note (optional)">
            <Input.TextArea rows={2} placeholder="Anything to remember" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={previewPost
          ? <Space direction="vertical" size={0}>
              <Text strong>{previewPost.property_name} — {(previewPost.unit_names || []).join(', ')}</Text>
              <Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
                {previewPost.forum?.forum_name || 'no forum'} · {previewPost.account?.name || previewPost.account?.email || 'no account'}
              </Text>
            </Space>
          : 'Post preview'}
        open={!!previewPost}
        onCancel={() => setPreviewPost(null)}
        width={720}
        footer={[
          <Button key="copy" icon={<CopyOutlined />} onClick={async () => {
            try {
              await navigator.clipboard.writeText(previewPost?.post_text || '');
              message.success('Post copied');
            } catch {
              // Clipboard is blocked on insecure origins — the text is on screen
              // and selectable, so say so rather than failing silently.
              message.warning('Copy blocked by the browser — select the text and copy manually');
            }
          }}>Copy post</Button>,
          <Button key="close" type="primary" onClick={() => setPreviewPost(null)}>Close</Button>,
        ]}
      >
        {previewPost && (
          <>
            <Space size={[8, 8]} wrap style={{ marginBottom: 12 }}>
              <Tag color="geekblue">{previewPost.template_name}</Tag>
              {(previewPost.unit_prices || []).map(p => (
                <Tag key={p.unit_id}>
                  {p.unit_name}: {p.posting_rent == null ? 'no price' : money(p.posting_rent)}
                </Tag>
              ))}
            </Space>
            {/* Exactly what gets pasted into the forum — whitespace preserved, since
                the blank lines between sections are part of the rendered post. */}
            <div style={{
              whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 13, lineHeight: 1.6,
              background: '#fafafa', border: '1px solid #f0f0f0', borderRadius: 6,
              padding: 16, maxHeight: '55vh', overflowY: 'auto',
            }}>
              {previewPost.post_text}
            </div>
            {previewPost.image_hint?.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  Photos: {previewPost.image_hint.join(' · ')}
                </Text>
              </div>
            )}
          </>
        )}
      </Modal>

      <style jsx global>{`
        .scheduler-empty-row td { background: #fafafa; }
      `}</style>
    </MainLayout>
  );
}
