'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Form, Input, Button, Select, DatePicker, InputNumber, message, Row, Col, Spin, Divider } from 'antd';
import dayjs from 'dayjs';
import { AttachedFileList, FileUploadBox } from '../../../../components/AttachedFiles';
import MainLayout from '../../../../components/Layout';
import { invoice, settings, contact, bookingPlatform, salesAgent } from '../../../../lib/api';

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
  const [platforms, setPlatforms] = useState([]);
  const [agents, setAgents] = useState([]);
  const [currencySymbol, setCurrencySymbol] = useState('HK$');

  // Original invoice data
  const [invoiceData, setInvoiceData] = useState(null);
  const [attached, setAttached] = useState([]);
  const [uploads, setUploads] = useState([]);

  useEffect(() => {
    loadAllData();
  }, [invoiceId]);

  const loadAllData = async () => {
    try {
      const [invRes, payersRes, propsRes, catsRes, tagsRes, platformsRes, agentsRes] = await Promise.all([
        invoice.get(invoiceId),
        invoice.getInitializationPayer({}),
        invoice.getInitializationProperty({}),
        settings.getCategories(),
        contact.getAllTags().catch(() => ({ data: { data: [] } })),
        bookingPlatform.list().catch(() => ({ data: { data: [] } })),
        salesAgent.list().catch(() => ({ data: { data: [] } })),
      ]);

      const inv = invRes.data.code === 200 ? invRes.data.data : null;
      const payersData = payersRes.data.code === 200 ? (payersRes.data.data || []) : [];
      const propsData = propsRes.data.code === 200 ? (propsRes.data.data || []) : [];
      const catsData = catsRes.data.code === 200 ? (catsRes.data.data || []) : [];
      const tagsData = tagsRes.data?.data || [];
      const platformsData = platformsRes.data?.data || [];
      const agentsData = agentsRes.data?.data || [];

      setTenants(payersData);
      setProperties(propsData);
      setCategories(catsData);
      setTags(tagsData);
      setPlatforms(platformsData);
      setAgents(agentsData);

      if (!inv) {
        message.error('Invoice not found');
        router.push('/invoices');
        return;
      }

      setInvoiceData(inv);
      setAttached(inv.files || []);

      // Determine property_id
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

      // Set currency symbol
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
        booking_platform_id: inv.booking_platform_id || undefined,
        sales_agent_id: inv.sales_agent_id || undefined,
      });
    } catch (error) {
      console.error('Failed to load invoice data:', error);
      message.error('Failed to load invoice data');
    } finally {
      setInitialLoading(false);
    }
  };

  // Helper: reload leases based on current form state (any combination of tenant/property/unit)
  const reloadLeases = async (overrides = {}) => {
    const tenantId = overrides.tenantId !== undefined ? overrides.tenantId : form.getFieldValue('tenant_id');
    const propertyId = overrides.propertyId !== undefined ? overrides.propertyId : form.getFieldValue('property_id');
    const unitId = overrides.unitId !== undefined ? overrides.unitId : form.getFieldValue('unit_id');

    if (!tenantId && !propertyId && !unitId) {
      setLeases([]);
      return;
    }
    try {
      const p = {};
      if (tenantId) p.tenantId = tenantId;
      if (propertyId) p.propertyId = propertyId;
      if (unitId) p.unitId = unitId;
      const leasesRes = await invoice.getInitializationLeasing(p);
      if (leasesRes.data.code === 200) setLeases(leasesRes.data.data || []);
    } catch (e) { setLeases([]); }
  };

  // Cascading: Property -> Units + Leases
  const onPropertyChange = async (propertyId) => {
    form.setFieldsValue({ unit_id: undefined, leasing_id: undefined });
    setUnits([]);
    setLeases([]);
    if (!propertyId) return;
    try {
      const unitsRes = await invoice.getInitializationUnit({ propertyId });
      if (unitsRes.data.code === 200) setUnits(unitsRes.data.data || []);
    } catch (e) { /* ignore */ }

    await reloadLeases({ propertyId, unitId: undefined });
  };

  // Cascading: Contact -> Leases
  const onContactChange = async (tenantId) => {
    form.setFieldsValue({ leasing_id: undefined });
    setLeases([]);
    if (!tenantId) {
      await reloadLeases({ tenantId: undefined });
      return;
    }
    await reloadLeases({ tenantId });
  };

  // Cascading: Unit -> Leases
  const onUnitChange = async (unitId) => {
    form.setFieldsValue({ leasing_id: undefined });
    setLeases([]);
    await reloadLeases({ unitId });
  };

  // When a lease is picked, default booking_platform / sales_agent to the
  // lease's values — only if the user hasn't already set them.
  const onLeaseChange = (leaseId) => {
    if (!leaseId) return;
    const lease = leases.find(l => String(l.id) === String(leaseId));
    if (!lease) return;
    const current = form.getFieldsValue(['booking_platform_id', 'sales_agent_id']);
    const updates = {};
    if (!current.booking_platform_id && lease.booking_platform_id) {
      updates.booking_platform_id = lease.booking_platform_id;
    }
    if (!current.sales_agent_id && lease.sales_agent_id) {
      updates.sales_agent_id = lease.sales_agent_id;
    }
    if (Object.keys(updates).length) form.setFieldsValue(updates);
  };

  // Removing an already-attached file takes effect immediately, not on Save.
  const detachFile = async (fileId) => {
    try {
      await invoice.detachFile(invoiceId, fileId);
      setAttached(prev => prev.filter(f => f.id !== fileId));
      message.success('File removed');
    } catch (error) {
      message.error(error.response?.data?.message || 'Failed to remove file');
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
        booking_platform_id: values.booking_platform_id || null,
        sales_agent_id: values.sales_agent_id || null,
        file_ids: uploads.map(u => u.id),
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

  const labelStyle = { fontSize: 11, fontWeight: 700, letterSpacing: '0.5px', color: '#555', textTransform: 'uppercase', marginBottom: 4 };
  const reqStar = { color: '#d4880f', marginRight: 2 };
  const FLabel = ({ required, children }) => (
    <div style={labelStyle}>{required && <span style={reqStar}>*</span>}{children}</div>
  );

  if (initialLoading) {
    return (
      <MainLayout>
        <div style={{ textAlign: 'center', padding: 100 }}><Spin size="large" /></div>
      </MainLayout>
    );
  }

  return (
    <MainLayout>
      <div style={{ width: '100%' }}>
        <h2 style={{ marginBottom: 24, fontWeight: 600 }}>Edit Invoice</h2>

        <Form form={form} layout="vertical" onFinish={onFinish}>
          {/* Section 1: Entry Type + Contact + Property + Unit + Lease */}
          <div style={{ background: '#fafafa', padding: '20px 24px', borderRadius: 6, marginBottom: 16 }}>
            <Row gutter={[24, 16]}>
              <Col xs={24} sm={12} md={8}>
                <FLabel required>ENTRY TYPE</FLabel>
                <Form.Item name="type" noStyle rules={[{ required: true, message: 'Please input entry type' }]}>
                  <Select placeholder="Please input entry type" style={{ width: '100%' }}>
                    <Select.Option value={0}>Inflow (CR)</Select.Option>
                    <Select.Option value={1}>Outflow (DR)</Select.Option>
                  </Select>
                </Form.Item>
              </Col>
              <Col xs={24} sm={12} md={8}>
                <FLabel required>CONTACT</FLabel>
                <Form.Item name="tenant_id" noStyle rules={[{ required: true, message: 'Please input contact' }]}>
                  <Select
                    placeholder="Please input contact"
                    showSearch
                    optionFilterProp="children"
                    onChange={onContactChange}
                    allowClear
                    style={{ width: '100%' }}
                  >
                    {tenants.map(t => (
                      <Select.Option key={t.id} value={t.id}>
                        {Number(t.type) === 1 ? (t.company_name || 'Company') : [t.first_name, t.last_name].filter(Boolean).join(' ')}
                      </Select.Option>
                    ))}
                  </Select>
                </Form.Item>
              </Col>
            </Row>

            {/* Property + Unit + Lease */}
            <Row gutter={[24, 16]} style={{ marginTop: 20 }}>
              <Col xs={24} sm={12} md={8}>
                <FLabel required>PROPERTY</FLabel>
                <Form.Item name="property_id" noStyle rules={[{ required: true, message: 'Please input property' }]}>
                  <Select
                    placeholder="Please input property"
                    showSearch
                    optionFilterProp="children"
                    allowClear
                    onChange={onPropertyChange}
                    style={{ width: '100%' }}
                  >
                    {properties.map(p => (
                      <Select.Option key={p.id} value={p.id}>{p.display_name || p.street_address}</Select.Option>
                    ))}
                  </Select>
                </Form.Item>
              </Col>
              <Col xs={24} sm={12} md={8}>
                <FLabel>UNIT</FLabel>
                <Form.Item name="unit_id" noStyle>
                  <Select
                    placeholder="Please input unit"
                    showSearch
                    optionFilterProp="children"
                    allowClear
                    onChange={onUnitChange}
                    style={{ width: '100%' }}
                  >
                    {units.map(u => (
                      <Select.Option key={u.id} value={u.id}>{u.name}</Select.Option>
                    ))}
                  </Select>
                </Form.Item>
              </Col>
              <Col xs={24} sm={12} md={8}>
                <FLabel>LEASE</FLabel>
                <Form.Item name="leasing_id" noStyle>
                  <Select
                    placeholder="Please input lease"
                    showSearch
                    optionFilterProp="children"
                    allowClear
                    onChange={onLeaseChange}
                    style={{ width: '100%' }}
                  >
                    {leases.map(l => {
                      const tenantName = [l.tenant_first_name, l.tenant_last_name].filter(Boolean).join(' ');
                      const label = l.lease_no || `Lease #${String(l.id).slice(-4)}`;
                      const extra = [
                        l.unit_name,
                        tenantName,
                        l.start_date ? dayjs(l.start_date).format('YYYY-MM-DD') : null
                      ].filter(Boolean).join(' · ');
                      return (
                        <Select.Option key={l.id} value={l.id}>
                          {label}{extra ? ` (${extra})` : ''}
                        </Select.Option>
                      );
                    })}
                  </Select>
                </Form.Item>
              </Col>
            </Row>
          </div>

          <Divider style={{ margin: '8px 0 16px' }} />

          {/* Section 2: Due Date + Category + Amount + Property Owner Tag */}
          <div style={{ padding: '0 0 16px' }}>
            <Row gutter={[24, 16]}>
              <Col xs={24} sm={12} md={6}>
                <FLabel required>DUE DATE</FLabel>
                <Form.Item name="due_on" noStyle rules={[{ required: true, message: 'Please input due date' }]}>
                  <DatePicker style={{ width: '100%' }} placeholder="Please input due date" />
                </Form.Item>
              </Col>
              <Col xs={24} sm={12} md={6}>
                <FLabel required>CATEGORY</FLabel>
                <Form.Item name="category" noStyle rules={[{ required: true, message: 'Please input category' }]}>
                  <Select
                    placeholder="Please input category"
                    showSearch
                    optionFilterProp="children"
                    allowClear
                    style={{ width: '100%' }}
                  >
                    {categories.map(c => (
                      <Select.Option key={c.id} value={c.id}>{c.name}</Select.Option>
                    ))}
                  </Select>
                </Form.Item>
              </Col>
              <Col xs={24} sm={12} md={6}>
                <FLabel required>AMOUNT</FLabel>
                <Form.Item name="amount" noStyle rules={[{ required: true, message: 'Please input your amount' }]}>
                  <InputNumber
                    style={{ width: '100%' }}
                    min={0}
                    precision={2}
                    prefix={currencySymbol}
                    placeholder="Please input your amount"
                  />
                </Form.Item>
              </Col>
              <Col xs={24} sm={12} md={6}>
                <FLabel>PROPERTY OWNER TAG</FLabel>
                <Form.Item name="tag_id" noStyle>
                  <Select placeholder="Please select the tag" allowClear style={{ width: '100%' }}>
                    {tags.map(tg => (
                      <Select.Option key={tg.id} value={tg.id}>{tg.name}</Select.Option>
                    ))}
                  </Select>
                </Form.Item>
              </Col>
            </Row>

            {/* Booking platform + sales agent — defaults to lease values, override per invoice */}
            <Row gutter={[24, 16]} style={{ marginTop: 20 }}>
              <Col xs={24} sm={12} md={6}>
                <FLabel>BOOKING PLATFORM</FLabel>
                <Form.Item name="booking_platform_id" noStyle>
                  <Select
                    placeholder="None"
                    showSearch
                    optionFilterProp="children"
                    allowClear
                    style={{ width: '100%' }}
                  >
                    {platforms.map(p => (
                      <Select.Option key={p.id} value={p.id}>{p.name}</Select.Option>
                    ))}
                  </Select>
                </Form.Item>
              </Col>
              <Col xs={24} sm={12} md={6}>
                <FLabel>SALES AGENT</FLabel>
                <Form.Item name="sales_agent_id" noStyle>
                  <Select
                    placeholder="None"
                    showSearch
                    optionFilterProp="children"
                    allowClear
                    style={{ width: '100%' }}
                  >
                    {agents.map(a => (
                      <Select.Option key={a.id} value={a.id}>{a.name}</Select.Option>
                    ))}
                  </Select>
                </Form.Item>
              </Col>
            </Row>
          </div>

          {/* Section 3: Notes + Files */}
          <Row gutter={[24, 16]} style={{ marginTop: 8 }}>
            <Col xs={24} md={12}>
              <FLabel>NOTES</FLabel>
              <Form.Item name="note" noStyle>
                <Input.TextArea rows={5} placeholder="Please input your notes" />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <FLabel>FILES</FLabel>
              {attached.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <AttachedFileList files={attached} onDetach={detachFile} />
                </div>
              )}
              <FileUploadBox value={uploads} onChange={setUploads} />
            </Col>
          </Row>

          {/* Action Buttons */}
          <Row gutter={[24, 16]} style={{ marginTop: 32, marginBottom: 40 }}>
            <Col xs={24} sm={12}>
              <Button block size="large" onClick={() => router.push('/invoices')}>
                Cancel
              </Button>
            </Col>
            <Col xs={24} sm={12}>
              <Button type="primary" htmlType="submit" block size="large" loading={loading}>
                SUBMIT
              </Button>
            </Col>
          </Row>
        </Form>
      </div>
    </MainLayout>
  );
}
