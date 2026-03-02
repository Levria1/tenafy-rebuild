'use client';
import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
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

export default function EditAmenityPage() {
  const router = useRouter();
  const params = useParams();
  const amenityId = params.id;
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    amenity.get(amenityId).then(r => {
      if (r.data.code === 200) form.setFieldsValue(r.data.data);
    }).catch(() => message.error('Failed to load amenity')).finally(() => setLoading(false));
  }, [amenityId]);

  const onFinish = async (values) => {
    setSubmitting(true);
    try {
      await amenity.update(amenityId, values);
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
            <Form.Item name="name" label="Amenity Name" rules={[{ required: true }]}>
              <Input />
            </Form.Item>
            <Form.Item name="type" label="Type" rules={[{ required: true }]}>
              <Select options={AMENITY_TYPES} />
            </Form.Item>
            <Form.Item name="description" label="Description">
              <Input.TextArea rows={3} />
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
