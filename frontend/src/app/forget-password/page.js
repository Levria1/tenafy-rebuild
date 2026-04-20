'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Form, Input, Button, Card, message, Steps } from 'antd';
import { MailOutlined, LockOutlined, KeyOutlined } from '@ant-design/icons';
import { auth } from '../../lib/api';

export default function ForgetPasswordPage() {
  const [current, setCurrent] = useState(0);
  const [loading, setLoading] = useState(false);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const router = useRouter();

  const onEmailSubmit = async (values) => {
    setLoading(true);
    try {
      const response = await auth.forgetPassword(values);
      if (response.data.code === 200) {
        setEmail(values.email);
        setCurrent(1);
        message.success('Verification code sent to your email');
      } else {
        message.error(response.data.message || 'Failed to send code');
      }
    } catch (error) {
      message.error(error.response?.data?.message || 'Failed to send code');
    } finally {
      setLoading(false);
    }
  };

  const onCodeSubmit = async (values) => {
    setLoading(true);
    try {
      const response = await auth.validateCode({ ...values, email });
      if (response.data.code === 200) {
        setCode(values.code);
        setCurrent(2);
        message.success('Code verified successfully');
      } else {
        message.error(response.data.message || 'Invalid code');
      }
    } catch (error) {
      message.error(error.response?.data?.message || 'Invalid code');
    } finally {
      setLoading(false);
    }
  };

  const onResetSubmit = async (values) => {
    setLoading(true);
    try {
      const response = await auth.resetPassword({
        email,
        code,
        password: values.new_password,
      });
      if (response.data.code === 200) {
        message.success('Password reset successfully');
        router.push('/login');
      } else {
        message.error(response.data.message || 'Failed to reset password');
      }
    } catch (error) {
      message.error(error.response?.data?.message || 'Failed to reset password');
    } finally {
      setLoading(false);
    }
  };

  const stepItems = [
    { title: 'Email' },
    { title: 'Verify' },
    { title: 'Reset' },
  ];

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
      <Card style={{ width: 450, boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <h1 style={{ fontSize: 24, fontWeight: 'bold', color: '#1890ff' }}>Tenafy</h1>
          <p style={{ color: '#666' }}>Reset Password</p>
        </div>
        <Steps current={current} items={stepItems} style={{ marginBottom: 24 }} />
        
        {current === 0 && (
          <Form name="email" onFinish={onEmailSubmit} size="large">
            <Form.Item
              name="email"
              rules={[
                { required: true, message: 'Please enter your email' },
                { type: 'email', message: 'Please enter a valid email' }
              ]}
            >
              <Input prefix={<MailOutlined />} placeholder="Enter your email" />
            </Form.Item>
            <Form.Item>
              <Button type="primary" htmlType="submit" loading={loading} block>
                Send Verification Code
              </Button>
            </Form.Item>
          </Form>
        )}

        {current === 1 && (
          <Form name="verify" onFinish={onCodeSubmit} size="large">
            <Form.Item
              name="code"
              rules={[{ required: true, message: 'Please enter the verification code' }]}
            >
              <Input prefix={<KeyOutlined />} placeholder="Enter verification code" />
            </Form.Item>
            <Form.Item>
              <Button type="primary" htmlType="submit" loading={loading} block>
                Verify Code
              </Button>
            </Form.Item>
          </Form>
        )}

        {current === 2 && (
          <Form name="reset" onFinish={onResetSubmit} size="large">
            <Form.Item
              name="new_password"
              rules={[
                { required: true, message: 'Please enter new password' },
                { min: 6, message: 'Password must be at least 6 characters' }
              ]}
            >
              <Input.Password prefix={<LockOutlined />} placeholder="New Password" />
            </Form.Item>
            <Form.Item
              name="confirm_password"
              dependencies={['new_password']}
              rules={[
                { required: true, message: 'Please confirm your password' },
                ({ getFieldValue }) => ({
                  validator(_, value) {
                    if (!value || getFieldValue('new_password') === value) {
                      return Promise.resolve();
                    }
                    return Promise.reject(new Error('Passwords do not match'));
                  },
                }),
              ]}
            >
              <Input.Password prefix={<LockOutlined />} placeholder="Confirm New Password" />
            </Form.Item>
            <Form.Item>
              <Button type="primary" htmlType="submit" loading={loading} block>
                Reset Password
              </Button>
            </Form.Item>
          </Form>
        )}

        <div style={{ textAlign: 'center', marginTop: 16 }}>
          <a href="/login">Back to Login</a>
        </div>
      </Card>
    </div>
  );
}
