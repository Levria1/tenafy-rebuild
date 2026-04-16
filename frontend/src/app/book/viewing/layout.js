'use client';

import { Layout } from 'antd';

// Bare public chrome for the /book/viewing/* pages. No sidebar, no auth shell.
// AuthProvider in src/components/Layout.jsx already skips /book/* so no login
// redirect will fire.

export default function ViewingBookingLayout({ children }) {
  return (
    <Layout style={{ minHeight: '100vh', background: '#f5f7fa' }}>
      <Layout.Header
        style={{
          background: '#001529',
          display: 'flex',
          alignItems: 'center',
          padding: '0 24px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div
            style={{
              width: 32, height: 32, borderRadius: '50%', background: '#1890ff',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <span style={{ color: '#fff', fontSize: 14, fontWeight: 'bold' }}>T</span>
          </div>
          <span style={{ color: '#fff', fontWeight: 'bold', fontSize: 16 }}>
            Book a Viewing
          </span>
        </div>
      </Layout.Header>
      <Layout.Content style={{ padding: '24px 16px' }}>
        <div style={{ maxWidth: 640, margin: '0 auto' }}>{children}</div>
      </Layout.Content>
      <Layout.Footer style={{ textAlign: 'center', color: '#8c8c8c', background: 'transparent' }}>
        Powered by Tenafy &middot; {new Date().getFullYear()}
      </Layout.Footer>
    </Layout>
  );
}
