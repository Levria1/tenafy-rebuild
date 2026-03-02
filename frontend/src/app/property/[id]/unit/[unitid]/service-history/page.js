'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Card, Button, Space, Tag, Table, message } from 'antd';
import { ArrowLeftOutlined, PlusOutlined } from '@ant-design/icons';
import MainLayout from '../../../../../../components/Layout';
import { property, service } from '../../../../../../lib/api';

export default function UnitServiceHistoryPage() {
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const params = useParams();
  const unitId = params.unitid;

  useEffect(() => {
    loadServices();
  }, [unitId]);

  const loadServices = async () => {
    try {
      const response = await service.list({ unit_id: unitId }, { page: 1, limit: 100 });
      if (response.data.code === 200) {
        setServices(response.data.data.content || []);
      }
    } catch (error) {
      console.error('Failed to load services');
    } finally {
      setLoading(false);
    }
  };

  const columns = [
    { title: 'Title', dataIndex: 'title', key: 'title' },
    { title: 'Category', dataIndex: 'category', key: 'category' },
    { title: 'Vendor', dataIndex: 'vendor_name', key: 'vendor_name' },
    { title: 'Cost', dataIndex: 'cost', key: 'cost', render: (v) => v ? `$${v.toLocaleString()}` : '-' },
    { title: 'Service Date', dataIndex: 'service_date', key: 'service_date' },
    { title: 'Status', dataIndex: 'status', key: 'status', render: (s) => <Tag color={s === 'COMPLETED' ? 'green' : 'orange'}>{s}</Tag> },
    { title: 'Actions', key: 'actions', render: (_, r) => (
      <Button type="link" onClick={() => router.push(`/services/${r.id}/detail`)}>View</Button>
    )},
  ];

  return (
    <MainLayout>
      <Space direction="vertical" style={{ width: '100%' }} size="large">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Button icon={<ArrowLeftOutlined />} onClick={() => router.back()}>Back to Unit</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => router.push(`/services/create?unitId=${unitId}`)}>Add Service</Button>
        </div>
        <Card title="Service History">
          <Table columns={columns} dataSource={services} rowKey="id" loading={loading} />
        </Card>
      </Space>
    </MainLayout>
  );
}
