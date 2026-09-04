'use client';

/**
 * Automatic overdue payment reminders.
 *
 * This screen controls one scheduled job: the Monday sweep that emails tenants
 * about invoices they have not paid. It lives here rather than on the
 * Overdue-Tenant email template because the policy is about WHICH invoices get
 * chased and HOW OFTEN, which is not a property of a template.
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

import { useEffect, useState } from 'react';
import { Card, Form, Switch, Select, InputNumber, Button, Alert, Space, Typography, message, Spin } from 'antd';
import { settings } from '../../lib/api';

const { Text } = Typography;

export default function PaymentRemindersSettings() {
  const [form] = Form.useForm();
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [enabled, setEnabled] = useState(false);

  useEffect(() => { load(); }, []);

  const load = async () => {
    try {
      setLoading(true);
      const [policyRes, catRes] = await Promise.all([
        settings.getPaymentReminders(),
        settings.getCategories(),
      ]);
      const policy = policyRes.data?.data || {};
      setCategories(catRes.data?.data || []);
      const on = Number(policy.enabled) === 1;
      setEnabled(on);
      form.setFieldsValue({
        enabled: on,
        // null means "rent only", which the backend resolves at send time. The
        // picker shows it as empty rather than inventing a selection, so saving
        // an untouched form cannot silently pin the rent category by id.
        categories: policy.categories || [],
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
        categories: values.categories?.length ? values.categories : null,
      });
      message.success('Saved');
      load();
    } catch (err) {
      message.error(err?.response?.data?.message || 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Card><Spin /></Card>;

  return (
    <Card>
      <Form form={form} layout="vertical" onFinish={onSave} style={{ maxWidth: 640 }}>
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

        <Form.Item
          name="categories"
          label="Which charges to chase"
          extra="Leave empty to chase rent only. The Overdue email threatens a late fee of 5% of the monthly rent, which does not read sensibly on a utility bill or a stamp duty charge."
        >
          <Select
            mode="multiple"
            allowClear
            placeholder="Rent only"
            optionFilterProp="label"
            options={categories.map((c) => ({ value: String(c.id), label: c.name }))}
          />
        </Form.Item>

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
