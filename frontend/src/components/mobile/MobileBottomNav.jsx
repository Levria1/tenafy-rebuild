'use client';

import { useState } from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { Drawer, Menu } from 'antd';
import {
  DashboardOutlined,
  HomeOutlined,
  TeamOutlined,
  DollarOutlined,
  MenuOutlined,
  CalendarOutlined,
  ToolOutlined,
  ClearOutlined,
  ThunderboltOutlined,
  BarChartOutlined,
  SettingOutlined,
  FileTextOutlined,
} from '@ant-design/icons';

const PRIMARY = '#1890ff';
const INACTIVE = '#999';

const mainTabs = [
  { key: '/dashboard', icon: DashboardOutlined, label: 'Home' },
  { key: '/property', icon: HomeOutlined, label: 'Properties' },
  { key: '/contacts', icon: TeamOutlined, label: 'Contacts' },
  { key: '/accounting', icon: DollarOutlined, label: 'Accounting' },
  { key: 'more', icon: MenuOutlined, label: 'More' },
];

/**
 * Fixed bottom tab navigation for mobile screens.
 * Shows 5 tabs: Dashboard, Properties, Contacts, Accounting, More.
 * "More" opens a drawer with the remaining nav items.
 */
export default function MobileBottomNav({ menuItems = [] }) {
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);

  const isActive = (key) => {
    if (key === '/contacts') return pathname.startsWith('/contacts');
    if (key === '/accounting') return pathname.startsWith('/accounting') || pathname.startsWith('/invoices');
    return pathname.startsWith(key);
  };

  // "More" drawer shows items not in the main tabs
  const moreKeys = ['/dashboard', '/property', '/contacts', '/accounting'];
  const moreMenuItems = menuItems.filter(item => !moreKeys.includes(item.key));

  const isMoreActive = moreMenuItems.some(item => {
    if (item.children) return item.children.some(c => pathname.startsWith(c.key?.split('?')[0]));
    return pathname.startsWith(item.key?.split('?')[0]);
  });

  return (
    <>
      <div
        style={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          height: 60,
          background: '#fff',
          borderTop: '1px solid #e8e8e8',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-around',
          zIndex: 1000,
          paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        }}
      >
        {mainTabs.map((tab) => {
          const active = tab.key === 'more' ? (isMoreActive && !drawerOpen) : isActive(tab.key);
          const Icon = tab.icon;

          if (tab.key === 'more') {
            return (
              <div
                key="more"
                onClick={() => setDrawerOpen(true)}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  cursor: 'pointer',
                  flex: 1,
                  padding: '6px 0',
                }}
              >
                <Icon style={{ fontSize: 20, color: active ? PRIMARY : INACTIVE }} />
                <span style={{ fontSize: 10, color: active ? PRIMARY : INACTIVE, marginTop: 2 }}>
                  {tab.label}
                </span>
              </div>
            );
          }

          return (
            <Link
              key={tab.key}
              href={tab.key}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                flex: 1,
                padding: '6px 0',
                textDecoration: 'none',
              }}
            >
              <Icon style={{ fontSize: 20, color: active ? PRIMARY : INACTIVE }} />
              <span style={{ fontSize: 10, color: active ? PRIMARY : INACTIVE, marginTop: 2 }}>
                {tab.label}
              </span>
            </Link>
          );
        })}
      </div>

      {/* More drawer */}
      <Drawer
        title="Menu"
        placement="bottom"
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        height="70vh"
        styles={{ body: { padding: 0 } }}
      >
        <Menu
          mode="inline"
          items={moreMenuItems}
          selectedKeys={[pathname]}
          onClick={() => setDrawerOpen(false)}
          style={{ border: 'none' }}
        />
      </Drawer>
    </>
  );
}
