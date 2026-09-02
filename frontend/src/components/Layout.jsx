'use client';

import { Suspense, useState, createContext, useContext, useEffect, useCallback } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Layout, Menu, Avatar, Dropdown, Badge, Button, List, Typography, Empty, Popover, Spin, Tag, Drawer } from 'antd';
import {
  DashboardOutlined,
  HomeOutlined,
  TeamOutlined,
  FileTextOutlined,
  BarChartOutlined,
  CalendarOutlined,
  ToolOutlined,
  DollarOutlined,
  SettingOutlined,
  UserOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  BellOutlined,
  ClearOutlined,
  ThunderboltOutlined,
  MailOutlined,
  CheckOutlined,
  WarningOutlined,
  InfoCircleOutlined,
  CloseCircleOutlined,
  CheckCircleOutlined,
  MessageOutlined,
  SoundOutlined,
} from '@ant-design/icons';
import Cookies from 'js-cookie';
import { notification as notificationApi } from '../lib/api';
import useIsMobile from '../hooks/useIsMobile';
import MobileBottomNav from './mobile/MobileBottomNav';

const { Header, Sider, Content } = Layout;
const { Text } = Typography;

export const AuthContext = createContext(null);

// Build menu items dynamically based on permissions
function buildMenuItems(hasPermission, isSuperAdmin) {
  const items = [];

  // Dashboard — always visible to all authenticated users
  items.push({
    key: '/dashboard',
    icon: <DashboardOutlined />,
    label: <Link href="/dashboard">Dashboard</Link>,
  });

  // Properties (nested: list + viewings)
  if (hasPermission('LANDLORD/PROPERTY_LIST')) {
    items.push({
      key: '/property',
      icon: <HomeOutlined />,
      label: 'Properties',
      children: [
        { key: '/property/list', label: <Link href="/property">All Properties</Link> },
        // Viewing REQUESTS (the WhatsApp relay) and SCHEDULED viewings (confirmed bookings) are
        // the two live surfaces. /property/viewings — the tokenised viewing-LINK manager — is
        // deliberately no longer linked here: the link flow is retired (2 links in existence, last
        // booking 2026-04-18) and having it in the menu invited people to generate links for a flow
        // nothing consumes. The route still works for outstanding tokens; it is just not advertised.
        // /viewings/bookings used to be reachable ONLY from that page, so it is promoted here rather
        // than orphaned — it is where confirmed relay viewings appear.
        { key: '/property/viewings/negotiations', label: <Link href="/property/viewings/negotiations">Viewing Requests</Link> },
        { key: '/property/viewings/bookings', label: <Link href="/property/viewings/bookings">Scheduled Viewings</Link> },
      ],
    });
  }

  // Contacts — show parent only if user can see at least one child
  const contactChildren = [];
  if (hasPermission('LANDLORD/TENANT_LIST')) contactChildren.push({ key: '/contacts/tenants', label: <Link href="/contacts/tenants">Tenants</Link> });
  if (hasPermission('LANDLORD/TENANT_LIST')) contactChildren.push({ key: '/inquiries', label: <Link href="/inquiries">Inquiries</Link> });
  if (hasPermission('LANDLORD/EMAIL_GROUP_LIST')) contactChildren.push({ key: '/contacts/groups', label: <Link href="/contacts/groups">Groups</Link> });
  if (hasPermission('LANDLORD/PAYEE_LIST')) contactChildren.push({ key: '/contacts/payees', label: <Link href="/contacts/payees">Payees</Link> });
  if (hasPermission('LANDLORD/SERVICE_VENDOR_LIST')) contactChildren.push({ key: '/contacts/service-vendors', label: <Link href="/contacts/service-vendors">Service Vendors</Link> });
  if (contactChildren.length > 0) {
    items.push({
      key: '/contacts',
      icon: <TeamOutlined />,
      label: 'Contacts',
      children: contactChildren,
    });
  }

  // Leasing
  if (hasPermission('LANDLORD/LEASING_LIST')) {
    items.push({
      key: '/leasing',
      icon: <CalendarOutlined />,
      label: 'Leasing',
      children: [
        { key: '/leasing/list', label: <Link href="/leasing">Leases</Link> },
        { key: '/leasing/calendar', label: <Link href="/leasing/calendar">Calendar</Link> },
        { key: '/leasing/check-in-out', label: <Link href="/leasing/check-in-out">Check In / Check Out</Link> },
        { key: '/leasing/vacancy', label: <Link href="/leasing/vacancy">Vacancy</Link> },
      ],
    });
  }

  // Advertising — the Facebook posting pipeline (vacancy now lives under Leasing).
  if (hasPermission('LANDLORD/LEASING_LIST')) {
    items.push({
      key: '/advertising',
      icon: <SoundOutlined />,
      label: 'Advertising',
      children: [
        { key: '/advertising/scheduler', label: <Link href="/advertising/scheduler">Scheduler</Link> },
        { key: '/advertising/templates', label: <Link href="/advertising/templates">Templates</Link> },
        { key: '/advertising/forums', label: <Link href="/advertising/forums">Forums</Link> },
        { key: '/advertising/settings', label: <Link href="/advertising/settings">Settings</Link> },
      ],
    });
  }

  // Accounting — show parent only if user can see at least one child
  const accountingChildren = [];
  if (hasPermission('LANDLORD/ACCOUNTING_LIST')) accountingChildren.push({ key: '/accounting/accounts', label: <Link href="/accounting">Accounts</Link> });
  if (hasPermission('LANDLORD/INVOICE_LIST')) accountingChildren.push({ key: '/accounting/invoices', label: <Link href="/invoices">Invoices</Link> });
  // Reconcile — Xero sync queue. Gated by accounting permission for now;
  // promote to a dedicated permission if needed once usage stabilises.
  if (hasPermission('LANDLORD/ACCOUNTING_LIST')) accountingChildren.push({ key: '/accounting/reconcile', label: <Link href="/accounting/reconcile">Reconcile (Xero)</Link> });
  if (accountingChildren.length > 0) {
    items.push({
      key: '/accounting',
      icon: <DollarOutlined />,
      label: 'Accounting',
      children: accountingChildren,
    });
  }

  // Services
  if (hasPermission('LANDLORD/SERVICE_LIST')) {
    items.push({
      key: '/services',
      icon: <ToolOutlined />,
      label: <Link href="/services">Service</Link>,
    });
  }

  // Chatbot — parent shown if user has at least one child permission.
  // Order: Bookings, Internal, Sessions, then the settings-gated config pages.
  // Chat: Internal is gated on CHAT_SETTINGS_VIEW (it exposes all data + ad-hoc
  // SQL), so it has its own permission check between the session-gated items.
  const chatChildren = [];
  if (hasPermission('LANDLORD/CHAT_SESSION_LIST')) {
    chatChildren.push({ key: '/chatbot/test', label: <Link href="/chatbot/test">Chat: Bookings</Link> });
  }
  if (hasPermission('LANDLORD/CHAT_SETTINGS_VIEW')) {
    chatChildren.push({ key: '/chatbot/internal', label: <Link href="/chatbot/internal">Chat: Internal</Link> });
  }
  if (hasPermission('LANDLORD/CHAT_SESSION_LIST')) {
    chatChildren.push({ key: '/chatbot/sessions', label: <Link href="/chatbot/sessions">Sessions History</Link> });
  }
  if (hasPermission('LANDLORD/CHAT_SETTINGS_VIEW')) {
    // Config, Rules and FAQ are separate pages — flat siblings rather than a
    // nested sub-dropdown, so each is one click (and the sidebar collapses to
    // 80px, where deep nesting turns into a fiddly flyout).
    chatChildren.push({ key: '/chatbot/settings', label: <Link href="/chatbot/settings">Chatbot Settings</Link> });
    chatChildren.push({ key: '/chatbot/rules', label: <Link href="/chatbot/rules">Rules Database</Link> });
    chatChildren.push({ key: '/chatbot/faq', label: <Link href="/chatbot/faq">FAQ Database</Link> });
  }
  if (chatChildren.length > 0) {
    items.push({
      key: '/chatbot',
      icon: <MessageOutlined />,
      label: 'Chatbot',
      children: chatChildren,
    });
  }

  // Cleaning
  items.push({
    key: '/cleaning',
    icon: <ClearOutlined />,
    label: <Link href="/cleaning">Cleaning</Link>,
  });

  // Utilities
  items.push({
    key: '/utilities',
    icon: <ThunderboltOutlined />,
    label: <Link href="/utilities">Utilities</Link>,
  });

  // Reports
  const reportsChildren = [
    { key: '/reports/user-logs', label: <Link href="/reports/user-logs">User Logs</Link> },
    { key: '/reports/vacancy-cost', label: <Link href="/reports/vacancy-cost">Vacancy Cost</Link> },
  ];
  if (hasPermission('LANDLORD/REPORT/COMMISSION_VIEW')) {
    reportsChildren.push({ key: '/reports/commission', label: <Link href="/reports/commission">Commission Tracker</Link> });
  }
  items.push({
    key: '/reports',
    icon: <BarChartOutlined />,
    label: 'Reports',
    children: reportsChildren,
  });

  // Build settings children based on permissions
  const settingsChildren = [];

  // Personal settings — always visible to logged-in users
  settingsChildren.push({ key: '/settings?tab=personal', label: <Link href="/settings?tab=personal">Account Settings</Link> });
  if (hasPermission('LANDLORD/SETTING_LANDLORD')) settingsChildren.push({ key: '/settings?tab=landlord', label: <Link href="/settings?tab=landlord">Landlord Setting</Link> });
  if (hasPermission('LANDLORD/SETTING_AMENITY')) settingsChildren.push({ key: '/settings?tab=amenities', label: <Link href="/settings?tab=amenities">Amenity Setting</Link> });

  // Accounting settings sub-group
  const acctSettingsChildren = [];
  if (hasPermission('LANDLORD/SETTING_PAYMENT_METHODS')) acctSettingsChildren.push({ key: '/settings?tab=payment', label: <Link href="/settings?tab=payment">Payment Methods</Link> });
  if (hasPermission('LANDLORD/SETTING_CATEGORY')) acctSettingsChildren.push({ key: '/settings?tab=categories', label: <Link href="/settings?tab=categories">Categories</Link> });
  if (hasPermission('LANDLORD/SETTING_ACCOUNT')) acctSettingsChildren.push({ key: '/settings?tab=accounts', label: <Link href="/settings?tab=accounts">Accounts</Link> });
  if (hasPermission('LANDLORD/SETTING_SEQUENCE')) acctSettingsChildren.push({ key: '/settings?tab=sequences', label: <Link href="/settings?tab=sequences">Sequences</Link> });
  // Integrations (Xero, etc.) — grouped under Accounting since Xero is accounting
  // software. Gated by the email-template permission for now; promote to its own
  // permission when there's more than one integration needing separate gates.
  if (hasPermission('LANDLORD/SETTING_EMAIL_TEMPLATE')) acctSettingsChildren.push({ key: '/settings/integrations', label: <Link href="/settings/integrations">Integrations</Link> });
  if (acctSettingsChildren.length > 0) {
    settingsChildren.push({
      key: '/settings/accounting',
      label: 'Accounting Settings',
      children: acctSettingsChildren,
    });
  }

  // Channels sub-group (Email + WhatsApp). Each channel's page carries its own
  // templates + channel config (SMTP/whitelist, connection) as horizontal tabs.
  // Both reuse the email-template permission.
  const channelsChildren = [];
  if (hasPermission('LANDLORD/SETTING_EMAIL_TEMPLATE')) {
    channelsChildren.push({ key: '/settings?tab=emailTemplates', label: <Link href="/settings?tab=emailTemplates">Email</Link> });
    channelsChildren.push({ key: '/settings?tab=whatsappTemplates', label: <Link href="/settings?tab=whatsappTemplates">WhatsApp</Link> });
  }
  if (channelsChildren.length > 0) {
    settingsChildren.push({
      key: '/settings/channels',
      label: 'Channels',
      children: channelsChildren,
    });
  }

  // User Management sub-group
  const canSeeUsers = hasPermission('LANDLORD/USER_LIST');
  const canSeeRoles = hasPermission('LANDLORD/ROLE_LIST');
  if (canSeeUsers || canSeeRoles) {
    const userMgmtChildren = [];
    if (canSeeUsers) userMgmtChildren.push({ key: '/settings?tab=users', label: <Link href="/settings?tab=users">Create/Edit Users</Link> });
    if (canSeeRoles) userMgmtChildren.push({ key: '/settings?tab=roles', label: <Link href="/settings?tab=roles">Role Management</Link> });
    settingsChildren.push({
      key: '/settings/users',
      label: 'User Management',
      children: userMgmtChildren,
    });
  }

  // Booking & Commission
  settingsChildren.push({ key: '/settings?tab=bookingPlatforms', label: <Link href="/settings?tab=bookingPlatforms">Booking & Commission</Link> });

  // Calendar Sync — per-unit iCal feed URLs pasted into Airbnb listings. Sits next to
  // Booking & Commission because it is the same OTA-distribution job.
  settingsChildren.push({ key: '/settings/ical', label: <Link href="/settings/ical">Calendar Sync (iCal)</Link> });

  // Lease Templates — own route (not part of the settings Tabs system).
  // Gated by the same permission as email templates for now; can be split later.
  if (hasPermission('LANDLORD/SETTING_EMAIL_TEMPLATE')) {
    settingsChildren.push({ key: '/settings/lease-templates', label: <Link href="/settings/lease-templates">Lease Templates</Link> });
    settingsChildren.push({ key: '/settings/landlord-signatures', label: <Link href="/settings/landlord-signatures">Landlord Signatures</Link> });
  }

  // API Keys — super admin only
  if (isSuperAdmin) {
    settingsChildren.push({ key: '/settings?tab=apiKeys', label: <Link href="/settings?tab=apiKeys">API Keys</Link> });
  }

  if (settingsChildren.length > 0) {
    items.push({
      key: '/settings',
      icon: <SettingOutlined />,
      label: 'Settings',
      children: settingsChildren,
    });
  }

  return items;
}

