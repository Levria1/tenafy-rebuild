'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Card, Form, Input, InputNumber, Select, Button, message } from 'antd';
import MainLayout from '../../../../../../components/Layout';
import { property as propertyApi } from '../../../../../../lib/api';

export default function UnitEditPage() {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const router = useRouter();
  const params = useParams();
  const unitId = params.unitid;

  useEffect(() => {
    loadUnit();
  }, [unitId]);

  const loadUnit = async () => {
    try {
      const response = await propertyApi.getUnit(unitId);
      if (response.data.code === 200) {
        form.setFieldsValue(response.data.data);
      }
    } catch (error) {
      message.error('Failed to load unit');
    } finally {
      setInitialLoading(false);
    }
  };

  const onFinish = async (values) => {
    try {
      setLoading(true);
      await propertyApi.updateUnit(unitId, values);
      message.success('Unit updated successfully');
      router.push(`/property/unit/${unitId}`);
    } catch (error) {
      message.error('Failed to update unit');
    } finally {
      setLoading(false);
    }
  };

  return (
    <MainLayout>
      <Card title="Edit Unit" loading={initialLoading}>
        <Form form={form} layout="vertical" onFinish={onFinish}>
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
          <Form.Item name="status" label="Status">
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
            <Button type="primary" htmlType="submit" loading={loading}>Update Unit</Button>
          </Form.Item>
        </Form>
      </Card>
    </MainLayout>
  );
}
