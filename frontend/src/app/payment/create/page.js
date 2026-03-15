'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Card, Form, Input, InputNumber, Select, DatePicker, Radio, Button, Space, message, Row, Col } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import MainLayout from '../../../components/Layout';
import { accounting, property, tenant, settings } from '../../../lib/api';

const { TextArea } = Input;

export default function PaymentCreatePageWrapper() {
  return <Suspense fallback={<div />}><PaymentCreatePage /></Suspense>;
}

function PaymentCreatePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);

  const [properties, setProperties] = useState([]);
  const [units, setUnits] = useState([]);
  const [unitsLoading, setUnitsLoading] = useState(false);
  const [tenants, setTenants] = useState([]);
  const [bankAccounts, setBankAccounts] = useState([]);
  const [paymentMethods, setPaymentMethods] = useState([]);
  const [categories, setCategories] = useState([]);

  useEffect(() => {
    loadInitialData();
  }, []);

  useEffect(() => {
    const invoiceId = searchParams.get('invoiceId');
    if (invoiceId) {
      form.setFieldValue('invoice_code', invoiceId);
    }
  }, [searchParams]);

  const loadInitialData = async () => {
    try {
      const [propRes, tenantRes, accountRes, paymentRes, categoryRes] = await Promise.all([
        property.getAll(),
        tenant.getAll(),
        settings.getAccountSettings(),
        settings.getPaymentMethods(),
        settings.getCategories(),
      ]);
      if (propRes.data.code === 200) setProperties(propRes.data.data || []);
      if (tenantRes.data.code === 200) setTenants(tenantRes.data.data || []);
      if (accountRes.data.code === 200) setBankAccounts(accountRes.data.data || []);
      if (paymentRes.data.code === 200) setPaymentMethods(paymentRes.data.data || []);
      if (categoryRes.data.code === 200) setCategories(categoryRes.data.data || []);
    } catch (error) {
      message.error('Failed to load form data');
    }
  };

  const handlePropertyChange = async (propertyId) => {
    form.setFieldValue('unit_id', undefined);
    setUnits([]);
    if (!propertyId) return;

    setUnitsLoading(true);
    try {
      const response = await property.getUnits(propertyId);
      if (response.data.code === 200) {
        setUnits(response.data.data || []);
      }
    } catch (error) {
      message.error('Failed to load units');
    } finally {
      setUnitsLoading(false);
    }
  };

  const onFinish = async (values) => {
    setSubmitting(true);
    try {
      const payload = {
        invoice_code: values.invoice_code || null,
        property_id: values.property_id || null,
        unit_id: values.unit_id || null,
        tenant_id: values.tenant_id || null,
        account_setting_id: values.account_setting_id || null,
        payment_setting_id: values.payment_setting_id || null,
        category: values.category || null,
        amount: values.amount,
        type: values.type,
        payment_date: values.payment_date ? values.payment_date.format('YYYY-MM-DD') : null,
        note: values.note || null,
      };

      await accounting.create(payload);
      message.success('Payment recorded successfully');
      router.push('/payment');
    } catch (error) {
      message.error(error.response?.data?.message || 'Failed to record payment');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <MainLayout>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => router.push('/payment')}>
          Back
        </Button>
        <Card title="Record Payment">
          <Form
            form={form}
            layout="vertical"
            onFinish={onFinish}
            style={{ maxWidth: 800 }}
            initialValues={{ type: 0 }}
          >
            <Form.Item name="invoice_code" label="Invoice Code">
              <Input placeholder="Enter or search invoice code" />
            </Form.Item>

            <Row gutter={16}>
              <Col span={12}>
                <Form.Item name="property_id" label="Property">
                  <Select
                    placeholder="Select Property"
                    allowClear
                    showSearch
                    optionFilterProp="label"
                    onChange={handlePropertyChange}
                    options={properties.map((p) => ({
                      label: p.display_name || p.name,
                      value: p.id,
                    }))}
                  />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item name="unit_id" label="Unit">
                  <Select
                    placeholder="Select Unit"
                    allowClear
                    showSearch
                    optionFilterProp="label"
                    loading={unitsLoading}
                    options={units.map((u) => ({
                      label: u.unit_number || u.name,
                      value: u.id,
                    }))}
                  />
                </Form.Item>
              </Col>
            </Row>

            <Form.Item name="tenant_id" label="Tenant">
              <Select
                placeholder="Select Tenant"
                allowClear
                showSearch
                optionFilterProp="label"
                options={tenants.map((t) => ({
                  label: t.first_name && t.last_name
                    ? `${t.first_name} ${t.last_name}`
                    : t.name || t.email,
                  value: t.id,
                }))}
              />
            </Form.Item>

            <Row gutter={16}>
              <Col span={12}>
                <Form.Item name="account_setting_id" label="Bank Account">
                  <Select
                    placeholder="Select Bank Account"
                    allowClear
                    options={bankAccounts.map((a) => ({
                      label: a.name || a.account_name,
                      value: a.id,
                    }))}
                  />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item name="payment_setting_id" label="Payment Method">
                  <Select
                    placeholder="Select Payment Method"
                    allowClear
                    options={paymentMethods.map((p) => ({
                      label: p.name,
                      value: p.id,
                    }))}
                  />
                </Form.Item>
              </Col>
            </Row>

            <Form.Item name="category" label="Category">
              <Select
                placeholder="Select Category"
                allowClear
                showSearch
                optionFilterProp="label"
                options={categories.map((c) => ({
                  label: c.name,
                  value: c.id,
                }))}
              />
            </Form.Item>

            <Row gutter={16}>
              <Col span={8}>
                <Form.Item name="amount" label="Amount" rules={[{ required: true, message: 'Please enter amount' }]}>
                  <InputNumber
                    min={0}
                    step={0.01}
                    style={{ width: '100%' }}
                    formatter={(value) => `$ ${value}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}
                    parser={(value) => value.replace(/\$\s?|(,*)/g, '')}
                    placeholder="0.00"
                  />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item name="type" label="Type" rules={[{ required: true, message: 'Please select type' }]}>
                  <Radio.Group>
                    <Radio value={0}>Inflow</Radio>
                    <Radio value={1}>Outflow</Radio>
                  </Radio.Group>
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item name="payment_date" label="Payment Date" rules={[{ required: true, message: 'Please select date' }]}>
                  <DatePicker style={{ width: '100%' }} />
                </Form.Item>
              </Col>
            </Row>

            <Form.Item name="note" label="Note">
              <TextArea rows={3} placeholder="Optional notes about this payment..." />
            </Form.Item>

            <Form.Item>
              <Space>
                <Button onClick={() => router.push('/payment')}>Cancel</Button>
                <Button type="primary" htmlType="submit" loading={submitting}>
                  Record Payment
                </Button>
              </Space>
            </Form.Item>
          </Form>
        </Card>
      </Space>
    </MainLayout>
  );
}