export function AuthProvider({ children }) {
  const router = useRouter();
  const currentPathname = usePathname();
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  // Skip auth for master pages, login page, forgot-password flow, tenant portal,
  // public booking pages, and the public e-signature signing page (token-based, no login).
  const isPublicPage =
       currentPathname === '/login'
    || currentPathname === '/forget-password'
    || currentPathname.startsWith('/master')
    || currentPathname.startsWith('/tenant-portal')
    || currentPathname.startsWith('/book')
    || currentPathname.startsWith('/sign');

  useEffect(() => {
    if (isPublicPage) {
      setLoading(false);
      return;
    }
    const token = Cookies.get('__s_t');
    if (!token) {
      router.push('/login');
      setLoading(false);
    } else {
      // Fetch profile with permissions and orgType
      import('../lib/api').then(({ user: userApi }) => {
        userApi.getProfile().then(r => {
          if (r.data.code === 200) {
            setUser(r.data.data);
          } else {
            Cookies.remove('__s_t');
            router.push('/login');
          }
        }).catch(() => {
          // If profile fetch fails, still allow basic usage
          setUser({ name: 'User' });
        }).finally(() => setLoading(false));
      });
    }
  }, [router, isPublicPage]);

  const isSuperAdmin = Number(user?.orgType) === 6;

  const hasPermission = (perm) => {
    if (isSuperAdmin) return true;
    if (!user?.permissions) return false;
    if (user.permissions.includes('*')) return true;
    return user.permissions.includes(perm);
  };

  const logout = () => {
    Cookies.remove('__s_t');
    router.push('/login');
  };

  return (
    <AuthContext.Provider value={{ user, loading, logout, isSuperAdmin, hasPermission }}>
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
export default function MainLayoutWrapper({ children }) {
  return <Suspense fallback={<div />}><MainLayout>{children}</MainLayout></Suspense>;
}

function MainLayout({ children }) {
  const [collapsed, setCollapsed] = useState(false);
  const [openKeys, setOpenKeys] = useState([]);
  const pathname = usePathname();
  const router = useRouter();
  const { user, logout, hasPermission, isSuperAdmin } = useAuth();
  const { isMobile } = useIsMobile();

  const searchParams = useSearchParams();
  const tab = searchParams.get('tab');

  // Determine which menu key is selected based on pathname + tab
  const getSelectedKeys = () => {
    if (pathname.startsWith('/accounting') || pathname.startsWith('/invoices')) {
      if (pathname.startsWith('/invoices')) return ['/accounting/invoices'];
      return ['/accounting/accounts'];
    }
    if (pathname.startsWith('/settings') && tab) {
      // Channel sub-tabs (SMTP/whitelist/connection) have no own sidebar entry —
      // highlight their channel's menu item so the sidebar reflects the section.
      if (['smtpAccounts', 'emailSettings'].includes(tab)) return ['/settings?tab=emailTemplates'];
      if (tab === 'whatsappSettings') return ['/settings?tab=whatsappTemplates'];
      return [`/settings?tab=${tab}`];
    }
    // Leasing sub-routes
    if (pathname.startsWith('/leasing')) {
      if (pathname === '/leasing/calendar') return ['/leasing/calendar'];
      if (pathname.startsWith('/leasing/check-in-out')) return ['/leasing/check-in-out'];
      if (pathname.startsWith('/leasing/vacancy')) return ['/leasing/vacancy'];
      return ['/leasing/list'];
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
    if (pathname.startsWith('/leasing')) keys.push('/leasing');
    if (pathname.startsWith('/contacts')) keys.push('/contacts');
    if (pathname.startsWith('/chatbot')) keys.push('/chatbot');
    if (pathname.startsWith('/settings')) {
      keys.push('/settings'); // Always open parent Settings
      if (pathname.startsWith('/settings/integrations')) {
        keys.push('/settings/accounting');
      } else if (['payment', 'categories', 'accounts', 'sequences'].includes(tab)) {
        keys.push('/settings/accounting');
      } else if (['emailTemplates', 'smtpAccounts', 'emailSettings', 'whatsappTemplates', 'whatsappSettings'].includes(tab)) {
        keys.push('/settings/channels');
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
      label: <Link href="/settings?tab=personal">Profile</Link>,
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

  const allMenuItems = buildMenuItems(hasPermission || (() => false), isSuperAdmin);

  // ── Mobile layout ──
  if (isMobile) {
    return (
      <Layout style={{ minHeight: '100vh' }}>
        {/* Compact mobile header */}
        <Header
          style={{
            padding: '0 12px',
            background: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            height: 48,
            lineHeight: '48px',
            borderBottom: '1px solid #f0f0f0',
            position: 'sticky',
            top: 0,
            zIndex: 999,
          }}
        >
          <h1 style={{ margin: 0, fontSize: 16, fontWeight: 'bold', color: '#1890ff' }}>Tenafy</h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <NotificationBell />
            <Dropdown menu={{ items: userMenuItems }} placement="bottomRight">
              <Avatar icon={<UserOutlined />} size={28} style={{ cursor: 'pointer' }} />
            </Dropdown>
          </div>
        </Header>

        {/* Content with bottom padding for nav bar */}
        <Content
          style={{
            margin: 0,
            padding: 12,
            background: '#fff',
            minHeight: 'calc(100vh - 48px - 60px)',
            paddingBottom: 72,
          }}
        >
          {children}
        </Content>

        {/* Bottom tab navigation */}
        <MobileBottomNav menuItems={allMenuItems} />
      </Layout>
    );
  }

  // ── Desktop layout (unchanged) ──
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
          items={allMenuItems}
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
                <span>{user?.first_name ? `${user.first_name} ${user.last_name || ''}`.trim() : (user?.username || 'User')}</span>
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
