'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import {
  Form, Input, InputNumber, Select, Button, message, Switch, Radio, Checkbox, Spin, Row, Col,
} from 'antd';
import { ArrowLeftOutlined, UploadOutlined, PlusOutlined } from '@ant-design/icons';
import MainLayout from '../../../../../components/Layout';
import { property as propertyApi } from '../../../../../lib/api';

const RESIDENTIAL_DESC = 'Residential Properties include single family homes where there is only one rental unit associated to the address, and also include houses, single condominium units, single mobile homes, co-ops, townhouses, duplexes, triple-deckers, quadplexes, high-value homes, multi-generational and vacation homes.';
const COMMERCIAL_DESC  = 'Commercial property usually refers to buildings that house businesses, as well as larger residential rental properties. Commercial properties include properties such as retail properties (store fronts), offices, serviced offices, hotels, cafe, malls, and entire apartment building blocks.';

const PanelHeader = ({ children }) => (
  <div style={{
    background: '#1677ff', color: '#fff', fontSize: 13, fontWeight: 600,
    padding: '8px 14px', borderRadius: '6px 6px 0 0',
  }}>
    {children}
  </div>
);

const PanelBody = ({ children, style }) => (
  <div style={{
    border: '1px solid #d9d9d9', borderTop: 'none',
    borderRadius: '0 0 6px 6px', padding: 14, marginBottom: 20, ...style,
  }}>
    {children}
  </div>
);

const SectionLabel = ({ children }) => (
  <div style={{
    fontSize: 11, fontWeight: 700, color: '#888', letterSpacing: 1,
    marginBottom: 14, marginTop: 24,
  }}>
    {children}
  </div>
);

