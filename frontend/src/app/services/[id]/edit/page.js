'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Card, Form, Input, Select, DatePicker, Button, message, Row, Col, Space } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import MainLayout from '../../../../components/Layout';
import { service, user } from '../../../../lib/api';

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

const STATUS_OPTIONS = [
  { label: 'Pending', value: 0 },
  { label: 'Ongoing', value: 1 },
  { label: 'Completed', value: 2 },
];

export default function ServiceEditPage() {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [properties, setProperties] = useState([]);
  const [units, setUnits] = useState([]);
  const [unitsLoading, setUnitsLoading] = useState(false);
  const [users, setUsers] = useState([]);
  const router = useRouter();
  const params = useParams();
  const serviceId = params.id;

  useEffect(() => {
    loadData();
    loadService();
  }, [serviceId]);

  const loadData = async () => {
    try {
      const [propRes, userRes] = await Promise.all([
        service.getPropertyList(),
        user.listUsers({}, { page: 1, limit: 200 }),
      ]);
      if (propRes.data.code === 200) setProperties(propRes.data.data || []);
      if (userRes.data.code === 200) {
        setUsers(userRes.data.data?.content || userRes.data.data || []);
      }
    } catch (error) {
      console.error('Failed to load form data');
    }
  };

  const loadService = async () => {
    try {
      const response = await service.get(serviceId);
      if (response.data.code === 200) {
        const data = response.data.data;

        // Load units for this service's property
        if (data.property_id) {
          try {
            const unitRes = await service.getUnitsByProperty(data.property_id);
            if (unitRes.data.code === 200) setUnits(unitRes.data.data || []);
          } catch (e) { /* ignore */ }
        }

        form.setFieldsValue({
          ...data,
          preferred_date_range: data.preferred_date_first_start && data.preferred_date_first_end
            ? [dayjs(data.preferred_date_first_start), dayjs(data.preferred_date_first_end)]
            : null,
          service_date_range: data.service_date_start && data.service_date_end
            ? [dayjs(data.service_date_start), dayjs(data.service_date_end)]
            : null,
        });
      }
    } catch (error) {
      message.error('Failed to load service');
    } finally {
      setInitialLoading(false);
    }
  };

  const handlePropertyChange = async (propertyId) => {
    form.setFieldValue('unit_id', undefined);
    setUnits([]);
    if (!propertyId) return;
    setUnitsLoading(true);
    try {
      const response = await service.getUnitsByProperty(propertyId);
      if (response.data.code === 200) setUnits(response.data.data || []);
    } catch (error) {
      message.error('Failed to load units');
    } finally {
      setUnitsLoading(false);
    }
  };

  const onFinish = async (values) => {
    try {
      setLoading(true);
      const payload = {
        category: values.category,
        sub_category: values.sub_category || null,
        note: values.note || null,
        additional_info: values.additional_info || null,
        status: values.status,
        assignee: values.assignee || null,
        priority: values.priority,
      };

      if (values.preferred_date_range && values.preferred_date_range.length === 2) {
        payload.preferred_date_first_start = values.preferred_date_range[0].format('YYYY-MM-DD HH:mm:ss');
        payload.preferred_date_first_end = values.preferred_date_range[1].format('YYYY-MM-DD HH:mm:ss');
      }
      if (values.service_date_range && values.service_date_range.length === 2) {
        payload.service_date_start = values.service_date_range[0].format('YYYY-MM-DD HH:mm:ss');
        payload.service_date_end = values.service_date_range[1].format('YYYY-MM-DD HH:mm:ss');
      }

      await service.update(serviceId, payload);
      message.success('Service updated successfully');
      router.push(`/services/${serviceId}/detail`);
    } catch (error) {
      message.error('Failed to update service');
    } finally {
      setLoading(false);
    }
  };

  return (
    <MainLayout>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => router.push(`/services/${serviceId}/detail`)}>
          Back to Detail
        </Button>
        <Card title="Edit Service Request" loading={initialLoading}>
          <Form form={form} layout="vertical" onFinish={onFinish} style={{ maxWidth: 800 }}>
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item name="property_id" label="Property">
                  <Select
                    placeholder="Select Property"
                    allowClear
                    showSearch
                    optionFilterProp="label"
                    onChange={handlePropertyChange}
                    disabled
                    options={properties.map(p => ({ label: p.display_name || p.name, value: p.id }))}
                  />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item name="unit_id" label="Unit">
                  <Select
                    placeholder="Select Unit"
                    disabled
                    loading={unitsLoading}
                    options={units.map(u => ({ label: u.name, value: u.id }))}
                  />
                </Form.Item>
              </Col>
            </Row>

            <Row gutter={16}>
              <Col span={12}>
                <Form.Item name="category" label="Category">
                  <Select placeholder="Select Category" options={CATEGORY_OPTIONS} allowClear />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item name="sub_category" label="Sub-Category">
                  <Input placeholder="e.g. Leaking faucet" />
                </Form.Item>
              </Col>
            </Row>

            <Row gutter={16}>
              <Col span={8}>
                <Form.Item name="priority" label="Priority">
                  <Select placeholder="Select Priority" options={PRIORITY_OPTIONS} allowClear />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item name="status" label="Status">
                  <Select options={STATUS_OPTIONS} />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item name="assignee" label="Assignee">
                  <Select
                    placeholder="Select Assignee"
                    allowClear
                    showSearch
                    optionFilterProp="label"
                    options={users.map(u => ({
                      label: u.first_name && u.last_name ? `${u.first_name} ${u.last_name}` : u.username,
                      value: u.id,
                    }))}
                  />
                </Form.Item>
              </Col>
            </Row>

            <Form.Item name="preferred_date_range" label="Preferred Date Range">
              <RangePicker style={{ width: '100%' }} showTime />
            </Form.Item>

            <Form.Item name="service_date_range" label="Service Date Range">
              <RangePicker style={{ width: '100%' }} showTime />
            </Form.Item>

            <Form.Item name="additional_info" label="Additional Information">
              <TextArea rows={3} placeholder="Any additional details about the issue..." />
            </Form.Item>

            <Form.Item name="note" label="Note">
              <TextArea rows={3} placeholder="Internal notes..." />
            </Form.Item>

            <Form.Item>
              <Space>
                <Button onClick={() => router.push(`/services/${serviceId}/detail`)}>Cancel</Button>
                <Button type="primary" htmlType="submit" loading={loading}>Update Service</Button>
              </Space>
            </Form.Item>
          </Form>
        </Card>
      </Space>
    </MainLayout>
  );
}
