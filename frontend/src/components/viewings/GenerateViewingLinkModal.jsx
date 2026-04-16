'use client';

import { useEffect, useState } from 'react';
import { Modal, Form, Select, Input, Button, message, Typography, Alert } from 'antd';
import { CopyOutlined } from '@ant-design/icons';
import { viewingApi, user as userApi } from '../../lib/api';

const { Text, Paragraph } = Typography;

/**
 * Modal for generating a shareable viewing link for a unit.
 * - Staff pick which employee receives the approval emails.
 * - After creation, the public URL is shown with a copy button.
 */
export default function GenerateViewingLinkModal({ open, unitId, onClose, onCreated }) {
  const [form] = Form.useForm();
  const [users, setUsers] = useState([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [createdUrl, setCreatedUrl] = useState(null);

  useEffect(() => {
    if (!open) return;
    setCreatedUrl(null);
    form.resetFields();
    setLoadingUsers(true);
    userApi.listUsers({}, { pageNum: 1, pageSize: 500 })
      .then((r) => {
        const list = r?.data?.data?.records || r?.data?.data?.list || r?.data?.data || [];
        setUsers(Array.isArray(list) ? list : []);
      })
      .catch(() => setUsers([]))
      .finally(() => setLoadingUsers(false));
  }, [open, form]);

  const handleCreate = async (values) => {
    setSubmitting(true);
    try {
      const res = await viewingApi.createLink(unitId, {
        employee_id: values.employee_id,
        note: values.note || null,
      });
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
            message="Anyone with the generated link can request a viewing."
            description="The chosen employee will receive an approval email for every request. If the unit is occupied, the current tenant is also asked to approve."
          />
          <Form.Item
            name="employee_id"
            label="Employee handling viewings"
            rules={[{ required: true, message: 'Please pick an employee' }]}
          >
            <Select
              loading={loadingUsers}
              placeholder="Select employee"
              showSearch
              optionFilterProp="label"
              options={users.map(u => ({
                value: String(u.id),
                label: [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || u.username,
              }))}
            />
          </Form.Item>
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
