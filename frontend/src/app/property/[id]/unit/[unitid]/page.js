'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Card, Descriptions, Button, Space, Tag, message, Row, Col } from 'antd';
import {
  EditOutlined, DeleteOutlined, ArrowLeftOutlined,
  ToolOutlined, InboxOutlined, HomeOutlined, HistoryOutlined,
  DollarOutlined, FileDoneOutlined
} from '@ant-design/icons';
import MainLayout from '../../../../../components/Layout';
import { property as propertyApi } from '../../../../../lib/api';

export default function UnitDetailPage() {
  const [unit, setUnit] = useState(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const params = useParams();
  const propertyId = params.id;
  const unitId = params.unitid;

  useEffect(() => {
    loadUnit();
  }, [unitId]);

  const loadUnit = async () => {
    try {
      const response = await propertyApi.getUnit(unitId);
      if (response.data.code === 200) {
        setUnit(response.data.data);
      }
    } catch (error) {
      message.error('Failed to load unit');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    try {
      await propertyApi.deleteUnit(unitId);
      message.success('Unit deleted');
      router.push(`/property/${propertyId}`);
    } catch (error) {
      message.error('Failed to delete unit');
    }
  };

  const getStatusColor = (status) => {
    const colors = { VACANT: 'green', OCCUPIED: 'blue', MAINTENANCE: 'orange', UNAVAILABLE: 'red' };
    return colors[status] || 'default';
  };

  const getFurnishingColor = (furnishing) => {
    const colors = { UNFURNISHED: 'default', PARTIALLY_FURNISHED: 'orange', FULLY_FURNISHED: 'green' };
    return colors[furnishing] || 'default';
  };

  const navBase = `/property/${propertyId}/unit/${unitId}`;

  const quickLinks = [
    { label: 'Furnishing', icon: <HomeOutlined />, path: `${navBase}/furnishing`, color: '#1890ff' },
    { label: 'Inventory', icon: <InboxOutlined />, path: `${navBase}/furnishing`, color: '#52c41a' },
    { label: 'Inventory History', icon: <HistoryOutlined />, path: `${navBase}/inventory-history`, color: '#faad14' },
    { label: 'Maintenance', icon: <ToolOutlined />, path: `${navBase}/maintenance`, color: '#f5222d' },
    { label: 'Service Cost', icon: <DollarOutlined />, path: `${navBase}/service-cost`, color: '#722ed1' },
    { label: 'Service History', icon: <FileDoneOutlined />, path: `${navBase}/service-history`, color: '#13c2c2' },
  ];

  if (loading) return <MainLayout><Card loading /></MainLayout>;
  if (!unit) return <MainLayout><Card>Unit not found</Card></MainLayout>;

  return (
    <MainLayout>
      <Space direction="vertical" style={{ width: '100%' }} size="large">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Button icon={<ArrowLeftOutlined />} onClick={() => router.push(`/property/${propertyId}`)}>
            Back to Property
          </Button>
          <Space>
            <Button
              icon={<EditOutlined />}
              onClick={() => router.push(`${navBase}/edit`)}
            >
              Edit
            </Button>
            <Button icon={<DeleteOutlined />} danger onClick={handleDelete}>Delete</Button>
          </Space>
        </div>

        <Card title={`Unit: ${unit.name || unit.unit_number || `Unit ${unitId}`}`}>
          <Descriptions bordered column={2}>
            <Descriptions.Item label="Unit Name">{unit.name || unit.unit_name || '-'}</Descriptions.Item>
            <Descriptions.Item label="Unit Number">{unit.unit_number || '-'}</Descriptions.Item>
            <Descriptions.Item label="Property">{unit.property_name || '-'}</Descriptions.Item>
            <Descriptions.Item label="Floor">{unit.floor || '-'}</Descriptions.Item>
            <Descriptions.Item label="Bedrooms">{unit.bedroom_count ?? unit.bedrooms ?? '-'}</Descriptions.Item>
            <Descriptions.Item label="Bathrooms">{unit.bathroom_count ?? unit.bathrooms ?? '-'}</Descriptions.Item>
            <Descriptions.Item label="Size">{unit.size ? `${unit.size} sq ft` : '-'}</Descriptions.Item>
            <Descriptions.Item label="Monthly Rent">
              {unit.rent_amount != null ? `$${Number(unit.rent_amount).toLocaleString()}` :
               unit.monthly_rent != null ? `$${Number(unit.monthly_rent).toLocaleString()}` : '-'}
            </Descriptions.Item>
            <Descriptions.Item label="Deposit">
              {unit.deposit != null ? `$${Number(unit.deposit).toLocaleString()}` : '-'}
            </Descriptions.Item>
            <Descriptions.Item label="Status">
              <Tag color={getStatusColor(unit.status)}>{unit.status || 'VACANT'}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="Furnishing">
              <Tag color={getFurnishingColor(unit.furnishing)}>
                {unit.furnishing ? unit.furnishing.replace(/_/g, ' ') : '-'}
              </Tag>
            </Descriptions.Item>
            <Descriptions.Item label="Description" span={2}>{unit.description || '-'}</Descriptions.Item>
          </Descriptions>
        </Card>

        <Card title="Quick Access">
          <Row gutter={[16, 16]}>
            {quickLinks.map(link => (
              <Col key={link.label} xs={12} sm={8} md={4}>
                <Button
                  block
                  size="large"
                  icon={link.icon}
                  onClick={() => router.push(link.path)}
                  style={{ height: 80, flexDirection: 'column', borderColor: link.color, color: link.color }}
                >
                  <div style={{ fontSize: 12, marginTop: 4 }}>{link.label}</div>
                </Button>
              </Col>
            ))}
          </Row>
        </Card>
      </Space>
    </MainLayout>
  );
}
