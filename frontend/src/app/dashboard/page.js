'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, Row, Col, Typography, Table, Tag, Select, Spin, Empty, Space } from 'antd';
import MainLayout from '../../components/Layout';
import useIsMobile from '../../hooks/useIsMobile';
import MobileCardList from '../../components/mobile/MobileCardList';
import { user } from '../../lib/api';

const { Text, Title } = Typography;

// Donut chart using pure CSS
function OccupancyDonut({ occupied, vacant, total, rate }) {
  const pct = rate || 0;
  const deg = (pct / 100) * 360;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '16px 0' }}>
      <div style={{
        width: 160, height: 160, borderRadius: '50%', position: 'relative',
        background: `conic-gradient(#1890ff 0deg ${deg}deg, #ff4d4f ${deg}deg 360deg)`,
      }}>
        <div style={{
          position: 'absolute', top: 20, left: 20, right: 20, bottom: 20,
          borderRadius: '50%', background: '#fff',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        }}>
          <Text strong style={{ fontSize: 11, color: '#999' }}>OCCUPIED</Text>
          <Text strong style={{ fontSize: 20, color: '#1890ff' }}>{pct} %</Text>
        </div>
      </div>
      <div style={{ marginTop: 12, display: 'flex', gap: 20, alignItems: 'center' }}>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, background: '#ff4d4f', borderRadius: 2, marginRight: 4 }} />{vacant} VACANT</span>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, background: '#1890ff', borderRadius: 2, marginRight: 4 }} />{occupied} OCCUPIED</span>
      </div>
      <Text type="secondary" style={{ fontSize: 12, marginTop: 4 }}>Total : {total}</Text>
    </div>
  );
}

// Widget Card wrapper
function Widget({ title, extra, children, bodyStyle, style }) {
  return (
    <Card
      size="small"
      title={<Text strong style={{ fontSize: 13 }}>{title}</Text>}
      extra={extra}
      bodyStyle={{ padding: '8px 12px', minHeight: 200, ...bodyStyle }}
      style={{ height: '100%', ...style }}
    >
      {children}
    </Card>
  );
}

