'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Card, Table, Tag, Input, Select, Typography, Button, Space, Empty, message,
} from 'antd';
import { SearchOutlined, ReloadOutlined, MessageOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import MainLayout from '../../../components/Layout';
import useIsMobile from '../../../hooks/useIsMobile';
import MobileCardList from '../../../components/mobile/MobileCardList';
import { chatApi } from '../../../lib/api';

const { Title, Text } = Typography;

const CHANNEL_LABELS = {
  'web': { label: 'Web', color: 'blue' },
  'whatsapp': { label: 'WhatsApp', color: 'green' },
  'staff-test': { label: 'Staff test', color: 'default' },
};

export default function ChatSessionsPage() {
  const { isMobile } = useIsMobile();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [channel, setChannel] = useState('all');

  const reload = useCallback(() => {
    setLoading(true);
    chatApi.listSessions()
      .then((r) => setRows(r.data.data || []))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (channel !== 'all' && r.channel !== channel) return false;
      if (!q) return true;
      const hay = [r.viewer_name, r.viewer_email, r.viewer_phone, r.channel_user_id]
        .filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [rows, search, channel]);

  const columns = [
    {
      title: 'Channel',
      dataIndex: 'channel',
      width: 120,
      render: (c) => {
        const info = CHANNEL_LABELS[c] || { label: c, color: 'default' };
        return <Tag color={info.color}>{info.label}</Tag>;
      },
    },
    {
      title: 'Prospect',
      key: 'prospect',
      render: (_, r) => (
        <div>
          {r.viewer_name ? <div>{r.viewer_name}</div> : <Text type="secondary">— anonymous —</Text>}
          {r.viewer_email && <div style={{ fontSize: 12, color: '#8c8c8c' }}>{r.viewer_email}</div>}
          {r.viewer_phone && <div style={{ fontSize: 12, color: '#8c8c8c' }}>{r.viewer_phone}</div>}
        </div>
      ),
    },
    {
      title: 'Messages',
      dataIndex: 'message_count',
      width: 100,
      align: 'center',
    },
    {
      title: 'Bookings',
      dataIndex: 'booking_count',
      width: 100,
      align: 'center',
      render: (n) => n > 0 ? <Tag color="green">{n}</Tag> : <Text type="secondary">0</Text>,
    },
    {
      title: 'Lead',
      dataIndex: 'lead_captured',
      width: 80,
      align: 'center',
      render: (v) => v ? <Tag color="gold">Captured</Tag> : <Text type="secondary">—</Text>,
    },
    {
      title: 'Bot',
      dataIndex: 'bot_disabled',
      width: 100,
      render: (v) => v
        ? <Tag color="red">Staff takeover</Tag>
        : <Tag color="blue">Bot active</Tag>,
    },
    {
      title: 'Last message',
      dataIndex: 'last_message_at',
      width: 160,
      render: (v, r) => (v ? dayjs(v).format('MMM D, HH:mm') : dayjs(r.created_at).format('MMM D, HH:mm')),
    },
    {
      title: '',
      key: 'actions',
      width: 110,
      render: (_, r) => (
        <Link href={`/chatbot/sessions/${r.id}`}>
          <Button size="small" type="link">View</Button>
        </Link>
      ),
    },
  ];

  return (
    <MainLayout>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <Title level={4} style={{ margin: 0 }}>Chat Sessions</Title>
          <Text type="secondary">Every conversation the assistant has had with a prospect.</Text>
        </div>
        <Space>
          <Link href="/chatbot/test">
            <Button icon={<MessageOutlined />}>New chat</Button>
          </Link>
          <Button icon={<ReloadOutlined />} onClick={reload} loading={loading}>Refresh</Button>
        </Space>
      </div>

      <Card size="small">
        <Space style={{ marginBottom: 12 }} wrap>
          <Input
            allowClear
            placeholder="Search name, email, phone"
            prefix={<SearchOutlined />}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: 260 }}
          />
          <Select
            value={channel}
            onChange={setChannel}
            style={{ width: 160 }}
            options={[
              { value: 'all', label: `All (${rows.length})` },
              { value: 'web', label: 'Web widget' },
              { value: 'whatsapp', label: 'WhatsApp' },
              { value: 'staff-test', label: 'Staff test' },
            ]}
          />
        </Space>

        {filtered.length === 0 && !loading ? (
          <Empty description={
            <Text type="secondary">
              No chat sessions yet. Start one from the <Link href="/chatbot/test">Assistant</Link> page.
            </Text>
          } />
        ) : isMobile ? (
          <MobileCardList
            loading={loading}
            dataSource={filtered}
            rowKey="id"
            renderCard={(r) => (
              <Link href={`/chatbot/sessions/${r.id}`}>
                <div style={{ padding: 8 }}>
                  <div style={{ fontWeight: 600 }}>{r.viewer_name || 'Anonymous'}</div>
                  <div style={{ fontSize: 12, color: '#8c8c8c' }}>
                    {r.viewer_email || r.channel_user_id}
                  </div>
                  <div style={{ marginTop: 6 }}>
                    <Tag color={CHANNEL_LABELS[r.channel]?.color}>
                      {CHANNEL_LABELS[r.channel]?.label}
                    </Tag>
                    {r.booking_count > 0 && <Tag color="green">{r.booking_count} booking{r.booking_count > 1 ? 's' : ''}</Tag>}
                    {r.bot_disabled ? <Tag color="red">Takeover</Tag> : null}
                  </div>
                </div>
              </Link>
            )}
          />
        ) : (
          <Table
            size="small"
            rowKey="id"
            loading={loading}
            dataSource={filtered}
            columns={columns}
            pagination={{ pageSize: 25 }}
            scroll={{ x: 'max-content' }}
          />
        )}
      </Card>
    </MainLayout>
  );
}
