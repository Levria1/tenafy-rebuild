'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Form, Input, Button, Select, DatePicker, InputNumber, message, Card } from 'antd';
import dayjs from 'dayjs';
import MainLayout from '../../../components/Layout';
import { inquiry, settings } from '../../../lib/api';

export default function InquiryCreatePage() {
  const router = useRouter();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [leadSources, setLeadSources] = useState([]);

  useEffect(() => {
    settings.getLeadSources().then(r => {
      if (r.data?.code === 200) setLeadSources(r.data.data || []);
    }).catch(() => {});
  }, []);

  const onFinish = async (values) => {
    setLoading(true);
    try {
      const payload = {
        ...values,
        inquiry_date: values.inquiry_date ? values.inquiry_date.format('YYYY-MM-DD') : null,
        desired_start_date: values.desired_start_date ? values.desired_start_date.format('YYYY-MM-DD') : null,
        reminder_date: values.reminder_date ? values.reminder_date.format('YYYY-MM-DD') : null,
      };
      const r = await inquiry.create(payload);
      if (r.data?.code === 200) {
        message.success('Inquiry created');
        router.push('/inquiries');
      } else {
        message.error(r.data?.message || 'Failed to create inquiry');
      }
    } catch (e) {
      message.error(e.response?.data?.message || 'Failed to create inquiry');
    } finally {
      setLoading(false);
    }
  };

  return (
    <MainLayout>
      <div style={{ padding: '0 0 24px 0', maxWidth: 720 }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 20, color: '#333' }}>Add Inquiry</h2>
        <Card>
          <Form
            form={form}
            layout="vertical"
            onFinish={onFinish}
            initialValues={{ inquiry_date: dayjs() }}
          >
            <Form.Item label="Date" name="inquiry_date" rules={[{ required: true, message: 'Date is required' }]}>
              <DatePicker style={{ width: '100%' }} format="YYYY-MM-DD" />
            </Form.Item>
            <Form.Item label="Lead Source" name="lead_source_id">
              <Select
                allowClear
                placeholder="Select lead source"
                options={leadSources.map(s => ({ label: s.name, value: String(s.id) }))}
              />
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
            <Form.Item label="Desired Start Date" name="desired_start_date" tooltip="When the prospect wants to start renting">
              <DatePicker style={{ width: '100%' }} format="YYYY-MM-DD" />
            </Form.Item>
            <Form.Item label="Budget" name="budget">
              <InputNumber style={{ width: '100%' }} min={0} step={100} placeholder="Monthly budget" />
            </Form.Item>
            <Form.Item label="Reminder Date" name="reminder_date" tooltip="An email reminder will be sent to you on this date using the Inquiry-Reminder template">
              <DatePicker style={{ width: '100%' }} format="YYYY-MM-DD" />
            </Form.Item>
            <Form.Item label="Notes" name="notes">
              <Input.TextArea rows={4} />
            </Form.Item>
            <Form.Item>
              <Button type="primary" htmlType="submit" loading={loading}>Save Inquiry</Button>
              <Button style={{ marginLeft: 8 }} onClick={() => router.push('/inquiries')}>Cancel</Button>
            </Form.Item>
          </Form>
        </Card>
      </div>
    </MainLayout>
  );
}
