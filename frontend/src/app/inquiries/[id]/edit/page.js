'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Form, Input, Button, Select, DatePicker, message, Card, Spin } from 'antd';
import dayjs from 'dayjs';
import MainLayout from '../../../../components/Layout';
import { inquiry, settings } from '../../../../lib/api';

const STATUS_OPTIONS = [
  { label: 'Open', value: 0 },
  { label: 'Converted', value: 1 },
  { label: 'Closed', value: 2 },
];

export default function InquiryEditPage() {
  const router = useRouter();
  const params = useParams();
  const id = params?.id;
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [pageLoading, setPageLoading] = useState(true);
  const [leadSources, setLeadSources] = useState([]);

  useEffect(() => {
    if (!id) return;
    Promise.all([
      inquiry.get(id),
      settings.getLeadSources().catch(() => ({ data: { data: [] } })),
    ]).then(([invRes, lsRes]) => {
      if (lsRes.data?.code === 200) setLeadSources(lsRes.data.data || []);
      if (invRes.data?.code === 200) {
        const d = invRes.data.data;
        form.setFieldsValue({
          inquiry_date: d.inquiry_date ? dayjs(d.inquiry_date) : null,
          lead_source_id: d.lead_source_id ? String(d.lead_source_id) : undefined,
          first_name: d.first_name || '',
          last_name: d.last_name || '',
          email: d.email || '',
          phone: d.phone || '',
          notes: d.notes || '',
          status: d.status,
        });
      }
    }).catch(() => message.error('Failed to load inquiry'))
      .finally(() => setPageLoading(false));
  }, [id, form]);

  const onFinish = async (values) => {
    setLoading(true);
    try {
      const payload = {
        ...values,
        inquiry_date: values.inquiry_date ? values.inquiry_date.format('YYYY-MM-DD HH:mm:ss') : null,
      };
      const r = await inquiry.update(id, payload);
      if (r.data?.code === 200) {
        message.success('Inquiry updated');
        router.push(`/inquiries/${id}`);
      } else {
        message.error(r.data?.message || 'Failed to update inquiry');
      }
    } catch (e) {
      message.error(e.response?.data?.message || 'Failed to update inquiry');
    } finally {
      setLoading(false);
    }
  };

  if (pageLoading) {
    return <MainLayout><div style={{ padding: 24, textAlign: 'center' }}><Spin /></div></MainLayout>;
  }

  return (
    <MainLayout>
      <div style={{ padding: '0 0 24px 0', maxWidth: 720 }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 20, color: '#333' }}>Edit Inquiry</h2>
        <Card>
          <Form form={form} layout="vertical" onFinish={onFinish}>
            <Form.Item label="Date" name="inquiry_date" rules={[{ required: true, message: 'Date is required' }]}>
              <DatePicker showTime style={{ width: '100%' }} format="YYYY-MM-DD HH:mm" />
            </Form.Item>
            <Form.Item label="Lead Source" name="lead_source_id">
              <Select
                allowClear
                placeholder="Select lead source"
                options={leadSources.map(s => ({ label: s.name, value: String(s.id) }))}
              />
            </Form.Item>
            <Form.Item label="Status" name="status">
              <Select options={STATUS_OPTIONS} />
            </Form.Item>
            <Form.Item label="First Name" name="first_name">
              <Input />
            </Form.Item>
            <Form.Item label="Last Name" name="last_name">
              <Input />
            </Form.Item>
            <Form.Item label="Email" name="email" rules={[{ type: 'email', message: 'Invalid email' }]}>
              <Input />
            </Form.Item>
            <Form.Item label="Phone Number" name="phone">
              <Input />
            </Form.Item>
            <Form.Item label="Notes" name="notes">
              <Input.TextArea rows={4} />
            </Form.Item>
            <Form.Item>
              <Button type="primary" htmlType="submit" loading={loading}>Save Changes</Button>
              <Button style={{ marginLeft: 8 }} onClick={() => router.push(`/inquiries/${id}`)}>Cancel</Button>
            </Form.Item>
          </Form>
        </Card>
      </div>
    </MainLayout>
  );
}
