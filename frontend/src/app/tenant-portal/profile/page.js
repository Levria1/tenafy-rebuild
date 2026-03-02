'use client';

import { useEffect, useState } from 'react';
import { Form, Input, Button, Card, Typography, Descriptions, message, Divider } from 'antd';
import { UserOutlined, EditOutlined, SaveOutlined } from '@ant-design/icons';
import { tenantPortal } from '../../../lib/tenantApi';

const { Title, Text } = Typography;

export default function TenantProfilePage() {
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [form] = Form.useForm();

  useEffect(() => {
    loadProfile();
  }, []);

  const loadProfile = async () => {
    try {
      const response = await tenantPortal.getProfile();
      if (response.data.code === 200) {
        setProfile(response.data.data);
        form.setFieldsValue({
          phone: response.data.data.phone || '',
          address: response.data.data.address || '',
        });
      } else {
        message.error(response.data.message || 'Failed to load profile');
      }
    } catch (error) {
      message.error(error.response?.data?.message || 'Failed to load profile');
    } finally {
      setLoading(false);
    }
  };

  const onFinish = async (values) => {
    setSaving(true);
    try {
      const response = await tenantPortal.updateProfile(values);
      if (response.data.code === 200) {
        message.success('Profile updated successfully');
        setProfile((prev) => ({ ...prev, ...values }));
        setEditing(false);
      } else {
        message.error(response.data.message || 'Failed to update profile');
      }
    } catch (error) {
      message.error(error.response?.data?.message || 'Failed to update profile');
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    form.setFieldsValue({
      phone: profile?.phone || '',
      address: profile?.address || '',
    });
    setEditing(false);
  };

  if (loading) {
    return (
      <div>
        <Title level={2} style={{ marginBottom: 24, marginTop: 0 }}>
          My Profile
        </Title>
        <Card loading style={{ borderRadius: 8 }} />
      </div>
    );
  }

  return (
    <div>
      <Title level={2} style={{ marginBottom: 24, marginTop: 0 }}>
        My Profile
      </Title>

      <Card
        style={{ borderRadius: 8, maxWidth: 720 }}
        extra={
          !editing && (
            <Button icon={<EditOutlined />} onClick={() => setEditing(true)}>
              Edit
            </Button>
          )
        }
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 24 }}>
          <div
            style={{
              width: 64,
              height: 64,
              borderRadius: '50%',
              background: '#1890ff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <UserOutlined style={{ color: '#fff', fontSize: 28 }} />
          </div>
          <div>
            <div style={{ fontSize: 20, fontWeight: 600, color: '#262626' }}>
              {profile?.first_name} {profile?.last_name}
            </div>
            <Text type="secondary">{profile?.email}</Text>
          </div>
        </div>

        <Divider />

        {!editing ? (
          <Descriptions column={1} labelStyle={{ fontWeight: 600, width: 140 }}>
            <Descriptions.Item label="First Name">{profile?.first_name || 'N/A'}</Descriptions.Item>
            <Descriptions.Item label="Last Name">{profile?.last_name || 'N/A'}</Descriptions.Item>
            <Descriptions.Item label="Email">{profile?.email || 'N/A'}</Descriptions.Item>
            <Descriptions.Item label="Phone">{profile?.phone || 'Not provided'}</Descriptions.Item>
            <Descriptions.Item label="Address">{profile?.address || 'Not provided'}</Descriptions.Item>
          </Descriptions>
        ) : (
          <Form form={form} onFinish={onFinish} layout="vertical">
            <Form.Item label="First Name">
              <Input value={profile?.first_name} disabled />
            </Form.Item>
            <Form.Item label="Last Name">
              <Input value={profile?.last_name} disabled />
            </Form.Item>
            <Form.Item label="Email">
              <Input value={profile?.email} disabled />
            </Form.Item>
            <Form.Item
              name="phone"
              label="Phone"
              rules={[{ max: 50, message: 'Phone number is too long' }]}
            >
              <Input placeholder="Enter phone number" />
            </Form.Item>
            <Form.Item
              name="address"
              label="Address"
              rules={[{ max: 255, message: 'Address is too long' }]}
            >
              <Input.TextArea rows={3} placeholder="Enter address" />
            </Form.Item>

            <div style={{ display: 'flex', gap: 8 }}>
              <Button
                type="primary"
                htmlType="submit"
                loading={saving}
                icon={<SaveOutlined />}
              >
                Save Changes
              </Button>
              <Button onClick={handleCancel}>Cancel</Button>
            </div>
          </Form>
        )}
      </Card>
    </div>
  );
}
