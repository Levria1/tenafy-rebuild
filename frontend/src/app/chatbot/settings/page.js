'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Card, Typography, Switch, Input, InputNumber, Button, Space, Form, Row, Col, message, Divider, Alert, Spin,
  Table, Tag, Modal, Segmented, Popconfirm, Tooltip, Empty,
} from 'antd';
import {
  SaveOutlined, ReloadOutlined, PlusOutlined, EditOutlined, DeleteOutlined, WhatsAppOutlined,
  UploadOutlined,
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
  // Internal-staff-only tools. Off these for any bot exposed to prospects (e.g. TaneChat).
  { key: 'can_search_inquiries', label: 'Search inquiries (PII)', description: 'Bot can look up prospects by name, phone, budget, or topic mentioned in chat history' },
  { key: 'can_search_leases',    label: 'Search leases (PII)',    description: 'Bot can find current/past/expiring leases by tenant, unit, or property' },
  { key: 'can_search_invoices',  label: 'Search invoices (PII)',  description: 'Bot can answer "who\'s behind on rent?" and pull outstanding/overdue balances' },
  { key: 'can_search_services',  label: 'Search service requests', description: 'Bot can find open maintenance jobs, AC issues, vendor assignments' },
  { key: 'can_search_documents', label: 'Search lease documents', description: 'Bot can find unsigned leases, lease templates, signature status' },
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
        // Legacy fields — actively cleared on every save now that the
        // Rulebook + FAQ cards below are the source of truth. Sending null
        // wipes any stale text so the bot doesn't silently append it.
        custom_instructions: null,
        system_prompt: null,
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
      <RulesSection locked={locked} />
      <div style={{ height: 16 }} />
      <FAQsSection locked={locked} />
    </MainLayout>
  );
}

// ---------------------------------------------------------------------------
// Shared hook — both Rules and FAQs sections use the same chat_knowledge
// table; we just filter by `kind`. Each card calls load() independently
// (single source of data in the backend, single fetch per card).
// ---------------------------------------------------------------------------
function useKnowledge(filterKind) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const load = useCallback(() => {
    setLoading(true);
    chatApi.listKnowledge()
      .then((r) => setItems((r.data.data || []).filter(x => x.kind === filterKind)))
      .catch(() => message.error('Failed to load'))
      .finally(() => setLoading(false));
  }, [filterKind]);
  useEffect(() => { load(); }, [load]);
  return { items, setItems, loading, load };
}

// Parse free-text pasted FAQs into [{ question, answer }] pairs.
// Accepted formats (most common first):
//   "Q: ...\nA: ..."                  with blank line between pairs
//   "Question: ...\nAnswer: ..."      same idea, longer prefix
//   "Q1. ...\n   A. ..."              numbered with optional prefix punctuation
//   alternating-line style: question on one line, answer on next, blank line
// Returns: [{ question, answer }, ...]. Empty entries are skipped.
function parseFaqText(text) {
  if (!text || !text.trim()) return [];
  // Split into blocks separated by blank lines (one or more empty lines).
  const blocks = String(text).split(/\n\s*\n+/).map(b => b.trim()).filter(Boolean);
  const out = [];
  for (const block of blocks) {
    // Try Q:/A: style first — matches "Q:" or "Question:" or "Q1.", etc.
    const qaMatch = block.match(
      /^(?:Q(?:uestion)?\s*\d*[:.)\-]\s*)([\s\S]*?)(?:\n|\r\n?)\s*(?:A(?:nswer)?\s*\d*[:.)\-]\s*)([\s\S]+)$/i
    );
    if (qaMatch) {
      const q = qaMatch[1].trim();
      const a = qaMatch[2].trim();
      if (q && a) { out.push({ question: q, answer: a }); continue; }
    }
    // Fall back to "first line is question, rest is answer".
    const lines = block.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length >= 2) {
      const q = lines[0].replace(/^\d+[.)]\s*/, '').replace(/^Q[:.]\s*/i, '');
      const a = lines.slice(1).join(' ').replace(/^A[:.]\s*/i, '');
      if (q && a) out.push({ question: q, answer: a });
    }
  }
  return out;
}

function RulesSection({ locked }) {
  return <KnowledgeCard kind="rule" locked={locked} />;
}

function FAQsSection({ locked }) {
  return <KnowledgeCard kind="faq" locked={locked} />;
}

