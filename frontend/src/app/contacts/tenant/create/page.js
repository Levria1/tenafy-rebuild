'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, Form, Input, Button, Select, message, DatePicker } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import MainLayout from '../../../../components/Layout';
import { tenant } from '../../../../lib/api';

export default function TenantCreatePage() {
  const router = useRouter();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);

  const onFinish = async (values) => {
    try {
      setLoading(true);
      const response = await tenant.create(values);
      if (response.data.code === 200) {
        message.success('Tenant created successfully');
        router.push('/contacts/tenant');
      } else {
        message.error(response.data.message || 'Failed to create tenant');
      }
    } catch (error) {
      message.error(error.response?.data?.message || 'Failed to create tenant');
    } finally {
      setLoading(false);
    }
  };

  return (
    <MainLayout>
      <div style={{ maxWidth: 800, margin: '0 auto' }}>
        <Button 
          icon={<ArrowLeftOutlined />} 
          onClick={() => router.push('/contacts/tenant')}
          style={{ marginBottom: 16 }}
        >
          Back to Tenants
        </Button>
        
        <Card title="Add New Tenant">
          <Form
            form={form}
            layout="vertical"
            onFinish={onFinish}
          >
            <Form.Item
              name="first_name"
              label="First Name"
              rules={[{ required: true, message: 'Please enter first name' }]}
            >
              <Input placeholder="First name" />
            </Form.Item>

            <Form.Item
              name="last_name"
              label="Last Name"
              rules={[{ required: true, message: 'Please enter last name' }]}
            >
              <Input placeholder="Last name" />
            </Form.Item>

            <Form.Item
              name="email"
              label="Email"
              rules={[{ type: 'email', message: 'Please enter a valid email' }]}
            >
              <Input placeholder="email@example.com" />
            </Form.Item>

            <Form.Item
              name="phone"
              label="Phone"
            >
              <Input placeholder="Phone number" />
            </Form.Item>

            <Form.Item
              name="company_name"
              label="Company Name"
            >
              <Input placeholder="Company (optional)" />
            </Form.Item>

            <Form.Item
              name="address"
              label="Address"
            >
              <Input.TextArea rows={2} placeholder="Address" />
            </Form.Item>

            <Form.Item
              name="nationality"
              label="Nationality"
            >
              <Input placeholder="e.g., US, UK, CA" />
            </Form.Item>

            <Form.Item
              name="id_number"
              label="ID Number"
            >
              <Input placeholder="Passport or ID number" />
            </Form.Item>

            <Form.Item
              name="birth_date"
              label="Date of Birth"
            >
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>

            <Form.Item>
              <Button type="primary" htmlType="submit" loading={loading}>
                Create Tenant
              </Button>
            </Form.Item>
          </Form>
        </Card>
      </div>
    </MainLayout>
  );
}
