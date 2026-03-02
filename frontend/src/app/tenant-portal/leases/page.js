'use client';

import { useEffect, useState } from 'react';
import { Table, Tag, Typography, Card, message } from 'antd';
import { tenantPortal } from '../../../lib/tenantApi';

const { Title } = Typography;

const STATUS_MAP = {
  1: { label: 'Active', color: 'green' },
  2: { label: 'Expired', color: 'default' },
  3: { label: 'Terminated', color: 'red' },
  0: { label: 'Inactive', color: 'default' },
};

export default function TenantLeasesPage() {
  const [leases, setLeases] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadLeases();
  }, []);

  const loadLeases = async () => {
    try {
      const response = await tenantPortal.getLeases();
      if (response.data.code === 200) {
        setLeases(response.data.data || []);
      } else {
        message.error(response.data.message || 'Failed to load leases');
      }
    } catch (error) {
      message.error(error.response?.data?.message || 'Failed to load leases');
    } finally {
      setLoading(false);
    }
  };

  const formatDate = (dateStr) => {
    if (!dateStr) return 'N/A';
    return new Date(dateStr).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  const formatCurrency = (amount) => {
    if (amount == null) return 'N/A';
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
  };

  const columns = [
    {
      title: 'Property',
      dataIndex: 'property_name',
      key: 'property_name',
      render: (val) => val || 'N/A',
    },
    {
      title: 'Unit',
      dataIndex: 'unit_name',
      key: 'unit_name',
      render: (val) => val || 'N/A',
    },
    {
      title: 'Start Date',
      dataIndex: 'start_date',
      key: 'start_date',
      render: (val) => formatDate(val),
    },
    {
      title: 'End Date',
      dataIndex: 'end_date',
      key: 'end_date',
      render: (val) => formatDate(val),
    },
    {
      title: 'Rent Amount',
      dataIndex: 'rent_amount',
      key: 'rent_amount',
      render: (val) => formatCurrency(val),
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      render: (val) => {
        const status = STATUS_MAP[val] || { label: 'Unknown', color: 'default' };
        return <Tag color={status.color}>{status.label}</Tag>;
      },
    },
  ];

  return (
    <div>
      <Title level={2} style={{ marginBottom: 24, marginTop: 0 }}>
        My Leases
      </Title>

      <Card style={{ borderRadius: 8 }}>
        <Table
          columns={columns}
          dataSource={leases}
          rowKey="id"
          loading={loading}
          pagination={false}
          locale={{ emptyText: 'No leases found' }}
        />
      </Card>
    </div>
  );
}
