'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Form, Input, InputNumber, Select, DatePicker, Button, message, Row, Col, Divider, Upload, Spin } from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import MainLayout from '../../../../../components/Layout';
import { invoice as invoiceApi, accounting, accountingApi, tenant as tenantApi } from '../../../../../lib/api';

const currencySymbolMap = { HKD: 'HK$', USD: '$', EUR: '€', GBP: '£', JPY: '¥', CNY: '¥', CAD: 'C$', AUD: 'A$', SGD: 'S$', TWD: 'NT$' };
const getCurSymbol = (code) => currencySymbolMap[code] || code || 'HK$';

const getDisplayName = (t) => {
  if (!t) return '-';
  if (Number(t.type) === 1 && t.company_name) return t.company_name;
  return [t.first_name, t.middle_name, t.last_name].filter(Boolean).join(' ') || '-';
};

export default function CreatePaymentPageWrapper() {
  return <Suspense fallback={<div />}><CreatePaymentPage /></Suspense>;
}

function CreatePaymentPage() {
  const [form] = Form.useForm();
  const router = useRouter();
  const searchParams = useSearchParams();
  const invoiceId = searchParams.get('invoiceId');

  const [loading, setLoading] = useState(false);
  const [pageLoading, setPageLoading] = useState(!!invoiceId);
  const [invoiceData, setInvoiceData] = useState(null);
  const [tenants, setTenants] = useState([]);
  const [bankAccounts, setBankAccounts] = useState([]);
  const [paymentMethods, setPaymentMethods] = useState([]);
  const [categories, setCategories] = useState([]);
  const [outstanding, setOutstanding] = useState(0);
  const [currencySymbol, setCurrencySymbol] = useState('HK$');

  useEffect(() => {
    loadOptions();
    if (invoiceId) loadInvoice();
  }, []);

  const loadOptions = async () => {
    try {
      const [acctRes, pmRes, tenantRes, catRes] = await Promise.all([
        accountingApi.getAccounts(),
        accountingApi.getPaymentMethods(),
        tenantApi.getAll(),
        accountingApi.getCategories(),
      ]);
      if (acctRes.data.code === 200) setBankAccounts(acctRes.data.data || []);
      if (pmRes.data.code === 200) setPaymentMethods(pmRes.data.data || []);
      if (tenantRes.data.code === 200) setTenants(tenantRes.data.data || []);
      if (catRes.data.code === 200) setCategories(catRes.data.data || []);
    } catch (e) {
      console.error('Failed to load options:', e);
    }
  };

  const loadInvoice = async () => {
    try {
      const res = await invoiceApi.get(invoiceId);
      if (res.data.code === 200) {
        const inv = res.data.data;
        setInvoiceData(inv);

        // Use backend-calculated outstanding directly
        setOutstanding(Number(inv.outstanding) || 0);

        // Set currency symbol
        const sym = getCurSymbol(inv.property_currency);
        setCurrencySymbol(sym);

        // Pre-fill form
        form.setFieldsValue({
          type: inv.type != null ? Number(inv.type) : 0,
          tenant_id: inv.tenant_id ? String(inv.tenant_id) : undefined,
          dueOn: inv.due_on ? dayjs(inv.due_on) : undefined,
          payment_date: dayjs(),
          category: inv.category ? String(inv.category) : undefined,
        });
      }
    } catch (e) {
      message.error('Failed to load invoice');
    } finally {
      setPageLoading(false);
    }
  };

  const onFinish = async (values) => {
    try {
      setLoading(true);

      const payload = {
        type: invoiceData ? Number(invoiceData.type) : values.type,
        account_setting_id: values.account_setting_id,
        payment_setting_id: values.payment_setting_id || null,
        tenant_id: invoiceData ? invoiceData.tenant_id : (values.tenant_id || null),
        payment_date: values.payment_date?.format('YYYY-MM-DD') || null,
        amount: values.amount,
        category: invoiceData?.category || values.category || null,
        invoice_code: invoiceData?.invoice_code || null,
        property_id: invoiceData?.property_id || null,
        unit_id: invoiceData?.unit_id || null,
        lease_id: invoiceData?.leasing_id || null,
        due_date: invoiceData?.due_on ? dayjs(invoiceData.due_on).format('YYYY-MM-DD') : null,
        note: values.note || null,
        lines: [{
          amount: values.amount || 0,
          category: invoiceData?.category || values.category || null,
          invoice_code: invoiceData?.invoice_code || null,
          property_id: invoiceData?.property_id || null,
          unit_id: invoiceData?.unit_id || null,
          lease_id: invoiceData?.leasing_id || null,
        }],
      };

      const res = await accounting.create(payload);
      if (res.data.code === 200) {
        message.success('Payment created successfully');
        router.back();
      } else {
        message.error(res.data.message || 'Failed to create payment');
      }
    } catch (error) {
      message.error(error.response?.data?.message || 'Failed to create payment');
    } finally {
      setLoading(false);
    }
  };

  const labelStyle = { fontWeight: 600, fontSize: 11, textTransform: 'uppercase' };
  const requiredLabel = (text) => <span style={labelStyle}><span style={{ color: 'red' }}>* </span>{text}</span>;
  const optionalLabel = (text) => <span style={labelStyle}>{text}</span>;

  if (pageLoading) {
    return (
      <MainLayout>
        <div style={{ padding: 48, textAlign: 'center' }}><Spin size="large" /></div>
      </MainLayout>
    );
  }

  return (
    <MainLayout>
      <h1 style={{ marginBottom: 16 }}>Create Payment</h1>

      <Form form={form} layout="vertical" onFinish={onFinish} initialValues={{ payment_date: dayjs() }}>
        {/* Row 1: Entry Type, Payee/Payer, Account, Payment Method */}
        <div style={{ background: '#f8f9fb', border: '1px solid #e8e8e8', borderTop: '3px solid #1890ff', padding: '20px 24px', marginBottom: 0 }}>
          <Row gutter={16}>
            <Col xs={24} sm={12} md={6}>
              <Form.Item name="type" label={optionalLabel('Entry Type')}>
                <Select
                  disabled={!!invoiceData}
                  placeholder="Select entry type"
                  options={[
                    { label: 'Inflow', value: 0 },
                    { label: 'Outflow', value: 1 },
                  ]}
                />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12} md={6}>
              <Form.Item name="tenant_id" label={optionalLabel('Payee / Payer')}>
                <Select
                  disabled={!!invoiceData?.tenant_id}
                  placeholder="Select payee/payer"
                  allowClear
                  showSearch
                  optionFilterProp="label"
                  options={tenants.map(t => ({
                    label: getDisplayName(t),
                    value: String(t.id),
                  }))}
                />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12} md={6}>
              <Form.Item name="account_setting_id" label={requiredLabel('Account')} rules={[{ required: true, message: 'Account is required' }]}>
                <Select
                  placeholder="Select an account"
                  allowClear
                  showSearch
                  optionFilterProp="label"
                  options={bankAccounts.map(a => ({ label: a.name, value: a.id }))}
                />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12} md={6}>
              <Form.Item name="payment_setting_id" label={requiredLabel('Payment Method')} rules={[{ required: true, message: 'Payment method is required' }]}>
                <Select
                  placeholder="Select a payment method"
                  allowClear
                  showSearch
                  optionFilterProp="label"
                  options={paymentMethods.map(m => ({ label: m.name || m.paymentMethod, value: m.id }))}
                />
              </Form.Item>
            </Col>
          </Row>

          <Divider style={{ margin: '4px 0 16px' }} />

          {/* Row 2: Due On, Payment Date */}
          <Row gutter={16}>
            <Col xs={24} sm={12} md={6}>
              <Form.Item name="dueOn" label={optionalLabel('Due On')}>
                <DatePicker style={{ width: '100%' }} disabled />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12} md={6}>
              <Form.Item name="payment_date" label={optionalLabel('Payment Date')}>
                <DatePicker style={{ width: '100%' }} placeholder="Select payment date" />
              </Form.Item>
            </Col>
          </Row>

          {/* Row 3: Outstanding, Amount, Category */}
          <Row gutter={16}>
            <Col xs={24} sm={8} md={6}>
              <Form.Item label={optionalLabel('Outstanding')}>
                <Input value={outstanding} disabled style={{ background: '#fafafa' }} />
              </Form.Item>
            </Col>
            <Col xs={24} sm={8} md={6}>
              <Form.Item name="amount" label={requiredLabel('Amount')} rules={[{ required: true, message: 'Amount is required' }]}>
                <InputNumber
                  min={0}
                  style={{ width: '100%' }}
                  addonBefore={currencySymbol}
                  placeholder="Please input your amount"
                />
              </Form.Item>
            </Col>
            <Col xs={24} sm={8} md={6}>
              <Form.Item name="category" label={requiredLabel('Category')} rules={invoiceData ? [] : [{ required: true, message: 'Category is required' }]}>
                <Select
                  placeholder="Please select the category"
                  allowClear
                  showSearch
                  optionFilterProp="label"
                  options={categories.map(c => ({ label: c.name, value: String(c.id) }))}
                />
              </Form.Item>
            </Col>
          </Row>
        </div>

        {/* Notes and Files */}
        <div style={{ background: '#fff', border: '1px solid #e8e8e8', borderTop: 'none', padding: '20px 24px' }}>
          <Row gutter={24}>
            <Col span={12}>
              <Form.Item name="note" label={optionalLabel('Notes')}>
                <Input.TextArea rows={5} placeholder="Please input your notes" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <div style={labelStyle}>Files</div>
              <div style={{ marginTop: 8 }}>
                <Upload.Dragger
                  name="file"
                  multiple
                  action="/api/file/upload"
                  style={{ padding: '20px 0' }}
                >
                  <p className="ant-upload-drag-icon"><UploadOutlined style={{ fontSize: 32, color: '#1890ff' }} /></p>
                  <p className="ant-upload-text" style={{ fontWeight: 600 }}>Upload</p>
                  <p className="ant-upload-hint">Store documents and templates</p>
                </Upload.Dragger>
              </div>
            </Col>
          </Row>
        </div>

        {/* Footer: Cancel / Submit */}
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 16, padding: '12px 0' }}>
          <Button
            onClick={() => router.back()}
            style={{ width: '40%', height: 44 }}
          >
            Cancel
          </Button>
          <Button
            type="primary"
            htmlType="submit"
            loading={loading}
            style={{ width: '55%', height: 44, fontWeight: 600, textTransform: 'uppercase' }}
          >
            Submit
          </Button>
        </div>
      </Form>
    </MainLayout>
  );
}
