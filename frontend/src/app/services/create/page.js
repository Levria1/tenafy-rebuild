'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Form, Input, Select, DatePicker, TimePicker, Button, Space, message,
  Row, Col, Upload, Radio,
} from 'antd';
import { ArrowLeftOutlined, InboxOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import MainLayout from '../../../components/Layout';
import { service, file as fileApi } from '../../../lib/api';

const { TextArea } = Input;
const { Dragger } = Upload;

const PRIORITY_OPTIONS = [
  { label: 'High', value: 0 },
  { label: 'Medium', value: 1 },
  { label: 'Low', value: 2 },
];

export default function ServiceCreatePage() {
  const router = useRouter();
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);

  // Dropdown data
  const [properties, setProperties] = useState([]);
  const [units, setUnits] = useState([]);
  const [unitsLoading, setUnitsLoading] = useState(false);
  const [categories, setCategories] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [contacts, setContacts] = useState([]);

  // Assignee mode: 'self' or 'vendor'
  const [assignMode, setAssignMode] = useState(null);

  // File list
  const [fileList, setFileList] = useState([]);

  // Contact phone (auto-populated)
  const [contactPhone, setContactPhone] = useState('');

  useEffect(() => {
    loadInitialData();
  }, []);

  const loadInitialData = async () => {
    try {
      const [propRes, catRes, vendorRes, contactRes] = await Promise.all([
        service.getPropertyList(),
        service.getCategories(),
        service.getVendors(),
        service.getContacts(),
      ]);
      if (propRes.data.code === 200) setProperties(propRes.data.data || []);
      if (catRes.data.code === 200) setCategories(catRes.data.data || []);
      if (vendorRes.data.code === 200) setVendors(vendorRes.data.data || []);
      if (contactRes.data.code === 200) setContacts(contactRes.data.data || []);
    } catch (error) {
      console.error('Failed to load form data:', error);
      message.error('Failed to load form data');
    }
  };

  const handlePropertyChange = async (propertyId) => {
    form.setFieldValue('unit_id', undefined);
    setUnits([]);
    if (!propertyId) return;

    setUnitsLoading(true);
    try {
      const response = await service.getUnitsByProperty(propertyId);
      if (response.data.code === 200) {
        setUnits(response.data.data || []);
      }
    } catch (error) {
      message.error('Failed to load units');
    } finally {
      setUnitsLoading(false);
    }
  };

  const handleContactChange = (contactId) => {
    if (!contactId) {
      setContactPhone('');
      return;
    }
    const found = contacts.find((c) => c.id === contactId);
    setContactPhone(found?.phone || '');
  };

  const onFinish = async (values) => {
    setSubmitting(true);
    try {
      const payload = {
        unit_id: values.unit_id,
        category: values.category || null,
        sub_category: values.sub_category || null,
        priority: values.priority,
        additional_info: values.additional_info || null,
        note: values.note || null,
      };

      // Reported By
      if (values.reported_by) {
        payload.reported_by = values.reported_by;
        payload.contact_phone = contactPhone || null;
      }

      // Assignee(s)
      if (assignMode === 'vendor') {
        if (values.vendor_id) payload.assignee = values.vendor_id;
        if (values.vendor_id_2) payload.assignee_2 = values.vendor_id_2;
      }

      // Service Date Start / End
      if (values.service_date_start) {
        payload.service_date_start = values.service_date_start.format('YYYY-MM-DD HH:mm:ss');
      }
      if (values.service_date_end) {
        payload.service_date_end = values.service_date_end.format('YYYY-MM-DD HH:mm:ss');
      }

      // Preferred Date and Time - Option 1
      if (values.pref1_date) {
        const dateStr = values.pref1_date.format('YYYY-MM-DD');
        const startTime = values.pref1_start ? values.pref1_start.format('HH:mm:ss') : '00:00:00';
        const endTime = values.pref1_end ? values.pref1_end.format('HH:mm:ss') : '23:59:59';
        payload.preferred_date_first_start = `${dateStr} ${startTime}`;
        payload.preferred_date_first_end = `${dateStr} ${endTime}`;
      }

      // Preferred Date and Time - Option 2
      if (values.pref2_date) {
        const dateStr = values.pref2_date.format('YYYY-MM-DD');
        const startTime = values.pref2_start ? values.pref2_start.format('HH:mm:ss') : '00:00:00';
        const endTime = values.pref2_end ? values.pref2_end.format('HH:mm:ss') : '23:59:59';
        payload.preferred_date_second_start = `${dateStr} ${startTime}`;
        payload.preferred_date_second_end = `${dateStr} ${endTime}`;
      }

      // Upload files first, collect their IDs
      if (fileList.length > 0) {
        const uploadedIds = [];
        for (const f of fileList) {
          const formData = new FormData();
          formData.append('file', f.originFileObj);
          const uploadRes = await fileApi.upload(formData);
          if (uploadRes.data.code === 200) {
            uploadedIds.push(uploadRes.data.data.id);
          }
        }
        if (uploadedIds.length > 0) {
          payload.file_ids = uploadedIds;
        }
      }

      await service.create(payload);
      message.success('Work order created successfully');
      router.push('/services');
    } catch (error) {
      message.error(error.response?.data?.message || 'Failed to create work order');
    } finally {
      setSubmitting(false);
    }
  };

  // Disable past dates
  const disabledDate = (current) => current && current < dayjs().startOf('day');

  const contactOptions = contacts.map((c) => {
    const name = Number(c.type) === 1 && c.company_name
      ? c.company_name
      : [c.first_name, c.last_name].filter(Boolean).join(' ');
    const tag = c.contact_type === 'vendor' ? ' (Vendor)' : ' (Tenant)';
    return { label: name + tag, value: c.id };
  });

  return (
    <MainLayout>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => router.push('/services')}>
          Back
        </Button>

        <div style={{ background: '#fff', border: '1px solid #f0f0f0', borderRadius: 8, padding: '24px 32px' }}>
          <h2 style={{ marginBottom: 24 }}>Create Work Order</h2>

          <Form form={form} layout="vertical" onFinish={onFinish} style={{ maxWidth: 900 }}>

            {/* ── Property & Unit ───────────────────────────────────── */}
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item name="property_id" label="Property" rules={[{ required: true, message: 'Please select a property' }]}>
                  <Select
                    placeholder="Select Property"
                    allowClear
                    showSearch
                    optionFilterProp="label"
                    onChange={handlePropertyChange}
                    options={properties.map((p) => ({
                      label: p.display_name,
                      value: p.id,
                    }))}
                  />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item name="unit_id" label="Unit" rules={[{ required: true, message: 'Please select a unit' }]}>
                  <Select
                    placeholder="Select Unit"
                    allowClear
                    showSearch
                    optionFilterProp="label"
                    loading={unitsLoading}
                    options={units.map((u) => ({
                      label: u.name,
                      value: u.id,
                    }))}
                  />
                </Form.Item>
              </Col>
            </Row>

            {/* ── Category & Sub-Category ──────────────────────────── */}
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item name="category" label="Category" rules={[{ required: true, message: 'Please select a category' }]}>
                  <Select
                    placeholder="Select Category"
                    allowClear
                    showSearch
                    optionFilterProp="label"
                    options={categories.map((c) => ({
                      label: c.category,
                      value: c.category,
                    }))}
                  />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item name="sub_category" label="Issues / Sub-Category">
                  <Input placeholder="e.g. Leaking faucet, Broken door" />
                </Form.Item>
              </Col>
            </Row>

            {/* ── Priority ─────────────────────────────────────────── */}
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item name="priority" label="Priority" rules={[{ required: true, message: 'Please select priority' }]}>
                  <Select placeholder="Select Priority" options={PRIORITY_OPTIONS} />
                </Form.Item>
              </Col>
            </Row>

            {/* ── Preferred Date and Time ──────────────────────────── */}
            <div style={{ marginBottom: 8 }}>
              <div style={{ color: '#d4830d', fontWeight: 600, fontSize: 14, marginBottom: 12 }}>
                Preferred Date and Time:
              </div>

              {/* Option 1 */}
              <div style={{ marginBottom: 12 }}>
                <span style={{ marginRight: 4, visibility: 'hidden' }}>*</span>
                <span style={{ fontWeight: 500, marginRight: 12 }}>Option 1:</span>
                <Space>
                  <Form.Item name="pref1_date" noStyle>
                    <DatePicker placeholder="Select date" disabledDate={disabledDate} style={{ width: 150 }} />
                  </Form.Item>
                  <Form.Item name="pref1_start" noStyle>
                    <TimePicker placeholder="Start Time" format="HH:mm" minuteStep={15} style={{ width: 120 }} />
                  </Form.Item>
                  <span style={{ color: '#999' }}>-</span>
                  <Form.Item name="pref1_end" noStyle>
                    <TimePicker placeholder="End Time" format="HH:mm" minuteStep={15} style={{ width: 120 }} />
                  </Form.Item>
                </Space>
              </div>

              {/* Option 2 */}
              <div style={{ marginBottom: 16 }}>
                <span style={{ marginRight: 4, visibility: 'hidden' }}>*</span>
                <span style={{ fontWeight: 500, marginRight: 12 }}>Option 2:</span>
                <Space>
                  <Form.Item name="pref2_date" noStyle>
                    <DatePicker placeholder="Select date" disabledDate={disabledDate} style={{ width: 150 }} />
                  </Form.Item>
                  <Form.Item name="pref2_start" noStyle>
                    <TimePicker placeholder="Start Time" format="HH:mm" minuteStep={15} style={{ width: 120 }} />
                  </Form.Item>
                  <span style={{ color: '#999' }}>-</span>
                  <Form.Item name="pref2_end" noStyle>
                    <TimePicker placeholder="End Time" format="HH:mm" minuteStep={15} style={{ width: 120 }} />
                  </Form.Item>
                </Space>
              </div>
            </div>

            {/* ── Service Start / End Date ────────────────────────── */}
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item name="service_date_start" label="Service Start Date">
                  <DatePicker
                    showTime={{ format: 'HH:mm', minuteStep: 15 }}
                    format="YYYY-MM-DD HH:mm"
                    placeholder="Select start date & time"
                    style={{ width: '100%' }}
                  />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item name="service_date_end" label="Service End Date">
                  <DatePicker
                    showTime={{ format: 'HH:mm', minuteStep: 15 }}
                    format="YYYY-MM-DD HH:mm"
                    placeholder="Select end date & time"
                    style={{ width: '100%' }}
                  />
                </Form.Item>
              </Col>
            </Row>

            {/* ── Reported By ────────────────────────────────────── */}
            <div style={{ color: '#d4830d', fontWeight: 600, fontSize: 14, marginBottom: 12 }}>
              Reported By:
            </div>
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item name="reported_by" label="Contact">
                  <Select
                    placeholder="Select Contact"
                    allowClear
                    showSearch
                    optionFilterProp="label"
                    onChange={handleContactChange}
                    options={contactOptions}
                  />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item label="Contact Phone">
                  <Input value={contactPhone} readOnly placeholder="Auto-populated from contact" />
                </Form.Item>
              </Col>
            </Row>

            {/* ── Assignee ─────────────────────────────────────────── */}
            <Form.Item label="Select Assignee">
              <Radio.Group
                value={assignMode}
                onChange={(e) => {
                  setAssignMode(e.target.value);
                  if (e.target.value !== 'vendor') {
                    form.setFieldValue('vendor_id', undefined);
                    form.setFieldValue('vendor_id_2', undefined);
                  }
                }}
              >
                <Space direction="vertical">
                  <Radio value="self">Assign to Myself</Radio>
                  <Radio value="vendor">Assign to Vendor</Radio>
                </Space>
              </Radio.Group>
            </Form.Item>

            {assignMode === 'vendor' && (
              <Row gutter={16}>
                <Col span={12}>
                  <Form.Item name="vendor_id" label="Vendor 1">
                    <Select
                      placeholder="Select Vendor"
                      allowClear
                      showSearch
                      optionFilterProp="label"
                      options={vendors.map((v) => ({
                        label: [v.first_name, v.last_name].filter(Boolean).join(' '),
                        value: v.id,
                      }))}
                    />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name="vendor_id_2" label="Vendor 2">
                    <Select
                      placeholder="Select Vendor (optional)"
                      allowClear
                      showSearch
                      optionFilterProp="label"
                      options={vendors.map((v) => ({
                        label: [v.first_name, v.last_name].filter(Boolean).join(' '),
                        value: v.id,
                      }))}
                    />
                  </Form.Item>
                </Col>
              </Row>
            )}

            {/* ── Additional Information ───────────────────────────── */}
            <Form.Item name="additional_info" label="Additional Information">
              <TextArea rows={4} placeholder="Any additional details about the issue..." />
            </Form.Item>

            {/* ── Note ─────────────────────────────────────────────── */}
            <Form.Item name="note" label="Note">
              <TextArea rows={3} placeholder="Internal notes..." />
            </Form.Item>

            {/* ── Upload Images or Documents ───────────────────────── */}
            <Form.Item label="Upload Images or Documents">
              <Dragger
                multiple
                fileList={fileList}
                onChange={({ fileList: fl }) => setFileList(fl)}
                beforeUpload={() => false}
                accept="image/*,.pdf,.doc,.docx,.xls,.xlsx"
              >
                <p className="ant-upload-drag-icon"><InboxOutlined /></p>
                <p className="ant-upload-text">Click or drag files to this area to upload</p>
                <p className="ant-upload-hint">Support images, PDF, Word, Excel files</p>
              </Dragger>
            </Form.Item>

            {/* ── Actions ──────────────────────────────────────────── */}
            <Form.Item>
              <Space>
                <Button onClick={() => router.push('/services')}>Cancel</Button>
                <Button type="primary" htmlType="submit" loading={submitting}>
                  Create Work Order
                </Button>
              </Space>
            </Form.Item>
          </Form>
        </div>
      </Space>
    </MainLayout>
  );
}
