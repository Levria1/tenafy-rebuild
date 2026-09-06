'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Card, Button, Space, Tag, Image, message, Modal, Row, Col, Select, Input, Upload, Divider, DatePicker } from 'antd';
import dayjs from 'dayjs';
import { EditOutlined, ArrowLeftOutlined, DeleteOutlined, FileOutlined, FilePdfOutlined, FileImageOutlined, FileWordOutlined, FileExcelOutlined, DownloadOutlined, PlusOutlined, CloudUploadOutlined, ClockCircleOutlined, UserOutlined } from '@ant-design/icons';
import MainLayout, { useAuth } from '../../../../components/Layout';
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
  const [showAddUpdate, setShowAddUpdate] = useState(false);
  const [activityStatus, setActivityStatus] = useState(undefined);
  const [activityDate, setActivityDate] = useState(null);
  const [activityNote, setActivityNote] = useState('');
  const [activityFiles, setActivityFiles] = useState([]);
  const [submittingActivity, setSubmittingActivity] = useState(false);
  const router = useRouter();
  const params = useParams();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission ? hasPermission('LANDLORD/SERVICE_EDIT') : false;
  const canDelete = hasPermission ? hasPermission('LANDLORD/SERVICE_DELETE') : false;
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

  const handleAddActivity = async () => {
    if (!activityNote.trim() && activityStatus === undefined && activityFiles.length === 0) {
      message.warning('Please add a note, status change, or photos');
      return;
    }
    try {
      setSubmittingActivity(true);
      // Upload files first
      const uploadedIds = [];
      for (const f of activityFiles) {
        if (f.originFileObj) {
          const formData = new FormData();
          formData.append('file', f.originFileObj);
          const uploadRes = await fileApi.upload(formData);
          if (uploadRes.data.code === 200) {
            uploadedIds.push(uploadRes.data.data.id);
          }
        }
      }
      await service.addActivity({
        service_id: serviceId,
        status: activityStatus ?? null,
        activity_date: activityDate ? activityDate.format('YYYY-MM-DD HH:mm:ss') : null,
        note: activityNote.trim() || null,
        file_ids: uploadedIds,
      });
      message.success('Update added');
      setShowAddUpdate(false);
      setActivityStatus(undefined);
      setActivityDate(null);
      setActivityNote('');
      setActivityFiles([]);
      loadService();
    } catch (error) {
      message.error('Failed to add update');
    } finally {
      setSubmittingActivity(false);
    }
  };

  const handleDeleteActivity = (activityId) => {
    Modal.confirm({
      title: 'Delete this update?',
      content: 'This will remove the update and its attached files.',
      okText: 'Delete',
      okType: 'danger',
      onOk: async () => {
        try {
          await service.deleteActivity(activityId);
          message.success('Update deleted');
          loadService();
        } catch (error) {
          message.error('Failed to delete update');
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
            {canDelete && <Button danger icon={<DeleteOutlined />} onClick={handleDelete}>Delete</Button>}
            {canEdit && <Button type="primary" icon={<EditOutlined />} onClick={() => router.push(`/services/${serviceId}/edit`)}>Edit Service</Button>}
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

              {/* ── Message to tenant ────────────────────────────────── */}
              {/* Above the internal note, and labelled as visible, so the difference
                  between the two boxes is obvious at a glance rather than remembered. */}
              <Row gutter={16}>
                <Field label="Message to tenant" span={24}>
                  {d.tenant_note ? (
                    <div style={{ whiteSpace: 'pre-wrap' }}>{d.tenant_note}</div>
                  ) : null}
                </Field>
              </Row>

              {/* ── Note (internal) ──────────────────────────────────── */}
              <Row gutter={16}>
                <Field label="Note (internal)" span={24}>
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

        {/* ── Activity Timeline ──────────────────────────────────── */}
        {d && (
          <Card
            title="Activity Timeline"
            extra={
              canEdit && !showAddUpdate && (
                <Button type="primary" icon={<PlusOutlined />} onClick={() => setShowAddUpdate(true)}>
                  Add Update
                </Button>
              )
            }
          >
            {/* Add Update Form */}
            {showAddUpdate && (
              <div style={{ background: '#fafafa', border: '1px solid #e8e8e8', borderRadius: 6, padding: 16, marginBottom: 20 }}>
                <div style={{ fontWeight: 600, marginBottom: 12, fontSize: 14 }}>New Update</div>
                <div style={{ display: 'flex', gap: 16, marginBottom: 12 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#555', marginBottom: 4, textTransform: 'uppercase' }}>Status Change (Optional)</div>
                    <Select
                      placeholder="No status change"
                      allowClear
                      value={activityStatus}
                      onChange={setActivityStatus}
                      style={{ width: '100%' }}
                      options={[
                        { label: 'Pending', value: 0 },
                        { label: 'In Progress', value: 1 },
                        { label: 'Completed', value: 2 },
                        { label: 'Cancelled', value: 3 },
                      ]}
                    />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#555', marginBottom: 4, textTransform: 'uppercase' }}>Date</div>
                    <DatePicker
                      value={activityDate}
                      onChange={setActivityDate}
                      showTime={{ format: 'HH:mm' }}
                      format="YYYY-MM-DD HH:mm"
                      style={{ width: '100%' }}
                      placeholder="Select date & time"
                    />
                  </div>
                </div>
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#555', marginBottom: 4, textTransform: 'uppercase' }}>Note</div>
                  <Input.TextArea
                    rows={3}
                    placeholder="Describe the update..."
                    value={activityNote}
                    onChange={(e) => setActivityNote(e.target.value)}
                  />
                </div>
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#555', marginBottom: 4, textTransform: 'uppercase' }}>Photos / Files</div>
                  <Upload.Dragger
                    multiple
                    fileList={activityFiles}
                    beforeUpload={() => false}
                    onChange={({ fileList }) => setActivityFiles(fileList)}
                  >
                    <p className="ant-upload-drag-icon"><CloudUploadOutlined style={{ fontSize: 32, color: '#1890ff' }} /></p>
                    <p style={{ fontSize: 13 }}>Click or drag files to upload</p>
                    <p style={{ fontSize: 11, color: '#999' }}>Images, videos, PDF, Word, Excel</p>
                  </Upload.Dragger>
                </div>
                <Space>
                  <Button type="primary" onClick={handleAddActivity} loading={submittingActivity}>Submit Update</Button>
                  <Button onClick={() => { setShowAddUpdate(false); setActivityStatus(undefined); setActivityDate(null); setActivityNote(''); setActivityFiles([]); }}>Cancel</Button>
                </Space>
              </div>
            )}

            {/* Timeline entries */}
            {d.activities && d.activities.length > 0 ? (
              <div>
                {d.activities.map((act, idx) => {
                  const actStatus = STATUS_MAP[act.status];
                  const actImages = (act.files || []).filter(isImage);
                  const actNonImages = (act.files || []).filter(f => !isImage(f));
                  const userName = [act.user_first_name, act.user_last_name].filter(Boolean).join(' ') || 'Unknown';

                  return (
                    <div key={act.id} style={{ position: 'relative', paddingLeft: 28, paddingBottom: idx < d.activities.length - 1 ? 24 : 0 }}>
                      {/* Timeline dot and line */}
                      <div style={{
                        position: 'absolute', left: 0, top: 4,
                        width: 12, height: 12, borderRadius: '50%',
                        background: actStatus ? actStatus.color === 'green' ? '#52c41a' : actStatus.color === 'blue' ? '#1677ff' : actStatus.color === 'orange' ? '#faad14' : '#ff4d4f' : '#d9d9d9',
                        border: '2px solid #fff', boxShadow: '0 0 0 1px #e8e8e8',
                      }} />
                      {idx < d.activities.length - 1 && (
                        <div style={{
                          position: 'absolute', left: 5, top: 18,
                          width: 2, height: 'calc(100% - 10px)',
                          background: '#e8e8e8',
                        }} />
                      )}

                      {/* Content */}
                      <div style={{ background: '#fff', border: '1px solid #f0f0f0', borderRadius: 6, padding: 12 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            {actStatus && <Tag color={actStatus.color}>{actStatus.label}</Tag>}
                            <span style={{ fontSize: 13, color: '#555' }}>
                              <UserOutlined style={{ marginRight: 4 }} />{userName}
                            </span>
                            {act.activity_date && (
                              <span style={{ fontSize: 12, color: '#1677ff' }}>
                                <ClockCircleOutlined style={{ marginRight: 4 }} />{formatDateTime(act.activity_date)}
                              </span>
                            )}
                            <span style={{ fontSize: 12, color: '#999' }}>
                              Added {formatDateTime(act.created_at)}
                            </span>
                          </div>
                          {canEdit && (
                            <Button
                              type="text"
                              size="small"
                              danger
                              icon={<DeleteOutlined />}
                              onClick={() => handleDeleteActivity(act.id)}
                            />
                          )}
                        </div>

                        {act.note && (
                          <div style={{ whiteSpace: 'pre-wrap', fontSize: 13, marginBottom: actImages.length > 0 || actNonImages.length > 0 ? 8 : 0 }}>
                            {act.note}
                          </div>
                        )}

                        {actImages.length > 0 && (
                          <Image.PreviewGroup>
                            <Space wrap size={8} style={{ marginBottom: actNonImages.length > 0 ? 8 : 0 }}>
                              {actImages.map(f => (
                                <Image
                                  key={f.id}
                                  src={`/api/file/preview/${f.id}`}
                                  width={100}
                                  height={100}
                                  style={{ objectFit: 'cover', borderRadius: 4, border: '1px solid #e8e8e8' }}
                                  alt={f.filename || 'Photo'}
                                />
                              ))}
                            </Space>
                          </Image.PreviewGroup>
                        )}

                        {actNonImages.length > 0 && (
                          <Space direction="vertical" size={4}>
                            {actNonImages.map(f => {
                              const ext = (f.extension || '').toLowerCase();
                              const isPdf = ext === 'pdf';
                              const isWord = ['doc', 'docx'].includes(ext);
                              const isExcel = ['xls', 'xlsx'].includes(ext);
                              const icon = isPdf ? <FilePdfOutlined /> : isWord ? <FileWordOutlined /> : isExcel ? <FileExcelOutlined /> : <FileOutlined />;
                              return (
                                <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                  {icon}
                                  <a href={`/api/file/download/${f.id}`} target="_blank" rel="noopener noreferrer">{f.filename || 'File'}</a>
                                </div>
                              );
                            })}
                          </Space>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div style={{ color: '#999', textAlign: 'center', padding: 24 }}>
                No activity updates yet. Click "Add Update" to log progress.
              </div>
            )}
          </Card>
        )}
      </Space>
    </MainLayout>
  );
}
