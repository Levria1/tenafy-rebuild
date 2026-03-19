'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Table, Button, Tag, Card, message, Switch, Space } from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { master } from '../../../lib/api';
import dayjs from 'dayjs';

export default function MasterDashboardPage() {
  const router = useRouter();
  const [orgs, setOrgs] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchOrgs = useCallback(async () => {
    setLoading(true);
    try {
      const res = await master.listOrganizations();
      setOrgs(res.data.data || []);
    } catch (err) {
      message.error('Failed to load organizations');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchOrgs(); }, [fetchOrgs]);

  const handleToggleStatus = async (org) => {
    const newStatus = Number(org.status) === 1 ? 0 : 1;
    try {
      await master.updateOrganization(org.id, { status: newStatus });
      message.success(`Organization ${newStatus === 1 ? 'enabled' : 'disabled'}`);
      fetchOrgs();
    } catch (err) {
      message.error('Failed to update status');
    }
  };

  const handleToggleApi = async (org) => {
    const newVal = Number(org.public_api_enabled) === 1 ? 0 : 1;
    try {
      await master.updateOrganization(org.id, { public_api_enabled: newVal });
      message.success(`Public API ${newVal === 1 ? 'enabled' : 'disabled'} for ${org.display_name}`);
      fetchOrgs();
    } catch (err) {
      message.error('Failed to update API setting');
    }
  };

  const columns = [
    {
      title: 'Organization',
      dataIndex: 'display_name',
      key: 'display_name',
    },
    {
      title: 'Database',
      dataIndex: 'db_name',
      key: 'db_name',
      render: (v) => <code>{v}</code>,
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      render: (status, record) => (
        <Switch
          checked={Number(status) === 1}
          checkedChildren="Active"
          unCheckedChildren="Disabled"
          onChange={() => handleToggleStatus(record)}
        />
      ),
    },
    {
      title: 'Public API',
      dataIndex: 'public_api_enabled',
      key: 'public_api_enabled',
      render: (val, record) => (
        <Switch
          checked={Number(val) === 1}
          checkedChildren="On"
          unCheckedChildren="Off"
          onChange={() => handleToggleApi(record)}
          size="small"
        />
      ),
    },
    {
      title: 'Created',
      dataIndex: 'created_at',
      key: 'created_at',
      render: (v) => v ? dayjs(v).format('MMM D, YYYY') : '-',
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>Organizations</h2>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={fetchOrgs}>Refresh</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => router.push('/master/organizations/create')}>
            Create Organization
          </Button>
        </Space>
      </div>
      <Card>
        <Table
          columns={columns}
          dataSource={orgs}
          rowKey="id"
          loading={loading}
          pagination={false}
        />
      </Card>
    </div>
  );
}
