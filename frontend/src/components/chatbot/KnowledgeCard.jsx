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
 * Public list the prospect-facing surface. The website is a SEPARATE destination
 * (publish_website), so the filter is one tab per audience — All / Website /
 * TaneChat / Tenafy (Internal) — with counts. An entry can be on more than one,
 * so the tabs overlap by design; Tenafy (Internal) means shared with nobody else.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Card, Typography, Input, Button, Space, Form, message,
  Table, Modal, Segmented, Popconfirm, Tooltip, Empty, Select, InputNumber, Tag, Checkbox, Upload,
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, WhatsAppOutlined,
  UploadOutlined, SearchOutlined, ArrowUpOutlined, ArrowDownOutlined,
} from '@ant-design/icons';
import Cookies from 'js-cookie';
import { chatApi } from '../../lib/api';

const { Paragraph, Text } = Typography;
// Ordered to match how a resident actually reads the page, and sized to the real
// corpus rather than guessed: the counts are how the 220 entries of the 2026 Tane
// Public FAQ document actually cluster.
//
// The original seven were designed for a LEASING FAQ. That document is a tenant
// handbook, and three of them — moving_in, moving_out, lease_renewal — matched
// almost nothing in it while a third of the entries are fuse boxes, appliances
// and water. Those three are kept anyway: they are correct for the leasing
// questions already in the database, and dropping a category would orphan the
// entries filed under it.
//
// MUST stay in sync with FAQ_CATEGORIES in backend/src/routes/chat.js — that list
// is the validator, and a value only present here is silently rewritten to 'other'
// on save.
const FAQ_CATEGORIES = [
  ['your_unit','Your unit'],                    // 40 entries — appliances, fittings, how things work
  ['power','Power & fuse boxes'],               // 36 — the single biggest cluster of photographs
  ['appliances_laundry','Appliances & laundry'],// 36
  ['water_heating','Water, heating & drains'],  // 26
  ['getting_here','Getting here & addresses'],  // 24
  ['internet','Internet & wifi'],               // 19
  ['rubbish','Rubbish & recycling'],            // 18
  ['building_access','Building access'],        // access, keys, doors
  ['access_safety','Access & safety'],          // 7 — fire, emergencies
  ['nearby','Nearby'],                          // 5 — shops, transport
  ['house_rules','House rules'],                // noise, pets, guests
  ['payments','Payments'],                      // 8
  ['maintenance','Maintenance'],                // reporting faults
  ['moving_in','Moving in'],
  ['moving_out','Moving out'],
  ['lease_renewal','Lease renewal'],
  // Bot-only. These two are EXCLUDED FROM THE PUBLIC FAQ PAGE IN SQL — not hidden
  // by the browser — so the content never leaves the server, whatever the
  // "Website" toggle on the entry says. Deliberately belt-and-braces: the toggle
  // is a per-entry setting someone can tick wrongly, the category is a standing
  // statement about what the content is.
  ['internal_private','Internal (Private)'],
  ['inquiries','Inquiries (Not on FAQ)'],
  ['other','Other'],
];

