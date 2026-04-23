'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Form, Input, Button, Card, message, Modal } from 'antd';
import { UserOutlined, LockOutlined } from '@ant-design/icons';
import Cookies from 'js-cookie';
import { auth } from '../../lib/api';

export default function LoginPage() {
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const onFinish = async (values) => {
    setLoading(true);
    try {
      const response = await auth.login(values);
      if (response.data.code === 200) {
        Cookies.set('__s_t', response.data.data.token, { expires: 1 });
        message.success('Login successful');
        router.push('/dashboard');
      } else {
        Modal.error({
          title: 'Login failed',
          content: response.data.message || 'Login failed',
          okText: 'OK',
        });
      }
    } catch (error) {
      Modal.error({
        title: 'Login failed',
        content: error.response?.data?.message || 'Login failed',
        okText: 'OK',
      });
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
      }}
    >
      <Card style={{ width: 400, boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <h1 style={{ fontSize: 24, fontWeight: 'bold', color: '#1890ff' }}>Tenafy</h1>
          <p style={{ color: '#666' }}>Property Management System</p>
        </div>
        <Form
          name="login"
          onFinish={onFinish}
          autoComplete="off"
          size="large"
        >
          <Form.Item
            name="username"
            rules={[{ required: true, message: 'Please enter your username' }]}
          >
            <Input
              prefix={<UserOutlined />}
              placeholder="Username"
            />
          </Form.Item>
          <Form.Item
            name="password"
            rules={[{ required: true, message: 'Please enter your password' }]}
          >
            <Input.Password
              prefix={<LockOutlined />}
              placeholder="Password"
            />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={loading} block>
              Log in
            </Button>
          </Form.Item>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <a href="/register">Register</a>
            <a href="/forget-password">Forgot Password?</a>
          </div>
        </Form>
      </Card>
    </div>
  );
}