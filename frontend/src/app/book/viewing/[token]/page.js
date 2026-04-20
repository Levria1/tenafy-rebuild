'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import {
  Card, Form, Input, DatePicker, Button, Typography, Alert, Spin, Result, Space, Tag,
} from 'antd';
import { viewingPublic } from '../../../../lib/bookingApi';
import { formatBeds, formatUnitType } from '../../../../lib/format';
import dayjs from 'dayjs';

const { Title, Paragraph, Text } = Typography;

// Availability window — keep in sync with backend validateBookingSlot() in
// backend/src/routes/viewingPublic.js.
// Viewings: Monday-Saturday, 11:00 AM – 7:00 PM (latest end time).
const OPEN_HOUR = 11;
const CLOSE_HOUR = 19; // 7 PM, end-time boundary
const DURATION_MIN = 30;
const LATEST_START_HOUR = 18; // 18:30 is the last valid start (ends 19:00)

const disabledPickerDate = (d) => {
  if (!d) return false;
  // Block past dates and Sundays (day 0)
  if (d.isBefore(dayjs().startOf('day'))) return true;
  if (d.day() === 0) return true;
  return false;
};

/**
 * Given the busy windows from the availability API, return the set of
 * disabled time-picker constraints for a selected date. A candidate slot
 * (pickedDate at HH:MM for DURATION_MIN) is disabled if it overlaps any
 * busy window.
 */
function buildDisabledTime(busyWindows, pickedDate) {
  return () => {
    if (!pickedDate) {
      const disabledHours = [];
      for (let h = 0; h < 24; h++) {
        if (h < OPEN_HOUR || h > LATEST_START_HOUR) disabledHours.push(h);
      }
      return { disabledHours: () => disabledHours };
    }

    const day = dayjs(pickedDate).startOf('day');
    const dayEnd = day.add(1, 'day');
    const windows = (busyWindows || [])
      .map(w => ({ start: dayjs(w.start), end: dayjs(w.end) }))
      .filter(w => w.end.isAfter(day) && w.start.isBefore(dayEnd));

    // Helper — does a candidate [candStart, candEnd] overlap any busy window?
    const overlaps = (candStart, candEnd) =>
      windows.some(w => candStart.isBefore(w.end) && candEnd.isAfter(w.start));

    return {
      disabledHours: () => {
        const out = [];
        for (let h = 0; h < 24; h++) {
          if (h < OPEN_HOUR || h > LATEST_START_HOUR) { out.push(h); continue; }
          // An hour is disabled only if EVERY minute-slot in it is blocked.
          let allBlocked = true;
          const minutes = h === LATEST_START_HOUR ? [0, 15, 30] : [0, 15, 30, 45];
          for (const m of minutes) {
            const candStart = day.hour(h).minute(m);
            const candEnd = candStart.add(DURATION_MIN, 'minute');
            if (!overlaps(candStart, candEnd)) { allBlocked = false; break; }
          }
          if (allBlocked) out.push(h);
        }
        return out;
      },
      disabledMinutes: (selectedHour) => {
        const out = [];
        const minutes = selectedHour === LATEST_START_HOUR ? [0, 15, 30] : [0, 15, 30, 45];
        for (const m of minutes) {
          const candStart = day.hour(selectedHour).minute(m);
          const candEnd = candStart.add(DURATION_MIN, 'minute');
          if (overlaps(candStart, candEnd)) out.push(m);
        }
        // Always block :45 on the last allowed hour (ends after 19:00)
        if (selectedHour === LATEST_START_HOUR && !out.includes(45)) out.push(45);
        return out;
      },
    };
  };
}

export default function ViewingBookingFormPage() {
  const { token } = useParams();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [detail, setDetail] = useState(null);
  const [busyWindows, setBusyWindows] = useState([]);
  const [pickedDate, setPickedDate] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(null);
  const [form] = Form.useForm();

  useEffect(() => {
    if (!token) return;
    viewingPublic.getLink(token)
      .then((r) => setDetail(r.data.data))
      .catch((e) => setError(e?.response?.data?.message || 'Link not found or no longer active'))
      .finally(() => setLoading(false));
    // Fetch taken slots so the picker can grey them out.
    viewingPublic.getAvailability(token)
      .then((r) => setBusyWindows(r.data?.data?.busy || []))
      .catch(() => { /* non-fatal — picker just won't grey out */ });
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
      // If it was a conflict, refresh availability so the picker shows the fresh state
      if (e?.response?.status === 409) {
        viewingPublic.getAvailability(token)
          .then((r) => setBusyWindows(r.data?.data?.busy || []))
          .catch(() => {});
      }
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

  if (detail && detail.ready === false) {
    return (
      <Result
        status="info"
        title="Not ready yet"
        subTitle={`The viewing link for ${detail.unit?.name || 'this unit'} isn't quite ready. The property team hasn't assigned a host yet. Please check back shortly or contact them directly.`}
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
            {Number(detail.unit.beds) === 0
              ? 'Studio'
              : `${detail.unit.beds} bed`}
            {' '}&middot; {detail.unit.baths} bath
            {detail.unit.type ? <> &middot; {formatUnitType(detail.unit.type)}</> : null}
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
        <Form.Item
          name="viewer_phone"
          label="Phone"
          rules={[
            { required: true, message: 'Please enter your phone number' },
            { min: 7, message: 'Please enter a valid phone number' },
          ]}
        >
          <Input placeholder="+254 700 000 000" autoComplete="tel" />
        </Form.Item>
        <Form.Item
          name="proposed_datetime"
          label="Proposed date & time"
          extra="Viewings run Monday–Saturday, 11:00 AM – 7:00 PM. Sunday is closed."
          rules={[
            { required: true, message: 'Please pick a date and time' },
            {
              validator: (_, value) => {
                if (!value) return Promise.resolve();
                if (value.day() === 0) return Promise.reject(new Error('Sundays are not available'));
                const mins = value.hour() * 60 + value.minute();
                if (mins < OPEN_HOUR * 60) return Promise.reject(new Error('Start time must be 11:00 AM or later'));
                if (mins + DURATION_MIN > CLOSE_HOUR * 60) return Promise.reject(new Error('Viewings must end by 7:00 PM'));
                return Promise.resolve();
              },
            },
          ]}
        >
          <DatePicker
            showTime={{ format: 'HH:mm', minuteStep: 15, defaultValue: dayjs().hour(11).minute(0) }}
            format="YYYY-MM-DD HH:mm"
            style={{ width: '100%' }}
            disabledDate={disabledPickerDate}
            disabledTime={buildDisabledTime(busyWindows, pickedDate)}
            onChange={(d) => setPickedDate(d)}
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
        By submitting, you agree to be contacted about this viewing. Your name, email, and phone
        will be saved in the property team's contact list so they can reach you about this and
        future listings. Your request is sent to the property team for approval — if the unit is
        currently occupied, the tenant is also asked to approve.
      </Paragraph>
    </Card>
  );
}