// Keep in step with WEBSITE_HIDDEN_CATEGORIES in backend/src/utils/faqCategories.js.
// Used to warn in the edit form when an entry is filed bot-only but ticked for the
// website — the category wins, and the operator should not have to discover that
// by checking the live site.
const WEBSITE_HIDDEN_CATEGORIES = ['internal_private', 'inquiries'];

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
  const [faqImages, setFaqImages] = useState([]);
  const [properties, setProperties] = useState([]);
  useEffect(() => { chatApi.listKnowledgeProperties().then(r=>setProperties(r.data.data||[])).catch(()=>{}); }, []);

  // Filter state — client-side, since every entry is already loaded.
  const [visFilter, setVisFilter] = useState('all');   // 'all' | 'website' | 'tanechat' | 'internal'
  const [search, setSearch] = useState('');

  // Bulk-import (FAQ only) state
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState('');
  const [bulkPublic, setBulkPublic] = useState(true);
  const [bulkWebsite, setBulkWebsite] = useState(true);
  const [bulkSaving, setBulkSaving] = useState(false);
  const bulkParsed = isFaq ? parseFaqText(bulkText) : [];

  // Counts come from the UNFILTERED set for this kind, so the segmented control
  // always shows the true totals (and doubles as the "what's public?" answer).
  // One filter per AUDIENCE, matching the "Shared with" column exactly. The old
  // Public/Internal pair predated the website as a separate destination, so an
  // entry on the website but not shared with TaneChat counted as "Internal" —
  // which read as "nobody outside sees this" about a row published to the open
  // internet. The audiences are not mutually exclusive: an entry can be on the
  // website AND with TaneChat, so it is counted under both. Tenafy always sees
  // everything, so "Tenafy (Internal)" means ONLY Tenafy — shared with no one.
  const counts = useMemo(() => ({
    all: items.length,
    website: items.filter(i => !!i.publish_website).length,
    tanechat: items.filter(i => i.visibility === 'public').length,
    internal: items.filter(i => i.visibility !== 'public' && !i.publish_website).length,
  }), [items]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((i) => {
      if (visFilter === 'website' && !i.publish_website) return false;
      if (visFilter === 'tanechat' && i.visibility !== 'public') return false;
      if (visFilter === 'internal' && (i.visibility === 'public' || i.publish_website)) return false;
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
    setFaqImages([]);
    // A new FAQ is shared everywhere; a new rule is a team instruction, so TaneChat only.
    form.setFieldsValue({ is_public: true, publish_website: isFaq, title: '', body: '', property_ids:[], sort_order:0, category:'other' });
    setModalOpen(true);
  };
  const openEdit = (item) => {
    setEditing(item);
    form.setFieldsValue({
      title: item.title || '', body: item.body, is_public: item.visibility === 'public',
      publish_website:!!item.publish_website, property_ids:item.property_ids||[],
      sort_order:item.sort_order, category:item.category||'other',
    });
    setFaqImages((item.images || []).slice().sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0)).map((img) => ({
      uid: String(img.id || img.file_id),
      name: img.caption || `Image ${img.file_id}`,
      status: 'done',
      url: img.url,
      file_id: String(img.file_id),
      caption: img.caption || '',
    })));
    setModalOpen(true);
  };

  const uploadHeaders = useMemo(() => {
    const token = Cookies.get('__s_t');
    return token ? { Authorization: `Bearer ${token}` } : {};
  }, [modalOpen]);

  const beforeFaqImageUpload = (file) => {
    const allowed = ['image/png', 'image/jpeg', 'image/webp'];
    if (!allowed.includes(file.type)) {
      message.error('Only PNG, JPEG, or WebP images can be uploaded.');
      return Upload.LIST_IGNORE;
    }
    if (file.size > 8 * 1024 * 1024) {
      message.error('Image must be 8 MB or smaller.');
      return Upload.LIST_IGNORE;
    }
    if (faqImages.length >= 12) {
      message.error('A FAQ can have at most 12 images.');
      return Upload.LIST_IGNORE;
    }
    return true;
  };

  const handleFaqImageChange = ({ file, fileList }) => {
    if (file.status === 'error') {
      message.error(file.response?.message || 'Image upload failed.');
    }
    setFaqImages((prev) => fileList.slice(0, 12).map((f) => {
      const existing = prev.find((p) => p.uid === f.uid);
      const uploaded = f.response?.data || {};
      return {
        ...f,
        file_id: uploaded.id ? String(uploaded.id) : f.file_id,
        url: uploaded.url || f.url,
        caption: existing?.caption ?? f.caption ?? '',
      };
    }));
  };

  const updateFaqImageCaption = (uid, caption) => {
    setFaqImages((prev) => prev.map((img) => img.uid === uid ? { ...img, caption: caption.slice(0, 255) } : img));
  };

  const moveFaqImage = (uid, direction) => {
    setFaqImages((prev) => {
      const next = [...prev];
      const index = next.findIndex((img) => img.uid === uid);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const removeFaqImage = (uid) => {
    setFaqImages((prev) => prev.filter((img) => img.uid !== uid));
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
      if (isFaq) {
        // An image only has a file_id once its upload has come back. Filtering silently would
        // mean a staff member who hits Save a second too early watches the thumbnail sit in the
        // modal and then finds the picture missing from the answer, with nothing having gone
        // wrong on screen. Say so instead of dropping it.
        const pending = faqImages.filter((img) => !img.file_id);
        if (pending.length) {
          const stillGoing = pending.some((img) => img.status === 'uploading');
          message.error(stillGoing
            ? 'An image is still uploading. Wait for it to finish, then save.'
            : 'An image failed to upload. Remove it or try again before saving.');
          setSaving(false);
          return;
        }
        payload.images = faqImages
          .map((img) => ({ file_id: String(img.file_id), caption: img.caption || null }));
      }
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
        // Sent explicitly rather than left to the server default, so what the operator ticked is
        // what happens — a pasted list is the easiest way to put a lot of text on the internet.
        publish_website: isFaq && bulkWebsite,
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
    ...(isFaq?[{title:'Category',dataIndex:'category',width:120,render:v=><span>{FAQ_CATEGORIES.find(x=>x[0]===v)?.[1]||'Other'}</span>}]:[]),
    {
      title: (
        <Tooltip title="Who this entry reaches. Tenafy's own assistant always sees it; TaneChat answers customers on WhatsApp; Website means taneresidence.com/faq. Edit an entry to change them.">
          <span><WhatsAppOutlined /> Shared with</span>
        </Tooltip>
      ),
      dataIndex: 'visibility',
      width: 200,
      align: 'center',
      // Read-only here on purpose: two independent audiences need a form where the consequence is
      // spelled out, not a toggle in a dense row that publishes to the open internet in one click.
      render: (visibility, item) => (
        <Space size={4} wrap>
          <Tag>Tenafy</Tag>
          {visibility === 'public' ? <Tag color="green">TaneChat</Tag> : null}
          {item.publish_website ? <Tag color="cyan">Website</Tag> : null}
          {visibility !== 'public' && !item.publish_website
            ? <Text type="secondary" style={{ fontSize: 12 }}>staff only</Text> : null}
        </Space>
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
            { label: `Website (${counts.website})`, value: 'website' },
            { label: `TaneChat (${counts.tanechat})`, value: 'tanechat' },
            { label: `Tenafy (Internal) (${counts.internal})`, value: 'internal' },
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
          {isFaq && (
            <Form.Item label="Images">
              <Upload
                action={`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'}/api/file/image/upload`}
                headers={uploadHeaders}
                accept="image/png,image/jpeg,image/webp"
                listType="picture-card"
                fileList={faqImages}
                beforeUpload={beforeFaqImageUpload}
                onChange={handleFaqImageChange}
                onRemove={(file) => { removeFaqImage(file.uid); return true; }}
                showUploadList={{ showRemoveIcon: false, showPreviewIcon: false }}
                itemRender={(originNode, file) => {
                  const index = faqImages.findIndex((img) => img.uid === file.uid);
                  return (
                    <div style={{ width: 104 }}>
                      {originNode}
                      <Input
                        size="small"
                        maxLength={255}
                        placeholder="Caption (optional)"
                        value={file.caption || ''}
                        onChange={(e) => updateFaqImageCaption(file.uid, e.target.value)}
                        style={{ marginTop: 6 }}
                      />
                      <Space size={4} style={{ marginTop: 4 }}>
                        <Button size="small" icon={<ArrowUpOutlined />} disabled={index <= 0} onClick={() => moveFaqImage(file.uid, -1)} />
                        <Button size="small" icon={<ArrowDownOutlined />} disabled={index < 0 || index >= faqImages.length - 1} onClick={() => moveFaqImage(file.uid, 1)} />
                        <Button size="small" danger icon={<DeleteOutlined />} onClick={() => removeFaqImage(file.uid)} />
                      </Space>
                    </div>
                  );
                }}
              >
                {faqImages.length >= 12 ? null : (
                  <div>
                    <PlusOutlined />
                    <div style={{ marginTop: 8 }}>Upload</div>
                  </div>
                )}
              </Upload>
            </Form.Item>
          )}
          <Form.Item name="property_ids" label="Properties" extra="Empty means Global — all properties. Scoped content is withheld until the property is known.">
            <Select mode="multiple" showSearch optionFilterProp="label" options={properties.map(p=>({value:String(p.id),label:p.display_name}))}/>
          </Form.Item>
          <Form.Item name="sort_order" label="Order" rules={[{required:true,message:'Enter an order'}]}><InputNumber precision={0} style={{width:'100%'}} /></Form.Item>
          {/* One question — who sees this? — instead of two switches that could contradict each
              other. The three audiences are independent: turning one off does not turn another
              off. Tenafy itself is shown but not editable, because an entry is always available
              to your own assistant; that is where it lives. */}
          <Form.Item label="Shared with" extra={isFaq
            ? 'Each is separate. Turning off TaneChat does not take it off the website.'
            : 'Rules are team instructions, so they are never published on the website.'}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <Checkbox checked disabled>
                Tenafy <Text type="secondary" style={{ fontSize: 12 }}>— your own assistant, always</Text>
              </Checkbox>
              <Form.Item name="is_public" valuePropName="checked" noStyle>
                <Checkbox disabled={locked}>
                  TaneChat <Text type="secondary" style={{ fontSize: 12 }}>— answers customers on WhatsApp</Text>
                </Checkbox>
              </Form.Item>
              <Form.Item name="publish_website" valuePropName="checked" noStyle>
                <Checkbox disabled={locked || !isFaq}>
                  Website <Text type="secondary" style={{ fontSize: 12 }}>— taneresidence.com/faq, visible to anyone</Text>
                </Checkbox>
              </Form.Item>
              {/* The category overrides this tick, and silently — the entry saves,
                  the Website tag shows in the table, and it still never appears on
                  the site. Say so here rather than let it be discovered by looking. */}
              <Form.Item noStyle shouldUpdate={(prev, cur) => prev.category !== cur.category || prev.publish_website !== cur.publish_website}>
                {({ getFieldValue }) => (
                  isFaq && getFieldValue('publish_website') && WEBSITE_HIDDEN_CATEGORIES.includes(getFieldValue('category'))
                    ? (
                      <Text type="warning" style={{ fontSize: 12, marginTop: 4 }}>
                        This category is never shown on the website. The entry stays available to
                        Tenafy and TaneChat, but the Website tick above has no effect.
                      </Text>
                    ) : null
                )}
              </Form.Item>
            </div>
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
            <Space size={12}>
              <span style={{ fontSize: 12, color: '#666' }}>Share all with:</span>
              <Checkbox checked={bulkPublic} onChange={(e) => setBulkPublic(e.target.checked)}>
                <span style={{ fontSize: 12 }}>TaneChat</span>
              </Checkbox>
              <Checkbox checked={bulkWebsite} disabled={!isFaq} onChange={(e) => setBulkWebsite(e.target.checked)}>
                <span style={{ fontSize: 12 }}>Website</span>
              </Checkbox>
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
