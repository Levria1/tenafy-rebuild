'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Card, Button, Spin, Tag, Row, Col, Statistic, Table, Space, message } from 'antd';
import { ArrowLeftOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import MainLayout from '../../../../components/Layout';
import { property } from '../../../../lib/api';

export default function PropertyDetailPage() {
  const router = useRouter();
  const params = useParams();
  const [loading, setLoading] = useState(true);
  const [propertyData, setPropertyData] = useState(null);
  const [units, setUnits] = useState([]);

  useEffect(() => {
    if (params.id) {
      loadProperty();
      loadUnits();
    }
  }, [params.id]);

  const loadProperty = async () => {
    try {
      const response = await property.get(params.id);
      if (response.data.code === 200) {
        setPropertyData(response.data.data);
      }
    } catch (error) {
      message.error('Failed to load property');
      router.push('/property');
    } finally {
      setLoading(false);
    }
  };

  const loadUnits = async () => {
    try {
      const response = await property.getUnits(params.id);
      if (response.data.code === 200) {
        setUnits(response.data.data || []);
      }
    } catch (error) {
      console.error('Failed to load units');
    }
  };

  const unitColumns = [
    { title: 'Unit Number', dataIndex: 'unit_number', key: 'unit_number' },
    { title: 'Unit Name', dataIndex: 'unit_name', key: 'unit_name' },
    { title: 'Floor', dataIndex: 'floor', key: 'floor' },
    { title: 'Beds', dataIndex: 'bedroom_count', key: 'beds' },
    { title: 'Baths', dataIndex: 'bathroom_count', key: 'baths' },
    { title: 'Size', dataIndex: 'size', key: 'size', render: (val) => val ? `${val} sq ft` : '-' },
    { title: 'Rent', dataIndex: 'monthly_rent', key: 'rent', 
      render: (val) => val ? `$${val.toLocaleString()}` : '-'
    },
    { title: 'Status', dataIndex: 'status', key: 'status',
      render: (status) => {
        const colors = { VACANT: 'green', OCCUPIED: 'blue', MAINTENANCE: 'orange', UNAVAILABLE: 'red' };
        return <Tag color={colors[status] || 'default'}>{status?.replace(/_/g, ' ')}</Tag>;
      }
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_, record) => (
        <Space>
          <Button type="link" onClick={() => router.push(`/property/${params.id}/unit/${record.id}`)}>View</Button>
          <Button type="link" onClick={() => router.push(`/property/${params.id}/unit/${record.id}/edit`)}>Edit</Button>
        </Space>
      )
    }
  ];

  if (loading) {
    return (
      <MainLayout>
        <div style={{ textAlign: 'center', padding: 50 }}>
          <Spin size="large" />
        </div>
      </MainLayout>
    );
  }

  if (!propertyData) return null;

  return (
    <MainLayout>
      <div style={{ maxWidth: 1200, margin: '0 auto' }}>
        <Button 
          icon={<ArrowLeftOutlined />} 
          onClick={() => router.push('/property')}
          style={{ marginBottom: 16 }}
        >
          Back to Properties
        </Button>

        <Row gutter={16}>
          <Col span={16}>
            <Card title={propertyData.display_name} extra={
              <Button icon={<EditOutlined />} onClick={() => router.push(`/property/${params.id}/edit`)}>
                Edit
              </Button>
            }>
              <p><strong>Address:</strong> {propertyData.address}</p>
              {propertyData.description && <p><strong>Description:</strong> {propertyData.description}</p>}
              <p><strong>Currency:</strong> {propertyData.currency}</p>
              <p><strong>Status:</strong> <Tag color={propertyData.status === 1 ? 'green' : 'red'}>
                {propertyData.status === 1 ? 'Active' : 'Inactive'}
              </Tag></p>
            </Card>
          </Col>
          <Col span={8}>
            <Card>
              <Statistic title="Total Units" value={propertyData.unit_count || 0} />
              <Statistic title="Occupied" value={propertyData.occupied_count || 0} valueStyle={{ color: '#3f8600' }} />
              <Statistic title="Vacant" value={(propertyData.unit_count || 0) - (propertyData.occupied_count || 0)} valueStyle={{ color: '#cf1322' }} />
            </Card>
          </Col>
        </Row>

        <Card title="Units" extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => router.push(`/property/${params.id}/unit/create`)}>
            Add Unit
          </Button>
        }>
          <Table
            columns={unitColumns}
            dataSource={units}
            rowKey="id"
            pagination={{ pageSize: 10 }}
          />
        </Card>
      </div>
    </MainLayout>
  );
}
