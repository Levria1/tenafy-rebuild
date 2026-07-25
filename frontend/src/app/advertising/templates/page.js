'use client';

import { useEffect, useState, useMemo } from 'react';
import {
  Table, Card, Button, Space, Typography, Modal, Form, Input, message,
  Tag, Tooltip, Select, Divider, Popconfirm, Empty,
} from 'antd';
import {
  SoundOutlined, PlusOutlined, EditOutlined, DeleteOutlined,
  ApartmentOutlined, EyeOutlined, FileTextOutlined,
} from '@ant-design/icons';
import MainLayout from '../../../components/Layout';
import { advertisingApi } from '../../../lib/api';

const { Title, Text, Paragraph } = Typography;
const { TextArea } = Input;

export default function TemplatesPage() {
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [placeholders, setPlaceholders] = useState([]);
  const [units, setUnits] = useState([]);

  // Editor modal
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState(null); // template being edited (null = new)
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  // Assignment modal
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignTarget, setAssignTarget] = useState(null);
  const [assignUnitIds, setAssignUnitIds] = useState([]);
  const [assignSaving, setAssignSaving] = useState(false);

  // Preview
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewTemplate, setPreviewTemplate] = useState(null);
  const [previewUnitId, setPreviewUnitId] = useState(null);
  const [previewData, setPreviewData] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  // Shared footer (org-wide, appended to every post)
  const [footerOpen, setFooterOpen] = useState(false);
  const [footer, setFooter] = useState('');
  const [footerSaving, setFooterSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [tRes, pRes, uRes, sRes] = await Promise.all([
        advertisingApi.listTemplates(),
        advertisingApi.getPlaceholders(),
        advertisingApi.getAssignableUnits(),
        advertisingApi.getAdSettings(),
      ]);
      if (tRes.data.code === 200) setTemplates(tRes.data.data || []);
      if (pRes.data.code === 200) setPlaceholders(pRes.data.data || []);
      if (uRes.data.code === 200) setUnits(uRes.data.data || []);
      if (sRes.data.code === 200) setFooter(sRes.data.data.footer || '');
    } catch (e) {
      message.error('Failed to load templates');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // --- Editor ---------------------------------------------------------------
  const openEditor = (tpl) => {
    setEditing(tpl || null);
    form.setFieldsValue(tpl
      ? { name: tpl.name, title: tpl.title, body: tpl.body, per_unit_line: tpl.per_unit_line, webpage_link: tpl.webpage_link }
      : { name: '', title: '', body: '', per_unit_line: '', webpage_link: '' });
    setEditorOpen(true);
  };

  const saveTemplate = async () => {
    try {
      const vals = await form.validateFields();
      setSaving(true);
      if (editing) {
        await advertisingApi.updateTemplate(editing.id, vals);
        message.success('Template updated');
      } else {
        await advertisingApi.createTemplate(vals);
        message.success('Template created');
      }
      setEditorOpen(false);
      load();
    } catch (e) {
      if (e?.errorFields) return; // validation
      message.error('Failed to save template');
    } finally {
      setSaving(false);
    }
  };

  // Insert a placeholder token into the Body field at the end (simple + reliable).
  const insertPlaceholder = (token) => {
    const cur = form.getFieldValue('body') || '';
    form.setFieldsValue({ body: cur + token });
  };

  // --- Assignment -----------------------------------------------------------
  const openAssign = async (tpl) => {
    setAssignTarget(tpl);
    // Pre-select units already on this template.
    setAssignUnitIds(units.filter(u => u.assigned_template_id === tpl.id).map(u => u.unit_id));
    setAssignOpen(true);
  };

  const saveAssign = async () => {
    setAssignSaving(true);
    try {
      await advertisingApi.assignTemplate(assignTarget.id, assignUnitIds);
      message.success('Units assigned');
      setAssignOpen(false);
      load();
    } catch (e) {
      message.error('Failed to assign units');
    } finally {
      setAssignSaving(false);
    }
  };

  // Options for the assignment select, grouped by property. A unit already on a
  // DIFFERENT template is labelled so the user knows reassigning moves it.
  const unitOptions = useMemo(() => {
    const byProp = {};
    for (const u of units) {
      (byProp[u.property_name] ||= []).push(u);
    }
    return Object.entries(byProp).map(([prop, us]) => ({
      label: prop,
      options: us.map(u => {
        const otherTpl = u.assigned_template_id && assignTarget && u.assigned_template_id !== assignTarget.id;
        return {
          value: u.unit_id,
          label: `${u.property_name} ${u.unit_name}${otherTpl ? ' · (on another template)' : ''}`,
        };
      }),
    }));
  }, [units, assignTarget]);

  // --- Preview --------------------------------------------------------------
  const saveFooter = async () => {
    setFooterSaving(true);
    try {
      await advertisingApi.updateAdSettings({ footer });
      message.success('Footer saved');
      setFooterOpen(false);
    } catch (e) { message.error('Failed to save footer'); }
    finally { setFooterSaving(false); }
  };

  const openPreview = async (tpl) => {
    setPreviewTemplate(tpl);
    const assigned = units.filter(u => u.assigned_template_id === tpl.id);
    const firstUnit = assigned[0]?.unit_id || units[0]?.unit_id || null;
    setPreviewUnitId(firstUnit);
    setPreviewData(null);
    setPreviewOpen(true);
    if (firstUnit) runPreview(tpl.id, firstUnit);
  };

  const runPreview = async (templateId, unitId) => {
    if (!unitId) return;
    setPreviewLoading(true);
    try {
      const res = await advertisingApi.previewTemplate(templateId, unitId);
      if (res.data.code === 200) setPreviewData(res.data.data);
    } catch (e) {
      message.error('Failed to render preview');
    } finally {
      setPreviewLoading(false);
    }
  };

  const columns = [
    {
      title: 'Template',
      dataIndex: 'name',
      key: 'name',
      render: (v, r) => (
        <div>
          <Text strong>{v}</Text>
          {r.status === 0 && <Tag style={{ marginLeft: 8 }}>Archived</Tag>}
          {r.title ? <div><Text type="secondary" style={{ fontSize: 12 }}>{r.title}</Text></div> : null}
        </div>
      ),
    },
    {
      title: 'Assigned Units',
      dataIndex: 'unit_count',
      key: 'unit_count',
      width: 140,
      render: (v) => <Tag color={v > 0 ? 'blue' : 'default'} icon={<ApartmentOutlined />}>{v} unit{v === 1 ? '' : 's'}</Tag>,
    },
    {
      title: 'Webpage',
      dataIndex: 'webpage_link',
      key: 'webpage_link',
      width: 180,
      render: (v) => v
        ? <a href={v} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>{v.length > 26 ? v.slice(0, 26) + '…' : v}</a>
        : <Text type="secondary">—</Text>,
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 240,
      render: (_, r) => (
        <Space size="small">
          <Button size="small" icon={<EyeOutlined />} onClick={() => openPreview(r)}>Preview</Button>
          <Button size="small" icon={<ApartmentOutlined />} onClick={() => openAssign(r)}>Assign</Button>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEditor(r)} />
          <Popconfirm
            title="Delete this template?"
            description="Assigned units will be unassigned."
            onConfirm={async () => { await advertisingApi.deleteTemplate(r.id); message.success('Deleted'); load(); }}
            okText="Delete" okButtonProps={{ danger: true }}
          >
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <MainLayout>
      <div style={{ padding: 24 }}>
        <Space align="center" style={{ marginBottom: 4 }} className="header-row">
          <SoundOutlined style={{ fontSize: 22, color: '#1677ff' }} />
          <Title level={3} style={{ margin: 0 }}>Templates</Title>
        </Space>
        <div style={{ marginBottom: 16 }}>
          <Text type="secondary">
            Ad copy for listings — reusable across a property&apos;s units. Insert
            <Tag style={{ margin: '0 4px' }}>%Placeholders%</Tag>
            that auto-fill each unit&apos;s details. Forum, account and schedule are set separately in Scheduler.
          </Text>
        </div>

        <Card styles={{ body: { padding: 16 } }} style={{ borderColor: '#e8e8e8' }}>
          <div style={{ marginBottom: 16 }}>
            <Space>
              <Button type="primary" icon={<PlusOutlined />} onClick={() => openEditor(null)}>New Template</Button>
              <Button icon={<FileTextOutlined />} onClick={() => setFooterOpen(true)}>Shared Footer</Button>
            </Space>
          </div>
          <Table
            rowKey="id"
            columns={columns}
            dataSource={templates}
            loading={loading}
            pagination={false}
            locale={{ emptyText: <Empty description="No templates yet — create one to start." /> }}
          />
        </Card>
      </div>

      {/* Editor modal */}
      <Modal
        title={editing ? 'Edit Template' : 'New Template'}
        open={editorOpen}
        onCancel={() => setEditorOpen(false)}
        onOk={saveTemplate}
        confirmLoading={saving}
        okText="Save"
        width={720}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="Template name" rules={[{ required: true, message: 'Name is required' }]}>
            <Input placeholder="e.g. Poplar — standard listing" />
          </Form.Item>
          <Form.Item name="title" label="First line" tooltip="Facebook posts have no title — this is just the opening line of the post. For a bundle it's rendered from the lowest-priced unit.">
            <Input placeholder="e.g. %PropertyName% Serviced Studios - $%PostingRentAmount% HKD and Up" />
          </Form.Item>
          <Form.Item name="body" label="Body (shared)" tooltip="Posted once per bundle — the building/area copy shared by all its units.">
            <TextArea rows={6} placeholder="Describe the unit/building. Use %Placeholders% below to auto-fill unit details." />
          </Form.Item>
          <Form.Item name="per_unit_line" label="Per-unit line" tooltip="Repeated once for EACH unit in a bundled post (the line that differs). e.g. Unit %UnitName% — available %AvailableDate%, %Rent%/mo">
            <Input placeholder="Unit %UnitName% — available %AvailableDate%, %Rent%/mo" />
          </Form.Item>
          <div style={{ marginBottom: 12 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>Insert placeholder:</Text>
            <div style={{ marginTop: 6 }}>
              <Space wrap size={[4, 4]}>
                {placeholders.map(p => (
                  <Tooltip key={p.token} title={p.description}>
                    <Tag style={{ cursor: 'pointer' }} onClick={() => insertPlaceholder(p.token)}>{p.token}</Tag>
                  </Tooltip>
                ))}
              </Space>
            </div>
          </div>
          <Form.Item name="webpage_link" label="Webpage link">
            <Input placeholder="https://your-site.com/listing/…" />
          </Form.Item>
        </Form>
      </Modal>

      {/* Shared footer modal */}
      <Modal title="Shared Footer" open={footerOpen} onCancel={() => setFooterOpen(false)}
        onOk={saveFooter} confirmLoading={footerSaving} okText="Save">
        <Paragraph type="secondary" style={{ fontSize: 13 }}>
          Appended to the end of <b>every</b> post (contact info, minimum rental, etc.) — one shared footer across all templates.
        </Paragraph>
        <TextArea rows={4} value={footer} onChange={(e) => setFooter(e.target.value)}
          placeholder="If you're interested, please contact +852 …  Minimum one month rental." />
      </Modal>

      {/* Assignment modal */}
      <Modal
        title={`Assign units — ${assignTarget?.name || ''}`}
        open={assignOpen}
        onCancel={() => setAssignOpen(false)}
        onOk={saveAssign}
        confirmLoading={assignSaving}
        okText="Save assignment"
        width={640}
      >
        <Paragraph type="secondary" style={{ fontSize: 13 }}>
          Each unit can be on only one template. Selecting a unit already on another template moves it here.
        </Paragraph>
        <Select
          mode="multiple"
          allowClear
          style={{ width: '100%' }}
          placeholder="Select units to post with this template"
          value={assignUnitIds}
          onChange={setAssignUnitIds}
          options={unitOptions}
          optionFilterProp="label"
          maxTagCount="responsive"
        />
        {/* Readable summary of what's chosen, grouped by property. */}
        {assignUnitIds.length > 0 && (() => {
          const chosen = units.filter(u => assignUnitIds.includes(u.unit_id));
          const byProp = {};
          for (const u of chosen) (byProp[u.property_name] ||= []).push(u.unit_name);
          return (
            <div style={{ marginTop: 12 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>Selected ({chosen.length}):</Text>
              <div style={{ marginTop: 6 }}>
                {Object.entries(byProp).map(([prop, us]) => (
                  <div key={prop} style={{ marginBottom: 4 }}>
                    <Text strong>{prop}</Text>: <Text>{us.join(', ')}</Text>
                  </div>
                ))}
              </div>
            </div>
          );
        })()}
      </Modal>

      {/* Preview modal */}
      <Modal
        title={`Preview — ${previewTemplate?.name || ''}`}
        open={previewOpen}
        onCancel={() => setPreviewOpen(false)}
        footer={null}
        width={640}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <div>
            <Text type="secondary" style={{ fontSize: 12 }}>Preview as unit:</Text>
            <Select
              style={{ width: '100%', marginTop: 4 }}
              showSearch
              optionFilterProp="label"
              value={previewUnitId}
              onChange={(v) => { setPreviewUnitId(v); runPreview(previewTemplate.id, v); }}
              options={units.map(u => ({ value: u.unit_id, label: `${u.property_name} · ${u.unit_name}` }))}
              placeholder="Pick a unit"
            />
          </div>
          <Divider style={{ margin: '12px 0' }} />
          {previewLoading ? <Text type="secondary">Rendering…</Text> : previewData ? (
            <div style={{ background: '#fafafa', border: '1px solid #f0f0f0', borderRadius: 6, padding: 16 }}>
              {previewData.title ? <Title level={5} style={{ marginTop: 0 }}>{previewData.title}</Title> : null}
              <Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: previewData.webpage_link ? 12 : 0 }}>
                {previewData.body || <Text type="secondary">(empty body)</Text>}
              </Paragraph>
              {previewData.webpage_link ? <a href={previewData.webpage_link} target="_blank" rel="noreferrer">{previewData.webpage_link}</a> : null}
            </div>
          ) : <Text type="secondary">Pick a unit to preview.</Text>}
        </Space>
      </Modal>
    </MainLayout>
  );
}
