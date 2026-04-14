'use client';

import { useRouter } from 'next/navigation';
import { Button, Space } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';

/**
 * Simplified mobile page header with back button and title.
 *
 * Props:
 *  - title: string
 *  - onBack: function (optional — defaults to router.back())
 *  - extra: JSX (optional — action buttons on the right)
 */
export default function MobilePageHeader({ title, onBack, extra }) {
  const router = useRouter();

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '8px 0',
        marginBottom: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <Button
          type="text"
          icon={<ArrowLeftOutlined />}
          onClick={onBack || (() => router.back())}
          style={{ flexShrink: 0 }}
        />
        <h2
          style={{
            margin: 0,
            fontSize: 17,
            fontWeight: 600,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {title}
        </h2>
      </div>
      {extra && <Space size={8}>{extra}</Space>}
    </div>
  );
}
