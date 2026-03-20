'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  Card, Table, Button, Space, Form, Input, InputNumber,
  DatePicker, Select, message, Statistic, Row, Col, Modal, Tag
} from 'antd';
import { PlusOutlined, ArrowLeftOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import MainLayout, { useAuth } from '../../../../../../components/Layout';
import { property as propertyApi } from '../../../../../../lib/api';

const CATEGORIES = [
  { label: 'Plumbing', value: 'PLUMBING' },
  { label: 'Electrical', value: 'ELECTRICAL' },
  { label: 'HVAC', value: 'HVAC' },
  { label: 'Structural', value: 'STRUCTURAL' },
  { label: 'Appliance', value: 'APPLIANCE' },
  { label: 'Painting', value: 'PAINTING' },
  { label: 'Flooring', value: 'FLOORING' },
  { label: 'Landscaping', value: 'LANDSCAPING' },
  { label: 'General', value: 'GENERAL' },
  { label: 'Other', value: 'OTHER' },
];

export default function UnitMaintenancePage() {
  const params = useParams();
  const router = useRouter();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission ? hasPermission('LANDLORD/PROPERTY_EDIT') : false;
  const canDelete = hasPermission ? hasPermission('LANDLORD/PROPERTY_DELETE') : false;
  const propertyId = params.id;
  const unitId = params.unitid;

  const [records, setRecords] = useState([]);
  const [summary, setSummary] = useState({ total: 0, count: 0 });
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingRecord, setEditingRecord] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm();

  useEffect(() => {
    loadData();
  }, [unitId]);

  const loadData = async () => {
    try {
      setLoading(true);
      const [listRes, sumRes] = await Promise.all([
        propertyApi.getMaintenanceList(unitId),
        propertyApi.getMaintenanceSum(unitId),
      ]);
      if (listRes.data.code === 200) setRecords(listRes.data.data || []);
      if (sumRes.data.code === 200) setSummary(sumRes.data.data || { total: 0, count: 0 });
    } catch (error) {
      console.error('Failed to load maintenance records:', error);
    } finally {
      setLoading(false);
    }
  };

  const openCreate = () => {
    setEditingRecord(null);
    form.resetFields();
    setModalOpen(true);
  };

  const openEdit = (record) => {
    setEditingRecord(record);
    form.setFieldsValue({
      ...record,
      maintenance_date: record.maintenance_date ? dayjs(record.maintenance_date) : null,
    });
    setModalOpen(true);
  };

  const handleSubmit = async (values) => {
    setSubmitting(true);
    try {
      const data = {
        ...values,
        maintenance_date: values.maintenance_date ? values.maintenance_date.format('YYYY-MM-DD') : null,
      };
      if (editingRecord) {
        await propertyApi.updateMaintenance(editingRecord.id, data);
        message.success('Maintenance record updated');
      } else {
        await propertyApi.createMaintenance(unitId, data);
        message.success('Maintenance record added');
      }
      setModalOpen(false);
      loadData();
    } catch (error) {
      message.error('Failed to save maintenance record');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id) => {
    Modal.confirm({
      title: 'Delete this maintenance record?',
      onOk: async () => {
        try {
          await propertyApi.deleteMaintenance(id);
          message.success('Record deleted');
          loadData();
        } catch (error) {
          message.error('Failed to delete');
        }
      },
    });
  };

  const columns = [
    { title: 'Title', dataIndex: 'title', key: 'title' },
    {
      title: 'Category', dataIndex: 'category', key: 'category',
      render: (cat) => <Tag>{cat || 'GENERAL'}</Tag>,
    },
    { title: 'Vendor', dataIndex: 'vendor_name', key: 'vendor_name' },
    {
      title: 'Cost', dataIndex: 'cost', key: 'cost',
      render: (c) => `$${Number(c || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}`,
    },
    {
      title: 'Date', dataIndex: 'maintenance_date', key: 'maintenance_date',
      render: (d) => d ? dayjs(d).format('MMM D, YYYY') : '-',
    },
    { title: 'Description', dataIndex: 'description', key: 'description', ellipsis: true },
    {
      title: 'Actions', key: 'actions',
      render: (_, record) => (
        <Space>
          {canEdit && <Button type="link" icon={<EditOutlined />} onClick={() => openEdit(record)}>Edit</Button>}
          {canDelete && <Button type="link" danger icon={<DeleteOutlined />} onClick={() => handleDelete(record.id)}>Delete</Button>}
        </Space>
      ),
    },
  ];

  return (
    <MainLayout>
      <div style={{ marginBottom: 16 }}>
        <Button
          icon={<ArrowLeftOutlined />}
          onClick={() => router.push(`/property/${propertyId}/unit/${unitId}`)}
          style={{ marginBottom: 16 }}
        >
          Back to Unit
        </Button>
        <h2 style={{ margin: 0 }}>Maintenance Records</h2>
      </div>

      <Row gutter={16} style={{ marginBottom: 24 }}>
        <Col span={8}>
          <Card>
            <Statistic
              title="Total Maintenance Cost"
              value={Number(summary.total || 0)}
              precision={2}
              prefix="$"
            />
          </Card>
        </Col>
        <Col span={8}>
          <Card>
            <Statistic title="Total Records" value={summary.count || 0} />
          </Card>
        </Col>
      </Row>

      <Card
        title="Maintenance History"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            Add Record
          </Button>
        }
      >
        <Table
          columns={columns}
          dataSource={records}
          rowKey="id"
          loading={loading}
          pagination={{ pageSize: 20 }}
        />
      </Card>

      <Modal
        title={editingRecord ? 'Edit Maintenance Record' : 'Add Maintenance Record'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        footer={null}
        width={600}
      >
        <Form form={form} layout="vertical" onFinish={handleSubmit}>
          <Form.Item name="title" label="Title" rules={[{ required: true, message: 'Please enter a title' }]}>
            <Input placeholder="e.g. Fix leaking faucet" />
          </Form.Item>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="category" label="Category">
                <Select options={CATEGORIES} placeholder="Select category" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="maintenance_date" label="Date">
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="cost" label="Cost ($)">
                <InputNumber
                  style={{ width: '100%' }}
                  min={0}
                  precision={2}
                  placeholder="0.00"
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="vendor_name" label="Vendor / Contractor">
                <Input placeholder="Company or person name" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={3} placeholder="Details about the maintenance work..." />
          </Form.Item>
          <Form.Item style={{ marginBottom: 0, textAlign: 'right' }}>
            <Space>
              <Button onClick={() => setModalOpen(false)}>Cancel</Button>
              <Button type="primary" htmlType="submit" loading={submitting}>
                {editingRecord ? 'Update' : 'Add Record'}
              </Button>
            </Space>
          </Form.Item>
        </Form>
      </Modal>
    </MainLayout>
  );
}
