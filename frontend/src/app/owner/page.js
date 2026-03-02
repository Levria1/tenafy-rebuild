'use client';

import { useEffect, useState } from 'react';
import { Card, Row, Col, Statistic, message, Spin } from 'antd';
import {
  HomeOutlined,
  FileTextOutlined,
  DollarOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { useRouter } from 'next/navigation';
import MainLayout from '../../components/Layout';
import { property, accounting } from '../../lib/api';

export default function OwnerDashboardPage() {
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({
    totalProperties: 0,
    activeLeases: 0,
    totalIncome: 0,
    outstanding: 0,
  });
  const router = useRouter();

  useEffect(() => {
    loadDashboard();
  }, []);

  const loadDashboard = async () => {
    try {
      setLoading(true);

      const [propertiesRes, paidOutstandingRes] = await Promise.all([
        property.list({}, { page: 1, limit: 1000 }),
        accounting.getOwnerPaidOutstanding({}),
      ]);

      let totalProperties = 0;
      let activeLeases = 0;

      if (propertiesRes.data.code === 200) {
        const properties = propertiesRes.data.data.content || [];
        totalProperties = properties.length;
        activeLeases = properties.reduce((sum, p) => {
          return sum + (p.active_leases || 0);
        }, 0);
      }

      let totalIncome = 0;
      let outstanding = 0;

      if (paidOutstandingRes.data.code === 200) {
        const data = paidOutstandingRes.data.data || {};
        totalIncome = data.paid || 0;
        outstanding = data.outstanding || 0;
      }

      setStats({
        totalProperties,
        activeLeases,
        totalIncome,
        outstanding,
      });
    } catch (error) {
      console.error('Failed to load owner dashboard:', error);
      message.error('Failed to load dashboard data');
    } finally {
      setLoading(false);
    }
  };

  const formatCurrency = (value) => {
    return Number(value || 0).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  };

  return (
    <MainLayout>
      <h1 style={{ marginBottom: 24 }}>Owner Dashboard</h1>
      <Spin spinning={loading}>
        <Row gutter={[16, 16]}>
          <Col xs={24} sm={12} lg={6}>
            <Card>
              <Statistic
                title="Total Properties"
                value={stats.totalProperties}
                prefix={<HomeOutlined />}
              />
            </Card>
          </Col>
          <Col xs={24} sm={12} lg={6}>
            <Card>
              <Statistic
                title="Active Leases"
                value={stats.activeLeases}
                prefix={<FileTextOutlined />}
              />
            </Card>
          </Col>
          <Col xs={24} sm={12} lg={6}>
            <Card>
              <Statistic
                title="Total Income"
                value={formatCurrency(stats.totalIncome)}
                prefix={<DollarOutlined />}
                valueStyle={{ color: '#3f8600' }}
              />
            </Card>
          </Col>
          <Col xs={24} sm={12} lg={6}>
            <Card>
              <Statistic
                title="Outstanding Invoices"
                value={formatCurrency(stats.outstanding)}
                prefix={<WarningOutlined />}
                valueStyle={{ color: '#faad14' }}
              />
            </Card>
          </Col>
        </Row>

        <Row gutter={[16, 16]} style={{ marginTop: 24 }}>
          <Col xs={24} md={12}>
            <Card
              title="Quick Actions"
              hoverable
              style={{ cursor: 'default' }}
            >
              <Row gutter={[8, 8]}>
                <Col span={12}>
                  <Card
                    size="small"
                    hoverable
                    onClick={() => router.push('/owner/accounting')}
                    style={{ textAlign: 'center' }}
                  >
                    <DollarOutlined style={{ fontSize: 24, marginBottom: 8 }} />
                    <div>View Transactions</div>
                  </Card>
                </Col>
                <Col span={12}>
                  <Card
                    size="small"
                    hoverable
                    onClick={() => router.push('/owner/invoices')}
                    style={{ textAlign: 'center' }}
                  >
                    <FileTextOutlined style={{ fontSize: 24, marginBottom: 8 }} />
                    <div>View Invoices</div>
                  </Card>
                </Col>
              </Row>
            </Card>
          </Col>
          <Col xs={24} md={12}>
            <Card title="Financial Summary">
              <Row gutter={16}>
                <Col span={12}>
                  <Statistic
                    title="Paid"
                    value={formatCurrency(stats.totalIncome)}
                    prefix="$"
                    valueStyle={{ color: '#3f8600', fontSize: 18 }}
                  />
                </Col>
                <Col span={12}>
                  <Statistic
                    title="Outstanding"
                    value={formatCurrency(stats.outstanding)}
                    prefix="$"
                    valueStyle={{ color: '#faad14', fontSize: 18 }}
                  />
                </Col>
              </Row>
            </Card>
          </Col>
        </Row>
      </Spin>
    </MainLayout>
  );
}
