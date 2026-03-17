'use client';

import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { Layout, Button, Spin } from 'antd';
import { LogoutOutlined } from '@ant-design/icons';
import Cookies from 'js-cookie';
import { master } from '../../lib/api';

const { Header, Content } = Layout;

export default function MasterLayout({ children }) {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  // Skip auth check on login page
  const isLoginPage = pathname === '/master/login';

  useEffect(() => {
    if (isLoginPage) {
      setLoading(false);
      return;
    }
    const token = Cookies.get('__s_t');
    if (!token) {
      router.push('/master/login');
      return;
    }
    master.getProfile()
      .then(res => {
        if (res.data.data?.isMasterAdmin) {
          setUser(res.data.data);
        } else {
          Cookies.remove('__s_t');
          router.push('/master/login');
        }
      })
      .catch(() => {
        Cookies.remove('__s_t');
        router.push('/master/login');
      })
      .finally(() => setLoading(false));
  }, [isLoginPage, router]);

  if (isLoginPage) return children;

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Spin size="large" />
      </div>
    );
  }

  const handleLogout = () => {
    Cookies.remove('__s_t');
    router.push('/master/login');
  };

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#141414', padding: '0 24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <span style={{ color: '#1890ff', fontSize: 20, fontWeight: 'bold' }}>Tenafy</span>
          <span style={{ color: 'rgba(255,255,255,0.65)', fontSize: 14 }}>Master Admin</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          {user && <span style={{ color: 'rgba(255,255,255,0.85)' }}>{user.username}</span>}
          <Button type="text" icon={<LogoutOutlined />} onClick={handleLogout} style={{ color: 'rgba(255,255,255,0.65)' }} />
        </div>
      </Header>
      <Content style={{ padding: 24, background: '#f0f2f5' }}>
        {children}
      </Content>
    </Layout>
  );
}
