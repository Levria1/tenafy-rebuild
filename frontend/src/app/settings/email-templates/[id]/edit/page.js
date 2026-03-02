'use client';
import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Card, Form, Input, Button, Space, message, Select } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import MainLayout from '../../../../../components/Layout';
import { emailTemplate } from '../../../../../lib/api';

const TEMPLATE_TYPES = ['lease', 'invoice', 'reminder', 'welcome', 'general', 'expiry', 'receipt'];

export default function EditEmailTemplatePage() {
  const router = useRouter();
  const params = useParams();
  const templateId = params.id;
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [types, setTypes] = useState(TEMPLATE_TYPES.map(t => ({ label: t.charAt(0).toUpperCase() + t.slice(1), value: t })));

  useEffect(() => {
    emailTemplate.get(templateId).then(r => {
      if (r.data.code === 200) form.setFieldsValue(r.data.data);
    }).catch(() => message.error('Failed to load template')).finally(() => setLoading(false));
    emailTemplate.getTypes().then(r => {
      if (r.data.code === 200 && Array.isArray(r.data.data)) {
        setTypes(r.data.data.map(t => ({ label: t.name || t, value: t.code || t })));
      }
    }).catch(() => {});
  }, [templateId]);

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

  return (
    <MainLayout>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => router.push('/settings?tab=emailTemplates')}>Back</Button>
        <Card title="Edit Email Template" loading={loading}>
          <Form form={form} layout="vertical" onFinish={onFinish} style={{ maxWidth: 800 }}>
            <Form.Item name="name" label="Template Name" rules={[{ required: true }]}>
              <Input />
            </Form.Item>
            <Form.Item name="subject" label="Email Subject" rules={[{ required: true }]}>
              <Input />
            </Form.Item>
            <Form.Item name="type" label="Template Type" rules={[{ required: true }]}>
              <Select options={types} />
            </Form.Item>
            <Form.Item name="body" label="Email Body (HTML supported)" rules={[{ required: true }]}>
              <Input.TextArea rows={12} />
            </Form.Item>
            <Form.Item>
              <Space>
                <Button onClick={() => router.push('/settings?tab=emailTemplates')}>Cancel</Button>
                <Button type="primary" htmlType="submit" loading={submitting}>Save Changes</Button>
              </Space>
            </Form.Item>
          </Form>
        </Card>
      </Space>
    </MainLayout>
  );
}
