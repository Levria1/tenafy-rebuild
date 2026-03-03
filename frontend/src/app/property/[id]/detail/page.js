'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Card, Button, Spin, Tag, Row, Col, Statistic, Table, Space, message } from 'antd';
import { ArrowLeftOutlined, EditOutlined, PlusOutlined, HomeOutlined, UserOutlined } from '@ant-design/icons';
import MainLayout from '../../../../components/Layout';
import { property } from '../../../../lib/api';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

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
      console.error('Failed to load property:', error);
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
    {
      title: 'Unit',
      dataIndex: 'name',
      key: 'name',
      render: (name, record) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 40, height: 32, borderRadius: 4, overflow: 'hidden', flexShrink: 0,
            background: '#f5f5f5', display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            {record.photo ? (
              <img src={`${API_URL}/api/file/preview/${record.photo}`} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            ) : (
              <HomeOutlined style={{ fontSize: 16, color: '#ccc' }} />
            )}
          </div>
          <span style={{ fontWeight: 500 }}>{name}</span>
        </div>
      ),
    },
    { title: 'Beds', dataIndex: 'beds', key: 'beds', width: 70, render: (v) => v ?? '-' },
    { title: 'Baths', dataIndex: 'baths', key: 'baths', width: 70, render: (v) => v ?? '-' },
    {
      title: 'Size',
      dataIndex: 'size',
      key: 'size',
      width: 100,
      render: (val, record) => val ? `${val} ${record.size_unit || 'sqft'}` : '-',
    },
    {
      title: 'Rent',
      dataIndex: 'rent_price_min',
      key: 'rent',
      width: 120,
      render: (val) => val ? `$${Number(val).toLocaleString()}` : '-',
    },
    {
      title: 'Tenant',
      key: 'tenant',
      width: 150,
      render: (_, record) => {
        const name = [record.tenant_first_name, record.tenant_last_name].filter(Boolean).join(' ');
        return name || <span style={{ color: '#ccc' }}>—</span>;
      },
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (status) => (
        <Tag color={status === 1 ? 'blue' : 'green'}>
          {status === 1 ? 'Occupied' : 'Vacant'}
        </Tag>
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 120,
      render: (_, record) => (
        <Button
          type="primary"
          ghost
          size="small"
          onClick={() => router.push(`/property/${params.id}/unit/${record.id}`)}
        >
          View Unit →
        </Button>
      ),
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

  const totalUnits = propertyData.total_units || 0;
  const occupiedUnits = propertyData.occupied_units || 0;
  const vacantUnits = totalUnits - occupiedUnits;

  // Build full address
  const addressParts = [
    propertyData.street_address,
    propertyData.city,
    propertyData.state,
    propertyData.country,
    propertyData.zip_code,
  ].filter(Boolean);
  const fullAddress = addressParts.join(', ');

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
            <Card
              title={
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  {propertyData.photo ? (
                    <img
                      src={`${API_URL}/api/file/preview/${propertyData.photo}`}
                      alt=""
                      style={{ width: 48, height: 36, objectFit: 'cover', borderRadius: 4 }}
                    />
                  ) : (
                    <div style={{
                      width: 48, height: 36, borderRadius: 4, background: '#f5f5f5',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      <HomeOutlined style={{ fontSize: 20, color: '#bbb' }} />
                    </div>
                  )}
                  <span>{propertyData.display_name}</span>
                </div>
              }
              extra={
                <Button icon={<EditOutlined />} onClick={() => router.push(`/property/${params.id}/edit`)}>
                  Edit
                </Button>
              }
            >
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 24px' }}>
                <div><strong>Address:</strong> {fullAddress || 'Not set'}</div>
                <div><strong>District:</strong> {propertyData.district || '-'}</div>
                <div><strong>Type:</strong> {propertyData.type === 2 ? 'Commercial' : 'Residential'}</div>
                <div><strong>Currency:</strong> {propertyData.currency || '-'}</div>
                <div><strong>Year Built:</strong> {propertyData.year_of_built || '-'}</div>
                <div><strong>MLS #:</strong> {propertyData.mls || '-'}</div>
                <div>
                  <strong>Status: </strong>
                  <Tag color={propertyData.status === 1 ? 'green' : 'red'}>
                    {propertyData.status === 1 ? 'Active' : 'Inactive'}
                  </Tag>
                </div>
              </div>
              {propertyData.notes && (
                <div style={{ marginTop: 12 }}>
                  <strong>Notes:</strong>
                  <p style={{ color: '#666', marginTop: 4 }}>{propertyData.notes}</p>
                </div>
              )}
            </Card>
          </Col>
          <Col span={8}>
            <Card>
              <Statistic title="Total Units" value={totalUnits} />
              <div style={{ marginTop: 16 }}>
                <Statistic title="Occupied" value={occupiedUnits} valueStyle={{ color: '#1890ff' }} />
              </div>
              <div style={{ marginTop: 16 }}>
                <Statistic title="Vacant" value={vacantUnits} valueStyle={{ color: '#d4760a' }} />
              </div>
              <div style={{ marginTop: 16 }}>
                <Statistic
                  title="Occupancy Rate"
                  value={totalUnits > 0 ? Math.round((occupiedUnits / totalUnits) * 100) : 0}
                  suffix="%"
                  valueStyle={{ color: '#52c41a' }}
                />
              </div>
            </Card>
          </Col>
        </Row>

        <Card
          title={`Units (${units.length})`}
          extra={
            <Button type="primary" icon={<PlusOutlined />} onClick={() => router.push(`/property/${params.id}/unit/create`)}>
              Add Unit
            </Button>
          }
          style={{ marginTop: 16 }}
        >
          <Table
            columns={unitColumns}
            dataSource={units}
            rowKey="id"
            pagination={{ pageSize: 10 }}
            size="middle"
          />
        </Card>
      </div>
    </MainLayout>
  );
}
