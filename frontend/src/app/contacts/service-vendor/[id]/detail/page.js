'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import {
  Button, Tabs, Table, message, Avatar, Spin,
} from 'antd';
import { UserOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import MainLayout, { useAuth } from '../../../../../components/Layout';
import { contact } from '../../../../../lib/api';

const STATUS_MAP = {
  0: { label: 'Pending' },
  1: { label: 'In Progress' },
  2: { label: 'Completed' },
};

const STATUS_TABS = [
  { key: 'all', label: 'ALL' },
  { key: '0', label: 'Pending' },
  { key: '1', label: 'In Progress' },
  { key: '2', label: 'Completed' },
];

// ---------------------------------------------------------------------------
// Field / Value row for the profile grid
// ---------------------------------------------------------------------------
function FieldRow({ label, value, style }) {
  return (
    <div style={{ padding: '12px 0', borderBottom: '1px solid #f5f5f5', ...style }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: '#d4830d', textTransform: 'uppercase', marginBottom: 2, letterSpacing: 0.5 }}>
        {label}
      </div>
      <div style={{ fontSize: 14, color: '#333' }}>{value || '—'}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Detail Page
// ---------------------------------------------------------------------------
export default function ServiceVendorDetailPage() {
  const [vendor, setVendor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [services, setServices] = useState([]);
  const [servicesLoading, setServicesLoading] = useState(false);
  const [servicesPagination, setServicesPagination] = useState({ current: 1, pageSize: 10, total: 0 });
  const [serviceStatusFilter, setServiceStatusFilter] = useState('all');
  const [activeTab, setActiveTab] = useState('profile');
  const router = useRouter();
  const params = useParams();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission ? hasPermission('LANDLORD/SERVICE_VENDOR_EDIT') : false;
  const canDelete = hasPermission ? hasPermission('LANDLORD/SERVICE_VENDOR_DELETE') : false;
  const vendorId = params.id;

  useEffect(() => {
    loadVendor();
  }, [vendorId]);

  useEffect(() => {
    if (activeTab === 'service') loadServices(servicesPagination.current);
  }, [activeTab, servicesPagination.current, serviceStatusFilter]);

  const loadVendor = async () => {
    try {
      const response = await contact.getServiceVendor(vendorId);
      if (response.data.code === 200) {
        setVendor(response.data.data);
      }
    } catch (error) {
      message.error('Failed to load service vendor');
    } finally {
      setLoading(false);
    }
  };

  const loadServices = async (page) => {
    setServicesLoading(true);
    try {
      const body = {};
      if (serviceStatusFilter !== 'all') body.status = Number(serviceStatusFilter);
      const response = await contact.getVendorServices(vendorId, body, { page, limit: servicesPagination.pageSize });
      if (response.data.code === 200) {
        setServices(response.data.data.content || []);
        setServicesPagination(prev => ({ ...prev, current: page, total: response.data.data.totalElements || 0 }));
      }
    } catch (error) {
      console.error('Failed to load services:', error);
    } finally {
      setServicesLoading(false);
    }
  };

  const handleDelete = async () => {
    try {
      const response = await contact.deleteServiceVendor(vendorId);
      if (response.data.code === 200) {
        message.success('Service vendor deleted');
        router.push('/contacts/service-vendors');
      }
    } catch (error) {
      message.error('Failed to delete service vendor');
    }
  };

  if (loading) {
    return (
      <MainLayout>
        <div style={{ padding: 48, textAlign: 'center' }}><Spin size="large" /></div>
      </MainLayout>
    );
  }

  const vendorName = vendor ? [vendor.first_name, vendor.last_name].filter(Boolean).join(' ') : '';
  const vendorStatus = Number(vendor?.status ?? 0);
  const vendorSex = Number(vendor?.sex ?? 0);

  // Calculate age from birth_date
  const calcAge = () => {
    if (!vendor?.birth_date) return null;
    const birth = dayjs(vendor.birth_date);
    if (!birth.isValid()) return null;
    return dayjs().diff(birth, 'year');
  };
  const age = calcAge();

  // ─── Profile Tab ───────────────────────────────────────────────────────────

  const profileContent = (
    <div style={{ display: 'flex', gap: 24 }}>
      {/* Left sidebar — avatar + name + status */}
      <div style={{ width: 340, flexShrink: 0 }}>
        <div style={{ textAlign: 'center', padding: '40px 20px 20px' }}>
          <Avatar size={160} icon={<UserOutlined />} style={{ backgroundColor: '#f0f0f0', marginBottom: 20 }} />
          <div style={{ fontSize: 18, fontWeight: 600 }}>{vendorName}</div>
          <div style={{ fontSize: 13, color: '#888', marginBottom: 16 }}>{vendor?.email || ''}</div>
          <div style={{
            background: vendorStatus === 1 ? '#1890ff' : '#999',
            color: '#fff', padding: '8px 0', borderRadius: 4, fontWeight: 600,
          }}>
            {vendorStatus === 1 ? 'Active' : 'Inactive'}
          </div>
        </div>
      </div>

      {/* Right content — General Info + Additional Info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* General Information */}
        <div style={{
          background: '#fff', border: '1px solid #f0f0f0', borderRadius: 8,
          padding: '20px 24px', marginBottom: 16,
        }}>
          <div style={{
            fontWeight: 700, fontSize: 13, color: '#555', textTransform: 'uppercase',
            marginBottom: 12, letterSpacing: 0.5,
          }}>
            General Information
          </div>

          {/* Row: First Name / Last Name */}
          <div style={{ display: 'flex', gap: 24 }}>
            <div style={{ flex: 1 }}><FieldRow label="First Name" value={vendor?.first_name} /></div>
            <div style={{ flex: 1 }}><FieldRow label="Last Name" value={vendor?.last_name} /></div>
          </div>

          {/* Row: Date of Birth / Age / Gender */}
          <div style={{ display: 'flex', gap: 24 }}>
            <div style={{ flex: 1 }}>
              <FieldRow label="Date of Birth" value={vendor?.birth_date ? dayjs(vendor.birth_date).format('YYYY-MM-DD') : null} />
            </div>
            <div style={{ flex: 1 }}>
              <FieldRow label="Age" value={age != null ? String(age) : null} />
            </div>
            <div style={{ flex: 1 }}>
              <FieldRow label="Gender" value={vendorSex === 1 ? 'MALE' : vendorSex === 2 ? 'FEMALE' : null} />
            </div>
          </div>

          {/* Row: Email / Phone */}
          <div style={{ display: 'flex', gap: 24 }}>
            <div style={{ flex: 1 }}><FieldRow label="Email" value={vendor?.email} /></div>
            <div style={{ flex: 1 }}><FieldRow label="Phone" value={vendor?.phone} /></div>
          </div>

          {/* Row: ID / Passport */}
          <div style={{ display: 'flex', gap: 24 }}>
            <div style={{ flex: 1 }}><FieldRow label="ID / Passport" value={vendor?.id_card} /></div>
          </div>
        </div>

        {/* Additional Information */}
        <div style={{
          background: '#fff', border: '1px solid #f0f0f0', borderRadius: 8,
          padding: '20px 24px',
        }}>
          <div style={{
            fontWeight: 700, fontSize: 13, color: '#555', textTransform: 'uppercase',
            marginBottom: 12, letterSpacing: 0.5,
          }}>
            Additional Information
          </div>
          <FieldRow label="Notes" value={vendor?.notes} />
          <FieldRow label="Attachments" value={null} style={{ borderBottom: 'none' }} />
        </div>
      </div>
    </div>
  );

  // ─── Service Tab ───────────────────────────────────────────────────────────

  // Helper: format datetime range like "Feb 27, 2020 11:25 - 11:30"
  const fmtDateRange = (start, end) => {
    if (!start) return '';
    const s = dayjs(start);
    if (!s.isValid()) return '';
    const datePart = s.format('MMM DD, YYYY');
    const startTime = s.format('HH:mm');
    if (!end) return `${datePart} ${startTime}`;
    const e = dayjs(end);
    if (!e.isValid()) return `${datePart} ${startTime}`;
    const endTime = e.format('HH:mm');
    return `${datePart} ${startTime} - ${endTime}`;
  };

  const serviceColumns = [
    {
      title: 'ID', dataIndex: 'code', key: 'code', width: 80, sorter: true,
      render: (v) => <span style={{ color: '#1890ff' }}>{v}</span>,
    },
    {
      title: 'Submission Date', dataIndex: 'created_at', key: 'created_at', width: 170, sorter: true,
      render: (v) => v ? dayjs(v).format('YYYY-MM-DD HH:mm:ss') : '-',
    },
    {
      title: 'Property Name', key: 'property_name', width: 170,
      render: (_, r) => {
        const prop = r.property_name || '';
        const unit = r.unit_name || '';
        return prop && unit ? `${prop} / ${unit}` : prop || unit || '-';
      },
    },
    {
      title: 'Status', dataIndex: 'status', key: 'status', width: 100,
      render: (v) => (STATUS_MAP[Number(v)] || { label: 'Unknown' }).label,
    },
    {
      title: 'Category', dataIndex: 'category', key: 'category', width: 150, sorter: true,
      render: (v) => v ? v.toUpperCase() : '-',
    },
    {
      title: 'Preferred Date', key: 'preferred_date', width: 210, sorter: true,
      render: (_, r) => fmtDateRange(r.preferred_date_first_start, r.preferred_date_first_end) || '-',
    },
    {
      title: 'Optional Date', key: 'optional_date', width: 210, sorter: true,
      render: (_, r) => fmtDateRange(r.preferred_date_second_start, r.preferred_date_second_end) || '-',
    },
    {
      title: 'Tenant', dataIndex: 'tenant_name', key: 'tenant_name', width: 140,
      render: (v) => v && v.trim() ? v.trim() : '',
    },
    {
      title: 'Contact Phone', dataIndex: 'tenant_phone', key: 'tenant_phone', width: 130,
      render: (v) => v || '',
    },
    {
      title: 'Action', key: 'action', width: 70, fixed: 'right',
      render: (_, r) => <a style={{ color: '#1890ff' }} onClick={() => router.push(`/service/${r.id}/detail`)}>View</a>,
    },
  ];

  const serviceContent = (
    <div>
      {/* Total count bar */}
      <div style={{
        background: '#fff', border: '1px solid #f0f0f0', borderRadius: '8px 8px 0 0',
        padding: '12px 20px', fontWeight: 500,
      }}>
        <span style={{ color: '#1890ff', fontSize: 16, fontWeight: 700, marginRight: 6 }}>{servicesPagination.total}</span>
        Total
      </div>

      {/* Status tabs: ALL | Pending | In Progress | Completed */}
      <div style={{
        background: '#fafafa', border: '1px solid #f0f0f0', borderTop: 'none',
        padding: '8px 20px', display: 'flex', gap: 20,
      }}>
        {STATUS_TABS.map(tab => (
          <span
            key={tab.key}
            onClick={() => { setServiceStatusFilter(tab.key); setServicesPagination(prev => ({ ...prev, current: 1 })); }}
            style={{
              cursor: 'pointer', fontSize: 13, fontWeight: 500,
              color: serviceStatusFilter === tab.key ? '#1890ff' : '#888',
              borderBottom: serviceStatusFilter === tab.key ? '2px solid #1890ff' : '2px solid transparent',
              paddingBottom: 4,
            }}
          >
            {tab.label}
          </span>
        ))}
      </div>

      <Table
        columns={serviceColumns}
        dataSource={services}
        rowKey="id"
        loading={servicesLoading}
        pagination={{
          current: servicesPagination.current,
          pageSize: servicesPagination.pageSize,
          total: servicesPagination.total,
          showSizeChanger: true,
          pageSizeOptions: ['10', '20', '50'],
          onChange: (page, pageSize) => {
            setServicesPagination(prev => ({ ...prev, current: page, pageSize }));
          },
        }}
        scroll={{ x: 1500 }}
        locale={{ emptyText: 'No service orders found' }}
        size="small"
        style={{ borderTop: 'none' }}
      />
    </div>
  );

  // ─── Tab Config ────────────────────────────────────────────────────────────

  const tabItems = [
    { key: 'profile', label: 'Profile', children: profileContent },
    { key: 'service', label: 'Service', children: serviceContent },
  ];

  return (
    <MainLayout>
      {/* Header: title + action buttons */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h1 style={{ margin: 0 }}>Profile</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          {canDelete && <Button onClick={handleDelete}>Delete</Button>}
          {canEdit && <Button onClick={() => router.push(`/contacts/service-vendor/${vendorId}/edit`)}>Edit</Button>}
        </div>
      </div>

      {/* Tabs */}
      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={tabItems}
      />
    </MainLayout>
  );
}
