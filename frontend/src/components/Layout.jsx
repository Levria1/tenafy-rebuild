'use client';

import { useState, createContext, useContext, useEffect } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Layout, Menu, Avatar, Dropdown, Badge, Button } from 'antd';
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
} from '@ant-design/icons';
import Cookies from 'js-cookie';

const { Header, Sider, Content } = Layout;

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
    label: <Link href="/contacts">Contacts</Link>,
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

  // Navigation is handled by <Link> inside menu items, no onClick needed

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
            <Badge count={3}>
              <BellOutlined style={{ fontSize: 20, cursor: 'pointer' }} />
            </Badge>
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