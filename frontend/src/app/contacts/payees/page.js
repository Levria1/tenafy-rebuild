'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  Input, Button, Space, Avatar, Empty, Spin, Pagination, Badge,
  Typography, Popover, Radio, message,
} from 'antd';
import {
  PlusOutlined, SearchOutlined, UserOutlined, MailOutlined,
  DollarOutlined, FilterOutlined,
} from '@ant-design/icons';
import MainLayout from '../../../components/Layout';
import { contact } from '../../../lib/api';

const { Text } = Typography;

function PayeeRow({ data, onEmail, onInvoice, onProfile }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', padding: '14px 20px',
      borderBottom: '1px solid #f0f0f0', gap: 16, transition: 'background 0.2s',
    }}
    onMouseEnter={(e) => e.currentTarget.style.background = '#fafafa'}
    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
    >
      <Avatar size={44} icon={<UserOutlined />} style={{ backgroundColor: '#f0e6ff', flexShrink: 0 }} />

      <div style={{ flex: 1, minWidth: 0 }}>
        <Text strong style={{ fontSize: 14, cursor: 'pointer' }} onClick={onProfile}>
          {data.first_name} {data.last_name}
        </Text>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          {data.email && <Text type="secondary" style={{ fontSize: 12 }}>{data.email}</Text>}
          {data.phone && <Text type="secondary" style={{ fontSize: 12 }}>{data.phone}</Text>}
          {data.company_name && <Text type="secondary" style={{ fontSize: 12 }}>{data.company_name}</Text>}
        </div>
      </div>

      {data.outstanding_amount > 0 && (
        <div style={{ textAlign: 'right', marginRight: 8 }}>
          <Text type="danger" style={{ fontSize: 13, fontWeight: 600 }}>
            ${Number(data.outstanding_amount).toLocaleString(undefined, { minimumFractionDigits: 2 })}
          </Text>
          <br />
          <Text type="secondary" style={{ fontSize: 11 }}>Outstanding</Text>
        </div>
      )}

      <Space size={6} style={{ flexShrink: 0 }}>
        <Button size="small" onClick={onEmail}>Email</Button>
        <Button size="small" onClick={onInvoice}>+ Invoice</Button>
      </Space>

      <div style={{ cursor: 'pointer', color: '#888', flexShrink: 0 }} onClick={onProfile}>
        <span style={{ fontSize: 13 }}>Profile</span>
        <span style={{ marginLeft: 4 }}>›</span>
      </div>
    </div>
  );
}

export default function PayeesPage() {
  const router = useRouter();
  const [payees, setPayees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [pagination, setPagination] = useState({ current: 1, pageSize: 20, total: 0 });

  const loadData = useCallback(async (page = 1) => {
    try {
      setLoading(true);
      const body = {};
      if (search) body.search = search;

      const res = await contact.listPayees(body, { page, limit: 20 });
      if (res.data.code === 200) {
        setPayees(res.data.data.content || []);
        setPagination(prev => ({
          ...prev,
          current: page,
          total: res.data.data.totalElements || 0,
        }));
      }
    } catch (err) {
      console.error('Failed to load payees:', err);
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => { loadData(); }, [loadData]);

  return (
    <MainLayout>
      <h1 style={{ marginBottom: 16 }}>Payees</h1>

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
          <Button type="primary" icon={<PlusOutlined />} onClick={() => router.push('/contacts/payee/create')}>
            + Add Payee
          </Button>
        </div>
      </div>

      <div style={{ background: '#fff', border: '1px solid #e8e8e8', borderRadius: 8 }}>
        {loading ? (
          <div style={{ padding: 48, textAlign: 'center' }}><Spin size="large" /></div>
        ) : payees.length === 0 ? (
          <Empty description="No payees found" style={{ padding: 48 }} />
        ) : (
          <>
            {payees.map((p) => (
              <PayeeRow
                key={p.id}
                data={p}
                onEmail={() => router.push(`/contacts/email/send?to=${encodeURIComponent(p.email || '')}&name=${encodeURIComponent(p.first_name + ' ' + p.last_name)}`)}
                onInvoice={() => router.push(`/invoices/create?tenantId=${p.id}&tenantName=${encodeURIComponent(p.first_name + ' ' + p.last_name)}`)}
                onProfile={() => router.push(`/contacts/tenant/${p.id}/detail`)}
              />
            ))}
            {pagination.total > pagination.pageSize && (
              <div style={{ padding: '16px', textAlign: 'center' }}>
                <Pagination
                  current={pagination.current}
                  total={pagination.total}
                  pageSize={pagination.pageSize}
                  onChange={(page) => loadData(page)}
                  showTotal={(total) => `Total ${total} payees`}
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
