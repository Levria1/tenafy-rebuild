'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Card, Button, Space, Tag, Table, Row, Col, Statistic, message } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import MainLayout from '../../../../../../components/Layout';
import { service } from '../../../../../../lib/api';

export default function UnitServiceCostPage() {
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({ total: 0, thisMonth: 0, thisYear: 0 });
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
        const data = response.data.data.content || [];
        setServices(data);
        
        const total = data.reduce((sum, s) => sum + (s.cost || 0), 0);
        const now = new Date();
        const thisMonth = data.filter(s => {
          const d = new Date(s.service_date);
          return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
        }).reduce((sum, s) => sum + (s.cost || 0), 0);
        const thisYear = data.filter(s => {
          const d = new Date(s.service_date);
          return d.getFullYear() === now.getFullYear();
        }).reduce((sum, s) => sum + (s.cost || 0), 0);
        
        setStats({ total, thisMonth, thisYear });
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
    { title: 'Cost', dataIndex: 'cost', key: 'cost', render: (v) => v ? `$${v.toLocaleString()}` : '-' },
    { title: 'Service Date', dataIndex: 'service_date', key: 'service_date' },
    { title: 'Actions', key: 'actions', render: (_, r) => (
      <Button type="link" onClick={() => router.push(`/services/${r.id}/detail`)}>View</Button>
    )},
  ];

  return (
    <MainLayout>
      <Space direction="vertical" style={{ width: '100%' }} size="large">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Button icon={<ArrowLeftOutlined />} onClick={() => router.back()}>Back to Unit</Button>
        </div>
        <Row gutter={16}>
          <Col span={8}>
            <Card loading={loading}><Statistic title="Total Cost" value={stats.total} prefix="$" /></Card>
          </Col>
          <Col span={8}>
            <Card loading={loading}><Statistic title="This Month" value={stats.thisMonth} prefix="$" valueStyle={{ color: '#1890ff' }} /></Card>
          </Col>
          <Col span={8}>
            <Card loading={loading}><Statistic title="This Year" value={stats.thisYear} prefix="$" valueStyle={{ color: '#52c41a' }} /></Card>
          </Col>
        </Row>
        <Card title="Service Cost Details">
          <Table columns={columns} dataSource={services} rowKey="id" loading={loading} />
        </Card>
      </Space>
    </MainLayout>
  );
}
