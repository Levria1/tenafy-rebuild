'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import {
  Form, Input, Button, Select, DatePicker, Radio, Row, Col, Card, Upload, message, Avatar, Spin,
} from 'antd';
import { UploadOutlined, UserOutlined, CloudUploadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import MainLayout from '../../../../../components/Layout';
import { contact } from '../../../../../lib/api';

export default function ServiceVendorEditPage() {
  const router = useRouter();
  const params = useParams();
  const vendorId = params.id;
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);

  useEffect(() => {
    loadVendor();
  }, [vendorId]);

  const loadVendor = async () => {
    try {
      const response = await contact.getServiceVendor(vendorId);
      if (response.data.code === 200) {
        const data = response.data.data;
        form.setFieldsValue({
          first_name: data.first_name,
          last_name: data.last_name,
          email: data.email,
          phone: data.phone,
          id_card: data.id_card,
          birth_date: data.birth_date ? dayjs(data.birth_date) : null,
          sex: data.sex != null ? Number(data.sex) : 1,
          notes: data.notes,
          status: data.status != null ? Number(data.status) : 1,
        });
      }
    } catch (error) {
      message.error('Failed to load service vendor');
    } finally {
      setInitialLoading(false);
    }
  };

  const onFinish = async (values) => {
    try {
      setLoading(true);
      const response = await contact.updateServiceVendor(vendorId, {
        ...values,
        birth_date: values.birth_date?.format('YYYY-MM-DD') || null,
      });
      if (response.data.code === 200) {
        message.success('Service vendor updated successfully');
        router.push(`/contacts/service-vendor/${vendorId}/detail`);
      } else {
        message.error(response.data.message || 'Failed to update service vendor');
      }
    } catch (error) {
      message.error(error.response?.data?.message || 'Failed to update service vendor');
    } finally {
      setLoading(false);
    }
  };

  if (initialLoading) {
    return (
      <MainLayout>
        <div style={{ padding: 48, textAlign: 'center' }}><Spin size="large" /></div>
      </MainLayout>
    );
  }

  return (
    <MainLayout>
      <h1 style={{ marginBottom: 24 }}>Edit Service Vendor</h1>

      <Form form={form} layout="vertical" onFinish={onFinish} initialValues={{ sex: 1, status: 1 }}>
        <Row gutter={24}>
          {/* Left column — Profile Photo + Status */}
          <Col xs={24} md={8}>
            {/* Profile Photo */}
            <Card
              style={{ marginBottom: 16 }}
              styles={{ header: { background: '#1890ff', color: '#fff', fontWeight: 600 } }}
              title="Profile Photo"
            >
              <div style={{ textAlign: 'center', padding: '24px 0' }}>
                <Avatar size={140} icon={<UserOutlined />} style={{ backgroundColor: '#f0f0f0', marginBottom: 16 }} />
                <div>
                  <Button icon={<UploadOutlined />}>Upload Photo</Button>
                </div>
              </div>
            </Card>

            {/* Service Vendor Status */}
            <Card>
              <div style={{ fontWeight: 600, marginBottom: 8 }}>Service Vendor Status</div>
              <Form.Item name="status" noStyle>
                <Select
                  style={{ width: '100%' }}
                  options={[
                    { label: 'Active', value: 1 },
                    { label: 'Inactive', value: 0 },
                  ]}
                />
              </Form.Item>
            </Card>
          </Col>

          {/* Right column — General Information + Additional Info + Upload */}
          <Col xs={24} md={16}>
            {/* General Information */}
            <Card style={{ marginBottom: 16 }}>
              <div style={{ fontWeight: 700, fontSize: 14, color: '#555', textTransform: 'uppercase', marginBottom: 16, letterSpacing: 0.5 }}>
                General Information
              </div>
              <Row gutter={16}>
                <Col span={12}>
                  <Form.Item
                    name="first_name"
                    label={<span style={{ color: '#d4380d' }}>* <span style={{ color: '#333' }}>FIRST NAME</span></span>}
                    rules={[{ required: true, message: 'Please input your first name' }]}
                  >
                    <Input placeholder="Please input your first name" />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item
                    name="last_name"
                    label={<span style={{ color: '#d4380d' }}>* <span style={{ color: '#333' }}>LAST NAME</span></span>}
                    rules={[{ required: true, message: 'Please input your last name' }]}
                  >
                    <Input placeholder="Please input your last name" />
                  </Form.Item>
                </Col>
              </Row>
              <Row gutter={16}>
                <Col span={12}>
                  <Form.Item name="birth_date" label="DATE OF BIRTH">
                    <DatePicker style={{ width: '100%' }} placeholder="Select your date of birth" />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name="sex" label="GENDER">
                    <Radio.Group>
                      <Radio value={1}>MALE</Radio>
                      <Radio value={2}>FEMALE</Radio>
                    </Radio.Group>
                  </Form.Item>
                </Col>
              </Row>
              <Row gutter={16}>
                <Col span={12}>
                  <Form.Item
                    name="email"
                    label={<span style={{ color: '#d4380d' }}>* <span style={{ color: '#333' }}>EMAIL</span></span>}
                    rules={[{ required: true, type: 'email', message: 'Please input email' }]}
                  >
                    <Input placeholder="Please input email" />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name="phone" label="PHONE">
                    <Input placeholder="Please input phone number" />
                  </Form.Item>
                </Col>
              </Row>
              <Row gutter={16}>
                <Col span={12}>
                  <Form.Item name="id_card" label="ID / PASSPORT">
                    <Input placeholder="Input ID or passport number" />
                  </Form.Item>
                </Col>
              </Row>
            </Card>

            {/* Additional Information */}
            <Card style={{ marginBottom: 16 }}>
              <div style={{ fontWeight: 700, fontSize: 14, color: '#555', textTransform: 'uppercase', marginBottom: 16, letterSpacing: 0.5 }}>
                Additional Information
              </div>
              <Form.Item name="notes" label="NOTES">
                <Input.TextArea rows={4} placeholder="Please input your notes here" />
              </Form.Item>
            </Card>

            {/* Upload area */}
            <Card style={{ marginBottom: 24 }}>
              <Upload.Dragger
                beforeUpload={() => false}
                multiple
                style={{ border: '2px dashed #1890ff', borderRadius: 8 }}
              >
                <p className="ant-upload-drag-icon">
                  <CloudUploadOutlined style={{ fontSize: 36, color: '#1890ff' }} />
                </p>
                <p className="ant-upload-text">Upload</p>
                <p className="ant-upload-hint">Store documents and templates</p>
              </Upload.Dragger>
            </Card>

            {/* Action buttons */}
            <Row gutter={16}>
              <Col span={12}>
                <Button
                  block
                  size="large"
                  onClick={() => router.push(`/contacts/service-vendor/${vendorId}/detail`)}
                >
                  Cancel
                </Button>
              </Col>
              <Col span={12}>
                <Button
                  block
                  size="large"
                  type="primary"
                  htmlType="submit"
                  loading={loading}
                >
                  SUBMIT
                </Button>
              </Col>
            </Row>
          </Col>
        </Row>
      </Form>
    </MainLayout>
  );
}
