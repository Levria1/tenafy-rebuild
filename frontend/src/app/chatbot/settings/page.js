'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Card, Typography, Switch, Input, InputNumber, Button, Space, Form, Row, Col, message, Divider, Alert, Spin,
  Table, Tag, Modal, Segmented, Popconfirm, Tooltip, Empty,
} from 'antd';
import {
  SaveOutlined, ReloadOutlined, PlusOutlined, EditOutlined, DeleteOutlined, WhatsAppOutlined,
} from '@ant-design/icons';
import MainLayout from '../../../components/Layout';
import { chatApi } from '../../../lib/api';

const { Title, Text, Paragraph } = Typography;

const CAPABILITY_LABELS = [
  { key: 'can_search', label: 'Search available units', description: 'Bot can answer "what 2BRs under $1500 do you have?"' },
  { key: 'can_show_details', label: 'Show unit / property details', description: 'Bot can pull photos, amenities, full descriptions' },
  { key: 'can_answer_pricing', label: 'Answer pricing questions', description: 'Bot can quote rent, deposits, utility costs' },
  { key: 'can_book_viewings', label: 'Book viewings', description: 'Bot can create viewing bookings (with explicit user confirmation)' },
  { key: 'can_capture_leads', label: 'Capture leads', description: 'Bot can save contact info as a prospect in the contacts list' },
];

