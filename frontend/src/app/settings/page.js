'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Card, Tabs, Table, Button, Form, Input, message, Row, Col, Select, Tag, Space, InputNumber, Switch } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import MainLayout from '../../components/Layout';
import { settings, user, amenity, role, emailTemplate } from '../../lib/api';
import { useCallback } from 'react';

export default function SettingsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get('tab');
  const [activeTab, setActiveTab] = useState(tabParam || 'personal');
  const [categories, setCategories] = useState([]);
  const [paymentMethods, setPaymentMethods] = useState([]);
  const [users, setUsers] = useState([]);
  const [amenities, setAmenities] = useState([]);
  const [roles, setRoles] = useState([]);
  const [emailTemplates, setEmailTemplates] = useState([]);
  const [loading, setLoading] = useState(true);

  // Sync tab from URL param
  useEffect(() => {
    if (tabParam && tabParam !== activeTab) {
      setActiveTab(tabParam);
    }
  }, [tabParam]);

  useEffect(() => {
    loadData();
  }, [activeTab]);

  const loadData = async () => {
    try {
      setLoading(true);
      if (activeTab === 'categories') {
        const response = await settings.getCategories();
        if (response.data.code === 200) setCategories(response.data.data || []);
      } else if (activeTab === 'payment') {
        const response = await settings.getPaymentMethods();
        if (response.data.code === 200) setPaymentMethods(response.data.data || []);
      } else if (activeTab === 'users') {
        const response = await user.listUsers({}, { page: 1, limit: 50 });
        if (response.data.code === 200) setUsers(response.data.data.content || []);
      } else if (activeTab === 'amenities') {
        const response = await amenity.list({}, { page: 1, limit: 50 });
        if (response.data.code === 200) setAmenities(response.data.data.content || []);
      } else if (activeTab === 'roles') {
        const response = await role.list({}, { page: 1, limit: 50 });
        if (response.data.code === 200) setRoles(response.data.data.content || []);
      } else if (activeTab === 'emailTemplates') {
        const response = await emailTemplate.list({}, { page: 1, limit: 50 });
        if (response.data.code === 200) setEmailTemplates(response.data.data.content || []);
      }
    } catch (error) {
      console.error('Failed to load settings:', error);
    } finally {
      setLoading(false);
    }
  };

  const categoryColumns = [
    { title: 'Name', dataIndex: 'name', key: 'name' },
    { title: 'Actions', key: 'actions', render: (_, r) => (
      <Button type="link" danger icon={<DeleteOutlined />} onClick={async () => {
        try { await settings.deleteCategory(r.id); message.success('Deleted'); loadData(); } 
        catch (error) { message.error('Failed to delete'); }
      }}>Delete</Button>
    )},
  ];

  const paymentColumns = [
    { title: 'Name', dataIndex: 'name', key: 'name' },
    { title: 'Actions', key: 'actions', render: (_, r) => (
      <Button type="link" danger icon={<DeleteOutlined />} onClick={async () => {
        try { await settings.deletePaymentMethod(r.id); message.success('Deleted'); loadData(); } 
        catch (error) { message.error('Failed to delete'); }
      }}>Delete</Button>
    )},
  ];

  const amenityColumns = [
    { title: 'Name', dataIndex: 'name', key: 'name' },
    { title: 'Type', dataIndex: 'type', key: 'type' },
    { title: 'Status', dataIndex: 'status', render: (s) => <Tag color={s === 1 ? 'green' : 'red'}>{s === 1 ? 'Active' : 'Inactive'}</Tag> },
    { title: 'Actions', key: 'actions', render: (_, r) => (
      <Space>
        <Button type="link" onClick={() => router.push(`/settings/amenity/${r.id}`)}>Edit</Button>
        <Button type="link" danger onClick={async () => {
          try { await amenity.delete(r.id); message.success('Deleted'); loadData(); } 
          catch (error) { message.error('Failed to delete'); }
        }}>Delete</Button>
      </Space>
    )},
  ];

  const roleColumns = [
    { title: 'Name', dataIndex: 'name', key: 'name' },
    { title: 'Description', dataIndex: 'description', key: 'description' },
    { title: 'Status', dataIndex: 'status', render: (s) => <Tag color={s === 1 ? 'green' : 'red'}>{s === 1 ? 'Active' : 'Inactive'}</Tag> },
    { title: 'Actions', key: 'actions', render: (_, r) => (
      <Space>
        <Button type="link" onClick={() => router.push(`/settings/role/${r.id}/edit`)}>Edit</Button>
        <Button type="link" danger onClick={async () => {
          try { await role.delete(r.id); message.success('Deleted'); loadData(); } 
          catch (error) { message.error('Failed to delete'); }
        }}>Delete</Button>
      </Space>
    )},
  ];

  const templateColumns = [
    { title: 'Name', dataIndex: 'name', key: 'name' },
    { title: 'Subject', dataIndex: 'subject', key: 'subject' },
    { title: 'Type', dataIndex: 'type', key: 'type' },
    { title: 'Actions', key: 'actions', render: (_, r) => (
      <Space>
        <Button type="link" onClick={() => router.push(`/settings/email-templates/${r.id}/edit`)}>Edit</Button>
        <Button type="link" danger onClick={async () => {
          try { await emailTemplate.delete(r.id); message.success('Deleted'); loadData(); } 
          catch (error) { message.error('Failed to delete'); }
        }}>Delete</Button>
      </Space>
    )},
  ];

  const userColumns = [
    { title: 'Username', dataIndex: 'username', key: 'username' },
    { title: 'Email', dataIndex: 'email', key: 'email' },
    { title: 'Role', dataIndex: 'role', key: 'role' },
    { title: 'Status', dataIndex: 'status', key: 'status', render: (s) => <Tag color={s === 1 ? 'green' : 'red'}>{s === 1 ? 'Active' : 'Inactive'}</Tag> },
    { title: 'Actions', key: 'actions', render: (_, r) => (
      <Space>
        <Button type="link" onClick={() => router.push(`/settings/users/${r.id}/edit`)}>Edit</Button>
      </Space>
    )},
  ];

  const tabItems = [
    { key: 'sequences', label: 'Sequences', children: <SequenceSettings /> },
    { key: 'personal', label: 'Personal Info', children: <PersonalSettings /> },
    { key: 'landlord', label: 'Landlord Info', children: <LandlordSettings /> },
    { key: 'users', label: 'User Management', children: (
      <Card>
        <div style={{ marginBottom: 16 }}><Button type="primary" icon={<PlusOutlined />} onClick={() => router.push('/settings/users/create')}>Add User</Button></div>
        <Table columns={userColumns} dataSource={users} rowKey="id" loading={loading} pagination={false} />
      </Card>
    )},
    { key: 'roles', label: 'Roles', children: (
      <Card>
        <div style={{ marginBottom: 16 }}><Button type="primary" icon={<PlusOutlined />} onClick={() => router.push('/settings/role/create')}>Add Role</Button></div>
        <Table columns={roleColumns} dataSource={roles} rowKey="id" loading={loading} pagination={false} />
      </Card>
    )},
    { key: 'amenities', label: 'Amenities', children: (
      <Card>
        <div style={{ marginBottom: 16 }}><Button type="primary" icon={<PlusOutlined />} onClick={() => router.push('/settings/amenity/create')}>Add Amenity</Button></div>
        <Table columns={amenityColumns} dataSource={amenities} rowKey="id" loading={loading} pagination={false} />
      </Card>
    )},
    { key: 'emailTemplates', label: 'Email Templates', children: (
      <Card>
        <div style={{ marginBottom: 16 }}><Button type="primary" icon={<PlusOutlined />} onClick={() => router.push('/settings/email-templates/create')}>Add Template</Button></div>
        <Table columns={templateColumns} dataSource={emailTemplates} rowKey="id" loading={loading} pagination={false} />
      </Card>
    )},
    { key: 'categories', label: 'Categories', children: (
      <Card>
        <div style={{ marginBottom: 16 }}>
          <Form layout="inline" onFinish={async (values) => {
            try { await settings.createCategory(values); message.success('Created'); loadData(); } 
            catch (error) { message.error('Failed'); }
          }}>
            <Form.Item name="name" rules={[{ required: true }]}><Input placeholder="Category name" /></Form.Item>
            <Form.Item><Button type="primary" htmlType="submit">Add</Button></Form.Item>
          </Form>
        </div>
        <Table columns={categoryColumns} dataSource={categories} rowKey="id" loading={loading} pagination={false} />
      </Card>
    )},
    { key: 'payment', label: 'Payment Methods', children: (
      <Card>
        <div style={{ marginBottom: 16 }}>
          <Form layout="inline" onFinish={async (values) => {
            try { await settings.createPaymentMethod(values); message.success('Created'); loadData(); } 
            catch (error) { message.error('Failed'); }
          }}>
            <Form.Item name="name" rules={[{ required: true }]}><Input placeholder="Payment method name" /></Form.Item>
            <Form.Item><Button type="primary" htmlType="submit">Add</Button></Form.Item>
          </Form>
        </div>
        <Table columns={paymentColumns} dataSource={paymentMethods} rowKey="id" loading={loading} pagination={false} />
      </Card>
    )},
  ];

  return (
    <MainLayout>
      <h1 style={{ marginBottom: 16 }}>Settings</h1>
      <Card><Tabs activeKey={activeTab} onChange={(key) => { setActiveTab(key); router.push(`/settings?tab=${key}`); }} items={tabItems} /></Card>
    </MainLayout>
  );
}

