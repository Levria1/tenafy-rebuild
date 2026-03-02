'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, Form, Input, Button, Space, message, Select } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import MainLayout from '../../../../components/Layout';
import { amenity } from '../../../../lib/api';

const AMENITY_TYPES = [
  { label: 'Indoor', value: 'INDOOR' }, { label: 'Outdoor', value: 'OUTDOOR' },
  { label: 'Parking', value: 'PARKING' }, { label: 'Security', value: 'SECURITY' },
  { label: 'Recreational', value: 'RECREATIONAL' }, { label: 'Utilities', value: 'UTILITIES' },
  { label: 'Accessibility', value: 'ACCESSIBILITY' }, { label: 'Other', value: 'OTHER' },
];

export default function CreateAmenityPage() {
  const router = useRouter();
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);

  const onFinish = async (values) => {
    setSubmitting(true);
    try {
      await amenity.create({ ...values, status: 1 });
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
          <Form form={form} layout="vertical" onFinish={onFinish} style={{ maxWidth: 600 }}>
            <Form.Item name="name" label="Amenity Name" rules={[{ required: true }]}>
              <Input placeholder="e.g. Swimming Pool" />
            </Form.Item>
            <Form.Item name="type" label="Type" rules={[{ required: true }]}>
              <Select options={AMENITY_TYPES} placeholder="Select type" />
            </Form.Item>
            <Form.Item name="description" label="Description">
              <Input.TextArea rows={3} placeholder="Optional description" />
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
