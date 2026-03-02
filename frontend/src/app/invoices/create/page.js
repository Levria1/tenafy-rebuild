'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Card, Form, Input, Button, Select, DatePicker, InputNumber, message, Row, Col, Space } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import MainLayout from '../../../components/Layout';
import { invoice, property, tenant } from '../../../lib/api';

export default function InvoiceCreatePage() {
  const router = useRouter();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [properties, setProperties] = useState([]);
  const [tenants, setTenants] = useState([]);
  const [loadingData, setLoadingData] = useState(true);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const [propsRes, tenantsRes] = await Promise.all([
        property.getAll(),
        tenant.getAll()
      ]);
      setProperties(propsRes.data.data || []);
      setTenants(tenantsRes.data.data || []);
    } catch (error) {
      message.error('Failed to load data');
    } finally {
      setLoadingData(false);
    }
  };

  const onFinish = async (values) => {
    try {
      setLoading(true);
      const payload = {
        ...values,
        due_on: values.due_on?.format('YYYY-MM-DD')
      };
      const response = await invoice.create(payload);
      if (response.data.code === 200) {
        message.success('Invoice created successfully');
        router.push('/invoices');
      } else {
        message.error(response.data.message || 'Failed to create invoice');
      }
    } catch (error) {
      message.error(error.response?.data?.message || 'Failed to create invoice');
    } finally {
      setLoading(false);
    }
  };

  return (
    <MainLayout>
      <div style={{ maxWidth: 900, margin: '0 auto' }}>
        <Button 
          icon={<ArrowLeftOutlined />} 
          onClick={() => router.push('/invoices')}
          style={{ marginBottom: 16 }}
        >
          Back to Invoices
        </Button>
        
        <Card title="Create New Invoice">
          <Form
            form={form}
            layout="vertical"
            onFinish={onFinish}
          >
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item
                  name="tenant_id"
                  label="Tenant"
                  rules={[{ required: true, message: 'Please select tenant' }]}
                >
                  <Select placeholder="Select Tenant" loading={loadingData}>
                    {tenants.map(t => (
                      <Select.Option key={t.id} value={t.id}>{t.first_name} {t.last_name}</Select.Option>
                    ))}
                  </Select>
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  name="property_id"
                  label="Property"
                  rules={[{ required: true, message: 'Please select property' }]}
                >
                  <Select placeholder="Select Property" loading={loadingData}>
                    {properties.map(p => (
                      <Select.Option key={p.id} value={p.id}>{p.display_name}</Select.Option>
                    ))}
                  </Select>
                </Form.Item>
              </Col>
            </Row>

            <Row gutter={16}>
              <Col span={12}>
                <Form.Item
                  name="category"
                  label="Category"
                >
                  <Select>
                    <Select.Option value={0}>Rent</Select.Option>
                    <Select.Option value={1}>Deposit</Select.Option>
                    <Select.Option value={2}>Late Fee</Select.Option>
                    <Select.Option value={3}>Utility</Select.Option>
                    <Select.Option value={4}>Maintenance</Select.Option>
                    <Select.Option value={5}>Other</Select.Option>
                  </Select>
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  name="type"
                  label="Type"
                >
                  <Select>
                    <Select.Option value={0}>Recurring</Select.Option>
                    <Select.Option value={1}>One-time</Select.Option>
                  </Select>
                </Form.Item>
              </Col>
            </Row>

            <Row gutter={16}>
              <Col span={12}>
                <Form.Item
                  name="amount"
                  label="Amount"
                  rules={[{ required: true, message: 'Please enter amount' }]}
                >
                  <InputNumber style={{ width: '100%' }} placeholder="0.00" prefix="$" />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  name="due_on"
                  label="Due Date"
                  rules={[{ required: true, message: 'Please select due date' }]}
                >
                  <DatePicker style={{ width: '100%' }} />
                </Form.Item>
              </Col>
            </Row>

            <Form.Item
              name="note"
              label="Notes"
            >
              <Input.TextArea rows={3} placeholder="Additional notes..." />
            </Form.Item>

            <Form.Item>
              <Space>
                <Button type="primary" htmlType="submit" loading={loading}>
                  Create Invoice
                </Button>
                <Button onClick={() => router.push('/invoices')}>
                  Cancel
                </Button>
              </Space>
            </Form.Item>
          </Form>
        </Card>
      </div>
    </MainLayout>
  );
}
