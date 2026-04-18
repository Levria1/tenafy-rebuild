'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Card, Form, Input, InputNumber, Select, Button, message, Row, Col, Switch, Checkbox, Spin, Upload } from 'antd';
import { ArrowLeftOutlined, CheckOutlined, CloseOutlined, UploadOutlined, PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import MainLayout from '../../../../../../components/Layout';
import { property as propertyApi, file as fileApi } from '../../../../../../lib/api';
import { bedsSelectOptions, unitTypeOptions } from '../../../../../../lib/format';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

const { TextArea } = Input;

const sectionStyle = { background: '#fafafa', padding: '16px 20px', borderRadius: 8, marginBottom: 16, border: '1px solid #f0f0f0' };
const sectionTitle = { fontSize: 12, fontWeight: 700, letterSpacing: '0.5px', color: '#333', textTransform: 'uppercase', marginBottom: 12 };

export default function UnitEditPage() {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [amenities, setAmenities] = useState([]);
  const [selectedAmenityIds, setSelectedAmenityIds] = useState([]);
  const [photoFileId, setPhotoFileId] = useState(null);
  const [photoPreview, setPhotoPreview] = useState(null);
  const [galleryFiles, setGalleryFiles] = useState([]);
  const router = useRouter();
  const params = useParams();
  const propertyId = params.id;
  const unitId = params.unitid;

  useEffect(() => {
    loadUnit();
  }, [unitId]);

  const loadUnit = async () => {
    try {
      const [unitRes, amenRes] = await Promise.all([
        propertyApi.getUnit(unitId),
        propertyApi.getUnitAmenities(unitId),
      ]);
      if (unitRes.data.code === 200) {
        const d = unitRes.data.data;
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
          name: d.name,
          type: d.type || undefined,
          size: d.size ? Number(d.size) : undefined,
          size_unit: d.size_unit || 'sqft',
          beds: d.beds != null ? Number(d.beds) : undefined,
          baths: d.baths != null ? Number(d.baths) : undefined,
          // Laundry + Smoking no longer shown on the form; loaded here so
          // the submit payload preserves existing DB values instead of nulling them.
          smoking: d.smoking ? true : false,
          laundry: d.laundry ? true : false,
          parking: d.parking != null ? Number(d.parking) : undefined,
          amenity_detail: d.amenity_detail || '',
          access_information: d.access_information || '',
          key_code: d.key_code || '',
          wifi_information: d.wifi_information || '',
          account_name: d.account_name || '',
          bank_details: d.bank_details || '',
          internal_note: d.internal_note || '',
          listing_url: d.listing_url || '',
          rent_price_min: d.rent_price_min ? Number(d.rent_price_min) : undefined,
          rent_price_max: d.rent_price_max ? Number(d.rent_price_max) : undefined,
          deposit_price: d.deposit_price ? Number(d.deposit_price) : undefined,
          charge_method: d.charge_method != null ? Number(d.charge_method) : 0,
          fee: d.fee ? Number(d.fee) : undefined,
          active_status: d.active_status != null ? Number(d.active_status) : 1,
        });
      }
      if (amenRes.data.code === 200) {
        const amenList = amenRes.data.data || [];
        setAmenities(amenList);
        setSelectedAmenityIds(amenList.filter(a => Number(a.selected) === 1).map(a => a.id.toString()));
      }
    } catch (error) {
      message.error('Failed to load unit');
    } finally {
      setInitialLoading(false);
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
      await Promise.all([
        propertyApi.updateUnit(unitId, {
          ...values,
          smoking: values.smoking ? 1 : 0,
          laundry: values.laundry ? 1 : 0,
          photo: photoFileId,
          galleryFileIds: galleryFiles.map(g => g.fileId),
        }),
        propertyApi.updateUnitAmenities(unitId, { amenityIds: selectedAmenityIds }),
      ]);
      message.success('Unit updated successfully');
      router.push(`/property/${propertyId}/unit/${unitId}`);
    } catch (error) {
      message.error(error?.response?.data?.message || 'Failed to update unit');
    } finally {
      setLoading(false);
    }
  };

  const toggleAmenity = (amenityId) => {
    const id = amenityId.toString();
    setSelectedAmenityIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
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
                <Form.Item noStyle shouldUpdate={(prev, cur) => prev.type !== cur.type}>
                  {({ getFieldValue }) => (
                    <Form.Item name="type" label="Type">
                      <Select
                        placeholder="Pick a type"
                        options={unitTypeOptions(getFieldValue('type'))}
                      />
                    </Form.Item>
                  )}
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
                <Form.Item noStyle shouldUpdate={(prev, cur) => prev.beds !== cur.beds}>
                  {({ getFieldValue }) => (
                    <Form.Item name="beds" label="Bedrooms">
                      <Select
                        placeholder="Pick a layout"
                        options={bedsSelectOptions(getFieldValue('beds'))}
                        style={{ width: '100%' }}
                      />
                    </Form.Item>
                  )}
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
                <Form.Item name="active_status" label="Active Status">
                  <Select>
                    <Select.Option value={1}>Active</Select.Option>
                    <Select.Option value={0}>Inactive</Select.Option>
                  </Select>
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

          {/* INTERIOR AMENITIES */}
          {amenities.length > 0 && (
            <div style={sectionStyle}>
              <div style={sectionTitle}>Interior Amenities</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 24px' }}>
                {amenities.map((a) => {
                  const isSelected = selectedAmenityIds.includes(a.id.toString());
                  return (
                    <div
                      key={a.id}
                      onClick={() => toggleAmenity(a.id)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 6, minWidth: 180,
                        cursor: 'pointer', padding: '4px 8px', borderRadius: 4,
                        background: isSelected ? '#f6ffed' : 'transparent',
                        border: `1px solid ${isSelected ? '#b7eb8f' : '#d9d9d9'}`,
                      }}
                    >
                      {isSelected ? (
                        <CheckOutlined style={{ color: '#52c41a', fontSize: 12 }} />
                      ) : (
                        <CloseOutlined style={{ color: '#ff4d4f', fontSize: 12 }} />
                      )}
                      <span style={{ fontSize: 13, color: isSelected ? '#262626' : '#999' }}>{a.display_name}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

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
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item name="account_name" label="Bank Account Name">
                  <Input placeholder="e.g. John Smith, ABC Company Ltd" />
                </Form.Item>
              </Col>
            </Row>
            <Form.Item name="bank_details" label="Bank Details">
              <TextArea rows={3} placeholder="Bank name, account number, routing info..." />
            </Form.Item>
            <Form.Item name="internal_note" label="Internal Notes">
              <TextArea rows={3} placeholder="Notes for internal use only..." />
            </Form.Item>
            <Form.Item
              name="listing_url"
              label="Public Listing URL (this unit)"
              extra="Optional. The page on your public website for THIS specific unit. If blank, the chatbot falls back to the property-level URL."
              rules={[{ pattern: /^https?:\/\/.+/i, message: 'Must start with http:// or https://' }]}
            >
              <Input placeholder="https://taneresidence.com/apartments/sun-gardens-3b" />
            </Form.Item>
          </div>

          {/* PHOTO & GALLERY */}
          <div style={sectionStyle}>
            <div style={sectionTitle}>Photos</div>
            <Row gutter={24}>
              <Col span={12}>
                <div style={{ fontWeight: 500, marginBottom: 8, fontSize: 13 }}>Main Photo</div>
                <div style={{
                  width: '100%', height: 160, background: '#f5f5f5',
                  border: '1px dashed #d9d9d9', borderRadius: 4,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  marginBottom: 8, overflow: 'hidden',
                }}>
                  {photoPreview ? (
                    <img src={photoPreview} alt="Unit" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  ) : (
                    <div style={{ color: '#999', fontSize: 12 }}>No photo</div>
                  )}
                </div>
                <Upload showUploadList={false} customRequest={handlePhotoUpload} accept="image/*">
                  <Button icon={<UploadOutlined />} size="small">{photoFileId ? 'Change' : 'Upload'}</Button>
                </Upload>
                {photoFileId && (
                  <Button type="text" danger size="small" style={{ marginLeft: 8 }}
                    onClick={() => { setPhotoFileId(null); setPhotoPreview(null); }}>
                    Remove
                  </Button>
                )}
              </Col>
              <Col span={12}>
                <div style={{ fontWeight: 500, marginBottom: 8, fontSize: 13 }}>Gallery</div>
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
              </Col>
            </Row>
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
