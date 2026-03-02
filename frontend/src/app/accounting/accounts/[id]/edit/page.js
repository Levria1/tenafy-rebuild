'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Card, Form, Input, InputNumber, Select, DatePicker, Button, message, Row, Col } from 'antd';
import MainLayout from '../../../../../components/Layout';
import { accounting, property, tenant } from '../../../../../lib/api';

export default function AccountEditPage() {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [properties, setProperties] = useState([]);
  const [tenants, setTenants] = useState([]);
  const router = useRouter();
  const params = useParams();
  const accountId = params.id;

  useEffect(() => {
    loadData();
    loadAccount();
  }, [accountId]);

  const loadData = async () => {
    try {
      const [propRes, tenantRes] = await Promise.all([
        property.getAll(),
        tenant.getAll()
      ]);
      if (propRes.data.code === 200) setProperties(propRes.data.data || []);
      if (tenantRes.data.code === 200) setTenants(tenantRes.data.data || []);
    } catch (error) {
      console.error('Failed to load data');
    }
  };

  const loadAccount = async () => {
    try {
      const response = await accounting.get(accountId);
      if (response.data.code === 200) {
        const data = response.data.data;
        form.setFieldsValue({
          ...data,
          transaction_date: data.transaction_date ? { _d: new Date(data.transaction_date) } : null,
        });
      }
    } catch (error) {
      message.error('Failed to load account');
    } finally {
      setInitialLoading(false);
    }
  };

  const onFinish = async (values) => {
    try {
      setLoading(true);
      await accounting.update(accountId, {
        ...values,
        transaction_date: values.transaction_date?.format('YYYY-MM-DD'),
      });
      message.success('Transaction updated successfully');
      router.push(`/accounting/accounts/${accountId}/detail`);
    } catch (error) {
      message.error('Failed to update transaction');
    } finally {
      setLoading(false);
    }
  };

  return (
    <MainLayout>
      <Card title="Edit Transaction" loading={initialLoading}>
        <Form form={form} layout="vertical" onFinish={onFinish}>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="transaction_date" label="Date" rules={[{ required: true }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="type" label="Type" rules={[{ required: true }]}>
                <Select options={[
                  { label: 'Income', value: 'income' },
                  { label: 'Expense', value: 'expense' },
                ]} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="property_id" label="Property">
                <Select 
                  placeholder="Select Property"
                  allowClear
                  options={properties.map(p => ({ label: p.display_name, value: p.id }))}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="tenant_id" label="Tenant">
                <Select 
                  placeholder="Select Tenant"
                  allowClear
                  options={tenants.map(t => ({ label: `${t.first_name} ${t.last_name}`, value: t.id }))}
                />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="amount" label="Amount" rules={[{ required: true }]}>
            <InputNumber min={0} style={{ width: '100%' }} formatter={value => `$ ${value}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',')} />
          </Form.Item>
          <Form.Item name="description" label="Description" rules={[{ required: true }]}>
            <Input.TextArea rows={3} />
          </Form.Item>
          <Form.Item name="category" label="Category">
            <Input />
          </Form.Item>
          <Form.Item name="status" label="Status">
            <Select options={[
              { label: 'Pending', value: 'PENDING' },
              { label: 'Completed', value: 'COMPLETED' },
              { label: 'Cancelled', value: 'CANCELLED' },
            ]} />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={loading}>Update Transaction</Button>
          </Form.Item>
        </Form>
      </Card>
    </MainLayout>
  );
}
