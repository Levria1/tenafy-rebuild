'use client';

import { Suspense, useEffect, useState, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Input, Button, Space, Avatar, Empty, Spin, Pagination, Badge,
  Typography, Tooltip, Popover, Radio, Select, message, Card, Tag,
} from 'antd';
import {
  PlusOutlined, SearchOutlined, UserOutlined, MailOutlined,
  FileTextOutlined, DollarOutlined, ProfileOutlined, FilterOutlined,
  SendOutlined, RightOutlined, EllipsisOutlined,
} from '@ant-design/icons';
import MainLayout from '../../../components/Layout';
import useIsMobile from '../../../hooks/useIsMobile';
import { tenant, property } from '../../../lib/api';

const { Text, Title } = Typography;

// ---------------------------------------------------------------------------
// Tenant row component matching the original Tenafy layout
// ---------------------------------------------------------------------------
function TenantRow({ data, onEmail, onInvoice, onInvite, onProfile }) {
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
      {/* Avatar */}
      <Avatar size={44} icon={<UserOutlined />} style={{ backgroundColor: '#e6f4ff', flexShrink: 0 }} />

      {/* Name + email */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <Text strong style={{ fontSize: 14, cursor: 'pointer' }} onClick={onProfile}>
          {data.first_name} {data.last_name}
        </Text>
        <div>
          {data.email && <Text type="secondary" style={{ fontSize: 12 }}>{data.email}</Text>}
        </div>
      </div>

      {/* Tenant status icon - green if active lease, grey if not */}
      <div style={{ textAlign: 'center', cursor: 'pointer' }} onClick={onProfile}>
        <div style={{
          width: 36, height: 36, borderRadius: '50%',
          background: hasLease ? '#f6ffed' : '#f5f5f5',
          border: `2px solid ${hasLease ? '#52c41a' : '#d9d9d9'}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          margin: '0 auto 2px',
        }}>
          <UserOutlined style={{ fontSize: 16, color: hasLease ? '#52c41a' : '#bbb' }} />
        </div>
        <span style={{ fontSize: 10, fontWeight: 600, color: '#888' }}>TENANT</span>
      </div>

      {/* Rent icon */}
      <div style={{ textAlign: 'center', cursor: 'pointer' }} onClick={() => onProfile()}>
        <div style={{
          width: 36, height: 36, borderRadius: '50%',
          background: '#f6ffed', border: '2px solid #52c41a',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          margin: '0 auto 2px',
        }}>
          <DollarOutlined style={{ fontSize: 16, color: '#52c41a' }} />
        </div>
        <span style={{ fontSize: 10, fontWeight: 600, color: '#888' }}>RENT</span>
      </div>

      {/* Lease icon */}
      <div style={{ textAlign: 'center', cursor: 'pointer' }} onClick={() => onProfile()}>
        <div style={{
          width: 36, height: 36, borderRadius: '50%',
          background: '#f0f5ff', border: '2px solid #597ef7',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          margin: '0 auto 2px',
        }}>
          <FileTextOutlined style={{ fontSize: 16, color: '#597ef7' }} />
        </div>
        <span style={{ fontSize: 10, fontWeight: 600, color: '#888' }}>LEASE</span>
      </div>

      {/* Action buttons for some rows */}
      <Space size={6} style={{ flexShrink: 0 }}>
        <Button size="small" onClick={onEmail}>Email</Button>
        <Button size="small" onClick={onInvoice}>+ Invoice</Button>
        <Button size="small" onClick={onInvite}>Invite</Button>
      </Space>

      {/* Profile arrow */}
      <div style={{ cursor: 'pointer', color: '#888', flexShrink: 0 }} onClick={onProfile}>
        <span style={{ fontSize: 13 }}>Profile</span>
        <span style={{ marginLeft: 4 }}>›</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mobile tenant card component
// ---------------------------------------------------------------------------
function MobileTenantRow({ data, onEmail, onInvoice, onInvite, onProfile }) {
  const [expanded, setExpanded] = useState(false);
  const hasLease = data.has_active_lease === 1 || data.has_active_lease === true;

  return (
    <Card
      size="small"
      style={{ marginBottom: 8, borderRadius: 8 }}
      bodyStyle={{ padding: '12px 14px' }}
      onClick={() => setExpanded(!expanded)}
    >
      {/* Top row: avatar + name + status */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <Avatar size={40} icon={<UserOutlined />} style={{ backgroundColor: '#e6f4ff', flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Text strong style={{ fontSize: 14 }}>
              {data.first_name} {data.last_name}
            </Text>
            <Tag
              color={hasLease ? 'green' : 'default'}
              style={{ fontSize: 10, lineHeight: '18px', margin: 0 }}
            >
              {hasLease ? 'Active' : 'Inactive'}
            </Tag>
          </div>
          {data.email && (
            <Text type="secondary" style={{ fontSize: 12, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {data.email}
            </Text>
          )}
        </div>
        <RightOutlined style={{ color: '#bbb', fontSize: 12, flexShrink: 0, transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s' }} />
      </div>

      {/* Expanded actions */}
      {expanded && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid #f0f0f0' }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button size="small" icon={<UserOutlined />} onClick={(e) => { e.stopPropagation(); onProfile(); }}>
              Profile
            </Button>
            <Button size="small" icon={<MailOutlined />} onClick={(e) => { e.stopPropagation(); onEmail(); }}>
              Email
            </Button>
            <Button size="small" icon={<DollarOutlined />} onClick={(e) => { e.stopPropagation(); onInvoice(); }}>
              + Invoice
            </Button>
            <Button size="small" icon={<SendOutlined />} onClick={(e) => { e.stopPropagation(); onInvite(); }}>
              Invite
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Main Tenants page
// ---------------------------------------------------------------------------
export default function TenantsPageWrapper() {
  return <Suspense fallback={<div />}><TenantsPage /></Suspense>;
}

function TenantsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const propertyIdParam = searchParams.get('propertyId');
  const { isMobile } = useIsMobile();

  const [tenants, setTenants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [pagination, setPagination] = useState({ current: 1, pageSize: 20, total: 0 });

  // Filters
  const [filterVisible, setFilterVisible] = useState(false);
  const [tenantStatus, setTenantStatus] = useState(null);     // null=all, 'active', 'inactive'
  const [leaseStatus, setLeaseStatus] = useState(null);        // null=all, 'active', 'inactive'
  const [leaseType, setLeaseType] = useState(null);            // null=all, 'fixed', 'month-to-month'
  const [propertyFilter, setPropertyFilter] = useState(propertyIdParam || null);
  const [unitFilter, setUnitFilter] = useState(null);

  // Property + unit dropdowns
  const [propertiesWithUnits, setPropertiesWithUnits] = useState([]);

  // Count active filters
  const filterCount = [tenantStatus, leaseStatus, leaseType, propertyFilter].filter(Boolean).length;

  useEffect(() => {
    loadPropertiesWithUnits();
  }, []);

  const loadPropertiesWithUnits = async () => {
    try {
      const res = await property.getAllWithUnits();
      if (res.data.code === 200) {
        setPropertiesWithUnits(res.data.data || []);
      }
    } catch (err) {
      console.error('Failed to load properties:', err);
    }
  };

  const loadData = useCallback(async (page = 1) => {
    try {
      setLoading(true);
      const body = {};
      if (search) body.search = search;
      if (tenantStatus) body.tenantStatus = tenantStatus;
      if (leaseStatus) body.leaseFilter = leaseStatus;
      if (leaseType) body.leaseType = leaseType;
      if (propertyFilter) body.propertyId = propertyFilter;
      if (unitFilter) body.unitId = unitFilter;

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
  }, [search, tenantStatus, leaseStatus, leaseType, propertyFilter, unitFilter]);

  useEffect(() => { loadData(); }, [loadData]);

  const handleEmail = (t) => {
    router.push(`/contacts/email/send?category=tenant&id=${t.id}`);
  };

  const handleInvoice = (t) => {
    router.push(`/invoices/create?tenantId=${t.id}&tenantName=${encodeURIComponent(t.first_name + ' ' + t.last_name)}`);
  };

  const handleInvite = (t) => {
    message.info('Invite feature coming soon');
  };

  const handleProfile = (t) => {
    router.push(`/contacts/tenant/${t.id}/detail`);
  };

  const handleEmailAll = () => {
    router.push('/contacts/email/send?category=tenants');
  };

  const resetFilters = () => {
    setTenantStatus(null);
    setLeaseStatus(null);
    setLeaseType(null);
    setPropertyFilter(null);
    setUnitFilter(null);
  };

  // Get units for selected property
  const selectedProp = propertiesWithUnits.find(p => p.id?.toString() === propertyFilter?.toString());
  const unitOptions = selectedProp?.units || [];

  // Filter popover content matching the original layout
  const filterContent = (
    <div style={{ width: 280, padding: 8 }}>
      {/* Tenant Status */}
      <div style={{ fontWeight: 600, marginBottom: 8 }}>Tenant Status</div>
      <Radio.Group
        value={tenantStatus}
        onChange={(e) => setTenantStatus(e.target.value)}
        style={{ marginBottom: 16 }}
      >
        <Radio value={null}>All</Radio>
        <Radio value="active">Active</Radio>
        <Radio value="inactive">Inactive</Radio>
      </Radio.Group>

      {/* Lease Status */}
      <div style={{ fontWeight: 600, marginBottom: 8 }}>Lease Status</div>
      <Radio.Group
        value={leaseStatus}
        onChange={(e) => setLeaseStatus(e.target.value)}
        style={{ marginBottom: 16 }}
      >
        <Radio value={null}>All</Radio>
        <Radio value="active">Active</Radio>
        <Radio value="inactive">Inactive</Radio>
      </Radio.Group>

      {/* Lease Type */}
      <div style={{ fontWeight: 600, marginBottom: 8 }}>Lease Type</div>
      <Radio.Group
        value={leaseType}
        onChange={(e) => setLeaseType(e.target.value)}
        style={{ marginBottom: 16 }}
      >
        <Radio value={null}>All</Radio>
        <Radio value="fixed">Fixed</Radio>
        <Radio value="month-to-month">Month-to-Month</Radio>
      </Radio.Group>

      {/* Property & Units */}
      <div style={{ fontWeight: 600, marginBottom: 8 }}>Property & Units</div>
      <Select
        placeholder="All Property"
        value={propertyFilter}
        onChange={(v) => { setPropertyFilter(v); setUnitFilter(null); }}
        allowClear
        style={{ width: '100%', marginBottom: 16 }}
        options={propertiesWithUnits.map(p => ({ value: p.id?.toString(), label: p.display_name }))}
      />

      {/* Buttons */}
      <div style={{ display: 'flex', gap: 8 }}>
        <Button type="primary" size="small" danger onClick={() => { resetFilters(); }}>
          Reset
        </Button>
        <Button size="small" onClick={() => setFilterVisible(false)}>
          Close
        </Button>
      </div>
    </div>
  );

  return (
    <MainLayout>
      {/* Page title */}
      <h1 style={{ marginBottom: 16 }}>Tenants</h1>

      {/* Top bar: total, search, filter, email all, add tenant */}
      {isMobile ? (
        <div style={{
          background: '#fff', border: '1px solid #e8e8e8', borderRadius: 8, padding: '12px 14px',
          marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 10,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ fontWeight: 500, fontSize: 15 }}>
              <span style={{ color: '#1890ff', fontSize: 18, fontWeight: 700, marginRight: 6 }}>{pagination.total}</span>
              Total
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <Button type="primary" icon={<PlusOutlined />} size="small" onClick={() => router.push('/contacts/tenant/create')}>
                Add
              </Button>
              <Button icon={<MailOutlined />} size="small" onClick={handleEmailAll} />
            </div>
          </div>
          <Input
            placeholder="Search tenants..."
            prefix={<SearchOutlined style={{ color: '#bbb' }} />}
            style={{ width: '100%' }}
            allowClear
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onPressEnter={() => loadData(1)}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <Popover content={filterContent} trigger="click" open={filterVisible} onOpenChange={setFilterVisible} placement="bottomRight">
              <Badge count={filterCount} size="small" offset={[-4, 0]}>
                <Button icon={<FilterOutlined />} size="small" block>Filter</Button>
              </Badge>
            </Popover>
          </div>
        </div>
      ) : (
        <div style={{
          background: '#fff', border: '1px solid #e8e8e8', borderRadius: 8, padding: '12px 20px',
          marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div style={{ fontWeight: 500, fontSize: 15 }}>
            <span style={{ color: '#1890ff', fontSize: 18, fontWeight: 700, marginRight: 6 }}>{pagination.total}</span>
            Total
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Input
              placeholder="Type here to search"
              prefix={<SearchOutlined style={{ color: '#bbb' }} />}
              style={{ width: 220 }}
              allowClear
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onPressEnter={() => loadData(1)}
            />
            <Popover content={filterContent} trigger="click" open={filterVisible} onOpenChange={setFilterVisible} placement="bottomRight">
              <Badge count={filterCount} size="small" offset={[-4, 0]}>
                <Button icon={<FilterOutlined />}>Filter</Button>
              </Badge>
            </Popover>
            <Button icon={<MailOutlined />} onClick={handleEmailAll}>
              Email All
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => router.push('/contacts/tenant/create')}>
              + Add Tenant
            </Button>
          </div>
        </div>
      )}

      {/* Tenant list */}
      {isMobile ? (
        <div>
          {loading ? (
            <div style={{ padding: 48, textAlign: 'center' }}><Spin size="large" /></div>
          ) : tenants.length === 0 ? (
            <Empty description="No tenants found" style={{ padding: 48 }} />
          ) : (
            <>
              {tenants.map((t) => (
                <MobileTenantRow
                  key={t.id}
                  data={t}
                  onEmail={() => handleEmail(t)}
                  onInvoice={() => handleInvoice(t)}
                  onInvite={() => handleInvite(t)}
                  onProfile={() => handleProfile(t)}
                />
              ))}
              {pagination.total > pagination.pageSize && (
                <div style={{ padding: '12px 0', textAlign: 'center' }}>
                  <Pagination
                    current={pagination.current}
                    total={pagination.total}
                    pageSize={pagination.pageSize}
                    onChange={(page) => loadData(page)}
                    size="small"
                    simple
                    showSizeChanger={false}
                  />
                </div>
              )}
            </>
          )}
        </div>
      ) : (
        <div style={{ background: '#fff', border: '1px solid #e8e8e8', borderRadius: 8 }}>
          {loading ? (
            <div style={{ padding: 48, textAlign: 'center' }}><Spin size="large" /></div>
          ) : tenants.length === 0 ? (
            <Empty description="No tenants found" style={{ padding: 48 }} />
          ) : (
            <>
              {tenants.map((t) => (
                <TenantRow
                  key={t.id}
                  data={t}
                  onEmail={() => handleEmail(t)}
                  onInvoice={() => handleInvoice(t)}
                  onInvite={() => handleInvite(t)}
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
        </div>
      )}
    </MainLayout>
  );
}
