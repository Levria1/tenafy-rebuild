'use client';
import { useState, useEffect, useRef } from 'react';
import { useRouter, useParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import { Card, Form, Input, Button, Space, message, Select, Switch, Row, Col, Tag, InputNumber, Radio } from 'antd';
import { ArrowLeftOutlined, CopyOutlined, EyeOutlined, SendOutlined } from '@ant-design/icons';
import MainLayout from '../../../../../components/Layout';
import { emailTemplate } from '../../../../../lib/api';

const ReactQuill = dynamic(() => import('react-quill-new'), { ssr: false });
import 'react-quill-new/dist/quill.snow.css';

const quillModules = {
  toolbar: [
    [{ header: [1, 2, 3, false] }],
    ['bold', 'italic', 'underline', 'strike'],
    [{ color: [] }, { background: [] }],
    [{ font: [] }],
    [{ size: ['small', false, 'large', 'huge'] }],
    [{ list: 'ordered' }, { list: 'bullet' }],
    [{ align: [] }],
    ['link', 'image'],
    ['clean'],
  ],
};

// Sample values for client-side preview
const SAMPLE_VALUES = {
  '%Name - Lease%': 'John Smith',
  '%Unit # - Property%': 'Unit 101',
  '%Name - Property%': 'Sunset Apartments',
  '%Building / Unit Address - Property%': '123 Main St, Los Angeles, CA',
  '%Lease start date - Lease%': '01/01/2026',
  '%Lease end date - Lease%': '12/31/2026',
  '%Unit Access Information - Property%': 'Front gate code: 1234',
  '%Wifi Details - Property%': 'Network: SunsetWifi, Password: guest123',
  '%Payment Info - Property%': 'Bank transfer to Account #XXXX',
  '%Unit Information - Lease%': 'Studio apartment, furnished',
  '%Outstandings%': '$1,200.00',
  '%Monthly utility credit%': '$50.00',
  '%Security deposit amount%': '$2,400.00',
  '%Payment Month%': 'March',
  '%Payment Date%': 'March 15',
  '%Due Date%': 'March 15, 2026',
  '%Overdue Amount%': '$0.00',
  '%Tenant Number%': '(555) 123-4567',
  '%Category%': 'Rental Income',
  '%Invoice Number%': 'TRIV0000000001',
};

function substitutePreview(content) {
  if (!content) return '';
  let result = content;
  for (const [key, value] of Object.entries(SAMPLE_VALUES)) {
    result = result.split(key).join(value);
    result = result.split(key.replace(/ /g, '&nbsp;')).join(value);
  }
  return result;
}

export default function EditEmailTemplatePage() {
  const router = useRouter();
  const params = useParams();
  const templateId = params.id;
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [sendingTest, setSendingTest] = useState(false);
  const [types, setTypes] = useState([]);
  const [variables, setVariables] = useState([]);
  const [previewMode, setPreviewMode] = useState(false);
  const bodyRef = useRef(null);

  useEffect(() => {
    Promise.all([
      emailTemplate.get(templateId),
      emailTemplate.getTypes(),
      emailTemplate.getVariables(),
    ]).then(([templateRes, typesRes, varsRes]) => {
      if (templateRes.data.code === 200) {
        const data = templateRes.data.data;
        // Normalize before_date from BIT/Buffer to boolean
        let beforeDate = false;
        if (data.before_date) {
          if (typeof data.before_date === 'object' && data.before_date.data) {
            beforeDate = data.before_date.data[0] === 1;
          } else {
            beforeDate = Boolean(data.before_date);
          }
        }
        form.setFieldsValue({
          ...data,
          is_default_template: data.is_default_template === 1 || data.is_default_template === true,
          before_date: beforeDate ? 1 : 0,
          date_first: data.date_first || 0,
          date_second: data.date_second || 0,
        });
      }
      if (typesRes.data.code === 200 && Array.isArray(typesRes.data.data)) {
        setTypes(
          typesRes.data.data
            .map(t => ({ label: t.label || t.name || t, value: t.value || t.code || t }))
            .sort((a, b) => String(a.label).localeCompare(String(b.label)))
        );
      }
      if (varsRes.data.code === 200 && Array.isArray(varsRes.data.data)) {
        setVariables(varsRes.data.data);
      }
    }).catch(() => message.error('Failed to load template'))
      .finally(() => setLoading(false));
  }, [templateId]);

  const insertVariable = (varKey) => {
    const quill = bodyRef.current?.getEditor?.();
    if (quill) {
      const range = quill.getSelection(true);
      const pos = range ? range.index : quill.getLength() - 1;
      quill.insertText(pos, varKey);
      quill.setSelection(pos + varKey.length);
    } else {
      const current = form.getFieldValue('body') || '';
      form.setFieldsValue({ body: current + varKey });
    }
  };

  const onFinish = async (values) => {
    setSubmitting(true);
    try {
      await emailTemplate.update(templateId, values);
      message.success('Email template updated');
      router.push('/settings?tab=emailTemplates');
    } catch (error) {
      message.error('Failed to update template');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSendTest = async () => {
    const testEmail = window.prompt('Enter test email address:');
    if (!testEmail || !testEmail.includes('@')) return;
    setSendingTest(true);
    try {
      const res = await emailTemplate.send({
        templateId: templateId,
        toOverride: testEmail,
      });
      if (res.data.code === 200) {
        message.success(`Test email sent to ${testEmail}! Check server console for Ethereal preview URL.`);
      } else {
        message.warning(res.data.message || 'Could not send test email');
      }
    } catch (err) {
      message.error('Failed to send test email');
    } finally {
      setSendingTest(false);
    }
  };

  const bodyValue = Form.useWatch('body', form) || '';
  const subjectValue = Form.useWatch('subject', form) || '';

  return (
    <MainLayout>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => router.push('/settings?tab=emailTemplates')}>Back</Button>
        <Row gutter={16}>
          {/* Main Form */}
          <Col xs={24} lg={16}>
            <Card title="Edit Email Template" loading={loading}>
              <Form form={form} layout="vertical" onFinish={onFinish}>
                <Row gutter={16}>
                  <Col xs={24} md={12}>
                    <Form.Item name="name" label="Template Name" rules={[{ required: true }]}>
                      <Input />
                    </Form.Item>
                  </Col>
                  <Col xs={24} md={12}>
                    <Form.Item name="type" label="Template Type" rules={[{ required: true }]}>
                      <Select options={types} />
                    </Form.Item>
                  </Col>
                </Row>

                <Form.Item name="subject" label="Email Subject" rules={[{ required: true }]}>
                  <Input />
                </Form.Item>

                <Row gutter={16}>
                  <Col xs={24} md={8}>
                    <Form.Item name="cc" label="CC">
                      <Input placeholder="email1@example.com, email2@example.com" />
                    </Form.Item>
                  </Col>
                  <Col xs={24} md={8}>
                    <Form.Item name="bcc" label="BCC">
                      <Input placeholder="email@example.com" />
                    </Form.Item>
                  </Col>
                  <Col xs={24} md={8}>
                    <Form.Item name="reply_to" label="Reply-To">
                      <Input placeholder="reply@example.com" />
                    </Form.Item>
                  </Col>
                </Row>

                <Row gutter={16} align="middle">
                  <Col xs={12} md={8}>
                    <Form.Item name="from" label="From (override)">
                      <Input placeholder="sender@example.com" />
                    </Form.Item>
                  </Col>
                  <Col xs={12} md={8}>
                    <Form.Item name="to_address" label="To (override)" tooltip="Optional. If set, sends to this address instead of the auto-resolved recipient. Used by templates not tied to a lease (e.g. Inquiry Reminder).">
                      <Input placeholder="recipient@example.com" />
                    </Form.Item>
                  </Col>
                  <Col xs={12} md={4}>
                    <Form.Item name="is_default_template" label="Default Template" valuePropName="checked">
                      <Switch />
                    </Form.Item>
                  </Col>
                </Row>

                {/* Email Timing */}
                <Card size="small" style={{ marginBottom: 24, background: '#fafafa' }}>
                  <div style={{ fontWeight: 600, marginBottom: 12 }}>Email Timing</div>
                  <Row gutter={16} align="middle">
                    <Col xs={24} md={8}>
                      <Form.Item name="before_date" label="Send Timing" style={{ marginBottom: 0 }}>
                        <Radio.Group>
                          <Radio value={1}>Before event</Radio>
                          <Radio value={0}>After event</Radio>
                        </Radio.Group>
                      </Form.Item>
                    </Col>
                    <Col xs={12} md={8}>
                      <Form.Item name="date_first" label="First Email (days)" style={{ marginBottom: 0 }}>
                        <InputNumber min={0} max={365} style={{ width: '100%' }} placeholder="e.g. 7" />
                      </Form.Item>
                    </Col>
                    <Col xs={12} md={8}>
                      <Form.Item name="date_second" label="Second Email (days)" style={{ marginBottom: 0 }}>
                        <InputNumber min={0} max={365} style={{ width: '100%' }} placeholder="e.g. 3" />
                      </Form.Item>
                    </Col>
                  </Row>
                  <div style={{ marginTop: 8, color: '#888', fontSize: 12 }}>
                    Example: Check-In set to "Before event" + 7 days = email sent 7 days before lease start date.
                    Set to 0 to disable.
                  </div>
                </Card>

                {/* Body with Edit/Preview tabs */}
                <div style={{ marginBottom: 24 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <span style={{ fontWeight: 500 }}>Email Body <span style={{ color: '#ff4d4f' }}>*</span></span>
                    <Space>
                      <Button
                        size="small"
                        icon={<SendOutlined />}
                        onClick={handleSendTest}
                      >
                        Send Test
                      </Button>
                      <Button
                        size="small"
                        icon={previewMode ? <CopyOutlined /> : <EyeOutlined />}
                        onClick={() => setPreviewMode(!previewMode)}
                      >
                        {previewMode ? 'Edit' : 'Preview'}
                      </Button>
                    </Space>
                  </div>

                  {previewMode ? (
                    <div
                      style={{
                        border: '1px solid #d9d9d9',
                        borderRadius: 6,
                        padding: 16,
                        minHeight: 300,
                        backgroundColor: '#fafafa',
                      }}
                    >
                      <div style={{ marginBottom: 12, padding: '8px 12px', backgroundColor: '#e6f4ff', borderRadius: 4, fontSize: 13 }}>
                        <strong>Subject:</strong> {substitutePreview(subjectValue)}
                      </div>
                      <div dangerouslySetInnerHTML={{ __html: substitutePreview(bodyValue) }} />
                    </div>
                  ) : (
                    <Form.Item name="body" noStyle rules={[{ required: true, message: 'Please enter email body' }]}
                      getValueFromEvent={(v) => v}
                    >
                      <ReactQuill
                        ref={bodyRef}
                        theme="snow"
                        modules={quillModules}
                        placeholder="Enter email content here. Click variables on the right to insert them."
                        style={{ minHeight: 300, marginBottom: 42 }}
                        value={bodyValue}
                        onChange={(v) => form.setFieldsValue({ body: v })}
                      />
                    </Form.Item>
                  )}
                </div>

                <Form.Item>
                  <Space>
                    <Button onClick={() => router.push('/settings?tab=emailTemplates')}>Cancel</Button>
                    <Button type="primary" htmlType="submit" loading={submitting}>Save Changes</Button>
                    <Button icon={<SendOutlined />} onClick={handleSendTest} loading={sendingTest}>Send Test</Button>
                  </Space>
                </Form.Item>
              </Form>
            </Card>
          </Col>

          {/* Variable Picker Sidebar */}
          <Col xs={24} lg={8}>
            <Card
              title="Template Variables"
              size="small"
              style={{ position: 'sticky', top: 16 }}
            >
              <p style={{ fontSize: 12, color: '#8c8c8c', marginBottom: 12 }}>
                Click a variable to insert it at the cursor position in the email body.
              </p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {variables.map(v => (
                  <Tag
                    key={v.key}
                    color="blue"
                    style={{ cursor: 'pointer', marginBottom: 4, fontSize: 11 }}
                    onClick={() => insertVariable(v.key)}
                    title={v.description}
                  >
                    {v.key}
                  </Tag>
                ))}
              </div>
              {variables.length > 0 && (
                <div style={{ marginTop: 16, fontSize: 12, color: '#8c8c8c' }}>
                  <strong>Variable Descriptions:</strong>
                  <div style={{ marginTop: 8 }}>
                    {variables.map(v => (
                      <div key={v.key} style={{ marginBottom: 4 }}>
                        <code style={{ fontSize: 11, backgroundColor: '#f5f5f5', padding: '1px 4px', borderRadius: 2 }}>{v.key}</code>
                        <span style={{ marginLeft: 6 }}>{v.description}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </Card>
          </Col>
        </Row>
      </Space>
    </MainLayout>
  );
}
