'use client';

import { useEffect, useState } from 'react';
import { Modal, Form, Input, Button, message, Typography, Alert } from 'antd';
import { CopyOutlined } from '@ant-design/icons';
import { viewingApi } from '../../lib/api';

const { Paragraph } = Typography;

/**
 * Simple modal for generating a shareable viewing link for a unit.
 *
 * The employee (who receives approval emails) is NOT chosen here — staff
 * assign an employee from the links table after the link is generated.
 * Until an employee is assigned, the public URL shows a "not ready" state.
 */
export default function GenerateViewingLinkModal({ open, unitId, onClose, onCreated }) {
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [createdUrl, setCreatedUrl] = useState(null);

  useEffect(() => {
    if (!open) return;
    setCreatedUrl(null);
    form.resetFields();
  }, [open, form]);

  const handleCreate = async (values) => {
    setSubmitting(true);
    try {
      const res = await viewingApi.createLink(unitId, { note: values.note || null });
      const token = res.data.data.token;
      const url = `${window.location.origin}/book/viewing/${token}`;
      setCreatedUrl(url);
      onCreated?.();
    } catch (e) {
      message.error(e?.response?.data?.message || 'Failed to create link');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(createdUrl);
      message.success('Link copied to clipboard');
    } catch {
      message.error('Copy failed — please copy manually');
    }
  };

  return (
    <Modal
      title={createdUrl ? 'Share this link' : 'Generate viewing link'}
      open={open}
      onCancel={onClose}
      footer={createdUrl ? [
        <Button key="done" type="primary" onClick={onClose}>Done</Button>,
      ] : null}
      destroyOnClose
    >
      {!createdUrl ? (
        <Form form={form} layout="vertical" onFinish={handleCreate} disabled={submitting}>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message="Next step: assign an employee"
            description="After the link is generated, pick which employee receives approval emails. Until then, the public URL will show a 'not ready' page."
          />
          <Form.Item name="note" label="Internal note (optional)">
            <Input.TextArea rows={2} placeholder="e.g. Instagram listing August" maxLength={500} />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={submitting} block>
              Generate link
            </Button>
          </Form.Item>
        </Form>
      ) : (
        <>
          <Paragraph>
            Share this link with prospective viewers. You can revoke it anytime.
          </Paragraph>
          <Input
            value={createdUrl}
            readOnly
            addonAfter={
              <Button type="text" icon={<CopyOutlined />} onClick={handleCopy} size="small">
                Copy
              </Button>
            }
          />
          <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8 }}>
            The link opens a public booking form — no login required.
          </Paragraph>
        </>
      )}
    </Modal>
  );
}
