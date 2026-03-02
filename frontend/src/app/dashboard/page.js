'use client';

import { useEffect, useState } from 'react';
import { Card, Row, Col, Statistic, Table, Tag } from 'antd';
import {
  HomeOutlined,
  TeamOutlined,
  FileTextOutlined,
  CalendarOutlined,
  RiseOutlined,
} from '@ant-design/icons';
import MainLayout from '../../components/Layout';
import { user, property } from '../../lib/api';

export default function DashboardPage() {
  const [stats, setStats] = useState({
    totalUnits: 0,
    occupiedUnits: 0,
    occupancyRate: 0,
    expiringLeases: 0,
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadDashboard();
  }, []);

  const loadDashboard = async () => {
    try {
      const response = await user.getDashboard();
      if (response.data.code === 200) {
        setStats(response.data.data);
      }
    } catch (error) {
      console.error('Failed to load dashboard:', error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <MainLayout>
      <h1 style={{ marginBottom: 24 }}>Dashboard</h1>
      <Row gutter={16}>
        <Col span={6}>
          <Card loading={loading}>
            <Statistic
              title="Total Units"
              value={stats.totalUnits}
              prefix={<HomeOutlined />}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card loading={loading}>
            <Statistic
              title="Occupied Units"
              value={stats.occupiedUnits}
              prefix={<TeamOutlined />}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card loading={loading}>
            <Statistic
              title="Occupancy Rate"
              value={stats.occupancyRate}
              prefix={<RiseOutlined />}
              suffix="%"
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card loading={loading}>
            <Statistic
              title="Expiring Leases"
              value={stats.expiringLeases}
              prefix={<CalendarOutlined />}
              valueStyle={{ color: '#faad14' }}
            />
          </Card>
        </Col>
      </Row>
      <Row gutter={16} style={{ marginTop: 24 }}>
        <Col span={12}>
          <Card title="Recent Activities" loading={loading}>
            <p>No recent activities</p>
          </Card>
        </Col>
        <Col span={12}>
          <Card title="Quick Actions" loading={loading}>
            <p>No quick actions available</p>
          </Card>
        </Col>
      </Row>
    </MainLayout>
  );
}