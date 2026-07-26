'use client';

import { useEffect, useState, useMemo } from 'react';
import {
  Table, Card, Button, Space, Typography, Modal, Form, Input, message,
  Tag, Tooltip, Select, Divider, Popconfirm, Empty,
} from 'antd';
import {
  SoundOutlined, PlusOutlined, EditOutlined, DeleteOutlined,
  ApartmentOutlined, EyeOutlined, FileTextOutlined, UnorderedListOutlined, StarOutlined, StarFilled,
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

  // Unit-line presets (reusable per-unit lines a template selects)
  const [unitLines, setUnitLines] = useState([]);
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [presetEditing, setPresetEditing] = useState(null); // preset id being edited (null = new)
  const [presetName, setPresetName] = useState('');
  const [presetText, setPresetText] = useState('');
  const [presetSaving, setPresetSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [tRes, pRes, uRes, sRes, lRes] = await Promise.all([
        advertisingApi.listTemplates(),
        advertisingApi.getPlaceholders(),
        advertisingApi.getAssignableUnits(),
        advertisingApi.getAdSettings(),
        // Degrade gracefully if an org DB hasn't migrated the presets table yet —
        // don't let it fail the whole page.
        advertisingApi.listUnitLines().catch(() => ({ data: { code: 0, data: [] } })),
      ]);
      if (tRes.data.code === 200) setTemplates(tRes.data.data || []);
      if (pRes.data.code === 200) setPlaceholders(pRes.data.data || []);
      if (uRes.data.code === 200) setUnits(uRes.data.data || []);
      if (sRes.data.code === 200) setFooter(sRes.data.data.footer || '');
      if (lRes.data.code === 200) setUnitLines(lRes.data.data || []);
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
      ? { name: tpl.name, title: tpl.title, body: tpl.body, unit_line_id: tpl.unit_line_id || null, webpage_link: tpl.webpage_link }
      : { name: '', title: '', body: '', unit_line_id: null, webpage_link: '' });
    setEditorOpen(true);
  };

  const saveTemplate = async () => {
    try {
      const vals = await form.validateFields();
      // Clearing the Unit line select yields `undefined`, which Axios omits from the
      // JSON body — so the backend would never set it back to NULL. Send an explicit
      // null so "clear → follow org default" actually persists.
      vals.unit_line_id = vals.unit_line_id ?? null;
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

  // --- Unit-line presets ----------------------------------------------------
  const resetPresetForm = () => { setPresetEditing(null); setPresetName(''); setPresetText(''); };
  const editPreset = (p) => { setPresetEditing(p.id); setPresetName(p.name); setPresetText(p.line_text || ''); };
  const insertPresetPlaceholder = (token) => setPresetText((t) => (t || '') + token);

  const savePreset = async () => {
    if (!presetName.trim()) { message.error('Preset name is required'); return; }
    setPresetSaving(true);
    try {
      if (presetEditing) {
        await advertisingApi.updateUnitLine(presetEditing, { name: presetName.trim(), line_text: presetText });
        message.success('Preset updated');
      } else {
        await advertisingApi.createUnitLine({ name: presetName.trim(), line_text: presetText });
        message.success('Preset added');
      }
      resetPresetForm();
      const lRes = await advertisingApi.listUnitLines();
      if (lRes.data.code === 200) setUnitLines(lRes.data.data || []);
    } catch (e) {
      message.error(e?.response?.data?.message || 'Failed to save preset');
    } finally { setPresetSaving(false); }
  };

  const setDefaultPreset = async (id) => {
    try {
      await advertisingApi.setDefaultUnitLine(id);
      const lRes = await advertisingApi.listUnitLines();
      if (lRes.data.code === 200) setUnitLines(lRes.data.data || []);
    } catch (e) { message.error('Failed to set default'); }
  };

  const deletePreset = async (id) => {
    try {
      await advertisingApi.deleteUnitLine(id);
      message.success('Preset deleted');
      if (presetEditing === id) resetPresetForm();
      const [lRes, tRes] = await Promise.all([advertisingApi.listUnitLines(), advertisingApi.listTemplates()]);
      if (lRes.data.code === 200) setUnitLines(lRes.data.data || []);
      if (tRes.data.code === 200) setTemplates(tRes.data.data || []);
    } catch (e) { message.error('Failed to delete preset'); }
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
              <Button icon={<UnorderedListOutlined />} onClick={() => { resetPresetForm(); setPresetsOpen(true); }}>Unit Line Presets</Button>
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
          <Form.Item name="unit_line_id" label="Unit line" tooltip="The per-unit line repeated for EACH unit in a bundle. Shared presets live in “Unit Line Presets”; leave as Default to follow the org default.">
            <Select
              allowClear
              placeholder="Default preset (org default)"
              options={unitLines.map(l => ({ value: l.id, label: `${l.name}${l.is_default ? ' (default)' : ''}` }))}
              dropdownRender={(menu) => (
                <>
                  {menu}
                  <Divider style={{ margin: '4px 0' }} />
                  <Button type="link" size="small" onClick={() => { setEditorOpen(false); setPresetsOpen(true); }}>
                    Manage presets…
                  </Button>
                </>
              )}
            />
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

      {/* Unit-line presets manager */}
      <Modal title="Unit Line Presets" open={presetsOpen} onCancel={() => setPresetsOpen(false)}
        footer={null} width={720}>
        <Paragraph type="secondary" style={{ fontSize: 13 }}>
          Reusable per-unit lines shared across templates. A template picks one; the <b>default</b> is used
          when a template has none selected. Edit here once instead of in every template.
        </Paragraph>
        <Table
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={unitLines}
          locale={{ emptyText: <Empty description="No presets yet — add one below." /> }}
          columns={[
            {
              title: 'Name', dataIndex: 'name', key: 'name', width: 160,
              render: (v, r) => (<span><Text strong>{v}</Text>{r.is_default && <Tag color="gold" style={{ marginLeft: 6 }}>Default</Tag>}</span>),
            },
            {
              title: 'Line', dataIndex: 'line_text', key: 'line_text',
              render: (v) => <Text type="secondary" style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>{v || '—'}</Text>,
            },
            {
              title: '', key: 'actions', width: 120,
              render: (_, r) => (
                <Space size={2}>
                  <Tooltip title={r.is_default ? 'Default' : 'Make default'}>
                    <Button size="small" type="text" icon={r.is_default ? <StarFilled style={{ color: '#faad14' }} /> : <StarOutlined />}
                      disabled={r.is_default} onClick={() => setDefaultPreset(r.id)} />
                  </Tooltip>
                  <Button size="small" type="text" icon={<EditOutlined />} onClick={() => editPreset(r)} />
                  <Popconfirm title="Delete this preset?" description="Templates using it fall back to the default."
                    onConfirm={() => deletePreset(r.id)} okText="Delete" okButtonProps={{ danger: true }}>
                    <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
        <Divider style={{ margin: '16px 0 12px' }} />
        <Text strong style={{ fontSize: 13 }}>{presetEditing ? 'Edit preset' : 'Add preset'}</Text>
        <Input style={{ marginTop: 8 }} placeholder="Preset name (e.g. Default)" value={presetName}
          onChange={(e) => setPresetName(e.target.value)} />
        <TextArea style={{ marginTop: 8 }} rows={3} value={presetText} onChange={(e) => setPresetText(e.target.value)}
          placeholder="%UnitName% (%Layout% unit - %Size%): Unit has a %BedSize% bed, Available from %AvailableDate%, and price is HKD$%PostingRentAmount% per month." />
        <div style={{ marginTop: 6 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>Insert placeholder:</Text>
          <div style={{ marginTop: 6 }}>
            <Space wrap size={[4, 4]}>
              {placeholders.map(p => (
                <Tooltip key={p.token} title={p.description}>
                  <Tag style={{ cursor: 'pointer' }} onClick={() => insertPresetPlaceholder(p.token)}>{p.token}</Tag>
                </Tooltip>
              ))}
            </Space>
          </div>
        </div>
        <Space style={{ marginTop: 12 }}>
          <Button type="primary" loading={presetSaving} onClick={savePreset}>{presetEditing ? 'Update preset' : 'Add preset'}</Button>
          {presetEditing && <Button onClick={resetPresetForm}>Cancel edit</Button>}
        </Space>
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
