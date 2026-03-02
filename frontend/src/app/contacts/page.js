'use client';

import { useEffect, useState } from 'react';
import { Table, Button, Space, Tag, Card, Input, Tabs } from 'antd';
import { PlusOutlined, EditOutlined, EyeOutlined } from '@ant-design/icons';
import { useRouter } from 'next/navigation';
import MainLayout from '../../components/Layout';
import { tenant, contact } from '../../lib/api';

export default function ContactsPage() {
  const [activeTab, setActiveTab] = useState('tenants');
  const [tenants, setTenants] = useState([]);
  const [propertyOwners, setPropertyOwners] = useState([]);
  const [serviceVendors, setServiceVendors] = useState([]);
  const [payees, setPayees] = useState([]);
  const [emailGroups, setEmailGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    loadData();
  }, [activeTab]);

  const loadData = async () => {
    try {
      setLoading(true);
      if (activeTab === 'tenants') {
        const response = await tenant.getAll();
        if (response.data.code === 200) {
          setTenants(response.data.data || []);
        }
      } else if (activeTab === 'owners') {
        const response = await contact.getAllPropertyOwners();
        if (response.data.code === 200) {
          setPropertyOwners(response.data.data || []);
        }
      } else if (activeTab === 'vendors') {
        const response = await contact.listServiceVendors({});
        if (response.data.code === 200) {
          setServiceVendors(response.data.data.content || []);
        }
      } else if (activeTab === 'payees') {
        const response = await contact.listPayees({});
        if (response.data.code === 200) {
          setPayees(response.data.data.content || []);
        }
      } else if (activeTab === 'groups') {
        const response = await contact.listEmailGroups({});
        if (response.data.code === 200) {
          setEmailGroups(response.data.data.content || []);
        }
      }
    } catch (error) {
      console.error('Failed to load contacts:', error);
    } finally {
      setLoading(false);
    }
  };

  const tenantColumns = [
    { title: 'Name', key: 'name', render: (_, r) => `${r.first_name} ${r.last_name}` },
    { title: 'Email', dataIndex: 'email', key: 'email' },
    { title: 'Phone', dataIndex: 'phone', key: 'phone' },
    { title: 'Status', dataIndex: 'status', render: (s) => <Tag color={s === 1 ? 'green' : 'red'}>{s === 1 ? 'Active' : 'Inactive'}</Tag> },
    { title: 'Actions', key: 'actions', render: (_, r) => (
      <Space>
        <Button type="link" icon={<EyeOutlined />} onClick={() => router.push(`/contacts/tenant/${r.id}/detail`)}>View</Button>
        <Button type="link" icon={<EditOutlined />} onClick={() => router.push(`/contacts/tenant/${r.id}/edit`)}>Edit</Button>
      </Space>
    )},
  ];

  const ownerColumns = [
    { title: 'Name', key: 'name', render: (_, r) => `${r.first_name} ${r.last_name}` },
    { title: 'Email', dataIndex: 'email', key: 'email' },
    { title: 'Company', dataIndex: 'company_name', key: 'company_name' },
    { title: 'Status', dataIndex: 'status', render: (s) => <Tag color={s === 1 ? 'green' : 'red'}>{s === 1 ? 'Active' : 'Inactive'}</Tag> },
    { title: 'Actions', key: 'actions', render: (_, r) => (
      <Space>
        <Button type="link" icon={<EyeOutlined />} onClick={() => router.push(`/contacts/property-owner/${r.id}/detail`)}>View</Button>
        <Button type="link" icon={<EditOutlined />} onClick={() => router.push(`/contacts/property-owner/${r.id}/edit`)}>Edit</Button>
      </Space>
    )},
  ];

  const vendorColumns = [
    { title: 'Name', dataIndex: 'name', key: 'name' },
    { title: 'Email', dataIndex: 'email', key: 'email' },
    { title: 'Phone', dataIndex: 'phone', key: 'phone' },
    { title: 'Category', dataIndex: 'category', key: 'category' },
    { title: 'Status', dataIndex: 'status', render: (s) => <Tag color={s === 1 ? 'green' : 'red'}>{s === 1 ? 'Active' : 'Inactive'}</Tag> },
    { title: 'Actions', key: 'actions', render: (_, r) => (
      <Space>
        <Button type="link" icon={<EyeOutlined />} onClick={() => router.push(`/contacts/service-vendor/${r.id}/detail`)}>View</Button>
        <Button type="link" icon={<EditOutlined />} onClick={() => router.push(`/contacts/service-vendor/${r.id}/edit`)}>Edit</Button>
      </Space>
    )},
  ];

  const payeeColumns = [
    { title: 'Name', dataIndex: 'name', key: 'name' },
    { title: 'Email', dataIndex: 'email', key: 'email' },
    { title: 'Phone', dataIndex: 'phone', key: 'phone' },
    { title: 'Type', dataIndex: 'type', key: 'type' },
    { title: 'Status', dataIndex: 'status', render: (s) => <Tag color={s === 1 ? 'green' : 'red'}>{s === 1 ? 'Active' : 'Inactive'}</Tag> },
    { title: 'Actions', key: 'actions', render: (_, r) => (
      <Space>
        <Button type="link" icon={<EyeOutlined />} onClick={() => router.push(`/contacts/payee/${r.id}/detail`)}>View</Button>
        <Button type="link" icon={<EditOutlined />} onClick={() => router.push(`/contacts/payee/${r.id}/edit`)}>Edit</Button>
      </Space>
    )},
  ];

  const groupColumns = [
    { title: 'Name', dataIndex: 'name', key: 'name' },
    { title: 'Description', dataIndex: 'description', key: 'description' },
    { title: 'Member Count', dataIndex: 'member_count', key: 'member_count' },
    { title: 'Actions', key: 'actions', render: (_, r) => (
      <Space>
        <Button type="link" onClick={() => router.push(`/contacts/group/${r.id}/edit`)}>Edit</Button>
        <Button type="link" onClick={() => router.push(`/contacts/email/send?group=${r.id}`)}>Send Email</Button>
      </Space>
    )},
  ];

  const getCreateLink = () => {
    switch(activeTab) {
      case 'tenants': return '/contacts/tenant/create';
      case 'owners': return '/contacts/property-owner/create';
      case 'vendors': return '/contacts/service-vendor/create';
      case 'payees': return '/contacts/payee/create';
      case 'groups': return '/contacts/group/create';
      default: return '/contacts/tenant/create';
    }
  };

  const getAddLabel = () => {
    switch(activeTab) {
      case 'tenants': return 'Tenant';
      case 'owners': return 'Property Owner';
      case 'vendors': return 'Service Vendor';
      case 'payees': return 'Payee';
      case 'groups': return 'Email Group';
      default: return 'Contact';
    }
  };

  const tabItems = [
    { key: 'tenants', label: 'Tenants', children: <Table columns={tenantColumns} dataSource={tenants} rowKey="id" loading={loading} /> },
    { key: 'owners', label: 'Property Owners', children: <Table columns={ownerColumns} dataSource={propertyOwners} rowKey="id" loading={loading} /> },
    { key: 'vendors', label: 'Service Vendors', children: <Table columns={vendorColumns} dataSource={serviceVendors} rowKey="id" loading={loading} /> },
    { key: 'payees', label: 'Payees', children: <Table columns={payeeColumns} dataSource={payees} rowKey="id" loading={loading} /> },
    { key: 'groups', label: 'Email Groups', children: <Table columns={groupColumns} dataSource={emailGroups} rowKey="id" loading={loading} /> },
  ];

  return (
    <MainLayout>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <h1>Contacts</h1>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => router.push(getCreateLink())}>
          Add {getAddLabel()}
        </Button>
      </div>
      <Card>
        <Tabs activeKey={activeTab} onChange={setActiveTab} items={tabItems} />
      </Card>
    </MainLayout>
  );
}