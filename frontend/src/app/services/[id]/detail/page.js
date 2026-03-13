'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Card, Button, Space, Tag, Image, message, Modal, Row, Col } from 'antd';
import { EditOutlined, ArrowLeftOutlined, DeleteOutlined, FileOutlined, FilePdfOutlined, FileImageOutlined, FileWordOutlined, FileExcelOutlined, DownloadOutlined } from '@ant-design/icons';
import MainLayout from '../../../../components/Layout';
import { service, file as fileApi } from '../../../../lib/api';

const STATUS_MAP = {
  0: { label: 'Pending', color: 'orange' },
  1: { label: 'In Progress', color: 'blue' },
  2: { label: 'Completed', color: 'green' },
  3: { label: 'Cancelled', color: 'red' },
};

const PRIORITY_MAP = {
  0: { label: 'High', color: 'red' },
  1: { label: 'Medium', color: 'orange' },
  2: { label: 'Low', color: 'green' },
};

const labelStyle = { color: '#888', fontSize: 13, marginBottom: 4 };
const valueStyle = { fontSize: 14, minHeight: 22 };

function Field({ label, children, span = 12 }) {
  return (
    <Col xs={24} sm={span}>
      <div style={{ marginBottom: 16 }}>
        <div style={labelStyle}>{label}</div>
        <div style={valueStyle}>{children || '-'}</div>
      </div>
    </Col>
  );
}