function PersonalSettings() {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);

  useEffect(() => {
    user.getProfile().then(r => { if (r.data.code === 200) form.setFieldsValue(r.data.data); }).finally(() => setInitialLoading(false));
  }, []);

  const onFinish = async (values) => {
    setLoading(true);
    try { await user.updatePersonal(values); message.success('Updated'); } 
    catch (error) { message.error('Failed'); }
    finally { setLoading(false); }
  };

  return (
    <Card loading={initialLoading}>
      <Form form={form} layout="vertical" onFinish={onFinish} style={{ maxWidth: 600 }}>
        <Form.Item name="username" label="Username"><Input disabled /></Form.Item>
        <Form.Item name="email" label="Email" rules={[{ type: 'email' }]}><Input /></Form.Item>
        <Form.Item name="first_name" label="First Name"><Input /></Form.Item>
        <Form.Item name="last_name" label="Last Name"><Input /></Form.Item>
        <Form.Item name="phone" label="Phone"><Input /></Form.Item>
        <Form.Item><Button type="primary" htmlType="submit" loading={loading}>Save</Button></Form.Item>
      </Form>
    </Card>
  );
}

function LandlordSettings() {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [currencies, setCurrencies] = useState([]);

  useEffect(() => {
    settings.getLandlord().then(r => { if (r.data.code === 200) form.setFieldsValue(r.data.data || {}); }).catch(() => {});
    settings.getCurrency().then(r => {
      if (r.data.code === 200) {
        const list = r.data.data || [];
        setCurrencies(Array.isArray(list) ? list.map(c => ({ label: `${c.code} - ${c.name}`, value: c.code })) : [
          { label: 'USD - US Dollar', value: 'USD' },
          { label: 'EUR - Euro', value: 'EUR' },
          { label: 'GBP - British Pound', value: 'GBP' },
        ]);
      }
    }).catch(() => setCurrencies([
      { label: 'USD - US Dollar', value: 'USD' },
      { label: 'EUR - Euro', value: 'EUR' },
      { label: 'GBP - British Pound', value: 'GBP' },
    ]));
  }, []);

  const onFinish = async (values) => {
    setLoading(true);
    try {
      await settings.updateLandlord(values);
      message.success('Landlord settings saved');
    } catch (error) {
      message.error('Failed to save settings');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <Form form={form} layout="vertical" onFinish={onFinish} style={{ maxWidth: 700 }}>
        <Row gutter={16}>
          <Col span={12}><Form.Item name="company_name" label="Company Name"><Input /></Form.Item></Col>
          <Col span={12}><Form.Item name="contact_person" label="Contact Person"><Input /></Form.Item></Col>
        </Row>
        <Form.Item name="address" label="Address"><Input.TextArea rows={2} /></Form.Item>
        <Row gutter={16}>
          <Col span={12}><Form.Item name="phone" label="Phone"><Input /></Form.Item></Col>
          <Col span={12}><Form.Item name="email" label="Email"><Input type="email" /></Form.Item></Col>
        </Row>
        <Row gutter={16}>
          <Col span={12}>
            <Form.Item name="invoice_prefix" label="Invoice Prefix">
              <Input placeholder="e.g. INV-" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="default_currency" label="Default Currency">
              <Select options={currencies.length ? currencies : [
                { label: 'USD', value: 'USD' }, { label: 'EUR', value: 'EUR' }, { label: 'GBP', value: 'GBP' }
              ]} showSearch />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item name="website" label="Website"><Input placeholder="https://..." /></Form.Item>
        <Form.Item name="tax_number" label="Tax / Registration Number"><Input /></Form.Item>
        <Form.Item><Button type="primary" htmlType="submit" loading={loading}>Save Landlord Settings</Button></Form.Item>
      </Form>
    </Card>
  );
}

function SequenceSettings() {
  const [sequences, setSequences] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState({});

  useEffect(() => {
    settings.getSequences()
      .then(r => { if (r.data.code === 200) setSequences(r.data.data || []); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const updateSeq = async (id, field, value) => {
    setSaving(s => ({ ...s, [id]: true }));
    try {
      const seq = sequences.find(s => s.id === id);
      await settings.updateSequence(id, { ...seq, [field]: value });
      setSequences(prev => prev.map(s => s.id === id ? { ...s, [field]: value } : s));
      message.success('Sequence updated');
    } catch (error) {
      message.error('Failed to update sequence');
    } finally {
      setSaving(s => ({ ...s, [id]: false }));
    }
  };

  const columns = [
    { title: 'Sequence Name', dataIndex: 'name', key: 'name' },
    { title: 'Prefix', dataIndex: 'prefix', key: 'prefix',
      render: (val, r) => (
        <Input defaultValue={val} style={{ width: 120 }}
          onBlur={(e) => { if (e.target.value !== val) updateSeq(r.id, 'prefix', e.target.value); }} />
      )
    },
    { title: 'Next Number', dataIndex: 'next_number', key: 'next_number',
      render: (val, r) => (
        <InputNumber defaultValue={val} min={1} style={{ width: 120 }}
          onBlur={(e) => { const v = parseInt(e.target.value); if (v && v !== val) updateSeq(r.id, 'next_number', v); }} />
      )
    },
    { title: 'Padding', dataIndex: 'padding', key: 'padding',
      render: (val, r) => (
        <InputNumber defaultValue={val} min={1} max={10} style={{ width: 80 }}
          onBlur={(e) => { const v = parseInt(e.target.value); if (v && v !== val) updateSeq(r.id, 'padding', v); }} />
      )
    },
    { title: 'Example', key: 'example',
      render: (_, r) => {
        const num = String(r.next_number || 1).padStart(r.padding || 4, '0');
        return <Tag>{r.prefix || ''}{num}</Tag>;
      }
    },
  ];

  return (
    <Card>
      <p style={{ marginBottom: 16, color: '#666' }}>
        Configure numbering sequences for invoices, leases, and other documents.
      </p>
      <Table columns={columns} dataSource={sequences} rowKey="id" loading={loading} pagination={false} />
    </Card>
  );
}
