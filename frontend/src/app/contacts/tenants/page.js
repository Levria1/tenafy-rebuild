'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  Card, Input, Button, Space, Tag, Avatar, Empty, Spin, Pagination,
  Typography, Tooltip, Select, Modal, message,
} from 'antd';
import {
  PlusOutlined, SearchOutlined, UserOutlined, MailOutlined,
  FileTextOutlined, DollarOutlined, ProfileOutlined,
  SendOutlined, CheckCircleFilled, CloseCircleFilled,
} from '@ant-design/icons';
import MainLayout from '../../../components/Layout';
import { tenant } from '../../../lib/api';

const { Text, Title } = Typography;

function TenantCard({ data, onEmail, onInvoice, onRent, onLease, onProfile }) {
  const hasLease = data.has_active_lease === 1 || data.has_active_lease === true;

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      padding: '14px 20px',
      borderBottom: '1px solid #f0f0f0',
      gap: 16,
      transition: 'background 0.2s',
    }}
    onMouseEnter={(e) => e.currentTarget.style.background = '#fafafa'}
    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
    >
      {/* Status indicator + Avatar */}
      <div style={{ position: 'relative' }}>
        <Avatar size={44} icon={<UserOutlined />} style={{ backgroundColor: '#e6f4ff' }} />
        <Tooltip title={hasLease ? 'Active Lease' : 'No Active Lease'}>
          {hasLease ? (
            <CheckCircleFilled style={{
              position: 'absolute', bottom: -2, right: -2,
              fontSize: 16, color: '#52c41a',
              background: '#fff', borderRadius: '50%',
            }} />
          ) : (
            <CloseCircleFilled style={{
              position: 'absolute', bottom: -2, right: -2,
              fontSize: 16, color: '#ff4d4f',
              background: '#fff', borderRadius: '50%',
            }} />
          )}
        </Tooltip>
      </div>

      {/* Name + Details */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
          <Text strong style={{ fontSize: 14, cursor: 'pointer' }} onClick={onProfile}>
            {data.first_name} {data.last_name}
          </Text>
          {hasLease && (
            <Tag color="green" style={{ fontSize: 11, lineHeight: '18px', margin: 0 }}>Active Lease</Tag>
          )}
        </div>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          {data.email && <Text type="secondary" style={{ fontSize: 12 }}>{data.email}</Text>}
          {data.phone && <Text type="secondary" style={{ fontSize: 12 }}>{data.phone}</Text>}
          {data.property_name && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {data.property_name}{data.unit_name ? ` — ${data.unit_name}` : ''}
            </Text>
          )}
        </div>
      </div>

      {/* Outstanding amount */}
      {data.outstanding_amount > 0 && (
        <div style={{ textAlign: 'right', marginRight: 8 }}>
          <Text type="danger" style={{ fontSize: 13, fontWeight: 600 }}>
            ${Number(data.outstanding_amount).toLocaleString(undefined, { minimumFractionDigits: 2 })}
          </Text>
          <br />
          <Text type="secondary" style={{ fontSize: 11 }}>Outstanding</Text>
        </div>
      )}

      {/* Action buttons */}
      <Space size={4}>
        <Tooltip title="Email">
          <Button type="text" size="small" icon={<MailOutlined />} onClick={onEmail}
            style={{ color: '#1677ff' }} />
        </Tooltip>
        <Tooltip title="Add Invoice">
          <Button type="text" size="small" icon={<FileTextOutlined />} onClick={onInvoice}
            style={{ color: '#722ed1' }} />
        </Tooltip>
        <Tooltip title="Rent Payments">
          <Button type="text" size="small" icon={<DollarOutlined />} onClick={onRent}
            style={{ color: '#52c41a' }} />
        </Tooltip>
        <Tooltip title="Lease">
          <Button type="text" size="small" icon={<ProfileOutlined />} onClick={onLease}
            style={{ color: '#fa8c16' }} />
        </Tooltip>
        <Tooltip title="Profile">
          <Button type="text" size="small" icon={<UserOutlined />} onClick={onProfile}
            style={{ color: '#595959' }} />
        </Tooltip>
      </Space>
    </div>
  );
}