export default function ChatSettingsPage() {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [settings, setSettings] = useState(null);

  const reload = useCallback(() => {
    setLoading(true);
    chatApi.getSettings()
      .then((r) => {
        const s = r.data.data;
        setSettings(s);
        form.setFieldsValue({
          enabled: Boolean(s.enabled),
          ...Object.fromEntries(CAPABILITY_LABELS.map(c => [c.key, Boolean(s.capabilities?.[c.key])])),
          custom_instructions: s.custom_instructions || '',
          system_prompt: s.system_prompt || '',
          max_bookings_per_session: s.max_bookings_per_session,
          max_messages_per_session: s.max_messages_per_session,
          max_messages_per_day: s.max_messages_per_day,
        });
      })
      .catch(() => message.error('Failed to load settings'))
      .finally(() => setLoading(false));
  }, [form]);

  useEffect(() => { reload(); }, [reload]);

  const handleSave = async (values) => {
    setSaving(true);
    try {
      const capabilities = Object.fromEntries(
        CAPABILITY_LABELS.map(c => [c.key, Boolean(values[c.key])])
      );
      await chatApi.updateSettings({
        enabled: Boolean(values.enabled),
        capabilities,
        custom_instructions: values.custom_instructions || null,
        system_prompt: values.system_prompt || null,
        max_bookings_per_session: values.max_bookings_per_session,
        max_messages_per_session: values.max_messages_per_session,
        max_messages_per_day: values.max_messages_per_day,
      });
      message.success('Settings saved');
      reload();
    } catch (e) {
      message.error(e?.response?.data?.message || 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <MainLayout><div style={{ textAlign: 'center', padding: 48 }}><Spin size="large" /></div></MainLayout>;
  }

  const locked = settings?.settings_locked;

  return (
    <MainLayout>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <Title level={4} style={{ margin: 0 }}>Chatbot Settings</Title>
          <Text type="secondary">Configure what the bot can do and how it sounds.</Text>
        </div>
        <Button icon={<ReloadOutlined />} onClick={reload}>Refresh</Button>
      </div>

      {locked && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="Settings are locked by the platform operator"
          description="You can view these settings but cannot edit them. Contact support to request changes."
        />
      )}

      <Form form={form} layout="vertical" onFinish={handleSave} disabled={locked || saving}>
        <Card size="small" title="Master switch" style={{ marginBottom: 16 }}>
          <Form.Item
            name="enabled"
            label="Chatbot enabled for this organization"
            valuePropName="checked"
            extra="When off, all /api/chat/message calls return 403. Useful as a quick kill switch."
          >
            <Switch />
          </Form.Item>
        </Card>

        <Card size="small" title="What the bot can do" style={{ marginBottom: 16 }}>
          <Paragraph type="secondary" style={{ marginBottom: 16 }}>
            Turning a capability off REMOVES that tool from the bot's toolbox — the LLM physically
            cannot call it. Stronger than a permission check.
          </Paragraph>
          <Row gutter={[16, 8]}>
            {CAPABILITY_LABELS.map((c) => (
              <Col xs={24} md={12} key={c.key}>
                <Form.Item name={c.key} valuePropName="checked" style={{ marginBottom: 8 }}>
                  <Switch />
                </Form.Item>
                <div style={{ marginLeft: 52, marginTop: -32, marginBottom: 12 }}>
                  <div style={{ fontWeight: 500 }}>{c.label}</div>
                  <Text type="secondary" style={{ fontSize: 12 }}>{c.description}</Text>
                </div>
              </Col>
            ))}
          </Row>
        </Card>

        <Card size="small" title="Custom instructions" style={{ marginBottom: 16 }}>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="Prefer the Rulebook below"
            description="For new rules, use the Rulebook section at the bottom — entries there can be shared with TaneChat (the WhatsApp-facing bot) and managed individually. This free-text box still works and is appended for the internal bot, but it's internal-only."
          />
          <Paragraph type="secondary">
            Extra rules APPENDED to the built-in system prompt. This is where you add business-
            specific behavior without rewriting the whole prompt. The bot reads these rules at the
            start of every conversation. Changes apply to new sessions; existing transcripts keep
            their original instructions.
          </Paragraph>
          <Paragraph type="secondary" style={{ fontSize: 12 }}>
            <strong>Examples of good rules:</strong>
            <ul style={{ marginTop: 4, marginBottom: 0 }}>
              <li>Always search at the unit level — recommend specific apartments, not buildings.</li>
              <li>Mention our pet policy (no pets above 15kg) if the user asks about animals.</li>
              <li>After business hours (6pm–8am), tell prospects we'll confirm in the morning.</li>
              <li>When unsure about availability, always offer to capture a lead instead of guessing.</li>
            </ul>
          </Paragraph>
          <Form.Item name="custom_instructions">
            <Input.TextArea
              rows={8}
              placeholder="- Always search at the unit level, not property level.&#10;- If the prospect asks about parking, tell them parking is included in the rent.&#10;- Never promise a specific employee will handle the viewing — just say 'our team'."
            />
          </Form.Item>
        </Card>

        <Card
          size="small"
          title="Full system prompt override (advanced)"
          style={{ marginBottom: 16 }}
          extra={<Text type="secondary" style={{ fontSize: 12 }}>Rarely needed</Text>}
        >
          <Paragraph type="secondary">
            If set, this REPLACES the built-in system prompt entirely (including the Mon–Sat 11–7
            rule, confirmation guardrails, and language auto-detect). Custom instructions above
            are ignored when this is used. Leave blank to use the built-in default + your custom
            instructions.
          </Paragraph>
          <Form.Item name="system_prompt">
            <Input.TextArea
              rows={6}
              placeholder="(leave blank — use Custom instructions above instead)"
            />
          </Form.Item>
        </Card>

        <Card size="small" title="Guardrails" style={{ marginBottom: 16 }}>
          <Row gutter={16}>
            <Col xs={24} md={8}>
              <Form.Item
                name="max_bookings_per_session"
                label="Max bookings per session"
                extra="Prevents a misbehaving bot from booking repeatedly."
                rules={[{ required: true }]}
              >
                <InputNumber min={0} max={20} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item
                name="max_messages_per_session"
                label="Max messages per session"
                rules={[{ required: true }]}
              >
                <InputNumber min={1} max={1000} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item
                name="max_messages_per_day"
                label="Max messages per day (per channel user)"
                rules={[{ required: true }]}
              >
                <InputNumber min={1} max={10000} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
        </Card>

        <Space>
          <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={saving} disabled={locked}>
            Save settings
          </Button>
          <Button onClick={reload} disabled={saving}>Cancel</Button>
        </Space>
      </Form>

      <Divider />
      <RulebookSection locked={locked} />
    </MainLayout>
  );
}

// ---------------------------------------------------------------------------
// Rulebook — manages chat_knowledge entries (the shared knowledge base).
// Each entry auto-saves on add/edit/delete (independent of the Save settings
// button above). The "Share with WhatsApp" toggle = public vs internal.
// ---------------------------------------------------------------------------
function RulebookSection({ locked }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();

  const load = useCallback(() => {
    setLoading(true);
    chatApi.listKnowledge()
      .then((r) => setItems(r.data.data || []))
      .catch(() => message.error('Failed to load rulebook'))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  const openAdd = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ kind: 'rule', is_public: false, title: '', body: '' });
    setModalOpen(true);
  };
  const openEdit = (item) => {
    setEditing(item);
    form.setFieldsValue({
      kind: item.kind, title: item.title || '', body: item.body, is_public: item.visibility === 'public',
    });
    setModalOpen(true);
  };

  const handleSubmit = async () => {
    let values;
    try { values = await form.validateFields(); } catch { return; }
    setSaving(true);
    try {
      const payload = {
        kind: values.kind,
        title: values.kind === 'faq' ? (values.title || null) : null,
        body: values.body,
        visibility: values.is_public ? 'public' : 'internal',
      };
      if (editing) await chatApi.updateKnowledge(editing.id, payload);
      else await chatApi.createKnowledge(payload);
      message.success(editing ? 'Rule updated' : 'Rule added');
      setModalOpen(false);
      load();
    } catch (e) {
      message.error(e?.response?.data?.message || 'Failed to save rule');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (item) => {
    try {
      await chatApi.deleteKnowledge(item.id);
      message.success('Rule deleted');
      load();
    } catch (e) {
      message.error(e?.response?.data?.message || 'Failed to delete rule');
    }
  };

  const toggleShare = async (item, checked) => {
    // Optimistic update
    setItems((prev) => prev.map((x) => x.id === item.id
      ? { ...x, visibility: checked ? 'public' : 'internal' } : x));
    try {
      await chatApi.updateKnowledge(item.id, { visibility: checked ? 'public' : 'internal' });
    } catch (e) {
      message.error('Failed to update sharing');
      load();
    }
  };

  const columns = [
    {
      title: 'Type',
      dataIndex: 'kind',
      width: 80,
      render: (k) => k === 'faq'
        ? <Tag color="purple">FAQ</Tag>
        : <Tag color="blue">Rule</Tag>,
    },
    {
      title: 'Content',
      dataIndex: 'body',
      render: (body, item) => (
        <div>
          {item.kind === 'faq' && item.title && (
            <div style={{ fontWeight: 600, marginBottom: 2 }}>Q: {item.title}</div>
          )}
          <div style={{ color: item.kind === 'faq' ? '#555' : 'inherit' }}>
            {item.kind === 'faq' ? `A: ${body}` : body}
          </div>
        </div>
      ),
    },
    {
      title: (
        <Tooltip title="When on, the rule is also shared with TaneChat (the external WhatsApp-facing bot). When off, only the internal Tenafy bot sees it.">
          <span><WhatsAppOutlined /> Share with TaneChat</span>
        </Tooltip>
      ),
      dataIndex: 'visibility',
      width: 170,
      align: 'center',
      render: (visibility, item) => (
        <Switch
          checked={visibility === 'public'}
          disabled={locked}
          checkedChildren="Public"
          unCheckedChildren="Internal"
          onChange={(checked) => toggleShare(item, checked)}
        />
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 90,
      render: (_, item) => (
        <Space>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(item)} disabled={locked} />
          <Popconfirm
            title="Delete this rule?"
            okText="Delete"
            okButtonProps={{ danger: true }}
            onConfirm={() => handleDelete(item)}
            disabled={locked}
          >
            <Button size="small" danger icon={<DeleteOutlined />} disabled={locked} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Card
      size="small"
      title="Rulebook (shared knowledge)"
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={openAdd} disabled={locked}>
          Add rule
        </Button>
      }
    >
      <Paragraph type="secondary">
        The shared knowledge base both bots draw from. <strong>Rules</strong> shape how the bot
        behaves; <strong>FAQs</strong> are answers to questions the live data can't provide.
        Toggle <strong>Share with TaneChat</strong> to also expose a rule to the external
        prospect-facing bot (off = internal Tenafy bot only). Changes apply to new conversations.
      </Paragraph>
      <Table
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={items}
        columns={columns}
        pagination={false}
        locale={{ emptyText: <Empty description="No rules yet — click “Add rule” to start your rulebook." /> }}
      />

      <Modal
        title={editing ? 'Edit rule' : 'Add rule'}
        open={modalOpen}
        onOk={handleSubmit}
        onCancel={() => setModalOpen(false)}
        confirmLoading={saving}
        okText={editing ? 'Save' : 'Add'}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item name="kind" label="Type">
            <Segmented
              options={[
                { label: 'Rule (behavior)', value: 'rule' },
                { label: 'FAQ (Q & A)', value: 'faq' },
              ]}
            />
          </Form.Item>

          <Form.Item noStyle shouldUpdate={(p, c) => p.kind !== c.kind}>
            {({ getFieldValue }) => getFieldValue('kind') === 'faq' ? (
              <>
                <Form.Item
                  name="title"
                  label="Question"
                  rules={[{ required: true, message: 'Enter the question' }]}
                >
                  <Input placeholder="e.g. Do you allow pets?" />
                </Form.Item>
                <Form.Item
                  name="body"
                  label="Answer"
                  rules={[{ required: true, message: 'Enter the answer' }]}
                >
                  <Input.TextArea rows={4} placeholder="e.g. Most of our buildings are pet-friendly; the team will confirm per unit." />
                </Form.Item>
              </>
            ) : (
              <Form.Item
                name="body"
                label="Rule"
                rules={[{ required: true, message: 'Enter the rule' }]}
              >
                <Input.TextArea rows={4} placeholder="e.g. Parking is included in the rent — mention it when asked." />
              </Form.Item>
            )}
          </Form.Item>

          <Form.Item
            name="is_public"
            label="Share with TaneChat (prospect-facing bot)"
            valuePropName="checked"
            extra="Off = only the internal Tenafy bot uses this rule. On = TaneChat (the external WhatsApp-facing bot) uses it too. Keep anything containing tenant or internal info OFF."
          >
            <Switch checkedChildren="Public" unCheckedChildren="Internal" />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
