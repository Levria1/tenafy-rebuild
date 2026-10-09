'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import {
  Form, Input, Button, Select, message, Spin, Checkbox, Radio, Upload,
} from 'antd';
import { ArrowLeftOutlined, UploadOutlined, PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import MainLayout from '../../../../components/Layout';
import { property as propertyApi, file as fileApi } from '../../../../lib/api';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

// ─── Blue panel header (matches original screenshot) ─────────────────────────
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

const RESIDENTIAL_DESC = 'Residential Properties include single family homes where there is only one rental unit associated to the address, and also include houses, single condominium units, single mobile homes, co-ops, townhouses, duplexes, triple-deckers, quadplexes, high-value homes, multi-generational and vacation homes.';
const COMMERCIAL_DESC  = 'Commercial property usually refers to buildings that house businesses, as well as larger residential rental properties. Commercial properties include properties such as retail properties (store fronts), offices, serviced offices, hotels, cafe, malls, and entire apartment building blocks.';

export default function PropertyEditPage() {
  const router = useRouter();
  const params = useParams();
  const [form] = Form.useForm();
  const [fetching, setFetching] = useState(true);
  const [loading, setLoading] = useState(false);
  const [propertyData, setPropertyData] = useState(null);
  const [amenities, setAmenities] = useState([]);
  const [selectedAmenityIds, setSelectedAmenityIds] = useState([]);
  const [photoFileId, setPhotoFileId] = useState(null);
  const [photoPreview, setPhotoPreview] = useState(null);
  const [galleryFiles, setGalleryFiles] = useState([]);

  useEffect(() => {
    if (params.id) loadAll();
  }, [params.id]);

  const loadAll = async () => {
    try {
      const [propRes, amenRes] = await Promise.all([
        propertyApi.get(params.id),
        propertyApi.getPropertyAmenities(params.id).catch(() => ({ data: { data: [] } })),
      ]);

      if (propRes.data.code === 200) {
        const d = propRes.data.data;
        setPropertyData(d);
        if (d.photo) {
          setPhotoFileId(d.photo);
          setPhotoPreview(`${API_URL}/api/file/preview/${d.photo}`);
        }
        if (d.gallery && d.gallery.length > 0) {
          setGalleryFiles(d.gallery.map((g, i) => ({
            fileId: g.file_id, url: `${API_URL}/api/file/preview/${g.file_id}`, uid: `existing-${i}`,
          })));
        }
        form.setFieldsValue({
          display_name:          d.display_name,
          street_address:        d.street_address,
          city:                  d.city,
          state:                 d.state,
          country:               d.country,
          zip_code:              d.zip_code,
          district:              d.district,
          year_of_built:         d.year_of_built,
          currency:              d.currency,
          type:                  d.type || 1,
          status:                d.status ?? 1,
          mls:                   d.mls,
          landlord_name:         d.landlord_name,
          landlord_br_no:        d.landlord_br_no,
          payment_instructions:  d.payment_instructions,
          notes:                 d.notes,
          listing_url:           d.listing_url,
        });
      }

      if (amenRes.data.code === 200) {
        const list = amenRes.data.data || [];
        setAmenities(list);
        setSelectedAmenityIds(list.filter(a => Number(a.selected) === 1).map(a => a.id));
      }
    } catch (err) {
      message.error('Failed to load property');
      router.push('/property');
    } finally {
      setFetching(false);
    }
  };

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
      const res = await propertyApi.update(params.id, {
        ...values,
        amenityIds: selectedAmenityIds,
        photo: photoFileId,
        galleryFileIds: galleryFiles.map(g => g.fileId),
      });
      if (res.data.code === 200) {
        message.success('Property updated successfully');
        router.push(`/property/${params.id}/detail`);
      } else {
        message.error(res.data.message || 'Failed to update property');
      }
    } catch (err) {
      message.error(err.response?.data?.message || 'Failed to update property');
    } finally {
      setLoading(false);
    }
  };

  const toggleAmenity = (id) => {
    setSelectedAmenityIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  if (fetching) {
    return <MainLayout><div style={{ textAlign: 'center', padding: 80 }}><Spin size="large" /></div></MainLayout>;
  }

  const currencyLocked = !!propertyData?.currency;

  return (
    <MainLayout>
      {/* Page header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 24 }}>
        <Button
          type="text" icon={<ArrowLeftOutlined />}
          onClick={() => router.push(`/property/${params.id}/detail`)}
          style={{ padding: '0 4px' }}
        />
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>
          Edit Property: {propertyData?.display_name}
        </h2>
      </div>

      <Form form={form} layout="vertical" onFinish={onFinish} onFinishFailed={({ errorFields }) => message.error(errorFields?.[0]?.errors?.[0] || 'Please check required fields')}>
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
              <Form.Item name="currency" style={{ marginBottom: 0 }}>
                <Select disabled={currencyLocked} placeholder="Select currency" showSearch>
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
                width: '100%', height: 180, background: '#f5f5f5',
                border: '1px dashed #d9d9d9', borderRadius: 4,
                display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center', marginBottom: 10,
                overflow: 'hidden',
              }}>
                {photoPreview ? (
                  <img src={photoPreview} alt="Property" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  <>
                    <div style={{ fontSize: 40, marginBottom: 8 }}>🏠</div>
                    <div style={{ fontSize: 12, color: '#999' }}>No photo uploaded</div>
                  </>
                )}
              </div>
              <Upload showUploadList={false} customRequest={handlePhotoUpload} accept="image/*">
                <Button icon={<UploadOutlined />} block>{photoFileId ? 'Change Photo' : 'Upload Photo'}</Button>
              </Upload>
              {photoFileId && (
                <Button type="text" danger size="small" style={{ marginTop: 4, width: '100%' }}
                  onClick={() => { setPhotoFileId(null); setPhotoPreview(null); }}>
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
                    <div onClick={() => removeGalleryFile(g.uid)} style={{
                      position: 'absolute', top: 2, right: 2, width: 18, height: 18,
                      background: 'rgba(0,0,0,0.5)', borderRadius: '50%', display: 'flex',
                      alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
                    }}>
                      <DeleteOutlined style={{ color: '#fff', fontSize: 10 }} />
                    </div>
                  </div>
                ))}
                <Upload showUploadList={false} customRequest={handleGalleryUpload} accept="image/*" multiple>
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
            <SectionLabel>GENERAL INFORMATION</SectionLabel>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
              <Form.Item
                name="display_name"
                label={<><span style={{ color: '#ff4d4f', marginRight: 4 }}>*</span>Property Name</>}
                rules={[{ required: true, message: 'Please enter property name' }]}
              >
                <Input placeholder="Property name" />
              </Form.Item>

              <Form.Item name="year_of_built" label="Year Built">
                <Input placeholder="e.g. 2005" />
              </Form.Item>

              <Form.Item name="country" label="Country">
                <Input placeholder="Country" />
              </Form.Item>

              <Form.Item name="district" label="District">
                <Input placeholder="District" />
              </Form.Item>

              <Form.Item name="city" label="City">
                <Input placeholder="City" />
              </Form.Item>

              <Form.Item name="state" label="State / Province">
                <Input placeholder="State / Province" />
              </Form.Item>

              <Form.Item name="zip_code" label="Zip / Postal Code">
                <Input placeholder="Zip / Postal Code" />
              </Form.Item>

              <Form.Item name="mls" label="MLS #">
                <Input placeholder="MLS number" />
              </Form.Item>
            </div>

            {/* Address — full width */}
            <Form.Item name="street_address" label="Address">
              <Input placeholder="Street address" />
            </Form.Item>

            {/* Property Type */}
            <SectionLabel>PROPERTY TYPE</SectionLabel>
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
            <SectionLabel>PROPERTY AMENITIES</SectionLabel>
            {amenities.length === 0 ? (
              <div style={{ color: '#bbb', fontSize: 13, marginBottom: 16 }}>
                No amenities configured. Add them via Settings → Amenity.
              </div>
            ) : (
              <div style={{
                display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)',
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
            <SectionLabel>BILLING &amp; PAYMENT</SectionLabel>
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
            <Form.Item name="payment_instructions" label="Payment Instructions">
              <Input.TextArea rows={3} placeholder="e.g. Bank account details, accepted payment methods..." />
            </Form.Item>

            {/* Notes */}
            <SectionLabel>NOTES</SectionLabel>
            <Form.Item name="notes">
              <Input.TextArea rows={4} placeholder="Please input your notes here" />
            </Form.Item>

            {/* Public website listing URL */}
            <SectionLabel>PUBLIC LISTING URL</SectionLabel>
            <Form.Item
              name="listing_url"
              extra="The page on your public website (e.g. taneresidence.com/properties/...) where prospects can see photos and details. The chatbot links here when recommending this property."
              rules={[{
                pattern: /^https?:\/\/.+/i,
                message: 'Must start with http:// or https://',
              }]}
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
          <Button onClick={() => router.push(`/property/${params.id}/detail`)}>
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
