'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, Form, Input, Button, Select, InputNumber, message, Spin } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import MainLayout from '../../../components/Layout';
import { property } from '../../../lib/api';

export default function PropertyCreatePage() {
  const router = useRouter();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(false);

  const onFinish = async (values) => {
    try {
      setLoading(true);
      const response = await property.create(values);
      if (response.data.code === 200) {
        message.success('Property created successfully');
        router.push('/property');
      } else {
        message.error(response.data.message || 'Failed to create property');
      }
    } catch (error) {
      message.error(error.response?.data?.message || 'Failed to create property');
    } finally {
      setLoading(false);
    }
  };

  return (
    <MainLayout>
      <div style={{ maxWidth: 800, margin: '0 auto' }}>
        <Button 
          icon={<ArrowLeftOutlined />} 
          onClick={() => router.push('/property')}
          style={{ marginBottom: 16 }}
        >
          Back to Properties
        </Button>
        
        <Card title="Add New Property">
          <Form
            form={form}
            layout="vertical"
            onFinish={onFinish}
            initialValues={{
              currency: 'USD',
              status: 1
            }}
          >
            <Form.Item
              name="display_name"
              label="Property Name"
              rules={[{ required: true, message: 'Please enter property name' }]}
            >
              <Input placeholder="e.g., Sunset Apartments" />
            </Form.Item>

            <Form.Item
              name="address"
              label="Address"
              rules={[{ required: true, message: 'Please enter address' }]}
            >
              <Input.TextArea rows={2} placeholder="Full address" />
            </Form.Item>

            <Form.Item
              name="description"
              label="Description"
            >
              <Input.TextArea rows={3} placeholder="Property description (optional)" />
            </Form.Item>

            <Form.Item
              name="currency"
              label="Currency"
            >
              <Select>
                <Select.Option value="USD">USD - US Dollar</Select.Option>
                <Select.Option value="EUR">EUR - Euro</Select.Option>
                <Select.Option value="GBP">GBP - British Pound</Select.Option>
                <Select.Option value="CAD">CAD - Canadian Dollar</Select.Option>
              </Select>
            </Form.Item>

            <Form.Item
              name="status"
              label="Status"
            >
              <Select>
                <Select.Option value={1}>Active</Select.Option>
                <Select.Option value={0}>Inactive</Select.Option>
              </Select>
            </Form.Item>

            <Form.Item>
              <Button type="primary" htmlType="submit" loading={loading}>
                Create Property
              </Button>
            </Form.Item>
          </Form>
        </Card>
      </div>
    </MainLayout>
  );
}
