'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Card, Button, Typography, Alert, Spin, Result, Space, Tag } from 'antd';
import { CalendarOutlined } from '@ant-design/icons';
import { viewingPublic } from '../../../../../lib/bookingApi';
import dayjs from 'dayjs';

const { Title, Paragraph, Text } = Typography;

const fmt = (dt) => (dt ? dayjs(dt).format('ddd, MMM D, YYYY · h:mm A') : '');

export default function ViewingConfirmPage() {
  const { token } = useParams();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [detail, setDetail] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmed, setConfirmed] = useState(null);

  useEffect(() => {
    if (!token) return;
    viewingPublic.getConfirm(token)
      .then((r) => setDetail(r.data.data))
      .catch((e) => setError(e?.response?.data?.message || 'Link not found'))
      .finally(() => setLoading(false));
  }, [token]);

  const onConfirm = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await viewingPublic.pickConfirm(token);
      setConfirmed(res.data.data);
    } catch (e) {
      if (e?.response?.status === 410) {
        setError('This request has already been finalised.');
        viewingPublic.getConfirm(token).then((r) => setDetail(r.data.data)).catch(() => {});
      } else {
        setError(e?.response?.data?.message || 'Failed to confirm the time');
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <div style={{ textAlign: 'center', padding: 48 }}><Spin size="large" /></div>;

  if (error && !detail) return <Result status="404" title="Link not found" subTitle={error} />;

  if (confirmed) {
    return (
      <Result
        status="success"
        title="Viewing confirmed"
        subTitle={`Thank you! The viewing is set for ${fmt(confirmed.proposed_datetime)}. Everyone has been notified and a calendar invite is on its way.`}
      />
    );
  }

  if (detail && detail.state === 'picked') {
    return (
      <Result
        status="success"
        title="Already confirmed"
        subTitle={`This time is confirmed: ${fmt(detail.candidate?.proposed_datetime)}.`}
      />
    );
  }
  if (detail && detail.state === 'already_confirmed') {
    return (
      <Result
        status="info"
        title="A time was already chosen"
        subTitle="Another of the proposed times has already been confirmed for this viewing."
      />
    );
  }
  if (detail && detail.state === 'closed') {
    return (
      <Result
        status="warning"
        title="No longer available"
        subTitle="This viewing request has been cancelled or is no longer active."
      />
    );
  }

  if (!detail) return null;

  const others = (detail.all_candidates || []).filter(
    (c) => dayjs(c.proposed_datetime).valueOf() !== dayjs(detail.candidate?.proposed_datetime).valueOf()
  );

  return (
    <Card>
      <Title level={3} style={{ marginTop: 0 }}>Confirm a viewing time</Title>
      <Paragraph style={{ color: '#595959', marginBottom: 16 }}>
        A prospective viewer would like to see <strong>{detail.unit?.name}</strong> at{' '}
        <strong>{detail.property?.name}</strong>. Confirm the time below if it works for you.
      </Paragraph>

      {error && (
        <Alert style={{ marginBottom: 16 }} type="error" showIcon message={error} closable onClose={() => setError(null)} />
      )}

      <Card type="inner" style={{ marginBottom: 16, textAlign: 'center', borderColor: '#1677ff' }}>
        <CalendarOutlined style={{ fontSize: 28, color: '#1677ff' }} />
        <Title level={4} style={{ margin: '8px 0 0' }}>{fmt(detail.candidate?.proposed_datetime)}</Title>
        <Text type="secondary">{detail.candidate?.duration_minutes || 30} minutes</Text>
      </Card>

      <Button type="primary" size="large" block loading={submitting} onClick={onConfirm}>
        Confirm this time
      </Button>

      {others.length > 0 && (
        <Paragraph style={{ color: '#8c8c8c', fontSize: 13, marginTop: 16 }}>
          Other times the viewer proposed (open the matching link to pick one instead):
          <br />
          <Space size={[8, 8]} wrap style={{ marginTop: 8 }}>
            {others.map((c, i) => <Tag key={i}>{fmt(c.proposed_datetime)}</Tag>)}
          </Space>
        </Paragraph>
      )}

      <Paragraph style={{ color: '#8c8c8c', fontSize: 12, marginTop: 16 }}>
        Confirming notifies the viewer and the property team, and releases the other proposed times.
      </Paragraph>
    </Card>
  );
}
