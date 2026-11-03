'use client';

import { useEffect, useState } from 'react';
import { Card, Row, Col, Statistic, Typography, message } from 'antd';
import {
  FileTextOutlined,
  DollarOutlined,
  CalendarOutlined,
  HomeOutlined,
} from '@ant-design/icons';
import { tenantPortal } from '../../../lib/tenantApi';
import { formatDateOnly } from '../../../lib/dateOnly';

const { Title } = Typography;

export default function TenantDashboardPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadDashboard();
  }, []);

  const loadDashboard = async () => {
    try {
      const response = await tenantPortal.getDashboard();
      if (response.data.code === 200) {
        setData(response.data.data);
      } else {
        message.error(response.data.message || 'Failed to load dashboard');
      }
    } catch (error) {
      message.error(error.response?.data?.message || 'Failed to load dashboard');
    } finally {
      setLoading(false);
    }
  };

  const formatCurrency = (amount) => {
    if (amount == null) return '$0.00';
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
  };

  const formatDate = (dateStr) => formatDateOnly(dateStr, { month: 'long' });

  return (
    <div>
      <Title level={2} style={{ marginBottom: 24, marginTop: 0 }}>
        Dashboard
      </Title>

      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} lg={6}>
          <Card loading={loading} style={{ borderRadius: 8 }}>
            <Statistic
              title="Active Leases"
              value={data?.activeLeases ?? 0}
              prefix={<HomeOutlined style={{ color: '#1890ff' }} />}
              valueStyle={{ color: '#1890ff' }}
            />
          </Card>
        </Col>

        <Col xs={24} sm={12} lg={6}>
          <Card loading={loading} style={{ borderRadius: 8 }}>
            <Statistic
              title="Unpaid Invoices"
              value={data?.unpaidInvoices ?? 0}
              prefix={<FileTextOutlined style={{ color: '#faad14' }} />}
              valueStyle={{ color: data?.unpaidInvoices > 0 ? '#faad14' : '#52c41a' }}
            />
          </Card>
        </Col>

        <Col xs={24} sm={12} lg={6}>
          <Card loading={loading} style={{ borderRadius: 8 }}>
            <Statistic
              title="Outstanding Amount"
              value={data?.outstandingAmount ?? 0}
              prefix={<DollarOutlined style={{ color: '#ff4d4f' }} />}
              valueStyle={{ color: data?.outstandingAmount > 0 ? '#ff4d4f' : '#52c41a' }}
              formatter={(val) => formatCurrency(val)}
            />
          </Card>
        </Col>

        <Col xs={24} sm={12} lg={6}>
          <Card loading={loading} style={{ borderRadius: 8 }}>
            <Statistic
              title="Next Payment Due"
              value={data?.nextDueDate ? formatDate(data.nextDueDate) : 'No upcoming payments'}
              prefix={<CalendarOutlined style={{ color: '#722ed1' }} />}
              valueStyle={{ color: '#722ed1', fontSize: 16 }}
            />
            {data?.nextDueAmount > 0 && !loading && (
              <div style={{ marginTop: 8, color: '#8c8c8c', fontSize: 12 }}>
                Amount: {formatCurrency(data.nextDueAmount)}
              </div>
            )}
          </Card>
        </Col>
      </Row>

      {!loading && data?.unpaidInvoices > 0 && (
        <Card
          style={{ marginTop: 24, borderRadius: 8, borderLeft: '4px solid #faad14' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <FileTextOutlined style={{ color: '#faad14', fontSize: 20 }} />
            <div>
              <div style={{ fontWeight: 600, color: '#262626' }}>
                You have {data.unpaidInvoices} unpaid invoice{data.unpaidInvoices !== 1 ? 's' : ''}
              </div>
              <div style={{ color: '#8c8c8c', fontSize: 13 }}>
                Total outstanding: {formatCurrency(data.outstandingAmount)}
                {data.nextDueDate && ` — Next due: ${formatDate(data.nextDueDate)}`}
              </div>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
