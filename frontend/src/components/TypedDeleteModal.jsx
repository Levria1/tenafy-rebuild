'use client';

import { useState, useEffect } from 'react';
import { Modal, Input, Button, message } from 'antd';
import { ExclamationCircleOutlined } from '@ant-design/icons';

/**
 * Typed delete confirmation modal.
 *
 * Forces the user to type "DELETE" (case-sensitive by default) before the
 * Delete button enables. Use for destructive operations that cannot be
 * trivially reversed: deleting properties, leases, meters, etc.
 *
 * Usage:
 *   const [open, setOpen] = useState(false);
 *   const [target, setTarget] = useState(null);
 *
 *   <TypedDeleteModal
 *     open={open}
 *     itemLabel={target?.name}
 *     itemType="property"
 *     warning="All units and lease history will be removed."
 *     onCancel={() => setOpen(false)}
 *     onConfirm={async () => {
 *       await api.delete(target.id);
 *       setOpen(false);
 *     }}
 *   />
 */
export default function TypedDeleteModal({
  open,
  onCancel,
  onConfirm,
  itemLabel,         // string — name of the thing being deleted (e.g. "Pearl City Mansion")
  itemType = 'item', // string — category noun (e.g. "property", "lease", "meter")
  warning,           // optional — extra warning text shown above the input
  confirmWord = 'DELETE',
}) {
  const [typed, setTyped] = useState('');
  const [loading, setLoading] = useState(false);

  // Reset typed value whenever the modal opens
  useEffect(() => {
    if (open) setTyped('');
  }, [open]);

  const matches = typed === confirmWord;

  const handleConfirm = async () => {
    if (!matches) return;
    setLoading(true);
    try {
      await onConfirm();
    } catch (err) {
      // onConfirm should typically handle its own errors; surface anything that escapes
      message.error(err?.response?.data?.message || err?.message || 'Delete failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      open={open}
      onCancel={() => { if (!loading) onCancel(); }}
      title={
        <span>
          <ExclamationCircleOutlined style={{ color: '#ff4d4f', marginRight: 8 }} />
          Delete {itemType}
        </span>
      }
      footer={[
        <Button key="cancel" onClick={onCancel} disabled={loading}>
          Cancel
        </Button>,
        <Button
          key="delete"
          danger
          type="primary"
          disabled={!matches}
          loading={loading}
          onClick={handleConfirm}
        >
          Delete
        </Button>,
      ]}
      destroyOnClose
      maskClosable={!loading}
      closable={!loading}
    >
      <div style={{ marginBottom: 12 }}>
        You are about to delete {itemLabel ? <strong>{itemLabel}</strong> : `this ${itemType}`}.
        {' '}This action <strong>cannot be undone</strong>.
      </div>
      {warning && (
        <div style={{
          marginBottom: 12, padding: 10,
          background: '#fff2f0', border: '1px solid #ffccc7', borderRadius: 4,
          fontSize: 13, color: '#a8071a',
        }}>
          {warning}
        </div>
      )}
      <div style={{ marginBottom: 6, fontSize: 13, color: '#555' }}>
        Type <code style={{ background: '#f5f5f5', padding: '2px 6px', borderRadius: 3, fontWeight: 600 }}>{confirmWord}</code> below to confirm:
      </div>
      <Input
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        placeholder={confirmWord}
        autoFocus
        onPressEnter={handleConfirm}
        status={typed && !matches ? 'warning' : undefined}
      />
    </Modal>
  );
}
