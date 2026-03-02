'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Card, Form, Input, Button, Space, message, Select, Row, Col } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import MainLayout from '../../../../components/Layout';
import { user, role } from '../../../../lib/api';

export default function CreateUserPage() {
  const router = useRouter();
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [roles, setRoles] = useState([]);

  useEffect(() => {
    role.getAll().then(r => {
      if (r.data.code === 200) {
        setRoles((r.data.data || []).map(ro => ({ label: ro.name, value: ro.id })));
      }
    }).catch(() => {});
  }, []);

  const onFinish = async (values) => {
    setSubmitting(true);
    try {
      await user.createUser({ ...values, status: 1 });
      message.success('User created successfully');
      router.push('/settings?tab=users');
    } catch (error) {
      message.error(error.response?.data?.message || 'Failed to create user');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <MainLayout>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => router.push('/settings?tab=users')}>Back</Button>
        <Card title="Create User">
          <Form form={form} layout="vertical" onFinish={onFinish} style={{ maxWidth: 700 }}>
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item name="username" label="Username" rules={[{ required: true }]}>
                  <Input placeholder="username" />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item name="email" label="Email" rules={[{ required: true, type: 'email' }]}>
                  <Input placeholder="user@example.com" />
                </Form.Item>
              </Col>
            </Row>
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item name="first_name" label="First Name">
                  <Input />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item name="last_name" label="Last Name">
                  <Input />
                </Form.Item>
              </Col>
            </Row>
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item name="phone" label="Phone">
                  <Input />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item name="role_id" label="Role">
                  <Select options={roles} placeholder="Select role" allowClear />
                </Form.Item>
              </Col>
            </Row>
            <Form.Item name="password" label="Password" rules={[{ required: true, min: 6 }]}>
              <Input.Password placeholder="Minimum 6 characters" />
            </Form.Item>
            <Form.Item>
              <Space>
                <Button onClick={() => router.push('/settings?tab=users')}>Cancel</Button>
                <Button type="primary" htmlType="submit" loading={submitting}>Create User</Button>
              </Space>
            </Form.Item>
          </Form>
        </Card>
      </Space>
    </MainLayout>
  );
}
