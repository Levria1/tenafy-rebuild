'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, Form, Input, Select, DatePicker, Button, Space, message, Row, Col } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import MainLayout from '../../../components/Layout';
import { service, user } from '../../../lib/api';

const { TextArea } = Input;
const { RangePicker } = DatePicker;

const CATEGORY_OPTIONS = [
  { label: 'Plumbing', value: 'Plumbing' },
  { label: 'Electrical', value: 'Electrical' },
  { label: 'HVAC', value: 'HVAC' },
  { label: 'Appliance', value: 'Appliance' },
  { label: 'Structural', value: 'Structural' },
  { label: 'Painting', value: 'Painting' },
  { label: 'Cleaning', value: 'Cleaning' },
  { label: 'Landscaping', value: 'Landscaping' },
  { label: 'General', value: 'General' },
  { label: 'Other', value: 'Other' },
];

const PRIORITY_OPTIONS = [
  { label: 'High', value: 0 },
  { label: 'Medium', value: 1 },
  { label: 'Low', value: 2 },
];

export default function ServiceCreatePage() {
  const router = useRouter();
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [properties, setProperties] = useState([]);
  const [units, setUnits] = useState([]);
  const [unitsLoading, setUnitsLoading] = useState(false);
  const [users, setUsers] = useState([]);

  useEffect(() => {
    loadInitialData();
  }, []);

  const loadInitialData = async () => {
    try {
      const [propRes, userRes] = await Promise.all([
        service.getPropertyList(),
        user.listUsers({}, { page: 1, limit: 200 }),
      ]);
      if (propRes.data.code === 200) {
        setProperties(propRes.data.data || []);
      }
      if (userRes.data.code === 200) {
        const userData = userRes.data.data?.content || userRes.data.data || [];
        setUsers(userData);
      }
    } catch (error) {
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
        category: values.category,
        sub_category: values.sub_category || null,
        priority: values.priority,
        additional_info: values.additional_info || null,
        note: values.note || null,
        assignee: values.assignee || null,
      };

      if (values.preferred_date_range && values.preferred_date_range.length === 2) {
        payload.preferred_date_first_start = values.preferred_date_range[0].format('YYYY-MM-DD');
        payload.preferred_date_first_end = values.preferred_date_range[1].format('YYYY-MM-DD');
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

  return (
    <MainLayout>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => router.push('/services')}>
          Back
        </Button>
        <Card title="Create Work Order">
          <Form form={form} layout="vertical" onFinish={onFinish} style={{ maxWidth: 800 }}>
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
                      label: p.display_name || p.name,
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
                      label: u.unit_number || u.name,
                      value: u.id,
                    }))}
                  />
                </Form.Item>
              </Col>
            </Row>

            <Row gutter={16}>
              <Col span={12}>
                <Form.Item name="category" label="Category" rules={[{ required: true, message: 'Please select a category' }]}>
                  <Select placeholder="Select Category" options={CATEGORY_OPTIONS} />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item name="sub_category" label="Sub-Category">
                  <Input placeholder="e.g. Leaking faucet" />
                </Form.Item>
              </Col>
            </Row>

            <Row gutter={16}>
              <Col span={12}>
                <Form.Item name="priority" label="Priority" rules={[{ required: true, message: 'Please select priority' }]}>
                  <Select placeholder="Select Priority" options={PRIORITY_OPTIONS} />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item name="assignee" label="Assignee">
                  <Select
                    placeholder="Select Assignee"
                    allowClear
                    showSearch
                    optionFilterProp="label"
                    options={users.map((u) => ({
                      label: u.first_name && u.last_name
                        ? `${u.first_name} ${u.last_name}`
                        : u.username,
                      value: u.id,
                    }))}
                  />
                </Form.Item>
              </Col>
            </Row>

            <Form.Item name="preferred_date_range" label="Preferred Date Range">
              <RangePicker style={{ width: '100%' }} />
            </Form.Item>

            <Form.Item name="additional_info" label="Additional Information">
              <TextArea rows={3} placeholder="Any additional details about the issue..." />
            </Form.Item>

            <Form.Item name="note" label="Note">
              <TextArea rows={3} placeholder="Internal notes..." />
            </Form.Item>

            <Form.Item>
              <Space>
                <Button onClick={() => router.push('/services')}>Cancel</Button>
                <Button type="primary" htmlType="submit" loading={submitting}>
                  Create Work Order
                </Button>
              </Space>
            </Form.Item>
          </Form>
        </Card>
      </Space>
    </MainLayout>
  );
}
