'use client';

/**
 * Automatic overdue payment reminders.
 *
 * This screen controls one scheduled job: the Monday sweep that emails tenants
 * about invoices they have not paid. It lives here rather than on the
 * Overdue-Tenant email template because the policy is about WHICH invoices get
 * chased and HOW OFTEN, which is not a property of a template.
 *
 * Categories are ticks, not a dropdown. Who gets chased is the consequential
 * part of this screen, and a closed multi-select shows it as a row of tags you
 * have to open something to verify. Laid out flat, the policy is legible at a
 * glance and a mis-tick is visible without hunting for it.
 *
 * The list is split by whether a category has ever carried a charge to a
 * tenant. Around thirty categories are enabled and most are the expense side of
 * the ledger, which can never appear on a tenant invoice; burying those keeps
 * the real choices readable. They stay reachable rather than hidden, because
 * "you cannot pick it" and "we did not list it" are different promises.
 *
 * Two separate day counts, because they answer different questions. "Days after
 * due" is the rope a late payer gets. "Days after the invoice was raised" is a
 * guard against back-dated bills: a utility invoice is dated to the end of its
 * meter period, so it is already past due on the day it is created, and without
 * this the tenant's first ever notice of the charge would be a late-payment
 * demand.
 *
 * The master switch defaults to off and says so plainly. This job messages real
 * tenants unattended and the backlog it can reach is years deep.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Card, Form, Switch, Checkbox, InputNumber, Button, Alert, Space,
  Typography, message, Spin, Row, Col, Divider, Tag,
} from 'antd';
import { settings } from '../../lib/api';

const { Text } = Typography;

export default function PaymentRemindersSettings() {
  const [form] = Form.useForm();
  const [available, setAvailable] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [picked, setPicked] = useState([]);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => { load(); }, []);

  const load = async () => {
    try {
      setLoading(true);
      const res = await settings.getPaymentReminders();
      const policy = res.data?.data || {};
      setAvailable(policy.categories_available || []);
      const on = Number(policy.enabled) === 1;
      const chosen = policy.categories || [];
      setEnabled(on);
      setPicked(chosen);
      // A saved category with no charges against it sits in the "other" group.
      // Open that group so a ticked box is never rendered out of sight.
      const others = (policy.categories_available || [])
        .filter((c) => c.charge_count === 0)
        .map((c) => c.id);
      if (chosen.some((id) => others.includes(id))) setShowAll(true);
      form.setFieldsValue({
        enabled: on,
        days_after_due: policy.days_after_due ?? 0,
        days_after_issue: policy.days_after_issue ?? 7,
        repeat_days: policy.repeat_days ?? 7,
      });
    } catch (err) {
      message.error('Could not load reminder settings');
    } finally {
      setLoading(false);
    }
  };

  const onSave = async (values) => {
    try {
      setSaving(true);
      await settings.updatePaymentReminders({
        ...values,
        enabled: values.enabled ? 1 : 0,
        // Empty means "rent only", resolved by the backend at send time. Sending
        // null rather than [] keeps that distinct from "chase nothing".
        categories: picked.length ? picked : null,
      });
      message.success('Saved');
      load();
    } catch (err) {
      message.error(err?.response?.data?.message || 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  const { charged, unused } = useMemo(() => ({
    charged: available.filter((c) => c.charge_count > 0),
    unused: available.filter((c) => c.charge_count === 0),
  }), [available]);

  const toggle = (id, on) =>
    setPicked((prev) => (on ? [...new Set([...prev, id])] : prev.filter((x) => x !== id)));

  const boxes = (list, { muted } = {}) => (
    <Row gutter={[8, 8]}>
      {list.map((c) => (
        <Col xs={24} sm={12} md={8} key={c.id}>
          <Checkbox
            checked={picked.includes(c.id)}
            onChange={(e) => toggle(c.id, e.target.checked)}
          >
            <span style={{ color: muted ? '#8c8c8c' : undefined }}>{c.name}</span>
            {!muted && (
              <Text type="secondary" style={{ fontSize: 12, marginLeft: 6 }}>
                {c.charge_count}
              </Text>
            )}
          </Checkbox>
        </Col>
      ))}
    </Row>
  );

  if (loading) return <Card><Spin /></Card>;

  return (
    <Card>
      <Form form={form} layout="vertical" onFinish={onSave} style={{ maxWidth: 760 }}>
        <Alert
          type={enabled ? 'warning' : 'info'}
          showIcon
          style={{ marginBottom: 24 }}
          message={enabled ? 'Reminders are being sent automatically' : 'Reminders are off'}
          description={
            enabled
              ? 'Every Monday morning, tenants with unpaid invoices matching the rules below are emailed the Overdue template. Nobody reviews these before they go out.'
              : 'Nothing is sent automatically. You can still chase any individual invoice by opening it and pressing Email.'
          }
        />

        <Form.Item
          name="enabled"
          label="Send reminders automatically"
          valuePropName="checked"
          extra="Runs every Monday at 9am. Switching this on can reach older unpaid invoices, so check the amounts first."
        >
          <Switch onChange={setEnabled} />
        </Form.Item>

        <Divider orientation="left" plain style={{ marginTop: 32 }}>Which charges to chase</Divider>

        {picked.length === 0 ? (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message="Rent only"
            description="Nothing ticked means rent, which is the sensible default. The Overdue email threatens a late fee of 5% of the monthly rent, which does not read sensibly attached to a utility bill or a stamp duty charge."
          />
        ) : (
          <div style={{ marginBottom: 16 }}>
            {picked.map((id) => {
              const c = available.find((x) => x.id === id);
              return <Tag key={id} color="blue">{c ? c.name : id}</Tag>;
            })}
          </div>
        )}

        {boxes(charged)}

        {unused.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setShowAll((v) => !v)}>
              {showAll
                ? 'Hide categories never charged to a tenant'
                : `Show ${unused.length} more (never charged to a tenant)`}
            </Button>
            {showAll && <div style={{ marginTop: 8 }}>{boxes(unused, { muted: true })}</div>}
          </div>
        )}

        <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
          The number beside each category is how many tenant charges it has carried.
        </Text>

        <Divider orientation="left" plain style={{ marginTop: 32 }}>Timing</Divider>

        <Form.Item
          name="days_after_due"
          label="Start chasing this many days after the due date"
          extra="0 means the day after the invoice was due."
        >
          <InputNumber min={0} max={365} style={{ width: 120 }} addonAfter="days" />
        </Form.Item>

        <Form.Item
          name="days_after_issue"
          label="Never chase an invoice raised in the last"
          extra="Protects back-dated charges. A utility bill is dated to the end of its meter period, so it is already overdue on the day you create it."
        >
          <InputNumber min={0} max={365} style={{ width: 120 }} addonAfter="days" />
        </Form.Item>

        <Form.Item
          name="repeat_days"
          label="Chase the same invoice again every"
          extra="Counted per invoice, from the last reminder actually sent for it."
        >
          <InputNumber min={1} max={365} style={{ width: 120 }} addonAfter="days" />
        </Form.Item>

        <Space>
          <Button type="primary" htmlType="submit" loading={saving}>Save</Button>
          <Text type="secondary">Tenants who have moved out are never chased automatically.</Text>
        </Space>
      </Form>
    </Card>
  );
}
