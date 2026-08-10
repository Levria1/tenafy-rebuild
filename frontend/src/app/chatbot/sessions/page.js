'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Card, Table, Tag, Input, Select, Typography, Button, Space, Empty, Segmented, message,
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
  'email': { label: 'Email', color: 'purple' },
  'airbnb': { label: 'Airbnb', color: 'red' },
  'staff-test': { label: 'Bookings (staff)', color: 'default' },
  'staff-internal': { label: 'Internal (staff)', color: 'geekblue' },
};

function channelLabel(value) {
  const channel = value == null ? '' : String(value).trim().toLowerCase();
  if (!channel) return '';
  const label = channel.replace(/-+/g, ' ');
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function channelInfo(value) {
  const key = value == null ? '' : String(value).trim().toLowerCase();
  return CHANNEL_LABELS[key] || { label: channelLabel(key), color: 'default' };
}

export default function ChatSessionsPage() {
  const { isMobile } = useIsMobile();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [channel, setChannel] = useState('all');
  // Default to Tenafy — this page's original purpose was the Tenafy assistants'
  // own chats; TaneChat (WhatsApp/email) conversations are kept but opt-in.
  const [source, setSource] = useState('tenafy');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [total, setTotal] = useState(0);
  const [sourceCounts, setSourceCounts] = useState({ all: 0, tenafy: 0, tanechat: 0 });

  const reload = useCallback(() => {
    setLoading(true);
    chatApi.listSessions({
      page,
      pageSize,
      source,
      ...(channel !== 'all' ? { channel } : {}),
      ...(debouncedSearch.trim() ? { search: debouncedSearch.trim() } : {}),
    })
      .then((r) => {
        const data = r.data.data || {};
        // Older backends returned an array. Keep the page tolerant during deploys.
        if (Array.isArray(data)) {
          setRows(data);
          setTotal(data.length);
          setSourceCounts({ all: data.length, tenafy: 0, tanechat: 0 });
          return;
        }
        setRows(data.sessions || []);
        setTotal(Number(data.total) || 0);
        setSourceCounts(data.sourceCounts || { all: 0, tenafy: 0, tanechat: 0 });
      })
      .catch(() => {
        setRows([]);
        setTotal(0);
        message.error('Failed to load chat sessions');
      })
      .finally(() => setLoading(false));
  }, [channel, debouncedSearch, page, pageSize, source]);

  useEffect(() => { reload(); }, [reload]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const resetPage = () => setPage(1);

  const handlePageChange = (nextPage, nextPageSize) => {
    setPage(nextPage);
    if (nextPageSize !== pageSize) {
      setPageSize(nextPageSize);
    }
  };

  const columns = [
    {
      title: 'Channel',
      dataIndex: 'channel',
      width: 120,
      render: (c) => {
        const info = channelInfo(c);
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
          <Text type="secondary">Conversations run in Tenafy (the staff assistants) and logged from TaneChat (WhatsApp/email).</Text>
        </div>
        <Space>
          <Link href="/chatbot/test">
            <Button icon={<MessageOutlined />}>New chat</Button>
          </Link>
          <Button icon={<ReloadOutlined />} onClick={reload} loading={loading}>Refresh</Button>
        </Space>
      </div>

      <Card size="small">
        <Segmented
          value={source}
          onChange={(value) => {
            setSource(value);
            resetPage();
          }}
          style={{ marginBottom: 12 }}
          options={[
            { label: `Tenafy (${sourceCounts.tenafy})`, value: 'tenafy' },
            { label: `TaneChat (${sourceCounts.tanechat})`, value: 'tanechat' },
            { label: `All (${sourceCounts.all})`, value: 'all' },
          ]}
        />
        <Space style={{ marginBottom: 12 }} wrap>
          <Input
            allowClear
            placeholder="Search name, email, phone"
            prefix={<SearchOutlined />}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              resetPage();
            }}
            style={{ width: 260 }}
          />
          <Select
            value={channel}
            onChange={(value) => {
              setChannel(value);
              resetPage();
            }}
            style={{ width: 180 }}
            options={[
              { value: 'all', label: 'All channels' },
              { value: 'staff-test', label: 'Bookings (staff)' },
              { value: 'staff-internal', label: 'Internal (staff)' },
              { value: 'whatsapp', label: 'WhatsApp' },
              { value: 'email', label: 'Email' },
              { value: 'airbnb', label: 'Airbnb' },
              { value: 'web', label: 'Web widget' },
            ]}
          />
        </Space>

        {rows.length === 0 && !loading ? (
          <Empty description={
            <Text type="secondary">
              No chat sessions yet. Start one from the <Link href="/chatbot/test">Assistant</Link> page.
            </Text>
          } />
        ) : isMobile ? (
          <MobileCardList
            loading={loading}
            dataSource={rows}
            rowKey="id"
            pagination={{
              current: page,
              pageSize,
              total,
              onChange: handlePageChange,
            }}
            renderCard={(r) => (
              <Link href={`/chatbot/sessions/${r.id}`}>
                <div style={{ padding: 8 }}>
                  <div style={{ fontWeight: 600 }}>{r.viewer_name || 'Anonymous'}</div>
                  <div style={{ fontSize: 12, color: '#8c8c8c' }}>
                    {r.viewer_email || r.channel_user_id}
                  </div>
                  <div style={{ marginTop: 6 }}>
                    <Tag color={channelInfo(r.channel).color}>
                      {channelInfo(r.channel).label}
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
            dataSource={rows}
            columns={columns}
            pagination={{
              current: page,
              pageSize,
              total,
              showSizeChanger: true,
            }}
            onChange={(pagination) => handlePageChange(pagination.current, pagination.pageSize)}
            scroll={{ x: 'max-content' }}
          />
        )}
      </Card>
    </MainLayout>
  );
}
