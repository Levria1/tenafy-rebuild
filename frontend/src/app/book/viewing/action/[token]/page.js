'use client';

import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import {
  Card, Button, Typography, Spin, Result, Alert, Descriptions, Space, Tag,
} from 'antd';
import { CheckCircleFilled, CloseCircleFilled } from '@ant-design/icons';
import { viewingPublic } from '@/lib/bookingApi';
import dayjs from 'dayjs';

const { Title, Paragraph, Text } = Typography;

// Map server status ints to human labels
const STATUS_LABELS = {
  0: { label: 'Pending', color: 'gold' },
  1: { label: 'Confirmed', color: 'green' },
  2: { label: 'Declined', color: 'red' },
  3: { label: 'Cancelled', color: 'default' },
  4: { label: 'Expired', color: 'default' },
};

export default function ViewingActionPage() {
  const { token } = useParams();
  const searchParams = useSearchParams();
  const presetDecision = searchParams.get('decision');

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (!token) return;
    viewingPublic.getAction(token)
      .then((r) => setData(r.data.data))
      .catch((e) => setError(e?.response?.data?.message || 'Link not found'))
      .finally(() => setLoading(false));
  }, [token]);

  const handleDecide = async (decision) => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await viewingPublic.decide(token, decision);
      setResult({ decision, booking_status: res.data.data.booking_status });
    } catch (e) {
      if (e?.response?.status === 410) {
        setError('This booking has already been finalised — no further action is possible.');
      } else {
        setError(e?.response?.data?.message || 'Failed to record decision');
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <div style={{ textAlign: 'center', padding: 48 }}><Spin size="large" /></div>;

  if (error && !data) {
    return <Result status="404" title="Link not found" subTitle={error} />;
  }

  if (result) {
    const statusInfo = STATUS_LABELS[result.booking_status] || STATUS_LABELS[0];
    return (
      <Result
        icon={result.decision === 'approve'
          ? <CheckCircleFilled style={{ color: '#52c41a' }} />
          : <CloseCircleFilled style={{ color: '#ff4d4f' }} />}
        status={result.decision === 'approve' ? 'success' : 'info'}
        title={result.decision === 'approve' ? 'Thanks — approval recorded' : 'Decision recorded'}
        subTitle={
          result.booking_status === 1 ? 'The viewing is confirmed. All parties will receive a calendar invite.' :
          result.booking_status === 2 ? 'The viewing has been declined. The viewer has been notified.' :
          'Awaiting the other party\'s decision.'
        }
        extra={<Tag color={statusInfo.color}>Status: {statusInfo.label}</Tag>}
      />
    );
  }

  const { role, booking, unit, property } = data;
  const alreadyFinalised = booking.status !== 0;

  return (
    <Card>
      <Title level={3} style={{ marginTop: 0 }}>
        {role === 'tenant' ? 'Tenant Approval' : 'Viewing Approval'}
      </Title>
      <Paragraph type="secondary">
        {role === 'tenant'
          ? 'A prospective tenant has requested to view your unit. Please approve or decline.'
          : 'Please approve or decline this viewing request.'}
      </Paragraph>

      <Descriptions bordered column={1} size="small" style={{ marginBottom: 16 }}>
        <Descriptions.Item label="Unit">
          <strong>{unit.name}</strong> at <strong>{property.name}</strong>
          {property.city ? <> &middot; {property.city}</> : null}
        </Descriptions.Item>
        <Descriptions.Item label="Requested time">
          {dayjs(booking.proposed_datetime).format('ddd, MMM D, YYYY · h:mm A')}
          {' '}({booking.duration_minutes} min)
        </Descriptions.Item>
        <Descriptions.Item label="Viewer">
          {booking.viewer_name}<br />
          <Text type="secondary">{booking.viewer_email}</Text>
          {booking.viewer_phone && <> &middot; <Text type="secondary">{booking.viewer_phone}</Text></>}
        </Descriptions.Item>
        {booking.viewer_message && (
          <Descriptions.Item label="Message">
            <div style={{ whiteSpace: 'pre-wrap' }}>{booking.viewer_message}</div>
          </Descriptions.Item>
        )}
      </Descriptions>

      {alreadyFinalised && (
        <Alert
          type="info"
          showIcon
          message={`This booking is already ${STATUS_LABELS[booking.status]?.label.toLowerCase()}.`}
          description="No further action is needed."
          style={{ marginBottom: 16 }}
        />
      )}

      {error && (
        <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />
      )}

      {!alreadyFinalised && (
        <Space size="middle" style={{ width: '100%', justifyContent: 'center' }}>
          <Button
            type="primary"
            size="large"
            icon={<CheckCircleFilled />}
            loading={submitting && presetDecision === 'approve'}
            onClick={() => handleDecide('approve')}
            style={{ background: '#52c41a', borderColor: '#52c41a' }}
          >
            Approve
          </Button>
          <Button
            danger
            size="large"
            icon={<CloseCircleFilled />}
            loading={submitting && presetDecision === 'decline'}
            onClick={() => handleDecide('decline')}
          >
            Decline
          </Button>
        </Space>
      )}
    </Card>
  );
}
