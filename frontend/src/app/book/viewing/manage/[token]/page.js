'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import {
  Card, Button, Typography, Spin, Result, Alert, Descriptions, Popconfirm, Tag,
} from 'antd';
import { viewingPublic } from '../../../../../lib/bookingApi';
import dayjs from 'dayjs';

const { Title, Paragraph, Text } = Typography;

const STATUS_LABELS = {
  0: { label: 'Pending approval', color: 'gold' },
  1: { label: 'Confirmed', color: 'green' },
  2: { label: 'Declined', color: 'red' },
  3: { label: 'Cancelled', color: 'default' },
  4: { label: 'Expired', color: 'default' },
};

export default function ManageViewingPage() {
  const { token } = useParams();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);
  const [cancelled, setCancelled] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    if (!token) return;
    viewingPublic.getManage(token)
      .then((r) => setData(r.data.data))
      .catch((e) => setError(e?.response?.data?.message || 'Link not found'))
      .finally(() => setLoading(false));
  }, [token]);

  const handleCancel = async () => {
    setCancelling(true);
    try {
      await viewingPublic.cancel(token);
      setCancelled(true);
    } catch (e) {
      setError(e?.response?.data?.message || 'Failed to cancel');
    } finally {
      setCancelling(false);
    }
  };

  if (loading) return <div style={{ textAlign: 'center', padding: 48 }}><Spin size="large" /></div>;

  if (error && !data) return <Result status="404" title="Link not found" subTitle={error} />;
  if (cancelled) {
    return <Result status="success" title="Viewing cancelled" subTitle="We've notified everyone involved." />;
  }

  const { booking, unit, property } = data;
  const statusInfo = STATUS_LABELS[booking.status] || STATUS_LABELS[0];
  const isActive = booking.status === 0 || booking.status === 1;

  return (
    <Card>
      <Title level={3} style={{ marginTop: 0 }}>Your viewing</Title>
      <Paragraph>
        <Tag color={statusInfo.color} style={{ fontSize: 14 }}>{statusInfo.label}</Tag>
      </Paragraph>

      <Descriptions bordered column={1} size="small" style={{ marginBottom: 16 }}>
        <Descriptions.Item label="Unit">
          <strong>{unit.name}</strong> at <strong>{property.name}</strong>
          {property.city ? <> &middot; {property.city}</> : null}
        </Descriptions.Item>
        <Descriptions.Item label="When">
          {dayjs(booking.proposed_datetime).format('ddd, MMM D, YYYY · h:mm A')}
          {' '}({booking.duration_minutes} min)
        </Descriptions.Item>
        <Descriptions.Item label="Name">
          {booking.viewer_name} &middot; <Text type="secondary">{booking.viewer_email}</Text>
        </Descriptions.Item>
      </Descriptions>

      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />}

      {isActive ? (
        <Popconfirm
          title="Cancel this viewing?"
          description="Everyone involved will be notified."
          okText="Yes, cancel"
          cancelText="Keep it"
          onConfirm={handleCancel}
        >
          <Button danger size="large" loading={cancelling} block>
            Cancel viewing
          </Button>
        </Popconfirm>
      ) : (
        <Paragraph type="secondary">This booking is no longer active.</Paragraph>
      )}
    </Card>
  );
}
