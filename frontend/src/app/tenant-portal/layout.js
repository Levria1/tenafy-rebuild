'use client';

import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { Layout, Menu, Button, Typography, Space, theme } from 'antd';
import {
  DashboardOutlined,
  FileTextOutlined,
  ContainerOutlined,
  UserOutlined,
  LogoutOutlined,
} from '@ant-design/icons';
import Cookies from 'js-cookie';

const { Header, Content, Footer } = Layout;
const { Text } = Typography;

const navItems = [
  { key: '/tenant-portal/dashboard', label: 'Dashboard', icon: <DashboardOutlined /> },
  { key: '/tenant-portal/leases', label: 'Leases', icon: <FileTextOutlined /> },
  { key: '/tenant-portal/invoices', label: 'Invoices', icon: <ContainerOutlined /> },
  { key: '/tenant-portal/profile', label: 'Profile', icon: <UserOutlined /> },
];

export default function TenantPortalLayout({ children }) {
  const router = useRouter();
  const pathname = usePathname();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const token = Cookies.get('__s_t');
    if (!token && pathname !== '/tenant-portal/login') {
      router.replace('/tenant-portal/login');
    }
  }, [pathname, router]);

  const handleLogout = () => {
    Cookies.remove('__s_t');
    router.push('/tenant-portal/login');
  };

  const handleMenuClick = ({ key }) => {
    router.push(key);
  };

  // Don't render the layout nav on the login page
  if (pathname === '/tenant-portal/login') {
    return <>{children}</>;
  }

  if (!mounted) {
    return null;
  }

  const selectedKey = navItems.find((item) => pathname.startsWith(item.key))?.key || '';

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 24px',
          background: '#001529',
          position: 'sticky',
          top: 0,
          zIndex: 1000,
        }}
      >
        <Space align="center" size={32}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: '50%',
                background: '#1890ff',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <span style={{ color: '#fff', fontSize: 14, fontWeight: 'bold' }}>T</span>
            </div>
            <Text style={{ color: '#fff', fontWeight: 'bold', fontSize: 16, whiteSpace: 'nowrap' }}>
              Tenant Portal
            </Text>
          </div>

          <Menu
            theme="dark"
            mode="horizontal"
            selectedKeys={[selectedKey]}
            onClick={handleMenuClick}
            items={navItems}
            style={{ background: 'transparent', borderBottom: 'none', minWidth: 400 }}
          />
        </Space>

        <Button
          icon={<LogoutOutlined />}
          onClick={handleLogout}
          type="text"
          style={{ color: '#fff' }}
        >
          Logout
        </Button>
      </Header>

      <Content style={{ padding: '24px', background: '#f0f2f5' }}>
        <div style={{ maxWidth: 1200, margin: '0 auto' }}>{children}</div>
      </Content>

      <Footer style={{ textAlign: 'center', color: '#8c8c8c' }}>
        Tenafy Tenant Portal &copy; {new Date().getFullYear()}
      </Footer>
    </Layout>
  );
}
