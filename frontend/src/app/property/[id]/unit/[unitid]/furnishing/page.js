'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Card, Descriptions, Button, Space, Tag, Table, message } from 'antd';
import { ArrowLeftOutlined, EditOutlined } from '@ant-design/icons';
import MainLayout from '../../../../../../components/Layout';
import { property as propertyApi } from '../../../../../../lib/api';

export default function UnitFurnishingPage() {
  const [unit, setUnit] = useState(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const params = useParams();
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

  const furnishingItems = [
    { label: 'Furnishing Status', value: unit?.furnishing || '-' },
    { label: 'Air Conditioning', value: unit?.air_conditioning ? 'Yes' : 'No' },
    { label: 'Heating', value: unit?.heating ? 'Yes' : 'No' },
    { label: 'Washer/Dryer', value: unit?.washer_dryer ? 'Yes' : 'No' },
    { label: 'Dishwasher', value: unit?.dishwasher ? 'Yes' : 'No' },
    { label: 'Refrigerator', value: unit?.refrigerator ? 'Yes' : 'No' },
    { label: 'Microwave', value: unit?.microwave ? 'Yes' : 'No' },
    { label: 'Furniture', value: unit?.furniture ? 'Yes' : 'No' },
  ];

  return (
    <MainLayout>
      <Space direction="vertical" style={{ width: '100%' }} size="large">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Button icon={<ArrowLeftOutlined />} onClick={() => router.back()}>Back to Unit</Button>
          <Button type="primary" icon={<EditOutlined />} onClick={() => router.push(`/property/unit/${unitId}/edit`)}>Edit Furnishing</Button>
        </div>
        <Card title="Unit Furnishing Details" loading={loading}>
          {unit && (
            <Descriptions bordered column={2}>
              {furnishingItems.map((item, index) => (
                <Descriptions.Item key={index} label={item.label}>{item.value}</Descriptions.Item>
              ))}
            </Descriptions>
          )}
        </Card>
      </Space>
    </MainLayout>
  );
}