export default function PropertyUnitCreatePage() {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(true);
  const [propertyData, setPropertyData] = useState(null);
  const [amenities, setAmenities] = useState([]);
  const [amenitiesLoading, setAmenitiesLoading] = useState(false);
  const [selectedAmenityIds, setSelectedAmenityIds] = useState([]);
  const router = useRouter();
  const params = useParams();
  const propertyId = params.id;

  useEffect(() => {
    if (propertyId) loadProperty();
  }, [propertyId]);

  const loadProperty = async () => {
    try {
      const res = await propertyApi.get(propertyId);
      if (res.data.code === 200) {
        setPropertyData(res.data.data);
      }
    } catch {}
    finally { setFetching(false); }
    // Load unit amenities for default type (Residential)
    loadAmenities(1);
  };

  const loadAmenities = async (type = 1) => {
    setAmenitiesLoading(true);
    try {
      const res = await propertyApi.getOrgUnitAmenities(type);
      if (res.data.code === 200) setAmenities(res.data.data || []);
    } catch {}
    finally { setAmenitiesLoading(false); }
    setSelectedAmenityIds([]);
  };

  const handleValuesChange = (changedValues) => {
    if ('amenity_type' in changedValues) {
      loadAmenities(changedValues.amenity_type);
    }
  };

  const toggleAmenity = (id) => {
    setSelectedAmenityIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  const onFinish = async (values) => {
    try {
      setLoading(true);
      const res = await propertyApi.createUnit(propertyId, { ...values, amenityIds: selectedAmenityIds });
      if (res.data.code === 200) {
        message.success('Unit created successfully');
        router.push(`/property/${propertyId}/detail`);
      } else {
        message.error(res.data.message || 'Failed to create unit');
      }
    } catch (error) {
      message.error(error.response?.data?.message || 'Failed to create unit');
    } finally {
      setLoading(false);
    }
  };

  if (fetching) {
    return <MainLayout><div style={{ textAlign: 'center', padding: 80 }}><Spin size="large" /></div></MainLayout>;
  }

  const fullAddress = propertyData
    ? [propertyData.street_address, propertyData.city, propertyData.state, propertyData.country].filter(Boolean).join(', ')
    : '';

  return (
    <MainLayout>
      {/* Page header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 24 }}>
        <Button
          type="text" icon={<ArrowLeftOutlined />}
          onClick={() => router.push(`/property/${propertyId}/detail`)}
          style={{ padding: '0 4px' }}
        />
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Add Unit</h2>
      </div>

      <Form
        form={form}
        layout="vertical"
        onFinish={onFinish}
        onValuesChange={handleValuesChange}
        initialValues={{ amenity_type: 1, size_unit: 'sqft', smoking: false, laundry: false }}
        onFinishFailed={({ errorFields }) => message.error(errorFields?.[0]?.errors?.[0] || 'Please check required fields')}
      >
        <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start' }}>

          {/* ── LEFT COLUMN ─────────────────────────────────────────────── */}
          <div style={{ width: 300, flexShrink: 0 }}>

            {/* Currency (read-only, from property) */}
            <PanelHeader>Currency</PanelHeader>
            <PanelBody>
              <div style={{
                background: '#fff7e6', border: '1px solid #ffd591', borderRadius: 4,
                padding: '8px 12px', marginBottom: 12, fontSize: 12, color: '#d46b08',
              }}>
                You need to select the currency for this property. Please note, you will not be able to edit or change the currency once selected!
              </div>
              <Input value={propertyData?.currency || '—'} disabled />
            </PanelBody>

            {/* Status */}
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 6 }}>Status</div>
              <Select defaultValue="Active" disabled style={{ width: '100%' }}>
                <Select.Option value="Active">Active</Select.Option>
              </Select>
            </div>

            {/* Main Photo */}
            <PanelHeader>Main Photo</PanelHeader>
            <PanelBody>
              <div style={{
                width: '100%', height: 180, background: '#f5f5f5',
                border: '1px dashed #d9d9d9', borderRadius: 4,
                display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center', marginBottom: 10,
              }}>
                <div style={{ fontSize: 40, marginBottom: 8 }}>🏠</div>
                <div style={{ fontSize: 12, color: '#999' }}>No photo uploaded</div>
              </div>
              <Button icon={<UploadOutlined />} block>Upload Photo</Button>
            </PanelBody>

            {/* Gallery */}
            <PanelHeader>Gallery</PanelHeader>
            <PanelBody>
              <div style={{
                width: 64, height: 64, border: '1px dashed #d9d9d9',
                borderRadius: 6, display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center',
                cursor: 'pointer', color: '#999', fontSize: 11,
              }}>
                <PlusOutlined style={{ fontSize: 18, marginBottom: 4 }} />
                Upload
              </div>
            </PanelBody>

          </div>

          {/* ── RIGHT COLUMN ────────────────────────────────────────────── */}
          <div style={{ flex: 1, minWidth: 0 }}>

            {/* General Information */}
            <SectionLabel>GENERAL INFORMATION</SectionLabel>

            {/* Property name & address (read-only) */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px', marginBottom: 16 }}>
              <div>
                <div style={{ fontSize: 11, color: '#aaa', marginBottom: 2 }}>PROPERTY NAME</div>
                <div style={{ fontWeight: 500, fontSize: 13 }}>{propertyData?.display_name || '—'}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: '#aaa', marginBottom: 2 }}>ADDRESS</div>
                <div style={{ fontWeight: 500, fontSize: 13 }}>{fullAddress || '—'}</div>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
              <Form.Item
                name="name"
                label={<><span style={{ color: '#ff4d4f', marginRight: 4 }}>*</span>UNIT NAME</>}
                rules={[{ required: true, message: 'Please enter unit name' }]}
              >
                <Input placeholder="Please input unit name" maxLength={100} />
              </Form.Item>

              <Form.Item
                name="type"
                label={<><span style={{ color: '#ff4d4f', marginRight: 4 }}>*</span>UNIT TYPE</>}
                rules={[{ required: true, message: 'Please select unit type' }]}
              >
                <Select placeholder="Please select unit type">
                  <Select.Option value="apartment">Apartment</Select.Option>
                  <Select.Option value="condo">Condo</Select.Option>
                  <Select.Option value="house">House</Select.Option>
                  <Select.Option value="townhouse">Townhouse</Select.Option>
                  <Select.Option value="studio">Studio</Select.Option>
                  <Select.Option value="loft">Loft</Select.Option>
                  <Select.Option value="office">Office</Select.Option>
                  <Select.Option value="retail">Retail</Select.Option>
                  <Select.Option value="sharedRoom">Shared Room</Select.Option>
                  <Select.Option value="other">Other</Select.Option>
                </Select>
              </Form.Item>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '0 16px' }}>
              <Form.Item
                name="beds"
                label={<><span style={{ color: '#ff4d4f', marginRight: 4 }}>*</span>BEDROOMS</>}
                rules={[{ required: true, message: 'Required' }]}
              >
                <InputNumber min={0} placeholder="Please input bedrooms" style={{ width: '100%' }} />
              </Form.Item>

              <Form.Item
                name="baths"
                label={<><span style={{ color: '#ff4d4f', marginRight: 4 }}>*</span>BATHROOMS</>}
                rules={[{ required: true, message: 'Required' }]}
              >
                <InputNumber min={0} placeholder="Please input bathrooms" style={{ width: '100%' }} />
              </Form.Item>

              <Form.Item
                name="size"
                label={<><span style={{ color: '#ff4d4f', marginRight: 4 }}>*</span>SIZE</>}
                rules={[{ required: true, message: 'Required' }]}
              >
                <InputNumber
                  min={0} placeholder="Please input size" style={{ width: '100%' }}
                  addonAfter={
                    <Form.Item name="size_unit" noStyle>
                      <Select style={{ width: 70 }}>
                        <Select.Option value="sqm">sqm</Select.Option>
                        <Select.Option value="sqft">sqft</Select.Option>
                      </Select>
                    </Form.Item>
                  }
                />
              </Form.Item>

              <Form.Item name="parking" label="PARKING SPACES">
                <InputNumber min={0} placeholder="Please input parking spaces" style={{ width: '100%' }} />
              </Form.Item>
            </div>

            {/* Smoking / Laundry toggles */}
            <div style={{ display: 'flex', gap: 32, marginBottom: 24 }}>
              <Form.Item name="smoking" label="SMOKING" valuePropName="checked" style={{ marginBottom: 0 }}>
                <Switch />
              </Form.Item>
              <Form.Item name="laundry" label="LAUNDRY" valuePropName="checked" style={{ marginBottom: 0 }}>
                <Switch />
              </Form.Item>
            </div>

            {/* Amenity Type */}
            <SectionLabel>Amenity Type</SectionLabel>
            <Form.Item name="amenity_type">
              <Radio.Group style={{ width: '100%' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  {[
                    { value: 1, label: 'RESIDENTIAL PROPERTY', desc: RESIDENTIAL_DESC },
                    { value: 2, label: 'COMMERCIAL PROPERTY',  desc: COMMERCIAL_DESC  },
                  ].map(opt => (
                    <Radio.Button
                      key={opt.value}
                      value={opt.value}
                      style={{
                        height: 'auto', padding: '14px 16px',
                        whiteSpace: 'normal', lineHeight: 'normal',
                        textAlign: 'left', borderRadius: 6,
                      }}
                    >
                      <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 6 }}>{opt.label}</div>
                      <div style={{ fontSize: 11, color: '#888', fontWeight: 400, lineHeight: 1.5 }}>
                        {opt.desc}
                      </div>
                    </Radio.Button>
                  ))}
                </div>
              </Radio.Group>
            </Form.Item>

            {/* Interior Amenities */}
            <SectionLabel>Interior Amenities</SectionLabel>
            {amenitiesLoading ? (
              <Spin size="small" />
            ) : amenities.length === 0 ? (
              <div style={{ color: '#bbb', fontSize: 13, marginBottom: 16 }}>
                No amenities configured for this type.
              </div>
            ) : (
              <div style={{
                display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)',
                gap: '10px 0', marginBottom: 16,
              }}>
                {amenities.map(a => (
                  <Checkbox
                    key={a.id}
                    checked={selectedAmenityIds.includes(a.id)}
                    onChange={() => toggleAmenity(a.id)}
                  >
                    <span style={{ fontSize: 12 }}>{a.display_name}</span>
                  </Checkbox>
                ))}
              </div>
            )}

            {/* Amenity Details */}
            <SectionLabel>AMENITY DETAILS</SectionLabel>
            <Form.Item name="amenity_detail">
              <Input.TextArea rows={3} placeholder="Please input amenity details" />
            </Form.Item>

            {/* Unit Access Information */}
            <SectionLabel>UNIT ACCESS INFORMATION</SectionLabel>
            <Form.Item name="access_information">
              <Input.TextArea rows={3} placeholder="Please input unit access information" />
            </Form.Item>

            {/* Key Codes */}
            <SectionLabel>KEY CODES</SectionLabel>
            <Form.Item name="key_code">
              <Input placeholder="Please input key codes" maxLength={100} />
            </Form.Item>

            {/* WiFi Information */}
            <SectionLabel>WIFI INFORMATION</SectionLabel>
            <Form.Item name="wifi_information">
              <Input.TextArea rows={3} placeholder="Please input wifi information" />
            </Form.Item>

            {/* Payment Information */}
            <SectionLabel>PAYMENT INFORMATION</SectionLabel>
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item name="account_name" label="Bank Account Name">
                  <Input placeholder="Bank account name" />
                </Form.Item>
              </Col>
            </Row>
            <Form.Item name="bank_details">
              <Input.TextArea rows={3} placeholder="Bank name, account number, routing info..." />
            </Form.Item>

            {/* Internal Notes */}
            <SectionLabel>INTERNAL NOTES</SectionLabel>
            <Form.Item name="internal_note">
              <Input.TextArea rows={3} placeholder="Please input internal notes" />
            </Form.Item>

            {/* Rent Range */}
            <SectionLabel>RENT RANGE</SectionLabel>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
              <Form.Item name="rent_price_min" label="Minimum Rent">
                <InputNumber min={0} placeholder="Minimum Rent" style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item name="rent_price_max" label="Maximum Rent">
                <InputNumber min={0} placeholder="Maximum Rent" style={{ width: '100%' }} />
              </Form.Item>
            </div>

            {/* Document upload placeholder */}
            <div style={{
              border: '1px dashed #d9d9d9', borderRadius: 6, padding: 28,
              textAlign: 'center', marginTop: 4,
            }}>
              <UploadOutlined style={{ fontSize: 28, color: '#1677ff', marginBottom: 8, display: 'block' }} />
              <div style={{ fontWeight: 500, marginBottom: 4 }}>Upload</div>
              <div style={{ fontSize: 12, color: '#999' }}>Store documents and templates</div>
            </div>

          </div>
        </div>

        {/* ── Bottom action buttons ─────────────────────────────────────── */}
        <div style={{
          display: 'flex', justifyContent: 'space-between',
          marginTop: 32, paddingTop: 16, borderTop: '1px solid #f0f0f0',
        }}>
          <Button onClick={() => router.push(`/property/${propertyId}/detail`)} style={{ minWidth: 120 }}>
            CANCEL
          </Button>
          <Button type="primary" htmlType="submit" loading={loading} style={{ minWidth: 120 }}>
            SUBMIT
          </Button>
        </div>
      </Form>
    </MainLayout>
  );
}
