'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Form, Input, Button, Select, DatePicker, InputNumber, message, Card, Upload } from 'antd';
import { ThunderboltOutlined, PictureOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import MainLayout from '../../../components/Layout';
import { inquiry, settings } from '../../../lib/api';

export default function InquiryCreatePage() {
  const router = useRouter();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [leadSources, setLeadSources] = useState([]);

  // Smart-extract state — pasted text + (optional) screenshot → backend parses
  // them via Google Cloud Vision + LLM and returns fields to prefill the form.
  // The screenshot URL is held in state and attached to the inquiry on save.
  const [extractText, setExtractText] = useState('');
  const [extractFile, setExtractFile] = useState(null);
  const [extractLoading, setExtractLoading] = useState(false);
  const [screenshotUrl, setScreenshotUrl] = useState(null);
  const apiBase = (typeof window !== 'undefined' && window.location.origin) || '';

  useEffect(() => {
    settings.getLeadSources().then(r => {
      if (r.data?.code === 200) setLeadSources(r.data.data || []);
    }).catch(() => {});
  }, []);

  const onExtract = async () => {
    const hasText = extractText.trim().length > 0;
    const hasImage = !!extractFile;
    if (!hasText && !hasImage) {
      message.warning('Paste some text or pick a screenshot first.');
      return;
    }
    setExtractLoading(true);
    try {
      const fd = new FormData();
      if (hasText) fd.append('text', extractText);
      if (hasImage) fd.append('image', extractFile);
      const r = await inquiry.parse(fd);
      if (r.data?.code !== 200) {
        message.error(r.data?.message || 'Parse failed');
        return;
      }
      const { fields = {}, screenshot_url } = r.data.data || {};

      // Prefill any field the LLM returned. Dates need to become dayjs to
      // satisfy Ant DatePicker. Numeric budget passed straight through.
      const patch = {};
      if (fields.first_name) patch.first_name = fields.first_name;
      if (fields.last_name) patch.last_name = fields.last_name;
      if (fields.email) patch.email = fields.email;
      if (fields.phone) patch.phone = fields.phone;
      if (fields.budget != null && fields.budget !== '') patch.budget = Number(fields.budget);
      if (fields.desired_start_date) {
        const d = dayjs(fields.desired_start_date);
        if (d.isValid()) patch.desired_start_date = d;
      }
      if (fields.notes) patch.notes = fields.notes;
      form.setFieldsValue(patch);

      if (screenshot_url) setScreenshotUrl(screenshot_url);

      const filledCount = Object.keys(patch).length;
      message.success(`Extracted ${filledCount} field${filledCount === 1 ? '' : 's'}.`);
    } catch (e) {
      message.error(e.response?.data?.message || 'Parse failed');
    } finally {
      setExtractLoading(false);
    }
  };

  const onFinish = async (values) => {
    setLoading(true);
    try {
      const payload = {
        ...values,
        inquiry_date: values.inquiry_date ? values.inquiry_date.format('YYYY-MM-DD') : null,
        desired_start_date: values.desired_start_date ? values.desired_start_date.format('YYYY-MM-DD') : null,
        reminder_date: values.reminder_date ? values.reminder_date.format('YYYY-MM-DD') : null,
        screenshot_url: screenshotUrl || null,
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

        {/* Smart Extract — paste text and/or upload a screenshot, click Extract,
            and the form below gets auto-filled. The screenshot is saved with
            the inquiry on Save. */}
        <Card
          size="small"
          style={{ marginBottom: 16, background: '#fafbff', borderColor: '#d6e4ff' }}
          title={
            <span style={{ fontSize: 13, fontWeight: 600, color: '#1677ff' }}>
              <ThunderboltOutlined /> Smart Extract
            </span>
          }
        >
          <div style={{ marginBottom: 8 }}>
            <Input.TextArea
              rows={3}
              placeholder="Paste a WhatsApp/Telegram/email message here (any language) — name, phone, budget, move-in date, etc."
              value={extractText}
              onChange={(e) => setExtractText(e.target.value)}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Upload
              beforeUpload={(file) => { setExtractFile(file); return false; }}
              onRemove={() => setExtractFile(null)}
              fileList={extractFile ? [{ uid: '1', name: extractFile.name, status: 'done' }] : []}
              maxCount={1}
              accept="image/*"
            >
              <Button icon={<PictureOutlined />}>Screenshot (optional)</Button>
            </Upload>
            <Button
              type="primary"
              icon={<ThunderboltOutlined />}
              loading={extractLoading}
              onClick={onExtract}
            >
              Extract
            </Button>
            {screenshotUrl && (
              <a href={apiBase + screenshotUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
                <img
                  src={apiBase + screenshotUrl}
                  alt="screenshot"
                  style={{ height: 32, borderRadius: 4, border: '1px solid #d9d9d9', verticalAlign: 'middle' }}
                />
                <span style={{ marginLeft: 8, color: '#666' }}>saved — will be attached on Save</span>
              </a>
            )}
          </div>
          <div style={{ fontSize: 11, color: '#999', marginTop: 8 }}>
            Uses Google Cloud Vision for OCR + LLM extraction. Review the prefilled fields before saving.
          </div>
        </Card>

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
