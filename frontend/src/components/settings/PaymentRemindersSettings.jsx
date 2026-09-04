'use client';

/**
 * Automatic overdue payment reminders.
 *
 * This screen controls one scheduled job: the Monday sweep that emails tenants
 * about invoices they have not paid. It lives here rather than on the
 * Overdue-Tenant email template because the policy is about WHICH invoices get
 * chased and HOW OFTEN, which is not a property of a template.
 *
 * Categories are a searchable multi-select. This org has 103 enabled categories,
 * which is well past the point where a flat grid of tickboxes reads as a wall,
 * and typing three letters beats scanning for a name you already know.
 *
 * The options are grouped by whether a category has ever carried a charge to a
 * tenant. 73 of the 103 never have: Salaries, MPF, Petty Cash, the whole
 * expense side of the ledger. They stay in the list rather than being filtered
 * out, because "you cannot pick it" and "we did not list it" are different
 * promises — they just sit below the ones that matter.
 *
 * Selections render as tags in the control, so what is chosen stays visible
 * without opening anything.
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
  Card, Form, Switch, Select, InputNumber, Button, Alert, Space,
  Typography, message, Spin, Divider,
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

  // The backend already orders by charge_count, so the first group arrives in
  // the order someone would actually reach for. Empty groups are dropped rather
  // than rendered as a bare heading over nothing.
  const options = useMemo(() => {
    const label = (c) => (c.charge_count > 0 ? `${c.name} (${c.charge_count})` : c.name);
    const groups = [
      {
        label: 'Charged to tenants',
        options: available.filter((c) => c.charge_count > 0)
          .map((c) => ({ value: c.id, label: label(c) })),
      },
      {
        label: 'Never charged to a tenant',
        options: available.filter((c) => c.charge_count === 0)
          .map((c) => ({ value: c.id, label: label(c) })),
      },
    ];
    return groups.filter((g) => g.options.length > 0);
  }, [available]);

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

        <Select
          mode="multiple"
          allowClear
          showSearch
          value={picked}
          onChange={setPicked}
          placeholder="Rent only"
          // Search the visible label, not the value: the values are Snowflake
          // ids, so the default would have people typing digits.
          optionFilterProp="label"
          options={options}
          style={{ width: '100%' }}
        />

        {picked.length === 0 && (
          <Alert
            type="info"
            showIcon
            style={{ marginTop: 12 }}
            message="Rent only"
            description="Leaving this empty means rent, which is the sensible default. The Overdue email threatens a late fee of 5% of the monthly rent, which does not read sensibly attached to a utility bill or a stamp duty charge."
          />
        )}

        <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
          The number beside a category is how many charges it has carried to a tenant.
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
