'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Form, Input, Select, DatePicker, TimePicker, Button, Space, message,
  Row, Col, Upload, Radio,
} from 'antd';
import { ArrowLeftOutlined, UploadOutlined, InboxOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import MainLayout from '../../../components/Layout';
import { service } from '../../../lib/api';

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

  // Assignee mode: 'self' or 'vendor'
  const [assignMode, setAssignMode] = useState(null);

  // File list
  const [fileList, setFileList] = useState([]);

  useEffect(() => {
    loadInitialData();
  }, []);

  const loadInitialData = async () => {
    try {
      const [propRes, catRes, vendorRes] = await Promise.all([
        service.getPropertyList(),
        service.getCategories(),
        service.getVendors(),
      ]);
      if (propRes.data.code === 200) setProperties(propRes.data.data || []);
      if (catRes.data.code === 200) setCategories(catRes.data.data || []);
      if (vendorRes.data.code === 200) setVendors(vendorRes.data.data || []);
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

      // Assignee
      if (assignMode === 'vendor' && values.vendor_id) {
        payload.assignee = values.vendor_id;
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
                <span style={{ color: '#ff4d4f', marginRight: 4 }}>*</span>
                <span style={{ fontWeight: 500, marginRight: 12 }}>Option 1:</span>
                <Space>
                  <Form.Item name="pref1_date" noStyle rules={[{ required: true, message: 'Select date' }]}>
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

            {/* ── Assignee ─────────────────────────────────────────── */}
            <Form.Item label="Select Assignee">
              <Radio.Group
                value={assignMode}
                onChange={(e) => {
                  setAssignMode(e.target.value);
                  if (e.target.value !== 'vendor') {
                    form.setFieldValue('vendor_id', undefined);
                  }
                }}
              >
                <Space direction="vertical">
                  <Radio value="self">Assign to Myself</Radio>
                  <Radio value="vendor">
                    <Space>
                      Assign to Vendor
                      {assignMode === 'vendor' && (
                        <Form.Item name="vendor_id" noStyle>
                          <Select
                            placeholder="Select Vendor"
                            allowClear
                            showSearch
                            optionFilterProp="label"
                            style={{ width: 250 }}
                            options={vendors.map((v) => ({
                              label: [v.first_name, v.last_name].filter(Boolean).join(' '),
                              value: v.id,
                            }))}
                          />
                        </Form.Item>
                      )}
                    </Space>
                  </Radio>
                </Space>
              </Radio.Group>
            </Form.Item>

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
