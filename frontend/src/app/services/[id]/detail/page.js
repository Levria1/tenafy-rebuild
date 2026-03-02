'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Card, Descriptions, Button, Space, Tag, message } from 'antd';
import { EditOutlined, ArrowLeftOutlined } from '@ant-design/icons';
import MainLayout from '../../../../components/Layout';
import { service } from '../../../../lib/api';

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

export default function ServiceDetailPage() {
  const [serviceData, setServiceData] = useState(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const params = useParams();
  const serviceId = params.id;

  useEffect(() => {
    loadService();
  }, [serviceId]);

  const loadService = async () => {
    try {
      const response = await service.get(serviceId);
      if (response.data.code === 200) {
        setServiceData(response.data.data);
      }
    } catch (error) {
      message.error('Failed to load service');
    } finally {
      setLoading(false);
    }
  };

  const formatDate = (d) => {
    if (!d) return '-';
    return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  };

  const formatDateTime = (d) => {
    if (!d) return '-';
    return new Date(d).toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  const statusInfo = STATUS_MAP[serviceData?.status] || { label: 'Unknown', color: 'default' };
  const priorityInfo = PRIORITY_MAP[serviceData?.priority];

  return (
    <MainLayout>
      <Space direction="vertical" style={{ width: '100%' }} size="large">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Button icon={<ArrowLeftOutlined />} onClick={() => router.push('/services')}>Back to Services</Button>
          <Button type="primary" icon={<EditOutlined />} onClick={() => router.push(`/services/${serviceId}/edit`)}>Edit Service</Button>
        </div>
        <Card title={`Service ${serviceData?.code || '#' + serviceId}`} loading={loading}>
          {serviceData && (
            <Descriptions bordered column={2}>
              <Descriptions.Item label="Service Code">{serviceData.code || '-'}</Descriptions.Item>
              <Descriptions.Item label="Status"><Tag color={statusInfo.color}>{statusInfo.label}</Tag></Descriptions.Item>
              <Descriptions.Item label="Category">{serviceData.category || '-'}</Descriptions.Item>
              <Descriptions.Item label="Sub-Category">{serviceData.sub_category || '-'}</Descriptions.Item>
              <Descriptions.Item label="Property">{serviceData.property_name || '-'}</Descriptions.Item>
              <Descriptions.Item label="Unit">{serviceData.unit_name || '-'}</Descriptions.Item>
              <Descriptions.Item label="Priority">
                {priorityInfo ? <Tag color={priorityInfo.color}>{priorityInfo.label}</Tag> : '-'}
              </Descriptions.Item>
              <Descriptions.Item label="Assignee">
                {[serviceData.assignee_first_name, serviceData.assignee_last_name].filter(Boolean).join(' ') || '-'}
              </Descriptions.Item>
              <Descriptions.Item label="Created By">
                {[serviceData.created_by_first_name, serviceData.created_by_last_name].filter(Boolean).join(' ') || '-'}
              </Descriptions.Item>
              <Descriptions.Item label="Created">{formatDate(serviceData.created_at)}</Descriptions.Item>
              <Descriptions.Item label="Preferred Date 1">
                {serviceData.preferred_date_first_start ? `${formatDateTime(serviceData.preferred_date_first_start)} — ${formatDateTime(serviceData.preferred_date_first_end)}` : '-'}
              </Descriptions.Item>
              <Descriptions.Item label="Preferred Date 2">
                {serviceData.preferred_date_second_start ? `${formatDateTime(serviceData.preferred_date_second_start)} — ${formatDateTime(serviceData.preferred_date_second_end)}` : '-'}
              </Descriptions.Item>
              <Descriptions.Item label="Service Date">
                {serviceData.service_date_start ? `${formatDateTime(serviceData.service_date_start)} — ${formatDateTime(serviceData.service_date_end)}` : '-'}
              </Descriptions.Item>
              <Descriptions.Item label="Additional Info" span={2}>{serviceData.additional_info || '-'}</Descriptions.Item>
              <Descriptions.Item label="Note" span={2}>{serviceData.note || '-'}</Descriptions.Item>
            </Descriptions>
          )}
        </Card>
      </Space>
    </MainLayout>
  );
}
