'use client';
import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Card, Form, Input, Button, Space, message, Select, Switch, Row, Col, Tag, InputNumber, Radio } from 'antd';
import { ArrowLeftOutlined, CopyOutlined, EyeOutlined } from '@ant-design/icons';
import MainLayout from '../../../../components/Layout';
import { whatsappTemplate } from '../../../../lib/api';

const { TextArea } = Input;

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
  }
  return result;
}

export default function CreateWhatsAppTemplatePage() {
  const router = useRouter();
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [types, setTypes] = useState([]);
  const [variables, setVariables] = useState([]);
  const [previewMode, setPreviewMode] = useState(false);
  const bodyRef = useRef(null);

  useEffect(() => {
    whatsappTemplate.getTypes().then(r => {
      if (r.data.code === 200 && Array.isArray(r.data.data)) {
        setTypes(r.data.data.map(t => ({ label: t.label || t.name || t, value: t.value || t.code || t })));
      }
    }).catch(() => {});
    whatsappTemplate.getVariables().then(r => {
      if (r.data.code === 200 && Array.isArray(r.data.data)) {
        setVariables(r.data.data);
      }
    }).catch(() => {});
  }, []);

  const insertVariable = (varKey) => {
    const ta = bodyRef.current?.resizableTextArea?.textArea;
    const current = form.getFieldValue('body') || '';
    if (ta && typeof ta.selectionStart === 'number') {
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const next = current.slice(0, start) + varKey + current.slice(end);
      form.setFieldsValue({ body: next });
      // Restore cursor after the inserted variable
      setTimeout(() => {
        ta.focus();
        ta.selectionStart = ta.selectionEnd = start + varKey.length;
      }, 0);
    } else {
      form.setFieldsValue({ body: current + varKey });
    }
  };

  const onFinish = async (values) => {
    setSubmitting(true);
    try {
      await whatsappTemplate.create(values);
      message.success('WhatsApp template created');
      router.push('/settings?tab=whatsappTemplates');
    } catch {
      message.error('Failed to create template');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSendTest = async () => {
    const phone = window.prompt('Enter test phone number (with country code, e.g. 85291234567):');
    if (!phone) return;
    const values = form.getFieldsValue();
    if (!values.body) {
      message.warning('Please enter message body first');
      return;
    }
    try {
      const res = await whatsappTemplate.send({
        toOverride: phone,
        body: values.body,
      });
      if (res.data.code === 200) {
        message.success('Test WhatsApp sent');
      } else {
        message.warning(res.data.message || 'Send failed');
      }
    } catch (err) {
      message.error('Failed to send test WhatsApp');
    }
  };

  const bodyValue = Form.useWatch('body', form) || '';

  return (
    <MainLayout>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => router.push('/settings?tab=whatsappTemplates')}>Back</Button>
        <Row gutter={16}>
          <Col xs={24} lg={16}>
            <Card title="Create WhatsApp Template">
              <Form form={form} layout="vertical" onFinish={onFinish}>
                <Row gutter={16}>
                  <Col xs={24} md={12}>
                    <Form.Item name="name" label="Template Name" rules={[{ required: true }]}>
                      <Input placeholder="e.g. Overdue - Tenant WA" />
                    </Form.Item>
                  </Col>
                  <Col xs={24} md={12}>
                    <Form.Item name="type" label="Template Type" rules={[{ required: true }]}>
                      <Select options={types} placeholder="Select type" />
                    </Form.Item>
                  </Col>
                </Row>

                <Row gutter={16} align="middle">
                  <Col xs={12} md={6}>
                    <Form.Item name="is_default_template" label="Default Template" valuePropName="checked">
                      <Switch />
                    </Form.Item>
                  </Col>
                </Row>

                <Card size="small" style={{ marginBottom: 24, background: '#fafafa' }}>
                  <div style={{ fontWeight: 600, marginBottom: 12 }}>WhatsApp Timing</div>
                  <Row gutter={16} align="middle">
                    <Col xs={24} md={8}>
                      <Form.Item name="before_date" label="Send Timing" initialValue={1} style={{ marginBottom: 0 }}>
                        <Radio.Group>
                          <Radio value={1}>Before event</Radio>
                          <Radio value={0}>After event</Radio>
                        </Radio.Group>
                      </Form.Item>
                    </Col>
                    <Col xs={12} md={8}>
                      <Form.Item name="date_first" label="First Send (days)" initialValue={0} style={{ marginBottom: 0 }}>
                        <InputNumber min={0} max={365} style={{ width: '100%' }} placeholder="e.g. 1" />
                      </Form.Item>
                    </Col>
                    <Col xs={12} md={8}>
                      <Form.Item name="date_second" label="Second Send (days)" initialValue={0} style={{ marginBottom: 0 }}>
                        <InputNumber min={0} max={365} style={{ width: '100%' }} placeholder="e.g. 0" />
                      </Form.Item>
                    </Col>
                  </Row>
                  <div style={{ marginTop: 8, color: '#888', fontSize: 12 }}>
                    Independent of email timing — set 0 to disable a slot. WA shares the email scheduler triggers.
                  </div>
                </Card>

                <div style={{ marginBottom: 24 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <span style={{ fontWeight: 500 }}>Message <span style={{ color: '#ff4d4f' }}>*</span></span>
                    <Button
                      size="small"
                      icon={previewMode ? <CopyOutlined /> : <EyeOutlined />}
                      onClick={() => setPreviewMode(!previewMode)}
                    >
                      {previewMode ? 'Edit' : 'Preview'}
                    </Button>
                  </div>

                  {previewMode ? (
                    <div
                      style={{
                        border: '1px solid #d9d9d9',
                        borderRadius: 6,
                        padding: 16,
                        minHeight: 220,
                        whiteSpace: 'pre-wrap',
                        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                        backgroundColor: '#e7ffdb',
                      }}
                    >
                      {substitutePreview(bodyValue)}
                    </div>
                  ) : (
                    <Form.Item name="body" rules={[{ required: true, message: 'Please enter message body' }]} style={{ marginBottom: 0 }}>
                      <TextArea
                        ref={bodyRef}
                        rows={10}
                        placeholder={'Hi %Name - Lease%,\n\nFriendly reminder that your invoice for %Payment Month% (%Due Date%) is %Outstandings% — please settle when you can. Thanks!'}
                      />
                    </Form.Item>
                  )}
                  <div style={{ marginTop: 8, color: '#888', fontSize: 12 }}>
                    Plain text only — keep it short. WhatsApp doesn't support HTML or rich formatting (use *bold*, _italic_, ~strike~ for inline emphasis).
                  </div>
                </div>

                <Form.Item>
                  <Space>
                    <Button onClick={() => router.push('/settings?tab=whatsappTemplates')}>Cancel</Button>
                    <Button onClick={handleSendTest}>Send Test</Button>
                    <Button type="primary" htmlType="submit" loading={submitting}>Create Template</Button>
                  </Space>
                </Form.Item>
              </Form>
            </Card>
          </Col>

          <Col xs={24} lg={8}>
            <Card title="Template Variables" size="small" style={{ position: 'sticky', top: 16 }}>
              <p style={{ fontSize: 12, color: '#8c8c8c', marginBottom: 12 }}>
                Click to insert at the cursor position.
              </p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {variables.map(v => (
                  <Tag key={v.key} color="green" style={{ cursor: 'pointer', marginBottom: 4, fontSize: 11 }}
                    onClick={() => insertVariable(v.key)} title={v.description}>
                    {v.key}
                  </Tag>
                ))}
              </div>
            </Card>
          </Col>
        </Row>
      </Space>
    </MainLayout>
  );
}
