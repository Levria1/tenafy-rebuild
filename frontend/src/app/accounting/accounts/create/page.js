'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Form, Input, InputNumber, Select, DatePicker, Button, message, Row, Col, Tabs, Divider, Upload } from 'antd';
import { PlusOutlined, DeleteOutlined, UploadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import MainLayout from '../../../../components/Layout';
import { accounting, accountingApi, property, tenant, contact, leasing } from '../../../../lib/api';

export default function AccountCreatePage() {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [properties, setProperties] = useState([]);
  const [units, setUnits] = useState([]);
  const [categories, setCategories] = useState([]);
  const [bankAccounts, setBankAccounts] = useState([]);
  const [paymentMethods, setPaymentMethods] = useState([]);
  const [tenants, setTenants] = useState([]);
  const [tags, setTags] = useState([]);
  const [leases, setLeases] = useState([]);
  const router = useRouter();

  // Account lines state
  const [accountLines, setAccountLines] = useState([
    { key: Date.now(), amount: '', category: null, invoice_code: '', property_id: null, unit_id: null, lease_id: null, tag_id: null, units: [] }
  ]);

  useEffect(() => {
    loadOptions();
  }, []);

  const loadOptions = async () => {
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
    } catch (error) {
      console.error('Failed to load options');
    }
  };

  // Header-level property change → load units for header
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

  // Header-level unit change → load leases
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

  const handleLinePropertyChange = async (key, propertyId) => {
    updateLine(key, 'property_id', propertyId);
    updateLine(key, 'unit_id', null);
    updateLine(key, 'lease_id', null);
    updateLine(key, 'units', []);
    if (!propertyId) return;
    try {
      const res = await property.getUnits(propertyId);
      if (res.data.code === 200) {
        updateLine(key, 'units', res.data.data || []);
      }
    } catch (e) { /* ignore */ }
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
        lines: accountLines
          .filter(l => l.amount || l.category)
          .map(l => ({
            amount: l.amount || 0,
            category: l.category || null,
            invoice_code: l.invoice_code || null,
            property_id: l.property_id || null,
            unit_id: l.unit_id || null,
            lease_id: l.lease_id || null,
            tag_id: l.tag_id || null,
          })),
      };
      const res = await accounting.create(payload);
      if (res.data.code === 200) {
        message.success('Transaction created successfully');
        router.push('/accounting');
      } else {
        message.error(res.data.message || 'Failed to create transaction');
      }
    } catch (error) {
      message.error(error.response?.data?.message || 'Failed to create transaction');
    } finally {
      setLoading(false);
    }
  };

  return (
    <MainLayout>
      <h1 style={{ marginBottom: 8 }}>Add Inflow / Outflow</h1>

      <Tabs
        defaultActiveKey="accounts"
        items={[
          { key: 'accounts', label: 'ACCOUNTS' },
          { key: 'lines', label: 'ACCOUNT LINE' },
        ]}
        style={{ marginBottom: 0 }}
      />

      <Form form={form} layout="vertical" onFinish={onFinish} initialValues={{ payment_date: dayjs() }}>
        {/* Main fields card */}
        <div style={{ background: '#f8f9fb', border: '1px solid #e8e8e8', borderTop: '3px solid #1890ff', padding: '20px 24px', marginBottom: 0 }}>
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name="type" label={<span style={{ fontWeight: 600, fontSize: 11, textTransform: 'uppercase' }}><span style={{ color: 'red' }}>* </span>Entry Type</span>} rules={[{ required: true, message: 'Please select the entry type' }]}>
                <Select placeholder="Please select the entry type" options={[{ label: 'Inflow (CR)', value: 0 }, { label: 'Outflow (DR)', value: 1 }]} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="account_setting_id" label={<span style={{ fontWeight: 600, fontSize: 11, textTransform: 'uppercase' }}><span style={{ color: 'red' }}>* </span>Account</span>} rules={[{ required: true, message: 'Please select an account' }]}>
                <Select placeholder="Please select an account" allowClear showSearch optionFilterProp="label" options={bankAccounts.map(a => ({ label: a.name, value: a.id }))} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="payment_setting_id" label={<span style={{ fontWeight: 600, fontSize: 11, textTransform: 'uppercase' }}><span style={{ color: 'red' }}>* </span>Payment Method</span>} rules={[{ required: true, message: 'Please select the payment method' }]}>
                <Select placeholder="Please select the payment method" allowClear options={paymentMethods.map(m => ({ label: m.name, value: m.id }))} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name="tenant_id" label={<span style={{ fontWeight: 600, fontSize: 11, textTransform: 'uppercase' }}><span style={{ color: 'red' }}>* </span>Payee / Payer</span>} rules={[{ required: true, message: 'Please select the payee/payer' }]}>
                <Select placeholder="Please select the payee/payer" allowClear showSearch optionFilterProp="label" options={tenants.map(t => ({ label: `${t.first_name || ''} ${t.last_name || ''}`.trim(), value: t.id }))} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="payment_date" label={<span style={{ fontWeight: 600, fontSize: 11, textTransform: 'uppercase' }}>Date</span>}>
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
              <Form.Item name="amount" label={<span style={{ fontWeight: 600, fontSize: 11, textTransform: 'uppercase' }}><span style={{ color: 'red' }}>* </span>Amount</span>} rules={[{ required: true, message: 'Please input your amount' }]}>
                <InputNumber min={0} style={{ width: '100%' }} addonBefore="HK$" placeholder="Please input your amount" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="category" label={<span style={{ fontWeight: 600, fontSize: 11, textTransform: 'uppercase' }}><span style={{ color: 'red' }}>* </span>Category</span>} rules={[{ required: true, message: 'Please select the category' }]}>
                <Select placeholder="Please select the category" allowClear showSearch optionFilterProp="label" options={categories.map(c => ({ label: c.name, value: c.id }))} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="invoice_code" label={<span style={{ fontWeight: 600, fontSize: 11, textTransform: 'uppercase' }}>Invoice Number</span>}>
                <Input />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={6}>
              <Form.Item name="property_id" label={<span style={{ fontWeight: 600, fontSize: 11, textTransform: 'uppercase' }}>Property</span>}>
                <Select placeholder="Please select the property" allowClear showSearch optionFilterProp="label" onChange={handlePropertyChange} options={properties.map(p => ({ label: p.display_name, value: p.id }))} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="unit_id" label={<span style={{ fontWeight: 600, fontSize: 11, textTransform: 'uppercase' }}>Unit</span>}>
                <Select placeholder="Please select the unit" allowClear onChange={handleUnitChange} options={units.map(u => ({ label: u.name, value: u.id }))} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="lease_id" label={<span style={{ fontWeight: 600, fontSize: 11, textTransform: 'uppercase' }}>Lease</span>}>
                <Select placeholder="Please input your unit lease" allowClear options={leases.map(l => ({ label: l.lease_code || `Lease #${l.id}`, value: l.id }))} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="tag_id" label={<span style={{ fontWeight: 600, fontSize: 11, textTransform: 'uppercase' }}>Property Owner Tag</span>}>
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
              <Form.Item name="note" label={<span style={{ fontWeight: 600, fontSize: 11, textTransform: 'uppercase' }}>Notes</span>}>
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
