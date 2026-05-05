'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import {
  Card, Descriptions, Button, Space, Tag, message, Spin, Empty, List, Typography,
  Popconfirm,
} from 'antd';
import {
  UserAddOutlined, CalendarOutlined, ArrowLeftOutlined, EditOutlined,
  DeleteOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import MainLayout from '../../../components/Layout';
import { inquiry } from '../../../lib/api';
import CreateViewingModal from '../CreateViewingModal';

const { Text } = Typography;

const STATUS_LABELS = { 0: 'Open', 1: 'Converted', 2: 'Closed' };
const STATUS_COLORS = { 0: 'blue', 1: 'green', 2: 'default' };
const VIEWING_STATUS = { 0: 'Pending', 1: 'Confirmed', 2: 'Declined', 3: 'Cancelled' };

export default function InquiryDetailPage() {
  const router = useRouter();
  const params = useParams();
  const id = params?.id;
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [viewingModalOpen, setViewingModalOpen] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const r = await inquiry.get(id);
      if (r.data?.code === 200) setData(r.data.data);
    } catch (e) {
      message.error('Failed to load inquiry');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (id) load(); }, [id]);

  const onConvertToContact = () => {
    const params = new URLSearchParams({ inquiry_id: String(id) });
    if (data.first_name) params.set('first_name', data.first_name);
    if (data.last_name) params.set('last_name', data.last_name);
    if (data.email) params.set('email', data.email);
    if (data.phone) params.set('phone', data.phone);
    if (data.notes) params.set('notes', data.notes);
    if (data.lead_source_id) params.set('lead_source_id', String(data.lead_source_id));
    router.push(`/contacts/tenant/create?${params.toString()}`);
  };

  const onCreateViewing = () => setViewingModalOpen(true);

  if (loading) return <MainLayout><div style={{ padding: 24, textAlign: 'center' }}><Spin /></div></MainLayout>;
  if (!data) return <MainLayout><Empty description="Inquiry not found" /></MainLayout>;

  return (
    <MainLayout>
      <div style={{ padding: '0 0 24px 0' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
          <Space>
            <Button icon={<ArrowLeftOutlined />} onClick={() => router.push('/inquiries')}>Back</Button>
            <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0, color: '#333' }}>
              Inquiry —{' '}
              {[data.first_name, data.last_name].filter(Boolean).join(' ') || '(no name)'}
            </h2>
            <Tag color={STATUS_COLORS[data.status]}>{STATUS_LABELS[data.status]}</Tag>
          </Space>
          <Space wrap>
            <Button icon={<EditOutlined />} onClick={() => router.push(`/inquiries/${id}/edit`)}>Edit</Button>
            <Button icon={<CalendarOutlined />} onClick={onCreateViewing}>Create Viewing</Button>
            <Button
              type="primary"
              icon={<UserAddOutlined />}
              disabled={!!data.tenant_id}
              onClick={onConvertToContact}
            >
              {data.tenant_id ? 'Already a Contact' : 'Create Contact'}
            </Button>
            <Popconfirm
              title="Delete this inquiry?"
              onConfirm={async () => {
                try {
                  await inquiry.delete(id);
                  message.success('Inquiry deleted');
                  router.push('/inquiries');
                } catch (e) {
                  message.error('Failed to delete inquiry');
                }
              }}
            >
              <Button danger icon={<DeleteOutlined />}>Delete</Button>
            </Popconfirm>
          </Space>
        </div>

        <Card style={{ marginBottom: 16 }}>
          <Descriptions column={{ xs: 1, sm: 2 }} size="small" bordered>
            <Descriptions.Item label="Date">
              {data.inquiry_date ? dayjs(data.inquiry_date).format('YYYY-MM-DD') : '—'}
            </Descriptions.Item>
            <Descriptions.Item label="Lead Source">{data.lead_source_name || '—'}</Descriptions.Item>
            <Descriptions.Item label="First Name">{data.first_name || '—'}</Descriptions.Item>
            <Descriptions.Item label="Last Name">{data.last_name || '—'}</Descriptions.Item>
            <Descriptions.Item label="Email">{data.email || '—'}</Descriptions.Item>
            <Descriptions.Item label="Phone">{data.phone || '—'}</Descriptions.Item>
            <Descriptions.Item label="Desired Start">
              {data.desired_start_date ? dayjs(data.desired_start_date).format('YYYY-MM-DD') : '—'}
            </Descriptions.Item>
            <Descriptions.Item label="Budget">
              {data.budget != null ? Number(data.budget).toLocaleString() : '—'}
            </Descriptions.Item>
            <Descriptions.Item label="Reminder">
              {data.reminder_date
                ? `${dayjs(data.reminder_date).format('YYYY-MM-DD')}${data.reminder_sent_at ? ' (sent)' : ''}`
                : '—'}
            </Descriptions.Item>
            <Descriptions.Item label="User">
              {(data.created_by_name && data.created_by_name.trim()) || data.created_by_email || '—'}
            </Descriptions.Item>
            <Descriptions.Item label="Source">{data.source}</Descriptions.Item>
            {data.property_name && (
              <Descriptions.Item label="Property" span={2}>
                {data.property_name}{data.unit_name ? ` · ${data.unit_name}` : ''}
              </Descriptions.Item>
            )}
            {data.tenant_id && (
              <Descriptions.Item label="Linked Contact" span={2}>
                <a onClick={() => router.push(`/contacts/tenant/${data.tenant_id}/detail`)}>
                  View contact #{data.tenant_id}
                </a>
              </Descriptions.Item>
            )}
          </Descriptions>
        </Card>

        <Card title="Notes" size="small" style={{ marginBottom: 16 }}>
          <div style={{ whiteSpace: 'pre-wrap', minHeight: 60, color: data.notes ? '#333' : '#999' }}>
            {data.notes || 'No notes yet.'}
          </div>
        </Card>

        <Card title="Linked Viewings" size="small">
          {(!data.viewings || data.viewings.length === 0) ? (
            <Empty description="No viewings yet" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          ) : (
            <List
              dataSource={data.viewings}
              renderItem={(v) => (
                <List.Item>
                  <List.Item.Meta
                    title={
                      <Space>
                        <Text>{dayjs(v.proposed_datetime).format('YYYY-MM-DD HH:mm')}</Text>
                        <Tag>{VIEWING_STATUS[v.status]}</Tag>
                      </Space>
                    }
                    description={`${v.property_name || ''}${v.unit_name ? ` · ${v.unit_name}` : ''}`}
                  />
                </List.Item>
              )}
            />
          )}
        </Card>
      </div>
      <CreateViewingModal
        open={viewingModalOpen}
        inquiry={data}
        onClose={() => setViewingModalOpen(false)}
        onCreated={load}
      />
    </MainLayout>
  );
}
