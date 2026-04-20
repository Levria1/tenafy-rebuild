'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Card, Table, Tag, Space, Button, Input, Select, Typography, message,
  Popconfirm, Tooltip, Alert,
} from 'antd';
import {
  CopyOutlined, ReloadOutlined, StopOutlined, PlusOutlined, SearchOutlined,
  UserAddOutlined, ThunderboltOutlined, CalendarOutlined,
} from '@ant-design/icons';
import MainLayout from '../../../components/Layout';
import useIsMobile from '../../../hooks/useIsMobile';
import MobileCardList from '../../../components/mobile/MobileCardList';
import { viewingApi, user as userApi } from '../../../lib/api';

const { Text, Title } = Typography;

function employeeLabel(emp) {
  if (!emp) return null;
  return [emp.first_name, emp.last_name].filter(Boolean).join(' ') || emp.email || '-';
}

export default function ViewingsOverviewPage() {
  const { isMobile } = useIsMobile();
  const [rows, setRows] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all'); // all | active | not-ready | none
  const [autoGenBusy, setAutoGenBusy] = useState(false);
  const [assigningLinkId, setAssigningLinkId] = useState(null);
  const [regenBusy, setRegenBusy] = useState(null);

  const reload = useCallback(() => {
    setLoading(true);
    viewingApi.overview()
      .then((r) => setRows(r.data.data || []))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, []);

  const loadUsers = useCallback(() => {
    userApi.listUsers({}, { page: 1, limit: 500 })
      .then((r) => setUsers(r?.data?.data?.content || []))
      .catch(() => setUsers([]));
  }, []);

  useEffect(() => { reload(); loadUsers(); }, [reload, loadUsers]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (q) {
        const hay = `${r.unit.name} ${r.property.name} ${r.property.city || ''} ${r.link?.note || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (statusFilter === 'active') return r.link && r.employee;
      if (statusFilter === 'not-ready') return r.link && !r.employee;
      if (statusFilter === 'none') return !r.link;
      return true;
    });
  }, [rows, search, statusFilter]);

  const counts = useMemo(() => {
    const totals = { active: 0, notReady: 0, none: 0 };
    for (const r of rows) {
      if (!r.link) totals.none++;
      else if (!r.employee) totals.notReady++;
      else totals.active++;
    }
    return totals;
  }, [rows]);

  const handleAutoGenerate = async () => {
    setAutoGenBusy(true);
    try {
      const r = await viewingApi.autoGenerate();
      const created = r?.data?.data?.created || 0;
      message.success(created === 0
        ? 'All units already have a link'
        : `${created} link${created > 1 ? 's' : ''} created`);
      reload();
    } catch (e) {
      message.error(e?.response?.data?.message || 'Failed to auto-generate links');
    } finally {
      setAutoGenBusy(false);
    }
  };

  const handleAssignEmployee = async (linkId, employeeId) => {
    setAssigningLinkId(linkId);
    try {
      await viewingApi.assignEmployee(linkId, employeeId);
      message.success(employeeId ? 'Employee assigned' : 'Employee cleared');
      reload();
    } catch (e) {
      message.error(e?.response?.data?.message || 'Failed to update employee');
    } finally {
      setAssigningLinkId(null);
    }
  };

  const handleCopy = async (token) => {
    const url = `${window.location.origin}/book/viewing/${token}`;
    try {
      await navigator.clipboard.writeText(url);
      message.success('Link copied');
    } catch {
      // Browsers block navigator.clipboard on plain HTTP. Works on HTTPS/localhost.
      message.error('Copy failed — clipboard is only available on HTTPS');
    }
  };

  const handleRegenerate = async (unitId) => {
    setRegenBusy(unitId);
    try {
      await viewingApi.regenerateForUnit(unitId);
      message.success('Link regenerated — remember to assign an employee');
      reload();
    } catch (e) {
      message.error(e?.response?.data?.message || 'Failed to regenerate');
    } finally {
      setRegenBusy(null);
    }
  };

  const handleRevoke = async (linkId) => {
    try {
      await viewingApi.revokeLink(linkId);
      message.success('Link revoked');
      reload();
    } catch (e) {
      message.error(e?.response?.data?.message || 'Failed to revoke');
    }
  };

  const userOptions = users.map((u) => ({
    value: String(u.id),
    label: [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || u.username,
  }));

  const columns = [
    {
      title: 'Property',
      key: 'property',
      render: (_, r) => (
        <Link href={`/property/${r.property.id}`}>
          <Text style={{ color: '#1677ff' }}>{r.property.name}</Text>
        </Link>
      ),
    },
    {
      title: 'Unit',
      key: 'unit',
      width: 110,
      render: (_, r) => (
        <Link href={`/property/${r.property.id}/unit/${r.unit.id}`}>
          <Text style={{ color: '#1677ff' }}>{r.unit.name}</Text>
        </Link>
      ),
    },
    {
      title: 'Status',
      key: 'status',
      width: 110,
      render: (_, r) => {
        if (!r.link) return <Tag color="default">No link</Tag>;
        if (!r.employee) return <Tag color="orange">Not ready</Tag>;
        return <Tag color="green">Active</Tag>;
      },
    },
    {
      title: 'Employee',
      key: 'employee',
      width: 240,
      render: (_, r) => {
        if (!r.link) return <Text type="secondary">—</Text>;
        return (
          <Select
            size="small"
            style={{ width: '100%' }}
            placeholder={
              <span style={{ color: '#ff7875' }}>
                <UserAddOutlined /> Assign employee…
              </span>
            }
            value={r.employee ? r.employee.id : undefined}
            onChange={(val) => handleAssignEmployee(r.link.id, val)}
            loading={assigningLinkId === r.link.id}
            allowClear
            showSearch
            optionFilterProp="label"
            options={userOptions}
          />
        );
      },
    },
    {
      title: 'Bookings',
      key: 'bookings',
      width: 110,
      render: (_, r) => {
        if (!r.total_bookings) return <Text type="secondary">0</Text>;
        return (
          <span>
            {r.total_bookings}
            {r.pending_bookings > 0 && (
              <Tag color="gold" style={{ marginLeft: 6 }}>{r.pending_bookings} pending</Tag>
            )}
          </span>
        );
      },
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 340,
      render: (_, r) => (
        <Space size="small" wrap={false}>
          {r.link ? (
            <>
              <Tooltip title={!r.employee ? 'Assign an employee before sharing' : ''}>
                <Button
                  size="small"
                  icon={<CopyOutlined />}
                  disabled={!r.employee}
                  onClick={() => handleCopy(r.link.token)}
                >
                  Copy
                </Button>
              </Tooltip>
              <Popconfirm
                title="Regenerate link?"
                description="This revokes the current link and creates a new one. You'll need to re-share it."
                okText="Regenerate"
                onConfirm={() => handleRegenerate(r.unit.id)}
              >
                <Button size="small" icon={<ReloadOutlined />} loading={regenBusy === r.unit.id}>
                  Regenerate
                </Button>
              </Popconfirm>
              <Popconfirm
                title="Revoke this link?"
                okText="Revoke"
                okType="danger"
                onConfirm={() => handleRevoke(r.link.id)}
              >
                <Button size="small" danger icon={<StopOutlined />}>Revoke</Button>
              </Popconfirm>
            </>
          ) : (
            <Button
              size="small"
              type="primary"
              icon={<PlusOutlined />}
              loading={regenBusy === r.unit.id}
              onClick={() => handleRegenerate(r.unit.id)}
            >
              Generate link
            </Button>
          )}
        </Space>
      ),
    },
  ];

  return (
    <MainLayout>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <Title level={4} style={{ margin: 0 }}>Viewings</Title>
          <Text type="secondary">Every unit in the org with its shareable booking link.</Text>
        </div>
        <Space wrap>
          <Link href="/property/viewings/bookings">
            <Button icon={<CalendarOutlined />}>View Bookings</Button>
          </Link>
          <Button
            type="primary"
            icon={<ThunderboltOutlined />}
            loading={autoGenBusy}
            onClick={handleAutoGenerate}
            disabled={counts.none === 0}
          >
            {counts.none === 0 ? 'All units have links' : `Auto-generate ${counts.none} missing link${counts.none > 1 ? 's' : ''}`}
          </Button>
        </Space>
      </div>

      {counts.notReady > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={`${counts.notReady} link${counts.notReady > 1 ? 's need' : ' needs'} an employee assigned before the public URL will work.`}
        />
      )}

      <Card size="small">
        <Space style={{ marginBottom: 12 }} wrap>
          <Input
            allowClear
            placeholder="Search unit, property, city, note"
            prefix={<SearchOutlined />}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: 280 }}
          />
          <Select
            value={statusFilter}
            onChange={setStatusFilter}
            style={{ width: 160 }}
            options={[
              { value: 'all', label: `All (${rows.length})` },
              { value: 'active', label: `Active (${counts.active})` },
              { value: 'not-ready', label: `Not ready (${counts.notReady})` },
              { value: 'none', label: `No link (${counts.none})` },
            ]}
          />
        </Space>

        {isMobile ? (
          <MobileCardList
            loading={loading}
            dataSource={filtered}
            rowKey={(r) => r.unit.id}
            renderCard={(r) => (
              <div>
                <div style={{ fontWeight: 600 }}>{r.unit.name}</div>
                <div style={{ color: '#8c8c8c', fontSize: 12 }}>{r.property.name}</div>
                <div style={{ marginTop: 8 }}>
                  {!r.link ? <Tag color="default">No link</Tag>
                    : !r.employee ? <Tag color="orange">Not ready</Tag>
                    : <Tag color="green">Active</Tag>}
                  {r.pending_bookings > 0 && <Tag color="gold">{r.pending_bookings} pending</Tag>}
                </div>
                <div style={{ marginTop: 8 }}>
                  {r.link && r.employee && (
                    <Button size="small" icon={<CopyOutlined />} onClick={() => handleCopy(r.link.token)}>Copy link</Button>
                  )}
                  {!r.link && (
                    <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => handleRegenerate(r.unit.id)}>
                      Generate
                    </Button>
                  )}
                </div>
              </div>
            )}
          />
        ) : (
          <Table
            size="small"
            rowKey={(r) => r.unit.id}
            loading={loading}
            dataSource={filtered}
            columns={columns}
            pagination={{ pageSize: 25 }}
            scroll={{ x: 'max-content' }}
          />
        )}
      </Card>
    </MainLayout>
  );
}
