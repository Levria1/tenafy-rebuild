'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Card, Tabs, Table, Button, Form, Input, message, Row, Col, Select, Tag, Space, InputNumber, Switch, Popover, Badge, Pagination, Modal, Popconfirm } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, FilterOutlined, SearchOutlined, CopyOutlined, KeyOutlined } from '@ant-design/icons';
import MainLayout, { useAuth } from '../../components/Layout';
import { settings, user, amenity, role, emailTemplate, smtpAccount, bookingPlatform, salesAgent } from '../../lib/api';
import { useCallback } from 'react';
import useIsMobile from '../../hooks/useIsMobile';
import MobileCardList from '../../components/mobile/MobileCardList';

export default function SettingsPageWrapper() {
  return <Suspense fallback={<div />}><SettingsPage /></Suspense>;
}

function SettingsPage() {
  const { hasPermission } = useAuth();
  const { isMobile } = useIsMobile();
  const router = useRouter();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get('tab');
  const [activeTab, setActiveTab] = useState(tabParam || 'personal');
  const [categories, setCategories] = useState([]);
  const [paymentMethods, setPaymentMethods] = useState([]);
  const [users, setUsers] = useState([]);
  const [userStatusFilter, setUserStatusFilter] = useState('all'); // 'all' | 'active' | 'inactive'
  // amenities managed by AmenitySettings component
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
  }, [activeTab, userStatusFilter]);

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
        const body = {};
        if (userStatusFilter === 'active')   body.status = 1;
        if (userStatusFilter === 'inactive') body.status = 0;
        const response = await user.listUsers(body, { page: 1, limit: 500 });
        if (response.data.code === 200) setUsers(response.data.data.content || []);
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

  const roleColumns = [
    { title: 'Name', dataIndex: 'display_name', key: 'display_name' },
    { title: 'Description', dataIndex: 'description', key: 'description' },
    { title: 'Status', dataIndex: 'status', render: (s) => <Tag color={s === 1 ? 'green' : 'red'}>{s === 1 ? 'Active' : 'Inactive'}</Tag> },
    { title: 'Actions', key: 'actions', render: (_, r) => (
      <Space>
        {canEditRole && <Button type="link" onClick={() => router.push(`/settings/role/${r.id}/edit`)}>Edit</Button>}
        {canDeleteRole && <Button type="link" danger onClick={async () => {
          try { await role.delete(r.id); message.success('Deleted'); loadData(); }
          catch (error) { message.error('Failed to delete'); }
        }}>Delete</Button>}
      </Space>
    )},
  ];

  const templateColumns = [
    { title: 'Name', dataIndex: 'name', key: 'name' },
    { title: 'Subject', dataIndex: 'subject', key: 'subject' },
    { title: 'Type', dataIndex: 'type', key: 'type' },
    { title: 'Actions', key: 'actions', render: (_, r) => (
      <Space>
        {canEditTemplate && <Button type="link" onClick={() => router.push(`/settings/email-templates/${r.id}/edit`)}>Edit</Button>}
        {canDeleteTemplate && <Button type="link" danger onClick={async () => {
          try { await emailTemplate.delete(r.id); message.success('Deleted'); loadData(); }
          catch (error) { message.error('Failed to delete'); }
        }}>Delete</Button>}
      </Space>
    )},
  ];

  const userColumns = [
    { title: 'Name', key: 'name', render: (_, r) => [r.first_name, r.last_name].filter(Boolean).join(' ') || '—' },
    { title: 'Username', dataIndex: 'username', key: 'username' },
    { title: 'Email', dataIndex: 'email', key: 'email' },
    { title: 'Role', dataIndex: 'role_name', key: 'role_name' },
    { title: 'Status', dataIndex: 'status', key: 'status', render: (s) => <Tag color={s === 1 ? 'green' : 'red'}>{s === 1 ? 'Active' : 'Inactive'}</Tag> },
    { title: 'Actions', key: 'actions', render: (_, r) => (
      <Space>
        {canEditUser && <Button type="link" onClick={() => router.push(`/settings/users/${r.id}/edit`)}>Edit</Button>}
      </Space>
    )},
  ];

  // --- Mobile renderCard functions for inline tables ---
  const renderCategoryCard = (r) => (
    <Card size="small" style={{ borderRadius: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontWeight: 500 }}>{r.name}</span>
        <Button type="link" danger icon={<DeleteOutlined />} onClick={async () => {
          try { await settings.deleteCategory(r.id); message.success('Deleted'); loadData(); }
          catch (error) { message.error('Failed to delete'); }
        }}>Delete</Button>
      </div>
    </Card>
  );

  const renderPaymentCard = (r) => (
    <Card size="small" style={{ borderRadius: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontWeight: 500 }}>{r.name}</span>
        <Button type="link" danger icon={<DeleteOutlined />} onClick={async () => {
          try { await settings.deletePaymentMethod(r.id); message.success('Deleted'); loadData(); }
          catch (error) { message.error('Failed to delete'); }
        }}>Delete</Button>
      </div>
    </Card>
  );

  const renderTemplateCard = (r) => (
    <Card size="small" style={{ borderRadius: 8 }}>
      <div style={{ fontWeight: 500, marginBottom: 4 }}>{r.name}</div>
      <div style={{ color: '#666', fontSize: 13, marginBottom: 4 }}>{r.subject}</div>
      {r.type && <Tag>{r.type}</Tag>}
      <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
        {canEditTemplate && <Button type="link" style={{ padding: 0 }} onClick={() => router.push(`/settings/email-templates/${r.id}/edit`)}>Edit</Button>}
        {canDeleteTemplate && <Button type="link" danger style={{ padding: 0 }} onClick={async () => {
          try { await emailTemplate.delete(r.id); message.success('Deleted'); loadData(); }
          catch (error) { message.error('Failed to delete'); }
        }}>Delete</Button>}
      </div>
    </Card>
  );

  const renderUserCard = (r) => (
    <Card size="small" style={{ borderRadius: 8 }}>
      <div style={{ fontWeight: 500, marginBottom: 4 }}>{[r.first_name, r.last_name].filter(Boolean).join(' ') || '—'}</div>
      <div style={{ fontSize: 13, color: '#666', marginBottom: 2 }}>{r.username}</div>
      <div style={{ fontSize: 13, color: '#666', marginBottom: 4 }}>{r.email}</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {r.role_name && <Tag>{r.role_name}</Tag>}
        <Tag color={r.status === 1 ? 'green' : 'red'}>{r.status === 1 ? 'Active' : 'Inactive'}</Tag>
      </div>
      {canEditUser && (
        <div style={{ marginTop: 8 }}>
          <Button type="link" style={{ padding: 0 }} onClick={() => router.push(`/settings/users/${r.id}/edit`)}>Edit</Button>
        </div>
      )}
    </Card>
  );

  const renderRoleCard = (r) => (
    <Card size="small" style={{ borderRadius: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontWeight: 500, marginBottom: 4 }}>{r.display_name}</div>
          {r.description && <div style={{ fontSize: 13, color: '#666', marginBottom: 4 }}>{r.description}</div>}
          <Tag color={r.status === 1 ? 'green' : 'red'}>{r.status === 1 ? 'Active' : 'Inactive'}</Tag>
        </div>
      </div>
      <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
        {canEditRole && <Button type="link" style={{ padding: 0 }} onClick={() => router.push(`/settings/role/${r.id}/edit`)}>Edit</Button>}
        {canDeleteRole && <Button type="link" danger style={{ padding: 0 }} onClick={async () => {
          try { await role.delete(r.id); message.success('Deleted'); loadData(); }
          catch (error) { message.error('Failed to delete'); }
        }}>Delete</Button>}
      </div>
    </Card>
  );

  const canSeeUsers = hasPermission ? hasPermission('LANDLORD/USER_LIST') : false;
  const canSeeRoles = hasPermission ? hasPermission('LANDLORD/ROLE_LIST') : false;
  const canCreateTemplate = hasPermission ? hasPermission('LANDLORD/EMAIL_TEMPLATE_CREATE') : false;
  const canEditTemplate = hasPermission ? hasPermission('LANDLORD/EMAIL_TEMPLATE_EDIT') : false;
  const canDeleteTemplate = hasPermission ? hasPermission('LANDLORD/EMAIL_TEMPLATE_DELETE') : false;
  const canEditRole = hasPermission ? hasPermission('LANDLORD/ROLE_EDIT') : false;
  const canDeleteRole = hasPermission ? hasPermission('LANDLORD/ROLE_DELETE') : false;
  const canEditUser = hasPermission ? hasPermission('LANDLORD/USER_EDIT') : false;

  // Group tabs by section — each sidebar link only shows its own tabs
  const accountTabs = [
    { key: 'personal', label: 'Personal Info', children: <PersonalSettings isMobile={isMobile} /> },
    { key: 'landlord', label: 'Landlord Info', children: <LandlordSettings isMobile={isMobile} /> },
  ];

  const accountingTabs = [
    { key: 'categories', label: 'Categories', children: (
      <Card>
        <div style={{ marginBottom: 16 }}>
          <Form layout={isMobile ? 'vertical' : 'inline'} onFinish={async (values) => {
            try { await settings.createCategory(values); message.success('Created'); loadData(); }
            catch (error) { message.error('Failed'); }
          }}>
            <Form.Item name="name" rules={[{ required: true }]}><Input placeholder="Category name" /></Form.Item>
            <Form.Item><Button type="primary" htmlType="submit" block={isMobile}>Add</Button></Form.Item>
          </Form>
        </div>
        {isMobile ? (
          <MobileCardList dataSource={categories} renderCard={renderCategoryCard} loading={loading} rowKey="id" />
        ) : (
          <Table columns={categoryColumns} dataSource={categories} rowKey="id" loading={loading} pagination={false} />
        )}
      </Card>
    )},
    { key: 'payment', label: 'Payment Methods', children: (
      <Card>
        <div style={{ marginBottom: 16 }}>
          <Form layout={isMobile ? 'vertical' : 'inline'} onFinish={async (values) => {
            try { await settings.createPaymentMethod(values); message.success('Created'); loadData(); }
            catch (error) { message.error('Failed'); }
          }}>
            <Form.Item name="name" rules={[{ required: true }]}><Input placeholder="Payment method name" /></Form.Item>
            <Form.Item><Button type="primary" htmlType="submit" block={isMobile}>Add</Button></Form.Item>
          </Form>
        </div>
        {isMobile ? (
          <MobileCardList dataSource={paymentMethods} renderCard={renderPaymentCard} loading={loading} rowKey="id" />
        ) : (
          <Table columns={paymentColumns} dataSource={paymentMethods} rowKey="id" loading={loading} pagination={false} />
        )}
      </Card>
    )},
    { key: 'accounts', label: 'Accounts', children: <AccountSettings isMobile={isMobile} /> },
    { key: 'sequences', label: 'Sequences', children: <SequenceSettings isMobile={isMobile} /> },
  ];

  const amenityTabs = [
    { key: 'amenities', label: 'Amenities', children: <AmenitySettings isMobile={isMobile} /> },
  ];

  const emailTabs = [
    { key: 'emailTemplates', label: 'Email Templates', children: (
      <Card>
        {canCreateTemplate && <div style={{ marginBottom: 16 }}><Button type="primary" icon={<PlusOutlined />} onClick={() => router.push('/settings/email-templates/create')} block={isMobile}>Add Template</Button></div>}
        {isMobile ? (
          <MobileCardList dataSource={emailTemplates} renderCard={renderTemplateCard} loading={loading} rowKey="id" />
        ) : (
          <Table columns={templateColumns} dataSource={emailTemplates} rowKey="id" loading={loading} pagination={false} />
        )}
      </Card>
    )},
    { key: 'smtpAccounts', label: 'SMTP Accounts', children: <SmtpAccountSettings isMobile={isMobile} /> },
    { key: 'emailSettings', label: 'Settings', children: <EmailWhitelistSettings /> },
  ];

  const userTabs = [
    ...(canSeeUsers ? [{ key: 'users', label: 'User Management', children: (
      <Card>
        <div style={{ marginBottom: 16, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => router.push('/settings/users/create')} block={isMobile}>Add User</Button>
          <Select
            value={userStatusFilter}
            onChange={setUserStatusFilter}
            style={{ width: 180 }}
            options={[
              { value: 'all',      label: 'All users' },
              { value: 'active',   label: 'Active only' },
              { value: 'inactive', label: 'Deactivated only' },
            ]}
          />
        </div>
        {isMobile ? (
          <MobileCardList dataSource={users} renderCard={renderUserCard} loading={loading} rowKey="id" />
        ) : (
          <Table columns={userColumns} dataSource={users} rowKey="id" loading={loading} pagination={false} />
        )}
      </Card>
    )}] : []),
    ...(canSeeRoles ? [{ key: 'roles', label: 'Roles', children: (
      <Card>
        <div style={{ marginBottom: 16 }}><Button type="primary" icon={<PlusOutlined />} onClick={() => router.push('/settings/role/create')} block={isMobile}>Add Role</Button></div>
        {isMobile ? (
          <MobileCardList dataSource={roles} renderCard={renderRoleCard} loading={loading} rowKey="id" />
        ) : (
          <Table columns={roleColumns} dataSource={roles} rowKey="id" loading={loading} pagination={false} />
        )}
      </Card>
    )}] : []),
  ];

  const apiKeyTabs = [
    { key: 'apiKeys', label: 'API Keys', children: <ApiKeySettings isMobile={isMobile} /> },
  ];

  const bookingCommissionTabs = [
    { key: 'bookingPlatforms', label: 'Booking Platforms', children: <BookingPlatformSettings isMobile={isMobile} /> },
    { key: 'salesAgents', label: 'Sales Agents', children: <SalesAgentSettings isMobile={isMobile} /> },
    { key: 'leadSources', label: 'Lead Sources', children: <LeadSourceSettings isMobile={isMobile} /> },
  ];

  // Determine which group the active tab belongs to
  const accountKeys = ['personal', 'landlord'];
  const accountingKeys = ['categories', 'payment', 'accounts', 'sequences'];
  const amenityKeys = ['amenities'];
  const emailKeys = ['emailTemplates', 'smtpAccounts', 'emailSettings'];
  const userKeys = ['users', 'roles'];
  const apiKeyKeys = ['apiKeys'];
  const bookingKeys = ['bookingPlatforms', 'salesAgents', 'leadSources'];

  let tabItems, pageTitle;
  if (bookingKeys.includes(activeTab)) {
    tabItems = bookingCommissionTabs;
    pageTitle = 'Booking & Commission';
  } else if (apiKeyKeys.includes(activeTab)) {
    tabItems = apiKeyTabs;
    pageTitle = 'API Keys';
  } else if (accountingKeys.includes(activeTab)) {
    tabItems = accountingTabs;
    pageTitle = 'Accounting Settings';
  } else if (amenityKeys.includes(activeTab)) {
    tabItems = amenityTabs;
    pageTitle = 'Amenity Settings';
  } else if (emailKeys.includes(activeTab)) {
    tabItems = emailTabs;
    pageTitle = 'Email Settings';
  } else if (userKeys.includes(activeTab)) {
    tabItems = userTabs;
    pageTitle = 'User Management';
  } else {
    tabItems = accountTabs;
    pageTitle = 'Account Settings';
  }

  return (
    <MainLayout>
      <h1 style={{ marginBottom: 16 }}>{pageTitle}</h1>
      <Card><Tabs activeKey={activeTab} onChange={(key) => { setActiveTab(key); router.push(`/settings?tab=${key}`); }} items={tabItems} /></Card>
    </MainLayout>
  );
}

