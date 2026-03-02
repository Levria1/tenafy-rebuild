'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, Form, Input, Button, message } from 'antd';
import MainLayout from '../../../../components/Layout';
import { contact } from '../../../../lib/api';

export default function EmailGroupCreatePage() {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const onFinish = async (values) => {
    try {
      setLoading(true);
      await contact.createEmailGroup(values);
      message.success('Email group created successfully');
      router.push('/contacts?tab=groups');
    } catch (error) {
      message.error('Failed to create email group');
    } finally {
      setLoading(false);
    }
  };

  return (
    <MainLayout>
      <Card title="Create Email Group">
        <Form form={form} layout="vertical" onFinish={onFinish}>
          <Form.Item name="name" label="Group Name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={3} />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={loading}>Create Group</Button>
          </Form.Item>
        </Form>
      </Card>
    </MainLayout>
  );
}
