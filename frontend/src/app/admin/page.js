'use client';

import { useEffect, useState } from 'react';
import { Card, Row, Col, Statistic, Progress, Spin, Alert, Divider, Table, Tag } from 'antd';
import {
  CloudOutlined, MailOutlined, FileOutlined, HomeOutlined,
  TeamOutlined, FileDoneOutlined, PictureOutlined
} from '@ant-design/icons';
import MainLayout from '../../components/Layout';
import { storageMonitoring } from '../../lib/api';

export default function AdminMonitoringPage() {
  const [storageData, setStorageData] = useState(null);
  const [emailData, setEmailData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      setLoading(true);
      const [storageRes, emailRes] = await Promise.all([
        storageMonitoring.getUsage(),
        storageMonitoring.getEmailUsage(),
      ]);
      if (storageRes.data.code === 200) setStorageData(storageRes.data.data);
      if (emailRes.data.code === 200) setEmailData(emailRes.data.data);
    } catch (err) {
      setError('Failed to load monitoring data');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const getProgressColor = (pct) => {
    const p = parseFloat(pct);
    if (p > 80) return '#ff4d4f';
    if (p > 60) return '#faad14';
    return '#52c41a';
  };

  if (loading) return <MainLayout><div style={{ textAlign: 'center', padding: 80 }}><Spin size="large" /></div></MainLayout>;

  return (
    <MainLayout>
      <h1 style={{ marginBottom: 24 }}>System Monitoring</h1>

      {error && <Alert type="error" message={error} style={{ marginBottom: 16 }} />}

      {/* Storage Section */}
      <Card title={<span><CloudOutlined style={{ marginRight: 8 }} />Storage Usage</span>} style={{ marginBottom: 24 }}>
        <Row gutter={[24, 24]}>
          <Col xs={24} sm={12} md={6}>
            <Statistic
              title="Storage Used"
              value={storageData?.storage?.usedFormatted || '0 B'}
              prefix={<CloudOutlined />}
            />
          </Col>
          <Col xs={24} sm={12} md={6}>
            <Statistic
              title="Storage Limit"
              value={storageData?.storage?.limitFormatted || '5 GB'}
            />
          </Col>
          <Col xs={24} sm={12} md={6}>
            <Statistic
              title="Total Files"
              value={storageData?.storage?.fileCount || 0}
              prefix={<FileOutlined />}
            />
          </Col>
          <Col xs={24} sm={12} md={6}>
            <Statistic
              title="Images"
              value={storageData?.storage?.imageCount || 0}
              prefix={<PictureOutlined />}
            />
          </Col>
          <Col span={24}>
            <div style={{ marginBottom: 8 }}>
              <strong>Storage:</strong> {storageData?.storage?.usedFormatted} / {storageData?.storage?.limitFormatted}
            </div>
            <Progress
              percent={parseFloat(storageData?.storage?.usagePercent || 0)}
              strokeColor={getProgressColor(storageData?.storage?.usagePercent || 0)}
              format={(p) => `${p}%`}
            />
          </Col>
        </Row>
      </Card>

      {/* Email Section */}
      <Card title={<span><MailOutlined style={{ marginRight: 8 }} />Email Usage</span>} style={{ marginBottom: 24 }}>
        <Row gutter={[24, 24]}>
          <Col xs={24} sm={12} md={6}>
            <Statistic
              title="Emails This Month"
              value={emailData?.sentThisMonth || 0}
              prefix={<MailOutlined />}
            />
          </Col>
          <Col xs={24} sm={12} md={6}>
            <Statistic
              title="Monthly Limit"
              value={emailData?.monthlyLimit || 1000}
            />
          </Col>
          <Col xs={24} sm={12} md={6}>
            <Statistic
              title="Total Emails Sent"
              value={emailData?.totalSent || 0}
            />
          </Col>
          <Col xs={24} sm={12} md={6}>
            <Statistic
              title="Remaining This Month"
              value={Math.max(0, (emailData?.monthlyLimit || 1000) - (emailData?.sentThisMonth || 0))}
              valueStyle={{ color: '#52c41a' }}
            />
          </Col>
          <Col span={24}>
            <div style={{ marginBottom: 8 }}>
              <strong>Email:</strong> {emailData?.sentThisMonth || 0} / {emailData?.monthlyLimit || 1000} this month
            </div>
            <Progress
              percent={parseFloat(emailData?.usagePercent || 0)}
              strokeColor={getProgressColor(emailData?.usagePercent || 0)}
              format={(p) => `${p}%`}
            />
          </Col>
        </Row>
      </Card>

      {/* Activity Summary */}
      <Card title="Platform Activity">
        <Row gutter={[24, 24]}>
          <Col xs={12} sm={8} md={4}>
            <Statistic
              title="Properties"
              value={storageData?.activity?.totalProperties || 0}
              prefix={<HomeOutlined />}
            />
          </Col>
          <Col xs={12} sm={8} md={4}>
            <Statistic
              title="Tenants"
              value={storageData?.activity?.totalTenants || 0}
              prefix={<TeamOutlined />}
            />
          </Col>
          <Col xs={12} sm={8} md={4}>
            <Statistic
              title="Active Leases"
              value={storageData?.activity?.activeLeases || 0}
              prefix={<FileDoneOutlined />}
            />
          </Col>
          <Col xs={12} sm={8} md={4}>
            <Statistic
              title="Invoices (Total)"
              value={storageData?.activity?.totalInvoices || 0}
            />
          </Col>
          <Col xs={12} sm={8} md={4}>
            <Statistic
              title="Invoices This Month"
              value={storageData?.activity?.invoicesThisMonth || 0}
              valueStyle={{ color: '#1890ff' }}
            />
          </Col>
        </Row>
      </Card>
    </MainLayout>
  );
}
