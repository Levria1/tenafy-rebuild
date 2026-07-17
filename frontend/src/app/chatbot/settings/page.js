'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Card, Typography, Switch, InputNumber, Button, Space, Form, Row, Col, message, Alert, Spin,
} from 'antd';
import { SaveOutlined, ReloadOutlined } from '@ant-design/icons';
import MainLayout from '../../../components/Layout';
import { chatApi } from '../../../lib/api';

const { Title, Text, Paragraph } = Typography;

const CAPABILITY_LABELS = [
  { key: 'can_search', label: 'Search available units', description: 'Bot can answer "what 2BRs under $1500 do you have?"' },
  { key: 'can_show_details', label: 'Show unit / property details', description: 'Bot can pull photos, amenities, full descriptions' },
  { key: 'can_answer_pricing', label: 'Answer pricing questions', description: 'Bot can quote rent, deposits, utility costs' },
  { key: 'can_book_viewings', label: 'Book viewings', description: 'Bot can create viewing bookings (with explicit user confirmation)' },
  { key: 'can_capture_leads', label: 'Capture leads', description: 'Bot can save contact info as a prospect in the contacts list' },
  // Internal-staff-only tools. Off these for any bot exposed to prospects (e.g. TaneChat).
  { key: 'can_search_inquiries', label: 'Search inquiries (PII)', description: 'Bot can look up prospects by name, phone, budget, or topic mentioned in chat history' },
  { key: 'can_search_leases',    label: 'Search leases (PII)',    description: 'Bot can find current/past/expiring leases by tenant, unit, or property' },
  { key: 'can_search_invoices',  label: 'Search invoices (PII)',  description: 'Bot can answer "who\'s behind on rent?" and pull outstanding/overdue balances' },
  { key: 'can_search_services',  label: 'Search service requests', description: 'Bot can find open maintenance jobs, AC issues, vendor assignments' },
  { key: 'can_search_documents', label: 'Search lease documents', description: 'Bot can find unsigned leases, lease templates, signature status' },
];

export default function ChatSettingsPage() {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [settings, setSettings] = useState(null);

  const reload = useCallback(() => {
    setLoading(true);
    chatApi.getSettings()
      .then((r) => {
        const s = r.data.data;
        setSettings(s);
        form.setFieldsValue({
          enabled: Boolean(s.enabled),
          ...Object.fromEntries(CAPABILITY_LABELS.map(c => [c.key, Boolean(s.capabilities?.[c.key])])),
          max_bookings_per_session: s.max_bookings_per_session,
          max_messages_per_session: s.max_messages_per_session,
          max_messages_per_day: s.max_messages_per_day,
        });
      })
      .catch(() => message.error('Failed to load settings'))
      .finally(() => setLoading(false));
  }, [form]);

  useEffect(() => { reload(); }, [reload]);

  const handleSave = async (values) => {
    setSaving(true);
    try {
      const capabilities = Object.fromEntries(
        CAPABILITY_LABELS.map(c => [c.key, Boolean(values[c.key])])
      );
      await chatApi.updateSettings({
        enabled: Boolean(values.enabled),
        capabilities,
        // Legacy fields — actively cleared on every save now that the
        // Rules + FAQ pages are the source of truth. Sending null wipes any
        // stale text so the bot doesn't silently append it.
        custom_instructions: null,
        system_prompt: null,
        max_bookings_per_session: values.max_bookings_per_session,
        max_messages_per_session: values.max_messages_per_session,
        max_messages_per_day: values.max_messages_per_day,
      });
      message.success('Settings saved');
      reload();
    } catch (e) {
      message.error(e?.response?.data?.message || 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <MainLayout><div style={{ textAlign: 'center', padding: 48 }}><Spin size="large" /></div></MainLayout>;
  }

  const locked = settings?.settings_locked;

  return (
    <MainLayout>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <Title level={4} style={{ margin: 0 }}>Chatbot Settings</Title>
          <Text type="secondary">Configure what the bot can do and how it sounds.</Text>
        </div>
        <Button icon={<ReloadOutlined />} onClick={reload}>Refresh</Button>
      </div>

      {locked && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="Settings are locked by the platform operator"
          description="You can view these settings but cannot edit them. Contact support to request changes."
        />
      )}

      <Form form={form} layout="vertical" onFinish={handleSave} disabled={locked || saving}>
        <Card size="small" title="Master switch" style={{ marginBottom: 16 }}>
          <Form.Item
            name="enabled"
            label="Chatbot enabled for this organization"
            valuePropName="checked"
            extra="When off, all /api/chat/message calls return 403. Useful as a quick kill switch."
          >
            <Switch />
          </Form.Item>
        </Card>

        <Card size="small" title="What the bot can do" style={{ marginBottom: 16 }}>
          <Paragraph type="secondary" style={{ marginBottom: 16 }}>
            Turning a capability off REMOVES that tool from the bot's toolbox — the LLM physically
            cannot call it. Stronger than a permission check.
          </Paragraph>
          <Row gutter={[16, 8]}>
            {CAPABILITY_LABELS.map((c) => (
              <Col xs={24} md={12} key={c.key}>
                <Form.Item name={c.key} valuePropName="checked" style={{ marginBottom: 8 }}>
                  <Switch />
                </Form.Item>
                <div style={{ marginLeft: 52, marginTop: -32, marginBottom: 12 }}>
                  <div style={{ fontWeight: 500 }}>{c.label}</div>
                  <Text type="secondary" style={{ fontSize: 12 }}>{c.description}</Text>
                </div>
              </Col>
            ))}
          </Row>
        </Card>

        <Card size="small" title="Guardrails" style={{ marginBottom: 16 }}>
          <Row gutter={16}>
            <Col xs={24} md={8}>
              <Form.Item
                name="max_bookings_per_session"
                label="Max bookings per session"
                extra="Prevents a misbehaving bot from booking repeatedly."
                rules={[{ required: true }]}
              >
                <InputNumber min={0} max={20} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item
                name="max_messages_per_session"
                label="Max messages per session"
                rules={[{ required: true }]}
              >
                <InputNumber min={1} max={1000} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item
                name="max_messages_per_day"
                label="Max messages per day (per channel user)"
                rules={[{ required: true }]}
              >
                <InputNumber min={1} max={10000} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
        </Card>

        <Space>
          <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={saving} disabled={locked}>
            Save settings
          </Button>
          <Button onClick={reload} disabled={saving}>Cancel</Button>
        </Space>
      </Form>
    </MainLayout>
  );
}
