'use client';

import { useState, createContext, useContext, useEffect, useCallback } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Layout, Menu, Avatar, Dropdown, Badge, Button, List, Typography, Empty, Popover, Spin, Tag } from 'antd';
import {
  DashboardOutlined,
  HomeOutlined,
  TeamOutlined,
  FileTextOutlined,
  CalendarOutlined,
  ToolOutlined,
  DollarOutlined,
  SettingOutlined,
  UserOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  BellOutlined,
  MailOutlined,
  CheckOutlined,
  WarningOutlined,
  InfoCircleOutlined,
  CloseCircleOutlined,
  CheckCircleOutlined,
} from '@ant-design/icons';
import Cookies from 'js-cookie';
import { notification as notificationApi } from '../lib/api';

const { Header, Sider, Content } = Layout;
const { Text } = Typography;

export const AuthContext = createContext(null);

const menuItems = [
  {
    key: '/dashboard',
    icon: <DashboardOutlined />,
    label: <Link href="/dashboard">Dashboard</Link>,
  },
  {
    key: '/property',
    icon: <HomeOutlined />,
    label: <Link href="/property">Properties</Link>,
  },
  {
    key: '/contacts',
    icon: <TeamOutlined />,
    label: 'Contacts',
    children: [
      { key: '/contacts/tenants', label: <Link href="/contacts/tenants">Tenants</Link> },
      { key: '/contacts/groups', label: <Link href="/contacts/groups">Groups</Link> },
      { key: '/contacts/payees', label: <Link href="/contacts/payees">Payees</Link> },
      { key: '/contacts/service-vendors', label: <Link href="/contacts/service-vendors">Service Vendors</Link> },
    ],
  },
  {
    key: '/leasing',
    icon: <CalendarOutlined />,
    label: <Link href="/leasing">Leasing</Link>,
  },
  {
    key: '/accounting',
    icon: <DollarOutlined />,
    label: 'Accounting',
    children: [
      {
        key: '/accounting/accounts',
        label: <Link href="/accounting">Accounts</Link>,
      },
      {
        key: '/accounting/invoices',
        label: <Link href="/invoices">Invoices</Link>,
      },
    ],
  },
  {
    key: '/services',
    icon: <ToolOutlined />,
    label: <Link href="/services">Service</Link>,
  },
  {
    key: '/settings',
    icon: <SettingOutlined />,
    label: 'Settings',
    children: [
      { key: '/settings?tab=personal', label: <Link href="/settings?tab=personal">Account Settings</Link> },
      { key: '/settings?tab=landlord', label: <Link href="/settings?tab=landlord">Landlord Setting</Link> },
      { key: '/settings?tab=amenities', label: <Link href="/settings?tab=amenities">Amenity Setting</Link> },
      {
        key: '/settings/accounting',
        label: 'Accounting Settings',
        children: [
          { key: '/settings?tab=payment', label: <Link href="/settings?tab=payment">Payment Methods</Link> },
          { key: '/settings?tab=categories', label: <Link href="/settings?tab=categories">Categories</Link> },
        ],
      },
      {
        key: '/settings/email',
        label: 'Email Settings',
        children: [
          { key: '/settings?tab=emailTemplates', label: <Link href="/settings?tab=emailTemplates">Email Template</Link> },
        ],
      },
      {
        key: '/settings/users',
        label: 'User Management',
        children: [
          { key: '/settings?tab=users', label: <Link href="/settings?tab=users">Users</Link> },
          { key: '/settings?tab=roles', label: <Link href="/settings?tab=roles">Role Management</Link> },
        ],
      },
    ],
  },
];

