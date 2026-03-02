'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Card, Form, Input, Button, message, Select } from 'antd';
import MainLayout from '../../../../../components/Layout';
import { contact } from '../../../../../lib/api';

export default function PayeeEditPage() {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const router = useRouter();
  const params = useParams();
  const payeeId = params.id;

  useEffect(() => {
    loadPayee();
  }, [payeeId]);

  const loadPayee = async () => {
    try {
      const response = await contact.getPayee(payeeId);
      if (response.data.code === 200) {
        form.setFieldsValue(response.data.data);
      }
    } catch (error) {
      message.error('Failed to load payee');
    } finally {
      setInitialLoading(false);
    }
  };

  const onFinish = async (values) => {
    try {
      setLoading(true);
      await contact.updatePayee(payeeId, values);
      message.success('Payee updated successfully');
      router.push(`/contacts/payee/${payeeId}/detail`);
    } catch (error) {
      message.error('Failed to update payee');
    } finally {
      setLoading(false);
    }
  };

  return (
    <MainLayout>
      <Card title="Edit Payee" loading={initialLoading}>
        <Form form={form} layout="vertical" onFinish={onFinish}>
          <Form.Item name="name" label="Name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="email" label="Email" rules={[{ type: 'email' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="phone" label="Phone">
            <Input />
          </Form.Item>
          <Form.Item name="type" label="Type">
            <Select options={[
              { label: 'Contractor', value: 'CONTRACTOR' },
              { label: 'Supplier', value: 'SUPPLIER' },
              { label: 'Utility', value: 'UTILITY' },
              { label: 'Insurance', value: 'INSURANCE' },
              { label: 'Other', value: 'OTHER' },
            ]} />
          </Form.Item>
          <Form.Item name="address" label="Address">
            <Input.TextArea rows={2} />
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
            <Button type="primary" htmlType="submit" loading={loading}>Update Payee</Button>
          </Form.Item>
        </Form>
      </Card>
    </MainLayout>
  );
}
