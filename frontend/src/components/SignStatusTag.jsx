'use client';

import { Tag, Tooltip } from 'antd';
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  EditOutlined,
  FileTextOutlined,
} from '@ant-design/icons';

/**
 * Sign-status pill for a lease, driven by the backend-computed `pdf_status`
 * (see backend/src/services/leaseTemplateResolver.js). Single source of truth
 * so the lease-detail button tag and the Leases-list column always agree.
 *
 *   signed   → fully signed (final PDF stored)
 *   pending  → sent, awaiting signatures
 *   declined → a party declined; re-send
 *   unsigned → real template resolves but was never sent  (ACTION: send it)
 *   basic    → no template configured; View Lease is the generic Basic PDF
 */
export const SIGN_STATUS_META = {
  signed:   { color: 'green',   label: 'Signed',              icon: <CheckCircleOutlined />,    tip: 'This lease has been signed.' },
  pending:  { color: 'orange',  label: 'Awaiting signature',  icon: <ClockCircleOutlined />,    tip: 'Sent for e-signature — waiting on signatures.' },
  declined: { color: 'red',     label: 'Declined',            icon: <CloseCircleOutlined />,    tip: 'A party declined — re-send for signature.' },
  unsigned: { color: 'default', label: 'Unsigned',            icon: <EditOutlined />,           tip: 'A lease template is ready — click "Generate Lease for E-Signature" to send it.' },
  basic:    { color: 'blue',    label: 'Basic only',          icon: <FileTextOutlined />,       tip: 'No lease template is configured, so only the generic Basic PDF is available. Set up a lease template to enable e-signature.' },
};

export default function SignStatusTag({ status, showTip = true }) {
  const meta = SIGN_STATUS_META[status] || SIGN_STATUS_META.basic;
  const tag = (
    <Tag color={meta.color} icon={meta.icon} style={{ marginInlineEnd: 0 }}>
      {meta.label}
    </Tag>
  );
  return showTip ? <Tooltip title={meta.tip}>{tag}</Tooltip> : tag;
}
