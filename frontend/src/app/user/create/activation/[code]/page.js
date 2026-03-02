'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Card, Form, Input, Button, Spin, message, Result } from 'antd';
import { LockOutlined, CloseCircleOutlined } from '@ant-design/icons';
import api from '../../../../../lib/api';

export default function SubUserActivationPage() {
  const params = useParams();
  const router = useRouter();
  const code = params.code;
  const [form] = Form.useForm();

  const [status, setStatus] = useState('loading'); // loading | form | error
  const [errorMsg, setErrorMsg] = useState('');
  const [userInfo, setUserInfo] = useState({ username: '', email: '' });
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (code) {
      validateCode();
    }
  }, [code]);

  const validateCode = async () => {
    try {
      const response = await api.post(`/api/auth/user/validate/${code}`);
      if (response.data.code === 200) {
        const data = response.data.data;
        setUserInfo({ username: data.username || '', email: data.email || '' });
        setStatus('form');
      } else {
        setStatus('error');
        setErrorMsg(response.data.message || 'Invalid activation code');
      }
    } catch (error) {
      setStatus('error');
      setErrorMsg(error.response?.data?.message || 'Invalid or expired activation code.');
    }
  };

  const onFinish = async (values) => {
    setSubmitting(true);
    try {
      const response = await api.post('/api/auth/user/activate', {
        code,
        password: values.password,
      });
      if (response.data.code === 200) {
        message.success('Account activated successfully! You can now log in.');
        router.push('/login');
      } else {
        message.error(response.data.message || 'Activation failed');
      }
    } catch (error) {
      message.error(error.response?.data?.message || 'Failed to activate account');
    } finally {
      setSubmitting(false);
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
      <Card style={{ width: 460, boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <h1 style={{ fontSize: 24, fontWeight: 'bold', color: '#1890ff' }}>Tenafy</h1>
          <p style={{ color: '#666' }}>Set Up Your Account</p>
        </div>

        {status === 'loading' && (
          <div style={{ textAlign: 'center', padding: '40px 0' }}>
            <Spin size="large" />
            <p style={{ marginTop: 16, color: '#666' }}>Validating your invitation...</p>
          </div>
        )}

        {status === 'error' && (
          <Result
            icon={<CloseCircleOutlined style={{ color: '#ff4d4f' }} />}
            title="Invalid Invitation"
            subTitle={errorMsg}
            extra={
              <Button type="primary" href="/login">
                Back to Login
              </Button>
            }
          />
        )}

        {status === 'form' && (
          <Form form={form} layout="vertical" onFinish={onFinish} size="large">
            <Form.Item label="Username">
              <Input value={userInfo.username} disabled />
            </Form.Item>
            <Form.Item label="Email">
              <Input value={userInfo.email} disabled />
            </Form.Item>
            <Form.Item
              name="password"
              label="Password"
              rules={[
                { required: true, message: 'Please enter a password' },
                { min: 6, message: 'Password must be at least 6 characters' },
              ]}
            >
              <Input.Password prefix={<LockOutlined />} placeholder="Enter your password" />
            </Form.Item>
            <Form.Item
              name="confirmPassword"
              label="Confirm Password"
              dependencies={['password']}
              rules={[
                { required: true, message: 'Please confirm your password' },
                ({ getFieldValue }) => ({
                  validator(_, value) {
                    if (!value || getFieldValue('password') === value) {
                      return Promise.resolve();
                    }
                    return Promise.reject(new Error('Passwords do not match'));
                  },
                }),
              ]}
            >
              <Input.Password prefix={<LockOutlined />} placeholder="Confirm your password" />
            </Form.Item>
            <Form.Item>
              <Button type="primary" htmlType="submit" loading={submitting} block>
                Activate Account
              </Button>
            </Form.Item>
          </Form>
        )}
      </Card>
    </div>
  );
}