export function AuthProvider({ children }) {
  const router = useRouter();
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = Cookies.get('__s_t');
    if (!token) {
      router.push('/login');
    } else {
      setUser({ name: 'User' });
    }
    setLoading(false);
  }, [router]);

  const logout = () => {
    Cookies.remove('__s_t');
    router.push('/login');
  };

  return (
    <AuthContext.Provider value={{ user, loading, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}

// ---------------------------------------------------------------------------
// Notification type helpers
// ---------------------------------------------------------------------------
const typeConfig = {
  error:   { color: '#ff4d4f', icon: <CloseCircleOutlined style={{ color: '#ff4d4f' }} /> },
  warning: { color: '#faad14', icon: <WarningOutlined style={{ color: '#faad14' }} /> },
  success: { color: '#52c41a', icon: <CheckCircleOutlined style={{ color: '#52c41a' }} /> },
  info:    { color: '#1677ff', icon: <InfoCircleOutlined style={{ color: '#1677ff' }} /> },
};

function getTypeConfig(type) {
  return typeConfig[type] || typeConfig.info;
}

function timeAgo(dateStr) {
  const now = new Date();
  const date = new Date(dateStr);
  const diffMs = now - date;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return date.toLocaleDateString();
}

// ---------------------------------------------------------------------------
// Notification bell + dropdown component
// ---------------------------------------------------------------------------
function NotificationBell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);

  const loadRecent = useCallback(async () => {
    try {
      setLoading(true);
      const res = await notificationApi.getRecent();
      if (res.data.code === 200) {
        setNotifications(res.data.data.notifications || []);
        setUnreadCount(res.data.data.unreadCount || 0);
      }
    } catch (err) {
      console.error('Failed to load notifications:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  // Load on mount, then poll every 60 seconds
  useEffect(() => {
    loadRecent();
    const interval = setInterval(loadRecent, 60000);
    return () => clearInterval(interval);
  }, [loadRecent]);

  // Reload when dropdown opens
  useEffect(() => {
    if (open) loadRecent();
  }, [open, loadRecent]);

  const handleMarkRead = async (id, e) => {
    e.stopPropagation();
    try {
      await notificationApi.markRead(id);
      setNotifications(prev => prev.map(n => n.id === id ? { ...n, is_read: 1 } : n));
      setUnreadCount(prev => Math.max(0, prev - 1));
    } catch (err) {
      console.error('Failed to mark read:', err);
    }
  };

  const handleMarkAllRead = async () => {
    try {
      await notificationApi.markAllRead();
      setNotifications(prev => prev.map(n => ({ ...n, is_read: 1 })));
      setUnreadCount(0);
    } catch (err) {
      console.error('Failed to mark all read:', err);
    }
  };

  const handleClick = (item) => {
    if (item.link) {
      router.push(item.link);
      setOpen(false);
    }
    if (!item.is_read) {
      notificationApi.markRead(item.id).then(() => {
        setNotifications(prev => prev.map(n => n.id === item.id ? { ...n, is_read: 1 } : n));
        setUnreadCount(prev => Math.max(0, prev - 1));
      });
    }
  };

  const content = (
    <div style={{ width: 360 }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid #f0f0f0' }}>
        <Text strong style={{ fontSize: 15 }}>Notifications</Text>
        {unreadCount > 0 && (
          <Button type="link" size="small" onClick={handleMarkAllRead} icon={<CheckOutlined />}>
            Mark all read
          </Button>
        )}
      </div>

      {/* List */}
      {loading && notifications.length === 0 ? (
        <div style={{ padding: 24, textAlign: 'center' }}><Spin /></div>
      ) : notifications.length === 0 ? (
        <Empty description="No notifications" image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ padding: '24px 0' }} />
      ) : (
        <List
          dataSource={notifications}
          style={{ maxHeight: 350, overflow: 'auto' }}
          renderItem={(item) => {
            const cfg = getTypeConfig(item.type);
            return (
              <List.Item
                onClick={() => handleClick(item)}
                style={{
                  padding: '10px 12px',
                  cursor: item.link ? 'pointer' : 'default',
                  background: item.is_read ? '#fff' : '#f6f8ff',
                  borderLeft: item.is_read ? '3px solid transparent' : `3px solid ${cfg.color}`,
                }}
                actions={!item.is_read ? [
                  <Button
                    key="read"
                    type="text"
                    size="small"
                    icon={<CheckOutlined />}
                    onClick={(e) => handleMarkRead(item.id, e)}
                    title="Mark as read"
                  />
                ] : undefined}
              >
                <List.Item.Meta
                  avatar={cfg.icon}
                  title={<Text style={{ fontSize: 13, fontWeight: item.is_read ? 400 : 600 }}>{item.title}</Text>}
                  description={
                    <div>
                      <Text type="secondary" style={{ fontSize: 12 }}>{item.message}</Text>
                      <br />
                      <Text type="secondary" style={{ fontSize: 11 }}>{timeAgo(item.created_at)}</Text>
                    </div>
                  }
                />
              </List.Item>
            );
          }}
        />
      )}

      {/* Footer */}
      <div style={{ borderTop: '1px solid #f0f0f0', padding: '8px 12px', textAlign: 'center' }}>
        <Button type="link" onClick={() => { setOpen(false); router.push('/notifications'); }}>
          View All Notifications
        </Button>
      </div>
    </div>
  );

  return (
    <Popover
      content={content}
      trigger="click"
      open={open}
      onOpenChange={setOpen}
      placement="bottomRight"
      arrow={false}
      overlayStyle={{ padding: 0 }}
      overlayInnerStyle={{ padding: 0 }}
    >
      <Badge count={unreadCount} size="small" offset={[-2, 2]}>
        <BellOutlined style={{ fontSize: 20, cursor: 'pointer' }} />
      </Badge>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Main Layout
// ---------------------------------------------------------------------------
export default function MainLayout({ children }) {
  const [collapsed, setCollapsed] = useState(false);
  const [openKeys, setOpenKeys] = useState([]);
  const pathname = usePathname();
  const router = useRouter();
  const { user, logout } = useAuth();

  const searchParams = useSearchParams();
  const tab = searchParams.get('tab');

  // Determine which menu key is selected based on pathname + tab
  const getSelectedKeys = () => {
    if (pathname.startsWith('/accounting') || pathname.startsWith('/invoices')) {
      if (pathname.startsWith('/invoices')) return ['/accounting/invoices'];
      return ['/accounting/accounts'];
    }
    if (pathname.startsWith('/settings') && tab) {
      return [`/settings?tab=${tab}`];
    }
    // Contacts sub-routes
    if (pathname.startsWith('/contacts')) {
      if (pathname.includes('/service-vendor')) return ['/contacts/service-vendors'];
      if (pathname.includes('/payee')) return ['/contacts/payees'];
      if (pathname.includes('/group') || pathname.includes('/email')) return ['/contacts/groups'];
      return ['/contacts/tenants']; // tenant detail pages, create, etc.
    }
    return [pathname];
  };

  // Set initial open keys based on current path
  useEffect(() => {
    const keys = [];
    if (pathname.startsWith('/accounting') || pathname.startsWith('/invoices')) keys.push('/accounting');
    if (pathname.startsWith('/contacts')) keys.push('/contacts');
    if (pathname.startsWith('/settings')) {
      keys.push('/settings'); // Always open parent Settings
      if (['payment', 'categories'].includes(tab)) {
        keys.push('/settings/accounting');
      } else if (['emailTemplates'].includes(tab)) {
        keys.push('/settings/email');
      } else if (['users', 'roles'].includes(tab)) {
        keys.push('/settings/users');
      }
    }
    setOpenKeys(prev => {
      const merged = new Set([...prev, ...keys]);
      return Array.from(merged);
    });
  }, [pathname, tab]);

  const userMenuItems = [
    {
      key: 'profile',
      icon: <UserOutlined />,
      label: 'Profile',
    },
    {
      key: 'settings',
      icon: <SettingOutlined />,
      label: <Link href="/settings">Settings</Link>,
    },
    {
      type: 'divider',
    },
    {
      key: 'logout',
      icon: <LogoutOutlined />,
      label: 'Logout',
      onClick: logout,
    },
  ];

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider
        trigger={null}
        collapsible
        collapsed={collapsed}
        style={{
          overflow: 'auto',
          height: '100vh',
          position: 'fixed',
          left: 0,
          top: 0,
          bottom: 0,
          background: '#001529',
        }}
      >
        <div
          style={{
            height: 64,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: '#001529',
          }}
        >
          <h1
            style={{
              color: '#fff',
              margin: 0,
              fontSize: collapsed ? 14 : 18,
              fontWeight: 'bold',
            }}
          >
            {collapsed ? 'T' : 'Tenafy'}
          </h1>
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={getSelectedKeys()}
          openKeys={openKeys}
          onOpenChange={setOpenKeys}
          items={menuItems}
          style={{ background: '#001529' }}
        />
      </Sider>
      <Layout style={{ marginLeft: collapsed ? 80 : 200, transition: 'margin-left 0.2s' }}>
        <Header
          style={{
            padding: '0 24px',
            background: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <Button
            type="text"
            icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            onClick={() => setCollapsed(!collapsed)}
            style={{ fontSize: 16 }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
            <NotificationBell />
            <Dropdown menu={{ items: userMenuItems }} placement="bottomRight">
              <div style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', gap: 8 }}>
                <Avatar icon={<UserOutlined />} />
                <span>{user?.name || 'User'}</span>
              </div>
            </Dropdown>
          </div>
        </Header>
        <Content
          style={{
            margin: 24,
            padding: 24,
            background: '#fff',
            minHeight: 280,
          }}
        >
          {children}
        </Content>
      </Layout>
    </Layout>
  );
}