// ---------------------------------------------------------------------------
// Shared card UI — renders either Rules or FAQs depending on `kind`.
// FAQs get an extra "Bulk Import" button + modal with the parser above.
// ---------------------------------------------------------------------------
function KnowledgeCard({ kind, locked }) {
  const isFaq = kind === 'faq';
  const { items, setItems, loading, load } = useKnowledge(kind);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();

  // Bulk-import (FAQ only) state
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState('');
  const [bulkPublic, setBulkPublic] = useState(false);
  const [bulkSaving, setBulkSaving] = useState(false);
  const bulkParsed = isFaq ? parseFaqText(bulkText) : [];

  const openAdd = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ is_public: false, title: '', body: '' });
    setModalOpen(true);
  };
  const openEdit = (item) => {
    setEditing(item);
    form.setFieldsValue({
      title: item.title || '', body: item.body, is_public: item.visibility === 'public',
    });
    setModalOpen(true);
  };

  const handleSubmit = async () => {
    let values;
    try { values = await form.validateFields(); } catch { return; }
    setSaving(true);
    try {
      const payload = {
        kind,
        title: isFaq ? (values.title || null) : null,
        body: values.body,
        visibility: values.is_public ? 'public' : 'internal',
      };
      if (editing) await chatApi.updateKnowledge(editing.id, payload);
      else await chatApi.createKnowledge(payload);
      message.success(editing ? 'Saved' : 'Added');
      setModalOpen(false);
      load();
    } catch (e) {
      message.error(e?.response?.data?.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (item) => {
    try {
      await chatApi.deleteKnowledge(item.id);
      message.success('Deleted');
      load();
    } catch (e) {
      message.error(e?.response?.data?.message || 'Failed to delete');
    }
  };

  const toggleShare = async (item, checked) => {
    setItems((prev) => prev.map((x) => x.id === item.id
      ? { ...x, visibility: checked ? 'public' : 'internal' } : x));
    try {
      await chatApi.updateKnowledge(item.id, { visibility: checked ? 'public' : 'internal' });
    } catch (e) {
      message.error('Failed to update sharing');
      load();
    }
  };

  const onBulkImport = async () => {
    if (!bulkParsed.length) {
      message.warning('Nothing to import — check the format below.');
      return;
    }
    setBulkSaving(true);
    try {
      const entries = bulkParsed.map(p => ({
        kind: 'faq',
        title: p.question,
        body: p.answer,
        visibility: bulkPublic ? 'public' : 'internal',
      }));
      const r = await chatApi.bulkKnowledge(entries);
      const data = r.data?.data || {};
      const failed = (data.failures || []).length;
      if (failed) {
        message.warning(`Imported ${data.inserted} FAQs, ${failed} failed.`);
      } else {
        message.success(`Imported ${data.inserted} FAQ${data.inserted === 1 ? '' : 's'}.`);
      }
      setBulkOpen(false);
      setBulkText('');
      load();
    } catch (e) {
      message.error(e?.response?.data?.message || 'Bulk import failed');
    } finally {
      setBulkSaving(false);
    }
  };

  const columns = [
    {
      title: 'Content',
      dataIndex: 'body',
      render: (body, item) => (
        <div>
          {isFaq && item.title && (
            <div style={{ fontWeight: 600, marginBottom: 2 }}>Q: {item.title}</div>
          )}
          <div style={{ color: isFaq ? '#555' : 'inherit' }}>
            {isFaq ? `A: ${body}` : body}
          </div>
        </div>
      ),
    },
    {
      title: (
        <Tooltip title="When on, the entry is also shared with TaneChat (external WhatsApp-facing bot). When off, only the internal Tenafy bot sees it.">
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
            title={`Delete this ${isFaq ? 'FAQ' : 'rule'}?`}
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
      title={isFaq ? 'FAQs' : 'Rules'}
      extra={
        <Space>
          {isFaq && (
            <Button icon={<UploadOutlined />} onClick={() => setBulkOpen(true)} disabled={locked}>
              Bulk Import
            </Button>
          )}
          <Button type="primary" icon={<PlusOutlined />} onClick={openAdd} disabled={locked}>
            {isFaq ? 'Add FAQ' : 'Add rule'}
          </Button>
        </Space>
      }
    >
      <Paragraph type="secondary">
        {isFaq
          ? <span>Question-and-answer entries the bot pulls from when prospects ask things the live data can't answer. Examples: <em>"Do you allow pets?"</em>, <em>"What time can I view?"</em>.</span>
          : <span>Behavior rules that shape how the bot responds. Examples: <em>"Always search at the unit level."</em>, <em>"Mention parking is included when asked about parking."</em></span>}
        {' '}Toggle <strong>Share with TaneChat</strong> to also expose the entry to the external prospect-facing bot.
      </Paragraph>
      <Table
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={items}
        columns={columns}
        pagination={false}
        locale={{ emptyText: <Empty description={isFaq ? 'No FAQs yet — click "Add FAQ" or "Bulk Import" to start.' : 'No rules yet — click "Add rule" to start.'} /> }}
      />

      {/* Add / Edit modal */}
      <Modal
        title={editing ? (isFaq ? 'Edit FAQ' : 'Edit rule') : (isFaq ? 'Add FAQ' : 'Add rule')}
        open={modalOpen}
        onOk={handleSubmit}
        onCancel={() => setModalOpen(false)}
        confirmLoading={saving}
        okText={editing ? 'Save' : 'Add'}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          {isFaq && (
            <Form.Item
              name="title"
              label="Question"
              rules={[{ required: true, message: 'Enter the question' }]}
            >
              <Input placeholder="e.g. Do you allow pets?" />
            </Form.Item>
          )}
          <Form.Item
            name="body"
            label={isFaq ? 'Answer' : 'Rule'}
            rules={[{ required: true, message: isFaq ? 'Enter the answer' : 'Enter the rule' }]}
          >
            <Input.TextArea
              rows={4}
              placeholder={isFaq
                ? 'e.g. Most of our buildings are pet-friendly; the team will confirm per unit.'
                : 'e.g. Parking is included in the rent — mention it when asked.'}
            />
          </Form.Item>
          <Form.Item
            name="is_public"
            label="Share with TaneChat (prospect-facing bot)"
            valuePropName="checked"
            extra="Off = only the internal Tenafy bot uses this. On = TaneChat too. Keep anything internal-only OFF."
          >
            <Switch checkedChildren="Public" unCheckedChildren="Internal" />
          </Form.Item>
        </Form>
      </Modal>

      {/* Bulk import modal — FAQs only */}
      {isFaq && (
        <Modal
          title="Bulk Import FAQs"
          open={bulkOpen}
          onOk={onBulkImport}
          onCancel={() => setBulkOpen(false)}
          confirmLoading={bulkSaving}
          okText={`Import ${bulkParsed.length} FAQ${bulkParsed.length === 1 ? '' : 's'}`}
          okButtonProps={{ disabled: !bulkParsed.length }}
          width={760}
          destroyOnClose
        >
          <Paragraph type="secondary" style={{ marginBottom: 8 }}>
            Paste any Q&amp;A list below. The parser handles a few common formats — see examples
            below. The preview updates as you type.
          </Paragraph>
          <details style={{ marginBottom: 8 }}>
            <summary style={{ cursor: 'pointer', color: '#1677ff' }}>Accepted formats</summary>
            <div style={{ marginTop: 6, padding: 12, background: '#fafafa', borderRadius: 4, fontSize: 12, fontFamily: 'monospace', whiteSpace: 'pre-wrap', color: '#555' }}>
{`Format 1 — Q: / A: with blank lines

Q: What time can I view?
A: Mon–Sat 11am–7pm.

Q: Do you allow pets?
A: Pets under 15kg only.

Format 2 — alternating lines

What time can I view?
Mon–Sat 11am–7pm.

Do you allow pets?
Pets under 15kg only.`}
            </div>
          </details>
          <Input.TextArea
            rows={10}
            value={bulkText}
            onChange={(e) => setBulkText(e.target.value)}
            placeholder="Paste your FAQ list here..."
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
            <span style={{ fontSize: 13 }}>
              Detected: <strong>{bulkParsed.length}</strong> Q&amp;A pair{bulkParsed.length === 1 ? '' : 's'}
            </span>
            <Space>
              <span style={{ fontSize: 12, color: '#666' }}>Share all with TaneChat:</span>
              <Switch
                checked={bulkPublic}
                onChange={setBulkPublic}
                checkedChildren="Public"
                unCheckedChildren="Internal"
                size="small"
              />
            </Space>
          </div>
          {bulkParsed.length > 0 && (
            <div style={{ marginTop: 12, maxHeight: 200, overflowY: 'auto', border: '1px solid #f0f0f0', borderRadius: 4, padding: 8 }}>
              {bulkParsed.map((p, i) => (
                <div key={i} style={{ marginBottom: 8, paddingBottom: 8, borderBottom: i < bulkParsed.length - 1 ? '1px solid #f5f5f5' : 'none' }}>
                  <div style={{ fontWeight: 600, fontSize: 12 }}>Q: {p.question}</div>
                  <div style={{ color: '#555', fontSize: 12 }}>A: {p.answer}</div>
                </div>
              ))}
            </div>
          )}
        </Modal>
      )}
    </Card>
  );
}

