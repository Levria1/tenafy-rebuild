'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Card, Form, Input, Button, message } from 'antd';
import MainLayout from '../../../../../components/Layout';
import { contact } from '../../../../../lib/api';

export default function EmailGroupEditPage() {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const router = useRouter();
  const params = useParams();
  const groupId = params.id;

  useEffect(() => {
    loadGroup();
  }, [groupId]);

  const loadGroup = async () => {
    try {
      const response = await contact.getEmailGroup(groupId);
      if (response.data.code === 200) {
        form.setFieldsValue(response.data.data);
      }
    } catch (error) {
      message.error('Failed to load email group');
    } finally {
      setInitialLoading(false);
    }
  };

  const onFinish = async (values) => {
    try {
      setLoading(true);
      await contact.updateEmailGroup(groupId, values);
      message.success('Email group updated successfully');
      router.push('/contacts?tab=groups');
    } catch (error) {
      message.error('Failed to update email group');
    } finally {
      setLoading(false);
    }
  };

  return (
    <MainLayout>
      <Card title="Edit Email Group" loading={initialLoading}>
        <Form form={form} layout="vertical" onFinish={onFinish}>
          <Form.Item name="name" label="Group Name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={3} />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={loading}>Update Group</Button>
          </Form.Item>
        </Form>
      </Card>
    </MainLayout>
  );
}
