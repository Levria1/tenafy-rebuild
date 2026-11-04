'use client';

import { Card, Checkbox, Form } from 'antd';
import SelectAllCheckbox from './SelectAllCheckbox';

/**
 * Per-lease WhatsApp switches, independent of the Email Notifications card.
 * Shared by Create Lease and Edit Lease so the two screens cannot drift.
 *
 * Each box sends that notice on WhatsApp to the tenant's phone, whatever the email
 * box beside it says. Nothing goes out unless the matching WhatsApp template
 * (Settings → Channels → WhatsApp Templates) is Active, and a contact marked
 * "WhatsApp opt-out" is never messaged.
 */
export const WHATSAPP_TOGGLES = [
  { name: 'wa_tenant_posted', label: 'WhatsApp tenant when invoice is posted' },
  { name: 'wa_tenant_overdue', label: 'WhatsApp tenant when invoice is overdue' },
  { name: 'wa_tenant_deposit_posted', label: 'WhatsApp tenant when deposit is posted' },
  { name: 'wa_tenant_checkin', label: 'WhatsApp tenant on check-in' },
  { name: 'wa_tenant_checkout', label: 'WhatsApp tenant on check-out' },
  { name: 'wa_tenant_renewal', label: 'WhatsApp tenant for renewal' },
];

export const WHATSAPP_TOGGLE_NAMES = WHATSAPP_TOGGLES.map(t => t.name);

/**
 * Ticked by default on Create Lease (owner, 2026-11-04): invoice posted, overdue,
 * check-in, check-out and renewal. Deposit is left to the operator.
 */
export const WHATSAPP_CREATE_DEFAULTS = {
  wa_tenant_posted: true,
  wa_tenant_overdue: true,
  wa_tenant_checkin: true,
  wa_tenant_checkout: true,
  wa_tenant_renewal: true,
};

/** The WhatsApp ticks from form values, as booleans, for the save payload. */
export function whatsappTogglePayload(values) {
  return Object.fromEntries(WHATSAPP_TOGGLE_NAMES.map(n => [n, !!values[n]]));
}

export default function WhatsAppNotificationsCard({ form, sectionStyle, titleStyle }) {
  const body = (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 24px' }}>
        {WHATSAPP_TOGGLES.map(t => (
          <Form.Item key={t.name} name={t.name} valuePropName="checked" style={{ marginBottom: 0 }}>
            <Checkbox>{t.label}</Checkbox>
          </Form.Item>
        ))}
      </div>
      <div style={{ fontSize: 11, color: '#888', marginTop: 12 }}>
        Sent to the tenant&apos;s phone, separately from email. Only goes out when the matching WhatsApp
        template is Active, and never to a contact marked &quot;WhatsApp opt-out&quot;. Renewal uses the
        renewal days set under Email Notifications.
      </div>
    </>
  );
  const selectAll = <SelectAllCheckbox form={form} fields={WHATSAPP_TOGGLE_NAMES} />;

  // Edit Lease draws plain bordered sections; Create Lease uses Cards. Take the
  // host page's look so the block sits naturally on both.
  if (sectionStyle) {
    return (
      <div style={sectionStyle}>
        <div style={{ ...titleStyle, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>WhatsApp Notifications</span>
          {selectAll}
        </div>
        {body}
      </div>
    );
  }
  return (
    <Card size="small" title="WhatsApp Notifications" style={{ marginBottom: 16 }} extra={selectAll}>
      {body}
    </Card>
  );
}
