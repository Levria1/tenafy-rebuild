'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, Form, Input, Button, Select, DatePicker, Row, Col, message } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import MainLayout from '../../../../components/Layout';
import { contact } from '../../../../lib/api';

export default function ServiceVendorCreatePage() {
  const router = useRouter();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);

  const onFinish = async (values) => {
    try {
      setLoading(true);
      const response = await contact.createServiceVendor({
        ...values,
        birth_date: values.birth_date?.format('YYYY-MM-DD') || null,
      });
      if (response.data.code === 200) {
        message.success('Service vendor created successfully');
        router.push('/contacts?tab=service-vendors');
      } else {
        message.error(response.data.message || 'Failed to create service vendor');
      }
    } catch (error) {
      message.error(error.response?.data?.message || 'Failed to create service vendor');
    } finally {
      setLoading(false);
    }
  };

  return (
    <MainLayout>
      <div style={{ maxWidth: 800, margin: '0 auto' }}>
        <Button
          icon={<ArrowLeftOutlined />}
          onClick={() => router.push('/contacts?tab=service-vendors')}
          style={{ marginBottom: 16 }}
        >
          Back to Contacts
        </Button>

        <Card title="Add New Service Vendor">
          <Form form={form} layout="vertical" onFinish={onFinish}>
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item
                  name="first_name"
                  label="First Name"
                  rules={[{ required: true, message: 'Please enter first name' }]}
                >
                  <Input placeholder="First name" />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  name="last_name"
                  label="Last Name"
                  rules={[{ required: true, message: 'Please enter last name' }]}
                >
                  <Input placeholder="Last name" />
                </Form.Item>
              </Col>
            </Row>

            <Row gutter={16}>
              <Col span={12}>
                <Form.Item
                  name="email"
                  label="Email"
                  rules={[{ required: true, type: 'email', message: 'Please enter a valid email' }]}
                >
                  <Input placeholder="email@example.com" />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item name="phone" label="Phone">
                  <Input placeholder="Phone number" />
                </Form.Item>
              </Col>
            </Row>

            <Row gutter={16}>
              <Col span={12}>
                <Form.Item name="id_card" label="ID Card / Passport">
                  <Input placeholder="Passport or ID number" />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item name="birth_date" label="Birth Date">
                  <DatePicker style={{ width: '100%' }} />
                </Form.Item>
              </Col>
            </Row>

            <Form.Item name="sex" label="Sex">
              <Select allowClear placeholder="Select" options={[
                { label: 'Male', value: 0 },
                { label: 'Female', value: 1 },
              ]} />
            </Form.Item>

            <Form.Item name="notes" label="Notes">
              <Input.TextArea rows={3} placeholder="Additional notes (license numbers, certifications, etc.)" />
            </Form.Item>

            <Form.Item>
              <Button type="primary" htmlType="submit" loading={loading}>
                Create Service Vendor
              </Button>
            </Form.Item>
          </Form>
        </Card>
      </div>
    </MainLayout>
  );
}
