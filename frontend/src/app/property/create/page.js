'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Form, Input, Button, Select, message, Spin, Checkbox, Radio, Upload,
} from 'antd';
import { ArrowLeftOutlined, UploadOutlined, PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import MainLayout from '../../../components/Layout';
import { property as propertyApi, file as fileApi } from '../../../lib/api';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

// ─── Shared layout components ─────────────────────────────────────────────────
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

const RESIDENTIAL_DESC = 'Residential Properties include single family homes where there is only one rental unit associated to the address, and also include houses, single condominium units, single mobile homes, co-ops, townhouses, duplexes, triple-deckers, quadplexes, high-value homes, multi-generational and vacation homes.';
const COMMERCIAL_DESC  = 'Commercial property usually refers to buildings that house businesses, as well as larger residential rental properties. Commercial properties include properties such as retail properties (store fronts), offices, serviced offices, hotels, cafe, malls, and entire apartment building blocks.';

export default function PropertyCreatePage() {
  const router = useRouter();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [amenities, setAmenities] = useState([]);
  const [selectedAmenityIds, setSelectedAmenityIds] = useState([]);
  const [amenitiesLoading, setAmenitiesLoading] = useState(true);
  const [photoFileId, setPhotoFileId] = useState(null);
  const [photoPreview, setPhotoPreview] = useState(null);
  const [galleryFiles, setGalleryFiles] = useState([]); // [{ fileId, url, uid }]

  // Load amenities filtered by the given property type (1=Residential, 2=Commercial)
  const loadAmenities = async (type = 1) => {
    setAmenitiesLoading(true);
    try {
      const res = await propertyApi.getOrgPropertyAmenities(type);
      if (res.data.code === 200) setAmenities(res.data.data || []);
    } catch {}
    finally { setAmenitiesLoading(false); }
    // Clear amenity selections whenever type changes
    setSelectedAmenityIds([]);
  };

  useEffect(() => {
    loadAmenities(1); // default: Residential
  }, []);

  const handlePhotoUpload = async (info) => {
    const { file: f, onSuccess, onError } = info;
    try {
      const formData = new FormData();
      formData.append('file', f);
      const res = await fileApi.upload(formData);
      if (res.data.code === 200) {
        const uploaded = res.data.data;
        const fid = uploaded.id || uploaded.fileId;
        setPhotoFileId(fid);
        setPhotoPreview(URL.createObjectURL(f));
        onSuccess(uploaded);
      } else { onError(new Error('Upload failed')); }
    } catch (e) { onError(e); }
  };

  const handleGalleryUpload = async (info) => {
    const { file: f, onSuccess, onError } = info;
    try {
      const formData = new FormData();
      formData.append('file', f);
      const res = await fileApi.upload(formData);
      if (res.data.code === 200) {
        const uploaded = res.data.data;
        const fid = uploaded.id || uploaded.fileId;
        setGalleryFiles(prev => [...prev, { fileId: fid, url: URL.createObjectURL(f), uid: f.uid }]);
        onSuccess(uploaded);
      } else { onError(new Error('Upload failed')); }
    } catch (e) { onError(e); }
  };

  const removeGalleryFile = (uid) => {
    setGalleryFiles(prev => prev.filter(g => g.uid !== uid));
  };

  const onFinish = async (values) => {
    try {
      setLoading(true);
      const res = await propertyApi.create({
        ...values,
        amenityIds: selectedAmenityIds,
        photo: photoFileId,
        galleryFileIds: galleryFiles.map(g => g.fileId),
      });
      if (res.data.code === 200) {
        message.success('Property created successfully');
        router.push('/property');
      } else {
        message.error(res.data.message || 'Failed to create property');
      }
    } catch (err) {
      message.error(err.response?.data?.message || 'Failed to create property');
    } finally {
      setLoading(false);
    }
  };

  const toggleAmenity = (id) => {
    setSelectedAmenityIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  // When property type radio changes, reload amenities for that type
  const handleValuesChange = (changedValues) => {
    if ('type' in changedValues) {
      loadAmenities(changedValues.type);
    }
  };

  return (
    <MainLayout>
      {/* Page header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 24 }}>
        <Button
          type="text" icon={<ArrowLeftOutlined />}
          onClick={() => router.push('/property')}
          style={{ padding: '0 4px' }}
        />
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Add Property</h2>
      </div>

      <Form
        form={form}
        layout="vertical"
        onFinish={onFinish}
        onValuesChange={handleValuesChange}
        initialValues={{ type: 1, status: 1 }}
      >
        <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start' }}>

          {/* ── LEFT COLUMN ─────────────────────────────────────────────── */}
          <div style={{ width: 300, flexShrink: 0 }}>

            {/* Currency */}
            <PanelHeader>Currency</PanelHeader>
            <PanelBody>
              <div style={{
                background: '#fff7e6', border: '1px solid #ffd591', borderRadius: 4,
                padding: '8px 12px', marginBottom: 12, fontSize: 12, color: '#d46b08',
              }}>
                You need to select the currency for this property. Please note, you will not be able to edit or change the currency once selected!
              </div>
              <Form.Item
                name="currency"
                rules={[{ required: true, message: 'Please select a currency' }]}
                style={{ marginBottom: 0 }}
              >
                <Select placeholder="Select currency" showSearch>
                  <Select.Option value="USD">US Dollar (USD)</Select.Option>
                  <Select.Option value="EUR">Euro (EUR)</Select.Option>
                  <Select.Option value="GBP">British Pound (GBP)</Select.Option>
                  <Select.Option value="HKD">Hong Kong Dollar (HK$)</Select.Option>
                  <Select.Option value="CAD">Canadian Dollar (CAD)</Select.Option>
                  <Select.Option value="AUD">Australian Dollar (AUD)</Select.Option>
                  <Select.Option value="SGD">Singapore Dollar (SGD)</Select.Option>
                  <Select.Option value="JPY">Japanese Yen (JPY)</Select.Option>
                </Select>
              </Form.Item>
            </PanelBody>

            {/* Property Status */}
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 6 }}>Property Status</div>
              <Form.Item name="status" style={{ marginBottom: 0 }}>
                <Select>
                  <Select.Option value={1}>Active</Select.Option>
                  <Select.Option value={0}>Inactive</Select.Option>
                </Select>
              </Form.Item>
            </div>

            {/* Main Photo */}
            <PanelHeader>Main Photo</PanelHeader>
            <PanelBody>
              <div style={{
                width: '100%', height: 260, background: '#f5f5f5',
                border: '1px dashed #d9d9d9', borderRadius: 4,
                display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center', marginBottom: 10,
                overflow: 'hidden',
              }}>
                {photoPreview ? (
                  <img src={photoPreview} alt="Property" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  <>
                    <div style={{ fontSize: 48, marginBottom: 8 }}>🏠</div>
                    <div style={{ fontSize: 12, color: '#999' }}>No photo uploaded</div>
                  </>
                )}
              </div>
              <Upload
                showUploadList={false}
                customRequest={handlePhotoUpload}
                accept="image/*"
              >
                <Button icon={<UploadOutlined />} block>{photoFileId ? 'Change Photo' : 'Upload Photo'}</Button>
              </Upload>
              {photoFileId && (
                <Button
                  type="text" danger size="small"
                  style={{ marginTop: 4, width: '100%' }}
                  onClick={() => { setPhotoFileId(null); setPhotoPreview(null); }}
                >
                  Remove Photo
                </Button>
              )}
            </PanelBody>

            {/* Gallery */}
            <PanelHeader>Gallery</PanelHeader>
            <PanelBody>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {galleryFiles.map(g => (
                  <div key={g.uid} style={{ position: 'relative', width: 64, height: 64, borderRadius: 6, overflow: 'hidden', border: '1px solid #d9d9d9' }}>
                    <img src={g.url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    <div
                      onClick={() => removeGalleryFile(g.uid)}
                      style={{
                        position: 'absolute', top: 2, right: 2, width: 18, height: 18,
                        background: 'rgba(0,0,0,0.5)', borderRadius: '50%', display: 'flex',
                        alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
                      }}
                    >
                      <DeleteOutlined style={{ color: '#fff', fontSize: 10 }} />
                    </div>
                  </div>
                ))}
                <Upload
                  showUploadList={false}
                  customRequest={handleGalleryUpload}
                  accept="image/*"
                  multiple
                >
                  <div style={{
                    width: 64, height: 64, border: '1px dashed #d9d9d9',
                    borderRadius: 6, display: 'flex', flexDirection: 'column',
                    alignItems: 'center', justifyContent: 'center',
                    cursor: 'pointer', color: '#999', fontSize: 11,
                  }}>
                    <PlusOutlined style={{ fontSize: 18, marginBottom: 4 }} />
                    Upload
                  </div>
                </Upload>
              </div>
            </PanelBody>

          </div>

          {/* ── RIGHT COLUMN ────────────────────────────────────────────── */}
          <div style={{ flex: 1, minWidth: 0 }}>

            {/* General Information */}
            <div style={{ fontSize: 13, fontWeight: 700, color: '#888', letterSpacing: 1, marginBottom: 14 }}>
              GENERAL INFORMATION
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
              <Form.Item
                name="display_name"
                label={<><span style={{ color: '#ff4d4f', marginRight: 4 }}>*</span> Property Name</>}
                rules={[{ required: true, message: 'Please enter property name' }]}
              >
                <Input placeholder="Please input your property name" />
              </Form.Item>

              <Form.Item name="year_of_built" label="Year Built">
                <Input placeholder="Select your built" />
              </Form.Item>

              <Form.Item
                name="country"
                label={<><span style={{ color: '#ff4d4f', marginRight: 4 }}>*</span> Country</>}
                rules={[{ required: true, message: 'Please enter country' }]}
              >
                <Input placeholder="Please input country" />
              </Form.Item>

              <Form.Item name="district" label="District">
                <Input placeholder="Please input district" />
              </Form.Item>

              <Form.Item
                name="city"
                label={<><span style={{ color: '#ff4d4f', marginRight: 4 }}>*</span> City</>}
                rules={[{ required: true, message: 'Please enter city' }]}
              >
                <Input placeholder="Please input city" />
              </Form.Item>

              <Form.Item name="state" label="State / Province">
                <Input placeholder="Please input province" />
              </Form.Item>
            </div>

            {/* Address + ZIP in a 3:1 split */}
            <div style={{ display: 'grid', gridTemplateColumns: '3fr 1fr', gap: '0 16px' }}>
              <Form.Item
                name="street_address"
                label={<><span style={{ color: '#ff4d4f', marginRight: 4 }}>*</span> Address</>}
                rules={[{ required: true, message: 'Please enter address' }]}
              >
                <Input placeholder="Please input address" />
              </Form.Item>
              <Form.Item name="zip_code" label="ZIP">
                <Input placeholder="Please input zip code" />
              </Form.Item>
            </div>

            {/* Property Type */}
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14, marginTop: 4 }}>
              Property Type
            </div>
            <Form.Item name="type">
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

            {/* Property Amenities */}
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14, marginTop: 8 }}>
              Property Amenities
            </div>
            {amenitiesLoading ? (
              <Spin size="small" />
            ) : amenities.length === 0 ? (
              <div style={{ color: '#bbb', fontSize: 13, marginBottom: 16 }}>
                No amenities configured. Add them via Settings → Amenity.
              </div>
            ) : (
              <div style={{
                display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)',
                gap: '10px 0', marginBottom: 16,
              }}>
                {amenities.map(a => (
                  <Checkbox
                    key={a.id}
                    checked={selectedAmenityIds.includes(a.id)}
                    onChange={() => toggleAmenity(a.id)}
                  >
                    {a.display_name}
                  </Checkbox>
                ))}
              </div>
            )}

            {/* Billing & Payment */}
            <div style={{ fontSize: 13, fontWeight: 700, color: '#888', letterSpacing: 1, marginBottom: 14, marginTop: 12 }}>
              BILLING &amp; PAYMENT
            </div>
            <Form.Item
              name="landlord_name"
              label="Landlord / Legal Entity"
              extra="Prints as the company name on invoices and receipts for this property. A unit's own account name overrides it."
            >
              <Input placeholder="e.g. ACJ Ventures Limited" />
            </Form.Item>
            <Form.Item
              name="landlord_br_no"
              label="Business Registration (BR) No."
              extra="Used when stamping tenancy agreements on IRD eTAX."
            >
              <Input placeholder="e.g. 12345678" />
            </Form.Item>

            {/* Payment Instructions */}
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10, marginTop: 8 }}>
              Payment Instructions
            </div>
            <Form.Item name="payment_instructions">
              <Input.TextArea rows={3} placeholder="e.g. Bank account details, accepted payment methods..." />
            </Form.Item>

            {/* Notes */}
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10, marginTop: 8 }}>Notes</div>
            <Form.Item name="notes">
              <Input.TextArea rows={4} placeholder="Please input your notes here" />
            </Form.Item>

            {/* Public website listing URL */}
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10, marginTop: 8 }}>Public Listing URL</div>
            <Form.Item
              name="listing_url"
              extra="The page on your public website where prospects can see photos (e.g. taneresidence.com/properties/...). The chatbot will link here."
              rules={[{ pattern: /^https?:\/\/.+/i, message: 'Must start with http:// or https://' }]}
            >
              <Input placeholder="https://taneresidence.com/properties/sun-gardens" />
            </Form.Item>

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
          <Button onClick={() => router.push('/property')} style={{ minWidth: 120 }}>
            Cancel
          </Button>
          <Button type="primary" htmlType="submit" loading={loading} style={{ minWidth: 120 }}>
            SUBMIT
          </Button>
        </div>
      </Form>
    </MainLayout>
  );
}
