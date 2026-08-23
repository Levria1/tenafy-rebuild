'use client';

/**
 * Email Timing card for the email-template editor.
 *
 * Only THREE template types actually read these fields:
 *   Invoice-Tenant   → date_first + date_second (scheduler reminder lead times)
 *   Checkin-Tenant   → date_first + date_second (first email + follow-up, both
 *                                                read by the 07:00 sweep;
 *                                                before_date is NOT read)
 *   Checkout-Tenant  → date_first + before_date (leasing.js send window)
 *
 * Every other type is EVENT-DRIVEN — it sends the moment its trigger happens, so
 * whatever is entered here is silently ignored. Previously the fields looked
 * fully functional for all types, so staff could set "7 days" on e.g. Payment
 * Options and reasonably expect a delay that never existed. For those types we
 * disable the inputs and say what actually triggers the send.
 */

import { Card, Row, Col, Form, Radio, InputNumber, Tooltip, Alert } from 'antd';
import { InfoCircleOutlined } from '@ant-design/icons';

// Types whose timing fields are genuinely read by the backend.
export const TIMING_AWARE_TYPES = ['Invoice-Tenant', 'Checkin-Tenant', 'Checkout-Tenant'];

// What actually triggers the send, for the types we've verified. Anything not
// listed falls back to the generic wording below.
const FIRES_WHEN = {
  'Payment-Options': 'a lease is saved with “Send Payment Options” ticked',
  'Lease-Signature-Request': 'a lease is sent for e-signature',
  'Lease-Signed': 'all parties have signed the lease',
  'Renewal-Tenant': 'the lease’s own “renewal days” value triggers it (that setting lives on the lease, not here)',
};

/**
 * @param withDefaults  true on the CREATE form (seed 1/0/0). The EDIT form must
 *   pass false — it populates from the saved template, and a Form.Item
 *   initialValue there can stomp a loaded value on remount.
 */
export default function EmailTimingCard({ selectedType, withDefaults = true }) {
  const applies = !selectedType || TIMING_AWARE_TYPES.includes(selectedType);
  const trigger = FIRES_WHEN[selectedType];
  const def = (v) => (withDefaults ? { initialValue: v } : {});

  return (
    <Card
      size="small"
      style={{ marginBottom: 24, background: '#fafafa', opacity: applies ? 1 : 0.85 }}
    >
      <div style={{ fontWeight: 600, marginBottom: 12 }}>
        Email Timing{' '}
        <Tooltip
          title={
            applies
              ? 'Controls how many days before/after the event this email is sent. Only Invoice, Check-In and Check-Out templates use these.'
              : `Not used for this template type. ${selectedType || 'This template'} is sent as soon as its event happens, so these values are ignored.`
          }
        >
          <InfoCircleOutlined style={{ color: '#8c8c8c' }} />
        </Tooltip>
      </div>

      {!applies && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="Timing doesn’t apply to this template"
          description={
            <>
              This email is sent immediately when {trigger || 'its triggering event happens'} — not on a schedule,
              so these fields are ignored. Only <strong>Invoice</strong>, <strong>Check-In</strong> and{' '}
              <strong>Check-Out</strong> templates use them.
            </>
          }
        />
      )}

      <Row gutter={16} align="middle">
        <Col xs={24} md={8}>
          <Form.Item name="before_date" label="Send Timing" {...def(1)} style={{ marginBottom: 0 }}>
            <Radio.Group disabled={!applies}>
              <Radio value={1}>Before event</Radio>
              <Radio value={0}>After event</Radio>
            </Radio.Group>
          </Form.Item>
        </Col>
        <Col xs={12} md={8}>
          <Form.Item name="date_first" label="First Email (days)" {...def(0)} style={{ marginBottom: 0 }}>
            <InputNumber min={0} max={365} style={{ width: '100%' }} placeholder="e.g. 7" disabled={!applies} />
          </Form.Item>
        </Col>
        <Col xs={12} md={8}>
          <Form.Item name="date_second" label="Second Email (days)" {...def(0)} style={{ marginBottom: 0 }}>
            <InputNumber min={0} max={365} style={{ width: '100%' }} placeholder="e.g. 3" disabled={!applies} />
          </Form.Item>
        </Col>
      </Row>

      {applies && (
        <div style={{ marginTop: 8, color: '#888', fontSize: 12 }}>
          Example: Check-In set to &quot;Before event&quot; + 7 days = email sent 7 days before lease start date.
          Set to 0 to disable.
        </div>
      )}
    </Card>
  );
}
