'use client';

import { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Card, Form, Input, Button, Select, DatePicker, InputNumber, message, Row, Col, Space } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import MainLayout from '../../../components/Layout';
import { invoice, property, tenant, settings } from '../../../lib/api';

export default function InvoiceCreatePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [properties, setProperties] = useState([]);
  const [tenants, setTenants] = useState([]);
  const [categories, setCategories] = useState([]);
  const [loadingData, setLoadingData] = useState(true);

  // URL params for pre-fill
  const paramTenantId = searchParams.get('tenantId');
  const paramTenantName = searchParams.get('tenantName');
  const paramCategory = searchParams.get('category');
  const paramPropertyId = searchParams.get('propertyId');
  const paramUnitId = searchParams.get('unitId');
  const paramLeasingId = searchParams.get('leasingId');
  const isDepositRefund = paramCategory === 'deposit-refund';

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const [propsRes, tenantsRes, catsRes] = await Promise.all([
        property.getAll(),
        tenant.getAll(),
        settings.getCategories(),
      ]);
      const propsData = propsRes.data.data || [];
      const tenantsData = tenantsRes.data.data || [];
      const catsData = catsRes.data.data || [];
      setProperties(propsData);
      setTenants(tenantsData);
      setCategories(catsData);

      // Pre-fill form after data is loaded
      const initialValues = {};

      if (paramTenantId) {
        // tenant_id might be a string/bigint — match against loaded tenants
        const matchTenant = tenantsData.find(t => String(t.id) === String(paramTenantId));
        if (matchTenant) initialValues.tenant_id = matchTenant.id;
      }
      if (paramPropertyId) {
        const matchProp = propsData.find(p => String(p.id) === String(paramPropertyId));
        if (matchProp) initialValues.property_id = matchProp.id;
      }

      if (isDepositRefund) {
        // Find deposit category
        const depositCat = catsData.find(c =>
          c.name && c.name.toLowerCase().includes('deposit')
          && !c.name.toLowerCase().includes('expense')
          && !c.name.toLowerCase().includes('don')
        );
        if (depositCat) initialValues.category = depositCat.id;
        initialValues.type = 1; // Outflow (DR)
        initialValues.due_on = dayjs(); // today
      }

      if (Object.keys(initialValues).length > 0) {
        form.setFieldsValue(initialValues);
      }
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
        tenant_id: values.tenant_id,
        property_id: values.property_id || null,
        unit_id: values.unit_id || paramUnitId || null,
        leasing_id: paramLeasingId || null,
        category: values.category || null,
        type: values.type ?? 0,
        amount: values.amount,
        due_date: values.due_on?.format('YYYY-MM-DD'),
        note: values.note || null,
        tag_id: values.tag_id || null,
      };
      const response = await invoice.create(payload);
      if (response.data.code === 200) {
        message.success(isDepositRefund ? 'Deposit refund created' : 'Invoice created successfully');
        if (paramTenantId) {
          router.push(`/contacts/tenant/${paramTenantId}/detail`);
        } else {
          router.push('/invoices');
        }
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
          onClick={() => {
            if (paramTenantId) {
              router.push(`/contacts/tenant/${paramTenantId}/detail`);
            } else {
              router.push('/invoices');
            }
          }}
          style={{ marginBottom: 16 }}
        >
          {paramTenantId ? 'Back to Tenant' : 'Back to Invoices'}
        </Button>

        <Card title={isDepositRefund ? 'Create Deposit Refund' : 'Create New Invoice'}>
          <Form
            form={form}
            layout="vertical"
            onFinish={onFinish}
          >
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item
                  name="tenant_id"
                  label="Contact"
                  rules={[{ required: true, message: 'Please select a contact' }]}
                >
                  <Select
                    placeholder="Select Contact"
                    loading={loadingData}
                    showSearch
                    optionFilterProp="children"
                    disabled={!!paramTenantId}
                  >
                    {tenants.map(t => (
                      <Select.Option key={t.id} value={t.id}>
                        {t.first_name} {t.last_name}
                      </Select.Option>
                    ))}
                  </Select>
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  name="property_id"
                  label="Property"
                >
                  <Select
                    placeholder="Select Property"
                    loading={loadingData}
                    showSearch
                    optionFilterProp="children"
                    allowClear
                  >
                    {properties.map(p => (
                      <Select.Option key={p.id} value={p.id}>{p.display_name}</Select.Option>
                    ))}
                  </Select>
                </Form.Item>
              </Col>
            </Row>

            <Row gutter={16}>
              <Col span={8}>
                <Form.Item
                  name="type"
                  label="Entry Type"
                  rules={[{ required: true, message: 'Please select entry type' }]}
                >
                  <Select disabled={isDepositRefund}>
                    <Select.Option value={0}>Inflow (CR)</Select.Option>
                    <Select.Option value={1}>Outflow (DR)</Select.Option>
                  </Select>
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item
                  name="category"
                  label="Category"
                  rules={[{ required: true, message: 'Please select category' }]}
                >
                  <Select
                    placeholder="Select Category"
                    loading={loadingData}
                    showSearch
                    optionFilterProp="children"
                    allowClear
                  >
                    {categories.map(c => (
                      <Select.Option key={c.id} value={c.id}>{c.name}</Select.Option>
                    ))}
                  </Select>
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item
                  name="due_on"
                  label="Due Date"
                  rules={[{ required: true, message: 'Please select due date' }]}
                >
                  <DatePicker style={{ width: '100%' }} />
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
                  <InputNumber style={{ width: '100%' }} placeholder="0.00" min={0} />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  name="tag_id"
                  label="Property Owner Tag"
                >
                  <Select placeholder="None" allowClear>
                    {/* Tags would be loaded here if available */}
                  </Select>
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
                  {isDepositRefund ? 'Create Deposit Refund' : 'Create Invoice'}
                </Button>
                <Button onClick={() => {
                  if (paramTenantId) {
                    router.push(`/contacts/tenant/${paramTenantId}/detail`);
                  } else {
                    router.push('/invoices');
                  }
                }}>
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
