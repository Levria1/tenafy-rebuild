'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, Table, Tag, Typography, Spin, Empty, Descriptions, message } from 'antd';
import dayjs from 'dayjs';
import { tenantPortal } from '../../../lib/tenantApi';

const { Title, Text } = Typography;

const INVOICE_STATUS = {
  0: { color: 'blue', text: 'Open' },
  1: { color: 'green', text: 'Paid' },
  2: { color: 'red', text: 'Overdue' },
};

const num = (v) => (v == null ? 0 : Number(v));
const money = (v) => `$${num(v).toFixed(2)}`;
const reading = (v) => num(v).toLocaleString();

export default function TenantUtilitiesPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await tenantPortal.getUtilities();
      if (response.data.code === 200) {
        setData(response.data.data || null);
      } else {
        message.error(response.data.message || 'Failed to load utility history');
      }
    } catch (error) {
      // 401/403 are already redirecting via the interceptor.
      const status = error.response?.status;
      if (status !== 401 && status !== 403) {
        message.error(error.response?.data?.message || 'Failed to load utility history');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return <div style={{ textAlign: 'center', padding: 40 }}><Spin size="large" /></div>;
  }

  const billLines = data?.billLines || [];
  const settlements = data?.settlements || [];
  const leases = data?.leases || [];
  const lease = leases[0] || null;

  // Monthly bills and the closing settlement are one story told in date order, the way
  // the staff tab shows it — a checkout charge only makes sense next to the month before.
  const history = [
    ...billLines.map((bl) => ({
      key: `bill-${bl.id}`,
      type: Number(bl.is_common_area) === 1 ? 'Common area' : 'Monthly',
      unit: [bl.property_name, bl.unit_name].filter(Boolean).join(' - ') || '-',
      period: bl.period_start && bl.period_end
        ? `${dayjs(bl.period_start).format('MMM D')} - ${dayjs(bl.period_end).format('MMM D, YYYY')}`
        : '-',
      starting_reading: num(bl.starting_reading),
      ending_reading: num(bl.ending_reading),
      kw_used: num(bl.kw_used),
      rate: num(bl.rate_per_kw),
      invoice_code: bl.invoice_code,
      invoice_status: bl.invoice_status,
      sort_date: bl.period_start,
    })),
    ...settlements.map((cs) => ({
      key: `settle-${cs.id}`,
      type: 'Checkout',
      unit: [cs.property_name, cs.unit_name].filter(Boolean).join(' - ') || '-',
      period: cs.reading_date ? dayjs(cs.reading_date).format('MMM D, YYYY') : '-',
      starting_reading: num(cs.starting_reading),
      ending_reading: num(cs.checkout_reading),
      kw_used: num(cs.kw_used),
      rate: num(cs.rate_per_kw),
      invoice_code: cs.invoice_code,
      invoice_status: cs.invoice_status,
      sort_date: cs.reading_date,
    })),
  ].sort((a, b) => new Date(b.sort_date) - new Date(a.sort_date));

  // Readings, rate, and the invoice the charge landed on. The gross / credit / net
  // breakdown stays staff-side (the tenant's Utilities tab in the admin app): what a
  // tenant owes is the invoice total, and the working in between only invites
  // arguments about proration. The Meter column went with them — tenants asked for
  // readings, not meter numbers, and the check-in and check-out readings are in the
  // card above.
  const columns = [
    {
      title: 'Type',
      dataIndex: 'type',
      width: 120,
      render: (v) => {
        const color = v === 'Checkout' ? 'orange' : v === 'Common area' ? 'purple' : 'blue';
        return <Tag color={color}>{v}</Tag>;
      },
    },
    { title: 'Unit', dataIndex: 'unit', width: 170 },
    { title: 'Period', dataIndex: 'period', width: 180 },
    { title: 'Start', dataIndex: 'starting_reading', width: 90, align: 'right', render: reading },
    { title: 'End', dataIndex: 'ending_reading', width: 90, align: 'right', render: reading },
    { title: 'kW', dataIndex: 'kw_used', width: 80, align: 'right', render: reading },
    { title: 'Rate', dataIndex: 'rate', width: 90, align: 'right', render: money },
    {
      title: 'Invoice',
      key: 'invoice',
      width: 150,
      render: (_, r) => {
        if (!r.invoice_code) return <Text type="secondary">-</Text>;
        const s = INVOICE_STATUS[Number(r.invoice_status)] || INVOICE_STATUS[0];
        return <Tag color={s.color}>{r.invoice_code} - {s.text}</Tag>;
      },
    },
  ];

  return (
    <div>
      <Title level={2} style={{ marginBottom: 24, marginTop: 0 }}>Electricity</Title>

      {lease && (
        <Card style={{ borderRadius: 8, marginBottom: 16 }}>
          <Descriptions
            column={{ xs: 1, sm: 2, md: 3 }}
            size="small"
            labelStyle={{ color: '#555', fontWeight: 600 }}
          >
            <Descriptions.Item label="Unit">
              {[lease.property_name, lease.unit_name].filter(Boolean).join(' - ') || '-'}
            </Descriptions.Item>
            <Descriptions.Item label="Utility credit">
              {lease.utility_credit ? `${money(lease.utility_credit)}/mo` : '-'}
            </Descriptions.Item>
            <Descriptions.Item label="Move in">
              {lease.start_date ? dayjs(lease.start_date).format('MMM D, YYYY') : '-'}
            </Descriptions.Item>
            <Descriptions.Item label="Move out">
              {lease.end_date ? dayjs(lease.end_date).format('MMM D, YYYY') : '-'}
            </Descriptions.Item>
            <Descriptions.Item label="Check-in meter">
              {lease.check_in_meter == null ? '-' : reading(lease.check_in_meter)}
            </Descriptions.Item>
            <Descriptions.Item label="Check-out meter">
              {lease.check_out_meter == null ? '-' : reading(lease.check_out_meter)}
            </Descriptions.Item>
          </Descriptions>
        </Card>
      )}

      <Card style={{ borderRadius: 8 }} title="Billing history">
        {history.length === 0 ? (
          <Empty description="No electricity charges yet" />
        ) : (
          <Table
            columns={columns}
            dataSource={history}
            rowKey="key"
            size="small"
            scroll={{ x: 880 }}
            pagination={{ pageSize: 20, showSizeChanger: false, hideOnSinglePage: true }}
          />
        )}
      </Card>

      <Text type="secondary" style={{ display: 'block', marginTop: 16, fontSize: 12 }}>
        The amount charged for each period is on the invoice shown against that row. A
        common area row is your share of electricity for the shared parts of the building.
        If a reading looks wrong, reply to your invoice email and we will check the meter.
      </Text>
    </div>
  );
}
