'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Form, Input, Button, Card, Alert, Typography, Result } from 'antd';
import { LockOutlined } from '@ant-design/icons';
import { tenantPortal } from '../../../lib/tenantApi';

const { Text } = Typography;

// Mirrors MIN_PASSWORD_LENGTH in backend/src/utils/tenantPortalRegistration.js. The
// server is the authority; this only saves a round trip. Deliberately the ONLY rule
// shown: the backend has no composition requirements, and inventing some here would
// push people toward "Summer2026!" while telling them a lie about what is accepted.
const MIN_PASSWORD_LENGTH = 10;

export default function SetPasswordPageWrapper() {
  // useSearchParams needs its own boundary or the whole route opts out of prerendering.
  return (
    <Suspense fallback={<Shell><div style={{ height: 180 }} /></Shell>}>
      <SetPasswordPage />
    </Suspense>
  );
}

function Shell({ children }) {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#f0f2f5',
        padding: 16,
      }}
    >
      <Card style={{ width: 440, boxShadow: '0 4px 16px rgba(0,0,0,0.12)', borderRadius: 8 }}>
        {children}
      </Card>
    </div>
  );
}

function SetPasswordPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token') || '';

  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState('');
  const [done, setDone] = useState(false);

  const onFinish = async (values) => {
    setLoading(true);
    setFailed('');
    try {
      const response = await tenantPortal.completeRegistration({ token, password: values.password });
      if (response.data?.code === 200) {
        setDone(true);
      } else {
        setFailed(response.data?.message || 'Could not set your password.');
      }
    } catch (error) {
      // 400 covers both a malformed link and an expired one, by design: distinguishing
      // them would tell someone holding a stale token which half was wrong.
      setFailed(error.response?.data?.message || 'Could not set your password. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  if (done) {
    return (
      <Shell>
        <Result
          status="success"
          title="Password set"
          subTitle="You can now sign in to the tenant portal."
          extra={
            <Button type="primary" onClick={() => router.replace('/tenant-portal/login')}>
              Go to sign in
            </Button>
          }
        />
      </Shell>
    );
  }

  // No token at all means the address bar was typed by hand or the link was truncated by
  // an email client. Say so here rather than letting them fill in a form that cannot work.
  if (!token) {
    return (
      <Shell>
        <Result
          status="warning"
          title="This link is incomplete"
          subTitle="Open the link from your email exactly as it was sent, or ask for a new one."
          extra={
            <Link href="/tenant-portal/register">
              <Button type="primary">Request a new link</Button>
            </Link>
          }
        />
      </Shell>
    );
  }

  return (
    <Shell>
      <div style={{ textAlign: 'center', marginBottom: 28 }}>
        <h1 style={{ fontSize: 22, fontWeight: 'bold', color: '#262626', marginBottom: 4 }}>
          Choose a password
        </h1>
        <p style={{ color: '#8c8c8c', margin: 0 }}>
          This will be the password for your tenant portal.
        </p>
      </div>

      {failed && (
        <Alert
          type="error"
          showIcon
          message={failed}
          action={
            <Link href="/tenant-portal/register">
              <Button size="small" type="link">Request a new link</Button>
            </Link>
          }
          style={{ marginBottom: 16 }}
        />
      )}

      <Form name="set-password" onFinish={onFinish} autoComplete="off" size="large" layout="vertical">
        <Form.Item
          name="password"
          label="New password"
          rules={[
            { required: true, message: 'Please choose a password' },
            { min: MIN_PASSWORD_LENGTH, message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` },
            { max: 200, message: 'Password must be 200 characters or fewer.' },
          ]}
          extra={`At least ${MIN_PASSWORD_LENGTH} characters. A few words you will remember beats one short complicated word.`}
        >
          <Input.Password prefix={<LockOutlined style={{ color: '#bfbfbf' }} />} placeholder="New password" />
        </Form.Item>

        <Form.Item
          name="confirm"
          label="Confirm password"
          dependencies={['password']}
          rules={[
            { required: true, message: 'Please retype your password' },
            // Confirmation is checked here only. The server never sees it: it is a typo
            // guard for the person typing, not a rule about the password itself.
            ({ getFieldValue }) => ({
              validator: (_, value) =>
                !value || getFieldValue('password') === value
                  ? Promise.resolve()
                  : Promise.reject(new Error('The two passwords do not match.')),
            }),
          ]}
        >
          <Input.Password prefix={<LockOutlined style={{ color: '#bfbfbf' }} />} placeholder="Retype password" />
        </Form.Item>

        <Form.Item style={{ marginBottom: 12 }}>
          <Button type="primary" htmlType="submit" loading={loading} block>
            Set password
          </Button>
        </Form.Item>
      </Form>

      <Text type="secondary" style={{ fontSize: 12, display: 'block', textAlign: 'center' }}>
        Setting a password signs out any other device already using this account.
      </Text>
    </Shell>
  );
}
