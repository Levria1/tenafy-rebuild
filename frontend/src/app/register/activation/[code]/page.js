'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Card, Button, Spin, Input, message, Result } from 'antd';
import { CheckCircleOutlined, CloseCircleOutlined } from '@ant-design/icons';
import api from '../../../../lib/api';

export default function AccountActivationPage() {
  const params = useParams();
  const code = params.code;

  const [status, setStatus] = useState('loading'); // loading | success | error
  const [errorMsg, setErrorMsg] = useState('');
  const [email, setEmail] = useState('');
  const [resending, setResending] = useState(false);

  useEffect(() => {
    if (code) {
      activateAccount();
    }
  }, [code]);

  const activateAccount = async () => {
    try {
      const response = await api.post(`/api/auth/activate/${code}`);
      if (response.data.code === 200) {
        setStatus('success');
      } else {
        setStatus('error');
        setErrorMsg(response.data.message || 'Activation failed');
      }
    } catch (error) {
      setStatus('error');
      setErrorMsg(error.response?.data?.message || 'Activation failed. The code may be invalid or expired.');
    }
  };

  const handleResendCode = async () => {
    if (!email) {
      message.error('Please enter your email address');
      return;
    }
    setResending(true);
    try {
      const response = await api.post(`/api/auth/activate/code/resend/${encodeURIComponent(email)}`);
      if (response.data.code === 200) {
        message.success('Activation code resent! Please check your email.');
      } else {
        message.error(response.data.message || 'Failed to resend code');
      }
    } catch (error) {
      message.error(error.response?.data?.message || 'Failed to resend activation code');
    } finally {
      setResending(false);
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
      }}
    >
      <Card style={{ width: 480, boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <h1 style={{ fontSize: 24, fontWeight: 'bold', color: '#1890ff' }}>Tenafy</h1>
          <p style={{ color: '#666' }}>Account Activation</p>
        </div>

        {status === 'loading' && (
          <div style={{ textAlign: 'center', padding: '40px 0' }}>
            <Spin size="large" />
            <p style={{ marginTop: 16, color: '#666' }}>Activating your account...</p>
          </div>
        )}

        {status === 'success' && (
          <Result
            icon={<CheckCircleOutlined style={{ color: '#52c41a' }} />}
            title="Account Activated!"
            subTitle="Your account has been successfully activated. You can now log in."
            extra={
              <Button type="primary" size="large" href="/login">
                Go to Login
              </Button>
            }
          />
        )}

        {status === 'error' && (
          <Result
            icon={<CloseCircleOutlined style={{ color: '#ff4d4f' }} />}
            title="Activation Failed"
            subTitle={errorMsg}
            extra={
              <div style={{ maxWidth: 320, margin: '0 auto' }}>
                <p style={{ color: '#666', marginBottom: 12 }}>
                  Enter your email to resend the activation code:
                </p>
                <Input
                  placeholder="your@email.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  style={{ marginBottom: 12 }}
                  onPressEnter={handleResendCode}
                />
                <Button
                  type="primary"
                  loading={resending}
                  onClick={handleResendCode}
                  block
                  style={{ marginBottom: 8 }}
                >
                  Resend Activation Code
                </Button>
                <Button href="/login" block>
                  Back to Login
                </Button>
              </div>
            }
          />
        )}
      </Card>
    </div>
  );
}
