'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Card, Descriptions, Button, Space, Tag, Tabs, Table, message } from 'antd';
import { EditOutlined, ArrowLeftOutlined } from '@ant-design/icons';
import MainLayout from '../../../../../components/Layout';
import { contact, property } from '../../../../../lib/api';

export default function PropertyOwnerDetailPage() {
  const [owner, setOwner] = useState(null);
  const [ownerUnits, setOwnerUnits] = useState([]);
  const [unitsLoading, setUnitsLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const params = useParams();
  const ownerId = params.id;

  useEffect(() => {
    loadOwner();
    loadOwnerProperties();
  }, [ownerId]);

  const loadOwner = async () => {
    try {
      const response = await contact.getPropertyOwner(ownerId);
      if (response.data.code === 200) {
        setOwner(response.data.data);
      }
    } catch (error) {
      message.error('Failed to load property owner');
    } finally {
      setLoading(false);
    }
  };

  const loadOwnerProperties = async () => {
    setUnitsLoading(true);
    try {
      const response = await property.getAllWithUnits();
      if (response.data.code === 200) {
        const properties = response.data.data || [];
        const units = [];
        properties.forEach((prop) => {
          (prop.units || []).forEach((unit) => {
            if (String(unit.owner_id) === String(ownerId)) {
              units.push({
                ...unit,
                property_name: prop.display_name || prop.name,
                property_id: prop.id,
              });
            }
          });
        });
        setOwnerUnits(units);
      }
    } catch (error) {
      console.error('Failed to load owner properties');
    } finally {
      setUnitsLoading(false);
    }
  };

  const unitColumns = [
    { title: 'Property Name', dataIndex: 'property_name', key: 'property_name' },
    { title: 'Unit Name', dataIndex: 'name', key: 'name', render: (v) => v || '-' },
    {
      title: 'Status', dataIndex: 'occupied', key: 'occupied',
      render: (v) => <Tag color={v ? 'green' : 'orange'}>{v ? 'Occupied' : 'Vacant'}</Tag>,
    },
    {
      title: 'Rent', dataIndex: 'rent_price_min', key: 'rent_price_min',
      render: (v) => v ? `$${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2 })}` : '-',
    },
    {
      title: 'Actions', key: 'actions',
      render: (_, r) => (
        <Button type="link" onClick={() => router.push(`/property/${r.property_id}/unit/${r.id}`)}>View</Button>
      ),
    },
  ];

  const tabItems = [
    {
      key: 'profile',
      label: 'Profile',
      children: (
        <Descriptions bordered column={2}>
          <Descriptions.Item label="First Name">{owner?.first_name || '-'}</Descriptions.Item>
          <Descriptions.Item label="Last Name">{owner?.last_name || '-'}</Descriptions.Item>
          <Descriptions.Item label="Email">{owner?.email || '-'}</Descriptions.Item>
          <Descriptions.Item label="Phone">{owner?.phone || '-'}</Descriptions.Item>
          <Descriptions.Item label="ID Card">{owner?.id_card || '-'}</Descriptions.Item>
          <Descriptions.Item label="Birth Date">{owner?.birth_date || '-'}</Descriptions.Item>
          <Descriptions.Item label="Sex">{owner?.sex === 0 ? 'Male' : owner?.sex === 1 ? 'Female' : '-'}</Descriptions.Item>
          <Descriptions.Item label="Status"><Tag color={owner?.status === 1 ? 'green' : 'red'}>{owner?.status === 1 ? 'Active' : 'Inactive'}</Tag></Descriptions.Item>
          <Descriptions.Item label="Notes" span={2}>{owner?.notes || '-'}</Descriptions.Item>
        </Descriptions>
      ),
    },
    {
      key: 'properties',
      label: 'Properties',
      children: (
        <Table
          columns={unitColumns}
          dataSource={ownerUnits}
          rowKey="id"
          loading={unitsLoading}
          locale={{ emptyText: 'No properties found for this owner' }}
        />
      ),
    },
  ];

  return (
    <MainLayout>
      <Space direction="vertical" style={{ width: '100%' }} size="large">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Button icon={<ArrowLeftOutlined />} onClick={() => router.push('/contacts')}>Back to Contacts</Button>
          <Button type="primary" icon={<EditOutlined />} onClick={() => router.push(`/contacts/property-owner/${ownerId}/edit`)}>Edit Owner</Button>
        </div>
        <Card title={owner ? `${owner.first_name} ${owner.last_name}` : 'Property Owner'} loading={loading}>
          {owner && <Tabs items={tabItems} />}
        </Card>
      </Space>
    </MainLayout>
  );
}
