'use client';

import { useState, useEffect, useCallback } from 'react';
import { Table, Input, Select, DatePicker, Tag, Card, Space, Button, Tooltip, Typography } from 'antd';
import { SearchOutlined, ReloadOutlined, ExpandOutlined } from '@ant-design/icons';
import { activityLog } from '@/lib/api';
import dayjs from 'dayjs';

const { RangePicker } = DatePicker;
const { Text } = Typography;

const ACTION_COLORS = {
  CREATE: 'green',
  UPDATE: 'blue',
  DELETE: 'red',
};

const ENTITY_LABELS = {
  lease: 'Lease',
  tenant: 'Tenant',
  property: 'Property',
  unit: 'Unit',
  invoice: 'Invoice',
  payment: 'Payment',
  service: 'Service',
};

export default function UserLogsPage() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [search, setSearch] = useState('');
  const [actionFilter, setActionFilter] = useState(null);
  const [entityFilter, setEntityFilter] = useState(null);
  const [userFilter, setUserFilter] = useState(null);
  const [dateRange, setDateRange] = useState(null);
  const [users, setUsers] = useState([]);
  const [entityTypes, setEntityTypes] = useState([]);
  const [expandedRow, setExpandedRow] = useState(null);

  const loadLogs = useCallback(async () => {
    try {
      setLoading(true);
      const params = { page, limit: pageSize };
      if (search) params.search = search;
      if (actionFilter) params.action = actionFilter;
      if (entityFilter) params.entity_type = entityFilter;
      if (userFilter) params.user_id = userFilter;
      if (dateRange && dateRange[0]) params.start_date = dateRange[0].format('YYYY-MM-DD');
      if (dateRange && dateRange[1]) params.end_date = dateRange[1].format('YYYY-MM-DD');

      const res = await activityLog.list(params);
      if (res.data.code === 200) {
        setLogs(res.data.data.content || []);
        setTotal(res.data.data.totalElements || 0);
      }
    } catch (err) {
      console.error('Failed to load logs:', err);
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, search, actionFilter, entityFilter, userFilter, dateRange]);

  useEffect(() => {
    loadLogs();
  }, [loadLogs]);

  useEffect(() => {
    activityLog.getUsers().then(res => {
      if (res.data.code === 200) setUsers(res.data.data || []);
    }).catch(() => {});
    activityLog.getEntityTypes().then(res => {
      if (res.data.code === 200) setEntityTypes(res.data.data || []);
    }).catch(() => {});
  }, []);

  const handleSearch = (val) => {
    setSearch(val);
    setPage(1);
  };

  const handleReset = () => {
    setSearch('');
    setActionFilter(null);
    setEntityFilter(null);
    setUserFilter(null);
    setDateRange(null);
    setPage(1);
  };

  const columns = [
    {
      title: 'Date & Time',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 170,
      render: (v) => v ? dayjs(v).format('YYYY-MM-DD HH:mm:ss') : '-',
    },
    {
      title: 'User',
      dataIndex: 'username',
      key: 'username',
      width: 220,
      render: (v) => v || '-',
    },
    {
      title: 'Action',
      dataIndex: 'action',
      key: 'action',
      width: 100,
      render: (v) => <Tag color={ACTION_COLORS[v] || 'default'}>{v}</Tag>,
    },
    {
      title: 'Type',
      dataIndex: 'entity_type',
      key: 'entity_type',
      width: 120,
      render: (v) => ENTITY_LABELS[v] || v,
    },
    {
      title: 'Description',
      dataIndex: 'description',
      key: 'description',
      ellipsis: true,
      render: (v) => v || '-',
    },
    {
      title: 'Entity ID',
      dataIndex: 'entity_id',
      key: 'entity_id',
      width: 160,
      render: (v) => v ? <Text copyable style={{ fontSize: 12 }}>{v}</Text> : '-',
    },
    {
      title: 'IP',
      dataIndex: 'ip_address',
      key: 'ip_address',
      width: 130,
      render: (v) => v || '-',
    },
  ];

  return (
    <div style={{ padding: 0 }}>
      <h1 style={{ marginBottom: 20, fontSize: 22 }}>User Logs</h1>

      <Card size="small" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
          <Input.Search
            placeholder="Search by user, description, or entity ID..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onSearch={handleSearch}
            style={{ width: 300 }}
            allowClear
            enterButton={<SearchOutlined />}
          />
          <Select
            placeholder="Action"
            value={actionFilter}
            onChange={(v) => { setActionFilter(v); setPage(1); }}
            allowClear
            style={{ width: 130 }}
            options={[
              { label: 'Create', value: 'CREATE' },
              { label: 'Update', value: 'UPDATE' },
              { label: 'Delete', value: 'DELETE' },
            ]}
          />
          <Select
            placeholder="Type"
            value={entityFilter}
            onChange={(v) => { setEntityFilter(v); setPage(1); }}
            allowClear
            style={{ width: 140 }}
            options={entityTypes.map(t => ({ label: ENTITY_LABELS[t] || t, value: t }))}
          />
          <Select
            placeholder="User"
            value={userFilter}
            onChange={(v) => { setUserFilter(v); setPage(1); }}
            allowClear
            showSearch
            optionFilterProp="label"
            style={{ width: 220 }}
            options={users.map(u => ({ label: u.username, value: String(u.user_id) }))}
          />
          <RangePicker
            value={dateRange}
            onChange={(v) => { setDateRange(v); setPage(1); }}
            style={{ width: 260 }}
          />
          <Button icon={<ReloadOutlined />} onClick={handleReset}>Reset</Button>
        </div>
      </Card>

      <Table
        columns={columns}
        dataSource={logs}
        rowKey="id"
        loading={loading}
        size="small"
        pagination={{
          current: page,
          pageSize: pageSize,
          total: total,
          showSizeChanger: true,
          pageSizeOptions: ['25', '50', '100'],
          showTotal: (t) => `${t} total logs`,
          onChange: (p, ps) => { setPage(p); setPageSize(ps); },
        }}
        expandable={{
          expandedRowRender: (record) => {
            if (!record.details) return <Text type="secondary">No additional details</Text>;
            let parsed;
            try { parsed = typeof record.details === 'string' ? JSON.parse(record.details) : record.details; } catch { parsed = record.details; }
            return (
              <pre style={{ fontSize: 12, background: '#f5f5f5', padding: 12, borderRadius: 4, maxHeight: 300, overflow: 'auto', margin: 0 }}>
                {typeof parsed === 'object' ? JSON.stringify(parsed, null, 2) : String(parsed)}
              </pre>
            );
          },
          rowExpandable: (record) => !!record.details,
        }}
        scroll={{ x: 1100 }}
      />
    </div>
  );
}
