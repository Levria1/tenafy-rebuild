'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Card, Form, Input, InputNumber, Select, Button, message, Tabs, Table, Tag, Space } from 'antd';
import MainLayout from '../../../../../components/Layout';
import { property as propertyApi } from '../../../../../lib/api';

export default function PropertyUnitCreatePage() {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const params = useParams();
  const propertyId = params.id;

  useEffect(() => {
    if (propertyId) {
      form.setFieldValue('property_id', propertyId);
    }
  }, [propertyId]);

  const onFinish = async (values) => {
    try {
      setLoading(true);
      await propertyApi.createUnit(propertyId, values);
      message.success('Unit created successfully');
      router.push(`/property/${propertyId}/detail`);
    } catch (error) {
      message.error('Failed to create unit');
    } finally {
      setLoading(false);
    }
  };

  return (
    <MainLayout>
      <Card title="Add New Unit">
        <Form form={form} layout="vertical" onFinish={onFinish}>
          <Form.Item name="property_id" label="Property ID" rules={[{ required: true }]}>
            <Input disabled />
          </Form.Item>
          <Form.Item name="unit_number" label="Unit Number" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="unit_name" label="Unit Name">
            <Input />
          </Form.Item>
          <Form.Item name="floor" label="Floor">
            <InputNumber style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="bedroom_count" label="Bedrooms" rules={[{ required: true }]}>
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="bathroom_count" label="Bathrooms">
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="size" label="Size (sq ft)">
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="monthly_rent" label="Monthly Rent" rules={[{ required: true }]}>
            <InputNumber min={0} style={{ width: '100%' }} formatter={value => `$ ${value}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',')} />
          </Form.Item>
          <Form.Item name="deposit" label="Deposit">
            <InputNumber min={0} style={{ width: '100%' }} formatter={value => `$ ${value}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',')} />
          </Form.Item>
          <Form.Item name="status" label="Status" initialValue="VACANT">
            <Select options={[
              { label: 'Vacant', value: 'VACANT' },
              { label: 'Occupied', value: 'OCCUPIED' },
              { label: 'Maintenance', value: 'MAINTENANCE' },
              { label: 'Unavailable', value: 'UNAVAILABLE' },
            ]} />
          </Form.Item>
          <Form.Item name="furnishing" label="Furnishing">
            <Select options={[
              { label: 'Unfurnished', value: 'UNFURNISHED' },
              { label: 'Partially Furnished', value: 'PARTIALLY_FURNISHED' },
              { label: 'Fully Furnished', value: 'FULLY_FURNISHED' },
            ]} />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={4} />
          </Form.Item>
          <Form.Item>
            <Space>
              <Button type="primary" htmlType="submit" loading={loading}>Create Unit</Button>
              <Button onClick={() => router.back()}>Cancel</Button>
            </Space>
          </Form.Item>
        </Form>
      </Card>
    </MainLayout>
  );
}
