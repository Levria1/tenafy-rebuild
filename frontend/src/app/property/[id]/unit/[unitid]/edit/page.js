'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Card, Form, Input, InputNumber, Select, Button, message, Row, Col, Switch } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import MainLayout from '../../../../../../components/Layout';
import { property as propertyApi } from '../../../../../../lib/api';

const { TextArea } = Input;

const sectionStyle = { background: '#fafafa', padding: '16px 20px', borderRadius: 8, marginBottom: 16, border: '1px solid #f0f0f0' };
const sectionTitle = { fontSize: 12, fontWeight: 700, letterSpacing: '0.5px', color: '#333', textTransform: 'uppercase', marginBottom: 12 };

export default function UnitEditPage() {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const router = useRouter();
  const params = useParams();
  const propertyId = params.id;
  const unitId = params.unitid;

  useEffect(() => {
    loadUnit();
  }, [unitId]);

  const loadUnit = async () => {
    try {
      const response = await propertyApi.getUnit(unitId);
      if (response.data.code === 200) {
        const d = response.data.data;
        form.setFieldsValue({
          name: d.name,
          type: d.type || undefined,
          size: d.size ? Number(d.size) : undefined,
          size_unit: d.size_unit || 'sqft',
          beds: d.beds != null ? Number(d.beds) : undefined,
          baths: d.baths != null ? Number(d.baths) : undefined,
          smoking: d.smoking ? true : false,
          laundry: d.laundry ? true : false,
          parking: d.parking != null ? Number(d.parking) : undefined,
          amenity_detail: d.amenity_detail || '',
          access_information: d.access_information || '',
          key_code: d.key_code || '',
          wifi_information: d.wifi_information || '',
          payment_information: d.payment_information || '',
          internal_note: d.internal_note || '',
          rent_price_min: d.rent_price_min ? Number(d.rent_price_min) : undefined,
          rent_price_max: d.rent_price_max ? Number(d.rent_price_max) : undefined,
          deposit_price: d.deposit_price ? Number(d.deposit_price) : undefined,
          charge_method: d.charge_method != null ? Number(d.charge_method) : 0,
          fee: d.fee ? Number(d.fee) : undefined,
        });
      }
    } catch (error) {
      message.error('Failed to load unit');
    } finally {
      setInitialLoading(false);
    }
  };

  const onFinish = async (values) => {
    try {
      setLoading(true);
      await propertyApi.updateUnit(unitId, {
        ...values,
        smoking: values.smoking ? 1 : 0,
        laundry: values.laundry ? 1 : 0,
      });
      message.success('Unit updated successfully');
      router.push(`/property/${unitId}`);
    } catch (error) {
      message.error('Failed to update unit');
    } finally {
      setLoading(false);
    }
  };

  return (
    <MainLayout>
      <div style={{ maxWidth: 800, margin: '0 auto' }}>
        <Button type="link" icon={<ArrowLeftOutlined />} onClick={() => router.back()} style={{ marginBottom: 16, paddingLeft: 0 }}>
          Back to Unit
        </Button>
        <h2 style={{ marginBottom: 20 }}>Edit Unit</h2>

        <Form form={form} layout="vertical" onFinish={onFinish} disabled={initialLoading}>

          {/* UNIT INFORMATION */}
          <div style={sectionStyle}>
            <div style={sectionTitle}>Unit Information</div>
            <Row gutter={16}>
              <Col span={8}>
                <Form.Item name="name" label="Unit Name" rules={[{ required: true, message: 'Unit name is required' }]}>
                  <Input placeholder="e.g. 3A" />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item name="type" label="Type">
                  <Input placeholder="e.g. Studio, 1BR, Commercial" />
                </Form.Item>
              </Col>
              <Col span={4}>
                <Form.Item name="size" label="Room Size">
                  <InputNumber min={0} style={{ width: '100%' }} placeholder="0" />
                </Form.Item>
              </Col>
              <Col span={4}>
                <Form.Item name="size_unit" label="Unit">
                  <Select>
                    <Select.Option value="sqft">sqft</Select.Option>
                    <Select.Option value="sqm">sqm</Select.Option>
                  </Select>
                </Form.Item>
              </Col>
            </Row>
            <Row gutter={16}>
              <Col span={6}>
                <Form.Item name="beds" label="Bedrooms">
                  <InputNumber min={0} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col span={6}>
                <Form.Item name="baths" label="Bathrooms">
                  <InputNumber min={0} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col span={6}>
                <Form.Item name="parking" label="Parking Spaces">
                  <InputNumber min={0} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
            </Row>
            <Row gutter={16}>
              <Col span={6}>
                <Form.Item name="laundry" label="Laundry" valuePropName="checked">
                  <Switch checkedChildren="YES" unCheckedChildren="NO" />
                </Form.Item>
              </Col>
              <Col span={6}>
                <Form.Item name="smoking" label="Smoking" valuePropName="checked">
                  <Switch checkedChildren="YES" unCheckedChildren="NO" />
                </Form.Item>
              </Col>
            </Row>
          </div>

          {/* RENT & DEPOSIT */}
          <div style={sectionStyle}>
            <div style={sectionTitle}>Rent & Deposit</div>
            <Row gutter={16}>
              <Col span={8}>
                <Form.Item name="rent_price_min" label="Rent (Min)">
                  <InputNumber min={0} precision={2} style={{ width: '100%' }} placeholder="0.00" />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item name="rent_price_max" label="Rent (Max)">
                  <InputNumber min={0} precision={2} style={{ width: '100%' }} placeholder="0.00" />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item name="deposit_price" label="Deposit">
                  <InputNumber min={0} precision={2} style={{ width: '100%' }} placeholder="0.00" />
                </Form.Item>
              </Col>
            </Row>
            <Row gutter={16}>
              <Col span={8}>
                <Form.Item name="charge_method" label="Management Fee">
                  <Select>
                    <Select.Option value={0}>No Charge</Select.Option>
                    <Select.Option value={1}>% of Rent</Select.Option>
                    <Select.Option value={2}>Fixed Monthly</Select.Option>
                  </Select>
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item name="fee" label="Fee Amount / %">
                  <InputNumber min={0} precision={2} style={{ width: '100%' }} placeholder="0.00" />
                </Form.Item>
              </Col>
            </Row>
          </div>

          {/* DETAILS */}
          <div style={sectionStyle}>
            <div style={sectionTitle}>Details</div>
            <Form.Item name="amenity_detail" label="Amenity Details">
              <TextArea rows={3} placeholder="Details about amenities..." />
            </Form.Item>
            <Form.Item name="access_information" label="Unit Access Information">
              <TextArea rows={3} placeholder="Access codes, key pickup location, etc." />
            </Form.Item>
            <Form.Item name="key_code" label="Key Codes">
              <Input placeholder="Door codes, lockbox info..." />
            </Form.Item>
            <Form.Item name="wifi_information" label="WiFi Information">
              <TextArea rows={2} placeholder="Network name, password..." />
            </Form.Item>
            <Form.Item name="payment_information" label="Payment Information">
              <TextArea rows={3} placeholder="Bank details, payment instructions..." />
            </Form.Item>
            <Form.Item name="internal_note" label="Internal Notes">
              <TextArea rows={3} placeholder="Notes for internal use only..." />
            </Form.Item>
          </div>

          {/* Submit */}
          <div style={{ display: 'flex', gap: 12 }}>
            <Button type="primary" htmlType="submit" loading={loading} size="large">
              Update Unit
            </Button>
            <Button size="large" onClick={() => router.back()}>
              Cancel
            </Button>
          </div>
        </Form>
      </div>
    </MainLayout>
  );
}
