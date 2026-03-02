'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, Form, Input, Button, Space, message, Checkbox, Row, Col, Divider } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import MainLayout from '../../../../components/Layout';
import { role } from '../../../../lib/api';

const PERMISSION_GROUPS = [
  { group: 'Properties', perms: [{ key: 'property.view', label: 'View' }, { key: 'property.manage', label: 'Manage' }] },
  { group: 'Tenants', perms: [{ key: 'tenant.view', label: 'View' }, { key: 'tenant.manage', label: 'Manage' }] },
  { group: 'Leasing', perms: [{ key: 'leasing.view', label: 'View' }, { key: 'leasing.manage', label: 'Manage' }] },
  { group: 'Invoices', perms: [{ key: 'invoice.view', label: 'View' }, { key: 'invoice.manage', label: 'Manage' }] },
  { group: 'Accounting', perms: [{ key: 'accounting.view', label: 'View' }, { key: 'accounting.manage', label: 'Manage' }] },
  { group: 'Services', perms: [{ key: 'service.view', label: 'View' }, { key: 'service.manage', label: 'Manage' }] },
  { group: 'Contacts', perms: [{ key: 'contacts.view', label: 'View' }, { key: 'contacts.manage', label: 'Manage' }] },
  { group: 'Settings', perms: [{ key: 'settings.view', label: 'View' }, { key: 'settings.manage', label: 'Manage' }] },
  { group: 'Reports', perms: [{ key: 'reports.view', label: 'View' }] },
];

export default function CreateRolePage() {
  const router = useRouter();
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);

  const onFinish = async (values) => {
    setSubmitting(true);
    try {
      const permissions = values.permissions || [];
      await role.create({ ...values, permissions: permissions.join(','), status: 1 });
      message.success('Role created');
      router.push('/settings?tab=roles');
    } catch (error) {
      message.error('Failed to create role');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <MainLayout>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => router.push('/settings?tab=roles')}>Back</Button>
        <Card title="Create Role">
          <Form form={form} layout="vertical" onFinish={onFinish} style={{ maxWidth: 800 }}>
            <Form.Item name="name" label="Role Name" rules={[{ required: true }]}>
              <Input placeholder="e.g. Property Manager" />
            </Form.Item>
            <Form.Item name="description" label="Description">
              <Input.TextArea rows={2} placeholder="Describe what this role can do" />
            </Form.Item>
            <Divider>Permissions</Divider>
            <Form.Item name="permissions">
              <Checkbox.Group style={{ width: '100%' }}>
                <Row gutter={[16, 8]}>
                  {PERMISSION_GROUPS.map(({ group, perms }) => (
                    <Col span={24} key={group}>
                      <strong style={{ color: '#666' }}>{group}</strong>
                      <Row style={{ marginTop: 4, marginBottom: 8 }}>
                        {perms.map(p => (
                          <Col span={6} key={p.key}>
                            <Checkbox value={p.key}>{p.label}</Checkbox>
                          </Col>
                        ))}
                      </Row>
                    </Col>
                  ))}
                  <Col span={24}>
                    <Checkbox value="admin" style={{ fontWeight: 'bold', color: '#f5222d' }}>
                      Administrator (Full Access)
                    </Checkbox>
                  </Col>
                </Row>
              </Checkbox.Group>
            </Form.Item>
            <Form.Item>
              <Space>
                <Button onClick={() => router.push('/settings?tab=roles')}>Cancel</Button>
                <Button type="primary" htmlType="submit" loading={submitting}>Create Role</Button>
              </Space>
            </Form.Item>
          </Form>
        </Card>
      </Space>
    </MainLayout>
  );
}
