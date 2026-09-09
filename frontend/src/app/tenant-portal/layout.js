'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { Layout, Menu, Button, Typography, Space, Spin, Result } from 'antd';
import {
  DashboardOutlined,
  FileTextOutlined,
  ContainerOutlined,
  UserOutlined,
  ToolOutlined,
  ThunderboltOutlined,
  LogoutOutlined,
} from '@ant-design/icons';
import { tenantPortal } from '../../lib/tenantApi';

const { Header, Content, Footer } = Layout;
const { Text } = Typography;

// `feature` marks a tab that only appears when the profile probe says this tenant has
// anything to see there. Utilities is metered electricity, which most orgs do not bill,
// so an always-present tab would be permanently empty for them.
const navItems = [
  { key: '/tenant-portal/dashboard', label: 'Dashboard', icon: <DashboardOutlined /> },
  { key: '/tenant-portal/leases', label: 'Leases', icon: <FileTextOutlined /> },
  { key: '/tenant-portal/invoices', label: 'Invoices', icon: <ContainerOutlined /> },
  { key: '/tenant-portal/utilities', label: 'Utilities', icon: <ThunderboltOutlined />, feature: 'utilities' },
  { key: '/tenant-portal/repairs', label: 'Repairs', icon: <ToolOutlined /> },
  { key: '/tenant-portal/profile', label: 'Profile', icon: <UserOutlined /> },
];

// Pages that must render without a session, and must never be probed. Kept in step with
// the same list in lib/tenantApi.js, which decides where a 401 sends you.
const AUTH_PAGES = [
  '/tenant-portal/login',
  '/tenant-portal/register',
  '/tenant-portal/set-password',
];

export default function TenantPortalLayoutWrapper({ children }) {
  return <Suspense fallback={<div />}><TenantPortalLayout>{children}</TenantPortalLayout></Suspense>;
}

function TenantPortalLayout({ children }) {
  const router = useRouter();
  const pathname = usePathname();
  const isAuthPage = AUTH_PAGES.some((p) => pathname.startsWith(p));

  // 'checking' | 'ok' | 'error'. There is no 'signed out' state because a rejected
  // probe is redirected by the axios interceptor rather than rendered here.
  const [state, setState] = useState('checking');
  const [tenantName, setTenantName] = useState('');
  const [features, setFeatures] = useState({});

  useEffect(() => {
    if (isAuthPage) return;
    let cancelled = false;

    // The session lives in an httpOnly cookie, so the browser cannot see whether one
    // exists. The only honest check is to ask the server.
    //
    // The old gate read Cookies.get('__s_t') and redirected when it came back empty.
    // It always came back empty: that cookie is httpOnly (and belongs to staff), so
    // js-cookie could never read it, and every portal page bounced to login forever.
    (async () => {
      try {
        const response = await tenantPortal.getProfile();
        if (cancelled) return;
        const p = response.data?.data || {};
        setTenantName([p.first_name, p.last_name].filter(Boolean).join(' ').trim());
        setFeatures(p.features || {});
        setState('ok');
      } catch (error) {
        if (cancelled) return;
        // 401 and 403 are already on their way to the login page via the interceptor;
        // rendering an error under a redirect just flashes a scary screen. Anything
        // else (portal disabled, 500, network) is a real fault and is shown as one.
        const status = error.response?.status;
        if (status !== 401 && status !== 403) setState('error');
      }
    })();

    return () => { cancelled = true; };
  }, [isAuthPage, pathname]);

  const handleLogout = useCallback(async () => {
    // Must be a server call. Clearing a cookie in JS cannot touch an httpOnly one, so
    // the old logout left the session fully alive and only looked like it worked.
    try {
      await tenantPortal.logout();
    } catch {
      // Signing out must never strand someone on a page they think they left.
    }
    router.replace('/tenant-portal/login');
  }, [router]);

  const handleMenuClick = ({ key }) => router.push(key);

  if (isAuthPage) return <>{children}</>;

  if (state === 'checking') {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f0f2f5' }}>
        <Spin size="large" />
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f0f2f5' }}>
        <Result
          status="warning"
          title="The portal is unavailable"
          subTitle="We could not load your account just now. Please try again in a moment."
          extra={<Button type="primary" onClick={() => window.location.reload()}>Try again</Button>}
        />
      </div>
    );
  }

  // Filter before selecting, so a hidden tab cannot be the highlighted one.
  const visibleNav = navItems.filter((item) => !item.feature || features[item.feature]);
  const selectedKey = visibleNav.find((item) => pathname.startsWith(item.key))?.key || '';

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
            items={visibleNav.map(({ feature, ...item }) => item)}
            style={{ background: 'transparent', borderBottom: 'none', minWidth: 400 }}
          />
        </Space>

        <Space align="center" size={12}>
          {tenantName && (
            <Text style={{ color: 'rgba(255,255,255,0.75)', whiteSpace: 'nowrap' }}>{tenantName}</Text>
          )}
          <Button icon={<LogoutOutlined />} onClick={handleLogout} type="text" style={{ color: '#fff' }}>
            Logout
          </Button>
        </Space>
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
