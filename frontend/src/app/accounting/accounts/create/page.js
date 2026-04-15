'use client';

import React, { useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Form, Input, InputNumber, Select, DatePicker, Button, message, Row, Col, Tabs, Divider, Upload, AutoComplete } from 'antd';
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
  const [selectedPayerId, setSelectedPayerId] = useState(null);
  const router = useRouter();

  // Account lines state - starts empty, lines added via "+add Line"
  const [accountLines, setAccountLines] = useState([]);
  const lineKeyRef = useRef(0);

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
    lineKeyRef.current += 1;
    setAccountLines(prev => [...prev, {
      key: `line-${Date.now()}-${lineKeyRef.current}`, amount: '', category: null, invoice_code: '', property_id: null, unit_id: null, lease_id: null, tag_id: null, units: []
    }]);
  };

  const removeLine = (key) => {
    setAccountLines(prev => {
      const next = prev.filter(l => l.key !== key);
      // Auto-sum: update header amount when lines change
      if (next.length > 0) {
        const sum = next.reduce((s, l) => s + (Number(l.amount) || 0), 0);
        form.setFieldValue('amount', sum || undefined);
      }
      return next;
    });
  };

  const updateLine = (key, field, value) => {
    setAccountLines(prev => {
      const next = prev.map(l => l.key === key ? { ...l, [field]: value } : l);
      // Auto-sum: update header amount when a line amount changes
      if (field === 'amount' && next.length > 0) {
        const sum = next.reduce((s, l) => s + (Number(l.amount) || 0), 0);
        form.setFieldValue('amount', sum || undefined);
      }
      return next;
    });
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
      // If user selected from dropdown, selectedPayerId has the ID; otherwise it's a new name
      const payload = {
        type: values.type,
        account_setting_id: values.account_setting_id,
        payment_setting_id: values.payment_setting_id || null,
        tenant_id: selectedPayerId || null,
        tenant_name: !selectedPayerId ? values.tenant_id : null,
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
              <Form.Item name="tenant_id" label={<span style={{ fontWeight: 600, fontSize: 11, textTransform: 'uppercase' }}><span style={{ color: 'red' }}>* </span>Payee / Payer</span>} rules={[{ required: true, message: 'Please select or type the payee/payer' }]}>
                <AutoComplete
                  placeholder="Please select or type the payee/payer"
                  allowClear
                  filterOption={(input, option) => (option?.label || '').toLowerCase().includes(input.toLowerCase())}
                  options={tenants.map(t => {
                    const name = `${t.first_name || ''} ${t.last_name || ''}`.trim();
                    return { label: name, value: name, tenantId: t.id };
                  })}
                  onSelect={(val, option) => setSelectedPayerId(option.tenantId)}
                  onChange={(val) => {
                    if (!val) { setSelectedPayerId(null); return; }
                    // Only reset if user manually changed text away from the selected option
                    if (selectedPayerId) {
                      const selectedTenant = tenants.find(t => t.id === selectedPayerId);
                      if (selectedTenant) {
                        const selectedName = `${selectedTenant.first_name || ''} ${selectedTenant.last_name || ''}`.trim();
                        if (val !== selectedName) setSelectedPayerId(null);
                      }
                    }
                  }}
                />
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
            <Col span={6}>
              <Form.Item name="amount" label={<span style={{ fontWeight: 600, fontSize: 11, textTransform: 'uppercase' }}><span style={{ color: 'red' }}>* </span>Amount{accountLines.length > 0 ? ' (Total)' : ''}</span>} rules={[{ required: true, message: 'Please input your amount' }]}>
                <InputNumber min={0} style={{ width: '100%' }} addonBefore="HK$" placeholder="Please input your amount" disabled={accountLines.length > 0} />
              </Form.Item>
            </Col>
            <Col span={6}>
              {accountLines.length > 0 ? (
                <div>
                  <div style={{ fontWeight: 600, fontSize: 11, textTransform: 'uppercase', marginBottom: 8 }}>Category</div>
                  <Input value="Multiple Expense" disabled style={{ width: '100%', color: '#1890ff', fontWeight: 600 }} />
                </div>
              ) : (
                <Form.Item name="category" label={<span style={{ fontWeight: 600, fontSize: 11, textTransform: 'uppercase' }}><span style={{ color: 'red' }}>* </span>Category</span>} rules={[{ required: true, message: 'Please select the category' }]}>
                  <Select placeholder="Please select the category" allowClear showSearch optionFilterProp="label" options={categories.map(c => ({ label: c.name, value: c.id }))} />
                </Form.Item>
              )}
            </Col>
            <Col span={6}>
              {accountLines.length === 0 && (
                <Form.Item name="invoice_code" label={<span style={{ fontWeight: 600, fontSize: 11, textTransform: 'uppercase' }}>Invoice Number</span>}>
                  <Input />
                </Form.Item>
              )}
            </Col>
            <Col span={6} />
          </Row>
          {accountLines.length === 0 && (
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
          )}
        </div>

        {/* Account Lines */}
        <div style={{ background: '#f8f9fb', border: '1px solid #e8e8e8', borderTop: 'none', padding: '12px 24px' }}>
          {accountLines.map((line) => (
            <div key={line.key} style={{ marginBottom: 16, paddingBottom: 16, borderBottom: '1px solid #d9d9d9' }}>
              <Row gutter={16}>
                <Col span={6}>
                  <div style={{ fontWeight: 600, fontSize: 11, textTransform: 'uppercase', marginBottom: 4 }}><span style={{ color: 'red' }}>* </span>Amount</div>
                  <InputNumber min={0} style={{ width: '100%' }} addonBefore="HK$" placeholder="Please input your amount" value={line.amount} onChange={v => updateLine(line.key, 'amount', v)} />
                </Col>
                <Col span={6}>
                  <div style={{ fontWeight: 600, fontSize: 11, textTransform: 'uppercase', marginBottom: 4 }}><span style={{ color: 'red' }}>* </span>Category</div>
                  <Select placeholder="Please select the category" allowClear showSearch optionFilterProp="label" style={{ width: '100%' }} value={line.category} onChange={v => updateLine(line.key, 'category', v)} options={categories.map(c => ({ label: c.name, value: c.id }))} />
                </Col>
                <Col span={6}>
                  <div style={{ fontWeight: 600, fontSize: 11, textTransform: 'uppercase', marginBottom: 4 }}>Invoice Number</div>
                  <Input placeholder="" value={line.invoice_code} onChange={e => updateLine(line.key, 'invoice_code', e.target.value)} />
                </Col>
                <Col span={6} />
              </Row>
              <Row gutter={16} style={{ marginTop: 8 }}>
                <Col span={6}>
                  <div style={{ fontWeight: 600, fontSize: 11, textTransform: 'uppercase', marginBottom: 4 }}>Property</div>
                  <Select placeholder="Please select the property" allowClear showSearch optionFilterProp="label" style={{ width: '100%' }} value={line.property_id} onChange={v => handleLinePropertyChange(line.key, v)} options={properties.map(p => ({ label: p.display_name, value: p.id }))} />
                </Col>
                <Col span={6}>
                  <div style={{ fontWeight: 600, fontSize: 11, textTransform: 'uppercase', marginBottom: 4 }}>Unit</div>
                  <Select placeholder="Please select the unit" allowClear style={{ width: '100%' }} value={line.unit_id} onChange={v => updateLine(line.key, 'unit_id', v)} options={(line.units || []).map(u => ({ label: u.name, value: u.id }))} />
                </Col>
                <Col span={6}>
                  <div style={{ fontWeight: 600, fontSize: 11, textTransform: 'uppercase', marginBottom: 4 }}>Lease</div>
                  <Select placeholder="Please input your unit lease" allowClear style={{ width: '100%' }} value={line.lease_id} onChange={v => updateLine(line.key, 'lease_id', v)} options={leases.map(l => ({ label: l.lease_code || `Lease #${l.id}`, value: l.id }))} />
                </Col>
                <Col span={6}>
                  <div style={{ fontWeight: 600, fontSize: 11, textTransform: 'uppercase', marginBottom: 4 }}>Property Owner Tag</div>
                  <Select placeholder="Please select the tag" allowClear style={{ width: '100%' }} value={line.tag_id} onChange={v => updateLine(line.key, 'tag_id', v)} options={tags.map(t => ({ label: t.name, value: t.id }))} />
                </Col>
              </Row>
            </div>
          ))}
          {accountLines.length > 0 && (
            <a onClick={(e) => { e.preventDefault(); setAccountLines(prev => prev.slice(0, -1)); }} style={{ color: '#1890ff', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4, cursor: 'pointer' }}>
              <DeleteOutlined /> del Line
            </a>
          )}
          <a onClick={(e) => { e.preventDefault(); addLine(); }} style={{ color: '#1890ff', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
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
