'use client';

import { Drawer, Button, Space } from 'antd';
import { FilterOutlined } from '@ant-design/icons';

/**
 * Bottom-sheet drawer for mobile filters.
 * Replaces inline Popover/Space filter bars that don't work well on mobile.
 *
 * Props:
 *  - open: boolean
 *  - onClose: function
 *  - onReset: function (optional — adds a Reset button)
 *  - children: JSX — the filter form fields
 *  - title: string (optional, defaults to 'Filters')
 */
export default function MobileFilterSheet({ open, onClose, onReset, children, title = 'Filters' }) {
  return (
    <Drawer
      title={title}
      placement="bottom"
      open={open}
      onClose={onClose}
      height="60vh"
      styles={{ body: { padding: '16px' } }}
      extra={
        <Space>
          {onReset && (
            <Button size="small" onClick={onReset}>
              Reset
            </Button>
          )}
          <Button type="primary" size="small" onClick={onClose}>
            Apply
          </Button>
        </Space>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {children}
      </div>
    </Drawer>
  );
}

/**
 * Compact filter trigger button for mobile.
 * Shows the filter icon + optional active count badge.
 */
export function MobileFilterButton({ onClick, activeCount = 0 }) {
  return (
    <Button
      icon={<FilterOutlined />}
      onClick={onClick}
      size="middle"
      style={{ minHeight: 36 }}
    >
      Filters{activeCount > 0 ? ` (${activeCount})` : ''}
    </Button>
  );
}
