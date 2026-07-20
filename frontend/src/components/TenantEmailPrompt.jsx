'use client';

/**
 * Missing-email prompt for the lease form.
 *
 * Why this exists: a lease delivers invoices, receipts and signature requests by
 * email. With no address those sends silently do nothing, so the lease looks fine
 * while the tenant is never contacted.
 *
 * Two things make this usable rather than a dead end:
 *   1. The email can be fixed RIGHT HERE (PATCH /api/tenant/:id/email) — no second
 *      tab, no page reload, so nothing typed into the lease form is lost.
 *   2. If the address was added elsewhere (another tab), "Re-check" re-fetches the
 *      contacts. The lease form caches its tenant list on mount, so without this
 *      the form would keep using the stale record until a full reload.
 *
 * modes:
 *   'warn'  — fired on tenant selection. Dismissible; the lease may not need email.
 *   'block' — fired on submit when email options are on. Must be resolved.
 */

import { useEffect, useState } from 'react';
import { Modal, Input, Button, Alert, Space, Typography, message } from 'antd';
import { MailOutlined, ReloadOutlined } from '@ant-design/icons';
import { tenant as tenantApi } from '../lib/api';

const { Text } = Typography;

export default function TenantEmailPrompt({
  open,
  parties = [],       // [{ id, name }] — contacts missing an email
  mode = 'warn',
  onSaved,            // (savedList: [{id, email}]) => void
  onRecheck,          // async () => void  — parent re-fetches its tenant list
  onClose,
}) {
  const [drafts, setDrafts] = useState({});   // { [tenantId]: email }
  const [saving, setSaving] = useState(false);
  const [rechecking, setRechecking] = useState(false);

  // Reset drafts whenever the prompt opens for a different set of contacts.
  useEffect(() => {
    if (open) setDrafts({});
  }, [open, parties.map(p => p.id).join(',')]);

  const isBlock = mode === 'block';
  const filled = parties.filter(p => (drafts[p.id] || '').trim());

  const handleSave = async () => {
    if (!filled.length) {
      message.warning('Enter at least one email address.');
      return;
    }
    setSaving(true);
    const saved = [];
    try {
      for (const p of filled) {
        const email = drafts[p.id].trim();
        try {
          await tenantApi.updateEmail(p.id, email);
          saved.push({ id: p.id, email });
        } catch (e) {
          // Report per-contact so one bad address doesn't hide the others.
          message.error(`${p.name}: ${e?.response?.data?.message || 'Failed to save email'}`);
        }
      }
      if (saved.length) {
        message.success(saved.length > 1 ? `${saved.length} emails saved` : 'Email saved');
        onSaved?.(saved);
      }
    } finally {
      setSaving(false);
    }
  };

  const handleRecheck = async () => {
    setRechecking(true);
    try {
      await onRecheck?.();
    } finally {
      setRechecking(false);
    }
  };

  return (
    <Modal
      open={open}
      title={
        <span><MailOutlined style={{ color: isBlock ? '#ff4d4f' : '#faad14', marginRight: 8 }} />
          {parties.length > 1 ? 'These contacts have no email address' : 'This contact has no email address'}
        </span>
      }
      onCancel={onClose}
      maskClosable={!isBlock}
      closable={!isBlock}
      keyboard={!isBlock}
      footer={
        <Space>
          <Button icon={<ReloadOutlined />} onClick={handleRecheck} loading={rechecking}>
            Re-check
          </Button>
          {!isBlock && <Button onClick={onClose}>Continue anyway</Button>}
          {isBlock && <Button onClick={onClose}>Back to form</Button>}
          <Button type="primary" onClick={handleSave} loading={saving} disabled={!filled.length}>
            Save &amp; continue
          </Button>
        </Space>
      }
      destroyOnClose
    >
      <Alert
        type={isBlock ? 'error' : 'warning'}
        showIcon
        style={{ marginBottom: 16 }}
        message={isBlock ? "The email options you've selected can't be delivered" : 'Emails to this contact will not be delivered'}
        description={
          isBlock
            ? 'Leases send invoices, receipts and signature requests by email. Add an address below, or go back and turn off the email options.'
            : 'You can still continue — but invoices, receipts and signature requests will not reach them until an email is added.'
        }
      />

      {parties.map(p => (
        <div key={p.id} style={{ marginBottom: 12 }}>
          <div style={{ marginBottom: 4 }}><Text strong>{p.name}</Text></div>
          <Input
            type="email"
            placeholder="name@example.com"
            prefix={<MailOutlined style={{ color: '#bfbfbf' }} />}
            value={drafts[p.id] || ''}
            onChange={(e) => setDrafts(d => ({ ...d, [p.id]: e.target.value }))}
            onPressEnter={handleSave}
            autoFocus={parties.length === 1}
          />
        </div>
      ))}

      <Text type="secondary" style={{ fontSize: 12 }}>
        Saving here updates the contact record. Already added it in another tab? Hit <strong>Re-check</strong> — your lease details are kept.
      </Text>
    </Modal>
  );
}
