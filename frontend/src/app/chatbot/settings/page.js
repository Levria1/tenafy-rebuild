'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Card, Typography, Switch, InputNumber, Input, Button, Space, Form, Row, Col, message, Alert, Spin,
} from 'antd';
import { SaveOutlined, ReloadOutlined } from '@ant-design/icons';
import MainLayout from '../../../components/Layout';
import { chatApi, advertisingApi } from '../../../lib/api';

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

// Settings -> Leasing -> Availability.
//
// These live on `advertising_setting` because that is where the availability engine
// (computeVacancies) already reads min_gap_days and the lead windows from. The table
// name is historical: these are LETTING rules, not advertising rules — they decide
// what gets offered to a prospect whether the answer comes from the chatbot, the
// public API, or a member of staff. This page is the first UI any of them has had.
function LeasingAvailabilitySettings() {
  const [maxGap, setMaxGap] = useState(null);
  const [hardMaxGap, setHardMaxGap] = useState(null);
  const [inquiryMinGap, setInquiryMinGap] = useState(null);
  const [inquiryLeadDaysNr, setInquiryLeadDaysNr] = useState(null);
  const [inquiryLeadDaysOther, setInquiryLeadDaysOther] = useState(null);
  const [effectiveInquiry, setEffectiveInquiry] = useState(null);
  const [partnerMsg, setPartnerMsg] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setLoadError(false);
    advertisingApi.getAdSettings()
      .then(r => {
        const d = r.data?.data;
        // No invented fallbacks: the API always returns a full object, so a missing
        // one means the request failed. Showing plausible-but-wrong numbers here and
        // then saving them over the real ones is the failure worth avoiding.
        if (!d) { setLoadError(true); return; }
        setMaxGap(d.max_gap_days ?? null);
        setHardMaxGap(d.hard_max_gap_days ?? null);
        setInquiryMinGap(d.inquiry_min_gap_days ?? null);
        setInquiryLeadDaysNr(d.inquiry_lead_days_nr ?? null);
        setInquiryLeadDaysOther(d.inquiry_lead_days_other ?? null);
        setEffectiveInquiry(d.effective?.inquiry ?? null);
        setPartnerMsg(d.partner_forward_message ?? '');
      })
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  // Mirrors the server-side rule. A warning threshold above the hide threshold is
  // incoherent: nothing could ever be warned about, because it would already be hidden.
  const invalid = maxGap != null && hardMaxGap != null && Number(maxGap) > Number(hardMaxGap);

  const handleNullableDays = setter => value => {
    setter(value === null || value === undefined || value === '' ? null : Number(value));
  };

  const renderEffectiveInquiry = key => {
    const value = effectiveInquiry?.[key];
    const source = effectiveInquiry?.source?.[key];
    if (value === null || value === undefined || !source) return null;

    const label = `${value} ${Number(value) === 1 ? 'day' : 'days'}`;
    if (source === 'advertising') {
      return <Text type="secondary" style={{ fontSize: 12 }}>Using the advertising value ({label})</Text>;
    }
    return <Text style={{ fontSize: 12 }}>Overriding advertising ({label})</Text>;
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const r = await advertisingApi.updateAdSettings({
        max_gap_days: maxGap,
        hard_max_gap_days: hardMaxGap,
        inquiry_min_gap_days: inquiryMinGap,
        inquiry_lead_days_nr: inquiryLeadDaysNr,
        inquiry_lead_days_other: inquiryLeadDaysOther,
        partner_forward_message: partnerMsg,
      });
      const d = r.data?.data;
      if (d) {
        setMaxGap(d.max_gap_days ?? null);
        setHardMaxGap(d.hard_max_gap_days ?? null);
        setInquiryMinGap(d.inquiry_min_gap_days ?? null);
        setInquiryLeadDaysNr(d.inquiry_lead_days_nr ?? null);
        setInquiryLeadDaysOther(d.inquiry_lead_days_other ?? null);
        setEffectiveInquiry(d.effective?.inquiry ?? null);
        setPartnerMsg(d.partner_forward_message ?? '');
      }
      message.success('Saved');
    } catch (e) {
      message.error(e?.response?.data?.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Card size="small" title="Leasing" style={{ marginBottom: 16 }} loading />;

  if (loadError) {
    return (
      <Card size="small" title="Leasing" style={{ marginBottom: 16 }}>
        <Space direction="vertical">
          <Alert type="error" showIcon message="Couldn't load the availability settings." />
          <span style={{ color: '#888', fontSize: 12 }}>
            Saving is disabled until they load, so a failed read can&apos;t overwrite your real settings.
          </span>
          <Button onClick={load}>Retry</Button>
        </Space>
      </Card>
    );
  }

  return (
    <Card size="small" title="Leasing" style={{ marginBottom: 16 }}>
      <p style={{ color: '#888', marginBottom: 20 }}>
        Availability settings for inquiries about what units are available
      </p>

      <Row gutter={24}>
        <Col xs={24} md={12} style={{ marginBottom: 20 }}>
          <div style={{ marginBottom: 4, fontWeight: 500 }}>Suggest an earlier move-in after</div>
          <InputNumber
            min={0} max={365} value={maxGap} onChange={setMaxGap}
            addonAfter="days empty" style={{ width: '100%', maxWidth: 240 }}
          />
          <div style={{ color: '#888', fontSize: 12, marginTop: 6 }}>
            If the unit would sit empty longer than this before the tenant moves in, we still offer it
            — but we ask whether they can start a little earlier.
          </div>
        </Col>

        <Col xs={24} md={12} style={{ marginBottom: 20 }}>
          <div style={{ marginBottom: 4, fontWeight: 500 }}>Stop offering the unit after</div>
          <InputNumber
            min={0} max={365} value={hardMaxGap} onChange={setHardMaxGap}
            addonAfter="days empty" style={{ width: '100%', maxWidth: 240 }}
          />
          <div style={{ color: '#888', fontSize: 12, marginTop: 6 }}>
            Past this the unit is not offered at all. <strong>Units that are already vacant are
            always offered</strong> regardless — they are the ones most needing a tenant, so hiding
            them would be counter-productive.
          </div>
        </Col>
      </Row>

      {invalid && (
        <Alert
          type="error" showIcon style={{ marginBottom: 16 }}
          message={`Suggest-earlier (${maxGap}d) must not be later than stop-offering (${hardMaxGap}d)`}
          description="Otherwise nothing could ever be flagged — it would already have been hidden."
        />
      )}

      <div style={{ borderTop: '1px solid #f0f0f0', paddingTop: 16, marginBottom: 16 }}>
        <Title level={5} style={{ marginTop: 0, marginBottom: 8 }}>Only for inquiries (optional)</Title>
        <Paragraph type="secondary" style={{ marginBottom: 16 }}>
          Leaving these empty means inquiries use the same windows as advertising; filling one lets
          that single field differ. The advertising values live on Advertising → Settings.
        </Paragraph>
        <Row gutter={24}>
          <Col xs={24} md={8} style={{ marginBottom: 16 }}>
            <div style={{ marginBottom: 4, fontWeight: 500 }}>Minimum vacancy worth offering</div>
            <InputNumber
              min={0} max={365} value={inquiryMinGap} onChange={handleNullableDays(setInquiryMinGap)}
              allowClear addonAfter="days" style={{ width: '100%', maxWidth: 240 }}
            />
            <div style={{ marginTop: 6 }}>{renderEffectiveInquiry('min_gap_days')}</div>
          </Col>
          <Col xs={24} md={8} style={{ marginBottom: 16 }}>
            <div style={{ marginBottom: 4, fontWeight: 500 }}>Offer a not-renewing unit from</div>
            <InputNumber
              min={0} max={365} value={inquiryLeadDaysNr} onChange={handleNullableDays(setInquiryLeadDaysNr)}
              allowClear addonAfter="days out" style={{ width: '100%', maxWidth: 240 }}
            />
            <div style={{ marginTop: 6 }}>{renderEffectiveInquiry('lead_days_nr')}</div>
          </Col>
          <Col xs={24} md={8} style={{ marginBottom: 16 }}>
            <div style={{ marginBottom: 4, fontWeight: 500 }}>Offer an other/may-renew unit from</div>
            <InputNumber
              min={0} max={365} value={inquiryLeadDaysOther} onChange={handleNullableDays(setInquiryLeadDaysOther)}
              allowClear addonAfter="days out" style={{ width: '100%', maxWidth: 240 }}
            />
            <div style={{ marginTop: 6 }}>{renderEffectiveInquiry('lead_days_other')}</div>
          </Col>
        </Row>
      </div>

      <Alert
        type="info" showIcon style={{ marginBottom: 16 }}
        message="When nothing matches"
        description="If we can't house the inquiry — whether nothing is suitable or we have nothing at all — the message below is what gets forwarded to partner agencies. A unit that only becomes free after the requested date is never hidden by the limits above, since waiting costs no rent."
      />

      <div style={{ marginBottom: 8, fontWeight: 500 }}>Message to forward to partner agencies</div>
      <Input.TextArea
        rows={5} value={partnerMsg} onChange={e => setPartnerMsg(e.target.value)}
        maxLength={2000} showCount
        placeholder={'e.g. Hi, we have an enquiry we can\u2019t house ourselves \u2014 {customer_name} is looking to move in around {target_date}, budget {budget}, in {area}. Requirements: {requirements}. Anything available on your side?'}
      />
      <div style={{ color: '#888', fontSize: 12, marginTop: 6 }}>
        Leave this empty and nothing is sent — there is deliberately no default, because this text
        goes to real agencies. Placeholders are filled in when the message is sent:{' '}
        <code>{'{customer_name}'}</code> <code>{'{target_date}'}</code> <code>{'{budget}'}</code>{' '}
        <code>{'{area}'}</code> <code>{'{requirements}'}</code>
      </div>

      <div style={{ height: 20 }} />

      <Button type="primary" loading={saving} disabled={invalid} onClick={handleSave}>Save</Button>
    </Card>
  );
}

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

      <LeasingAvailabilitySettings />
    </MainLayout>
  );
}
