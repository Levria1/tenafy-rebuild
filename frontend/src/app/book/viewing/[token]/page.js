'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import {
  Card, Form, Input, DatePicker, Button, Typography, Alert, Spin, Result, Space, Tag,
} from 'antd';
import { viewingPublic } from '@/lib/bookingApi';
import dayjs from 'dayjs';

const { Title, Paragraph, Text } = Typography;

export default function ViewingBookingFormPage() {
  const { token } = useParams();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [detail, setDetail] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(null);
  const [form] = Form.useForm();

  useEffect(() => {
    if (!token) return;
    viewingPublic.getLink(token)
      .then((r) => setDetail(r.data.data))
      .catch((e) => setError(e?.response?.data?.message || 'Link not found or no longer active'))
      .finally(() => setLoading(false));
  }, [token]);

  const onFinish = async (values) => {
    setSubmitting(true);
    try {
      const payload = {
        viewer_name: values.viewer_name.trim(),
        viewer_email: values.viewer_email.trim(),
        viewer_phone: values.viewer_phone?.trim() || null,
        viewer_message: values.viewer_message?.trim() || null,
        proposed_datetime: values.proposed_datetime.format('YYYY-MM-DDTHH:mm:ss'),
        duration_minutes: 30,
      };
      const res = await viewingPublic.submitBooking(token, payload);
      setSuccess(res.data.data);
    } catch (e) {
      setError(e?.response?.data?.message || 'Failed to submit request');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return <div style={{ textAlign: 'center', padding: 48 }}><Spin size="large" /></div>;
  }

  if (error && !detail) {
    return (
      <Result
        status="404"
        title="Link not found"
        subTitle={error}
      />
    );
  }

  if (success) {
    return (
      <Result
        status="success"
        title="Request received!"
        subTitle="Check your inbox — we've sent you a confirmation. The viewing will be confirmed once the team approves."
        extra={[
          success.manage_url ? (
            <Button key="manage" type="link" href={success.manage_url}>
              Manage your booking
            </Button>
          ) : null,
        ]}
      />
    );
  }

  return (
    <Card>
      <Title level={3} style={{ marginTop: 0 }}>Book a viewing</Title>
      <Paragraph style={{ color: '#595959', marginBottom: 16 }}>
        <strong>{detail.unit.name}</strong> at <strong>{detail.property.name}</strong>
        {detail.property.city ? <> &middot; {detail.property.city}</> : null}
      </Paragraph>

      <Space direction="vertical" size={4} style={{ marginBottom: 20 }}>
        {detail.unit.beds != null && (
          <Text type="secondary">
            {detail.unit.beds} bed &middot; {detail.unit.baths} bath
            {detail.unit.type ? <> &middot; {detail.unit.type}</> : null}
          </Text>
        )}
        <Text type="secondary">Your host: <strong>{detail.employee.name}</strong></Text>
      </Space>

      {detail.upcoming_viewings > 0 && (
        <Alert
          style={{ marginBottom: 16 }}
          type="info"
          showIcon
          message={`This unit has ${detail.upcoming_viewings} other upcoming viewing${detail.upcoming_viewings > 1 ? 's' : ''}.`}
          description="Popular time slots may already be claimed. If your proposed time doesn't work, our team will reach out."
        />
      )}

      {error && (
        <Alert style={{ marginBottom: 16 }} type="error" showIcon message={error} closable onClose={() => setError(null)} />
      )}

      <Form form={form} layout="vertical" onFinish={onFinish} disabled={submitting}>
        <Form.Item
          name="viewer_name"
          label="Your name"
          rules={[{ required: true, message: 'Please enter your name' }]}
        >
          <Input placeholder="Jane Doe" autoComplete="name" />
        </Form.Item>
        <Form.Item
          name="viewer_email"
          label="Email"
          rules={[
            { required: true, message: 'Please enter your email' },
            { type: 'email', message: 'Please enter a valid email' },
          ]}
        >
          <Input placeholder="jane@example.com" autoComplete="email" />
        </Form.Item>
        <Form.Item name="viewer_phone" label="Phone (optional)">
          <Input placeholder="+254 700 000 000" autoComplete="tel" />
        </Form.Item>
        <Form.Item
          name="proposed_datetime"
          label="Proposed date & time"
          rules={[{ required: true, message: 'Please pick a date and time' }]}
        >
          <DatePicker
            showTime={{ format: 'HH:mm', minuteStep: 15 }}
            format="YYYY-MM-DD HH:mm"
            style={{ width: '100%' }}
            disabledDate={(d) => d && d.isBefore(dayjs().startOf('day'))}
            placeholder="Pick when you'd like to visit"
          />
        </Form.Item>
        <Form.Item name="viewer_message" label="Message (optional)">
          <Input.TextArea rows={3} placeholder="Anything the team should know?" />
        </Form.Item>
        <Form.Item>
          <Button type="primary" htmlType="submit" loading={submitting} size="large" block>
            Request viewing
          </Button>
        </Form.Item>
      </Form>

      <Paragraph style={{ color: '#8c8c8c', fontSize: 12, marginTop: 16 }}>
        By submitting, you agree to be contacted about this viewing. Your request is sent to the
        property team for approval — if the unit is currently occupied, the tenant is also asked to approve.
      </Paragraph>
    </Card>
  );
}
