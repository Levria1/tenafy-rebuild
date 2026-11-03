'use client';

import { Suspense, useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Form, Input, Button, Select, DatePicker, InputNumber, message, Row, Col, Spin, Divider } from 'antd';
import dayjs from 'dayjs';
import { FileUploadBox } from '../../../components/AttachedFiles';
import MainLayout from '../../../components/Layout';
import { invoice, settings, contact, bookingPlatform, salesAgent } from '../../../lib/api';

export default function InvoiceCreatePageWrapper() {
  return <Suspense fallback={<div />}><InvoiceCreatePage /></Suspense>;
}

function InvoiceCreatePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
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
  const [uploads, setUploads] = useState([]);

  // URL params for pre-fill
  const paramTenantId = searchParams.get('tenantId');
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
      const [payersRes, propsRes, catsRes, tagsRes, platformsRes, agentsRes] = await Promise.all([
        invoice.getInitializationPayer({}),
        invoice.getInitializationProperty({}),
        settings.getCategories(),
        contact.getAllTags().catch(() => ({ data: { data: [] } })),
        bookingPlatform.list().catch(() => ({ data: { data: [] } })),
        salesAgent.list().catch(() => ({ data: { data: [] } })),
      ]);

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

      // Pre-fill from URL params
      const initialValues = {};

      if (paramTenantId) {
        const matchTenant = payersData.find(t => String(t.id) === String(paramTenantId));
        if (matchTenant) initialValues.tenant_id = matchTenant.id;
      }
      if (paramPropertyId) {
        const matchProp = propsData.find(p => String(p.id) === String(paramPropertyId));
        if (matchProp) {
          initialValues.property_id = matchProp.id;
          try {
            const unitsRes = await invoice.getInitializationUnit({ propertyId: matchProp.id });
            if (unitsRes.data.code === 200) setUnits(unitsRes.data.data || []);
          } catch (e) { /* ignore */ }
        }
      }
      if (paramUnitId) {
        initialValues.unit_id = paramUnitId;
      }
      if (paramLeasingId) {
        initialValues.leasing_id = paramLeasingId;
      }

      if (isDepositRefund) {
        const depositCat = catsData.find(c =>
          c.name && c.name.toLowerCase().includes('deposit')
          && !c.name.toLowerCase().includes('expense')
          && !c.name.toLowerCase().includes('don')
        );
        if (depositCat) initialValues.category = depositCat.id;
        initialValues.type = 1; // Outflow (DR)
        initialValues.due_on = dayjs();
      }

      // Load leases if we have any filter (tenant, property, or unit)
      if (paramTenantId || paramPropertyId || paramUnitId) {
        try {
          const leaseParams = {};
          if (paramTenantId) leaseParams.tenantId = paramTenantId;
          if (paramPropertyId) leaseParams.propertyId = paramPropertyId;
          if (paramUnitId) leaseParams.unitId = paramUnitId;
          const leasesRes = await invoice.getInitializationLeasing(leaseParams);
          if (leasesRes.data.code === 200) setLeases(leasesRes.data.data || []);
        } catch (e) { /* ignore */ }
      }

      if (Object.keys(initialValues).length > 0) {
        form.setFieldsValue(initialValues);
      }
    } catch (error) {
      console.error('Failed to load data:', error);
      message.error('Failed to load data');
    } finally {
      setInitialLoading(false);
    }
  };

  // Helper: reload leases based on current form state (any combination of tenant/property/unit)
  const reloadLeases = async (overrides = {}) => {
    const tenantId = overrides.tenantId !== undefined ? overrides.tenantId : form.getFieldValue('tenant_id');
    const propertyId = overrides.propertyId !== undefined ? overrides.propertyId : form.getFieldValue('property_id');
    const unitId = overrides.unitId !== undefined ? overrides.unitId : form.getFieldValue('unit_id');

    // Need at least one filter to load leases
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

  // When a lease is picked, default the booking_platform / sales_agent fields
  // to the lease's values — but only if the user hasn't already set them.
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

  const onFinish = async (values) => {
    try {
      setLoading(true);
      const payload = {
        type: values.type ?? 0,
        tenant_id: values.tenant_id,
        property_id: values.property_id || null,
        unit_id: values.unit_id || null,
        leasing_id: values.leasing_id || null,
        category: values.category || null,
        amount: values.amount,
        due_date: values.due_on?.format('YYYY-MM-DD'),
        note: values.note || null,
        tag_id: values.tag_id || null,
        booking_platform_id: values.booking_platform_id || null,
        sales_agent_id: values.sales_agent_id || null,
        file_ids: uploads.map(u => u.id),
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
        <h2 style={{ marginBottom: 24, fontWeight: 600 }}>
          {isDepositRefund ? 'Create Deposit Refund' : 'Add Invoice'}
        </h2>

        <Form form={form} layout="vertical" onFinish={onFinish}>
          {/* Section 1: Entry Type + Contact + Property + Unit + Lease */}
          <div style={{ background: '#fafafa', padding: '20px 24px', borderRadius: 6, marginBottom: 16 }}>
            <Row gutter={[24, 16]}>
              <Col xs={24} sm={12} md={8}>
                <FLabel required>ENTRY TYPE</FLabel>
                <Form.Item name="type" noStyle rules={[{ required: true, message: 'Please input entry type' }]}>
                  <Select placeholder="Please input entry type" disabled={isDepositRefund} style={{ width: '100%' }}>
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
                    disabled={!!paramTenantId}
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
              <FileUploadBox value={uploads} onChange={setUploads} />
            </Col>
          </Row>

          {/* Action Buttons */}
          <Row gutter={[24, 16]} style={{ marginTop: 32, marginBottom: 40 }}>
            <Col xs={24} sm={12}>
              <Button
                block
                size="large"
                onClick={() => {
                  if (paramTenantId) {
                    router.push(`/contacts/tenant/${paramTenantId}/detail`);
                  } else {
                    router.push('/invoices');
                  }
                }}
              >
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
