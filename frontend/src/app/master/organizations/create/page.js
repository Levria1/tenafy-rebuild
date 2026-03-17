'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Form, Input, Button, Card, message } from 'antd';
import { master } from '../../../../lib/api';

export default function CreateOrganizationPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  const onFinish = async (values) => {
    setLoading(true);
    try {
      const res = await master.createOrganization(values);
      if (res.data.code === 200) {
        message.success('Organization created successfully');
        router.push('/master/dashboard');
      } else {
        message.error(res.data.message || 'Failed to create organization');
      }
    } catch (err) {
      message.error(err.response?.data?.message || 'Failed to create organization');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ maxWidth: 600, margin: '0 auto' }}>
      <h2 style={{ marginBottom: 24 }}>Create Organization</h2>
      <Card>
        <Form layout="vertical" onFinish={onFinish} size="large">
          <Form.Item
            label="Organization Name"
            name="display_name"
            rules={[{ required: true, message: 'Required' }]}
          >
            <Input placeholder="e.g. Acme Properties" />
          </Form.Item>

          <div style={{ background: '#fafafa', padding: 16, borderRadius: 8, marginBottom: 24 }}>
            <h4 style={{ marginTop: 0 }}>Super Admin Account</h4>

            <Form.Item
              label="Username (email)"
              name="admin_username"
              rules={[{ required: true, message: 'Required' }, { type: 'email', message: 'Must be a valid email' }]}
            >
              <Input placeholder="admin@example.com" />
            </Form.Item>

            <Form.Item
              label="Password"
              name="admin_password"
              rules={[{ required: true, message: 'Required' }, { min: 6, message: 'At least 6 characters' }]}
            >
              <Input.Password placeholder="Password for org super admin" />
            </Form.Item>

            <div style={{ display: 'flex', gap: 16 }}>
              <Form.Item label="First Name" name="admin_first_name" style={{ flex: 1 }}>
                <Input placeholder="First name" />
              </Form.Item>
              <Form.Item label="Last Name" name="admin_last_name" style={{ flex: 1 }}>
                <Input placeholder="Last name" />
              </Form.Item>
            </div>

            <Form.Item label="Email" name="admin_email">
              <Input placeholder="Same as username if blank" />
            </Form.Item>
          </div>

          <Form.Item>
            <div style={{ display: 'flex', gap: 12 }}>
              <Button onClick={() => router.push('/master/dashboard')}>Cancel</Button>
              <Button type="primary" htmlType="submit" loading={loading}>
                Create Organization
              </Button>
            </div>
          </Form.Item>
        </Form>
      </Card>
    </div>
  );
}
