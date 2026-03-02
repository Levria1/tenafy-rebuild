'use client';

import { useEffect, useState } from 'react';
import { Table, Button, Space, Tag, Card, Input } from 'antd';
import { PlusOutlined, EditOutlined, EyeOutlined } from '@ant-design/icons';
import { useRouter } from 'next/navigation';
import MainLayout from '../../components/Layout';
import { service } from '../../lib/api';

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

export default function ServicesPage() {
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pagination, setPagination] = useState({ current: 1, pageSize: 20, total: 0 });
  const [search, setSearch] = useState('');
  const router = useRouter();

  useEffect(() => {
    loadServices();
  }, [pagination.current, pagination.pageSize, search]);

  const loadServices = async () => {
    try {
      setLoading(true);
      const response = await service.list({ search }, { page: pagination.current, limit: pagination.pageSize });
      if (response.data.code === 200) {
        setServices(response.data.data.content || []);
        setPagination({ ...pagination, total: response.data.data.totalElements || 0 });
      }
    } catch (error) {
      console.error('Failed to load services:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleTableChange = (pag) => {
    setPagination({ ...pagination, current: pag.current, pageSize: pag.pageSize });
  };

  const columns = [
    { title: 'Code', dataIndex: 'code', key: 'code' },
    { title: 'Category', dataIndex: 'category', key: 'category', render: (v) => v || '-' },
    { title: 'Property', dataIndex: 'property_name', key: 'property_name', render: (v) => v || '-' },
    { title: 'Unit', dataIndex: 'unit_name', key: 'unit_name', render: (v) => v || '-' },
    { title: 'Priority', dataIndex: 'priority', key: 'priority', render: (v) => {
      const info = PRIORITY_MAP[v];
      return info ? <Tag color={info.color}>{info.label}</Tag> : '-';
    }},
    { title: 'Assignee', key: 'assignee', render: (_, r) => {
      if (r.assignee_first_name || r.assignee_last_name) {
        return [r.assignee_first_name, r.assignee_last_name].filter(Boolean).join(' ');
      }
      return '-';
    }},
    { title: 'Status', dataIndex: 'status', key: 'status', render: (s) => {
      const info = STATUS_MAP[s] || { label: 'Unknown', color: 'default' };
      return <Tag color={info.color}>{info.label}</Tag>;
    }},
    { title: 'Created', dataIndex: 'created_at', key: 'created_at', render: (v) => v ? new Date(v).toLocaleDateString() : '-' },
    { title: 'Actions', key: 'actions', render: (_, r) => (
      <Space>
        <Button type="link" icon={<EyeOutlined />} onClick={() => router.push(`/services/${r.id}/detail`)}>View</Button>
        <Button type="link" icon={<EditOutlined />} onClick={() => router.push(`/services/${r.id}/edit`)}>Edit</Button>
      </Space>
    )},
  ];

  return (
    <MainLayout>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <h1>Services</h1>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => router.push('/services/create')}>
          Create Service
        </Button>
      </div>
      <Card>
        <Input.Search
          placeholder="Search by code or note..."
          style={{ width: 300, marginBottom: 16 }}
          onSearch={(v) => { setSearch(v); setPagination({ ...pagination, current: 1 }); }}
          allowClear
        />
        <Table columns={columns} dataSource={services} rowKey="id" loading={loading} pagination={pagination} onChange={handleTableChange} />
      </Card>
    </MainLayout>
  );
}