export default function DashboardPage() {
  const router = useRouter();
  const { isMobile } = useIsMobile();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [expiringDays, setExpiringDays] = useState(30);
  const [vacantDays, setVacantDays] = useState(30);

  useEffect(() => {
    loadDashboard();
  }, [expiringDays, vacantDays]);

  const loadDashboard = async () => {
    try {
      setLoading(true);
      const res = await user.getDashboard({ expiringDays, vacantDays });
      if (res.data.code === 200) {
        setData(res.data.data);
      }
    } catch (err) {
      console.error('Dashboard error:', err);
    } finally {
      setLoading(false);
    }
  };

  const showMore = (text) => (
    <a style={{ fontSize: 12, color: '#1890ff' }}>{text || 'show more'}</a>
  );

  const fmtMoney = (v) => v != null ? `HK$${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2 })}` : '-';
  const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-CA') : '-';

  const linkStyle = { color: '#1890ff', cursor: 'pointer', fontSize: 12 };

  if (loading && !data) {
    return (
      <MainLayout>
        <div style={{ padding: 48, textAlign: 'center' }}><Spin size="large" /></div>
      </MainLayout>
    );
  }

  const d = data || {};
  const occ = d.occupancy || {};
  const overdueRent = d.overdueRentals || { items: [], total: 0, count: 0 };
  const overduePay = d.overduePayments || { items: [], total: 0, count: 0 };
  const outstanding = d.outstandingBalance || { items: [], total: 0 };
  const expiring = d.expiringLeases || { items: [], count: 0 };
  const upcoming = d.upcomingVacant || { items: [], count: 0 };
  const vacantUnits = d.vacantUnits || [];
  const svcRequests = d.serviceRequests || [];

  return (
    <MainLayout>
      <Title level={4} style={{ marginBottom: 16 }}>Dashboard</Title>

      {/* ROW 1: Vacant Units | Overdue Rental | Overdue Payments */}
      <Row gutter={[16, 16]}>
        {/* Vacant Units */}
        <Col xs={24} lg={8}>
          <Widget title={`Vacant Units : ${vacantUnits.length}`} extra={showMore()}>
            {isMobile ? (
              <MobileCardList
                dataSource={vacantUnits}
                rowKey="unit_id"
                emptyText="No vacant units"
                renderCard={(r) => (
                  <Card size="small" style={{ borderLeft: '3px solid #1890ff' }}>
                    <a style={linkStyle} onClick={() => router.push(`/property/${r.property_id}`)}>{r.property} {r.unit_name}</a>
                    <div style={{ marginTop: 4, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Tag>{r.unit_type ? r.unit_type.charAt(0).toUpperCase() + r.unit_type.slice(1) : '-'}</Tag>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {(!r.rent_price_min && !r.rent_price_max) ? '--' : `HK$${Number(r.rent_price_min || 0).toLocaleString()} — HK$${Number(r.rent_price_max || 0).toLocaleString()}`}
                      </Text>
                    </div>
                  </Card>
                )}
              />
            ) : (
              <Table
                dataSource={vacantUnits}
                rowKey="unit_id"
                size="small"
                pagination={false}
                scroll={{ y: 180 }}
                columns={[
                  {
                    title: 'Property', dataIndex: 'property', key: 'property',
                    render: (v, r) => <a style={linkStyle} onClick={() => router.push(`/property/${r.property_id}`)}>{v} {r.unit_name}</a>,
                  },
                  { title: 'Unit Type', dataIndex: 'unit_type', key: 'type', width: 100, render: v => v ? v.charAt(0).toUpperCase() + v.slice(1) : '-' },
                  {
                    title: 'Rent', key: 'rent', width: 160,
                    render: (_, r) => {
                      if (!r.rent_price_min && !r.rent_price_max) return <Text type="secondary">--</Text>;
                      return `HK$${Number(r.rent_price_min || 0).toLocaleString()} — HK$${Number(r.rent_price_max || 0).toLocaleString()}`;
                    },
                  },
                ]}
                locale={{ emptyText: <Empty description="No vacant units" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
              />
            )}
          </Widget>
        </Col>

        {/* Overdue Rental Amount */}
        <Col xs={24} lg={8}>
          <Widget
            title={<span>Overdue Rental Amount : <Text style={{ color: '#cf1322' }}>{fmtMoney(overdueRent.total)}</Text><br /><Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>Overdue Rent : {overdueRent.count}</Text></span>}
            extra={showMore()}
          >
            {isMobile ? (
              <MobileCardList
                dataSource={overdueRent.items}
                rowKey="id"
                emptyText="No overdue rentals"
                renderCard={(r) => (
                  <Card size="small" style={{ borderLeft: '3px solid #cf1322' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <a style={linkStyle}>{r.property} {r.unit_name || ''}</a>
                      <Text style={{ color: '#cf1322', fontWeight: 600, fontSize: 13 }}>{fmtMoney(r.outstanding)}</Text>
                    </div>
                    <div style={{ marginTop: 4, display: 'flex', justifyContent: 'space-between' }}>
                      <Text type="secondary" style={{ fontSize: 12 }}>Due: {fmtDate(r.due_on)}</Text>
                      <Text style={{ color: '#cf1322', fontSize: 12 }}>{r.days_late} days late</Text>
                    </div>
                  </Card>
                )}
              />
            ) : (
              <Table
                dataSource={overdueRent.items}
                rowKey="id"
                size="small"
                pagination={false}
                scroll={{ y: 160 }}
                columns={[
                  {
                    title: 'Property', key: 'property', width: 140,
                    render: (_, r) => <a style={linkStyle}>{r.property} {r.unit_name || ''}</a>,
                  },
                  { title: 'Due Date', dataIndex: 'due_on', key: 'due', width: 100, render: fmtDate },
                  { title: 'Outstanding', dataIndex: 'outstanding', key: 'out', width: 110, render: fmtMoney },
                  {
                    title: 'Days Late', dataIndex: 'days_late', key: 'late', width: 80,
                    render: (v) => <Text style={{ color: '#cf1322' }}>{v}</Text>,
                  },
                ]}
                locale={{ emptyText: <Empty description="No overdue rentals" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
              />
            )}
          </Widget>
        </Col>

        {/* Overdue Payments Amount */}
        <Col xs={24} lg={8}>
          <Widget
            title={<span>Overdue Payments Amount : <Text style={{ color: '#cf1322' }}>{fmtMoney(overduePay.total)}</Text><br /><Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>Overdue Payments : {overduePay.count}</Text></span>}
            extra={showMore()}
          >
            {isMobile ? (
              <MobileCardList
                dataSource={overduePay.items}
                rowKey={(r, i) => `pay-${i}`}
                emptyText="No overdue payments"
                renderCard={(r) => (
                  <Card size="small" style={{ borderLeft: '3px solid #cf1322' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <a style={linkStyle}>{r.property} {r.unit_name || ''}</a>
                      <Text style={{ color: '#cf1322', fontWeight: 600, fontSize: 13 }}>{fmtMoney(r.outstanding)}</Text>
                    </div>
                    <div style={{ marginTop: 4, display: 'flex', justifyContent: 'space-between' }}>
                      <Text type="secondary" style={{ fontSize: 12 }}>Due: {fmtDate(r.due_date)}</Text>
                      <Text style={{ color: '#cf1322', fontSize: 12 }}>{r.days_late} days late</Text>
                    </div>
                  </Card>
                )}
              />
            ) : (
              <Table
                dataSource={overduePay.items}
                rowKey={(r, i) => `pay-${i}`}
                size="small"
                pagination={false}
                scroll={{ y: 160 }}
                columns={[
                  {
                    title: 'Property', key: 'property', width: 140,
                    render: (_, r) => <a style={linkStyle}>{r.property} {r.unit_name || ''}</a>,
                  },
                  { title: 'Due Date', dataIndex: 'due_date', key: 'due', width: 100, render: fmtDate },
                  { title: 'Outstanding', dataIndex: 'outstanding', key: 'out', width: 110, render: fmtMoney },
                  {
                    title: 'Days Late', dataIndex: 'days_late', key: 'late', width: 80,
                    render: (v) => <Text style={{ color: '#cf1322' }}>{v}</Text>,
                  },
                ]}
                locale={{ emptyText: <Empty description="No overdue payments" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
              />
            )}
          </Widget>
        </Col>
      </Row>

      {/* ROW 2: Outstanding Balance | Occupancy Rate | Expiring Leases */}
      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        {/* Outstanding Balance */}
        <Col xs={24} lg={8}>
          <Widget
            title={<span>Outstanding Balance : <Text style={{ color: '#cf1322' }}>{fmtMoney(outstanding.total)}</Text></span>}
            extra={showMore()}
          >
            {isMobile ? (
              <MobileCardList
                dataSource={outstanding.items}
                rowKey="tenant_id"
                emptyText="No outstanding balances"
                renderCard={(r) => (
                  <Card size="small" style={{ borderLeft: '3px solid #cf1322' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <a style={linkStyle} onClick={() => router.push(`/contacts/tenant/${r.tenant_id}/detail`)}>{r.first_name} {r.last_name}</a>
                      <Text style={{ color: '#cf1322', fontWeight: 600, fontSize: 13 }}>{fmtMoney(r.outstanding)}</Text>
                    </div>
                    <div style={{ marginTop: 4 }}>
                      {r.days_late > 0
                        ? <Text style={{ color: '#cf1322', fontSize: 12 }}>{r.days_late} days late</Text>
                        : <Text type="secondary" style={{ fontSize: 12 }}>{r.days_late || 0} days</Text>
                      }
                    </div>
                  </Card>
                )}
              />
            ) : (
              <Table
                dataSource={outstanding.items}
                rowKey="tenant_id"
                size="small"
                pagination={false}
                scroll={{ y: 180 }}
                columns={[
                  {
                    title: 'Tenant', key: 'tenant',
                    render: (_, r) => <a style={linkStyle} onClick={() => router.push(`/contacts/tenant/${r.tenant_id}/detail`)}>{r.first_name} {r.last_name}</a>,
                  },
                  { title: 'Outstanding', dataIndex: 'outstanding', key: 'out', width: 130, render: fmtMoney },
                  {
                    title: 'Days Late', dataIndex: 'days_late', key: 'late', width: 80,
                    render: (v) => v > 0 ? <Text style={{ color: '#cf1322' }}>{v}</Text> : <Text>{v || 0}</Text>,
                  },
                ]}
                locale={{ emptyText: <Empty description="No outstanding balances" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
              />
            )}
          </Widget>
        </Col>

        {/* Occupancy Rate */}
        <Col xs={24} lg={8}>
          <Widget title="Occupancy Rate">
            <OccupancyDonut
              occupied={occ.occupiedUnits || 0}
              vacant={occ.vacantCount || 0}
              total={occ.totalUnits || 0}
              rate={occ.occupancyRate || 0}
            />
          </Widget>
        </Col>

        {/* Expiring Leases */}
        <Col xs={24} lg={8}>
          <Widget
            title={`Expiring Leases : ${expiring.count}`}
            extra={
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Select size="small" value={expiringDays} onChange={setExpiringDays} style={{ width: 100 }}
                  options={[
                    { value: 10, label: '0-10days' },
                    { value: 30, label: '0-30days' },
                    { value: 60, label: '0-60days' },
                    { value: 90, label: '0-90days' },
                  ]} />
                {showMore()}
              </span>
            }
          >
            {isMobile ? (
              <MobileCardList
                dataSource={expiring.items}
                rowKey="lease_id"
                emptyText="No expiring leases"
                renderCard={(r) => (
                  <Card size="small" style={{ borderLeft: '3px solid #faad14' }}>
                    <a style={linkStyle} onClick={() => router.push(`/property/${r.property_id}`)}>{r.property} {r.unit_name || ''}</a>
                    <div style={{ marginTop: 4, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Text style={{ fontSize: 12 }}>{r.first_name} {r.last_name}</Text>
                      <Tag color="warning">{fmtDate(r.lease_end_date)}</Tag>
                    </div>
                  </Card>
                )}
              />
            ) : (
              <Table
                dataSource={expiring.items}
                rowKey="lease_id"
                size="small"
                pagination={false}
                scroll={{ y: 180 }}
                columns={[
                  {
                    title: 'Property', key: 'property',
                    render: (_, r) => <a style={linkStyle} onClick={() => router.push(`/property/${r.property_id}`)}>{r.property} {r.unit_name || ''}</a>,
                  },
                  {
                    title: 'Tenant', key: 'tenant',
                    render: (_, r) => <a style={linkStyle}>{r.first_name} {r.last_name}</a>,
                  },
                  { title: 'Lease End Date', dataIndex: 'lease_end_date', key: 'end', width: 120, render: fmtDate },
                ]}
                locale={{ emptyText: <Empty description="No expiring leases" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
              />
            )}
          </Widget>
        </Col>
      </Row>

      {/* ROW 3: Upcoming Vacant | Task List | Request List */}
      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        {/* Upcoming Vacant Units */}
        <Col xs={24} lg={8}>
          <Widget
            title={`Upcoming Vacant Units : ${upcoming.count}`}
            extra={
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Select size="small" value={vacantDays} onChange={setVacantDays} style={{ width: 100 }}
                  options={[
                    { value: 10, label: '10days' },
                    { value: 30, label: '30days' },
                    { value: 60, label: '60days' },
                    { value: 90, label: '90days' },
                  ]} />
                {showMore()}
              </span>
            }
          >
            {isMobile ? (
              <MobileCardList
                dataSource={upcoming.items}
                rowKey={(r, i) => `uv-${i}`}
                emptyText="No upcoming vacants"
                renderCard={(r) => (
                  <Card size="small" style={{ borderLeft: '3px solid #faad14' }}>
                    <a style={linkStyle} onClick={() => router.push(`/property/${r.property_id}`)}>{r.property} {r.unit_name || ''}</a>
                    <div style={{ marginTop: 4, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Tag>{r.unit_type ? r.unit_type.charAt(0).toUpperCase() + r.unit_type.slice(1) : '-'}</Tag>
                      <Text type="secondary" style={{ fontSize: 12 }}>Ends: {fmtDate(r.lease_end_date)}</Text>
                    </div>
                  </Card>
                )}
              />
            ) : (
              <Table
                dataSource={upcoming.items}
                rowKey={(r, i) => `uv-${i}`}
                size="small"
                pagination={false}
                scroll={{ y: 180 }}
                columns={[
                  {
                    title: 'Property', key: 'property',
                    render: (_, r) => <a style={linkStyle} onClick={() => router.push(`/property/${r.property_id}`)}>{r.property} {r.unit_name || ''}</a>,
                  },
                  { title: 'Unit Type', dataIndex: 'unit_type', key: 'type', width: 100, render: v => v ? v.charAt(0).toUpperCase() + v.slice(1) : '-' },
                  { title: 'Lease End Date', dataIndex: 'lease_end_date', key: 'end', width: 120, render: fmtDate },
                ]}
                locale={{ emptyText: <Empty description="No upcoming vacants" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
              />
            )}
          </Widget>
        </Col>

        {/* Task List */}
        <Col xs={24} lg={8}>
          <Widget title="Task List" extra={showMore()}>
            <Empty description="No tasks" image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ marginTop: 40 }} />
          </Widget>
        </Col>

        {/* Request List */}
        <Col xs={24} lg={8}>
          <Widget title="Request List" extra={showMore()}>
            {svcRequests.length === 0 ? (
              <Empty description="No service requests" image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ marginTop: 40 }} />
            ) : (
              <div style={{ maxHeight: 220, overflow: 'auto' }}>
                {svcRequests.map((sr) => (
                  <div
                    key={sr.id}
                    style={{
                      padding: '10px 12px', marginBottom: 8, borderRadius: 6,
                      background: '#fffbe6', borderLeft: '4px solid #faad14', cursor: 'pointer',
                    }}
                    onClick={() => router.push(`/service?id=${sr.id}`)}
                  >
                    <Text strong style={{ fontSize: 13 }}>{sr.code}</Text>
                    <br />
                    <Text style={{ fontSize: 12 }}>{sr.property} {sr.unit_name}</Text>
                    <br />
                    <Text type="secondary" style={{ fontSize: 11 }}>
                      {sr.category}{sr.sub_category ? ' / ' + sr.sub_category : ''} · Request
                    </Text>
                    <br />
                    <Text type="secondary" style={{ fontSize: 11 }}>
                      {sr.preferred_date_first_start
                        ? new Date(sr.preferred_date_first_start).toLocaleString()
                        : new Date(sr.created_at).toLocaleString()}
                    </Text>
                  </div>
                ))}
              </div>
            )}
          </Widget>
        </Col>
      </Row>
    </MainLayout>
  );
}
