'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Form, Input, DatePicker, Select, Button, message, Spin, Row, Col, Divider } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import MainLayout from '../../../../components/Layout';
import { leasing, property, tenant as tenantApi } from '../../../../lib/api';

const INVOICE_SCHEDULES = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'bi-weekly', label: 'Bi-Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'bi-annually', label: 'Bi-Annually' },
  { value: 'annually', label: 'Annually' },
];

const DUE_DAY_OPTIONS = Array.from({ length: 31 }, (_, i) => ({ value: i + 1, label: `${i + 1}` }));

const CONTRACT_TYPES = [
  { value: 0, label: 'Standard' },
  { value: 1, label: 'Commercial' },
  { value: 2, label: 'Residential' },
  { value: 3, label: 'Short Term' },
];

const LEASE_TYPES = [
  { value: 0, label: 'Fixed' },
  { value: 1, label: 'Month-to-Month' },
];

const labelStyle = { fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 };
const FLabel = ({ children, required }) => (
  <div style={{ ...labelStyle, marginBottom: 4 }}>
    {required && <span style={{ color: 'red' }}>* </span>}{children}
  </div>
);

export default function LeasingEditPage() {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [pageLoading, setPageLoading] = useState(true);
  const [properties, setProperties] = useState([]);
  const [allUnits, setAllUnits] = useState([]);
  const [filteredUnits, setFilteredUnits] = useState([]);
  const [tenants, setTenants] = useState([]);
  const [leaseData, setLeaseData] = useState(null);
  const router = useRouter();
  const params = useParams();
  const leaseId = params.id;

  useEffect(() => {
    loadAll();
  }, [leaseId]);

  const loadAll = async () => {
    try {
      const [propRes, tenantRes, leaseRes] = await Promise.all([
        leasing.getUnits({}),
        tenantApi.getAll(),
        leasing.get(leaseId),
      ]);

      let unitsList = [];
      let propsList = [];
      if (propRes.data.code === 200) {
        const rawUnits = propRes.data.data || [];
        // Backend returns flat unit list with property_name — group into properties
        const propMap = {};
        rawUnits.forEach(u => {
          const pid = String(u.property_id);
          if (!propMap[pid]) {
            propMap[pid] = { id: pid, display_name: u.property_name };
          }
        });
        propsList = Object.values(propMap);
        setProperties(propsList);
        unitsList = rawUnits.map(u => ({ ...u, property_id: String(u.property_id), property_name: u.property_name }));
        setAllUnits(unitsList);
      }
      if (tenantRes.data.code === 200) {
        setTenants(tenantRes.data.data || []);
      }
      if (leaseRes.data.code === 200) {
        const d = leaseRes.data.data;
        setLeaseData(d);

        // Find property_id from unit
        const unit = unitsList.find(u => String(u.id) === String(d.unit_id));
        const propertyId = unit?.property_id || null;

        // Filter units for this property
        if (propertyId) {
          setFilteredUnits(unitsList.filter(u => String(u.property_id) === String(propertyId)));
        }

        form.setFieldsValue({
          property_id: propertyId ? String(propertyId) : undefined,
          unit_id: d.unit_id ? String(d.unit_id) : undefined,
          tenant_id: d.tenant_id ? String(d.tenant_id) : undefined,
          additionalTenantIds: (d.additional_tenants || []).map(t => String(t.id)),
          start_date: d.start_date ? dayjs(d.start_date) : undefined,
          end_date: d.end_date ? dayjs(d.end_date) : undefined,
          type: d.type != null ? Number(d.type) : 0,
          contract_type: d.contract_type != null ? Number(d.contract_type) : 0,
          price: d.price || d.amount || '',
          deposit: d.deposit || '',
          due_date: d.due_date ? Number(d.due_date) : undefined,
          invoicing: d.invoicing || undefined,
          first_invoice_date: d.first_invoice_date ? dayjs(d.first_invoice_date) : undefined,
          credits: d.credits || '',
          note: d.note || '',
          contact_phone: d.contact_phone || '',
          unit_information: d.unit_information || '',
          status: d.status != null ? Number(d.status) : 1,
        });
      }
    } catch (error) {
      console.error('Failed to load data:', error);
      message.error('Failed to load lease data');
    } finally {
      setPageLoading(false);
    }
  };

  const onPropertyChange = (propertyId) => {
    const units = allUnits.filter(u => String(u.property_id) === String(propertyId));
    setFilteredUnits(units);
    form.setFieldsValue({ unit_id: undefined });
  };

  const stripCommas = (v) => parseFloat(String(v || '').replace(/,/g, '')) || 0;

  const onFinish = async (values) => {
    try {
      setLoading(true);
      const price = stripCommas(values.price);
      const payload = {
        unit_id: values.unit_id,
        tenant_id: values.tenant_id,
        additionalTenantIds: values.additionalTenantIds || [],
        start_date: values.start_date?.format('YYYY-MM-DD'),
        end_date: values.end_date?.format('YYYY-MM-DD') || null,
        type: values.type ?? 0,
        price: price,
        amount: price,
        deposit: stripCommas(values.deposit),
        due_date: values.due_date || null,
        invoicing: values.invoicing || null,
        first_invoice_date: values.first_invoice_date?.format('YYYY-MM-DD') || null,
        contract_type: values.contract_type ?? 0,
        unit_information: values.unit_information || null,
        note: values.note || null,
        credits: values.credits || null,
        contact_phone: values.contact_phone || null,
        status: values.status ?? 1,
      };
      const res = await leasing.update(leaseId, payload);
      if (res.data.code === 200) {
        message.success('Lease updated successfully');
        router.push('/leasing');
      } else {
        message.error(res.data.message || 'Failed to update lease');
      }
    } catch (error) {
      console.error('Update error:', error);
      message.error(error.response?.data?.message || 'Failed to update lease');
    } finally {
      setLoading(false);
    }
  };

  const sectionStyle = { border: '1px solid #e8e8e8', borderRadius: 4, padding: 20, marginBottom: 20 };
  const sectionTitle = { fontSize: 14, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 16, color: '#333' };

  if (pageLoading) {
    return <MainLayout><div style={{ padding: 48, textAlign: 'center' }}><Spin size="large" /></div></MainLayout>;
  }

  return (
    <MainLayout>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <Button icon={<ArrowLeftOutlined />} type="text" onClick={() => router.push('/leasing')} />
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>Edit Lease</h1>
        {leaseData?.lease_no && (
          <span style={{ color: '#888', fontSize: 14 }}>({leaseData.lease_no})</span>
        )}
      </div>

      <Form form={form} layout="vertical" onFinish={onFinish}>
        {/* Property & Tenant */}
        <div style={sectionStyle}>
          <div style={sectionTitle}>Property & Tenant</div>
          <Row gutter={16}>
            <Col span={12}>
              <FLabel required>Property</FLabel>
              <Form.Item name="property_id" noStyle rules={[{ required: true, message: 'Property is required' }]}>
                <Select
                  placeholder="Select property"
                  showSearch optionFilterProp="label"
                  onChange={onPropertyChange}
                  options={properties.map(p => ({ label: p.display_name || p.name, value: String(p.id) }))}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <FLabel required>Unit</FLabel>
              <Form.Item name="unit_id" noStyle rules={[{ required: true, message: 'Unit is required' }]}>
                <Select
                  placeholder="Select unit"
                  showSearch optionFilterProp="label"
                  options={filteredUnits.map(u => ({ label: u.name || u.unit_number, value: String(u.id) }))}
                />
              </Form.Item>
            </Col>
          </Row>
          <div style={{ height: 16 }} />
          <Row gutter={16}>
            <Col span={12}>
              <FLabel required>Tenant</FLabel>
              <Form.Item name="tenant_id" noStyle rules={[{ required: true, message: 'Tenant is required' }]}>
                <Select
                  placeholder="Select tenant"
                  showSearch optionFilterProp="label"
                  options={tenants.map(t => ({
                    label: Number(t.type) === 1 && t.company_name
                      ? t.company_name
                      : [t.first_name, t.last_name].filter(Boolean).join(' '),
                    value: String(t.id),
                  }))}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <FLabel>Additional Tenants</FLabel>
              <Form.Item name="additionalTenantIds" noStyle>
                <Select
                  mode="multiple" placeholder="Select additional tenants (optional)"
                  showSearch optionFilterProp="label" allowClear
                  options={tenants.map(t => ({
                    label: [t.first_name, t.last_name].filter(Boolean).join(' '),
                    value: String(t.id),
                  }))}
                />
              </Form.Item>
            </Col>
          </Row>
        </div>

        {/* Lease Details */}
        <div style={sectionStyle}>
          <div style={sectionTitle}>Lease Details</div>
          <Row gutter={16}>
            <Col span={6}>
              <FLabel required>Lease Type</FLabel>
              <Form.Item name="type" noStyle>
                <Select options={LEASE_TYPES} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <FLabel>Contract Type</FLabel>
              <Form.Item name="contract_type" noStyle>
                <Select options={CONTRACT_TYPES} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <FLabel required>Start Date</FLabel>
              <Form.Item name="start_date" noStyle rules={[{ required: true, message: 'Start date is required' }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <FLabel>End Date</FLabel>
              <Form.Item name="end_date" noStyle>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <div style={{ height: 16 }} />
          <Row gutter={16}>
            <Col span={6}>
              <FLabel required>Amount</FLabel>
              <Form.Item name="price" noStyle rules={[{ required: true, message: 'Amount is required' }]}>
                <Input placeholder="Please input amount" />
              </Form.Item>
            </Col>
            <Col span={6}>
              <FLabel>Invoice Schedule</FLabel>
              <Form.Item name="invoicing" noStyle>
                <Select placeholder="Select schedule" allowClear>
                  {INVOICE_SCHEDULES.map(s => (
                    <Select.Option key={s.value} value={s.value}>{s.label}</Select.Option>
                  ))}
                </Select>
              </Form.Item>
            </Col>
            <Col span={6}>
              <FLabel>Due Date (Day of Month)</FLabel>
              <Form.Item name="due_date" noStyle>
                <Select placeholder="Select due day" allowClear>
                  {DUE_DAY_OPTIONS.map(d => (
                    <Select.Option key={d.value} value={d.value}>{d.label}</Select.Option>
                  ))}
                </Select>
              </Form.Item>
            </Col>
            <Col span={6}>
              <FLabel>First Invoice Date</FLabel>
              <Form.Item name="first_invoice_date" noStyle>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
        </div>

        {/* Deposit & Status */}
        <div style={sectionStyle}>
          <div style={sectionTitle}>Deposit & Status</div>
          <Row gutter={16}>
            <Col span={8}>
              <FLabel>Deposit</FLabel>
              <Form.Item name="deposit" noStyle>
                <Input placeholder="Please input deposit" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <FLabel>Credits</FLabel>
              <Form.Item name="credits" noStyle>
                <Input placeholder="Credits" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <FLabel>Status</FLabel>
              <Form.Item name="status" noStyle>
                <Select options={[
                  { label: 'Active', value: 1 },
                  { label: 'Inactive', value: 0 },
                ]} />
              </Form.Item>
            </Col>
          </Row>
        </div>

        {/* Additional Info */}
        <div style={sectionStyle}>
          <div style={sectionTitle}>Additional Information</div>
          <Row gutter={16}>
            <Col span={12}>
              <FLabel>Contact Phone</FLabel>
              <Form.Item name="contact_phone" noStyle>
                <Input placeholder="Contact phone" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <FLabel>Unit Information</FLabel>
              <Form.Item name="unit_information" noStyle>
                <Input placeholder="Unit information" />
              </Form.Item>
            </Col>
          </Row>
          <div style={{ height: 16 }} />
          <FLabel>Notes</FLabel>
          <Form.Item name="note" noStyle>
            <Input.TextArea rows={3} placeholder="Notes" />
          </Form.Item>
        </div>

        {/* Footer */}
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 16, padding: '12px 0' }}>
          <Button onClick={() => router.push('/leasing')} style={{ width: '40%', height: 44 }}>
            Cancel
          </Button>
          <Button type="primary" htmlType="submit" loading={loading}
            style={{ width: '55%', height: 44, fontWeight: 600, textTransform: 'uppercase' }}>
            Update Lease
          </Button>
        </div>
      </Form>
    </MainLayout>
  );
}
