'use client';

/**
 * Shared rulebook card — renders either the Rules list or the FAQ list depending
 * on `kind`. Both live in the same `chat_knowledge` table; we just filter by kind.
 *
 * Used by two pages:
 *   /chatbot/rules  → <KnowledgeCard kind="rule" />
 *   /chatbot/faq    → <KnowledgeCard kind="faq" />
 *
 * FAQs additionally get a "Bulk Import" button + modal (see parseFaqText below).
 *
 * VISIBILITY: each entry is 'internal' (default) or 'public'. Public entries are
 * ALSO served to external prospect-facing channels (TaneChat/WhatsApp) via
 * GET /api/public/chat/knowledge — the internal bot sees both. That makes the
 * Public list the prospect-facing surface, which is why this card carries an
 * All/Public/Internal filter with counts.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Card, Typography, Switch, Input, Button, Space, Form, message,
  Table, Modal, Segmented, Popconfirm, Tooltip, Empty, Select, InputNumber, Tag,
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, WhatsAppOutlined,
  UploadOutlined, SearchOutlined,
} from '@ant-design/icons';
import { chatApi } from '../../lib/api';

const { Paragraph } = Typography;
const FAQ_CATEGORIES = [
  ['payments','Payments'],['moving_in','Moving in'],['moving_out','Moving out'],
  ['maintenance','Maintenance'],['building_access','Building access'],
  ['lease_renewal','Lease renewal'],['other','Other'],
];

// ---------------------------------------------------------------------------
// Shared hook — both Rules and FAQs use the same chat_knowledge table; we just
// filter by `kind`. (Single source of data in the backend, single fetch here.)
// ---------------------------------------------------------------------------
// `refreshToken` lets the parent page's Refresh button re-fetch WITHOUT remounting
// the card — so the current filter/search selection survives a refresh.
function useKnowledge(filterKind, refreshToken) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const load = useCallback(() => {
    setLoading(true);
    chatApi.listKnowledge()
      .then((r) => setItems((r.data.data || []).filter(x => x.kind === filterKind)))
      .catch(() => message.error('Failed to load'))
      .finally(() => setLoading(false));
  }, [filterKind]);
  useEffect(() => { load(); }, [load, refreshToken]);
  return { items, setItems, loading, load };
}

// Parse free-text pasted FAQs into [{ question, answer }] pairs.
// Accepted formats (most common first):
//   "Q: ...\nA: ..."                  with blank line between pairs
//   "Question: ...\nAnswer: ..."      same idea, longer prefix
//   "Q1. ...\n   A. ..."              numbered with optional prefix punctuation
//   alternating-line style: question on one line, answer on next, blank line
// Returns: [{ question, answer }, ...]. Empty entries are skipped.
export function parseFaqText(text) {
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

// ---------------------------------------------------------------------------
// Card UI — renders either Rules or FAQs depending on `kind`.
// ---------------------------------------------------------------------------
export default function KnowledgeCard({ kind, locked, refreshToken }) {
  const isFaq = kind === 'faq';
  const { items, setItems, loading, load } = useKnowledge(kind, refreshToken);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();
  const [properties, setProperties] = useState([]);
  useEffect(() => { chatApi.listKnowledgeProperties().then(r=>setProperties(r.data.data||[])).catch(()=>{}); }, []);

  // Filter state — client-side, since every entry is already loaded.
  const [visFilter, setVisFilter] = useState('all');   // 'all' | 'public' | 'internal'
  const [search, setSearch] = useState('');

  // Bulk-import (FAQ only) state
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState('');
  const [bulkPublic, setBulkPublic] = useState(false);
  const [bulkSaving, setBulkSaving] = useState(false);
  const bulkParsed = isFaq ? parseFaqText(bulkText) : [];

  // Counts come from the UNFILTERED set for this kind, so the segmented control
  // always shows the true totals (and doubles as the "what's public?" answer).
  const counts = useMemo(() => ({
    all: items.length,
    public: items.filter(i => i.visibility === 'public').length,
    internal: items.filter(i => i.visibility !== 'public').length,
  }), [items]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((i) => {
      if (visFilter === 'public' && i.visibility !== 'public') return false;
      if (visFilter === 'internal' && i.visibility === 'public') return false;
      if (q) {
        // Rules have no title, so search title+body combined — works for both kinds.
        const hay = `${i.title || ''} ${i.body || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [items, visFilter, search]);

  const isFiltering = visFilter !== 'all' || search.trim() !== '';

  const openAdd = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ is_public: false, publish_website:false, title: '', body: '', property_ids:[], sort_order:0, category:'other' });
    setModalOpen(true);
  };
  const openEdit = (item) => {
    setEditing(item);
    form.setFieldsValue({
      title: item.title || '', body: item.body, is_public: item.visibility === 'public',
      publish_website:!!item.publish_website, property_ids:item.property_ids||[],
      sort_order:item.sort_order, category:item.category||'other',
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
        publish_website: isFaq ? !!values.publish_website : false,
        property_ids: values.property_ids || [],
        sort_order: values.sort_order,
        category: isFaq ? values.category : 'other',
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
    { title:'Order', dataIndex:'sort_order', width:70 },
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
    { title:'Scope', width:150, render:(_,item)=> {
      const ps=item.properties||[]; const deleted=ps.filter(p=>p.deleted);
      if(!ps.length)return <Tag color="green">Global</Tag>;
      return <Tooltip title={ps.map(p=>`${p.display_name||p.id}${p.deleted?' (Deleted)':''}`).join(', ')}><span><Tag color={deleted.length===ps.length?'red':'blue'}>{ps.length===1?`Property: ${ps[0].display_name||ps[0].id}`:`${ps.length} properties`}</Tag>{deleted.length===ps.length&&<div style={{fontSize:11,color:'#cf1322'}}>Currently invisible</div>}</span></Tooltip>;
    }},
    ...(isFaq?[{title:'Category',dataIndex:'category',width:120,render:v=><span>{FAQ_CATEGORIES.find(x=>x[0]===v)?.[1]||'Other'}</span>},{title:'Website',dataIndex:'publish_website',width:110,render:v=><Tag color={v?'cyan':'default'}>{v?'Website':'Not on website'}</Tag>}]:[]),
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

      {/* Visibility filter + search. Both are client-side — everything's loaded. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', marginBottom: 12 }}>
        <Segmented
          value={visFilter}
          onChange={setVisFilter}
          options={[
            { label: `All (${counts.all})`, value: 'all' },
            { label: `Public (${counts.public})`, value: 'public' },
            { label: `Internal (${counts.internal})`, value: 'internal' },
          ]}
        />
        <Input
          allowClear
          prefix={<SearchOutlined style={{ color: '#bfbfbf' }} />}
          placeholder={isFaq ? 'Search questions and answers...' : 'Search rules...'}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ width: 280 }}
        />
        {isFiltering && (
          <span style={{ fontSize: 12, color: '#888' }}>
            Showing {filtered.length} of {items.length}
          </span>
        )}
      </div>

      <Table
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={filtered}
        columns={columns}
        pagination={false}
        locale={{
          emptyText: (
            <Empty
              description={
                isFiltering
                  ? `No ${isFaq ? 'FAQs' : 'rules'} match this filter.`
                  : (isFaq
                      ? 'No FAQs yet — click "Add FAQ" or "Bulk Import" to start.'
                      : 'No rules yet — click "Add rule" to start.')
              }
            />
          ),
        }}
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
          {isFaq && <Form.Item name="category" label="Category"><Select options={FAQ_CATEGORIES.map(([value,label])=>({value,label}))}/></Form.Item>}
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
          <Form.Item name="property_ids" label="Properties" extra="Empty means Global — all properties. Scoped content is withheld until the property is known.">
            <Select mode="multiple" showSearch optionFilterProp="label" options={properties.map(p=>({value:String(p.id),label:p.display_name}))}/>
          </Form.Item>
          <Form.Item name="sort_order" label="Order" rules={[{required:true,message:'Enter an order'}]}><InputNumber precision={0} style={{width:'100%'}} /></Form.Item>
          {isFaq && <Form.Item name="publish_website" label="Publish on website" valuePropName="checked"><Switch /></Form.Item>}
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
