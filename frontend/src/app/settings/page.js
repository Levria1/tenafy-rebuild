'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Card, Tabs, Table, Button, Form, Input, message, Row, Col, Select, Tag, Space, InputNumber, Switch, Popover, Badge, Pagination } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, FilterOutlined, SearchOutlined } from '@ant-design/icons';
import MainLayout, { useAuth } from '../../components/Layout';
import { settings, user, amenity, role, emailTemplate } from '../../lib/api';
import { useCallback } from 'react';

export default function SettingsPage() {
  const { hasPermission } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get('tab');
  const [activeTab, setActiveTab] = useState(tabParam || 'personal');
  const [categories, setCategories] = useState([]);
  const [paymentMethods, setPaymentMethods] = useState([]);
  const [users, setUsers] = useState([]);
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
    { title: 'Role', dataIndex: 'role_name', key: 'role_name' },
    { title: 'Status', dataIndex: 'status', key: 'status', render: (s) => <Tag color={s === 1 ? 'green' : 'red'}>{s === 1 ? 'Active' : 'Inactive'}</Tag> },
    { title: 'Actions', key: 'actions', render: (_, r) => (
      <Space>
        <Button type="link" onClick={() => router.push(`/settings/users/${r.id}/edit`)}>Edit</Button>
      </Space>
    )},
  ];

  const canSeeUsers = hasPermission ? hasPermission('LANDLORD/USER_LIST') : false;
  const canSeeRoles = hasPermission ? hasPermission('LANDLORD/ROLE_LIST') : false;

  // Group tabs by section — each sidebar link only shows its own tabs
  const accountTabs = [
    { key: 'personal', label: 'Personal Info', children: <PersonalSettings /> },
    { key: 'landlord', label: 'Landlord Info', children: <LandlordSettings /> },
  ];

  const accountingTabs = [
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
    { key: 'sequences', label: 'Sequences', children: <SequenceSettings /> },
  ];

  const amenityTabs = [
    { key: 'amenities', label: 'Amenities', children: <AmenitySettings /> },
  ];

  const emailTabs = [
    { key: 'emailTemplates', label: 'Email Templates', children: (
      <Card>
        <div style={{ marginBottom: 16 }}><Button type="primary" icon={<PlusOutlined />} onClick={() => router.push('/settings/email-templates/create')}>Add Template</Button></div>
        <Table columns={templateColumns} dataSource={emailTemplates} rowKey="id" loading={loading} pagination={false} />
      </Card>
    )},
  ];

  const userTabs = [
    ...(canSeeUsers ? [{ key: 'users', label: 'User Management', children: (
      <Card>
        <div style={{ marginBottom: 16 }}><Button type="primary" icon={<PlusOutlined />} onClick={() => router.push('/settings/users/create')}>Add User</Button></div>
        <Table columns={userColumns} dataSource={users} rowKey="id" loading={loading} pagination={false} />
      </Card>
    )}] : []),
    ...(canSeeRoles ? [{ key: 'roles', label: 'Roles', children: (
      <Card>
        <div style={{ marginBottom: 16 }}><Button type="primary" icon={<PlusOutlined />} onClick={() => router.push('/settings/role/create')}>Add Role</Button></div>
        <Table columns={roleColumns} dataSource={roles} rowKey="id" loading={loading} pagination={false} />
      </Card>
    )}] : []),
  ];

  // Determine which group the active tab belongs to
  const accountKeys = ['personal', 'landlord'];
  const accountingKeys = ['categories', 'payment', 'sequences'];
  const amenityKeys = ['amenities'];
  const emailKeys = ['emailTemplates'];
  const userKeys = ['users', 'roles'];

  let tabItems, pageTitle;
  if (accountingKeys.includes(activeTab)) {
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

  return (
    <Card>
      <p style={{ marginBottom: 16, color: '#666' }}>
        Configure numbering sequences for invoices, leases, transactions, and services.
        The pattern uses <code>{'{#,010}'}</code> for the sequence number and <code>{'{d,yyyyMMdd}'}</code> for the date.
      </p>
      <Table columns={columns} dataSource={sequences} rowKey="id" loading={loading} pagination={false} />
      <div style={{ marginTop: 16, textAlign: 'right' }}>
        <Button type="primary" onClick={handleSave} loading={saving} disabled={!hasChanges}>
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

function AmenitySettings() {
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

  return (
    <>
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
      <Table columns={columns} dataSource={data} rowKey="id" loading={loading}
        pagination={false} size="middle" />
      {total > limit && (
        <div style={{ marginTop: 16, textAlign: 'right' }}>
          <Pagination current={page} total={total} pageSize={limit}
            onChange={(p) => setPage(p)} showSizeChanger={false} />
        </div>
      )}
    </>
  );
}
