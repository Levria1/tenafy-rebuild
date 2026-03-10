'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
  Input, Button, Space, Avatar, Empty, Spin, Pagination, Badge,
  Typography, Popover, Radio, Checkbox, message,
} from 'antd';
import {
  PlusOutlined, SearchOutlined, UserOutlined, FilterOutlined,
} from '@ant-design/icons';
import MainLayout from '../../../components/Layout';
import { contact } from '../../../lib/api';

const { Text } = Typography;

// ---------------------------------------------------------------------------
// Vendor row component matching the original Tenafy layout
// ---------------------------------------------------------------------------
function VendorRow({ data, onProfile }) {
  const displayName = [data.first_name, data.last_name].filter(Boolean).join(' ') || data.display_name || '-';
  const subText = data.email || '';

  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', padding: '14px 20px',
        borderBottom: '1px solid #f0f0f0', gap: 16, transition: 'background 0.2s',
        cursor: 'pointer',
      }}
      onMouseEnter={(e) => e.currentTarget.style.background = '#fafafa'}
      onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
      onClick={onProfile}
    >
      {/* Avatar */}
      <Avatar size={44} icon={<UserOutlined />} style={{ backgroundColor: '#e6f4ff', flexShrink: 0 }} />

      {/* Name + email */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <Text strong style={{ fontSize: 14 }}>{displayName}</Text>
        <div>
          {subText && <Text type="secondary" style={{ fontSize: 12 }}>{subText}</Text>}
        </div>
      </div>

      {/* Profile arrow */}
      <div style={{ color: '#888', flexShrink: 0 }}>
        <span style={{ fontSize: 13 }}>Profile</span>
        <span style={{ marginLeft: 4 }}>›</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Search field checkbox options
// ---------------------------------------------------------------------------
const SEARCH_FIELD_OPTIONS = [
  { label: 'Name', value: 'name' },
  { label: 'Email', value: 'email' },
  { label: 'Phone', value: 'phone' },
  { label: 'ID', value: 'idCard' },
];

// ---------------------------------------------------------------------------
// Main Service Vendors page
// ---------------------------------------------------------------------------
export default function ServiceVendorsPage() {
  const router = useRouter();

  const [vendors, setVendors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [searchFields, setSearchFields] = useState([]);
  const [searchDropdownOpen, setSearchDropdownOpen] = useState(false);
  const [pagination, setPagination] = useState({ current: 1, pageSize: 20, total: 0 });

  // Filters
  const [filterVisible, setFilterVisible] = useState(false);
  const [statusFilter, setStatusFilter] = useState(null); // null=all, 1=active, 0=inactive

  const filterCount = statusFilter !== null ? 1 : 0;

  const loadData = useCallback(async (page = 1) => {
    try {
      setLoading(true);
      const body = {};
      if (search) {
        body.search = search;
        if (searchFields.length > 0) body.searchFields = searchFields;
      }
      if (statusFilter !== null) body.status = statusFilter;

      const res = await contact.listServiceVendors(body, { page, limit: pagination.pageSize });
      if (res.data.code === 200) {
        setVendors(res.data.data.content || []);
        setPagination(prev => ({
          ...prev,
          current: page,
          total: res.data.data.totalElements || 0,
        }));
      }
    } catch (err) {
      console.error('Failed to load service vendors:', err);
    } finally {
      setLoading(false);
    }
  }, [search, searchFields, statusFilter, pagination.pageSize]);

  useEffect(() => { loadData(); }, [loadData]);

  const handleProfile = (v) => {
    router.push(`/contacts/service-vendor/${v.id}/detail`);
  };

  const resetFilters = () => {
    setStatusFilter(null);
  };

  // Search field checkbox dropdown
  const searchFieldContent = (
    <div style={{ padding: 4 }}>
      {SEARCH_FIELD_OPTIONS.map(opt => (
        <div key={opt.value} style={{ padding: '4px 0' }}>
          <Checkbox
            checked={searchFields.includes(opt.value)}
            onChange={(e) => {
              setSearchFields(prev =>
                e.target.checked
                  ? [...prev, opt.value]
                  : prev.filter(f => f !== opt.value)
              );
            }}
          >
            {opt.label}
          </Checkbox>
        </div>
      ))}
    </div>
  );

  // Filter popover content
  const filterContent = (
    <div style={{ width: 260, padding: 8 }}>
      <div style={{ fontWeight: 600, marginBottom: 8 }}>Service Vendor Status</div>
      <Radio.Group
        value={statusFilter}
        onChange={(e) => setStatusFilter(e.target.value)}
        style={{ marginBottom: 16 }}
      >
        <Radio value={null}>All</Radio>
        <Radio value={1}>Active</Radio>
        <Radio value={0}>Inactive</Radio>
      </Radio.Group>
      <div style={{ borderTop: '1px solid #f0f0f0', paddingTop: 12, display: 'flex', gap: 8 }}>
        <Button type="primary" size="small" onClick={resetFilters}>
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
      <h1 style={{ marginBottom: 16 }}>Service Vendor</h1>

      {/* Top bar: total, search, filter, add button */}
      <div style={{
        background: '#fff', border: '1px solid #e8e8e8', borderRadius: 8, padding: '12px 20px',
        marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <div style={{ fontWeight: 500, fontSize: 15 }}>
          <span style={{ color: '#1890ff', fontSize: 18, fontWeight: 700, marginRight: 6 }}>{pagination.total}</span>
          Total
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Popover
            content={searchFieldContent}
            trigger="click"
            open={searchDropdownOpen}
            onOpenChange={setSearchDropdownOpen}
            placement="bottomRight"
          >
            <Input
              placeholder="Type here to search"
              prefix={<SearchOutlined style={{ color: '#bbb' }} />}
              style={{ width: 220 }}
              allowClear
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onPressEnter={() => loadData(1)}
              onFocus={() => setSearchDropdownOpen(true)}
            />
          </Popover>
          <Popover content={filterContent} trigger="click" open={filterVisible} onOpenChange={setFilterVisible} placement="bottomRight">
            <Badge count={filterCount} size="small" offset={[-4, 0]}>
              <Button icon={<FilterOutlined />}>Filter</Button>
            </Badge>
          </Popover>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => router.push('/contacts/service-vendor/create')}>
            + Add Service Vendor
          </Button>
        </div>
      </div>

      {/* Vendor list */}
      <div style={{ background: '#fff', border: '1px solid #e8e8e8', borderRadius: 8 }}>
        {loading ? (
          <div style={{ padding: 48, textAlign: 'center' }}><Spin size="large" /></div>
        ) : vendors.length === 0 ? (
          <Empty description="No service vendors found" style={{ padding: 48 }} />
        ) : (
          <>
            {vendors.map((v) => (
              <VendorRow
                key={v.id}
                data={v}
                onProfile={() => handleProfile(v)}
              />
            ))}
            {pagination.total > pagination.pageSize && (
              <div style={{ padding: '16px', textAlign: 'center' }}>
                <Pagination
                  current={pagination.current}
                  total={pagination.total}
                  pageSize={pagination.pageSize}
                  onChange={(page) => loadData(page)}
                  showTotal={(total) => `Total ${total} service vendors`}
                  showSizeChanger={false}
                />
              </div>
            )}
          </>
        )}
      </div>
    </MainLayout>
  );
}
