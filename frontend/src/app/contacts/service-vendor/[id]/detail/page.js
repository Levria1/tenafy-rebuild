'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Card, Descriptions, Button, Space, Tag, Tabs, Table, message } from 'antd';
import { EditOutlined, ArrowLeftOutlined } from '@ant-design/icons';
import MainLayout from '../../../../../components/Layout';
import { contact, service } from '../../../../../lib/api';

const STATUS_MAP = {
  0: { label: 'Pending', color: 'orange' },
  1: { label: 'Ongoing', color: 'blue' },
  2: { label: 'Completed', color: 'green' },
};

const PRIORITY_MAP = {
  0: { label: 'High', color: 'red' },
  1: { label: 'Medium', color: 'orange' },
  2: { label: 'Low', color: 'green' },
};

export default function ServiceVendorDetailPage() {
  const [vendor, setVendor] = useState(null);
  const [services, setServices] = useState([]);
  const [servicesLoading, setServicesLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const params = useParams();
  const vendorId = params.id;

  useEffect(() => {
    loadVendor();
    loadServices();
  }, [vendorId]);

  const loadVendor = async () => {
    try {
      const response = await contact.getServiceVendor(vendorId);
      if (response.data.code === 200) {
        setVendor(response.data.data);
      }
    } catch (error) {
      message.error('Failed to load service vendor');
    } finally {
      setLoading(false);
    }
  };

  const loadServices = async () => {
    setServicesLoading(true);
    try {
      const response = await service.list({});
      if (response.data.code === 200) {
        setServices(response.data.data?.content || response.data.data || []);
      }
    } catch (error) {
      console.error('Failed to load services');
    } finally {
      setServicesLoading(false);
    }
  };

  const vendorName = vendor ? [vendor.first_name, vendor.last_name].filter(Boolean).join(' ') : '';

  const serviceColumns = [
    { title: 'Service Code', dataIndex: 'code', key: 'code' },
    { title: 'Category', dataIndex: 'category', key: 'category', render: (v) => v || '-' },
    { title: 'Unit', dataIndex: 'unit_name', key: 'unit_name', render: (v) => v || '-' },
    {
      title: 'Priority', dataIndex: 'priority', key: 'priority',
      render: (v) => {
        const info = PRIORITY_MAP[v];
        return info ? <Tag color={info.color}>{info.label}</Tag> : '-';
      },
    },
    {
      title: 'Status', dataIndex: 'status', key: 'status',
      render: (v) => {
        const info = STATUS_MAP[v] || { label: 'Unknown', color: 'default' };
        return <Tag color={info.color}>{info.label}</Tag>;
      },
    },
    { title: 'Date', dataIndex: 'created_at', key: 'created_at', render: (v) => v ? new Date(v).toLocaleDateString() : '-' },
    {
      title: 'Actions', key: 'actions',
      render: (_, r) => (
        <Button type="link" onClick={() => router.push(`/services/${r.id}/detail`)}>View</Button>
      ),
    },
  ];

  const tabItems = [
    {
      key: 'profile',
      label: 'Profile',
      children: (
        <Descriptions bordered column={2}>
          <Descriptions.Item label="First Name">{vendor?.first_name || '-'}</Descriptions.Item>
          <Descriptions.Item label="Last Name">{vendor?.last_name || '-'}</Descriptions.Item>
          <Descriptions.Item label="Email">{vendor?.email || '-'}</Descriptions.Item>
          <Descriptions.Item label="Phone">{vendor?.phone || '-'}</Descriptions.Item>
          <Descriptions.Item label="ID Card">{vendor?.id_card || '-'}</Descriptions.Item>
          <Descriptions.Item label="Birth Date">{vendor?.birth_date || '-'}</Descriptions.Item>
          <Descriptions.Item label="Sex">{vendor?.sex === 0 ? 'Male' : vendor?.sex === 1 ? 'Female' : '-'}</Descriptions.Item>
          <Descriptions.Item label="Status"><Tag color={vendor?.status === 1 ? 'green' : 'red'}>{vendor?.status === 1 ? 'Active' : 'Inactive'}</Tag></Descriptions.Item>
          <Descriptions.Item label="Notes" span={2}>{vendor?.notes || '-'}</Descriptions.Item>
        </Descriptions>
      ),
    },
    {
      key: 'services',
      label: 'Services',
      children: (
        <Table
          columns={serviceColumns}
          dataSource={services}
          rowKey="id"
          loading={servicesLoading}
          locale={{ emptyText: 'No service orders found' }}
        />
      ),
    },
  ];

  return (
    <MainLayout>
      <Space direction="vertical" style={{ width: '100%' }} size="large">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Button icon={<ArrowLeftOutlined />} onClick={() => router.push('/contacts')}>Back to Contacts</Button>
          <Button type="primary" icon={<EditOutlined />} onClick={() => router.push(`/contacts/service-vendor/${vendorId}/edit`)}>Edit Vendor</Button>
        </div>
        <Card title={vendorName || 'Service Vendor'} loading={loading}>
          {vendor && <Tabs items={tabItems} />}
        </Card>
      </Space>
    </MainLayout>
  );
}
