'use client';
import { useState, useEffect, useRef } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Card, Form, Input, Button, Space, message, Select, Switch, Row, Col, Tag, InputNumber, Radio } from 'antd';
import { ArrowLeftOutlined, CopyOutlined, EyeOutlined } from '@ant-design/icons';
import MainLayout from '../../../../../components/Layout';
import { whatsappTemplate } from '../../../../../lib/api';

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

export default function EditWhatsAppTemplatePage() {
  const router = useRouter();
  const params = useParams();
  const templateId = params.id;
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [types, setTypes] = useState([]);
  const [variables, setVariables] = useState([]);
  const [previewMode, setPreviewMode] = useState(false);
  const bodyRef = useRef(null);

  useEffect(() => {
    Promise.all([
      whatsappTemplate.get(templateId),
      whatsappTemplate.getTypes(),
      whatsappTemplate.getVariables(),
    ]).then(([tRes, typesRes, varsRes]) => {
      if (tRes.data.code === 200) {
        const data = tRes.data.data;
        let beforeDate = false;
        if (data.before_date) {
          if (typeof data.before_date === 'object' && data.before_date.data) {
            beforeDate = data.before_date.data[0] === 1;
          } else {
            beforeDate = Boolean(data.before_date);
          }
        }
        let isDefault = false;
        if (data.is_default_template) {
          isDefault = data.is_default_template === 1 || data.is_default_template === true;
        }
        form.setFieldsValue({
          name: data.name,
          type: data.type,
          body: data.body,
          status: data.status ?? 1,
          is_default_template: isDefault,
          before_date: beforeDate ? 1 : 0,
          date_first: data.date_first || 0,
          date_second: data.date_second || 0,
        });
      }
      if (typesRes.data.code === 200 && Array.isArray(typesRes.data.data)) {
        setTypes(typesRes.data.data.map(t => ({ label: t.label || t.name || t, value: t.value || t.code || t })));
      }
      if (varsRes.data.code === 200 && Array.isArray(varsRes.data.data)) {
        setVariables(varsRes.data.data);
      }
    }).catch(() => message.error('Failed to load template')).finally(() => setLoading(false));
  }, [templateId]);

  const insertVariable = (varKey) => {
    const ta = bodyRef.current?.resizableTextArea?.textArea;
    const current = form.getFieldValue('body') || '';
    if (ta && typeof ta.selectionStart === 'number') {
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const next = current.slice(0, start) + varKey + current.slice(end);
      form.setFieldsValue({ body: next });
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
      await whatsappTemplate.update(templateId, values);
      message.success('WhatsApp template updated');
      router.push('/settings?tab=whatsappTemplates');
    } catch {
      message.error('Failed to update template');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSendTest = async () => {
    const phone = window.prompt('Enter test phone number (with country code, e.g. 85291234567):');
    if (!phone) return;
    const values = form.getFieldsValue();
    if (!values.body) { message.warning('Please enter message body first'); return; }
    try {
      const res = await whatsappTemplate.send({ toOverride: phone, body: values.body });
      if (res.data.code === 200) message.success('Test WhatsApp sent');
      else message.warning(res.data.message || 'Send failed');
    } catch {
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
            <Card title="Edit WhatsApp Template" loading={loading}>
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

                <Row gutter={16} align="middle">
                  <Col xs={12} md={6}>
                    <Form.Item name="is_default_template" label="Default Template" valuePropName="checked">
                      <Switch />
                    </Form.Item>
                  </Col>
                  <Col xs={12} md={6}>
                    <Form.Item name="status" label="Status" initialValue={1}>
                      <Select options={[{ value: 1, label: 'Active' }, { value: 2, label: 'Inactive' }]} />
                    </Form.Item>
                  </Col>
                </Row>

                <Card size="small" style={{ marginBottom: 24, background: '#fafafa' }}>
                  <div style={{ fontWeight: 600, marginBottom: 12 }}>WhatsApp Timing</div>
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
                      <Form.Item name="date_first" label="First Send (days)" style={{ marginBottom: 0 }}>
                        <InputNumber min={0} max={365} style={{ width: '100%' }} />
                      </Form.Item>
                    </Col>
                    <Col xs={12} md={8}>
                      <Form.Item name="date_second" label="Second Send (days)" style={{ marginBottom: 0 }}>
                        <InputNumber min={0} max={365} style={{ width: '100%' }} />
                      </Form.Item>
                    </Col>
                  </Row>
                  <div style={{ marginTop: 8, color: '#888', fontSize: 12 }}>
                    Independent of email timing — set 0 to disable a slot.
                  </div>
                </Card>

                <div style={{ marginBottom: 24 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <span style={{ fontWeight: 500 }}>Message <span style={{ color: '#ff4d4f' }}>*</span></span>
                    <Button size="small" icon={previewMode ? <CopyOutlined /> : <EyeOutlined />}
                      onClick={() => setPreviewMode(!previewMode)}>
                      {previewMode ? 'Edit' : 'Preview'}
                    </Button>
                  </div>
                  {previewMode ? (
                    <div style={{
                      border: '1px solid #d9d9d9', borderRadius: 6, padding: 16, minHeight: 220,
                      whiteSpace: 'pre-wrap', backgroundColor: '#e7ffdb',
                    }}>{substitutePreview(bodyValue)}</div>
                  ) : (
                    <Form.Item name="body" rules={[{ required: true, message: 'Please enter message body' }]} style={{ marginBottom: 0 }}>
                      <TextArea ref={bodyRef} rows={10} />
                    </Form.Item>
                  )}
                </div>

                <Form.Item>
                  <Space>
                    <Button onClick={() => router.push('/settings?tab=whatsappTemplates')}>Cancel</Button>
                    <Button onClick={handleSendTest}>Send Test</Button>
                    <Button type="primary" htmlType="submit" loading={submitting}>Save Changes</Button>
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
