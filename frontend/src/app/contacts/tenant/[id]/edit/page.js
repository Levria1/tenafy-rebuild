'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Card, Form, Input, Button, message, Select } from 'antd';
import MainLayout from '../../../../../components/Layout';
import { tenant } from '../../../../../lib/api';

export default function TenantEditPage() {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const router = useRouter();
  const params = useParams();
  const tenantId = params.id;

  useEffect(() => {
    loadTenant();
  }, [tenantId]);

  const loadTenant = async () => {
    try {
      const response = await tenant.get(tenantId);
      if (response.data.code === 200) {
        form.setFieldsValue(response.data.data);
      }
    } catch (error) {
      message.error('Failed to load tenant');
    } finally {
      setInitialLoading(false);
    }
  };

  const onFinish = async (values) => {
    try {
      setLoading(true);
      await tenant.update(tenantId, values);
      message.success('Tenant updated successfully');
      router.push(`/contacts/tenant/${tenantId}/detail`);
    } catch (error) {
      message.error('Failed to update tenant');
    } finally {
      setLoading(false);
    }
  };

  return (
    <MainLayout>
      <Card title="Edit Tenant" loading={initialLoading}>
        <Form form={form} layout="vertical" onFinish={onFinish}>
          <Form.Item name="first_name" label="First Name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="last_name" label="Last Name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="email" label="Email" rules={[{ required: true, type: 'email' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="phone" label="Phone">
            <Input />
          </Form.Item>
          <Form.Item name="id_type" label="ID Type">
            <Select options={[
              { label: 'Passport', value: 'PASSPORT' },
              { label: 'Driver License', value: 'DRIVER_LICENSE' },
              { label: 'National ID', value: 'NATIONAL_ID' },
              { label: 'Other', value: 'OTHER' },
            ]} />
          </Form.Item>
          <Form.Item name="id_number" label="ID Number">
            <Input />
          </Form.Item>
          <Form.Item name="address" label="Address">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item name="emergency_contact" label="Emergency Contact">
            <Input />
          </Form.Item>
          <Form.Item name="emergency_phone" label="Emergency Phone">
            <Input />
          </Form.Item>
          <Form.Item name="notes" label="Notes">
            <Input.TextArea rows={3} />
          </Form.Item>
          <Form.Item name="status" label="Status" initialValue={1}>
            <Select options={[
              { label: 'Active', value: 1 },
              { label: 'Inactive', value: 0 },
            ]} />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={loading}>Update Tenant</Button>
          </Form.Item>
        </Form>
      </Card>
    </MainLayout>
  );
}
