'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import {
  Card, Form, Input, DatePicker, Button, Typography, Alert, Spin, Result, Space, Tag,
} from 'antd';
import { PlusOutlined, MinusCircleOutlined } from '@ant-design/icons';
import { viewingPublic } from '../../../../../lib/bookingApi';
import { formatUnitType } from '../../../../../lib/format';
import dayjs from 'dayjs';

const { Title, Paragraph, Text } = Typography;

// Availability window — keep in sync with backend validateBookingSlot().
// Viewings: Monday–Saturday, 11:00 AM – 7:00 PM (latest end time).
const OPEN_HOUR = 11;
const CLOSE_HOUR = 19;       // 7 PM end-time boundary
const DURATION_MIN = 30;
const LATEST_START_HOUR = 18; // 18:30 is the last valid start
const MAX_CANDIDATES = 3;

const disabledPickerDate = (d) => {
  if (!d) return false;
  if (d.isBefore(dayjs().startOf('day'))) return true;
  if (d.day() === 0) return true; // Sunday
  return false;
};

function buildDisabledTime(busyWindows, pickedDate) {
  return () => {
    if (!pickedDate) {
      const disabledHours = [];
      for (let h = 0; h < 24; h++) if (h < OPEN_HOUR || h > LATEST_START_HOUR) disabledHours.push(h);
      return { disabledHours: () => disabledHours };
    }
    const day = dayjs(pickedDate).startOf('day');
    const dayEnd = day.add(1, 'day');
    const windows = (busyWindows || [])
      .map(w => ({ start: dayjs(w.start), end: dayjs(w.end) }))
      .filter(w => w.end.isAfter(day) && w.start.isBefore(dayEnd));
    const overlaps = (candStart, candEnd) =>
      windows.some(w => candStart.isBefore(w.end) && candEnd.isAfter(w.start));
    return {
      disabledHours: () => {
        const out = [];
        for (let h = 0; h < 24; h++) {
          if (h < OPEN_HOUR || h > LATEST_START_HOUR) { out.push(h); continue; }
          let allBlocked = true;
          const minutes = h === LATEST_START_HOUR ? [0, 15, 30] : [0, 15, 30, 45];
          for (const m of minutes) {
            const candStart = day.hour(h).minute(m);
            if (!overlaps(candStart, candStart.add(DURATION_MIN, 'minute'))) { allBlocked = false; break; }
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
          if (overlaps(candStart, candStart.add(DURATION_MIN, 'minute'))) out.push(m);
        }
        if (selectedHour === LATEST_START_HOUR && !out.includes(45)) out.push(45);
        return out;
      },
    };
  };
}

const slotValidator = (_, value) => {
  if (!value) return Promise.resolve();
  if (value.day() === 0) return Promise.reject(new Error('Sundays are not available'));
  const mins = value.hour() * 60 + value.minute();
  if (mins < OPEN_HOUR * 60) return Promise.reject(new Error('Start time must be 11:00 AM or later'));
  if (mins + DURATION_MIN > CLOSE_HOUR * 60) return Promise.reject(new Error('Viewings must end by 7:00 PM'));
  return Promise.resolve();
};

export default function ViewingInvitePage() {
  const { token } = useParams();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [detail, setDetail] = useState(null);
  const [busyWindows, setBusyWindows] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(null);
  const [fromChat, setFromChat] = useState(false);
  const [form] = Form.useForm();
  const candidateValues = Form.useWatch('candidates', form);

  useEffect(() => {
    if (!token) return;
    viewingPublic.getInvite(token)
      .then((r) => {
        const d = r.data.data;
        setDetail(d);
        setBusyWindows(d.busy || []);
        // Prefill prospect + candidate times. If the bot already parsed times
        // from chat (prefill_times), load them so the prospect can review/fix.
        if (d.ready) {
          const parsedTimes = Array.isArray(d.prefill_times) ? d.prefill_times : [];
          let candidates;
          if (parsedTimes.length) {
            setFromChat(true);
            candidates = parsedTimes.slice(0, d.max_candidates || 3).map((s) => dayjs(s));
          } else {
            candidates = [d.prefill_date ? dayjs(`${d.prefill_date} 11:00`) : undefined];
          }
          form.setFieldsValue({
            prospect_name: d.prospect?.name || '',
            prospect_email: d.prospect?.email || '',
            prospect_phone: d.prospect?.phone || '',
            candidates,
          });
        }
      })
      .catch((e) => setError(e?.response?.data?.message || 'Link not found or no longer active'))
      .finally(() => setLoading(false));
  }, [token, form]);

  const onFinish = async (values) => {
    const candidates = (values.candidates || []).filter(Boolean);
    if (candidates.length === 0) {
      setError('Please propose at least one time');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const payload = {
        prospect_name: values.prospect_name.trim(),
        prospect_email: values.prospect_email.trim(),
        prospect_phone: values.prospect_phone.trim(),
        message: values.message?.trim() || null,
        candidates: candidates.map((c) => c.format('YYYY-MM-DDTHH:mm:ss')),
      };
      const res = await viewingPublic.submitInvite(token, payload);
      setSuccess(res.data.data);
    } catch (e) {
      setError(e?.response?.data?.message || 'Failed to submit your request');
      if (e?.response?.status === 409) {
        // refresh availability so greyed-out slots reflect the latest state
        viewingPublic.getInvite(token)
          .then((r) => setBusyWindows(r.data?.data?.busy || []))
          .catch(() => {});
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <div style={{ textAlign: 'center', padding: 48 }}><Spin size="large" /></div>;

  if (error && !detail) {
    return <Result status="404" title="Link not found" subTitle={error} />;
  }

  // Non-active invite states
  if (detail && detail.state && detail.state !== 'active') {
    const map = {
      used: { status: 'info', title: 'Already submitted', sub: 'This viewing link has already been used. If you need another time, just message us again.' },
      expired: { status: 'warning', title: 'Link expired', sub: 'This viewing link has expired. Message us and we\'ll send a fresh one.' },
      closed: { status: 'info', title: 'No longer available', sub: 'This unit is no longer open for viewings.' },
    };
    const m = map[detail.state] || map.used;
    return <Result status={m.status} title={m.title} subTitle={m.sub} />;
  }

  if (detail && detail.ready === false) {
    return (
      <Result
        status="info"
        title="Not ready yet"
        subTitle={`The viewing link for ${detail.unit?.name || 'this unit'} isn't quite ready — the team hasn't assigned a host yet. Please check back shortly.`}
      />
    );
  }

  if (success) {
    return (
      <Result
        status="success"
        title="Times sent!"
        subTitle={
          success.has_tenant
            ? 'Thanks! The current occupant will pick whichever of your times works best, and we\'ll confirm the viewing with you shortly.'
            : 'Thanks! Our team will confirm one of your proposed times shortly.'
        }
        extra={
          <Space direction="vertical" size={4}>
            <Text type="secondary">You proposed:</Text>
            {(success.candidates || []).map((c, i) => <Tag key={i} color="blue">{c.label}</Tag>)}
          </Space>
        }
      />
    );
  }

  if (!detail) return null;

  return (
    <Card>
      <Title level={3} style={{ marginTop: 0 }}>Propose viewing times</Title>
      <Paragraph style={{ color: '#595959', marginBottom: 16 }}>
        <strong>{detail.unit.name}</strong> at <strong>{detail.property.name}</strong>
        {detail.property.city ? <> &middot; {detail.property.city}</> : null}
      </Paragraph>

      <Space direction="vertical" size={4} style={{ marginBottom: 20 }}>
        {detail.unit.beds != null && (
          <Text type="secondary">
            {Number(detail.unit.beds) === 0 ? 'Studio' : `${detail.unit.beds} bed`}
            {' '}&middot; {detail.unit.baths} bath
            {detail.unit.type ? <> &middot; {formatUnitType(detail.unit.type)}</> : null}
          </Text>
        )}
        <Text type="secondary">Your host: <strong>{detail.employee?.name}</strong></Text>
      </Space>

      <Alert
        style={{ marginBottom: 16 }}
        type={fromChat ? 'warning' : 'info'}
        showIcon
        message={fromChat ? 'Please review the times from your chat' : 'Pick up to 3 times that work for you'}
        description={
          fromChat
            ? 'We filled these in from your messages — please double-check them and fix any that are wrong before sending. The current occupant will then choose whichever suits them. Viewings run Monday–Saturday, 11:00 AM – 7:00 PM.'
            : 'The current occupant will choose whichever one suits them, then we\'ll confirm. Viewings run Monday–Saturday, 11:00 AM – 7:00 PM.'
        }
      />

      {error && (
        <Alert style={{ marginBottom: 16 }} type="error" showIcon message={error} closable onClose={() => setError(null)} />
      )}

      <Form form={form} layout="vertical" onFinish={onFinish} disabled={submitting}>
        <Form.Item name="prospect_name" label="Your name" rules={[{ required: true, message: 'Please enter your name' }]}>
          <Input placeholder="Jane Doe" autoComplete="name" />
        </Form.Item>
        <Form.Item
          name="prospect_email"
          label="Email"
          rules={[{ required: true, message: 'Please enter your email' }, { type: 'email', message: 'Please enter a valid email' }]}
        >
          <Input placeholder="jane@example.com" autoComplete="email" />
        </Form.Item>
        <Form.Item
          name="prospect_phone"
          label="Phone"
          rules={[{ required: true, message: 'Please enter your phone number' }, { min: 7, message: 'Please enter a valid phone number' }]}
        >
          <Input placeholder="+852 0000 0000" autoComplete="tel" />
        </Form.Item>

        <Form.List name="candidates">
          {(fields, { add, remove }) => (
            <>
              {fields.map((field, index) => (
                <Form.Item
                  key={field.key}
                  label={index === 0 ? 'Proposed times' : ' '}
                  style={{ marginBottom: 8 }}
                >
                  <Space align="start">
                    <Form.Item
                      {...field}
                      noStyle
                      rules={[{ required: true, message: 'Pick a time or remove this row' }, { validator: slotValidator }]}
                    >
                      <DatePicker
                        showTime={{ format: 'HH:mm', minuteStep: 15, defaultValue: dayjs().hour(11).minute(0) }}
                        format="YYYY-MM-DD HH:mm"
                        style={{ width: 260 }}
                        disabledDate={disabledPickerDate}
                        disabledTime={buildDisabledTime(busyWindows, candidateValues?.[index])}
                        placeholder="Pick a date & time"
                      />
                    </Form.Item>
                    {fields.length > 1 && (
                      <MinusCircleOutlined style={{ marginTop: 8, color: '#ff4d4f' }} onClick={() => remove(field.name)} />
                    )}
                  </Space>
                </Form.Item>
              ))}
              {fields.length < MAX_CANDIDATES && (
                <Form.Item>
                  <Button type="dashed" onClick={() => add()} icon={<PlusOutlined />} block>
                    Add another time ({fields.length}/{MAX_CANDIDATES})
                  </Button>
                </Form.Item>
              )}
            </>
          )}
        </Form.List>

        <Form.Item name="message" label="Message (optional)">
          <Input.TextArea rows={2} placeholder="Anything the team should know?" />
        </Form.Item>
        <Form.Item>
          <Button type="primary" htmlType="submit" loading={submitting} size="large" block>
            Send my times
          </Button>
        </Form.Item>
      </Form>

      <Paragraph style={{ color: '#8c8c8c', fontSize: 12, marginTop: 16 }}>
        By submitting, you agree to be contacted about this viewing. Your name, email, and phone
        will be saved so the team can reach you about this and future listings.
      </Paragraph>
    </Card>
  );
}
