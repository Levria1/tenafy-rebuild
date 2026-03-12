'use client';
import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
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

export default function EditAmenityPage() {
  const router = useRouter();
  const params = useParams();
  const amenityId = params.id;
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    amenity.get(amenityId).then(r => {
      if (r.data.code === 200) {
        const d = r.data.data;
        form.setFieldsValue({
          display_name: d.display_name,
          category: Number(d.category),
          type: Number(d.type),
        });
      }
    }).catch(() => message.error('Failed to load amenity')).finally(() => setLoading(false));
  }, [amenityId]);

  const onFinish = async (values) => {
    setSubmitting(true);
    try {
      await amenity.update(amenityId, {
        display_name: values.display_name,
        category: values.category,
        type: values.type,
      });
      message.success('Amenity updated');
      router.push('/settings?tab=amenities');
    } catch (error) {
      message.error('Failed to update amenity');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <MainLayout>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => router.push('/settings?tab=amenities')}>Back</Button>
        <Card title="Edit Amenity" loading={loading}>
          <Form form={form} layout="vertical" onFinish={onFinish} style={{ maxWidth: 600 }}>
            <Form.Item name="display_name" label="Display Name" rules={[{ required: true, message: 'Please enter a display name' }]}>
              <Input />
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
                <Button type="primary" htmlType="submit" loading={submitting}>Save Changes</Button>
              </Space>
            </Form.Item>
          </Form>
        </Card>
      </Space>
    </MainLayout>
  );
}
