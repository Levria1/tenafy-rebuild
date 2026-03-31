'use client';

import { useEffect, useState } from 'react';
import { Card, Calendar, Badge, Row, Col, Select } from 'antd';
import MainLayout from '../../../components/Layout';
import { leasing } from '../../../lib/api';

export default function LeasingCalendarPage() {
  const [leases, setLeases] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedMonth, setSelectedMonth] = useState(null);

  useEffect(() => {
    loadLeases();
  }, []);

  const loadLeases = async () => {
    try {
      const response = await leasing.list({}, { page: 1, limit: 1000 });
      if (response.data.code === 200) {
        setLeases(response.data.data.content || []);
      }
    } catch (error) {
      console.error('Failed to load leases:', error);
    } finally {
      setLoading(false);
    }
  };

  const getLeaseStatus = (lease) => {
    const today = new Date().toISOString().split('T')[0];
    const start = lease.start_date ? lease.start_date.slice(0, 10) : null;
    const end = lease.end_date ? lease.end_date.slice(0, 10) : null;

    if (start && start > today) return { status: 'upcoming', color: 'blue' };
    if (end && end < today) return { status: 'inactive', color: 'red' };
    return { status: 'active', color: 'green' };
  };

  const getLeasesForDate = (date) => {
    const dateStr = date.format('YYYY-MM-DD');
    return leases.filter(lease => {
      const start = lease.start_date;
      const end = lease.end_date;
      return dateStr >= start && dateStr <= end;
    }).map(lease => {
      const { status, color } = getLeaseStatus(lease);
      return {
        type: color,
        content: `${lease.property_name} - Unit ${lease.unit_number} (${lease.tenant_first_name})`
      };
    });
  };

  const dateCellRender = (date) => {
    const leasesForDate = getLeasesForDate(date);
    return (
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {leasesForDate.map((item, index) => (
          <li key={index}>
            <Badge status={item.type} text={<span style={{ fontSize: 10 }}>{item.content}</span>} />
          </li>
        ))}
      </ul>
    );
  };

  return (
    <MainLayout>
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col>
          <h1>Leasing Calendar</h1>
        </Col>
      </Row>
      <Card loading={loading}>
        <Calendar dateCellRender={dateCellRender} />
      </Card>
    </MainLayout>
  );
}
