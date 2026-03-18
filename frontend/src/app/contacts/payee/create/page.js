'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, Form, Input, Button, message, Select } from 'antd';
import MainLayout from '../../../../components/Layout';
import { contact } from '../../../../lib/api';

export default function PayeeCreatePage() {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const onFinish = async (values) => {
    try {
      setLoading(true);
      await contact.createPayee(values);
      message.success('Payee created successfully');
      router.push('/contacts?tab=payees');
    } catch (error) {
      message.error('Failed to create payee');
    } finally {
      setLoading(false);
    }
  };

  return (
    <MainLayout>
      <Card title="Add New Payee">
        <Form form={form} layout="vertical" onFinish={onFinish}>
          <Form.Item name="first_name" label="First Name" rules={[{ required: true, message: 'Please enter the first name' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="last_name" label="Last Name">
            <Input />
          </Form.Item>
          <Form.Item name="email" label="Email" rules={[{ type: 'email' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="phone" label="Phone">
            <Input />
          </Form.Item>
          <Form.Item name="company_name" label="Company Name">
            <Input />
          </Form.Item>
          <Form.Item name="notes" label="Notes">
            <Input.TextArea rows={3} />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={loading}>Create Payee</Button>
          </Form.Item>
        </Form>
      </Card>
    </MainLayout>
  );
}
