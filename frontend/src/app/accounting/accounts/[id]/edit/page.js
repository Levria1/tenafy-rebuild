'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Form, Input, InputNumber, Select, DatePicker, Button, message, Row, Col, Tabs, Divider, Upload, Spin } from 'antd';
import { PlusOutlined, DeleteOutlined, UploadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import MainLayout from '../../../../../components/Layout';
import { accounting, accountingApi, property, tenant, contact, leasing } from '../../../../../lib/api';

export default function AccountEditPage() {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [properties, setProperties] = useState([]);
  const [units, setUnits] = useState([]);
  const [categories, setCategories] = useState([]);
  const [bankAccounts, setBankAccounts] = useState([]);
  const [paymentMethods, setPaymentMethods] = useState([]);
  const [tenants, setTenants] = useState([]);
  const [tags, setTags] = useState([]);
  const [leases, setLeases] = useState([]);
  const router = useRouter();
  const params = useParams();
  const accountId = params.id;

  // Account lines state
  const [accountLines, setAccountLines] = useState([
    { key: Date.now(), amount: '', category: null, invoice_code: '', property_id: null, unit_id: null, lease_id: null, tag_id: null, units: [] }
  ]);

  useEffect(() => {
    loadAll();
  }, [accountId]);

  const loadAll = async () => {
    try {
      const [propRes, catRes, acctRes, pmRes, tenantRes, tagRes] = await Promise.all([
        property.getAll(),
        accountingApi.getCategories(),
        accountingApi.getAccounts(),
        accountingApi.getPaymentMethods(),
        tenant.getAll(),
        contact.getAllTags().catch(() => ({ data: { code: 200, data: [] } })),
      ]);
      if (propRes.data.code === 200) setProperties(propRes.data.data || []);
      if (catRes.data.code === 200) setCategories(catRes.data.data || []);
      if (acctRes.data.code === 200) setBankAccounts(acctRes.data.data || []);
      if (pmRes.data.code === 200) setPaymentMethods(pmRes.data.data || []);
      if (tenantRes.data.code === 200) setTenants(tenantRes.data.data || []);
      if (tagRes.data.code === 200) setTags(tagRes.data.data || []);

      // Load the transaction data
      const response = await accounting.get(accountId);
      if (response.data.code === 200) {
        const data = response.data.data;

        // Load units if property is set
        if (data.property_id) {
          try {
            const unitRes = await property.getUnits(data.property_id);
            if (unitRes.data.code === 200) setUnits(unitRes.data.data || []);
          } catch (e) { /* ignore */ }
        }

        // Load leases if unit is set
        if (data.unit_id) {
          try {
            const leaseRes = await leasing.getUnitLease(data.unit_id);
            if (leaseRes.data.code === 200) {
              const ld = leaseRes.data.data;
              setLeases(Array.isArray(ld) ? ld : ld ? [ld] : []);
            }
          } catch (e) { /* ignore */ }
        }

        form.setFieldsValue({
          type: data.type != null ? Number(data.type) : undefined,
          account_setting_id: data.account_setting_id || undefined,
          payment_setting_id: data.payment_setting_id || undefined,
          tenant_id: data.tenant_id || undefined,
          payment_date: data.payment_date ? dayjs(data.payment_date) : null,
          amount: data.amount ? Number(data.amount) : undefined,
          category: data.category || undefined,
          invoice_code: data.invoice_code || '',
          property_id: data.property_id || undefined,
          unit_id: data.unit_id || undefined,
          lease_id: data.lease_id || undefined,
          tag_id: data.tag_id || undefined,
          note: data.note || '',
        });

        // Load account lines if they exist
        if (data.lines && data.lines.length > 0) {
          setAccountLines(data.lines.map(l => ({
            key: l.id || Date.now() + Math.random(),
            amount: l.amount ? Number(l.amount) : '',
            category: l.category || null,
            invoice_code: l.invoice_code || '',
            property_id: l.property_id || null,
            unit_id: l.unit_id || null,
            lease_id: l.lease_id || null,
            tag_id: l.tag_id || null,
            units: [],
          })));
        }
      }
    } catch (error) {
      console.error('Failed to load data:', error);
      message.error('Failed to load transaction');
    } finally {
      setInitialLoading(false);
    }
  };

  const handlePropertyChange = async (propertyId) => {
    form.setFieldValue('unit_id', undefined);
    form.setFieldValue('lease_id', undefined);
    setUnits([]);
    setLeases([]);
    if (!propertyId) return;
    try {
      const res = await property.getUnits(propertyId);
      if (res.data.code === 200) setUnits(res.data.data || []);
    } catch (e) { /* ignore */ }
  };

  const handleUnitChange = async (unitId) => {
    form.setFieldValue('lease_id', undefined);
    setLeases([]);
    if (!unitId) return;
    try {
      const res = await leasing.getUnitLease(unitId);
      if (res.data.code === 200) {
        const data = res.data.data;
        setLeases(Array.isArray(data) ? data : data ? [data] : []);
      }
    } catch (e) { /* ignore */ }
  };

  // Account line handlers
  const addLine = () => {
    setAccountLines(prev => [...prev, {
      key: Date.now(), amount: '', category: null, invoice_code: '', property_id: null, unit_id: null, lease_id: null, tag_id: null, units: []
    }]);
  };

  const removeLine = (key) => {
    setAccountLines(prev => prev.length > 1 ? prev.filter(l => l.key !== key) : prev);
  };

  const updateLine = (key, field, value) => {
    setAccountLines(prev => prev.map(l => l.key === key ? { ...l, [field]: value } : l));
  };

  const onFinish = async (values) => {
    try {
      setLoading(true);
      const payload = {
        type: values.type,
        account_setting_id: values.account_setting_id,
        payment_setting_id: values.payment_setting_id || null,
        tenant_id: values.tenant_id || null,
        payment_date: values.payment_date?.format('YYYY-MM-DD') || null,
        amount: values.amount,
        category: values.category || null,
        invoice_code: values.invoice_code || null,
        property_id: values.property_id || null,
        unit_id: values.unit_id || null,
        lease_id: values.lease_id || null,
        tag_id: values.tag_id || null,
        note: values.note || null,
      };
      const res = await accounting.update(accountId, payload);
      if (res.data.code === 200) {
        message.success('Transaction updated successfully');
        router.push('/accounting');
      } else {
        message.error(res.data.message || 'Failed to update transaction');
      }
    } catch (error) {
      console.error('Update transaction error:', error);
      message.error(error.response?.data?.message || 'Failed to update transaction');
    } finally {
      setLoading(false);
    }
  };

  const labelStyle = { fontWeight: 600, fontSize: 11, textTransform: 'uppercase' };
  const reqLabel = (text) => <span style={labelStyle}><span style={{ color: 'red' }}>* </span>{text}</span>;
  const optLabel = (text) => <span style={labelStyle}>{text}</span>;

  if (initialLoading) {
    return (
      <MainLayout>
        <div style={{ textAlign: 'center', padding: 100 }}><Spin size="large" /></div>
      </MainLayout>
    );
  }

  return (
    <MainLayout>
      <h1 style={{ marginBottom: 8 }}>Edit Inflow / Outflow</h1>

      <Tabs
        defaultActiveKey="accounts"
        items={[
          { key: 'accounts', label: 'ACCOUNTS' },
          { key: 'lines', label: 'ACCOUNT LINE' },
        ]}
        style={{ marginBottom: 0 }}
      />

      <Form form={form} layout="vertical" onFinish={onFinish}>
        {/* Main fields card */}
        <div style={{ background: '#f8f9fb', border: '1px solid #e8e8e8', borderTop: '3px solid #1890ff', padding: '20px 24px', marginBottom: 0 }}>
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name="type" label={reqLabel('Entry Type')} rules={[{ required: true, message: 'Please select the entry type' }]}>
                <Select placeholder="Please select the entry type" options={[{ label: 'Inflow (CR)', value: 0 }, { label: 'Outflow (DR)', value: 1 }]} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="account_setting_id" label={reqLabel('Account')} rules={[{ required: true, message: 'Please select an account' }]}>
                <Select placeholder="Please select an account" allowClear showSearch optionFilterProp="label" options={bankAccounts.map(a => ({ label: a.name, value: a.id }))} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="payment_setting_id" label={reqLabel('Payment Method')} rules={[{ required: true, message: 'Please select the payment method' }]}>
                <Select placeholder="Please select the payment method" allowClear options={paymentMethods.map(m => ({ label: m.name, value: m.id }))} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name="tenant_id" label={reqLabel('Payee / Payer')} rules={[{ required: true, message: 'Please select the payee/payer' }]}>
                <Select placeholder="Please select the payee/payer" allowClear showSearch optionFilterProp="label" options={tenants.map(t => ({ label: `${t.first_name || ''} ${t.last_name || ''}`.trim(), value: t.id }))} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="payment_date" label={optLabel('Date')}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={8} />
          </Row>
        </div>

        {/* Amount / Category / Invoice */}
        <div style={{ background: '#f8f9fb', border: '1px solid #e8e8e8', borderTop: 'none', padding: '20px 24px', marginBottom: 0 }}>
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name="amount" label={reqLabel('Amount')} rules={[{ required: true, message: 'Please input your amount' }]}>
                <InputNumber min={0} style={{ width: '100%' }} addonBefore="HK$" placeholder="Please input your amount" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="category" label={reqLabel('Category')} rules={[{ required: true, message: 'Please select the category' }]}>
                <Select placeholder="Please select the category" allowClear showSearch optionFilterProp="label" options={categories.map(c => ({ label: c.name, value: c.id }))} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="invoice_code" label={optLabel('Invoice Number')}>
                <Input />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={6}>
              <Form.Item name="property_id" label={optLabel('Property')}>
                <Select placeholder="Please select the property" allowClear showSearch optionFilterProp="label" onChange={handlePropertyChange} options={properties.map(p => ({ label: p.display_name, value: p.id }))} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="unit_id" label={optLabel('Unit')}>
                <Select placeholder="Please select the unit" allowClear onChange={handleUnitChange} options={units.map(u => ({ label: u.name, value: u.id }))} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="lease_id" label={optLabel('Lease')}>
                <Select placeholder="Please input your unit lease" allowClear options={leases.map(l => ({ label: l.lease_no || `Lease #${l.id}`, value: l.id }))} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="tag_id" label={optLabel('Property Owner Tag')}>
                <Select placeholder="Please select the tag" allowClear options={tags.map(t => ({ label: t.name, value: t.id }))} />
              </Form.Item>
            </Col>
          </Row>
        </div>

        {/* Account Lines */}
        <div style={{ background: '#fff', border: '1px solid #e8e8e8', borderTop: 'none', padding: '12px 24px' }}>
          {accountLines.map((line, index) => (
            <div key={line.key} style={{ marginBottom: 8 }}>
              {accountLines.length > 1 && (
                <a onClick={() => removeLine(line.key)} style={{ color: '#1890ff', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
                  <DeleteOutlined /> del Line
                </a>
              )}
              {index === 0 && accountLines.length === 1 && (
                <a onClick={() => removeLine(line.key)} style={{ color: '#1890ff', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
                  <DeleteOutlined /> del Line
                </a>
              )}
              {index > 0 && <Divider style={{ margin: '8px 0' }} />}
            </div>
          ))}
          <a onClick={addLine} style={{ color: '#1890ff', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
            <PlusOutlined /> add Line
          </a>
        </div>

        {/* Notes and Files */}
        <div style={{ background: '#fff', border: '1px solid #e8e8e8', borderTop: 'none', padding: '20px 24px' }}>
          <Row gutter={24}>
            <Col span={12}>
              <Form.Item name="note" label={optLabel('Notes')}>
                <Input.TextArea rows={5} placeholder="Please input your notes" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <div style={{ fontWeight: 600, fontSize: 11, textTransform: 'uppercase', marginBottom: 8 }}>Files</div>
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
            </Col>
          </Row>
        </div>

        {/* Footer */}
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 16, padding: '12px 0' }}>
          <Button
            onClick={() => router.push('/accounting')}
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
