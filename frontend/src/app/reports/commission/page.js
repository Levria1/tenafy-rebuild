'use client';

import { useState, useEffect, useCallback } from 'react';
import { Table, Card, DatePicker, Button, message, Typography, Tag, Tabs, Empty, Tooltip } from 'antd';
import { ReloadOutlined, DownloadOutlined, InfoCircleOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { reports } from '../../../lib/api';
import MainLayout, { useAuth } from '../../../components/Layout';

const { RangePicker } = DatePicker;
const { Text, Title } = Typography;

const fmt = (n) => (n == null ? '-' : Number(n).toLocaleString('en-HK', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const fmtMoney = (n) => (n == null ? '-' : 'HK$ ' + fmt(n));

// CSV helpers — keep it dependency-free, just escape quotes and wrap.
function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function downloadCsv(filename, rows) {
  const csv = rows.map(r => r.map(csvCell).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

export default function CommissionTrackerPage() {
  const { hasPermission, loading: authLoading } = useAuth();
  const canView = hasPermission('LANDLORD/REPORT/COMMISSION_VIEW');

  const [dateRange, setDateRange] = useState(() => [
    dayjs().startOf('year'),
    dayjs().endOf('year'),
  ]);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState({ by_agent: [], by_platform: [], totals: { new_leases: 0, active_leases: 0, revenue: 0 } });
  const [activeTab, setActiveTab] = useState('agent');

  const load = useCallback(async () => {
    if (!canView) return;
    if (!dateRange || dateRange.length !== 2) return;
    const [from, to] = dateRange;
    if (!from || !to) return;
    setLoading(true);
    try {
      const res = await reports.commission({
        from: from.format('YYYY-MM-DD'),
        to: to.format('YYYY-MM-DD'),
      });
      if (res.data.code === 200) {
        setData(res.data.data || { by_agent: [], by_platform: [], totals: {} });
      } else {
        message.error(res.data.message || 'Failed to load commission report');
      }
    } catch (e) {
      message.error(e.response?.data?.message || 'Failed to load commission report');
    } finally {
      setLoading(false);
    }
  }, [dateRange, canView]);

  useEffect(() => { load(); }, [load]);

  if (authLoading) return <MainLayout><div /></MainLayout>;
  if (!canView) {
    return (
      <MainLayout>
        <Empty description="You don't have permission to view the Commission Tracker." style={{ padding: 64 }} />
      </MainLayout>
    );
  }

  const exportCsv = () => {
    const rows = activeTab === 'agent' ? data.by_agent : data.by_platform;
    const header = [activeTab === 'agent' ? 'Sales Agent' : 'Booking Platform', 'New Leases', 'Active Leases', 'Revenue (HK$)'];
    const out = [header, ...rows.map(r => [r.name, r.new_leases, r.active_leases, r.revenue])];
    const [from, to] = dateRange;
    downloadCsv(
      `commission-${activeTab}-${from.format('YYYYMMDD')}-${to.format('YYYYMMDD')}.csv`,
      out
    );
  };

  // ---- Columns ----
  const summaryColumns = (label) => [
    { title: label, dataIndex: 'name', key: 'name', render: (v, r) => (
      <span>
        {v}
        {r.key === '__none__' && <Tag color="default" style={{ marginLeft: 8 }}>Unassigned</Tag>}
      </span>
    ) },
    { title: 'New Leases', dataIndex: 'new_leases', key: 'new_leases', width: 120, align: 'right' },
    { title: 'Active Leases', dataIndex: 'active_leases', key: 'active_leases', width: 130, align: 'right' },
    { title: (
      <span>
        Revenue&nbsp;
        <Tooltip title="Gross rental-income invoiced inside the filter period. Bulk/one-shot invoices are prorated by the overlap of the lease's covered span with the filter period.">
          <InfoCircleOutlined style={{ color: '#999' }} />
        </Tooltip>
      </span>
    ), dataIndex: 'revenue', key: 'revenue', width: 180, align: 'right', render: fmtMoney },
  ];

  const leaseColumns = [
    { title: 'Lease #', dataIndex: 'lease_no', key: 'lease_no', width: 110 },
    { title: 'Tenant', dataIndex: 'tenant_name', key: 'tenant_name' },
    { title: 'Property', dataIndex: 'property_name', key: 'property_name' },
    { title: 'Unit', dataIndex: 'unit_name', key: 'unit_name', width: 80 },
    { title: 'Start', dataIndex: 'start_date', key: 'start_date', width: 110, render: v => v ? dayjs(v).format('YYYY-MM-DD') : '-' },
    { title: 'End', dataIndex: 'end_date', key: 'end_date', width: 110, render: v => v ? dayjs(v).format('YYYY-MM-DD') : '—' },
    { title: 'Schedule', dataIndex: 'invoicing', key: 'invoicing', width: 100, render: v => v || <Tag color="orange">Bulk</Tag> },
    { title: 'New', dataIndex: 'is_new', key: 'is_new', width: 60, align: 'center', render: v => v ? <Tag color="green">New</Tag> : null },
    { title: 'Revenue', dataIndex: 'revenue', key: 'revenue', width: 140, align: 'right', render: fmtMoney },
  ];

  const expandedRowRender = (row) => (
    <Table
      rowKey="id"
      columns={leaseColumns}
      dataSource={row.leases || []}
      pagination={false}
      size="small"
    />
  );

  return (
    <MainLayout>
      <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Title level={3} style={{ margin: 0 }}>Commission Tracker</Title>
        <Text type="secondary">Sales agent and booking platform performance — revenue is prorated rental income.</Text>
      </div>

      <Card size="small" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <Text strong>Period:</Text>
          <RangePicker value={dateRange} onChange={setDateRange} allowClear={false} />
          <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>Refresh</Button>
          <Button icon={<DownloadOutlined />} onClick={exportCsv} disabled={loading}>Export CSV</Button>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 16 }}>
            <div><Text type="secondary">New leases:</Text> <Text strong>{data.totals.new_leases}</Text></div>
            <div><Text type="secondary">Active leases:</Text> <Text strong>{data.totals.active_leases}</Text></div>
            <div><Text type="secondary">Revenue:</Text> <Text strong style={{ color: '#1677ff' }}>{fmtMoney(data.totals.revenue)}</Text></div>
          </div>
        </div>
      </Card>

      <Card size="small">
        <Tabs activeKey={activeTab} onChange={setActiveTab} items={[
          {
            key: 'agent',
            label: 'By Sales Agent',
            children: (
              <Table
                rowKey="key"
                loading={loading}
                columns={summaryColumns('Sales Agent')}
                dataSource={data.by_agent}
                expandable={{ expandedRowRender, rowExpandable: r => r.leases?.length > 0 }}
                pagination={false}
                locale={{ emptyText: 'No leases or revenue in this period.' }}
              />
            ),
          },
          {
            key: 'platform',
            label: 'By Booking Platform',
            children: (
              <Table
                rowKey="key"
                loading={loading}
                columns={summaryColumns('Booking Platform')}
                dataSource={data.by_platform}
                expandable={{ expandedRowRender, rowExpandable: r => r.leases?.length > 0 }}
                pagination={false}
                locale={{ emptyText: 'No leases or revenue in this period.' }}
              />
            ),
          },
        ]} />
      </Card>
    </MainLayout>
  );
}
