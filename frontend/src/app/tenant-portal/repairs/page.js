'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Card, Button, Modal, Form, Select, Input, DatePicker, Upload, Image,
  Tag, Empty, Spin, Alert, Typography, Space, Descriptions, message,
} from 'antd';
import { PlusOutlined, PictureOutlined, ToolOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { tenantPortal } from '../../../lib/tenantApi';

const { Text, Paragraph } = Typography;
const { TextArea } = Input;

// Tenant-facing wording for service.status. Deliberately not the staff labels: to
// someone who has reported a leak, "Pending" reads as "nobody has looked at it", when
// what it actually means is that we have it and it is queued.
const STATUS = {
  0: { label: 'Received', color: 'blue' },
  1: { label: 'In progress', color: 'gold' },
  2: { label: 'Completed', color: 'green' },
  3: { label: 'Cancelled', color: 'default' },
};

// The server sends `category` as the fixed slug it stores, e.g. "interior: bathroom".
// Shown to the tenant with the prefix dropped and the first letter raised, so the
// select reads like a list of things rather than a list of database values.
const prettyCategory = (slug) => {
  const s = String(slug || '');
  const tail = s.includes(':') ? s.slice(s.indexOf(':') + 1) : s;
  const t = tail.trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : s;
};

// Group the fixed list by its own prefix so the dropdown has Appliances / Interior /
// Other headings without the server needing to send a structure.
const groupCategories = (categories) => {
  const groups = new Map();
  for (const slug of categories) {
    const head = slug.includes(':') ? slug.slice(0, slug.indexOf(':')).trim() : 'Other';
    const label = head.charAt(0).toUpperCase() + head.slice(1);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push({ value: slug, label: prettyCategory(slug) });
  }
  return Array.from(groups, ([label, options]) => ({ label, options }));
};

const fmtDate = (v) => (v ? dayjs(v).format('D MMM YYYY') : null);
const fmtWindow = (start, end) => {
  if (!start) return null;
  const s = dayjs(start);
  const e = end ? dayjs(end) : null;
  if (!e) return s.format('D MMM YYYY, HH:mm');
  return s.isSame(e, 'day')
    ? `${s.format('D MMM YYYY, HH:mm')} to ${e.format('HH:mm')}`
    : `${s.format('D MMM YYYY, HH:mm')} to ${e.format('D MMM YYYY, HH:mm')}`;
};

export default function TenantRepairsPage() {
  const [loading, setLoading] = useState(true);
  const [requests, setRequests] = useState([]);
  const [options, setOptions] = useState(null);
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [fileList, setFileList] = useState([]);
  const [form] = Form.useForm();

  const load = useCallback(async () => {
    try {
      // Both together: the list is useless without the options that say whether the
      // tenant may add to it, and vice versa.
      const [listRes, optionsRes] = await Promise.all([
        tenantPortal.getRepairs(),
        tenantPortal.getRepairOptions(),
      ]);
      setRequests(listRes.data?.data || []);
      setOptions(optionsRes.data?.data || null);
    } catch (error) {
      // 401/403 are already being redirected by the api client.
      if (![401, 403].includes(error.response?.status)) {
        message.error(error.response?.data?.message || 'Could not load your repair requests.');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const units = options?.units || [];
  const canRaise = Boolean(options?.can_raise);
  const maxPhotos = options?.max_photos || 5;

  const openForm = () => {
    form.resetFields();
    setFileList([]);
    // With exactly one current tenancy there is nothing to choose, so the field is
    // preset and hidden rather than shown as a select with a single option.
    if (units.length === 1) form.setFieldsValue({ unit_id: units[0].unit_id });
    setOpen(true);
  };

  const onSubmit = async (values) => {
    setSubmitting(true);
    try {
      const fd = new FormData();
      fd.append('category', values.category);
      fd.append('additional_info', values.additional_info);
      if (values.unit_id) fd.append('unit_id', values.unit_id);
      if (values.contact_phone) fd.append('contact_phone', values.contact_phone);

      // The two preferred windows are optional and independent; only send the halves
      // that were actually filled in.
      const windows = [
        ['preferred_date_first_start', 'preferred_date_first_end', values.first_window],
        ['preferred_date_second_start', 'preferred_date_second_end', values.second_window],
      ];
      for (const [startKey, endKey, range] of windows) {
        if (range?.[0]) fd.append(startKey, range[0].format('YYYY-MM-DD HH:mm'));
        if (range?.[1]) fd.append(endKey, range[1].format('YYYY-MM-DD HH:mm'));
      }

      for (const f of fileList) fd.append('photos', f.originFileObj || f);

      const response = await tenantPortal.createRepair(fd);
      message.success(`Repair request ${response.data?.data?.code || ''} submitted.`.trim());
      setOpen(false);
      setFileList([]);
      form.resetFields();
      load();
    } catch (error) {
      message.error(error.response?.data?.message || 'Could not submit your request. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return <div style={{ textAlign: 'center', padding: 80 }}><Spin size="large" /></div>;
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: 20 }}>Repairs</h2>
        <Button type="primary" icon={<PlusOutlined />} onClick={openForm} disabled={!canRaise}>
          Report a repair
        </Button>
      </div>

      {!canRaise && (
        // The server refuses submissions without a current lease, so the button is
        // disabled and the reason is stated. A button that always fails is worse.
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="Repairs can only be reported on a current tenancy"
          description="Your past requests are shown below. If you need something looked at, please contact us directly."
        />
      )}

      {requests.length === 0 ? (
        <Card><Empty image={<ToolOutlined style={{ fontSize: 48, color: '#bfbfbf' }} />} description="You have not reported any repairs." /></Card>
      ) : (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          {requests.map((r) => {
            const status = STATUS[r.status] || { label: 'Unknown', color: 'default' };
            const firstWindow = fmtWindow(r.preferred_date_first_start, r.preferred_date_first_end);
            const secondWindow = fmtWindow(r.preferred_date_second_start, r.preferred_date_second_end);
            const scheduled = fmtWindow(r.service_date_start, r.service_date_end);
            return (
              <Card key={r.id} size="small">
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
                  <Space size={8} wrap>
                    <Text strong>{prettyCategory(r.category)}</Text>
                    <Tag color={status.color}>{status.label}</Tag>
                    <Text type="secondary" style={{ fontSize: 12 }}>{r.code}</Text>
                  </Space>
                  <Text type="secondary" style={{ fontSize: 12 }}>Reported {fmtDate(r.created_at)}</Text>
                </div>

                <Text type="secondary" style={{ fontSize: 13 }}>
                  {[r.property_name, r.unit_name].filter(Boolean).join(' - ')}
                </Text>

                <Paragraph style={{ marginTop: 8, marginBottom: 8, whiteSpace: 'pre-wrap' }}>
                  {r.additional_info}
                </Paragraph>

                {r.tenant_note && (
                  // The one field staff can write that a tenant reads. Given its own
                  // block so it is not mistaken for part of what the tenant wrote.
                  <Alert
                    type="success"
                    showIcon={false}
                    style={{ marginBottom: 8 }}
                    message={<Text strong style={{ fontSize: 13 }}>Update from us</Text>}
                    description={<span style={{ whiteSpace: 'pre-wrap' }}>{r.tenant_note}</span>}
                  />
                )}

                {(scheduled || firstWindow || secondWindow) && (
                  <Descriptions size="small" column={1} style={{ marginBottom: 8 }}>
                    {scheduled && <Descriptions.Item label="Booked in">{scheduled}</Descriptions.Item>}
                    {firstWindow && <Descriptions.Item label="You asked for">{firstWindow}</Descriptions.Item>}
                    {secondWindow && <Descriptions.Item label="Or">{secondWindow}</Descriptions.Item>}
                  </Descriptions>
                )}

                {r.photos?.length > 0 && (
                  <Image.PreviewGroup>
                    <Space size={8} wrap>
                      {r.photos.map((p) => (
                        <Image
                          key={p.id}
                          src={tenantPortal.repairPhotoUrl(r.id, p.id)}
                          alt="Photo attached to this repair request"
                          width={72}
                          height={72}
                          style={{ objectFit: 'cover', borderRadius: 4 }}
                          fallback="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiI+PHJlY3Qgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIiBmaWxsPSIjZjVmNWY1Ii8+PC9zdmc+"
                        />
                      ))}
                    </Space>
                  </Image.PreviewGroup>
                )}
              </Card>
            );
          })}
        </Space>
      )}

      <Modal
        title="Report a repair"
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => form.submit()}
        okText="Submit"
        confirmLoading={submitting}
        destroyOnClose
        width={560}
      >
        <Form form={form} layout="vertical" onFinish={onSubmit} requiredMark={false}>
          {units.length > 1 && (
            <Form.Item name="unit_id" label="Which home is this for?" rules={[{ required: true, message: 'Please choose the unit' }]}>
              <Select
                placeholder="Choose a unit"
                options={units.map((u) => ({
                  value: u.unit_id,
                  label: [u.property_name, u.unit_name].filter(Boolean).join(' - '),
                }))}
              />
            </Form.Item>
          )}

          <Form.Item name="category" label="What needs fixing?" rules={[{ required: true, message: 'Please choose a category' }]}>
            <Select
              placeholder="Choose the closest match"
              showSearch
              optionFilterProp="label"
              options={groupCategories(options?.categories || [])}
            />
          </Form.Item>

          <Form.Item
            name="additional_info"
            label="Tell us what is wrong"
            rules={[
              { required: true, message: 'Please describe the problem' },
              // Mirrors the server: it rejects anything under 10 characters, so
              // catching it here saves a round trip and a wasted submission.
              { min: 10, message: 'Please describe the problem in a little more detail.' },
              { max: 5000, message: 'Please keep this under 5000 characters.' },
            ]}
          >
            <TextArea rows={4} placeholder="For example: the kitchen tap drips constantly and the handle is loose." />
          </Form.Item>

          <Form.Item name="contact_phone" label="Best number to reach you (optional)">
            <Input placeholder="Phone number" maxLength={64} />
          </Form.Item>

          <Form.Item name="first_window" label="When suits you? (optional)">
            <DatePicker.RangePicker showTime={{ format: 'HH:mm' }} format="D MMM YYYY HH:mm" style={{ width: '100%' }} />
          </Form.Item>

          <Form.Item name="second_window" label="A second option (optional)">
            <DatePicker.RangePicker showTime={{ format: 'HH:mm' }} format="D MMM YYYY HH:mm" style={{ width: '100%' }} />
          </Form.Item>

          <Form.Item label={`Photos (optional, up to ${maxPhotos})`}>
            <Upload
              listType="picture-card"
              // false: hold the files and send them with the form as one multipart
              // request, so there is never a stored file with no request attached to it.
              beforeUpload={() => false}
              multiple
              accept="image/jpeg,image/png,image/heic,image/heif,image/webp"
              fileList={fileList}
              onChange={({ fileList: next }) => setFileList(next.slice(0, maxPhotos))}
            >
              {fileList.length >= maxPhotos ? null : (
                <div><PictureOutlined /><div style={{ marginTop: 8 }}>Add</div></div>
              )}
            </Upload>
            <Text type="secondary" style={{ fontSize: 12 }}>
              JPEG, PNG, HEIC or WebP. Up to 15 MB each. A photo usually saves a visit.
            </Text>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
