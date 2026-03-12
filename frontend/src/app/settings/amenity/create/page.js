'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, Form, Input, Button, Space, message, Select } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import MainLayout from '../../../../components/Layout';
import { amenity } from '../../../../lib/api';

const CATEGORY_OPTIONS = [
  { label: 'Property', value: 0 },
  { label: 'Unit', value: 1 },
];
const TYPE_OPTIONS = [
  { label: 'Residential', value: 1 },
  { label: 'Commercial', value: 2 },
];

export default function CreateAmenityPage() {
  const router = useRouter();
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);

  const onFinish = async (values) => {
    setSubmitting(true);
    try {
      await amenity.create({
        display_name: values.display_name,
        category: values.category,
        type: values.type,
      });
      message.success('Amenity created');
      router.push('/settings?tab=amenities');
    } catch (error) {
      message.error('Failed to create amenity');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <MainLayout>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => router.push('/settings?tab=amenities')}>Back</Button>
        <Card title="Create Amenity">
          <Form form={form} layout="vertical" onFinish={onFinish} style={{ maxWidth: 600 }}
            initialValues={{ category: 0, type: 1 }}>
            <Form.Item name="display_name" label="Display Name" rules={[{ required: true, message: 'Please enter a display name' }]}>
              <Input placeholder="e.g. Swimming Pool" />
            </Form.Item>
            <Form.Item name="category" label="Category" rules={[{ required: true }]}>
              <Select options={CATEGORY_OPTIONS} />
            </Form.Item>
            <Form.Item name="type" label="Type" rules={[{ required: true }]}>
              <Select options={TYPE_OPTIONS} />
            </Form.Item>
            <Form.Item>
              <Space>
                <Button onClick={() => router.push('/settings?tab=amenities')}>Cancel</Button>
                <Button type="primary" htmlType="submit" loading={submitting}>Create Amenity</Button>
              </Space>
            </Form.Item>
          </Form>
        </Card>
      </Space>
    </MainLayout>
  );
}
