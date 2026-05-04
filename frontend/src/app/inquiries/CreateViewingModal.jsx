'use client';

import { useEffect, useState } from 'react';
import { Modal, Form, Select, DatePicker, InputNumber, Input, message } from 'antd';
import dayjs from 'dayjs';
import { property, userApi, viewingApi } from '../../lib/api';

/**
 * Modal for staff to manually create a viewing booking from an inquiry.
 * Booking is saved as confirmed (status=1) with inquiry_id stamped.
 *
 * Props:
 *   open       - boolean
 *   onClose    - () => void
 *   inquiry    - { id, first_name, last_name, email, phone } (pre-fills viewer)
 *   onCreated  - () => void (parent reloads after success)
 */
export default function CreateViewingModal({ open, onClose, inquiry, onCreated }) {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [properties, setProperties] = useState([]);
  const [users, setUsers] = useState([]);
  const [selectedPropertyId, setSelectedPropertyId] = useState(null);

  useEffect(() => {
    if (!open) return;
    property.getAllWithUnits().then(r => {
      if (r.data?.code === 200) setProperties(r.data.data || []);
    }).catch(() => {});
    userApi.listUsers({}, { page: 1, limit: 500 }).then(r => {
      const list = r.data?.data?.content || r.data?.data || [];
      setUsers(list);
    }).catch(() => {});
  }, [open]);

  useEffect(() => {
    if (open && inquiry) {
      form.setFieldsValue({
        proposed_datetime: dayjs().add(1, 'day').hour(11).minute(0).second(0),
        duration_minutes: 30,
      });
      setSelectedPropertyId(null);
    }
  }, [open, inquiry, form]);

  const onFinish = async (values) => {
    setLoading(true);
    try {
      const viewerName = [inquiry.first_name, inquiry.last_name].filter(Boolean).join(' ') || '(no name)';
      const payload = {
        inquiry_id: String(inquiry.id),
        unit_id: values.unit_id,
        employee_id: values.employee_id,
        proposed_datetime: values.proposed_datetime.format('YYYY-MM-DD HH:mm:ss'),
        duration_minutes: values.duration_minutes || 30,
        viewer_name: viewerName,
        viewer_email: inquiry.email || '',
        viewer_phone: inquiry.phone || '',
        viewer_message: values.viewer_message || '',
      };
      const r = await viewingApi.createManualBooking(payload);
      if (r.data?.code === 200) {
        message.success('Viewing created');
        form.resetFields();
        onClose();
        onCreated && onCreated();
      } else {
        message.error(r.data?.message || 'Failed to create viewing');
      }
    } catch (e) {
      message.error(e.response?.data?.message || 'Failed to create viewing');
    } finally {
      setLoading(false);
    }
  };

  const selectedProperty = properties.find(p => String(p.id) === String(selectedPropertyId));
  const units = selectedProperty?.units || [];

  return (
    <Modal
      open={open}
      onCancel={onClose}
      onOk={() => form.submit()}
      okText="Create Viewing"
      confirmLoading={loading}
      title={`Create Viewing — ${[inquiry?.first_name, inquiry?.last_name].filter(Boolean).join(' ') || '(no name)'}`}
      destroyOnClose
    >
      <div style={{ marginBottom: 12, padding: 10, background: '#fafafa', borderRadius: 4, fontSize: 12, color: '#666' }}>
        <div><strong>Viewer:</strong> {[inquiry?.first_name, inquiry?.last_name].filter(Boolean).join(' ') || '—'}</div>
        {inquiry?.email && <div><strong>Email:</strong> {inquiry.email}</div>}
        {inquiry?.phone && <div><strong>Phone:</strong> {inquiry.phone}</div>}
      </div>
      <Form form={form} layout="vertical" onFinish={onFinish}>
        <Form.Item label="Property" required>
          <Select
            placeholder="Select property"
            value={selectedPropertyId || undefined}
            onChange={(v) => { setSelectedPropertyId(v); form.setFieldsValue({ unit_id: undefined }); }}
            options={properties.map(p => ({ label: p.display_name, value: String(p.id) }))}
            showSearch
            optionFilterProp="label"
          />
        </Form.Item>
        <Form.Item label="Unit" name="unit_id" rules={[{ required: true, message: 'Pick a unit' }]}>
          <Select
            placeholder={selectedPropertyId ? 'Select unit' : 'Select a property first'}
            disabled={!selectedPropertyId}
            options={units.map(u => ({ label: u.name, value: String(u.id) }))}
            showSearch
            optionFilterProp="label"
          />
        </Form.Item>
        <Form.Item label="Employee" name="employee_id" rules={[{ required: true, message: 'Pick an employee' }]}>
          <Select
            placeholder="Select employee"
            options={users.map(u => ({
              label: `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email,
              value: String(u.id),
            }))}
            showSearch
            optionFilterProp="label"
          />
        </Form.Item>
        <Form.Item label="Date & Time" name="proposed_datetime" rules={[{ required: true }]}>
          <DatePicker showTime format="YYYY-MM-DD HH:mm" style={{ width: '100%' }} minuteStep={15} />
        </Form.Item>
        <Form.Item label="Duration (minutes)" name="duration_minutes">
          <InputNumber min={15} max={240} step={15} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item label="Note (optional)" name="viewer_message">
          <Input.TextArea rows={2} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
