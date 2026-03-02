'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Card, Form, Input, Button, message, Select, DatePicker, Row, Col } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import MainLayout from '../../../../../components/Layout';
import { contact } from '../../../../../lib/api';

export default function PropertyOwnerEditPage() {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const router = useRouter();
  const params = useParams();
  const ownerId = params.id;

  useEffect(() => {
    loadOwner();
  }, [ownerId]);

  const loadOwner = async () => {
    try {
      const response = await contact.getPropertyOwner(ownerId);
      if (response.data.code === 200) {
        const data = response.data.data;
        form.setFieldsValue({
          ...data,
          birth_date: data.birth_date ? dayjs(data.birth_date) : null,
        });
      }
    } catch (error) {
      message.error('Failed to load property owner');
    } finally {
      setInitialLoading(false);
    }
  };

  const onFinish = async (values) => {
    try {
      setLoading(true);
      await contact.updatePropertyOwner(ownerId, {
        ...values,
        birth_date: values.birth_date?.format('YYYY-MM-DD') || null,
      });
      message.success('Property owner updated successfully');
      router.push(`/contacts/property-owner/${ownerId}/detail`);
    } catch (error) {
      message.error('Failed to update property owner');
    } finally {
      setLoading(false);
    }
  };

  return (
    <MainLayout>
      <Button icon={<ArrowLeftOutlined />} onClick={() => router.push(`/contacts/property-owner/${ownerId}/detail`)} style={{ marginBottom: 16 }}>
        Back to Detail
      </Button>
      <Card title="Edit Property Owner" loading={initialLoading}>
        <Form form={form} layout="vertical" onFinish={onFinish} style={{ maxWidth: 700 }}>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="first_name" label="First Name" rules={[{ required: true }]}>
                <Input />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="last_name" label="Last Name" rules={[{ required: true }]}>
                <Input />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="email" label="Email" rules={[{ required: true, type: 'email' }]}>
                <Input />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="phone" label="Phone">
                <Input />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="id_card" label="ID Card / Passport">
                <Input />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="birth_date" label="Birth Date">
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="sex" label="Sex">
            <Select allowClear options={[
              { label: 'Male', value: 0 },
              { label: 'Female', value: 1 },
            ]} />
          </Form.Item>
          <Form.Item name="notes" label="Notes">
            <Input.TextArea rows={3} />
          </Form.Item>
          <Form.Item name="status" label="Status">
            <Select options={[
              { label: 'Active', value: 1 },
              { label: 'Inactive', value: 0 },
            ]} />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={loading}>Update Property Owner</Button>
          </Form.Item>
        </Form>
      </Card>
    </MainLayout>
  );
}
