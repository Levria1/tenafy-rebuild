'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Button, Card, Table, Tag, Space, Typography, Popconfirm, message, Empty,
  Drawer, Descriptions, Alert,
} from 'antd';
import {
  PlusOutlined, CopyOutlined, LinkOutlined, EyeOutlined, StopOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import GenerateViewingLinkModal from './GenerateViewingLinkModal';
import { viewingApi } from '../../lib/api';

const { Text, Paragraph } = Typography;

// Server-side status ints → UI label/color.
const BOOKING_STATUS = {
  0: { label: 'Pending', color: 'gold' },
  1: { label: 'Confirmed', color: 'green' },
  2: { label: 'Declined', color: 'red' },
  3: { label: 'Cancelled', color: 'default' },
  4: { label: 'Expired', color: 'default' },
};
const DECISION = {
  0: { label: 'Pending', color: 'gold' },
  1: { label: 'Approved', color: 'green' },
  2: { label: 'Declined', color: 'red' },
  3: { label: 'Skipped', color: 'default' },
};

function employeeName(emp) {
  if (!emp) return '-';
  return [emp.first_name, emp.last_name].filter(Boolean).join(' ') || emp.email || '-';
}

export default function UnitViewingsTab({ unitId, isMobile }) {
  const [links, setLinks] = useState([]);
  const [bookings, setBookings] = useState([]);
  const [loadingLinks, setLoadingLinks] = useState(false);
  const [loadingBookings, setLoadingBookings] = useState(false);
  const [genOpen, setGenOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailData, setDetailData] = useState(null);

  const reloadLinks = useCallback(() => {
    if (!unitId) return;
    setLoadingLinks(true);
    viewingApi.listLinks(unitId)
      .then((r) => setLinks(r.data.data || []))
      .catch(() => setLinks([]))
      .finally(() => setLoadingLinks(false));
  }, [unitId]);

  const reloadBookings = useCallback(() => {
    if (!unitId) return;
    setLoadingBookings(true);
    viewingApi.listBookings(unitId)
      .then((r) => setBookings(r.data.data || []))
      .catch(() => setBookings([]))
      .finally(() => setLoadingBookings(false));
  }, [unitId]);

  useEffect(() => {
    reloadLinks();
    reloadBookings();
  }, [reloadLinks, reloadBookings]);

  const handleCopy = async (token) => {
    const url = `${window.location.origin}/book/viewing/${token}`;
    try {
      await navigator.clipboard.writeText(url);
      message.success('Link copied');
    } catch {
      message.error('Copy failed');
    }
  };

  const handleRevoke = async (linkId) => {
    try {
      await viewingApi.revokeLink(linkId);
      message.success('Link revoked');
      reloadLinks();
    } catch (e) {
      message.error(e?.response?.data?.message || 'Failed to revoke');
    }
  };

  const openDetail = async (bookingId) => {
    setDetailOpen(true);
    setDetailData(null);
    try {
      const r = await viewingApi.getBooking(bookingId);
      setDetailData(r.data.data);
    } catch (e) {
      message.error(e?.response?.data?.message || 'Failed to load booking');
    }
  };

  const handleStaffCancel = async (bookingId) => {
    try {
      await viewingApi.cancelBooking(bookingId);
      message.success('Booking cancelled');
      reloadBookings();
      setDetailOpen(false);
    } catch (e) {
      message.error(e?.response?.data?.message || 'Failed to cancel');
    }
  };

  // --- Shareable links table ---
  const linkColumns = [
    {
      title: 'Status',
      dataIndex: 'status',
      width: 100,
      render: (s) => <Tag color={s === 1 ? 'green' : 'default'}>{s === 1 ? 'Active' : 'Revoked'}</Tag>,
    },
    {
      title: 'Employee',
      dataIndex: 'employee',
      render: (e) => employeeName(e),
    },
    {
      title: 'Note',
      dataIndex: 'note',
      render: (n) => n || <Text type="secondary">—</Text>,
    },
    {
      title: 'Bookings',
      dataIndex: 'booking_count',
      width: 90,
      align: 'center',
    },
    {
      title: 'Created',
      dataIndex: 'created_at',
      width: 140,
      render: (v) => v ? dayjs(v).format('YYYY-MM-DD HH:mm') : '',
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 180,
      render: (_, r) => (
        <Space size="small">
          <Button
            size="small"
            icon={<CopyOutlined />}
            disabled={r.status !== 1}
            onClick={() => handleCopy(r.token)}
          >
            Copy
          </Button>
          {r.status === 1 && (
            <Popconfirm title="Revoke this link?" okText="Revoke" okType="danger" onConfirm={() => handleRevoke(r.id)}>
              <Button size="small" danger icon={<StopOutlined />}>Revoke</Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  // --- Bookings table ---
  const bookingColumns = [
    {
      title: 'When',
      dataIndex: 'proposed_datetime',
      render: (v) => dayjs(v).format('ddd MMM D, h:mm A'),
    },
    { title: 'Viewer', dataIndex: 'viewer_name' },
    {
      title: 'Contact',
      key: 'contact',
      render: (_, r) => (
        <>
          <div style={{ fontSize: 12 }}>{r.viewer_email}</div>
          {r.viewer_phone && <div style={{ fontSize: 12, color: '#8c8c8c' }}>{r.viewer_phone}</div>}
        </>
      ),
    },
    {
      title: 'Tenant',
      dataIndex: 'tenant_decision',
      width: 100,
      render: (d) => {
        const info = DECISION[d] || DECISION[0];
        return <Tag color={info.color}>{info.label}</Tag>;
      },
    },
    {
      title: 'Employee',
      dataIndex: 'employee_decision',
      width: 110,
      render: (d) => {
        const info = DECISION[d] || DECISION[0];
        return <Tag color={info.color}>{info.label}</Tag>;
      },
    },
    {
      title: 'Status',
      dataIndex: 'status',
      width: 110,
      render: (s) => {
        const info = BOOKING_STATUS[s] || BOOKING_STATUS[0];
        return <Tag color={info.color}>{info.label}</Tag>;
      },
    },
    {
      title: '',
      key: 'actions',
      width: 80,
      render: (_, r) => (
        <Button size="small" icon={<EyeOutlined />} onClick={() => openDetail(r.id)}>View</Button>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <Text strong>Shareable booking links</Text>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setGenOpen(true)}>
          Generate link
        </Button>
      </div>

      {links.length === 0 && !loadingLinks ? (
        <Card size="small" style={{ marginBottom: 24 }}>
          <Empty
            image={<LinkOutlined style={{ fontSize: 48, color: '#bfbfbf' }} />}
            description={<Text type="secondary">No share links yet — generate one to let viewers book this unit without logging in.</Text>}
          />
        </Card>
      ) : (
        <Table
          size="small"
          rowKey="id"
          loading={loadingLinks}
          dataSource={links}
          columns={linkColumns}
          pagination={false}
          style={{ marginBottom: 24 }}
        />
      )}

      <Text strong style={{ display: 'block', marginBottom: 12 }}>Booking requests</Text>
      {bookings.length === 0 && !loadingBookings ? (
        <Card size="small">
          <Empty description={<Text type="secondary">No viewing requests yet.</Text>} />
        </Card>
      ) : (
        <Table
          size="small"
          rowKey="id"
          loading={loadingBookings}
          dataSource={bookings}
          columns={bookingColumns}
          pagination={{ pageSize: 10 }}
          scroll={{ x: 'max-content' }}
        />
      )}

      <GenerateViewingLinkModal
        open={genOpen}
        unitId={unitId}
        onClose={() => setGenOpen(false)}
        onCreated={reloadLinks}
      />

      <Drawer
        width={520}
        title="Viewing request"
        open={detailOpen}
        onClose={() => { setDetailOpen(false); setDetailData(null); }}
        extra={detailData && detailData.status === 0 ? (
          <Popconfirm
            title="Cancel this booking?"
            okText="Yes, cancel"
            okType="danger"
            onConfirm={() => handleStaffCancel(detailData.id)}
          >
            <Button danger>Cancel</Button>
          </Popconfirm>
        ) : null}
      >
        {!detailData ? <Paragraph>Loading…</Paragraph> : (
          <>
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 16 }}
              message={`Status: ${BOOKING_STATUS[detailData.status]?.label || 'Pending'}`}
            />
            <Descriptions bordered column={1} size="small">
              <Descriptions.Item label="Proposed">
                {dayjs(detailData.proposed_datetime).format('dddd, MMM D YYYY · h:mm A')}
                {' '}({detailData.duration_minutes} min)
              </Descriptions.Item>
              <Descriptions.Item label="Unit">
                {detailData.unit_name}
              </Descriptions.Item>
              <Descriptions.Item label="Property">
                {detailData.property_name}
              </Descriptions.Item>
              <Descriptions.Item label="Viewer">
                {detailData.viewer_name}<br />
                <Text type="secondary">{detailData.viewer_email}</Text>
                {detailData.viewer_phone && <><br /><Text type="secondary">{detailData.viewer_phone}</Text></>}
              </Descriptions.Item>
              {detailData.viewer_message && (
                <Descriptions.Item label="Message">
                  <div style={{ whiteSpace: 'pre-wrap' }}>{detailData.viewer_message}</div>
                </Descriptions.Item>
              )}
              <Descriptions.Item label="Tenant decision">
                <Tag color={DECISION[detailData.tenant_decision]?.color}>
                  {DECISION[detailData.tenant_decision]?.label}
                </Tag>
                {detailData.tenant_decided_at && (
                  <Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
                    {dayjs(detailData.tenant_decided_at).fromNow ? dayjs(detailData.tenant_decided_at).format('MMM D, HH:mm') : ''}
                  </Text>
                )}
              </Descriptions.Item>
              <Descriptions.Item label="Employee decision">
                <Tag color={DECISION[detailData.employee_decision]?.color}>
                  {DECISION[detailData.employee_decision]?.label}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="Employee">
                {[detailData.employee_first_name, detailData.employee_last_name].filter(Boolean).join(' ')}<br />
                <Text type="secondary">{detailData.employee_email}</Text>
              </Descriptions.Item>
              {detailData.tenant_id && (
                <Descriptions.Item label="Current tenant">
                  {[detailData.tenant_first_name, detailData.tenant_last_name].filter(Boolean).join(' ') || detailData.tenant_company}<br />
                  <Text type="secondary">{detailData.tenant_email}</Text>
                </Descriptions.Item>
              )}
            </Descriptions>
          </>
        )}
      </Drawer>
    </div>
  );
}
