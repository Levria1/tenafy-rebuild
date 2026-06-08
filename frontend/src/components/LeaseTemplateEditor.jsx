'use client';

/**
 * Lease template editor — used by both /settings/lease-templates/create
 * and /settings/lease-templates/[id]/edit.
 *
 * Layout (desktop):
 *   ┌─ Form (left, ~55%) ─────────┐ ┌─ Live preview (right, ~45%) ──┐
 *   │  Name, description, default │ │  PDF iframe                   │
 *   │  Quill body editor          │ │  ▼ refreshes after each save  │
 *   │    + Insert Variable picker │ │    or "Preview" click         │
 *   │  Header / Footer / Page size │ │                              │
 *   │  [Save]  [Cancel]  [Preview] │ │                              │
 *   └──────────────────────────────┘ └──────────────────────────────┘
 *
 * On mobile we stack vertically: form on top, preview at bottom.
 */

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import {
  Card, Form, Input, Button, Space, message, Select, Switch, Row, Col,
  Dropdown, Empty, Spin,
} from 'antd';
import {
  SaveOutlined, EyeOutlined, ThunderboltOutlined, ArrowLeftOutlined,
} from '@ant-design/icons';
import { leaseTemplate } from '../lib/api';

const ReactQuill = dynamic(() => import('react-quill-new'), { ssr: false });
import 'react-quill-new/dist/quill.snow.css';

// Quill toolbar — keep it close to email-templates for consistency, plus a
// table option since lease docs often need tables.
const quillModules = {
  toolbar: [
    [{ header: [1, 2, 3, false] }],
    ['bold', 'italic', 'underline', 'strike'],
    [{ color: [] }, { background: [] }],
    [{ font: [] }],
    [{ size: ['small', false, 'large', 'huge'] }],
    [{ list: 'ordered' }, { list: 'bullet' }],
    [{ indent: '-1' }, { indent: '+1' }],
    [{ align: [] }],
    ['link'],
    ['clean'],
  ],
};