export default function ServiceDetailPage() {
  const [serviceData, setServiceData] = useState(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const params = useParams();
  const serviceId = params.id;

  useEffect(() => {
    loadService();
  }, [serviceId]);

  const loadService = async () => {
    try {
      const response = await service.get(serviceId);
      if (response.data.code === 200) {
        setServiceData(response.data.data);
      }
    } catch (error) {
      message.error('Failed to load service');
    } finally {
      setLoading(false);
    }
  };

  const formatDate = (d) => {
    if (!d) return null;
    return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  };

  const formatDateTime = (d) => {
    if (!d) return null;
    return new Date(d).toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  const handleDelete = () => {
    Modal.confirm({
      title: 'Delete Service',
      content: 'Are you sure you want to delete this service? This action cannot be undone.',
      okText: 'Delete',
      okType: 'danger',
      onOk: async () => {
        try {
          await service.delete(serviceId);
          message.success('Service deleted');
          router.push('/services');
        } catch (error) {
          message.error('Failed to delete service');
        }
      },
    });
  };

  const d = serviceData;
  const statusInfo = STATUS_MAP[d?.status] || { label: 'Unknown', color: 'default' };
  const priorityInfo = PRIORITY_MAP[d?.priority];

  const assignee1 = d ? [d.assignee_first_name, d.assignee_last_name].filter(Boolean).join(' ') : '';
  const assignee2 = d ? [d.assignee_2_first_name, d.assignee_2_last_name].filter(Boolean).join(' ') : '';

  const isImage = (f) => {
    const ext = (f.extension || (f.filename && f.filename.includes('.') ? f.filename.split('.').pop() : '') || '').toLowerCase();
    const mime = (f.mime_type || '').toLowerCase();
    return ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg'].includes(ext) || mime.startsWith('image/');
  };

  const images = d?.files?.filter(isImage) || [];
  const nonImages = d?.files?.filter(f => !isImage(f)) || [];

  return (
    <MainLayout>
      <Space direction="vertical" style={{ width: '100%' }} size="large">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Button icon={<ArrowLeftOutlined />} onClick={() => router.push('/services')}>Back to Services</Button>
          <Space>
            <Button danger icon={<DeleteOutlined />} onClick={handleDelete}>Delete</Button>
            <Button type="primary" icon={<EditOutlined />} onClick={() => router.push(`/services/${serviceId}/edit`)}>Edit Service</Button>
          </Space>
        </div>

        <Card
          title={`Service ${d?.code || '#' + serviceId}`}
          loading={loading}
          extra={<Tag color={statusInfo.color}>{statusInfo.label}</Tag>}
        >
          {d && (
            <div style={{ maxWidth: 900 }}>

              {/* ── Status & Service Code ────────────────────────────── */}
              <Row gutter={16}>
                <Field label="Status">
                  <Tag color={statusInfo.color}>{statusInfo.label}</Tag>
                </Field>
                <Field label="Service Code">{d.code}</Field>
              </Row>

              {/* ── Property & Unit ───────────────────────────────────── */}
              <Row gutter={16}>
                <Field label="Property">{d.property_name}</Field>
                <Field label="Unit">{d.unit_name}</Field>
              </Row>

              {/* ── Category & Sub-Category ──────────────────────────── */}
              <Row gutter={16}>
                <Field label="Category">{d.category}</Field>
                <Field label="Issues / Sub-Category">{d.sub_category}</Field>
              </Row>

              {/* ── Priority ─────────────────────────────────────────── */}
              <Row gutter={16}>
                <Field label="Priority">
                  {priorityInfo ? <Tag color={priorityInfo.color}>{priorityInfo.label}</Tag> : null}
                </Field>
              </Row>

              {/* ── Preferred Date and Time ──────────────────────────── */}
              <div style={{ color: '#d4830d', fontWeight: 600, fontSize: 14, marginBottom: 12, marginTop: 8 }}>
                Preferred Date and Time:
              </div>
              <Row gutter={16}>
                <Field label="Option 1">
                  {d.preferred_date_first_start
                    ? `${formatDateTime(d.preferred_date_first_start)} — ${formatDateTime(d.preferred_date_first_end)}`
                    : null}
                </Field>
                <Field label="Option 2">
                  {d.preferred_date_second_start
                    ? `${formatDateTime(d.preferred_date_second_start)} — ${formatDateTime(d.preferred_date_second_end)}`
                    : null}
                </Field>
              </Row>

              {/* ── Service Start / End Date ────────────────────────── */}
              <Row gutter={16}>
                <Field label="Service Start Date">{formatDateTime(d.service_date_start)}</Field>
                <Field label="Service End Date">{formatDateTime(d.service_date_end)}</Field>
              </Row>

              {/* ── Reported By ────────────────────────────────────── */}
              <div style={{ color: '#d4830d', fontWeight: 600, fontSize: 14, marginBottom: 12, marginTop: 8 }}>
                Reported By:
              </div>
              <Row gutter={16}>
                <Field label="Contact">{d.reported_by_name}</Field>
                <Field label="Contact Phone">{d.contact_phone}</Field>
              </Row>

              {/* ── Assigned To ─────────────────────────────────────── */}
              <div style={{ color: '#d4830d', fontWeight: 600, fontSize: 14, marginBottom: 12, marginTop: 8 }}>
                Assigned To:
              </div>
              <Row gutter={16}>
                <Field label="Vendor 1">{assignee1 || null}</Field>
                <Field label="Vendor 2">{assignee2 || null}</Field>
              </Row>

              {/* ── Additional Information ───────────────────────────── */}
              <Row gutter={16}>
                <Field label="Additional Information" span={24}>
                  {d.additional_info ? (
                    <div style={{ whiteSpace: 'pre-wrap' }}>{d.additional_info}</div>
                  ) : null}
                </Field>
              </Row>

              {/* ── Note ─────────────────────────────────────────────── */}
              <Row gutter={16}>
                <Field label="Note" span={24}>
                  {d.note ? (
                    <div style={{ whiteSpace: 'pre-wrap' }}>{d.note}</div>
                  ) : null}
                </Field>
              </Row>

              {/* ── Attachments ──────────────────────────────────────── */}
              <Row gutter={16}>
                <Field label="Attachments" span={24}>
                  {(images.length > 0 || nonImages.length > 0) ? (
                    <div>
                      {images.length > 0 && (
                        <Image.PreviewGroup>
                          <Space wrap size={12} style={{ marginBottom: nonImages.length > 0 ? 12 : 0 }}>
                            {images.map(f => (
                              <Image
                                key={f.id}
                                src={`/api/file/preview/${f.id}`}
                                width={120}
                                height={120}
                                style={{ objectFit: 'cover', borderRadius: 6, border: '1px solid #e8e8e8' }}
                                alt={f.filename || 'Attachment'}
                              />
                            ))}
                          </Space>
                        </Image.PreviewGroup>
                      )}
                      {nonImages.length > 0 && (
                        <Space direction="vertical" size={4}>
                          {nonImages.map(f => {
                            const ext = (f.extension || (f.filename && f.filename.includes('.') ? f.filename.split('.').pop() : '') || '').toLowerCase();
                            const isPdf = ext === 'pdf' || (f.mime_type || '').toLowerCase() === 'application/pdf';
                            const isWord = ['doc', 'docx'].includes(ext);
                            const isExcel = ['xls', 'xlsx'].includes(ext);
                            const icon = isPdf ? <FilePdfOutlined /> : isWord ? <FileWordOutlined /> : isExcel ? <FileExcelOutlined /> : <FileOutlined />;
                            return (
                              <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                {icon}
                                <a href={`/api/file/download/${f.id}`} target="_blank" rel="noopener noreferrer">{f.filename || f.item_name || 'File'}</a>
                                <a href={`/api/file/download/${f.id}`} title="Download"><DownloadOutlined style={{ color: '#999' }} /></a>
                              </div>
                            );
                          })}
                        </Space>
                      )}
                    </div>
                  ) : null}
                </Field>
              </Row>

              {/* ── Meta ─────────────────────────────────────────────── */}
              <div style={{ borderTop: '1px solid #f0f0f0', marginTop: 8, paddingTop: 16 }}>
                <Row gutter={16}>
                  <Field label="Created By">
                    {[d.created_by_first_name, d.created_by_last_name].filter(Boolean).join(' ') || null}
                  </Field>
                  <Field label="Created">{formatDate(d.created_at)}</Field>
                </Row>
              </div>
            </div>
          )}
        </Card>
      </Space>
    </MainLayout>
  );
}
