'use client';
import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Card, Form, Input, Button, Space, message, Checkbox, Row, Col, Select } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import MainLayout from '../../../../../components/Layout';
import { role } from '../../../../../lib/api';

function PermissionCheckboxes({ value = [], onChange, permissionGroups, leftGroups, rightGroups }) {
  const selected = value || [];

  const toggle = (key) => {
    const next = selected.includes(key) ? selected.filter(k => k !== key) : [...selected, key];
    onChange(next);
  };

  const toggleGroup = (groupName, checked) => {
    const groupPerms = permissionGroups[groupName].map(p => p.key);
    let next;
    if (checked) {
      next = [...new Set([...selected, ...groupPerms])];
    } else {
      next = selected.filter(p => !groupPerms.includes(p));
    }
    onChange(next);
  };

  const renderGroups = (groups) => groups.map(groupName => {
    const groupPerms = permissionGroups[groupName].map(p => p.key);
    const allChecked = groupPerms.length > 0 && groupPerms.every(p => selected.includes(p));
    const someChecked = !allChecked && groupPerms.some(p => selected.includes(p));

    return (
      <div key={groupName} style={{ marginBottom: 12 }}>
        <Checkbox
          checked={allChecked}
          indeterminate={someChecked}
          onChange={(e) => toggleGroup(groupName, e.target.checked)}
          style={{ fontWeight: 600, fontSize: 13 }}
        >
          {groupName}
        </Checkbox>
        {permissionGroups[groupName].map(p => (
          <div key={p.key} style={{ marginLeft: 24, marginTop: 2 }}>
            <Checkbox
              checked={selected.includes(p.key)}
              onChange={() => toggle(p.key)}
            >
              {p.label}
            </Checkbox>
          </div>
        ))}
      </div>
    );
  });

  return (
    <Row gutter={24}>
      <Col span={12}>{renderGroups(leftGroups)}</Col>
      <Col span={12}>{renderGroups(rightGroups)}</Col>
    </Row>
  );
}

export default function EditRolePage() {
  const router = useRouter();
  const params = useParams();
  const roleId = params.id;
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [permissionGroups, setPermissionGroups] = useState({});

  useEffect(() => {
    Promise.all([
      role.getPermissions(),
      role.get(roleId),
    ]).then(([permRes, roleRes]) => {
      if (permRes.data.code === 200) {
        const grouped = {};
        (permRes.data.data || []).forEach(p => {
          if (!grouped[p.group]) grouped[p.group] = [];
          grouped[p.group].push(p);
        });
        setPermissionGroups(grouped);
      }
      if (roleRes.data.code === 200) {
        const data = roleRes.data.data;
        const perms = Array.isArray(data.permissions)
          ? data.permissions
          : (data.permissions ? data.permissions.split(',').filter(Boolean) : []);
        form.setFieldsValue({
          display_name: data.display_name,
          description: data.description,
          status: Number(data.status),
          permissions: perms,
        });
      }
    }).catch(() => message.error('Failed to load role')).finally(() => setLoading(false));
  }, [roleId]);

  const onFinish = async (values) => {
    setSubmitting(true);
    try {
      const permissions = values.permissions || [];
      await role.update(roleId, { display_name: values.display_name, description: values.description, permissions, status: values.status ?? 1 });
      message.success('Role updated');
      router.push('/settings?tab=roles');
    } catch (error) {
      message.error('Failed to update role');
    } finally {
      setSubmitting(false);
    }
  };

  const groupNames = Object.keys(permissionGroups);
  const midpoint = Math.ceil(groupNames.length / 2);
  const leftGroups = groupNames.slice(0, midpoint);
  const rightGroups = groupNames.slice(midpoint);

  return (
    <MainLayout>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => router.push('/settings?tab=roles')}>Back</Button>
        <Card loading={loading}>
          <h2 style={{ marginBottom: 24 }}>Edit Role</h2>
          <Form form={form} layout="vertical" onFinish={onFinish}>
            <Row gutter={24}>
              <Col xs={24} md={16}>
                <Form.Item name="display_name" label={<span style={{ color: '#d4380d' }}>* Display Name</span>} rules={[{ required: true, message: 'Please input display name' }]}>
                  <Input placeholder="Please input display name" />
                </Form.Item>
              </Col>
              <Col xs={24} md={8}>
                <Form.Item name="status" label={<span style={{ color: '#d4380d' }}>* Status</span>}>
                  <Select options={[{ label: 'Active', value: 1 }, { label: 'Inactive', value: 0 }]} />
                </Form.Item>
              </Col>
            </Row>
            <Form.Item name="description" label={<span style={{ color: '#d4380d' }}>* Description</span>}>
              <Input.TextArea rows={3} placeholder="Please input description" />
            </Form.Item>
            <div style={{ marginBottom: 8, fontWeight: 600, color: '#d4380d' }}>* Permissions</div>
            <Form.Item name="permissions" valuePropName="value" trigger="onChange"
              getValueFromEvent={(val) => val}>
              <PermissionCheckboxes permissionGroups={permissionGroups} leftGroups={leftGroups} rightGroups={rightGroups} />
            </Form.Item>
            <Form.Item>
              <Space>
                <Button onClick={() => router.push('/settings?tab=roles')}>Cancel</Button>
                <Button type="primary" htmlType="submit" loading={submitting}>Save Changes</Button>
              </Space>
            </Form.Item>
          </Form>
        </Card>
      </Space>
    </MainLayout>
  );
}
