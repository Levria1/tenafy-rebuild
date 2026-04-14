'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Form, Input, Button, Select, message, DatePicker, Radio, Switch, Upload } from 'antd';
import { UploadOutlined, CloudUploadOutlined, UserOutlined } from '@ant-design/icons';
import MainLayout from '../../../../components/Layout';
import useIsMobile from '../../../../hooks/useIsMobile';
import { tenant, settings } from '../../../../lib/api';

const sectionTitleStyle = {
  fontSize: 13,
  fontWeight: 600,
  letterSpacing: '0.5px',
  color: '#333',
  marginBottom: 16,
  borderBottom: '1px solid #e8e8e8',
  paddingBottom: 8,
};

const labelStyle = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.5px',
  color: '#555',
  textTransform: 'uppercase',
  marginBottom: 4,
};

const requiredStar = { color: '#d4880f', marginRight: 2 };

export default function TenantCreatePage() {
  const router = useRouter();
  const { isMobile } = useIsMobile();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [displayAsCompany, setDisplayAsCompany] = useState(false);
  const [leadSources, setLeadSources] = useState([]);

  useEffect(() => {
    settings.getLeadSources().then(res => {
      if (res.data.code === 200) setLeadSources(res.data.data || []);
    }).catch(() => {});
  }, []);

  const onFinish = async (values) => {
    try {
      setLoading(true);
      const payload = {
        ...values,
        birth_date: values.birth_date ? values.birth_date.format('YYYY-MM-DD') : null,
        type: displayAsCompany ? 1 : 0,
        sex: values.sex ?? 0,
        status: values.status ?? 1,
      };
      const response = await tenant.create(payload);
      if (response.data.code === 200) {
        message.success('Tenant created successfully');
        router.push('/contacts/tenants');
      } else {
        message.error(response.data.message || 'Failed to create tenant');
      }
    } catch (error) {
      message.error(error.response?.data?.message || 'Failed to create tenant');
    } finally {
      setLoading(false);
    }
  };

  const Label = ({ required, children }) => (
    <div style={labelStyle}>
      {required && <span style={requiredStar}>*</span>}
      {children}
    </div>
  );

  return (
    <MainLayout>
      <div style={{ padding: '0 0 24px 0' }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 20, color: '#333' }}>Add Tenant</h2>

        <Form form={form} onFinish={onFinish} layout="vertical" initialValues={{ sex: 1, status: 1 }}>
          <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', gap: 24 }}>
            {/* Left Sidebar */}
            <div style={{ width: isMobile ? '100%' : 300, flexShrink: 0 }}>
              {/* Profile Photo */}
              <div style={{ border: '1px solid #d9d9d9', borderRadius: 4, overflow: 'hidden', marginBottom: 16 }}>
                <div style={{ background: '#1890ff', color: '#fff', padding: '6px 12px', fontSize: 12, fontWeight: 600 }}>
                  Profile Photo
                </div>
                <div style={{ padding: 16, textAlign: 'center' }}>
                  <div style={{
                    width: '100%', height: 260, border: '2px dashed #d9d9d9', borderRadius: 4,
                    display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 12, background: '#fafafa'
                  }}>
                    <UserOutlined style={{ fontSize: 120, color: '#bbb' }} />
                  </div>
                  <Upload showUploadList={false} beforeUpload={() => false}>
                    <Button icon={<UploadOutlined />} block>Upload Photo</Button>
                  </Upload>
                </div>
              </div>

              {/* Tenant Status */}
              <div style={{ border: '1px solid #d9d9d9', borderRadius: 4, padding: 16 }}>
                <Label>Tenant Status</Label>
                <Form.Item name="status" noStyle initialValue={1}>
                  <Select style={{ width: '100%' }} options={[
                    { label: 'Active', value: 1 },
                    { label: 'Pending', value: 0 },
                    { label: 'Inactive', value: 2 },
                  ]} />
                </Form.Item>
              </div>
            </div>

            {/* Right Content */}
            <div style={{ flex: 1, minWidth: 0 }}>
              {/* General Information */}
              <div style={{ border: '1px solid #e8e8e8', borderRadius: 4, padding: 20, marginBottom: 20 }}>
                <div style={sectionTitleStyle}>GENERAL INFORMATION</div>

                {/* Row: First, Last, Middle Name */}
                <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', gap: 16, marginBottom: 16 }}>
                  <div style={{ flex: 1 }}>
                    <Label required>FIRST NAME</Label>
                    <Form.Item name="first_name" noStyle rules={[{ required: true, message: 'Required' }]}>
                      <Input placeholder="Please input your first name" />
                    </Form.Item>
                  </div>
                  <div style={{ flex: 1 }}>
                    <Label required>LAST NAME</Label>
                    <Form.Item name="last_name" noStyle rules={[{ required: true, message: 'Required' }]}>
                      <Input placeholder="Please input your last name" />
                    </Form.Item>
                  </div>
                  <div style={{ flex: 1 }}>
                    <Label>MIDDLE NAME</Label>
                    <Form.Item name="middle_name" noStyle>
                      <Input placeholder="Please input your middle name" />
                    </Form.Item>
                  </div>
                </div>

                {/* Row: Company Name + Display as Company */}
                <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', gap: 16, marginBottom: 16, alignItems: isMobile ? 'flex-start' : 'flex-end' }}>
                  <div style={{ flex: 1 }}>
                    <Label>COMPANY NAME</Label>
                    <Form.Item name="company_name" noStyle>
                      <Input placeholder="Please input your company name" />
                    </Form.Item>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 4 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.5px', color: '#555', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>
                      DISPLAY AS COMPANY
                    </span>
                    <Switch checked={displayAsCompany} onChange={setDisplayAsCompany} size="small" />
                  </div>
                </div>

                {/* Row: Date of Birth + Gender */}
                <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', gap: 16, marginBottom: 16 }}>
                  <div style={{ flex: 1 }}>
                    <Label>DATE OF BIRTH</Label>
                    <Form.Item name="birth_date" noStyle>
                      <DatePicker style={{ width: '100%' }} placeholder="Select your date of birth" />
                    </Form.Item>
                  </div>
                  <div style={{ flex: 1 }}>
                    <Label>GENDER</Label>
                    <Form.Item name="sex" noStyle>
                      <Radio.Group>
                        <Radio value={1}>MALE</Radio>
                        <Radio value={2}>FEMALE</Radio>
                      </Radio.Group>
                    </Form.Item>
                  </div>
                </div>

                {/* Row: Email, Secondary Email, Phone */}
                <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', gap: 16, marginBottom: 16 }}>
                  <div style={{ flex: 1 }}>
                    <Label required>EMAIL</Label>
                    <Form.Item name="email" noStyle rules={[{ type: 'email', message: 'Invalid email' }]}>
                      <Input placeholder="Please input email" />
                    </Form.Item>
                  </div>
                  <div style={{ flex: 1 }}>
                    <Label>SECONDARY EMAIL</Label>
                    <Form.Item name="secondary_email" noStyle>
                      <Input placeholder="Please input secondary email" />
                    </Form.Item>
                  </div>
                  <div style={{ flex: 1 }}>
                    <Label>PHONE</Label>
                    <Form.Item name="phone" noStyle>
                      <Input placeholder="Please input phone number" />
                    </Form.Item>
                  </div>
                </div>

                {/* Row: ID / Passport + Lead Source */}
                <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', gap: 16, marginBottom: 0 }}>
                  <div style={{ flex: 1 }}>
                    <Label>ID / PASSPORT</Label>
                    <Form.Item name="id_card" noStyle>
                      <Input placeholder="Input ID or passport number" />
                    </Form.Item>
                  </div>
                  <div style={{ flex: 1 }}>
                    <Label>LEAD SOURCE</Label>
                    <Form.Item name="lead_source_id" noStyle>
                      <Select
                        placeholder="Select lead source"
                        allowClear
                        showSearch
                        optionFilterProp="label"
                        options={leadSources.map(s => ({ label: s.name, value: Number(s.id) }))}
                      />
                    </Form.Item>
                  </div>
                </div>
              </div>

              {/* Additional Information */}
              <div style={{ border: '1px solid #e8e8e8', borderRadius: 4, padding: 20, marginBottom: 20 }}>
                <div style={sectionTitleStyle}>ADDITIONAL INFORMATION</div>

                {/* Row: Profession + Budget */}
                <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', gap: 16, marginBottom: 16 }}>
                  <div style={{ flex: 1 }}>
                    <Label>PROFESSION</Label>
                    <Form.Item name="profession" noStyle>
                      <Input placeholder="Please input profession" />
                    </Form.Item>
                  </div>
                  <div style={{ flex: 1 }}>
                    <Label>BUDGET</Label>
                    <Form.Item name="budget" noStyle>
                      <Input placeholder="Please input budget" />
                    </Form.Item>
                  </div>
                </div>

                {/* Row: Employer + Salary */}
                <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', gap: 16, marginBottom: 16 }}>
                  <div style={{ flex: 1 }}>
                    <Label>EMPLOYER</Label>
                    <Form.Item name="employer" noStyle>
                      <Input placeholder="Please input employer" />
                    </Form.Item>
                  </div>
                  <div style={{ flex: 1 }}>
                    <Label>SALARY</Label>
                    <Form.Item name="salary" noStyle>
                      <Input placeholder="Please input salary" />
                    </Form.Item>
                  </div>
                </div>

                {/* Row: Emergency Contact + Referral */}
                <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', gap: 16, marginBottom: 16 }}>
                  <div style={{ flex: 1 }}>
                    <Label>EMERGENCY CONTACT</Label>
                    <Form.Item name="emergency_contact" noStyle>
                      <Input placeholder="Please input emergency contact" />
                    </Form.Item>
                  </div>
                  <div style={{ flex: 1 }}>
                    <Label>REFERRAL</Label>
                    <Form.Item name="referral" noStyle>
                      <Input placeholder="Please input referral" />
                    </Form.Item>
                  </div>
                </div>

                {/* Notes */}
                <div>
                  <Label>NOTES</Label>
                  <Form.Item name="notes" noStyle>
                    <Input.TextArea rows={4} placeholder="Please input your notes here" />
                  </Form.Item>
                </div>

                <div>
                  <Label>CLEANING NOTES</Label>
                  <Form.Item name="cleaning_notes" noStyle>
                    <Input.TextArea rows={3} placeholder="Special cleaning instructions for this tenant (e.g. no shoes inside, allergic to bleach)" />
                  </Form.Item>
                </div>
              </div>

              {/* Upload Section */}
              <div style={{ border: '2px dashed #d9d9d9', borderRadius: 4, padding: 40, textAlign: 'center', marginBottom: 20 }}>
                <CloudUploadOutlined style={{ fontSize: 40, color: '#1890ff', marginBottom: 8 }} />
                <div style={{ fontSize: 14, fontWeight: 500 }}>Upload</div>
                <div style={{ fontSize: 12, color: '#999' }}>Store documents and templates</div>
              </div>

              {/* Buttons */}
              <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', justifyContent: 'space-between', gap: 16 }}>
                <Button
                  size="large"
                  block={isMobile}
                  onClick={() => router.push('/contacts/tenants')}
                  style={isMobile ? {} : { flex: 1, maxWidth: 400 }}
                >
                  Cancel
                </Button>
                <Button
                  type="primary"
                  size="large"
                  block={isMobile}
                  htmlType="submit"
                  loading={loading}
                  style={isMobile ? {} : { minWidth: 200 }}
                >
                  SUBMIT
                </Button>
              </div>
            </div>
          </div>
        </Form>
      </div>
    </MainLayout>
  );
}
