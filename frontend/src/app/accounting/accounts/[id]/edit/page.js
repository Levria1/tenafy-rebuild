'use client';

import React, { useEffect, useState, useRef } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Form, Input, InputNumber, Select, DatePicker, Button, message, Row, Col, Tabs, Divider, Upload, Spin, AutoComplete } from 'antd';
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
  const [selectedPayerId, setSelectedPayerId] = useState(null);
  const router = useRouter();
  const params = useParams();
  const accountId = params.id;

  // Account lines state - starts empty, populated from server or via "+add Line"
  const [accountLines, setAccountLines] = useState([]);
  const lineKeyRef = useRef(0);

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
      const tenantList = tenantRes.data.code === 200 ? (tenantRes.data.data || []) : [];
      setTenants(tenantList);
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

        // Resolve tenant ID to display name for AutoComplete
        if (data.tenant_id) {
          setSelectedPayerId(data.tenant_id);
          const matchedTenant = tenantList.find(t => t.id === data.tenant_id);
          if (matchedTenant) {
            data._tenantDisplayName = `${matchedTenant.first_name || ''} ${matchedTenant.last_name || ''}`.trim();
          }
        }

        form.setFieldsValue({
          type: data.type != null ? Number(data.type) : undefined,
          account_setting_id: data.account_setting_id || undefined,
          payment_setting_id: data.payment_setting_id || undefined,
          tenant_id: data._tenantDisplayName || (data.tenant_name || undefined),
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
        // Skip if there's only 1 line that matches the header (it's just the header line, not an extra breakdown)
        if (data.lines && data.lines.length > 0) {
          // The detail GET coalesces line category/property/unit/lease into the header, but not tag_id.
          // A line with only a line-level owner tag is therefore a real breakdown; skipping it would let
          // Save hard-delete and rebuild the line from the untagged header, destroying the owner tag.
          const isHeaderOnly = data.lines.length === 1
            && Number(data.lines[0].amount) === Number(data.amount)
            && String(data.lines[0].category || '') === String(data.category || '')
            && String(data.lines[0].tag_id || '') === String(data.tag_id || '')
            && String(data.lines[0].invoice_code || '').trim() === String(data.invoice_code || '').trim();
          if (!isHeaderOnly) {
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
    lineKeyRef.current += 1;
    setAccountLines(prev => [...prev, {
      key: `line-${Date.now()}-${lineKeyRef.current}`, amount: '', category: null, invoice_code: '', property_id: null, unit_id: null, lease_id: null, tag_id: null, units: []
    }]);
  };

  const removeLine = (key) => {
    setAccountLines(prev => {
      const next = prev.filter(l => l.key !== key);
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
              <Form.Item name="tenant_id" label={reqLabel('Payee / Payer')} rules={[{ required: true, message: 'Please select or type the payee/payer' }]}>
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
              <Form.Item name="amount" label={<span style={labelStyle}><span style={{ color: 'red' }}>* </span>Amount{accountLines.length > 0 ? ' (Total)' : ''}</span>} rules={[{ required: true, message: 'Please input your amount' }]}>
                <InputNumber min={0} style={{ width: '100%' }} addonBefore="HK$" placeholder="Please input your amount" disabled={accountLines.length > 0} />
              </Form.Item>
            </Col>
            <Col span={8}>
              {accountLines.length > 0 ? (
                <div>
                  <div style={{ ...labelStyle, marginBottom: 8 }}>Category</div>
                  <Input value="Multiple Expense" disabled style={{ width: '100%', color: '#1890ff', fontWeight: 600 }} />
                </div>
              ) : (
                <Form.Item name="category" label={reqLabel('Category')} rules={[{ required: true, message: 'Please select the category' }]}>
                  <Select placeholder="Please select the category" allowClear showSearch optionFilterProp="label" options={categories.map(c => ({ label: c.name, value: c.id }))} />
                </Form.Item>
              )}
            </Col>
            <Col span={8}>
              {accountLines.length === 0 && (
                <Form.Item name="invoice_code" label={optLabel('Invoice Number')}>
                  <Input />
                </Form.Item>
              )}
            </Col>
          </Row>
          {accountLines.length === 0 && (
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
          )}
        </div>

        {/* Account Lines */}
        <div style={{ background: '#f8f9fb', border: '1px solid #e8e8e8', borderTop: 'none', padding: '12px 24px' }}>
          {accountLines.map((line) => (
            <div key={line.key} style={{ marginBottom: 16 }}>
              <Row gutter={16}>
                <Col span={8}>
                  <div style={{ fontWeight: 600, fontSize: 11, textTransform: 'uppercase', marginBottom: 4 }}><span style={{ color: 'red' }}>* </span>Amount</div>
                  <InputNumber min={0} style={{ width: '100%' }} addonBefore="HK$" placeholder="Please input your amount" value={line.amount} onChange={v => updateLine(line.key, 'amount', v)} />
                </Col>
                <Col span={8}>
                  <div style={{ fontWeight: 600, fontSize: 11, textTransform: 'uppercase', marginBottom: 4 }}><span style={{ color: 'red' }}>* </span>Category</div>
                  <Select placeholder="Please select the category" allowClear showSearch optionFilterProp="label" style={{ width: '100%' }} value={line.category} onChange={v => updateLine(line.key, 'category', v)} options={categories.map(c => ({ label: c.name, value: c.id }))} />
                </Col>
                <Col span={8}>
                  <div style={{ fontWeight: 600, fontSize: 11, textTransform: 'uppercase', marginBottom: 4 }}>Invoice Number</div>
                  <Input placeholder="" value={line.invoice_code} onChange={e => updateLine(line.key, 'invoice_code', e.target.value)} />
                </Col>
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
                  <Select placeholder="Please input your unit lease" allowClear style={{ width: '100%' }} value={line.lease_id} onChange={v => updateLine(line.key, 'lease_id', v)} options={leases.map(l => ({ label: l.lease_no || `Lease #${l.id}`, value: l.id }))} />
                </Col>
                <Col span={6}>
                  <div style={{ fontWeight: 600, fontSize: 11, textTransform: 'uppercase', marginBottom: 4 }}>Property Owner Tag</div>
                  <Select placeholder="Please select the tag" allowClear style={{ width: '100%' }} value={line.tag_id} onChange={v => updateLine(line.key, 'tag_id', v)} options={tags.map(t => ({ label: t.name, value: t.id }))} />
                </Col>
              </Row>
            </div>
          ))}
          {accountLines.length > 0 && (
            <a onClick={() => setAccountLines(prev => prev.slice(0, -1))} style={{ color: '#1890ff', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
              <DeleteOutlined /> del Line
            </a>
          )}
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
