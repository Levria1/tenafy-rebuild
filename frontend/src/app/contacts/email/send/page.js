'use client';

import { useEffect, useState, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Card, Form, Input, Button, Select, message, Row, Col, Space, Divider, Tag, Alert,
} from 'antd';
import { ArrowLeftOutlined, SendOutlined } from '@ant-design/icons';
import dynamic from 'next/dynamic';
import dayjs from 'dayjs';
import MainLayout from '../../../../components/Layout';
import { emailTemplate, tenant as tenantApi, invoice as invoiceApi } from '../../../../lib/api';

// ReactQuill — dynamic import to avoid SSR issues
const ReactQuill = dynamic(() => import('react-quill-new'), { ssr: false });
import 'react-quill-new/dist/quill.snow.css';

const quillModules = {
  toolbar: [
    [{ header: [1, 2, 3, false] }],
    ['bold', 'italic', 'underline', 'strike'],
    [{ color: [] }, { background: [] }],
    [{ list: 'ordered' }, { list: 'bullet' }],
    [{ align: [] }],
    ['link', 'image'],
    ['clean'],
  ],
};

export default function SendEmailPage() {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [pageLoading, setPageLoading] = useState(true);
  const [templates, setTemplates] = useState([]);
  const [selectedTemplate, setSelectedTemplate] = useState(null);
  const [allTenants, setAllTenants] = useState([]);
  const [bodyHtml, setBodyHtml] = useState('');
  const [variables, setVariables] = useState([]);

  // Lease & invoice context
  const [tenantLeases, setTenantLeases] = useState([]);  // active leases for selected tenant
  const [selectedLeaseId, setSelectedLeaseId] = useState(null);
  const [tenantInvoices, setTenantInvoices] = useState([]); // invoices for selected lease
  const [selectedInvoiceId, setSelectedInvoiceId] = useState(null);
  const [selectedInvoiceCode, setSelectedInvoiceCode] = useState(null);
  const [tenantName, setTenantName] = useState('');

  const router = useRouter();
  const searchParams = useSearchParams();
  const category = searchParams.get('category');
  const tenantId = searchParams.get('id');
  const urlLeaseId = searchParams.get('leaseId');
  const urlInvoiceId = searchParams.get('invoiceId');
  const urlInvoiceCode = searchParams.get('invoiceCode');

  useEffect(() => {
    loadInitialData();
  }, []);

  const loadInitialData = async () => {
    try {
      setPageLoading(true);
      const [templateRes, tenantRes, variableRes] = await Promise.all([
        emailTemplate.getAll(),
        tenantApi.getAll(),
        emailTemplate.getVariables(),
      ]);

      if (templateRes.data.code === 200) setTemplates(templateRes.data.data || []);
      if (tenantRes.data.code === 200) setAllTenants(tenantRes.data.data || []);
      if (variableRes.data.code === 200) setVariables(variableRes.data.data || []);

      const tenants = tenantRes.data.data || [];

      // Pre-fill recipients and load tenant leases
      await prefillRecipients(tenants);

      // If we have a tenantId, load their leases
      if (tenantId) {
        await loadTenantLeases(tenantId, tenants);
      }

      // If leaseId was passed in URL, set it directly
      if (urlLeaseId) {
        setSelectedLeaseId(urlLeaseId);
      }

      // If invoiceId was passed in URL, set it
      if (urlInvoiceId) {
        setSelectedInvoiceId(urlInvoiceId);
        setSelectedInvoiceCode(urlInvoiceCode || null);
      }
    } catch (error) {
      console.error('Failed to load data:', error);
    } finally {
      setPageLoading(false);
    }
  };

  const loadTenantLeases = async (tid, tenants) => {
    try {
      const t = (tenants || allTenants).find(t => String(t.id) === String(tid));
      if (t) {
        const name = Number(t.type) === 1 && t.company_name
          ? t.company_name
          : [t.first_name, t.last_name].filter(Boolean).join(' ');
        setTenantName(name);
      }

      const res = await tenantApi.getLeases(tid);
      if (res.data.code === 200) {
        const leases = res.data.data || [];
        // Filter to active leases only
        const activeLeases = leases.filter(l => Number(l.status) === 1);
        setTenantLeases(activeLeases);

        // If only one active lease, auto-select it
        if (activeLeases.length === 1 && !urlLeaseId) {
          setSelectedLeaseId(String(activeLeases[0].id));
        }
      }
    } catch (err) {
      console.error('Failed to load tenant leases:', err);
    }
  };

  // Load invoices for the selected lease (for overdue/invoice context)
  const loadLeaseInvoices = async (lid) => {
    try {
      const res = await invoiceApi.list(
        { leasing_id: lid },
        { page: 1, limit: 100 }
      );
      if (res.data.code === 200) {
        setTenantInvoices(res.data.data?.content || []);
      }
    } catch (err) {
      console.error('Failed to load lease invoices:', err);
    }
  };

  // When lease changes, load its invoices
  const handleLeaseChange = (lid) => {
    setSelectedLeaseId(lid);
    setSelectedInvoiceId(null);
    setSelectedInvoiceCode(null);
    if (lid) {
      loadLeaseInvoices(lid);
    } else {
      setTenantInvoices([]);
    }
  };

  const handleInvoiceChange = (invId) => {
    setSelectedInvoiceId(invId);
    const inv = tenantInvoices.find(i => String(i.id) === String(invId));
    setSelectedInvoiceCode(inv ? inv.invoice_code : null);
  };

  const prefillRecipients = async (tenants) => {
    try {
      if ((category === 'tenant' || category === 'tenantLeases') && tenantId) {
        const t = tenants.find(t => String(t.id) === String(tenantId));
        if (t && t.email) {
          form.setFieldsValue({ to: t.email });
        }
      } else if (category === 'tenants') {
        const emails = tenants.filter(t => t.email).map(t => t.email);
        form.setFieldsValue({ to: emails.join('; ') });
      } else if (category === 'invoice' && urlInvoiceId) {
        try {
          const invRes = await invoiceApi.get(urlInvoiceId);
          if (invRes.data.code === 200) {
            const inv = invRes.data.data;
            const t = tenants.find(t => String(t.id) === String(inv.tenant_id));
            if (t && t.email) {
              form.setFieldsValue({ to: t.email });
            }
          }
        } catch (err) {
          console.error('Failed to load invoice for recipient:', err);
        }
      }
    } catch (err) {
      console.error('Failed to prefill recipients:', err);
    }
  };

  // When a template is selected, auto-fill fields
  const handleTemplateSelect = async (templateId) => {
    if (!templateId) {
      setSelectedTemplate(null);
      return;
    }
    try {
      const res = await emailTemplate.get(templateId);
      if (res.data.code === 200) {
        const tmpl = res.data.data;
        setSelectedTemplate(tmpl);
        form.setFieldsValue({
          subject: tmpl.subject || '',
          cc: tmpl.cc || '',
          bcc: tmpl.bcc || '',
          replyTo: tmpl.reply_to || '',
        });
        setBodyHtml(tmpl.body || '');
      }
    } catch (err) {
      console.error('Failed to load template:', err);
    }
  };

  const insertVariableInSubject = (varKey) => {
    const current = form.getFieldValue('subject') || '';
    form.setFieldsValue({ subject: current + varKey });
  };

  const onFinish = async (values) => {
    if (!values.to) {
      return message.error('Please enter at least one recipient');
    }
    if (!values.subject) {
      return message.error('Please enter a subject');
    }
    if (!bodyHtml || bodyHtml === '<p><br></p>') {
      return message.error('Please enter email body content');
    }

    const effectiveLeaseId = selectedLeaseId || urlLeaseId;
    if (!effectiveLeaseId) {
      return message.warning('Please select a lease so variables can be resolved');
    }

    try {
      setLoading(true);
      const payload = {
        toOverride: values.to,
        subject: values.subject,
        body: bodyHtml,
        cc: values.cc || undefined,
        bcc: values.bcc || undefined,
        replyTo: values.replyTo || undefined,
        templateId: selectedTemplate ? String(selectedTemplate.id) : undefined,
        templateType: selectedTemplate ? selectedTemplate.type : undefined,
        leaseId: effectiveLeaseId || undefined,
        invoiceId: selectedInvoiceId || urlInvoiceId || undefined,
        invoiceCode: selectedInvoiceCode || urlInvoiceCode || undefined,
      };

      const res = await emailTemplate.send(payload);
      if (res.data.code === 200) {
        message.success(res.data.message || 'Email sent successfully');
        router.back();
      } else {
        message.error(res.data.message || 'Failed to send email');
      }
    } catch (error) {
      console.error('Send email error:', error);
      message.error('Failed to send email');
    } finally {
      setLoading(false);
    }
  };

  // Template options grouped by type
  const templateOptions = useMemo(() => {
    const grouped = {};
    templates.forEach(t => {
      const type = t.type || 'Other';
      if (!grouped[type]) grouped[type] = [];
      grouped[type].push(t);
    });
    return Object.entries(grouped).map(([type, items]) => ({
      label: type,
      options: items.map(t => ({
        label: `${t.name}${t.is_default_template === 1 ? ' ★' : ''}`,
        value: String(t.id),
      })),
    }));
  }, [templates]);

  // Lease dropdown options — show unit + property + dates
  const leaseOptions = useMemo(() => {
    return tenantLeases.map(l => ({
      label: `${l.unit_name || 'Unit'} — ${l.property_name || 'Property'} (${dayjs(l.start_date).format('MM/DD/YYYY')} → ${l.end_date ? dayjs(l.end_date).format('MM/DD/YYYY') : 'Ongoing'})`,
      value: String(l.id),
    }));
  }, [tenantLeases]);

  // Invoice dropdown options — show code + due date + amount + status
  const invoiceStatusLabel = (s) => ({ 0: 'Open', 1: 'Paid', 2: 'Overdue' }[Number(s)] || '');
  const invoiceOptions = useMemo(() => {
    return tenantInvoices.map(inv => ({
      label: `${inv.invoice_code || '—'} | Due: ${inv.due_on ? dayjs(inv.due_on).format('MM/DD/YYYY') : '—'} | $${Number(inv.amount || 0).toFixed(2)} | ${invoiceStatusLabel(inv.status)}`,
      value: String(inv.id),
    }));
  }, [tenantInvoices]);

  // Determine if we need to show the lease picker
  const showLeasePicker = tenantId && !urlLeaseId;
  // Show invoice picker when a lease is selected (or from URL) and template is invoice/overdue related
  const isInvoiceTemplate = selectedTemplate &&
    (selectedTemplate.type || '').match(/Invoice|Overdue|Deposit/i);
  const showInvoicePicker = (selectedLeaseId || urlLeaseId) && isInvoiceTemplate;

  return (
    <MainLayout>
      <div style={{ maxWidth: 900, margin: '0 auto' }}>
        <Button
          type="link"
          icon={<ArrowLeftOutlined />}
          onClick={() => router.back()}
          style={{ marginBottom: 16, padding: 0 }}
        >
          Back
        </Button>

        <Card
          title={tenantName ? `Send Email — ${tenantName}` : 'Send Email'}
          loading={pageLoading}
        >
          <Form form={form} layout="vertical" onFinish={onFinish}>

            {/* Template Selection */}
            <Form.Item label="Email Template">
              <Select
                placeholder="Select a template to auto-fill fields..."
                allowClear
                showSearch
                optionFilterProp="label"
                onChange={handleTemplateSelect}
                options={templateOptions}
                style={{ width: '100%' }}
              />
            </Form.Item>

            {/* Lease Picker — shown when we have a tenant but no pre-selected lease */}
            {showLeasePicker && (
              <Form.Item label="Lease" required>
                {tenantLeases.length === 0 ? (
                  <Alert
                    type="warning"
                    message="No active leases found for this tenant"
                    showIcon
                    style={{ marginBottom: 0 }}
                  />
                ) : (
                  <Select
                    placeholder="Select a lease to resolve email variables..."
                    value={selectedLeaseId}
                    onChange={handleLeaseChange}
                    options={leaseOptions}
                    style={{ width: '100%' }}
                  />
                )}
              </Form.Item>
            )}

            {/* Invoice Picker — shown for invoice/overdue templates when a lease is selected */}
            {showInvoicePicker && tenantInvoices.length > 0 && (
              <Form.Item label="Invoice (optional — for %Invoice Number% variable)">
                <Select
                  placeholder="Select an invoice..."
                  allowClear
                  value={selectedInvoiceId}
                  onChange={handleInvoiceChange}
                  options={invoiceOptions}
                  style={{ width: '100%' }}
                />
              </Form.Item>
            )}

            <Divider style={{ margin: '12px 0 20px' }} />

            {/* To */}
            <Form.Item
              name="to"
              label="To"
              rules={[{ required: true, message: 'Enter at least one recipient email' }]}
            >
              <Input.TextArea
                rows={2}
                placeholder="email@example.com; another@example.com"
                style={{ fontFamily: 'monospace', fontSize: 13 }}
              />
            </Form.Item>

            {/* CC / BCC / Reply To */}
            <Row gutter={16}>
              <Col span={8}>
                <Form.Item name="cc" label="CC">
                  <Input placeholder="cc@example.com" />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item name="bcc" label="BCC">
                  <Input placeholder="bcc@example.com" />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item name="replyTo" label="Reply To">
                  <Input placeholder="reply@example.com" />
                </Form.Item>
              </Col>
            </Row>

            {/* Subject */}
            <Form.Item
              name="subject"
              label="Subject"
              rules={[{ required: true, message: 'Enter a subject line' }]}
            >
              <Input placeholder="e.g. Invoice for %Payment Month% - %Name - Property%" />
            </Form.Item>

            {/* Body */}
            <Form.Item label="Email Body" required>
              <ReactQuill
                theme="snow"
                value={bodyHtml}
                onChange={setBodyHtml}
                modules={quillModules}
                style={{ minHeight: 250, marginBottom: 42 }}
                placeholder="Enter email content here..."
              />
            </Form.Item>

            {/* Variables */}
            <Card
              size="small"
              title="Template Variables"
              style={{ marginBottom: 24, background: '#fafafa' }}
            >
              <p style={{ color: '#666', fontSize: 12, marginBottom: 12 }}>
                Click a variable to insert it into the subject line. Copy/paste into the body editor.
              </p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {variables.map(v => (
                  <Tag
                    key={v.key}
                    color="blue"
                    style={{ cursor: 'pointer', fontSize: 12, marginBottom: 4 }}
                    onClick={() => insertVariableInSubject(v.key)}
                    title={v.description}
                  >
                    {v.key}
                  </Tag>
                ))}
              </div>
            </Card>

            {/* Actions */}
            <Form.Item>
              <Space>
                <Button
                  type="primary"
                  htmlType="submit"
                  loading={loading}
                  icon={<SendOutlined />}
                  size="large"
                >
                  Send Email
                </Button>
                <Button onClick={() => router.back()} size="large">
                  Cancel
                </Button>
              </Space>
            </Form.Item>
          </Form>
        </Card>
      </div>
    </MainLayout>
  );
}