export default function LeaseTemplateEditor({ mode, templateId }) {
  // mode: 'create' | 'edit'
  const router = useRouter();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [bodyHtml, setBodyHtml] = useState('');
  const [headerHtml, setHeaderHtml] = useState('');
  const [footerHtml, setFooterHtml] = useState('');
  const [variables, setVariables] = useState([]);
  const quillRef = useRef(null);

  // Load variable registry for the "Insert Variable" dropdown.
  useEffect(() => {
    leaseTemplate.variables()
      .then(r => { if (r.data?.code === 200) setVariables(r.data.data || []); })
      .catch(() => {});
  }, []);

  // If editing, load the template.
  useEffect(() => {
    if (mode !== 'edit' || !templateId) return;
    setLoading(true);
    leaseTemplate.get(templateId)
      .then(r => {
        if (r.data?.code === 200) {
          const t = r.data.data;
          form.setFieldsValue({
            name: t.name,
            description: t.description || '',
            page_size: t.page_size || 'A4',
            is_default: !!t.is_default,
          });
          setBodyHtml(t.body_html || '');
          setHeaderHtml(t.header_html || '');
          setFooterHtml(t.footer_html || '');
        }
      })
      .catch(() => message.error('Failed to load template'))
      .finally(() => setLoading(false));
  }, [mode, templateId]);

  // Build a {{KEY}} insert dropdown grouped by variable.group.
  const variableDropdown = (() => {
    const byGroup = variables.reduce((acc, v) => {
      (acc[v.group] = acc[v.group] || []).push(v);
      return acc;
    }, {});
    const items = Object.entries(byGroup).map(([group, vs]) => ({
      key: `g-${group}`,
      type: 'group',
      label: group,
      children: vs.map(v => ({
        key: v.key,
        label: (
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
            <span>{v.label}</span>
            <code style={{ color: '#1677ff', fontSize: 11 }}>{`{{${v.key}}}`}</code>
          </div>
        ),
        onClick: () => insertVariable(v.key),
      })),
    }));
    return { items };
  })();

  function insertVariable(key) {
    // Inserts at current Quill caret position. If editor not focused, appends.
    const editor = quillRef.current?.getEditor?.();
    if (editor) {
      const range = editor.getSelection(true);
      editor.insertText(range ? range.index : editor.getLength(), `{{${key}}}`, 'user');
      editor.setSelection((range ? range.index : editor.getLength()) + key.length + 4);
    } else {
      setBodyHtml(prev => prev + `{{${key}}}`);
    }
  }

  const onPreview = async () => {
    setPreviewLoading(true);
    try {
      const r = await leaseTemplate.previewInline({
        body_html: bodyHtml,
        header_html: headerHtml,
        footer_html: footerHtml,
        page_size: form.getFieldValue('page_size') || 'A4',
      });
      const url = URL.createObjectURL(new Blob([r.data], { type: 'application/pdf' }));
      // Revoke prior blob URL to avoid leaking memory across previews.
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(url);
    } catch (e) {
      message.error('Preview failed. Check the body for invalid HTML.');
    } finally {
      setPreviewLoading(false);
    }
  };

  const onFinish = async (values) => {
    if (!bodyHtml || !bodyHtml.replace(/<[^>]+>/g, '').trim()) {
      message.error('Body is empty — add at least some lease content first.');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: values.name,
        description: values.description || '',
        page_size: values.page_size || 'A4',
        is_default: !!values.is_default,
        body_html: bodyHtml,
        header_html: headerHtml || '',
        footer_html: footerHtml || '',
      };
      const r = mode === 'edit'
        ? await leaseTemplate.update(templateId, payload)
        : await leaseTemplate.create(payload);
      if (r.data?.code === 200) {
        message.success(mode === 'edit' ? 'Template saved' : 'Template created');
        router.push('/settings/lease-templates');
      } else {
        message.error(r.data?.message || 'Save failed');
      }
    } catch (e) {
      message.error(e.response?.data?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ padding: '0 0 24px 0' }}>
      <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => router.push('/settings/lease-templates')}>
          Back
        </Button>
        <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0, color: '#333' }}>
          {mode === 'edit' ? 'Edit Lease Template' : 'New Lease Template'}
        </h2>
      </div>

      <Spin spinning={loading}>
        <Row gutter={16}>
          <Col xs={24} lg={14}>
            <Card>
              <Form form={form} layout="vertical" onFinish={onFinish}
                initialValues={{ page_size: 'A4', is_default: false }}>
                <Row gutter={16}>
                  <Col span={16}>
                    <Form.Item label="Name" name="name" rules={[{ required: true, message: 'Name is required' }]}>
                      <Input placeholder='e.g. "HK Residential — Monthly Lease"' />
                    </Form.Item>
                  </Col>
                  <Col span={8}>
                    <Form.Item label="Page size" name="page_size">
                      <Select options={[{ value: 'A4', label: 'A4' }, { value: 'Letter', label: 'Letter' }]} />
                    </Form.Item>
                  </Col>
                </Row>
                <Form.Item label="Description" name="description">
                  <Input.TextArea rows={2} placeholder="Internal description — what's this template for?" />
                </Form.Item>
                <Form.Item label="Set as default" name="is_default" valuePropName="checked">
                  <Switch />
                </Form.Item>

                <Form.Item label={
                  <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', alignItems: 'center' }}>
                    <span>Body</span>
                    <Dropdown menu={variableDropdown} trigger={['click']}>
                      <Button size="small" icon={<ThunderboltOutlined />}>Insert Variable</Button>
                    </Dropdown>
                  </div>
                }>
                  <ReactQuill
                    ref={quillRef}
                    value={bodyHtml}
                    onChange={setBodyHtml}
                    modules={quillModules}
                    theme="snow"
                    style={{ background: '#fff', minHeight: 420 }}
                  />
                </Form.Item>

                <Form.Item label="Page header (repeats on every page — optional)">
                  <Input.TextArea
                    rows={2}
                    value={headerHtml}
                    onChange={(e) => setHeaderHtml(e.target.value)}
                    placeholder='e.g. <strong>{{LANDLORD_COMPANY}}</strong> — Lease Agreement'
                  />
                </Form.Item>
                <Form.Item label="Page footer (repeats on every page — optional)">
                  <Input.TextArea
                    rows={2}
                    value={footerHtml}
                    onChange={(e) => setFooterHtml(e.target.value)}
                    placeholder='e.g. Page <span class="pageNumber"></span> of <span class="totalPages"></span>'
                  />
                </Form.Item>

                <Form.Item style={{ marginBottom: 0 }}>
                  <Space>
                    <Button type="primary" icon={<SaveOutlined />} htmlType="submit" loading={saving}>
                      {mode === 'edit' ? 'Save changes' : 'Create template'}
                    </Button>
                    <Button icon={<EyeOutlined />} onClick={onPreview} loading={previewLoading}>
                      Refresh Preview
                    </Button>
                    <Button onClick={() => router.push('/settings/lease-templates')}>Cancel</Button>
                  </Space>
                </Form.Item>
              </Form>
            </Card>
          </Col>

          <Col xs={24} lg={10}>
            <Card
              title="PDF Preview (sample data)"
              size="small"
              extra={previewUrl && (
                <a href={previewUrl} target="_blank" rel="noreferrer">Open in new tab</a>
              )}
              bodyStyle={{ padding: 0, height: 'calc(100vh - 200px)', minHeight: 600 }}
            >
              {previewUrl ? (
                <iframe
                  src={previewUrl}
                  title="Template preview"
                  style={{ width: '100%', height: '100%', border: 0 }}
                />
              ) : (
                <div style={{ padding: 40, height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Empty
                    description={<span>Click <strong>Refresh Preview</strong> to render the template with sample data.</span>}
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                  />
                </div>
              )}
            </Card>
          </Col>
        </Row>
      </Spin>
    </div>
  );
}
