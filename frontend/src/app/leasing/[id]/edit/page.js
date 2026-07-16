'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Form, Input, InputNumber, DatePicker, Select, Button, message, Spin, Row, Col, Divider, Switch, Checkbox, Modal, Popconfirm } from 'antd';
import { ArrowLeftOutlined, PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import MainLayout from '../../../../components/Layout';
import SelectAllCheckbox from '../../../../components/SelectAllCheckbox';
import { leasing, property, tenant as tenantApi, bookingPlatform, salesAgent } from '../../../../lib/api';

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
  { value: 1, label: 'MR (May Renew)' },
  { value: 2, label: 'MTM (Month To Month)' },
  { value: 3, label: 'NR (Not Renewing)' },
  { value: 4, label: 'UC (Unconfirmed)' },
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
  const watchedContractType = Form.useWatch('contract_type', form);
  const [loading, setLoading] = useState(false);
  const [pageLoading, setPageLoading] = useState(true);
  const [properties, setProperties] = useState([]);
  const [allUnits, setAllUnits] = useState([]);
  const [filteredUnits, setFilteredUnits] = useState([]);
  const [tenants, setTenants] = useState([]);
  const [leaseData, setLeaseData] = useState(null);
  const [makeRecurring, setMakeRecurring] = useState(false);
  const [platforms, setPlatforms] = useState([]);
  const [agents, setAgents] = useState([]);
  // Scheduled rate changes
  const [revisions, setRevisions] = useState([]);
  const [revModalOpen, setRevModalOpen] = useState(false);
  const [revEditing, setRevEditing] = useState(null); // null = new, object = editing
  const [revForm] = Form.useForm();
  const router = useRouter();
  const params = useParams();
  const leaseId = params.id;

  useEffect(() => {
    loadAll();
    loadRevisions();
  }, [leaseId]);

  const loadRevisions = async () => {
    try {
      const res = await leasing.listRevisions(leaseId);
      if (res.data.code === 200) setRevisions(res.data.data || []);
    } catch (err) {
      // lease_revision table may not exist yet — fail silently
    }
  };

  const openRevModal = (rev) => {
    setRevEditing(rev);
    if (rev) {
      const eff = rev.effective_from instanceof Date
        ? rev.effective_from.toISOString().split('T')[0]
        : String(rev.effective_from).split('T')[0];
      revForm.setFieldsValue({
        effective_from: eff ? dayjs(eff) : null,
        price: rev.price != null ? rev.price : undefined,
        credits: rev.credits || undefined,
        utility_credit: rev.utility_credit != null ? rev.utility_credit : undefined,
        deposit: rev.deposit != null ? rev.deposit : undefined,
        note: rev.note || undefined,
      });
    } else {
      revForm.resetFields();
    }
    setRevModalOpen(true);
  };

  const saveRevision = async () => {
    try {
      const vals = await revForm.validateFields();
      const payload = {
        effective_from: vals.effective_from ? vals.effective_from.format('YYYY-MM-DD') : null,
        price: vals.price ?? null,
        credits: vals.credits || null,
        utility_credit: vals.utility_credit ?? null,
        deposit: vals.deposit ?? null,
        note: vals.note || null,
      };
      if (!payload.effective_from) {
        message.error('Effective date is required');
        return;
      }
      if (payload.price == null && payload.credits == null && payload.utility_credit == null && payload.deposit == null) {
        message.error('Set at least one of: rent, credits, utility credit, deposit');
        return;
      }
      const res = revEditing
        ? await leasing.updateRevision(leaseId, revEditing.id, payload)
        : await leasing.createRevision(leaseId, payload);
      if (res.data.code === 200) {
        message.success(revEditing ? 'Scheduled change updated' : 'Rate change scheduled');
        setRevModalOpen(false);
        loadRevisions();
      } else {
        message.error(res.data.message || 'Failed to save');
      }
    } catch (err) {
      if (err?.errorFields) return; // form validation error
      message.error(err.response?.data?.message || 'Failed to save scheduled change');
    }
  };

  const cancelRevision = async (rev) => {
    try {
      const res = await leasing.deleteRevision(leaseId, rev.id);
      if (res.data.code === 200) {
        message.success('Scheduled change cancelled');
        loadRevisions();
      } else {
        message.error(res.data.message || 'Failed to cancel');
      }
    } catch (err) {
      message.error(err.response?.data?.message || 'Failed to cancel scheduled change');
    }
  };

  const loadAll = async () => {
    try {
      const [propRes, tenantRes, leaseRes, platformsRes, agentsRes] = await Promise.all([
        leasing.getUnits({}),
        tenantApi.getAll(),
        leasing.get(leaseId),
        bookingPlatform.list(),
        salesAgent.list(),
      ]);
      setPlatforms(platformsRes.data.data || []);
      setAgents(agentsRes.data.data || []);

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

        // Initialize recurring toggle from existing data
        setMakeRecurring(!!d.invoicing);

        form.setFieldsValue({
          property_id: propertyId ? String(propertyId) : undefined,
          unit_id: d.unit_id ? String(d.unit_id) : undefined,
          tenant_id: d.tenant_id ? String(d.tenant_id) : undefined,
          additionalTenantIds: (d.additional_tenants || []).map(t => String(t.id)),
          start_date: d.start_date ? dayjs(d.start_date) : undefined,
          end_date: d.end_date ? dayjs(d.end_date) : undefined,
          type: d.type != null ? Number(d.type) : 0,
          contract_type: d.contract_type ? Number(d.contract_type) : undefined,
          viewing_enabled: !!Number(d.viewing_enabled),
          notice_period_days: d.notice_period_days != null ? Number(d.notice_period_days) : undefined,
          price: d.price || d.amount || '',
          deposit: d.deposit || '',
          due_date: d.due_date ? Number(d.due_date) : undefined,
          invoicing: d.invoicing || undefined,
          first_invoice_date: d.first_invoice_date ? dayjs(d.first_invoice_date) : undefined,
          credits: d.credits || '',
          utility_credit: d.utility_credit != null ? Number(d.utility_credit) : undefined,
          check_in_meter: d.check_in_meter != null ? Number(d.check_in_meter) : undefined,
          check_out_meter: d.check_out_meter != null ? Number(d.check_out_meter) : undefined,
          note: d.note || '',
          contact_phone: d.contact_phone || '',
          unit_information: d.unit_information || '',
          status: d.status != null ? Number(d.status) : 1,
          booking_platform_id: d.booking_platform_id ? String(d.booking_platform_id) : undefined,
          sales_agent_id: d.sales_agent_id ? String(d.sales_agent_id) : undefined,
          payment_receipt: !!d.payment_receipt,
          // Email notifications
          tenant_posted: !!d.tenant_posted,
          landlord_posted: !!d.landlord_posted,
          tenant_due: !!d.tenant_due,
          landlord_due: !!d.landlord_due,
          tenant_overdue: !!d.tenant_overdue,
          landlord_overdue: !!d.landlord_overdue,
          tenant_deposit_posted: !!d.tenant_deposit_posted,
          tenant_checkin: !!d.tenant_checkin,
          tenant_checkout: !!d.tenant_checkout,
          landlord_expired: !!d.landlord_expired,
          landlord_expired_days: d.landlord_expired_days != null ? Number(d.landlord_expired_days) : 30,
          tenant_renewal: !!d.tenant_renewal,
          tenant_renewal_days: d.tenant_renewal_days != null ? Number(d.tenant_renewal_days) : 30,
          // Access & sharing
          access_setting: d.access_setting != null ? Number(d.access_setting) : undefined,
          share_lease: !!d.share_lease,
          all_past: !!d.all_past,
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
    // Validate recurring fields for month-to-month
    if (makeRecurring && values.type === 1) {
      if (!values.invoicing || !values.due_date) {
        message.error('Please fill in all required fields');
        return;
      }
    }
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
        due_date: makeRecurring ? (values.due_date || null) : null,
        invoicing: makeRecurring ? (values.invoicing || null) : null,
        first_invoice_date: makeRecurring ? (values.first_invoice_date?.format('YYYY-MM-DD') || null) : null,
        contract_type: values.contract_type ?? 0,
        // Only meaningful when Tenant Status = NR; harmless otherwise.
        viewing_enabled: (values.contract_type === 3 && values.viewing_enabled) ? 1 : 0,
        notice_period_days: (values.notice_period_days != null && values.notice_period_days !== '')
          ? Number(values.notice_period_days) : null,
        unit_information: values.unit_information || null,
        note: values.note || null,
        credits: values.credits || null,
        utility_credit: values.utility_credit ?? null,
        check_in_meter: values.check_in_meter ?? null,
        check_out_meter: values.check_out_meter ?? null,
        contact_phone: values.contact_phone || null,
        status: values.status ?? 1,
        mark_past_paid: values.mark_past_paid || false,
        payment_receipt: values.payment_receipt || false,
        booking_platform_id: values.booking_platform_id || null,
        sales_agent_id: values.sales_agent_id || null,
        // Email notifications
        tenant_posted: !!values.tenant_posted,
        landlord_posted: !!values.landlord_posted,
        tenant_due: !!values.tenant_due,
        landlord_due: !!values.landlord_due,
        tenant_overdue: !!values.tenant_overdue,
        landlord_overdue: !!values.landlord_overdue,
        tenant_deposit_posted: !!values.tenant_deposit_posted,
        tenant_checkin: !!values.tenant_checkin,
        tenant_checkout: !!values.tenant_checkout,
        landlord_expired: !!values.landlord_expired,
        landlord_expired_days: values.landlord_expired_days || 0,
        tenant_renewal: !!values.tenant_renewal,
        tenant_renewal_days: values.tenant_renewal_days || 0,
        // Access & sharing
        access_setting: values.access_setting ?? null,
        share_lease: !!values.share_lease,
        all_past: !!values.all_past,
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
          </Row>
          <div style={{ height: 16 }} />
          <Row gutter={16}>
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
          <div style={{ height: 16 }} />
          <Row gutter={16}>
            <Col span={6}>
              <FLabel required>Tenant Status</FLabel>
              <Form.Item
                name="contract_type"
                noStyle
                rules={[{ required: true, message: 'Please select tenant status' }]}
              >
                <Select options={CONTRACT_TYPES} placeholder="Select status" />
              </Form.Item>
            </Col>
            {watchedContractType === 3 && (
              <Col span={12} style={{ display: 'flex', alignItems: 'flex-end' }}>
                <Form.Item name="viewing_enabled" valuePropName="checked" noStyle>
                  <Checkbox>
                    Request viewings — notify the tenant to share their availability and open this unit for viewing requests
                  </Checkbox>
                </Form.Item>
              </Col>
            )}
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
          <Row gutter={16} style={{ marginTop: 16 }}>
            <Col span={6}>
              <FLabel>Notice Period (Days)</FLabel>
              <Form.Item name="notice_period_days" noStyle>
                <InputNumber style={{ width: '100%' }} min={0} precision={0} placeholder="e.g. 60" />
              </Form.Item>
              <div style={{ fontSize: 11, color: '#999', marginTop: 4 }}>
                Notice the tenant must give to renew.
              </div>
            </Col>
          </Row>
        </div>

        {/* Recurring Invoice */}
        <div style={sectionStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
            <div style={sectionTitle}>Recurring Invoice</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
              <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.5px', color: '#555', textTransform: 'uppercase' }}>
                MAKE RECURRING
              </span>
              <Switch checked={makeRecurring} onChange={setMakeRecurring} size="small" />
            </div>
          </div>
          <Row gutter={16}>
            <Col span={6}>
              <FLabel required>Amount</FLabel>
              <Form.Item name="price" noStyle rules={[{ required: true, message: 'Amount is required' }]}>
                <Input placeholder="Please input amount" />
              </Form.Item>
            </Col>
            {makeRecurring && (
              <>
                <Col span={6}>
                  <FLabel required>First Invoice Date</FLabel>
                  <Form.Item name="first_invoice_date" noStyle>
                    <DatePicker style={{ width: '100%' }} placeholder="First Invoice Date" />
                  </Form.Item>
                </Col>
                <Col span={6}>
                  <FLabel required>Invoice Schedule</FLabel>
                  <Form.Item name="invoicing" noStyle rules={[{ required: true, message: 'Select invoice schedule' }]}>
                    <Select placeholder="Select schedule">
                      {INVOICE_SCHEDULES.map(s => (
                        <Select.Option key={s.value} value={s.value}>{s.label}</Select.Option>
                      ))}
                    </Select>
                  </Form.Item>
                </Col>
                <Col span={6}>
                  <FLabel required>Due Date (Day of Month)</FLabel>
                  <Form.Item name="due_date" noStyle rules={[{ required: true, message: 'Select due date' }]}>
                    <Select placeholder="Select due day">
                      {DUE_DAY_OPTIONS.map(d => (
                        <Select.Option key={d.value} value={d.value}>{d.label}</Select.Option>
                      ))}
                    </Select>
                  </Form.Item>
                </Col>
              </>
            )}
          </Row>
          <div style={{ marginTop: 16 }}>
            <Form.Item name="payment_receipt" valuePropName="checked" noStyle>
              <Checkbox>Email tenant payment receipt</Checkbox>
            </Form.Item>
          </div>
          <div style={{ marginTop: 8 }}>
            <Form.Item name="mark_past_paid" valuePropName="checked" noStyle>
              <Checkbox>Automatically mark all past invoices as paid</Checkbox>
            </Form.Item>
            <div style={{ color: '#d4380d', fontSize: 12, marginTop: 8 }}>
              * If you are updating a lease and want the system to mark all previous transactions as paid, check here and all past invoices will be marked as paid on their due days.
            </div>
          </div>
        </div>

        {/* Utility */}
        <div style={sectionStyle}>
          <div style={sectionTitle}>UTILITY</div>
          <div>
            <FLabel>MONTHLY UTILITY CREDIT</FLabel>
            <Form.Item name="utility_credit" noStyle>
              <InputNumber style={{ width: '100%', maxWidth: 500 }} min={0} precision={2} placeholder="0.00" />
            </Form.Item>
          </div>
          <Row gutter={16} style={{ marginTop: 12 }}>
            <Col span={12}>
              <FLabel>CHECK IN METER</FLabel>
              <Form.Item name="check_in_meter" noStyle>
                <InputNumber placeholder="0.00" min={0} precision={2} style={{ maxWidth: 500, width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <FLabel>CHECK OUT METER</FLabel>
              <Form.Item name="check_out_meter" noStyle>
                <InputNumber placeholder="0.00" min={0} precision={2} style={{ maxWidth: 500, width: '100%' }} />
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
          </Row>
          <Row gutter={16} style={{ marginTop: 12 }}>
            <Col span={8}>
              <FLabel>Status</FLabel>
              <Form.Item name="status" noStyle>
                <Select options={[
                  { label: 'Active', value: 1 },
                  { label: 'Inactive (Terminated)', value: 0 },
                ]} />
              </Form.Item>
              <div style={{ fontSize: 12, color: '#999', marginTop: 4 }}>Set to Inactive to terminate early. Active/Upcoming is determined by dates.</div>
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

        {/* Scheduled Rate Changes */}
        <div style={sectionStyle}>
          <div style={sectionTitle}>Scheduled Rate Changes</div>
          <div style={{ fontSize: 12, color: '#888', marginBottom: 12 }}>
            Schedule future changes to rent, utility credit, credits, or deposit. The invoice scheduler will automatically pick up the new values on each effective date.
          </div>
          {revisions.length === 0 ? (
            <div style={{ fontSize: 13, color: '#999', fontStyle: 'italic', marginBottom: 12 }}>No scheduled changes.</div>
          ) : (
            (() => {
              const today = new Date().toISOString().split('T')[0];
              const fmtNum = (n) => n == null ? '—' : `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
              const fmtDate = (d) => d ? (d instanceof Date ? d.toISOString().split('T')[0] : String(d).split('T')[0]) : '';
              return revisions.map(r => {
                const eff = fmtDate(r.effective_from);
                const isPast = eff <= today;
                const days = Math.round((new Date(eff) - new Date(today)) / 86400000);
                return (
                  <div key={r.id} style={{
                    padding: '10px 12px', marginBottom: 8,
                    background: isPast ? '#fafafa' : '#fffbe6',
                    border: `1px solid ${isPast ? '#f0f0f0' : '#ffe58f'}`,
                    borderRadius: 4,
                    display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12,
                  }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>
                        {isPast ? `Past — effective ${eff} (already applied)` : `⏰ Effective ${eff} (${days} day${days !== 1 ? 's' : ''} away)`}
                      </div>
                      <div style={{ marginTop: 4, fontSize: 13, color: '#555' }}>
                        {r.price != null && <span style={{ marginRight: 16 }}>Rent: <strong>{fmtNum(r.price)}</strong></span>}
                        {r.utility_credit != null && <span style={{ marginRight: 16 }}>Utility credit: <strong>{fmtNum(r.utility_credit)}</strong></span>}
                        {r.credits && <span style={{ marginRight: 16 }}>Credits: <strong>{r.credits}</strong></span>}
                        {r.deposit != null && <span style={{ marginRight: 16 }}>Deposit: <strong>{fmtNum(r.deposit)}</strong></span>}
                      </div>
                      {r.note && <div style={{ marginTop: 4, fontSize: 12, fontStyle: 'italic', color: '#888' }}>{r.note}</div>}
                    </div>
                    {!isPast && (
                      <div style={{ display: 'flex', gap: 4 }}>
                        <Button size="small" icon={<EditOutlined />} onClick={() => openRevModal(r)}>Edit</Button>
                        <Popconfirm
                          title="Cancel this scheduled change?"
                          okText="Yes" cancelText="No"
                          onConfirm={() => cancelRevision(r)}
                        >
                          <Button size="small" danger icon={<DeleteOutlined />}>Cancel</Button>
                        </Popconfirm>
                      </div>
                    )}
                  </div>
                );
              });
            })()
          )}
          <Button type="dashed" icon={<PlusOutlined />} onClick={() => openRevModal(null)} block>
            Schedule new rate change
          </Button>
        </div>

        {/* Booking & Commission */}
        <div style={sectionStyle}>
          <div style={sectionTitle}>Booking & Commission</div>
          <Row gutter={16}>
            <Col span={12}>
              <FLabel>Booking Platform</FLabel>
              <Form.Item name="booking_platform_id" noStyle>
                <Select placeholder="Select platform" allowClear showSearch optionFilterProp="children" style={{ width: '100%' }}>
                  {platforms.map(p => (
                    <Select.Option key={p.id} value={String(p.id)}>{p.name}</Select.Option>
                  ))}
                </Select>
              </Form.Item>
            </Col>
            <Col span={12}>
              <FLabel>Sales Agent</FLabel>
              <Form.Item name="sales_agent_id" noStyle>
                <Select placeholder="Select agent" allowClear showSearch optionFilterProp="children" style={{ width: '100%' }}>
                  {agents.map(a => (
                    <Select.Option key={a.id} value={String(a.id)}>{a.name}</Select.Option>
                  ))}
                </Select>
              </Form.Item>
            </Col>
          </Row>
        </div>

        {/* Email Notifications */}
        <div style={sectionStyle}>
          <div style={{ ...sectionTitle, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>Email Notifications</span>
            <SelectAllCheckbox form={form} fields={['tenant_posted', 'landlord_posted', 'tenant_due', 'landlord_due', 'tenant_overdue', 'landlord_overdue', 'tenant_deposit_posted', 'tenant_checkin', 'tenant_checkout']} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 24px' }}>
            <Form.Item name="tenant_posted" valuePropName="checked" style={{ marginBottom: 0 }}>
              <Checkbox>Email tenant when invoice is posted</Checkbox>
            </Form.Item>
            <Form.Item name="landlord_posted" valuePropName="checked" style={{ marginBottom: 0 }}>
              <Checkbox>Email landlord when invoice is posted</Checkbox>
            </Form.Item>
            <Form.Item name="tenant_due" valuePropName="checked" style={{ marginBottom: 0 }}>
              <Checkbox>Email tenant when invoice is due</Checkbox>
            </Form.Item>
            <Form.Item name="landlord_due" valuePropName="checked" style={{ marginBottom: 0 }}>
              <Checkbox>Email landlord when invoice is due</Checkbox>
            </Form.Item>
            <Form.Item name="tenant_overdue" valuePropName="checked" style={{ marginBottom: 0 }}>
              <Checkbox>Email tenant when invoice is overdue</Checkbox>
            </Form.Item>
            <Form.Item name="landlord_overdue" valuePropName="checked" style={{ marginBottom: 0 }}>
              <Checkbox>Email landlord when invoice is overdue</Checkbox>
            </Form.Item>
            <Form.Item name="tenant_deposit_posted" valuePropName="checked" style={{ marginBottom: 0 }}>
              <Checkbox>Email tenant when deposit is posted</Checkbox>
            </Form.Item>
            <Form.Item name="tenant_checkin" valuePropName="checked" style={{ marginBottom: 0 }}>
              <Checkbox>Email tenant on check-in</Checkbox>
            </Form.Item>
            <Form.Item name="tenant_checkout" valuePropName="checked" style={{ marginBottom: 0 }}>
              <Checkbox>Email tenant on check-out</Checkbox>
            </Form.Item>
          </div>

          <Divider style={{ margin: '16px 0' }} />

          <Row gutter={16}>
            <Col span={12}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <Form.Item name="landlord_expired" valuePropName="checked" style={{ marginBottom: 0 }}>
                  <Checkbox>Notify landlord before lease expires</Checkbox>
                </Form.Item>
                <Form.Item name="landlord_expired_days" style={{ marginBottom: 0, width: 80 }}>
                  <InputNumber min={0} placeholder="Days" size="small" />
                </Form.Item>
                <span style={{ color: '#999', fontSize: 12 }}>days before</span>
              </div>
            </Col>
            <Col span={12}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <Form.Item name="tenant_renewal" valuePropName="checked" style={{ marginBottom: 0 }}>
                  <Checkbox>Notify tenant for renewal</Checkbox>
                </Form.Item>
                <Form.Item name="tenant_renewal_days" style={{ marginBottom: 0, width: 80 }}>
                  <InputNumber min={0} placeholder="Days" size="small" />
                </Form.Item>
                <span style={{ color: '#999', fontSize: 12 }}>days before</span>
              </div>
            </Col>
          </Row>
        </div>

        {/* Access & Sharing */}
        <div style={sectionStyle}>
          <div style={{ ...sectionTitle, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>Access & Sharing</span>
            <SelectAllCheckbox form={form} fields={['share_lease', 'all_past']} />
          </div>
          <Row gutter={16}>
            <Col span={12}>
              <FLabel>Access Setting</FLabel>
              <Form.Item name="access_setting" noStyle>
                <Select placeholder="Select access level" allowClear>
                  <Select.Option value={0}>Private</Select.Option>
                  <Select.Option value={1}>Shared</Select.Option>
                  <Select.Option value={2}>Public</Select.Option>
                </Select>
              </Form.Item>
            </Col>
            <Col span={12}>
              <div style={{ marginTop: 24 }}>
                <Form.Item name="share_lease" valuePropName="checked" style={{ marginBottom: 0 }}>
                  <Checkbox>Share lease with tenant</Checkbox>
                </Form.Item>
              </div>
            </Col>
          </Row>
          <div style={{ marginTop: 12 }}>
            <Form.Item name="all_past" valuePropName="checked" style={{ marginBottom: 0 }}>
              <Checkbox>Include all past invoices</Checkbox>
            </Form.Item>
          </div>
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

      {/* Schedule Rate Change Modal */}
      <Modal
        title={revEditing ? 'Edit Scheduled Rate Change' : 'Schedule Rate Change'}
        open={revModalOpen}
        onCancel={() => setRevModalOpen(false)}
        onOk={saveRevision}
        okText={revEditing ? 'Save Changes' : 'Schedule'}
        destroyOnClose
      >
        <Form form={revForm} layout="vertical" preserve={false}>
          <Form.Item
            name="effective_from"
            label="Effective From"
            rules={[{ required: true, message: 'Effective date is required' }]}
          >
            <DatePicker style={{ width: '100%' }} disabledDate={(d) => d && d.isBefore(dayjs().startOf('day'))} />
          </Form.Item>
          <div style={{ fontSize: 12, color: '#888', marginBottom: 12 }}>
            Leave any field blank to keep the current value. Provide at least one change.
          </div>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="price" label="New Rent">
                <InputNumber style={{ width: '100%' }} placeholder="e.g. 18000" min={0} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="utility_credit" label="New Utility Credit">
                <InputNumber style={{ width: '100%' }} placeholder="e.g. 500" min={0} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="credits" label="New Credits">
                <Input placeholder="Credits" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="deposit" label="New Deposit">
                <InputNumber style={{ width: '100%' }} placeholder="e.g. 36000" min={0} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="note" label="Note (optional)">
            <Input.TextArea rows={2} placeholder="e.g. Per annual review email of 2026-04-15" />
          </Form.Item>
        </Form>
      </Modal>
    </MainLayout>
  );
}
