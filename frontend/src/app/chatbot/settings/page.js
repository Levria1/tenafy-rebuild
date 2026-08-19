'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Card, Typography, Switch, InputNumber, Input, Button, Space, Form, Row, Col, message, Alert, Spin,
} from 'antd';
import { SaveOutlined, ReloadOutlined } from '@ant-design/icons';
import MainLayout from '../../../components/Layout';
import { chatApi, advertisingApi, viewingApi } from '../../../lib/api';

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
// (computeVacancies) reads its window settings. The table name is historical: this
// card edits the inquiry audience's independent copy only.
function LeasingAvailabilitySettings() {
  const [hardMaxGap, setHardMaxGap] = useState(null);
  const [vacantMaxMoveIn, setVacantMaxMoveIn] = useState(null);
  const [inquiryMinGap, setInquiryMinGap] = useState(null);
  const [inquiryLeadDaysNr, setInquiryLeadDaysNr] = useState(null);
  const [inquiryLeadDaysOther, setInquiryLeadDaysOther] = useState(null);
  const [inquiryHorizon, setInquiryHorizon] = useState(null);
  const [gapBand1m, setGapBand1m] = useState(null);
  const [gapBand2m, setGapBand2m] = useState(null);
  const [gapBand3mPlus, setGapBand3mPlus] = useState(null);
  const [tooFarOutPhrase, setTooFarOutPhrase] = useState('');
  const [gapAskPhrase, setGapAskPhrase] = useState('');
  const [renewalAskEnabled, setRenewalAskEnabled] = useState(false);
  const [renewalNoticeDays, setRenewalNoticeDays] = useState(null);
  const [renewalAskPhrase, setRenewalAskPhrase] = useState('');
  const [effectiveAdvertising, setEffectiveAdvertising] = useState(null);
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
        setHardMaxGap(d.hard_max_gap_days ?? null);
        setVacantMaxMoveIn(d.vacant_max_move_in_days ?? 30);
        setInquiryMinGap(d.inquiry_min_gap_days ?? 40);
        setInquiryLeadDaysNr(d.inquiry_lead_days_nr ?? 60);
        setInquiryLeadDaysOther(d.inquiry_lead_days_other ?? 45);
        setInquiryHorizon(d.inquiry_booking_horizon_days ?? 60);
        setGapBand1m(d.inquiry_gap_band_1m_days ?? 3);
        setGapBand2m(d.inquiry_gap_band_2m_days ?? 6);
        setGapBand3mPlus(d.inquiry_gap_band_3m_plus_days ?? 10);
        setTooFarOutPhrase(d.inquiry_too_far_out_phrase ?? '');
        setGapAskPhrase(d.inquiry_gap_ask_phrase ?? '');
        setRenewalAskEnabled(Number(d.renewal_ask_enabled) === 1);
        setRenewalNoticeDays(d.renewal_default_notice_days ?? 30);
        setRenewalAskPhrase(d.renewal_ask_phrase ?? '');
        setEffectiveAdvertising(d.effective?.advertising ?? null);
        setPartnerMsg(d.partner_forward_message ?? '');
      })
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleRequiredDays = (setter, fallback) => value => {
    setter(value === null || value === undefined || value === '' ? fallback : Number(value));
  };

  const renderAdvertisingReference = key => {
    const value = effectiveAdvertising?.[key];
    if (value === null || value === undefined) return null;

    const label = `${value} ${Number(value) === 1 ? 'day' : 'days'}`;
    return <Text type="secondary" style={{ fontSize: 12 }}>Advertising uses {label}</Text>;
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const r = await advertisingApi.updateAdSettings({
        hard_max_gap_days: hardMaxGap,
        vacant_max_move_in_days: vacantMaxMoveIn,
        inquiry_min_gap_days: inquiryMinGap,
        inquiry_lead_days_nr: inquiryLeadDaysNr,
        inquiry_lead_days_other: inquiryLeadDaysOther,
        inquiry_booking_horizon_days: inquiryHorizon,
        inquiry_gap_band_1m_days: gapBand1m,
        inquiry_gap_band_2m_days: gapBand2m,
        inquiry_gap_band_3m_plus_days: gapBand3mPlus,
        inquiry_too_far_out_phrase: tooFarOutPhrase,
        inquiry_gap_ask_phrase: gapAskPhrase,
        renewal_ask_enabled: renewalAskEnabled ? 1 : 0,
        renewal_default_notice_days: renewalNoticeDays,
        renewal_ask_phrase: renewalAskPhrase,
        partner_forward_message: partnerMsg,
      });
      const d = r.data?.data;
      if (d && d.max_gap_days !== undefined) {
        setHardMaxGap(d.hard_max_gap_days ?? null);
        setVacantMaxMoveIn(d.vacant_max_move_in_days ?? 30);
        setInquiryMinGap(d.inquiry_min_gap_days ?? 40);
        setInquiryLeadDaysNr(d.inquiry_lead_days_nr ?? 60);
        setInquiryLeadDaysOther(d.inquiry_lead_days_other ?? 45);
        setInquiryHorizon(d.inquiry_booking_horizon_days ?? 60);
        setGapBand1m(d.inquiry_gap_band_1m_days ?? 3);
        setGapBand2m(d.inquiry_gap_band_2m_days ?? 6);
        setGapBand3mPlus(d.inquiry_gap_band_3m_plus_days ?? 10);
        setTooFarOutPhrase(d.inquiry_too_far_out_phrase ?? '');
        setGapAskPhrase(d.inquiry_gap_ask_phrase ?? '');
        setRenewalAskEnabled(Number(d.renewal_ask_enabled) === 1);
        setRenewalNoticeDays(d.renewal_default_notice_days ?? 30);
        setRenewalAskPhrase(d.renewal_ask_phrase ?? '');
        setEffectiveAdvertising(d.effective?.advertising ?? null);
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

  // A band above the ceiling can never fire: the unit is hidden before we get the
  // chance to ask. Silently unreachable settings are worse than rejected ones.
  const widestBand = Math.max(
    Number(gapBand1m) || 0, Number(gapBand2m) || 0, Number(gapBand3mPlus) || 0,
  );
  const bandAboveCeiling = Number.isFinite(Number(hardMaxGap)) && widestBand > Number(hardMaxGap);

  return (
    <Card size="small" title="Leasing" style={{ marginBottom: 16 }}>
      <p style={{ color: '#888', marginBottom: 20 }}>
        Availability settings for inquiry answers. Gap bands create earlier move-in asks; ceiling
        limits decide when a unit is not offered.
      </p>

      <div style={{ marginBottom: 16 }}>
        <Title level={5} style={{ marginTop: 0, marginBottom: 8 }}>Offer limits</Title>
        <Paragraph type="secondary" style={{ marginBottom: 16 }}>
          These are hard cutoffs. Past them, the unit is not offered.
        </Paragraph>
      </div>
      <Row gutter={24}>
        <Col xs={24} md={12} style={{ marginBottom: 20 }}>
          <div style={{ marginBottom: 4, fontWeight: 500 }}>Never offer if empty longer than</div>
          <InputNumber
            min={0} max={365} value={hardMaxGap} onChange={handleRequiredDays(setHardMaxGap, 15)}
            addonAfter="days empty" style={{ width: '100%', maxWidth: 240 }}
          />
          <div style={{ color: '#888', fontSize: 12, marginTop: 6 }}>
            For occupied units, this is the maximum empty gap between the lease end date and the
            requested move-in date.
          </div>
        </Col>

        <Col xs={24} md={12} style={{ marginBottom: 20 }}>
          <div style={{ marginBottom: 4, fontWeight: 500 }}>Don&apos;t offer vacant units if the move-in is more than</div>
          <InputNumber
            min={0} max={365} value={vacantMaxMoveIn} onChange={handleRequiredDays(setVacantMaxMoveIn, 30)}
            addonAfter="days from today" style={{ width: '100%', maxWidth: 240 }}
          />
          <div style={{ color: '#888', fontSize: 12, marginTop: 6 }}>
            This is measured from today to the customer&apos;s move-in date, not from a lease end date.
          </div>
        </Col>
      </Row>

      <div style={{ borderTop: '1px solid #f0f0f0', paddingTop: 16, marginBottom: 16 }}>
        <Title level={5} style={{ marginTop: 0, marginBottom: 8 }}>Availability for inquiries</Title>
        <Paragraph type="secondary" style={{ marginBottom: 16 }}>
          These values are independent of advertising. Changing them does not affect what gets
          posted to Facebook; those values live on Advertising → Settings.
        </Paragraph>
        <Row gutter={24}>
          <Col xs={24} md={8} style={{ marginBottom: 16 }}>
            <div style={{ marginBottom: 4, fontWeight: 500 }}>Minimum vacancy worth offering</div>
            <InputNumber
              min={0} max={365} value={inquiryMinGap} onChange={handleRequiredDays(setInquiryMinGap, 40)}
              addonAfter="days" style={{ width: '100%', maxWidth: 240 }}
            />
            <div style={{ marginTop: 6 }}>{renderAdvertisingReference('min_gap_days')}</div>
          </Col>
          <Col xs={24} md={8} style={{ marginBottom: 16 }}>
            <div style={{ marginBottom: 4, fontWeight: 500 }}>Offer a not-renewing unit from</div>
            <InputNumber
              min={0} max={365} value={inquiryLeadDaysNr} onChange={handleRequiredDays(setInquiryLeadDaysNr, 60)}
              addonAfter="days out" style={{ width: '100%', maxWidth: 240 }}
            />
            <div style={{ marginTop: 6 }}>{renderAdvertisingReference('lead_days_nr')}</div>
          </Col>
          <Col xs={24} md={8} style={{ marginBottom: 16 }}>
            <div style={{ marginBottom: 4, fontWeight: 500 }}>Offer an other/may-renew unit from</div>
            <InputNumber
              min={0} max={365} value={inquiryLeadDaysOther} onChange={handleRequiredDays(setInquiryLeadDaysOther, 45)}
              addonAfter="days out" style={{ width: '100%', maxWidth: 240 }}
            />
            <div style={{ marginTop: 6 }}>{renderAdvertisingReference('lead_days_other')}</div>
          </Col>
        </Row>
      </div>

      <div style={{ borderTop: '1px solid #f0f0f0', paddingTop: 16, marginBottom: 16 }}>
        <Title level={5} style={{ marginTop: 0, marginBottom: 8 }}>Booking horizon</Title>
        <Row gutter={24}>
          <Col xs={24} md={12} style={{ marginBottom: 16 }}>
            <div style={{ marginBottom: 4, fontWeight: 500 }}>Offer only confirmed-leaving units after</div>
            <InputNumber
              min={0} max={365} value={inquiryHorizon} onChange={handleRequiredDays(setInquiryHorizon, 60)}
              addonAfter="days from today" style={{ width: '100%', maxWidth: 240 }}
            />
            <div style={{ color: '#888', fontSize: 12, marginTop: 6 }}>
              Beyond this, we only offer units whose tenant has confirmed they are leaving.
              Everything else is withheld, and the customer is told when to check back.
            </div>
          </Col>
        </Row>
      </div>

      <div style={{ borderTop: '1px solid #f0f0f0', paddingTop: 16, marginBottom: 16 }}>
        <Title level={5} style={{ marginTop: 0, marginBottom: 8 }}>How long a unit can sit empty</Title>
        <Paragraph type="secondary" style={{ marginBottom: 16 }}>
          Outside these bands, the unit is still offered and we ask the customer to move in earlier.
          A shorter stay must line up more tightly because the same empty week costs proportionally more.
        </Paragraph>
        {bandAboveCeiling && (
          <Alert
            type="warning" showIcon style={{ marginBottom: 16 }}
            message={`A band of ${widestBand} days is above the ${hardMaxGap}-day ceiling`}
            description="Past the ceiling the unit is not offered at all, so we never get to ask the customer to move in earlier. Raise 'Never offer if empty longer than' above the widest band, or lower the band."
          />
        )}
        <Row gutter={24}>
          <Col xs={24} md={8} style={{ marginBottom: 16 }}>
            <div style={{ marginBottom: 4, fontWeight: 500 }}>1 month</div>
            <InputNumber
              min={0} max={365} value={gapBand1m} onChange={handleRequiredDays(setGapBand1m, 3)}
              addonAfter="days empty" style={{ width: '100%', maxWidth: 240 }}
            />
          </Col>
          <Col xs={24} md={8} style={{ marginBottom: 16 }}>
            <div style={{ marginBottom: 4, fontWeight: 500 }}>2 months</div>
            <InputNumber
              min={0} max={365} value={gapBand2m} onChange={handleRequiredDays(setGapBand2m, 6)}
              addonAfter="days empty" style={{ width: '100%', maxWidth: 240 }}
            />
          </Col>
          <Col xs={24} md={8} style={{ marginBottom: 16 }}>
            <div style={{ marginBottom: 4, fontWeight: 500 }}>3+ months</div>
            <InputNumber
              min={0} max={365} value={gapBand3mPlus} onChange={handleRequiredDays(setGapBand3mPlus, 10)}
              addonAfter="days empty" style={{ width: '100%', maxWidth: 240 }}
            />
          </Col>
        </Row>
      </div>

      <div style={{ borderTop: '1px solid #f0f0f0', paddingTop: 16, marginBottom: 16 }}>
        <Title level={5} style={{ marginTop: 0, marginBottom: 8 }}>Ask the tenant if they are staying</Title>
        <Paragraph type="secondary" style={{ marginBottom: 16 }}>
          When someone asks about a unit whose tenant has not decided, and that decision is due, we can
          ask the tenant directly. A reply of <b>staying</b> takes the unit off what customers see
          straight away — it stays on your Vacancy page, because the lease still needs extending. A
          reply of <b>leaving</b> is never enough on its own to advertise the unit as definitely free.
        </Paragraph>
        <Row gutter={24}>
          <Col xs={24} md={12} style={{ marginBottom: 16 }}>
            <div style={{ marginBottom: 4, fontWeight: 500 }}>Send these messages</div>
            <Switch checked={renewalAskEnabled} onChange={setRenewalAskEnabled} />
            <div style={{ color: '#888', fontSize: 12, marginTop: 6 }}>
              Off by default. Nothing reaches any tenant while this is off.
            </div>
          </Col>
          <Col xs={24} md={12} style={{ marginBottom: 16 }}>
            <div style={{ marginBottom: 4, fontWeight: 500 }}>If the lease has no notice period, assume</div>
            <InputNumber
              min={0} max={365} value={renewalNoticeDays} onChange={handleRequiredDays(setRenewalNoticeDays, 30)}
              addonAfter="days notice" style={{ width: '100%', maxWidth: 240 }}
            />
            <div style={{ color: '#888', fontSize: 12, marginTop: 6 }}>
              Used only to work out when to ask. It is never shown to a customer as a date.
            </div>
          </Col>
        </Row>
        <div style={{ marginBottom: 4, fontWeight: 500 }}>Message to the tenant</div>
        <Input.TextArea
          rows={4} value={renewalAskPhrase} onChange={e => setRenewalAskPhrase(e.target.value)}
          maxLength={2000} showCount
        />
        <div style={{ color: '#888', fontSize: 12, marginTop: 6 }}>
          Placeholders: <code>{'{tenant_name}'}</code> <code>{'{unit}'}</code> <code>{'{end_date}'}</code>.
          It deliberately does not mention that someone else is interested — that turns a routine
          question into pressure.
        </div>
      </div>

      <div style={{ borderTop: '1px solid #f0f0f0', paddingTop: 16, marginBottom: 16 }}>
        <Title level={5} style={{ marginTop: 0, marginBottom: 8 }}>Customer messages</Title>
        <Row gutter={24}>
          <Col xs={24} md={12} style={{ marginBottom: 16 }}>
            <div style={{ marginBottom: 4, fontWeight: 500 }}>&quot;Can you move in earlier?&quot; ask</div>
            <Input.TextArea
              rows={5} value={gapAskPhrase} onChange={e => setGapAskPhrase(e.target.value)}
              maxLength={2000} showCount
            />
            <div style={{ color: '#888', fontSize: 12, marginTop: 6 }}>
              Placeholders: <code>{'{units}'}</code> <code>{'{gap_days}'}</code>{' '}
              <code>{'{suggested_move_in_date}'}</code>
            </div>
          </Col>
          <Col xs={24} md={12} style={{ marginBottom: 16 }}>
            <div style={{ marginBottom: 4, fontWeight: 500 }}>&quot;Too far out&quot; message</div>
            <Input.TextArea
              rows={5} value={tooFarOutPhrase} onChange={e => setTooFarOutPhrase(e.target.value)}
              maxLength={2000} showCount
            />
            <div style={{ color: '#888', fontSize: 12, marginTop: 6 }}>
              Used only when a date is beyond the booking horizon and no confirmed-leaving unit
              qualifies. Placeholders: <code>{'{target_date}'}</code>{' '}
              <code>{'{booking_horizon_days}'}</code> <code>{'{check_back_in_days}'}</code>{' '}
              <code>{'{check_back_on}'}</code>
            </div>
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

      <Button type="primary" loading={saving} onClick={handleSave}>Save</Button>
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
    Promise.all([chatApi.getSettings(), viewingApi.getViewingSettings()])
      .then(([chatRes, viewingRes]) => {
        const s = chatRes.data.data;
        const viewing = viewingRes.data.data || {};
        setSettings(s);
        form.setFieldsValue({
          enabled: Boolean(s.enabled),
          ...Object.fromEntries(CAPABILITY_LABELS.map(c => [c.key, Boolean(s.capabilities?.[c.key])])),
          max_bookings_per_session: s.max_bookings_per_session,
          max_messages_per_session: s.max_messages_per_session,
          max_messages_per_day: s.max_messages_per_day,
          tenant_opt_out_hours: viewing.tenant_opt_out_hours ?? 4,
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
      await viewingApi.updateViewingSettings({
        tenant_opt_out_hours: values.tenant_opt_out_hours,
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

        <Card size="small" title="Viewing relay" style={{ marginBottom: 16 }}>
          <Row gutter={16}>
            <Col xs={24} md={8}>
              <Form.Item
                name="tenant_opt_out_hours"
                label="Tenant response window (hours)"
                extra="How long we wait after the notice is sent before confirming the viewing. If the tenant does not reply in this time, the viewing is confirmed automatically. The tenant is not told this time."
                rules={[
                  { required: true, message: 'Enter a whole number from 1 to 48 hours.' },
                  {
                    validator: (_, value) => {
                      const n = Number(value);
                      return Number.isInteger(n) && n >= 1 && n <= 48
                        ? Promise.resolve()
                        : Promise.reject(new Error('Enter a whole number from 1 to 48 hours.'));
                    },
                  },
                ]}
              >
                <InputNumber min={1} max={48} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Alert
            type="warning"
            showIcon
            message="Viewings starting sooner than this window ask the tenant to reply yes instead — silence will not confirm those. Raising this number makes more viewings need an explicit yes."
          />
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
