'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  Card, Form, Input, Button, Select, DatePicker, InputNumber, message, Modal,
  Row, Col, Steps, Switch, Upload, Divider, Alert, Spin, Checkbox, Space
} from 'antd';
import {
  ArrowLeftOutlined, UploadOutlined, WarningOutlined, CheckCircleOutlined
} from '@ant-design/icons';
import dayjs from 'dayjs';
import MainLayout from '../../../components/Layout';
import { leasing, property, tenant, emailTemplate, file as fileApi, settings, bookingPlatform, salesAgent } from '../../../lib/api';

const { TextArea } = Input;

const INVOICE_SCHEDULES = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'bi-weekly', label: 'Bi-Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'bi-annually', label: 'Bi-Annually' },
  { value: 'annually', label: 'Annually' },
];

const DUE_DAY_OPTIONS = Array.from({ length: 31 }, (_, i) => ({ value: i + 1, label: `${i + 1}` }));

export default function LeaseCreatePage() {
  const router = useRouter();
  const [form] = Form.useForm();
  const [currentStep, setCurrentStep] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingData, setLoadingData] = useState(true);

  // Data
  const [properties, setProperties] = useState([]);
  const [allUnits, setAllUnits] = useState([]);
  const [filteredUnits, setFilteredUnits] = useState([]);
  const [tenants, setTenants] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [platforms, setPlatforms] = useState([]);
  const [agents, setAgents] = useState([]);

  // Conflict
  const [conflictChecking, setConflictChecking] = useState(false);
  const [conflictResult, setConflictResult] = useState(null);

  // File upload
  const [fileList, setFileList] = useState([]);

  // Selected tenant info (for pre-filling email fields)
  const [selectedTenant, setSelectedTenant] = useState(null);

  // Recurring invoice toggle
  const [makeRecurring, setMakeRecurring] = useState(true);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const [propsRes, tenantsRes, templatesRes, platformsRes, agentsRes] = await Promise.all([
        property.getAllWithUnits(),
        leasing.getTenants(),
        emailTemplate.getAll({ type: 'lease' }),
        bookingPlatform.list(),
        salesAgent.list(),
      ]);
      setProperties(propsRes.data.data || []);
      setTenants(tenantsRes.data.data || []);
      setTemplates(templatesRes.data.data || []);
      setPlatforms(platformsRes.data.data || []);
      setAgents(agentsRes.data.data || []);

      // Build flat units list from properties with units
      const props = propsRes.data.data || [];
      const units = [];
      props.forEach(p => {
        if (p.units) {
          p.units.forEach(u => units.push({ ...u, property_id: p.id, property_name: p.display_name }));
        }
      });
      setAllUnits(units);
    } catch (error) {
      console.error('Failed to load data:', error);
      // Fallback: try loading units separately
      try {
        const [propsRes, tenantsRes, templatesRes] = await Promise.all([
          property.getAll(),
          leasing.getTenants(),
          emailTemplate.getAll({ type: 'lease' }),
        ]);
        setProperties(propsRes.data.data || []);
        setTenants(tenantsRes.data.data || []);
        setTemplates(templatesRes.data.data || []);
      } catch (e2) {
        message.error('Failed to load data');
      }
    } finally {
      setLoadingData(false);
    }
  };

  const handlePropertyChange = async (propertyId) => {
    form.setFieldsValue({ unit_id: undefined });
    setConflictResult(null);

    if (propertyId) {
      // Filter units by property
      const units = allUnits.filter(u => u.property_id === propertyId);
      if (units.length > 0) {
        setFilteredUnits(units);
      } else {
        // Fallback: load units from API
        try {
          const res = await property.getUnits(propertyId);
          setFilteredUnits(res.data.data || []);
        } catch {
          setFilteredUnits([]);
        }
      }
    } else {
      setFilteredUnits([]);
    }
  };

  const checkConflict = useCallback(async () => {
    const unitId = form.getFieldValue('unit_id');
    const startDate = form.getFieldValue('start_date');
    const endDate = form.getFieldValue('end_date');

    if (!unitId || !startDate) {
      setConflictResult(null);
      return;
    }

    try {
      setConflictChecking(true);
      const res = await leasing.checkConflict({
        unit_id: unitId,
        start_date: startDate.format('YYYY-MM-DD'),
        end_date: endDate ? endDate.format('YYYY-MM-DD') : null,
      });
      if (res.data.code === 200) {
        setConflictResult(res.data.data);
      }
    } catch {
      // ignore
    } finally {
      setConflictChecking(false);
    }
  }, [form]);

  const handleUnitChange = () => {
    setConflictResult(null);
    checkConflict();
  };

  const handleDateChange = () => {
    checkConflict();
  };

  const handleTenantChange = (tenantId) => {
    const t = tenants.find(x => x.id === tenantId);
    setSelectedTenant(t || null);
    if (t) {
      form.setFieldsValue({
        contact_phone: t.phone || '',
        email_to: t.email || '',
      });
    }
  };

  const handleFileUpload = async (info) => {
    const { file: f, onSuccess, onError } = info;
    try {
      const formData = new FormData();
      formData.append('file', f);
      const res = await fileApi.upload(formData);
      if (res.data.code === 200) {
        const uploaded = res.data.data;
        setFileList(prev => [...prev, { uid: f.uid, name: f.name, status: 'done', fileId: uploaded.id || uploaded.fileId }]);
        onSuccess(uploaded);
      } else {
        onError(new Error('Upload failed'));
      }
    } catch (e) {
      onError(e);
    }
  };

  const nextStep = async () => {
    try {
      if (currentStep === 0) {
        const step1Fields = ['property_id', 'unit_id', 'start_date', 'tenant_id', 'type', 'price'];
        const leaseType = form.getFieldValue('type');
        if (makeRecurring && leaseType === 1) {
          step1Fields.push('invoicing', 'due_date');
        }
        await form.validateFields(step1Fields);
        // Block if end date is before start date
        const startVal = form.getFieldValue('start_date');
        const endVal = form.getFieldValue('end_date');
        if (startVal && endVal && endVal.isBefore(startVal, 'day')) {
          message.error('End date cannot be before start date');
          return;
        }
        // Block if conflict
        if (conflictResult && conflictResult.conflict) {
          message.error('Please resolve the lease conflict before proceeding.');
          return;
        }
      }
      setCurrentStep(prev => prev + 1);
    } catch (err) {
      if (err?.errorFields?.length) {
        message.error('Please fill in all required fields');
      }
    }
  };

  const prevStep = () => {
    setCurrentStep(prev => prev - 1);
  };

  const buildPayload = () => {
    const values = form.getFieldsValue(true);
    const stripCommas = (v) => parseFloat(String(v || '').replace(/,/g, '')) || 0;
    const price = stripCommas(values.price);
    return {
      unit_id: values.unit_id,
      tenant_id: values.tenant_id,
      additionalTenantIds: values.additionalTenantIds || [],
      start_date: values.start_date?.format('YYYY-MM-DD'),
      end_date: values.end_date?.format('YYYY-MM-DD') || null,
      type: values.type ?? 0,
      price: price,
      deposit: stripCommas(values.deposit),
      due_date: makeRecurring ? (values.due_date || null) : null,
      invoicing: makeRecurring ? (values.invoicing || null) : null,
      amount: price,
      first_invoice_date: makeRecurring ? (values.first_invoice_date?.format('YYYY-MM-DD') || null) : null,
      share_lease: makeRecurring ? 1 : 0,
      contract_type: values.contract_type ?? 0,
      unit_information: values.unit_information || null,
      note: values.note || null,
      credits: values.credits || null,
      utility_credit: values.utility_credit ?? null,
      check_in_meter: values.check_in_meter ?? null,
      check_out_meter: values.check_out_meter ?? null,
      contact_phone: values.contact_phone || null,
      // notifications
      tenant_posted: values.tenant_posted || false,
      landlord_posted: values.landlord_posted || false,
      landlord_due: values.landlord_due || false,
      tenant_due: values.tenant_due || false,
      landlord_overdue: values.landlord_overdue || false,
      tenant_overdue: values.tenant_overdue || false,
      landlord_expired: values.landlord_expired || false,
      landlord_expired_days: values.landlord_expired_days || 0,
      tenant_checkin: values.tenant_checkin || false,
      tenant_checkout: values.tenant_checkout || false,
      tenant_renewal: values.tenant_renewal || false,
      tenant_renewal_days: values.tenant_renewal_days || 0,
      tenant_deposit_posted: values.tenant_deposit_posted || false,
      payment_receipt: values.payment_receipt || false,
      // email
      email_template_id: values.email_template_id || null,
      access_setting: values.access_setting || null,
      all_past: values.all_past || false,
      mark_past_paid: values.mark_past_paid || false,
    };
  };

  const submitLease = async (payload) => {
    try {
      setLoading(true);
      const response = await leasing.create(payload);
      if (response.data.code === 200) {
        message.success('Lease created successfully');
        router.push('/leasing');
      } else {
        message.error(response.data.message || 'Failed to create lease');
      }
    } catch (error) {
      message.error(error.response?.data?.message || 'Failed to create lease');
    } finally {
      setLoading(false);
    }
  };

  const onSubmit = async () => {
    const payload = buildPayload();

    // If no security deposit, confirm with user before proceeding
    if (!payload.deposit || payload.deposit <= 0) {
      Modal.confirm({
        title: 'No Security Deposit',
        content: 'Are you sure you want to proceed with creating this lease? There is no security deposit.',
        okText: 'Yes, Create Lease',
        cancelText: 'Cancel',
        onOk: () => submitLease(payload),
      });
    } else {
      await submitLease(payload);
    }
  };

  // ─── Step 1: Property & Tenants ─────────────────────────────
  const sectionStyle = { border: '1px solid #e8e8e8', borderRadius: 4, padding: 20, marginBottom: 20 };
  const sectionTitle = { fontSize: 13, fontWeight: 600, letterSpacing: '0.5px', color: '#333', marginBottom: 16 };
  const fieldLabel = { fontSize: 11, fontWeight: 700, letterSpacing: '0.5px', color: '#555', textTransform: 'uppercase', marginBottom: 4 };
  const reqStar = { color: '#d4880f', marginRight: 2 };
  const FLabel = ({ required, children }) => (
    <div style={fieldLabel}>{required && <span style={reqStar}>*</span>}{children}</div>
  );

  const renderStep1 = () => (
    <>
      {/* Property Information */}
      <div style={sectionStyle}>
        <div style={sectionTitle}>PROPERTY INFORMATION</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 2 }}>
            <FLabel required>PROPERTY NAME</FLabel>
            <Form.Item name="property_id" noStyle rules={[{ required: true, message: 'Select a property' }]}>
              <Select
                placeholder="Select Property"
                showSearch
                optionFilterProp="children"
                onChange={handlePropertyChange}
                loading={loadingData}
              >
                {properties.map(p => (
                  <Select.Option key={p.id} value={p.id}>{p.display_name}</Select.Option>
                ))}
              </Select>
            </Form.Item>
          </div>
          <div style={{ flex: 1 }}>
            <FLabel required>UNIT</FLabel>
            <Form.Item name="unit_id" noStyle rules={[{ required: true, message: 'Select a unit' }]}>
              <Select
                placeholder="Select Unit"
                showSearch
                optionFilterProp="children"
                onChange={handleUnitChange}
                loading={loadingData}
              >
                {filteredUnits.map(u => (
                  <Select.Option key={u.id} value={u.id}>{u.name}{u.type ? ` - ${u.type}` : ''}</Select.Option>
                ))}
              </Select>
            </Form.Item>
          </div>
        </div>
      </div>

      {/* Lease Information */}
      <div style={sectionStyle}>
        <div style={sectionTitle}>LEASE INFORMATION</div>
        <div style={{ marginBottom: 16 }}>
          <FLabel required>START DATE AND END DATE</FLabel>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Form.Item name="start_date" noStyle rules={[{ required: true, message: 'Select start date' }]}>
              <DatePicker style={{ width: 160 }} onChange={handleDateChange} />
            </Form.Item>
            <span style={{ color: '#999' }}>~</span>
            <Form.Item name="end_date" noStyle>
              <DatePicker style={{ width: 160 }} onChange={handleDateChange} />
            </Form.Item>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ width: 160 }}>
            <FLabel>LEASE TYPE</FLabel>
            <Form.Item name="type" noStyle initialValue={0}>
              <Select style={{ width: 160 }}>
                <Select.Option value={0}>Fixed</Select.Option>
                <Select.Option value={1}>Month-to-Month</Select.Option>
              </Select>
            </Form.Item>
          </div>
        </div>

        {/* Conflict Alert */}
        {conflictChecking && (
          <div style={{ marginTop: 12 }}>
            <Spin size="small" /> Checking for lease conflicts...
          </div>
        )}
        {conflictResult && conflictResult.conflict && (
          <Alert
            type="error" showIcon icon={<WarningOutlined />}
            message="Lease Conflict Detected"
            description={conflictResult.message}
            style={{ marginTop: 12 }}
          />
        )}
        {conflictResult && !conflictResult.conflict && form.getFieldValue('unit_id') && (
          <Alert
            type="success" showIcon icon={<CheckCircleOutlined />}
            message="No conflicts found for this unit and date range."
            style={{ marginTop: 12 }}
          />
        )}
      </div>

      {/* Tenants */}
      <div style={sectionStyle}>
        <div style={sectionTitle}>TENANTS</div>
        <div style={{ marginBottom: 16 }}>
          <FLabel required>SELECT TENANT</FLabel>
          <Form.Item name="tenant_id" noStyle rules={[{ required: true, message: 'Select a tenant' }]}>
            <Select
              placeholder="Please select contact"
              showSearch
              optionFilterProp="children"
              onChange={handleTenantChange}
              loading={loadingData}
              style={{ width: '100%' }}
            >
              {tenants.map(t => (
                <Select.Option key={t.id} value={t.id}>
                  {[t.first_name, t.last_name].filter(Boolean).join(' ')} {t.email ? `(${t.email})` : ''}
                </Select.Option>
              ))}
            </Select>
          </Form.Item>
        </div>
        <div>
          <FLabel>ADDITIONAL TENANT</FLabel>
          <Form.Item name="additionalTenantIds" noStyle>
            <Select
              mode="multiple"
              placeholder="Please select additional contact"
              showSearch
              optionFilterProp="children"
              loading={loadingData}
              allowClear
              style={{ width: '100%' }}
            >
              {tenants.map(t => (
                <Select.Option key={t.id} value={t.id}>
                  {[t.first_name, t.last_name].filter(Boolean).join(' ')} {t.email ? `(${t.email})` : ''}
                </Select.Option>
              ))}
            </Select>
          </Form.Item>
        </div>
        <div style={{ marginTop: 16, width: 200 }}>
          <FLabel required>TENANT STATUS</FLabel>
          <Form.Item
            name="contract_type"
            noStyle
            rules={[{ required: true, message: 'Please select tenant status' }]}
          >
            <Select style={{ width: 200 }} placeholder="Select status">
              <Select.Option value={1}>MR (May Renew)</Select.Option>
              <Select.Option value={2}>MTM (Month To Month)</Select.Option>
              <Select.Option value={3}>NR (Not Renewing)</Select.Option>
              <Select.Option value={4}>UC (Unconfirmed)</Select.Option>
            </Select>
          </Form.Item>
        </div>
      </div>

      {/* Recurring Invoice */}
      <div style={sectionStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <div style={sectionTitle}>RECURRING INVOICE</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.5px', color: '#555', textTransform: 'uppercase' }}>
              MAKE RECURRING
            </span>
            <Switch checked={makeRecurring} onChange={setMakeRecurring} size="small" />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 16 }}>
          <div style={{ flex: 1 }}>
            <FLabel required>AMOUNT</FLabel>
            <Form.Item name="price" noStyle rules={[{ required: true, message: 'Please input amount' }]}>
              <Input placeholder="Please input amount" />
            </Form.Item>
          </div>
          {makeRecurring && (
            <>
              <div style={{ flex: 1 }}>
                <FLabel required>FIRST INVOICE DATE</FLabel>
                <Form.Item name="first_invoice_date" noStyle>
                  <DatePicker style={{ width: '100%' }} placeholder="First Invoice Date" />
                </Form.Item>
              </div>
              <div style={{ flex: 1 }}>
                <FLabel required>INVOICE SCHEDULE</FLabel>
                <Form.Item name="invoicing" noStyle rules={[{ required: true, message: 'Select invoice schedule' }]}>
                  <Select placeholder="Monthly">
                    {INVOICE_SCHEDULES.map(s => (
                      <Select.Option key={s.value} value={s.value}>{s.label}</Select.Option>
                    ))}
                  </Select>
                </Form.Item>
              </div>
              <div style={{ flex: 1 }}>
                <FLabel required>DUE DATE</FLabel>
                <Form.Item name="due_date" noStyle rules={[{ required: true, message: 'Select due date' }]}>
                  <Select placeholder="Please select Due date" allowClear>
                    {DUE_DAY_OPTIONS.map(d => (
                      <Select.Option key={d.value} value={d.value}>{d.label}</Select.Option>
                    ))}
                  </Select>
                </Form.Item>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Utility */}
      <div style={sectionStyle}>
        <div style={sectionTitle}>UTILITY</div>
        <div>
          <FLabel>MONTHLY UTILITY CREDIT</FLabel>
          <Form.Item name="utility_credit" noStyle>
            <InputNumber placeholder="0.00" min={0} precision={2} style={{ maxWidth: 500, width: '100%' }} />
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

      {/* Deposit */}
      <div style={sectionStyle}>
        <div style={sectionTitle}>DEPOSIT</div>
        <div>
          <FLabel>ADD DEPOSIT</FLabel>
          <Form.Item name="deposit" noStyle>
            <Input placeholder="Please input deposit" style={{ maxWidth: 500 }} />
          </Form.Item>
        </div>
      </div>

      {/* Mark past invoices */}
      <div style={{ marginBottom: 16 }}>
        <Form.Item name="mark_past_paid" valuePropName="checked" noStyle>
          <Checkbox>Automatically mark all past invoices as paid</Checkbox>
        </Form.Item>
        <div style={{ color: '#d4380d', fontSize: 12, marginTop: 8 }}>
          * If you are adding a lease that started in the past and you want the system to mark all previous transaction as paid, click here and all past invoices will be marked as paid on their due days.
        </div>
      </div>
    </>
  );

  // ─── Step 2: Additional Information ─────────────────────────
  const renderStep2 = () => (
    <>
      <Card size="small" title="Additional Information" style={{ marginBottom: 16 }}>
        <Row gutter={16}>
          <Col span={12}>
            <Form.Item name="credits" label="Additional Credits">
              <InputNumber style={{ width: '100%' }} min={0} precision={2} placeholder="0.00" />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item name="unit_information" label="Unit Information">
          <TextArea rows={4} placeholder="Enter unit details, condition notes, furniture list, etc." />
        </Form.Item>

        <Form.Item name="note" label="Notes">
          <TextArea rows={4} placeholder="Additional notes about this lease..." />
        </Form.Item>
      </Card>

      <Card size="small" title="Booking & Commission" style={{ marginBottom: 16 }}>
        <Row gutter={16}>
          <Col span={12}>
            <Form.Item name="booking_platform_id" label="Booking Platform">
              <Select placeholder="Select platform" allowClear showSearch optionFilterProp="children">
                {platforms.map(p => (
                  <Select.Option key={p.id} value={p.id}>{p.name}</Select.Option>
                ))}
              </Select>
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="sales_agent_id" label="Sales Agent">
              <Select placeholder="Select agent" allowClear showSearch optionFilterProp="children">
                {agents.map(a => (
                  <Select.Option key={a.id} value={a.id}>{a.name}</Select.Option>
                ))}
              </Select>
            </Form.Item>
          </Col>
        </Row>
      </Card>

      <Card size="small" title="Files" style={{ marginBottom: 16 }}>
        <Upload
          customRequest={handleFileUpload}
          fileList={fileList}
          onRemove={(f) => {
            setFileList(prev => prev.filter(x => x.uid !== f.uid));
          }}
          multiple
        >
          <Button icon={<UploadOutlined />}>Upload Files</Button>
        </Upload>
        <div style={{ color: '#999', marginTop: 8, fontSize: 12 }}>
          Upload lease contracts, documents, photos, etc.
        </div>
      </Card>
    </>
  );

  // ─── Step 3: Email & Settings ───────────────────────────────
  const renderStep3 = () => (
    <>
      <Card size="small" title="Email Template" style={{ marginBottom: 16 }}>
        <Row gutter={16}>
          <Col span={12}>
            <Form.Item name="email_template_id" label="Email Template">
              <Select placeholder="Select template" allowClear>
                {templates.map(t => (
                  <Select.Option key={t.id} value={t.id}>{t.name}</Select.Option>
                ))}
              </Select>
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={16}>
          <Col span={12}>
            <Form.Item name="email_to" label="To">
              <Input placeholder="Tenant email" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="email_reply_to" label="Reply To">
              <Input placeholder="Reply-to email" />
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={16}>
          <Col span={12}>
            <Form.Item name="email_cc" label="CC">
              <Input placeholder="CC email addresses" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="email_bcc" label="BCC">
              <Input placeholder="BCC email addresses" />
            </Form.Item>
          </Col>
        </Row>
      </Card>

      <Card size="small" title="Email Notifications" style={{ marginBottom: 16 }}>
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
          <Form.Item name="payment_receipt" valuePropName="checked" style={{ marginBottom: 0 }}>
            <Checkbox>Email tenant payment receipt</Checkbox>
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
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
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
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
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
      </Card>

      <Card size="small" title="Access & Sharing" style={{ marginBottom: 16 }}>
        <Row gutter={16}>
          <Col span={12}>
            <Form.Item name="access_setting" label="Access Setting">
              <Select placeholder="Select access level" allowClear>
                <Select.Option value={0}>Private</Select.Option>
                <Select.Option value={1}>Shared</Select.Option>
                <Select.Option value={2}>Public</Select.Option>
              </Select>
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="share_lease" valuePropName="checked" label=" ">
              <Checkbox>Share lease with tenant</Checkbox>
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={16}>
          <Col span={12}>
            <Form.Item name="all_past" valuePropName="checked">
              <Checkbox>Include all past invoices</Checkbox>
            </Form.Item>
          </Col>
        </Row>
      </Card>
    </>
  );

  const steps = [
    { title: 'Property & Tenants' },
    { title: 'Additional Information' },
    { title: 'Email & Settings' },
  ];

  const stepContent = [renderStep1, renderStep2, renderStep3];

  return (
    <MainLayout>
      <div style={{ maxWidth: 960, margin: '0 auto' }}>
        <Button
          icon={<ArrowLeftOutlined />}
          onClick={() => router.push('/leasing')}
          style={{ marginBottom: 16 }}
        >
          Back to Leases
        </Button>

        <h1 style={{ marginBottom: 24 }}>Create Lease</h1>

        <Steps current={currentStep} items={steps} style={{ marginBottom: 32 }} />

        <Form
          form={form}
          layout="vertical"
          initialValues={{
            type: 0,
            landlord_expired_days: 30,
            tenant_renewal_days: 30,
          }}
        >
          {stepContent[currentStep]()}
        </Form>

        {/* Navigation Buttons */}
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 24, marginBottom: 40 }}>
          <div>
            {currentStep > 0 && (
              <Button onClick={prevStep} size="large">
                Previous
              </Button>
            )}
          </div>
          <Space>
            <Button size="large" onClick={() => router.push('/leasing')}>
              Cancel
            </Button>
            {currentStep < steps.length - 1 ? (
              <Button type="primary" onClick={nextStep} size="large">
                Next
              </Button>
            ) : (
              <Button type="primary" onClick={onSubmit} loading={loading} size="large">
                CREATE LEASE
              </Button>
            )}
          </Space>
        </div>
      </div>
    </MainLayout>
  );
}