function PersonalSettings({ isMobile }) {
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
        <Form.Item><Button type="primary" htmlType="submit" loading={loading}>Save</Button></Form.Item>
      </Form>
    </Card>
  );
}

function LandlordSettings({ isMobile }) {
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
      <Form form={form} layout="vertical" onFinish={onFinish} style={{ maxWidth: isMobile ? '100%' : 700 }}>
        <Row gutter={16}>
          <Col xs={24} sm={12}><Form.Item name="company_name" label="Company Name"><Input /></Form.Item></Col>
          <Col xs={24} sm={12}><Form.Item name="contact_person" label="Contact Person"><Input /></Form.Item></Col>
        </Row>
        <Form.Item name="address" label="Address"><Input.TextArea rows={2} /></Form.Item>
        <Row gutter={16}>
          <Col xs={24} sm={12}><Form.Item name="phone" label="Phone"><Input /></Form.Item></Col>
          <Col xs={24} sm={12}><Form.Item name="email" label="Email"><Input type="email" /></Form.Item></Col>
        </Row>
        <Row gutter={16}>
          <Col xs={24} sm={12}>
            <Form.Item name="invoice_prefix" label="Invoice Prefix">
              <Input placeholder="e.g. INV-" />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12}>
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

// ---------------------------------------------------------------------------
// Account Settings (Bank / Payment Accounts)
// ---------------------------------------------------------------------------

