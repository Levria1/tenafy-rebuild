'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Form, Input, Button, Select, DatePicker, InputNumber, message, Row, Col, Spin, Upload } from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import MainLayout from '../../../../components/Layout';
import { invoice, settings } from '../../../../lib/api';

export default function InvoiceEditPage() {
  const router = useRouter();
  const params = useParams();
  const invoiceId = params.id;
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);

  // Dropdown data
  const [tenants, setTenants] = useState([]);
  const [properties, setProperties] = useState([]);
  const [units, setUnits] = useState([]);
  const [leases, setLeases] = useState([]);
  const [categories, setCategories] = useState([]);
  const [tags, setTags] = useState([]);
  const [currencySymbol, setCurrencySymbol] = useState('HK$');

  // Original invoice data for reference
  const [invoiceData, setInvoiceData] = useState(null);

  useEffect(() => {
    loadAllData();
  }, [invoiceId]);

  const loadAllData = async () => {
    try {
      // Load invoice detail + dropdown data in parallel
      const [invRes, payersRes, propsRes, catsRes] = await Promise.all([
        invoice.get(invoiceId),
        invoice.getInitializationPayer({}),
        invoice.getInitializationProperty({}),
        settings.getCategories(),
      ]);

      const inv = invRes.data.code === 200 ? invRes.data.data : null;
      const payersData = payersRes.data.code === 200 ? (payersRes.data.data || []) : [];
      const propsData = propsRes.data.code === 200 ? (propsRes.data.data || []) : [];
      const catsData = catsRes.data.code === 200 ? (catsRes.data.data || []) : [];

      setTenants(payersData);
      setProperties(propsData);
      setCategories(catsData);

      if (!inv) {
        message.error('Invoice not found');
        router.push('/invoices');
        return;
      }

      setInvoiceData(inv);

      // Determine property_id (could be on invoice directly or via unit)
      const propId = inv.property_id || inv.property_id_resolved || inv.unit_property_id || null;

      // Load units for the property
      if (propId) {
        try {
          const unitsRes = await invoice.getInitializationUnit({ propertyId: propId });
          if (unitsRes.data.code === 200) setUnits(unitsRes.data.data || []);
        } catch (e) { /* ignore */ }
      }

      // Load leases for the tenant
      if (inv.tenant_id) {
        try {
          const leaseParams = { tenantId: inv.tenant_id };
          if (inv.unit_id) leaseParams.unitId = inv.unit_id;
          const leasesRes = await invoice.getInitializationLeasing(leaseParams);
          if (leasesRes.data.code === 200) setLeases(leasesRes.data.data || []);
        } catch (e) { /* ignore */ }
      }

      // Set currency symbol from property
      if (inv.property_currency) setCurrencySymbol(inv.property_currency);

      // Set form values
      form.setFieldsValue({
        type: Number(inv.type) || 0,
        tenant_id: inv.tenant_id || undefined,
        property_id: propId || undefined,
        unit_id: inv.unit_id || undefined,
        leasing_id: inv.leasing_id || undefined,
        due_on: inv.due_on ? dayjs(inv.due_on) : undefined,
        category: inv.category || undefined,
        amount: inv.amount ? Number(inv.amount) : undefined,
        tag_id: inv.tag_id || undefined,
        note: inv.note || '',
      });
    } catch (error) {
      console.error('Failed to load invoice data:', error);
      message.error('Failed to load invoice data');
    } finally {
      setInitialLoading(false);
    }
  };

  // When property changes, reload units
  const onPropertyChange = async (propertyId) => {
    form.setFieldsValue({ unit_id: undefined, leasing_id: undefined });
    setUnits([]);
    setLeases([]);
    if (!propertyId) return;
    try {
      const unitsRes = await invoice.getInitializationUnit({ propertyId });
      if (unitsRes.data.code === 200) setUnits(unitsRes.data.data || []);
    } catch (e) { /* ignore */ }

    // Reload leases filtered by property
    const tenantId = form.getFieldValue('tenant_id');
    if (tenantId) {
      try {
        const leasesRes = await invoice.getInitializationLeasing({ tenantId, propertyId });
        if (leasesRes.data.code === 200) setLeases(leasesRes.data.data || []);
      } catch (e) { /* ignore */ }
    }
  };

  // When contact changes, reload leases
  const onContactChange = async (tenantId) => {
    form.setFieldsValue({ leasing_id: undefined });
    setLeases([]);
    if (!tenantId) return;
    const propertyId = form.getFieldValue('property_id');
    const unitId = form.getFieldValue('unit_id');
    try {
      const params = { tenantId };
      if (propertyId) params.propertyId = propertyId;
      if (unitId) params.unitId = unitId;
      const leasesRes = await invoice.getInitializationLeasing(params);
      if (leasesRes.data.code === 200) setLeases(leasesRes.data.data || []);
    } catch (e) { /* ignore */ }
  };

  // When unit changes, reload leases
  const onUnitChange = async (unitId) => {
    form.setFieldsValue({ leasing_id: undefined });
    setLeases([]);
    const tenantId = form.getFieldValue('tenant_id');
    if (tenantId) {
      try {
        const params = { tenantId };
        if (unitId) params.unitId = unitId;
        const leasesRes = await invoice.getInitializationLeasing(params);
        if (leasesRes.data.code === 200) setLeases(leasesRes.data.data || []);
      } catch (e) { /* ignore */ }
    }
  };

  const onFinish = async (values) => {
    try {
      setLoading(true);
      const payload = {
        type: values.type,
        tenant_id: values.tenant_id,
        property_id: values.property_id || null,
        unit_id: values.unit_id || null,
        leasing_id: values.leasing_id || null,
        due_date: values.due_on?.format('YYYY-MM-DD'),
        category: values.category || null,
        amount: values.amount,
        tag_id: values.tag_id || null,
        note: values.note || null,
        // Keep existing invoice_code and status
        invoice_code: invoiceData?.invoice_code,
        status: Number(invoiceData?.status),
      };
      const res = await invoice.update(invoiceId, payload);
      if (res.data.code === 200) {
        message.success('Invoice updated successfully');
        router.push('/invoices');
      } else {
        message.error(res.data.message || 'Failed to update invoice');
      }
    } catch (error) {
      console.error('Update error:', error);
      message.error(error.response?.data?.message || 'Failed to update invoice');
    } finally {
      setLoading(false);
    }
  };

  if (initialLoading) {
    return (
      <MainLayout>
        <div style={{ textAlign: 'center', padding: 100 }}><Spin size="large" /></div>
      </MainLayout>
    );
  }

  return (
    <MainLayout>
      <h2 style={{ marginBottom: 24 }}>Edit Invoice</h2>

      <Form form={form} layout="vertical" onFinish={onFinish}>
        {/* Row 1: Entry Type + Contact */}
        <div style={{ background: '#fafafa', padding: '20px 24px', borderRadius: 6, marginBottom: 16 }}>
          <Row gutter={24}>
            <Col span={8}>
              <Form.Item name="type" label="* ENTRY TYPE" rules={[{ required: true, message: 'Required' }]}>
                <Select>
                  <Select.Option value={0}>Inflow</Select.Option>
                  <Select.Option value={1}>Outflow</Select.Option>
                </Select>
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="tenant_id" label="* CONTACT" rules={[{ required: true, message: 'Required' }]}>
                <Select
                  placeholder="Select contact"
                  showSearch
                  optionFilterProp="children"
                  onChange={onContactChange}
                >
                  {tenants.map(t => (
                    <Select.Option key={t.id} value={t.id}>
                      {t.first_name} {t.last_name}
                    </Select.Option>
                  ))}
                </Select>
              </Form.Item>
            </Col>
          </Row>

          {/* Row 2: Property + Unit + Lease */}
          <Row gutter={24}>
            <Col span={8}>
              <Form.Item name="property_id" label="* PROPERTY">
                <Select
                  placeholder="Select property"
                  showSearch
                  optionFilterProp="children"
                  allowClear
                  onChange={onPropertyChange}
                >
                  {properties.map(p => (
                    <Select.Option key={p.id} value={p.id}>{p.display_name || p.street_address}</Select.Option>
                  ))}
                </Select>
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="unit_id" label="UNIT">
                <Select
                  placeholder="Select unit"
                  showSearch
                  optionFilterProp="children"
                  allowClear
                  onChange={onUnitChange}
                >
                  {units.map(u => (
                    <Select.Option key={u.id} value={u.id}>{u.name}</Select.Option>
                  ))}
                </Select>
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="leasing_id" label="LEASE">
                <Select
                  placeholder="Select lease"
                  showSearch
                  optionFilterProp="children"
                  allowClear
                >
                  {leases.map(l => (
                    <Select.Option key={l.id} value={l.id}>
                      {l.id ? `LEA${String(l.id).slice(-4)}` : '-'}
                    </Select.Option>
                  ))}
                </Select>
              </Form.Item>
            </Col>
          </Row>
        </div>

        {/* Row 3: Due Date + Category + Amount + Property Owner Tag */}
        <div style={{ background: '#f0f5ff', padding: '20px 24px', borderRadius: 6, marginBottom: 16 }}>
          <Row gutter={24}>
            <Col span={6}>
              <Form.Item name="due_on" label="* DUE DATE" rules={[{ required: true, message: 'Required' }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="category" label="* CATEGORY" rules={[{ required: true, message: 'Required' }]}>
                <Select
                  placeholder="Select category"
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
            <Col span={6}>
              <Form.Item name="amount" label="* AMOUNT" rules={[{ required: true, message: 'Required' }]}>
                <InputNumber
                  style={{ width: '100%' }}
                  min={0}
                  precision={2}
                  prefix={currencySymbol}
                />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="tag_id" label="PROPERTY OWNER TAG">
                <Select placeholder="Please select the tag" allowClear>
                  {tags.map(tg => (
                    <Select.Option key={tg.id} value={tg.id}>{tg.name}</Select.Option>
                  ))}
                </Select>
              </Form.Item>
            </Col>
          </Row>
        </div>

        {/* Row 4: Notes + Files */}
        <Row gutter={24}>
          <Col span={12}>
            <Form.Item name="note" label="NOTES">
              <Input.TextArea rows={5} placeholder="Notes..." />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item label="FILES">
              <Upload.Dragger
                name="file"
                multiple
                beforeUpload={() => false}
                style={{ padding: '20px 0' }}
              >
                <p className="ant-upload-drag-icon">
                  <UploadOutlined style={{ fontSize: 32, color: '#1890ff' }} />
                </p>
                <p className="ant-upload-text">Upload</p>
                <p className="ant-upload-hint">Store documents and templates</p>
              </Upload.Dragger>
            </Form.Item>
          </Col>
        </Row>

        {/* Action Buttons */}
        <Row gutter={24} style={{ marginTop: 24 }}>
          <Col span={12}>
            <Button block size="large" onClick={() => router.push('/invoices')}>
              Cancel
            </Button>
          </Col>
          <Col span={12}>
            <Button type="primary" htmlType="submit" block size="large" loading={loading}>
              SUBMIT
            </Button>
          </Col>
        </Row>
      </Form>
    </MainLayout>
  );
}
