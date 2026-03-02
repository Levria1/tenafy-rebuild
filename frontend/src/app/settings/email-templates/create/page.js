'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Card, Form, Input, Button, Space, message, Select } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import MainLayout from '../../../../components/Layout';
import { emailTemplate } from '../../../../lib/api';

const TEMPLATE_TYPES = ['lease', 'invoice', 'reminder', 'welcome', 'general', 'expiry', 'receipt'];

export default function CreateEmailTemplatePage() {
  const router = useRouter();
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [types, setTypes] = useState(TEMPLATE_TYPES.map(t => ({ label: t.charAt(0).toUpperCase() + t.slice(1), value: t })));

  useEffect(() => {
    emailTemplate.getTypes().then(r => {
      if (r.data.code === 200 && Array.isArray(r.data.data)) {
        setTypes(r.data.data.map(t => ({ label: t.name || t, value: t.code || t })));
      }
    }).catch(() => {});
  }, []);

  const onFinish = async (values) => {
    setSubmitting(true);
    try {
      await emailTemplate.create(values);
      message.success('Email template created');
      router.push('/settings?tab=emailTemplates');
    } catch (error) {
      message.error('Failed to create template');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <MainLayout>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => router.push('/settings?tab=emailTemplates')}>Back</Button>
        <Card title="Create Email Template">
          <Form form={form} layout="vertical" onFinish={onFinish} style={{ maxWidth: 800 }}>
            <Form.Item name="name" label="Template Name" rules={[{ required: true }]}>
              <Input placeholder="e.g. Lease Expiry Reminder" />
            </Form.Item>
            <Form.Item name="subject" label="Email Subject" rules={[{ required: true }]}>
              <Input placeholder="e.g. Your lease is expiring soon" />
            </Form.Item>
            <Form.Item name="type" label="Template Type" rules={[{ required: true }]}>
              <Select options={types} placeholder="Select type" />
            </Form.Item>
            <Form.Item name="body" label="Email Body (HTML supported)" rules={[{ required: true }]}>
              <Input.TextArea rows={12} placeholder="Enter email content here. You can use HTML." />
            </Form.Item>
            <Form.Item>
              <Space>
                <Button onClick={() => router.push('/settings?tab=emailTemplates')}>Cancel</Button>
                <Button type="primary" htmlType="submit" loading={submitting}>Create Template</Button>
              </Space>
            </Form.Item>
          </Form>
        </Card>
      </Space>
    </MainLayout>
  );
}