export default function TenantsPage() {
  const router = useRouter();
  const [tenants, setTenants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [leaseFilter, setLeaseFilter] = useState(undefined);
  const [pagination, setPagination] = useState({ current: 1, pageSize: 20, total: 0 });

  const loadData = useCallback(async (page = 1) => {
    try {
      setLoading(true);
      const body = {};
      if (search) body.search = search;
      if (leaseFilter) body.leaseFilter = leaseFilter;

      const res = await tenant.list(body, { page, limit: 20 });
      if (res.data.code === 200) {
        setTenants(res.data.data.content || []);
        setPagination(prev => ({
          ...prev,
          current: page,
          total: res.data.data.totalElements || 0,
        }));
      }
    } catch (err) {
      console.error('Failed to load tenants:', err);
    } finally {
      setLoading(false);
    }
  }, [search, leaseFilter]);

  useEffect(() => { loadData(); }, [loadData]);

  const handleEmail = (t) => {
    router.push(`/contacts/email/send?to=${encodeURIComponent(t.email)}&name=${encodeURIComponent(t.first_name + ' ' + t.last_name)}`);
  };

  const handleInvoice = (t) => {
    router.push(`/invoices/create?tenantId=${t.id}&tenantName=${encodeURIComponent(t.first_name + ' ' + t.last_name)}`);
  };

  const handleRent = (t) => {
    router.push(`/contacts/tenant/${t.id}/detail?tab=accounting&status=1`);
  };

  const handleLease = (t) => {
    router.push(`/contacts/tenant/${t.id}/detail?tab=leases`);
  };

  const handleProfile = (t) => {
    router.push(`/contacts/tenant/${t.id}/detail`);
  };

  return (
    <MainLayout>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <Title level={4} style={{ margin: 0 }}>Tenants</Title>
          <Text type="secondary">{pagination.total} tenant{pagination.total !== 1 ? 's' : ''} with lease history</Text>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => router.push('/contacts/tenant/create')}>
          Add Tenant
        </Button>
      </div>

      {/* Filters */}
      <Card bodyStyle={{ padding: '12px 16px' }} style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <Input
            placeholder="Search by name, email, phone..."
            prefix={<SearchOutlined />}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onPressEnter={() => loadData(1)}
            style={{ width: 300 }}
            allowClear
          />
          <Select
            placeholder="Lease Status"
            value={leaseFilter}
            onChange={(v) => setLeaseFilter(v)}
            allowClear
            style={{ width: 160 }}
            options={[
              { value: 'active', label: 'Active Lease' },
              { value: 'inactive', label: 'No Active Lease' },
            ]}
          />
          <Button onClick={() => loadData(1)}>Search</Button>
        </div>
      </Card>

      {/* Tenant list */}
      <Card bodyStyle={{ padding: 0 }}>
        {loading ? (
          <div style={{ padding: 48, textAlign: 'center' }}><Spin size="large" /></div>
        ) : tenants.length === 0 ? (
          <Empty description="No tenants found" style={{ padding: 48 }} />
        ) : (
          <>
            {tenants.map((t) => (
              <TenantCard
                key={t.id}
                data={t}
                onEmail={() => handleEmail(t)}
                onInvoice={() => handleInvoice(t)}
                onRent={() => handleRent(t)}
                onLease={() => handleLease(t)}
                onProfile={() => handleProfile(t)}
              />
            ))}
            {pagination.total > pagination.pageSize && (
              <div style={{ padding: '16px', textAlign: 'center' }}>
                <Pagination
                  current={pagination.current}
                  total={pagination.total}
                  pageSize={pagination.pageSize}
                  onChange={(page) => loadData(page)}
                  showTotal={(total) => `Total ${total} tenants`}
                  showSizeChanger={false}
                />
              </div>
            )}
          </>
        )}
      </Card>
    </MainLayout>
  );
}
