'use client';
import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Card, Form, Input, Button, Space, message, Select, Row, Col, Switch } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import MainLayout from '../../../../../components/Layout';
import { user, role } from '../../../../../lib/api';

export default function EditUserPage() {
  const router = useRouter();
  const params = useParams();
  const userId = params.id;
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [roles, setRoles] = useState([]);

  useEffect(() => {
    Promise.all([
      user.getUser(userId),
      role.getAll(),
    ]).then(([userRes, roleRes]) => {
      if (userRes.data.code === 200) form.setFieldsValue(userRes.data.data);
      if (roleRes.data.code === 200) {
        setRoles((roleRes.data.data || []).map(ro => ({ label: ro.name, value: ro.id })));
      }
    }).catch(() => message.error('Failed to load user')).finally(() => setLoading(false));
  }, [userId]);

  const onFinish = async (values) => {
    setSubmitting(true);
    try {
      await user.updateUser(userId, values);
      message.success('User updated');
      router.push('/settings?tab=users');
    } catch (error) {
      message.error('Failed to update user');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <MainLayout>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => router.push('/settings?tab=users')}>Back</Button>
        <Card title="Edit User" loading={loading}>
          <Form form={form} layout="vertical" onFinish={onFinish} style={{ maxWidth: 700 }}>
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item name="username" label="Username">
                  <Input disabled />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item name="email" label="Email" rules={[{ type: 'email' }]}>
                  <Input />
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
            <Form.Item name="status" label="Active" valuePropName="checked">
              <Switch />
            </Form.Item>
            <Form.Item>
              <Space>
                <Button onClick={() => router.push('/settings?tab=users')}>Cancel</Button>
                <Button type="primary" htmlType="submit" loading={submitting}>Save Changes</Button>
              </Space>
            </Form.Item>
          </Form>
        </Card>
      </Space>
    </MainLayout>
  );
}
