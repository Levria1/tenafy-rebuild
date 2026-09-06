'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Form, Input, Button, Card, Alert, Typography } from 'antd';
import { MailOutlined } from '@ant-design/icons';
import { tenantPortal } from '../../../lib/tenantApi';

const { Text } = Typography;

export default function TenantRegisterPage() {
  const [loading, setLoading] = useState(false);
  // The acknowledgement, once shown, replaces the form. Leaving the form up invites a
  // second submit, and the second submit invalidates the link the first one just mailed.
  const [sent, setSent] = useState('');
  const [failed, setFailed] = useState('');

  const onFinish = async (values) => {
    setLoading(true);
    setFailed('');
    try {
      const response = await tenantPortal.register(values);
      // The server answers identically for a real tenant, a stranger, and its own
      // internal failure, on purpose: anything else turns this box into a way to test
      // whether an address is one of our tenants. So the message is shown as-is and
      // this page must not add a cheerful "check your inbox" on top of it.
      setSent(response.data?.message || 'If that email belongs to a tenant of ours, we have sent it a link to set a password.');
    } catch (error) {
      // Only transport-level failures reach here: 429 from the rate limiter, or the
      // portal being switched off. Both are worth saying plainly.
      setFailed(error.response?.data?.message || 'We could not process that just now. Please try again shortly.');
    } finally {
      setLoading(false);
    }
  };

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
      <Card style={{ width: 420, boxShadow: '0 4px 16px rgba(0,0,0,0.12)', borderRadius: 8 }}>
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: '50%',
              background: '#1890ff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto 16px',
            }}
          >
            <span style={{ color: '#fff', fontSize: 24, fontWeight: 'bold' }}>T</span>
          </div>
          <h1 style={{ fontSize: 22, fontWeight: 'bold', color: '#262626', marginBottom: 4 }}>
            Set up your account
          </h1>
          <p style={{ color: '#8c8c8c', margin: 0 }}>
            Enter the email address we hold for you and we will send a link to choose a password.
          </p>
        </div>

        {sent ? (
          <>
            <Alert type="success" showIcon message="Check your email" description={sent} style={{ marginBottom: 20 }} />
            <Text type="secondary" style={{ fontSize: 13, display: 'block', marginBottom: 20 }}>
              The link lasts one hour. If it does not arrive, check your spam folder, or ask us to
              confirm which address is on your tenancy.
            </Text>
            <Link href="/tenant-portal/login">
              <Button block>Back to sign in</Button>
            </Link>
          </>
        ) : (
          <>
            {failed && <Alert type="error" showIcon message={failed} style={{ marginBottom: 16 }} />}
            <Form name="tenant-register" onFinish={onFinish} autoComplete="off" size="large">
              <Form.Item
                name="email"
                rules={[
                  { required: true, message: 'Please enter your email' },
                  { type: 'email', message: 'Please enter a valid email address' },
                ]}
              >
                <Input prefix={<MailOutlined style={{ color: '#bfbfbf' }} />} placeholder="Email address" />
              </Form.Item>

              <Form.Item style={{ marginBottom: 12 }}>
                <Button type="primary" htmlType="submit" loading={loading} block>
                  Send me a link
                </Button>
              </Form.Item>
            </Form>

            <div style={{ textAlign: 'center' }}>
              <Link href="/tenant-portal/login" style={{ fontSize: 13 }}>
                Already have a password? Sign in
              </Link>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