function AccountSettings({ isMobile }) {
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState('');

  const loadAccounts = async () => {
    setLoading(true);
    try {
      const r = await settings.getAccountSettings();
      if (r.data.code === 200) setAccounts(r.data.data || []);
    } catch (err) {
      console.error('Load accounts error:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadAccounts(); }, []);

  const handleAdd = async (values) => {
    try {
      await settings.createAccountSetting(values);
      message.success('Account created');
      loadAccounts();
    } catch (err) {
      message.error('Failed to create account');
    }
  };

  const handleEdit = (record) => {
    setEditingId(record.id);
    setEditName(record.name);
  };

  const handleEditSave = async () => {
    if (!editName.trim()) { message.warning('Name cannot be empty'); return; }
    try {
      await settings.updateAccountSetting(editingId, { name: editName.trim() });
      message.success('Account updated');
      setEditingId(null);
      setEditName('');
      loadAccounts();
    } catch (err) {
      message.error('Failed to update account');
    }
  };

  const handleEditCancel = () => {
    setEditingId(null);
    setEditName('');
  };

  const handleDelete = async (id) => {
    try {
      await settings.deleteAccountSetting(id);
      message.success('Account deleted');
      loadAccounts();
    } catch (err) {
      message.error(err.response?.data?.message || 'Failed to delete account');
    }
  };

  const columns = [
    {
      title: 'Account Name', dataIndex: 'name', key: 'name',
      render: (val, r) => {
        if (String(r.id) === String(editingId)) {
          return (
            <Input
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onPressEnter={handleEditSave}
              style={{ width: 250 }}
              autoFocus
            />
          );
        }
        return val;
      },
    },
    {
      title: 'Actions', key: 'actions', width: 200,
      render: (_, r) => {
        if (String(r.id) === String(editingId)) {
          return (
            <Space>
              <Button type="link" style={{ padding: 0 }} onClick={handleEditSave}>Save</Button>
              <Button type="link" style={{ padding: 0 }} onClick={handleEditCancel}>Cancel</Button>
            </Space>
          );
        }
        return (
          <Space>
            <Button type="link" style={{ padding: 0 }} icon={<EditOutlined />} onClick={() => handleEdit(r)}>Edit</Button>
            <Popconfirm title="Delete this account?" onConfirm={() => handleDelete(r.id)} okText="Yes" cancelText="No">
              <Button type="link" danger style={{ padding: 0 }} icon={<DeleteOutlined />}>Delete</Button>
            </Popconfirm>
          </Space>
        );
      },
    },
  ];

  const renderAccountCard = (r) => (
    <Card size="small" style={{ borderRadius: 8 }}>
      {String(r.id) === String(editingId) ? (
        <div>
          <Input value={editName} onChange={(e) => setEditName(e.target.value)} onPressEnter={handleEditSave} autoFocus style={{ marginBottom: 8 }} />
          <Space>
            <Button type="link" style={{ padding: 0 }} onClick={handleEditSave}>Save</Button>
            <Button type="link" style={{ padding: 0 }} onClick={handleEditCancel}>Cancel</Button>
          </Space>
        </div>
      ) : (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontWeight: 500 }}>{r.name}</span>
          <Space>
            <Button type="link" style={{ padding: 0 }} icon={<EditOutlined />} onClick={() => handleEdit(r)}>Edit</Button>
            <Popconfirm title="Delete this account?" onConfirm={() => handleDelete(r.id)} okText="Yes" cancelText="No">
              <Button type="link" danger style={{ padding: 0 }} icon={<DeleteOutlined />}>Delete</Button>
            </Popconfirm>
          </Space>
        </div>
      )}
    </Card>
  );

  return (
    <Card>
      <h3 style={{ marginBottom: 4 }}>Accounts</h3>
      <p style={{ color: '#666', marginBottom: 16, fontSize: 13 }}>
        Manage bank and payment accounts used for accounting transactions.
      </p>
      <div style={{ marginBottom: 16 }}>
        <Form layout={isMobile ? 'vertical' : 'inline'} onFinish={handleAdd}>
          <Form.Item name="name" rules={[{ required: true, message: 'Enter account name' }]}>
            <Input placeholder="Account name" style={{ width: isMobile ? '100%' : 250 }} />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" icon={<PlusOutlined />} block={isMobile}>Add Account</Button>
          </Form.Item>
        </Form>
      </div>
      {isMobile ? (
        <MobileCardList dataSource={accounts} renderCard={renderAccountCard} loading={loading} rowKey="id" />
      ) : (
        <Table columns={columns} dataSource={accounts} rowKey="id" loading={loading} pagination={false} size="middle" />
      )}
    </Card>
  );
}

function SequenceSettings({ isMobile }) {
  const [sequences, setSequences] = useState([]);
  const [edited, setEdited] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    settings.getSequences()
      .then(r => { if (r.data.code === 200) setSequences(r.data.data || []); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleChange = (id, field, value) => {
    setEdited(prev => ({
      ...prev,
      [id]: { ...(prev[id] || {}), [field]: value },
    }));
  };

  const getVal = (r, field) => {
    if (edited[r.id] && edited[r.id][field] !== undefined) return edited[r.id][field];
    return r[field];
  };

  const hasChanges = Object.keys(edited).length > 0;

  const handleSave = async () => {
    setSaving(true);
    try {
      for (const id of Object.keys(edited)) {
        const seq = sequences.find(s => String(s.id) === String(id));
        if (!seq) continue;
        const updates = edited[id];
        await settings.updateSequence(id, {
          pattern: updates.pattern !== undefined ? updates.pattern : seq.pattern,
          seq_next: updates.seq_next !== undefined ? updates.seq_next : seq.seq_next,
        });
      }
      // Reload fresh data
      const r = await settings.getSequences();
      if (r.data.code === 200) setSequences(r.data.data || []);
      setEdited({});
      message.success('Sequences saved');
    } catch (error) {
      message.error('Failed to save sequences');
    } finally {
      setSaving(false);
    }
  };

  // Build example from pattern: "TRIV{#,010}" with seq_next=31400 → "TRIV31400"
  const buildExample = (r) => {
    const pattern = getVal(r, 'pattern') || '';
    const num = Number(getVal(r, 'seq_next')) || 1;
    return pattern
      .replace(/\{d,(\w+)\}/g, () => {
        const now = new Date();
        return now.getFullYear().toString() +
          String(now.getMonth() + 1).padStart(2, '0') +
          String(now.getDate()).padStart(2, '0');
      })
      .replace(/\{#,(\d+)\}/, () => String(num));
  };

  const columns = [
    { title: 'Sequence Name', dataIndex: 'name', key: 'name', width: 180 },
    { title: 'Pattern', dataIndex: 'pattern', key: 'pattern', width: 200,
      render: (val, r) => (
        <Input value={getVal(r, 'pattern')} style={{ width: 180 }}
          onChange={(e) => handleChange(r.id, 'pattern', e.target.value)} />
      )
    },
    { title: 'Next Number', dataIndex: 'seq_next', key: 'seq_next', width: 150,
      render: (val, r) => (
        <InputNumber value={Number(getVal(r, 'seq_next')) || 1} min={1} style={{ width: 130 }}
          onChange={(v) => handleChange(r.id, 'seq_next', v)} />
      )
    },
    { title: 'Preview', key: 'preview', width: 200,
      render: (_, r) => <Tag>{buildExample(r)}</Tag>
    },
  ];

  const renderSequenceCard = (r) => (
    <Card size="small" style={{ borderRadius: 8 }}>
      <div style={{ fontWeight: 500, marginBottom: 8 }}>{r.name}</div>
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>Pattern</div>
        <Input value={getVal(r, 'pattern')} onChange={(e) => handleChange(r.id, 'pattern', e.target.value)} />
      </div>
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>Next Number</div>
        <InputNumber value={Number(getVal(r, 'seq_next')) || 1} min={1} style={{ width: '100%' }} onChange={(v) => handleChange(r.id, 'seq_next', v)} />
      </div>
      <div>
        <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>Preview</div>
        <Tag>{buildExample(r)}</Tag>
      </div>
    </Card>
  );

  return (
    <Card>
      <p style={{ marginBottom: 16, color: '#666' }}>
        Configure numbering sequences for invoices, leases, transactions, and services.
        The pattern uses <code>{'{#,010}'}</code> for the sequence number and <code>{'{d,yyyyMMdd}'}</code> for the date.
      </p>
      {isMobile ? (
        <MobileCardList dataSource={sequences} renderCard={renderSequenceCard} loading={loading} rowKey="id" />
      ) : (
        <Table columns={columns} dataSource={sequences} rowKey="id" loading={loading} pagination={false} />
      )}
      <div style={{ marginTop: 16, textAlign: 'right' }}>
        <Button type="primary" onClick={handleSave} loading={saving} disabled={!hasChanges} block={isMobile}>
          Save Changes
        </Button>
      </div>
    </Card>
  );
}

const CATEGORY_OPTIONS = [
  { label: 'All', value: '' },
  { label: 'Property', value: 0 },
  { label: 'Unit', value: 1 },
];
const TYPE_OPTIONS = [
  { label: 'All', value: '' },
  { label: 'Residential', value: 1 },
  { label: 'Commercial', value: 2 },
];

function getCategoryLabel(val) {
  return Number(val) === 0 ? 'Property' : Number(val) === 1 ? 'Unit' : '-';
}
function getTypeLabel(cat, type) {
  const catLabel = getCategoryLabel(cat);
  const typeLabel = Number(type) === 1 ? 'Residential' : Number(type) === 2 ? 'Commercial' : '';
  return typeLabel ? `${typeLabel} ${catLabel}` : catLabel;
}

function AmenitySettings({ isMobile }) {
  const router = useRouter();
  const [data, setData] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [filterCategory, setFilterCategory] = useState('');
  const [filterType, setFilterType] = useState('');
  const [filterOpen, setFilterOpen] = useState(false);
  const limit = 10;

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const body = {};
      if (search) body.search = search;
      if (filterCategory !== '') body.category = filterCategory;
      if (filterType !== '') body.type = filterType;
      const r = await amenity.list(body, { page, limit });
      if (r.data.code === 200) {
        setData(r.data.data.content || []);
        setTotal(Number(r.data.data.totalElements) || 0);
      }
    } catch (err) {
      console.error('Load amenities error:', err);
    } finally {
      setLoading(false);
    }
  }, [page, search, filterCategory, filterType]);

  useEffect(() => { loadData(); }, [loadData]);

  const handleDelete = async (id) => {
    try {
      await amenity.delete(id);
      message.success('Amenity deleted');
      loadData();
    } catch (err) {
      message.error('Failed to delete');
    }
  };

  const activeFilters = (filterCategory !== '' ? 1 : 0) + (filterType !== '' ? 1 : 0);

  const filterContent = (
    <div style={{ width: 220 }}>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontWeight: 500, marginBottom: 4 }}>Category</div>
        <Select value={filterCategory} onChange={setFilterCategory} options={CATEGORY_OPTIONS} style={{ width: '100%' }} />
      </div>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontWeight: 500, marginBottom: 4 }}>Type</div>
        <Select value={filterType} onChange={setFilterType} options={TYPE_OPTIONS} style={{ width: '100%' }} />
      </div>
      <Button size="small" onClick={() => { setFilterCategory(''); setFilterType(''); }}>Clear Filters</Button>
    </div>
  );

  const columns = [
    { title: 'Display Name', dataIndex: 'display_name', key: 'display_name' },
    { title: 'Category', dataIndex: 'category', key: 'category', width: 120,
      render: (v) => getCategoryLabel(v)
    },
    { title: 'Type', key: 'type', width: 200,
      render: (_, r) => getTypeLabel(r.category, r.type)
    },
    { title: 'Operation', key: 'actions', width: 150,
      render: (_, r) => (
        <Space>
          <Button type="link" style={{ padding: 0 }} onClick={() => router.push(`/settings/amenity/${r.id}`)}>Edit</Button>
          <Button type="link" danger style={{ padding: 0 }} onClick={() => handleDelete(r.id)}>Delete</Button>
        </Space>
      )
    },
  ];

  const renderAmenityCard = (r) => (
    <Card size="small" style={{ borderRadius: 8 }}>
      <div style={{ fontWeight: 500, marginBottom: 4 }}>{r.display_name}</div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <Tag>{getCategoryLabel(r.category)}</Tag>
        <Tag>{getTypeLabel(r.category, r.type)}</Tag>
      </div>
      <Space>
        <Button type="link" style={{ padding: 0 }} onClick={() => router.push(`/settings/amenity/${r.id}`)}>Edit</Button>
        <Button type="link" danger style={{ padding: 0 }} onClick={() => handleDelete(r.id)}>Delete</Button>
      </Space>
    </Card>
  );

  return (
    <>
      {isMobile ? (
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <Tag style={{ fontSize: 14, padding: '4px 12px' }}>{total} Total</Tag>
            <Popover content={filterContent} trigger="click" open={filterOpen} onOpenChange={setFilterOpen} placement="bottomRight">
              <Badge count={activeFilters} size="small">
                <Button icon={<FilterOutlined />}>Filter</Button>
              </Badge>
            </Popover>
          </div>
          <Input
            placeholder="Type here to search"
            prefix={<SearchOutlined />}
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            style={{ width: '100%', marginBottom: 8 }}
            allowClear
          />
          <Button type="primary" icon={<PlusOutlined />} onClick={() => router.push('/settings/amenity/create')} block>
            CREATE AMENITY
          </Button>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <Tag style={{ fontSize: 14, padding: '4px 12px' }}>{total} Total</Tag>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Input
              placeholder="Type here to search"
              prefix={<SearchOutlined />}
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              style={{ width: 220 }}
              allowClear
            />
            <Popover content={filterContent} trigger="click" open={filterOpen} onOpenChange={setFilterOpen} placement="bottomRight">
              <Badge count={activeFilters} size="small">
                <Button icon={<FilterOutlined />}>Filter</Button>
              </Badge>
            </Popover>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => router.push('/settings/amenity/create')}>
              CREATE AMENITY
            </Button>
          </div>
        </div>
      )}
      {isMobile ? (
        <MobileCardList
          dataSource={data}
          renderCard={renderAmenityCard}
          loading={loading}
          rowKey="id"
          pagination={{ current: page, pageSize: limit, total, onChange: (p) => setPage(p) }}
        />
      ) : (
        <>
          <Table columns={columns} dataSource={data} rowKey="id" loading={loading}
            pagination={false} size="middle" />
          {total > limit && (
            <div style={{ marginTop: 16, textAlign: 'right' }}>
              <Pagination current={page} total={total} pageSize={limit}
                onChange={(p) => setPage(p)} showSizeChanger={false} />
            </div>
          )}
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// SMTP Account Settings
// ---------------------------------------------------------------------------

function SmtpAccountSettings({ isMobile }) {
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState(null);
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const loadAccounts = async () => {
    setLoading(true);
    try {
      const r = await smtpAccount.list();
      if (r.data.code === 200) setAccounts(r.data.data || []);
    } catch (err) {
      console.error('Load SMTP accounts error:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadAccounts(); }, []);

  const openCreate = () => {
    setEditingAccount(null);
    form.resetFields();
    form.setFieldsValue({ host: 'smtp.titan.email', port: 465, is_secure: true, is_default: false });
    setModalOpen(true);
  };

  const openEdit = (record) => {
    setEditingAccount(record);
    form.setFieldsValue({
      email: record.email,
      password: '', // don't pre-fill password
      display_name: record.display_name || '',
      host: record.host || 'smtp.titan.email',
      port: Number(record.port) || 465,
      is_secure: record.is_secure,
      is_default: record.is_default,
    });
    setModalOpen(true);
  };

  const handleTest = async () => {
    try {
      const values = form.getFieldsValue();
      if (!values.email || !values.password) {
        message.warning('Email and password are required to test');
        return;
      }
      setTesting(true);
      const r = await smtpAccount.test(values);
      if (r.data.code === 200) {
        message.success('Connection successful!');
      }
    } catch (err) {
      message.error(err.response?.data?.message || 'Connection failed');
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      setSaving(true);
      if (editingAccount) {
        // Don't send empty password on update
        if (!values.password) delete values.password;
        await smtpAccount.update(editingAccount.id, values);
        message.success('SMTP account updated');
      } else {
        await smtpAccount.create(values);
        message.success('SMTP account created');
      }
      setModalOpen(false);
      loadAccounts();
    } catch (err) {
      if (err.errorFields) return; // validation error
      message.error('Failed to save SMTP account');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id) => {
    try {
      await smtpAccount.delete(id);
      message.success('SMTP account deleted');
      loadAccounts();
    } catch (err) {
      message.error('Failed to delete');
    }
  };

  const columns = [
    { title: 'Email', dataIndex: 'email', key: 'email' },
    { title: 'Display Name', dataIndex: 'display_name', key: 'display_name', render: (v) => v || '-' },
    { title: 'Host', dataIndex: 'host', key: 'host', width: 160 },
    { title: 'Port', dataIndex: 'port', key: 'port', width: 70 },
    { title: 'Default', dataIndex: 'is_default', key: 'is_default', width: 80,
      render: (v) => v ? <Tag color="blue">Default</Tag> : null },
    { title: 'Actions', key: 'actions', width: 150, render: (_, r) => (
      <Space>
        <Button type="link" style={{ padding: 0 }} onClick={() => openEdit(r)}>Edit</Button>
        <Popconfirm title="Delete this SMTP account?" onConfirm={() => handleDelete(r.id)} okText="Yes" cancelText="No">
          <Button type="link" danger style={{ padding: 0 }}>Delete</Button>
        </Popconfirm>
      </Space>
    )},
  ];

  const renderSmtpCard = (r) => (
    <Card size="small" style={{ borderRadius: 8 }}>
      <div style={{ fontWeight: 500, marginBottom: 2 }}>{r.email}</div>
      {r.display_name && <div style={{ fontSize: 13, color: '#666', marginBottom: 2 }}>{r.display_name}</div>}
      <div style={{ fontSize: 13, color: '#666', marginBottom: 4 }}>{r.host}:{r.port}</div>
      <div style={{ marginBottom: 8 }}>
        {r.is_default ? <Tag color="blue">Default</Tag> : null}
      </div>
      <Space>
        <Button type="link" style={{ padding: 0 }} onClick={() => openEdit(r)}>Edit</Button>
        <Popconfirm title="Delete this SMTP account?" onConfirm={() => handleDelete(r.id)} okText="Yes" cancelText="No">
          <Button type="link" danger style={{ padding: 0 }}>Delete</Button>
        </Popconfirm>
      </Space>
    </Card>
  );

  return (
    <>
      <Card>
        <h3 style={{ marginBottom: 4 }}>SMTP Accounts</h3>
        <p style={{ color: '#666', marginBottom: 16, fontSize: 13 }}>
          Add SMTP accounts for each email address you send from. When a template uses a specific &quot;From&quot; address, the matching SMTP credentials will be used automatically.
        </p>
        <div style={{ marginBottom: 16 }}>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate} block={isMobile}>Add SMTP Account</Button>
        </div>
        {isMobile ? (
          <MobileCardList dataSource={accounts} renderCard={renderSmtpCard} loading={loading} rowKey="id" />
        ) : (
          <Table columns={columns} dataSource={accounts} rowKey="id" loading={loading} pagination={false} size="middle" />
        )}
      </Card>

      <Modal
        title={editingAccount ? 'Edit SMTP Account' : 'Add SMTP Account'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        footer={[
          <Button key="test" onClick={handleTest} loading={testing}>Test Connection</Button>,
          <Button key="cancel" onClick={() => setModalOpen(false)}>Cancel</Button>,
          <Button key="save" type="primary" onClick={handleSave} loading={saving}>Save</Button>,
        ]}
        width={520}
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item name="email" label="Email Address" rules={[{ required: true, type: 'email', message: 'Valid email required' }]}>
            <Input placeholder="payments@yourdomain.com" />
          </Form.Item>
          <Form.Item name="password" label="Password" rules={editingAccount ? [] : [{ required: true, message: 'Password required' }]}>
            <Input.Password placeholder={editingAccount ? 'Leave blank to keep current' : 'SMTP password'} />
          </Form.Item>
          <Form.Item name="display_name" label="Display Name">
            <Input placeholder="e.g. Tane Residence" />
          </Form.Item>
          <Row gutter={16}>
            <Col xs={24} sm={16}>
              <Form.Item name="host" label="SMTP Host">
                <Input placeholder="smtp.titan.email" />
              </Form.Item>
            </Col>
            <Col xs={24} sm={8}>
              <Form.Item name="port" label="Port">
                <InputNumber style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col xs={24} sm={12}>
              <Form.Item name="is_secure" label="SSL/TLS" valuePropName="checked">
                <Switch />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item name="is_default" label="Default Account" valuePropName="checked">
                <Switch />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------------------
// API Key Settings (Super Admin only)
// ---------------------------------------------------------------------------

function ApiKeySettings({ isMobile }) {
  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [apiEnabled, setApiEnabled] = useState(false);
  const [checkingEnabled, setCheckingEnabled] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [newKey, setNewKey] = useState(null);

  useEffect(() => {
    checkEnabled();
  }, []);

  const checkEnabled = async () => {
    setCheckingEnabled(true);
    try {
      const r = await settings.checkApiEnabled();
      if (r.data.code === 200) {
        setApiEnabled(r.data.data.enabled);
        if (r.data.data.enabled) loadKeys();
        else setLoading(false);
      }
    } catch (err) {
      console.error('Check API enabled error:', err);
      setLoading(false);
    } finally {
      setCheckingEnabled(false);
    }
  };

  const loadKeys = async () => {
    setLoading(true);
    try {
      const r = await settings.getApiKeys();
      if (r.data.code === 200) setKeys(r.data.data || []);
    } catch (err) {
      console.error('Load API keys error:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async () => {
    try {
      const values = await form.validateFields();
      setSaving(true);
      const r = await settings.createApiKey(values);
      if (r.data.code === 200) {
        setNewKey(r.data.data.api_key);
        message.success('API key created');
        setModalOpen(false);
        form.resetFields();
        loadKeys();
      }
    } catch (err) {
      if (err.errorFields) return;
      message.error(err.response?.data?.message || 'Failed to create API key');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleStatus = async (record) => {
    const newStatus = Number(record.status) === 1 ? 0 : 1;
    try {
      await settings.updateApiKey(record.id, { status: newStatus });
      message.success(`API key ${newStatus === 1 ? 'enabled' : 'disabled'}`);
      loadKeys();
    } catch (err) {
      message.error('Failed to update');
    }
  };

  const handleDelete = async (id) => {
    try {
      await settings.deleteApiKey(id);
      message.success('API key deleted');
      loadKeys();
    } catch (err) {
      message.error('Failed to delete');
    }
  };

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text).then(() => message.success('Copied to clipboard'));
  };

  if (checkingEnabled) return <Card loading />;

  if (!apiEnabled) {
    return (
      <Card>
        <div style={{ textAlign: 'center', padding: '40px 0' }}>
          <KeyOutlined style={{ fontSize: 48, color: '#d9d9d9', marginBottom: 16 }} />
          <h3 style={{ color: '#999' }}>Public API Not Enabled</h3>
          <p style={{ color: '#999' }}>
            The Public API has not been enabled for your organization. Please contact the master administrator to enable it.
          </p>
        </div>
      </Card>
    );
  }

  const columns = [
    { title: 'Name', dataIndex: 'name', key: 'name' },
    {
      title: 'API Key', dataIndex: 'api_key', key: 'api_key',
      render: (v) => (
        <Space>
          <code style={{ fontSize: 12 }}>{v.substring(0, 12)}...{v.substring(v.length - 6)}</code>
          <Button type="text" size="small" icon={<CopyOutlined />} onClick={() => copyToClipboard(v)} />
        </Space>
      ),
    },
    {
      title: 'Status', dataIndex: 'status', key: 'status',
      render: (status, record) => (
        <Switch
          checked={Number(status) === 1}
          checkedChildren="Active"
          unCheckedChildren="Disabled"
          onChange={() => handleToggleStatus(record)}
          size="small"
        />
      ),
    },
    {
      title: 'Last Used', dataIndex: 'last_used_at', key: 'last_used_at',
      render: (v) => v ? new Date(v).toLocaleDateString() : 'Never',
    },
    {
      title: 'Created', dataIndex: 'created_at', key: 'created_at',
      render: (v) => v ? new Date(v).toLocaleDateString() : '-',
    },
    {
      title: 'Actions', key: 'actions', width: 80,
      render: (_, r) => (
        <Popconfirm title="Delete this API key?" onConfirm={() => handleDelete(r.id)} okText="Yes" cancelText="No">
          <Button type="link" danger style={{ padding: 0 }}>Delete</Button>
        </Popconfirm>
      ),
    },
  ];

  const renderApiKeyCard = (r) => (
    <Card size="small" style={{ borderRadius: 8 }}>
      <div style={{ fontWeight: 500, marginBottom: 4 }}>{r.name}</div>
      <div style={{ marginBottom: 4 }}>
        <Space>
          <code style={{ fontSize: 12 }}>{r.api_key.substring(0, 12)}...{r.api_key.substring(r.api_key.length - 6)}</code>
          <Button type="text" size="small" icon={<CopyOutlined />} onClick={() => copyToClipboard(r.api_key)} />
        </Space>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
        <Switch
          checked={Number(r.status) === 1}
          checkedChildren="Active"
          unCheckedChildren="Disabled"
          onChange={() => handleToggleStatus(r)}
          size="small"
        />
      </div>
      <div style={{ fontSize: 12, color: '#999', marginBottom: 4 }}>
        Last used: {r.last_used_at ? new Date(r.last_used_at).toLocaleDateString() : 'Never'}
        {' | '}
        Created: {r.created_at ? new Date(r.created_at).toLocaleDateString() : '-'}
      </div>
      <Popconfirm title="Delete this API key?" onConfirm={() => handleDelete(r.id)} okText="Yes" cancelText="No">
        <Button type="link" danger style={{ padding: 0 }}>Delete</Button>
      </Popconfirm>
    </Card>
  );

  return (
    <>
      <Card>
        <h3 style={{ marginBottom: 4 }}>API Keys</h3>
        <p style={{ color: '#666', marginBottom: 16, fontSize: 13 }}>
          Manage API keys for external integrations. Use these keys to access your organization&apos;s public data via the API.
        </p>
        <div style={{ marginBottom: 16 }}>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => { form.resetFields(); setModalOpen(true); }} block={isMobile}>
            Create API Key
          </Button>
        </div>
        {isMobile ? (
          <MobileCardList dataSource={keys} renderCard={renderApiKeyCard} loading={loading} rowKey="id" />
        ) : (
          <Table columns={columns} dataSource={keys} rowKey="id" loading={loading} pagination={false} size="middle" />
        )}
      </Card>

      {/* New key reveal */}
      <Modal
        title="API Key Created"
        open={!!newKey}
        onCancel={() => setNewKey(null)}
        footer={[
          <Button key="copy" type="primary" icon={<CopyOutlined />} onClick={() => { copyToClipboard(newKey); setNewKey(null); }}>
            Copy & Close
          </Button>,
        ]}
      >
        <p style={{ marginBottom: 8 }}>Your new API key has been created. <strong>Copy it now</strong> &mdash; you won&apos;t be able to see the full key again.</p>
        <Input.TextArea
          value={newKey}
          readOnly
          rows={2}
          style={{ fontFamily: 'monospace', fontSize: 13 }}
        />
      </Modal>

      {/* Create modal */}
      <Modal
        title="Create API Key"
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        footer={[
          <Button key="cancel" onClick={() => setModalOpen(false)}>Cancel</Button>,
          <Button key="create" type="primary" onClick={handleCreate} loading={saving}>Create</Button>,
        ]}
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item name="name" label="Key Name" rules={[{ required: true, message: 'Please enter a name for this key' }]}>
            <Input placeholder="e.g. Vacancy Scraper, Partner Integration" />
          </Form.Item>
        </Form>
      </Modal>

      <Card style={{ marginTop: 16 }}>
        <h4 style={{ marginBottom: 8 }}>API Usage</h4>
        <p style={{ color: '#666', fontSize: 13, marginBottom: 12 }}>
          Use the <code>X-API-Key</code> header with your key to access the public endpoints:
        </p>
        <pre style={{ background: '#f5f5f5', padding: 16, borderRadius: 6, fontSize: 12, overflow: 'auto' }}>
{`# Get available units (defaults to today)
GET /api/public/units/available
X-API-Key: pk_your_key_here

# Get available units on a specific date
GET /api/public/units/available?date=2026-04-01

# Filter by property
GET /api/public/units/available?propertyId=123&date=2026-04-01

# Get properties with vacancy counts
GET /api/public/properties`}
        </pre>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Email Whitelist Settings
// ---------------------------------------------------------------------------

function EmailWhitelistSettings() {
  const [enabled, setEnabled] = useState(false);
  const [emails, setEmails] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    settings.getEmailSettings().then(r => {
      if (r.data.code === 200) {
        setEnabled(r.data.data.email_whitelist_enabled);
        setEmails(r.data.data.email_whitelist || '');
      }
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await settings.updateEmailSettings({
        email_whitelist_enabled: enabled,
        email_whitelist: emails,
      });
      message.success('Email settings saved');
    } catch (err) {
      message.error('Failed to save email settings');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Card loading />;

  return (
    <Card>
      <h3 style={{ marginBottom: 4 }}>Email Whitelist</h3>
      <p style={{ color: '#666', marginBottom: 20, fontSize: 13 }}>
        When enabled, emails will only be sent to addresses listed below. All other recipients will be silently skipped. Use this to safely test email sending before going live.
      </p>

      <div style={{ marginBottom: 20 }}>
        <Space>
          <Switch checked={enabled} onChange={setEnabled} />
          <span style={{ fontWeight: 500 }}>
            {enabled ? 'Whitelist ON — only whitelisted emails will receive messages' : 'Whitelist OFF — all emails will be sent normally'}
          </span>
        </Space>
      </div>

      {enabled && (
        <div style={{ marginBottom: 20 }}>
          <label style={{ display: 'block', marginBottom: 6, fontWeight: 500 }}>Whitelisted Email Addresses</label>
          <Input.TextArea
            rows={6}
            value={emails}
            onChange={e => setEmails(e.target.value)}
            placeholder={"Enter email addresses, one per line:\nyou@example.com\ntest@example.com"}
            style={{ fontFamily: 'monospace', fontSize: 13 }}
          />
          <div style={{ marginTop: 4, color: '#999', fontSize: 12 }}>
            One email per line. Only these addresses will receive emails while the whitelist is active.
          </div>
        </div>
      )}

      <Button type="primary" onClick={handleSave} loading={saving}>
        Save
      </Button>
    </Card>
  );
}

function BookingPlatformSettings({ isMobile }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const r = await bookingPlatform.list();
      if (r.data.code === 200) setItems(r.data.data || []);
    } catch (err) { console.error('Load platforms error:', err); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const handleAdd = async (values) => {
    try { await bookingPlatform.create(values); message.success('Platform created'); load(); }
    catch (err) { message.error('Failed to create platform'); }
  };

  const handleEdit = (record) => { setEditingId(record.id); setEditName(record.name); };

  const handleEditSave = async () => {
    if (!editName.trim()) { message.warning('Name cannot be empty'); return; }
    try {
      await bookingPlatform.update(editingId, { name: editName.trim() });
      message.success('Platform updated');
      setEditingId(null); setEditName('');
      load();
    } catch (err) { message.error('Failed to update platform'); }
  };

  const handleEditCancel = () => { setEditingId(null); setEditName(''); };

  const handleDelete = async (id) => {
    try { await bookingPlatform.delete(id); message.success('Platform deleted'); load(); }
    catch (err) { message.error(err.response?.data?.message || 'Failed to delete platform'); }
  };

  const columns = [
    {
      title: 'Platform Name', dataIndex: 'name', key: 'name',
      render: (val, r) => {
        if (String(r.id) === String(editingId)) {
          return <Input value={editName} onChange={(e) => setEditName(e.target.value)} onPressEnter={handleEditSave} style={{ width: 250 }} autoFocus />;
        }
        return val;
      },
    },
    {
      title: 'Actions', key: 'actions', width: 200,
      render: (_, r) => {
        if (String(r.id) === String(editingId)) {
          return (
            <Space>
              <Button type="link" style={{ padding: 0 }} onClick={handleEditSave}>Save</Button>
              <Button type="link" style={{ padding: 0 }} onClick={handleEditCancel}>Cancel</Button>
            </Space>
          );
        }
        return (
          <Space>
            <Button type="link" style={{ padding: 0 }} icon={<EditOutlined />} onClick={() => handleEdit(r)}>Edit</Button>
            <Popconfirm title="Delete this platform?" onConfirm={() => handleDelete(r.id)} okText="Yes" cancelText="No">
              <Button type="link" danger style={{ padding: 0 }} icon={<DeleteOutlined />}>Delete</Button>
            </Popconfirm>
          </Space>
        );
      },
    },
  ];

  const renderPlatformCard = (r) => (
    <Card size="small" style={{ borderRadius: 8 }}>
      {String(r.id) === String(editingId) ? (
        <div>
          <Input value={editName} onChange={(e) => setEditName(e.target.value)} onPressEnter={handleEditSave} autoFocus style={{ marginBottom: 8 }} />
          <Space>
            <Button type="link" style={{ padding: 0 }} onClick={handleEditSave}>Save</Button>
            <Button type="link" style={{ padding: 0 }} onClick={handleEditCancel}>Cancel</Button>
          </Space>
        </div>
      ) : (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontWeight: 500 }}>{r.name}</span>
          <Space>
            <Button type="link" style={{ padding: 0 }} icon={<EditOutlined />} onClick={() => handleEdit(r)}>Edit</Button>
            <Popconfirm title="Delete this platform?" onConfirm={() => handleDelete(r.id)} okText="Yes" cancelText="No">
              <Button type="link" danger style={{ padding: 0 }} icon={<DeleteOutlined />}>Delete</Button>
            </Popconfirm>
          </Space>
        </div>
      )}
    </Card>
  );

  return (
    <Card>
      <h3 style={{ marginBottom: 4 }}>Booking Platforms</h3>
      <p style={{ color: '#666', marginBottom: 16, fontSize: 13 }}>
        Manage booking platforms (e.g. Airbnb, Booking.com, Direct) to track where tenants come from.
      </p>
      <div style={{ marginBottom: 16 }}>
        <Form layout={isMobile ? 'vertical' : 'inline'} onFinish={handleAdd}>
          <Form.Item name="name" rules={[{ required: true, message: 'Enter platform name' }]}>
            <Input placeholder="Platform name" style={{ width: isMobile ? '100%' : 250 }} />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" icon={<PlusOutlined />} block={isMobile}>Add Platform</Button>
          </Form.Item>
        </Form>
      </div>
      {isMobile ? (
        <MobileCardList dataSource={items} renderCard={renderPlatformCard} loading={loading} rowKey="id" />
      ) : (
        <Table columns={columns} dataSource={items} rowKey="id" loading={loading} pagination={false} size="middle" />
      )}
    </Card>
  );
}

function SalesAgentSettings({ isMobile }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const r = await salesAgent.list();
      if (r.data.code === 200) setItems(r.data.data || []);
    } catch (err) { console.error('Load agents error:', err); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const handleAdd = async (values) => {
    try { await salesAgent.create(values); message.success('Agent created'); load(); }
    catch (err) { message.error('Failed to create agent'); }
  };

  const handleEdit = (record) => { setEditingId(record.id); setEditName(record.name); };

  const handleEditSave = async () => {
    if (!editName.trim()) { message.warning('Name cannot be empty'); return; }
    try {
      await salesAgent.update(editingId, { name: editName.trim() });
      message.success('Agent updated');
      setEditingId(null); setEditName('');
      load();
    } catch (err) { message.error('Failed to update agent'); }
  };

  const handleEditCancel = () => { setEditingId(null); setEditName(''); };

  const handleDelete = async (id) => {
    try { await salesAgent.delete(id); message.success('Agent deleted'); load(); }
    catch (err) { message.error(err.response?.data?.message || 'Failed to delete agent'); }
  };

  const columns = [
    {
      title: 'Agent Name', dataIndex: 'name', key: 'name',
      render: (val, r) => {
        if (String(r.id) === String(editingId)) {
          return <Input value={editName} onChange={(e) => setEditName(e.target.value)} onPressEnter={handleEditSave} style={{ width: 250 }} autoFocus />;
        }
        return val;
      },
    },
    {
      title: 'Actions', key: 'actions', width: 200,
      render: (_, r) => {
        if (String(r.id) === String(editingId)) {
          return (
            <Space>
              <Button type="link" style={{ padding: 0 }} onClick={handleEditSave}>Save</Button>
              <Button type="link" style={{ padding: 0 }} onClick={handleEditCancel}>Cancel</Button>
            </Space>
          );
        }
        return (
          <Space>
            <Button type="link" style={{ padding: 0 }} icon={<EditOutlined />} onClick={() => handleEdit(r)}>Edit</Button>
            <Popconfirm title="Delete this agent?" onConfirm={() => handleDelete(r.id)} okText="Yes" cancelText="No">
              <Button type="link" danger style={{ padding: 0 }} icon={<DeleteOutlined />}>Delete</Button>
            </Popconfirm>
          </Space>
        );
      },
    },
  ];

  const renderAgentCard = (r) => (
    <Card size="small" style={{ borderRadius: 8 }}>
      {String(r.id) === String(editingId) ? (
        <div>
          <Input value={editName} onChange={(e) => setEditName(e.target.value)} onPressEnter={handleEditSave} autoFocus style={{ marginBottom: 8 }} />
          <Space>
            <Button type="link" style={{ padding: 0 }} onClick={handleEditSave}>Save</Button>
            <Button type="link" style={{ padding: 0 }} onClick={handleEditCancel}>Cancel</Button>
          </Space>
        </div>
      ) : (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontWeight: 500 }}>{r.name}</span>
          <Space>
            <Button type="link" style={{ padding: 0 }} icon={<EditOutlined />} onClick={() => handleEdit(r)}>Edit</Button>
            <Popconfirm title="Delete this agent?" onConfirm={() => handleDelete(r.id)} okText="Yes" cancelText="No">
              <Button type="link" danger style={{ padding: 0 }} icon={<DeleteOutlined />}>Delete</Button>
            </Popconfirm>
          </Space>
        </div>
      )}
    </Card>
  );

  return (
    <Card>
      <h3 style={{ marginBottom: 4 }}>Sales Agents</h3>
      <p style={{ color: '#666', marginBottom: 16, fontSize: 13 }}>
        Manage sales agents for commission tracking. Agents assigned to leases will be tagged on all generated invoices.
      </p>
      <div style={{ marginBottom: 16 }}>
        <Form layout={isMobile ? 'vertical' : 'inline'} onFinish={handleAdd}>
          <Form.Item name="name" rules={[{ required: true, message: 'Enter agent name' }]}>
            <Input placeholder="Agent name" style={{ width: isMobile ? '100%' : 250 }} />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" icon={<PlusOutlined />} block={isMobile}>Add Agent</Button>
          </Form.Item>
        </Form>
      </div>
      {isMobile ? (
        <MobileCardList dataSource={items} renderCard={renderAgentCard} loading={loading} rowKey="id" />
      ) : (
        <Table columns={columns} dataSource={items} rowKey="id" loading={loading} pagination={false} size="middle" />
      )}
    </Card>
  );
}

function LeadSourceSettings({ isMobile }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const r = await settings.getLeadSources();
      if (r.data.code === 200) setItems(r.data.data || []);
    } catch (err) { console.error('Load lead sources error:', err); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const handleAdd = async (values) => {
    try { await settings.createLeadSource(values); message.success('Lead source created'); load(); }
    catch (err) { message.error('Failed to create lead source'); }
  };

  const handleEdit = (record) => { setEditingId(record.id); setEditName(record.name); };

  const handleEditSave = async () => {
    if (!editName.trim()) { message.warning('Name cannot be empty'); return; }
    try {
      await settings.updateLeadSource(editingId, { name: editName.trim() });
      message.success('Lead source updated');
      setEditingId(null); setEditName('');
      load();
    } catch (err) { message.error('Failed to update lead source'); }
  };

  const handleEditCancel = () => { setEditingId(null); setEditName(''); };

  const handleDelete = async (id) => {
    try { await settings.deleteLeadSource(id); message.success('Lead source deleted'); load(); }
    catch (err) { message.error(err.response?.data?.message || 'Failed to delete lead source'); }
  };

  const columns = [
    {
      title: 'Lead Source Name', dataIndex: 'name', key: 'name',
      render: (val, r) => {
        if (String(r.id) === String(editingId)) {
          return <Input value={editName} onChange={(e) => setEditName(e.target.value)} onPressEnter={handleEditSave} style={{ width: 250 }} autoFocus />;
        }
        return val;
      },
    },
    {
      title: 'Actions', key: 'actions', width: 200,
      render: (_, r) => {
        if (String(r.id) === String(editingId)) {
          return (
            <Space>
              <Button type="link" style={{ padding: 0 }} onClick={handleEditSave}>Save</Button>
              <Button type="link" style={{ padding: 0 }} onClick={handleEditCancel}>Cancel</Button>
            </Space>
          );
        }
        return (
          <Space>
            <Button type="link" style={{ padding: 0 }} icon={<EditOutlined />} onClick={() => handleEdit(r)}>Edit</Button>
            <Popconfirm title="Delete this lead source?" onConfirm={() => handleDelete(r.id)} okText="Yes" cancelText="No">
              <Button type="link" danger style={{ padding: 0 }} icon={<DeleteOutlined />}>Delete</Button>
            </Popconfirm>
          </Space>
        );
      },
    },
  ];

  const renderLeadSourceCard = (r) => (
    <Card size="small" style={{ borderRadius: 8 }}>
      {String(r.id) === String(editingId) ? (
        <div>
          <Input value={editName} onChange={(e) => setEditName(e.target.value)} onPressEnter={handleEditSave} autoFocus style={{ marginBottom: 8 }} />
          <Space>
            <Button type="link" style={{ padding: 0 }} onClick={handleEditSave}>Save</Button>
            <Button type="link" style={{ padding: 0 }} onClick={handleEditCancel}>Cancel</Button>
          </Space>
        </div>
      ) : (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontWeight: 500 }}>{r.name}</span>
          <Space>
            <Button type="link" style={{ padding: 0 }} icon={<EditOutlined />} onClick={() => handleEdit(r)}>Edit</Button>
            <Popconfirm title="Delete this lead source?" onConfirm={() => handleDelete(r.id)} okText="Yes" cancelText="No">
              <Button type="link" danger style={{ padding: 0 }} icon={<DeleteOutlined />}>Delete</Button>
            </Popconfirm>
          </Space>
        </div>
      )}
    </Card>
  );

  return (
    <Card>
      <h3 style={{ marginBottom: 4 }}>Lead Sources</h3>
      <p style={{ color: '#666', marginBottom: 16, fontSize: 13 }}>
        Manage lead sources to track how contacts found you (e.g. Walk-in, Referral, Facebook, Google).
      </p>
      <div style={{ marginBottom: 16 }}>
        <Form layout={isMobile ? 'vertical' : 'inline'} onFinish={handleAdd}>
          <Form.Item name="name" rules={[{ required: true, message: 'Enter lead source name' }]}>
            <Input placeholder="Lead source name" style={{ width: isMobile ? '100%' : 250 }} />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" icon={<PlusOutlined />} block={isMobile}>Add Lead Source</Button>
          </Form.Item>
        </Form>
      </div>
      {isMobile ? (
        <MobileCardList dataSource={items} renderCard={renderLeadSourceCard} loading={loading} rowKey="id" />
      ) : (
        <Table columns={columns} dataSource={items} rowKey="id" loading={loading} pagination={false} size="middle" />
      )}
    </Card>
  );
}
