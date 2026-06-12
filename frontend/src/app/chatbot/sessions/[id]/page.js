'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  Card, Typography, Button, Space, Spin, Tag, Empty, Popconfirm, message, Descriptions, Input,
} from 'antd';
import {
  ArrowLeftOutlined, ReloadOutlined, StopOutlined, PlayCircleOutlined, RobotOutlined, UserOutlined, ToolOutlined, SendOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import MainLayout from '../../../../components/Layout';
import { chatApi } from '../../../../lib/api';

const { Title, Text, Paragraph } = Typography;

function RoleBadge({ role }) {
  switch (role) {
    case 'user':      return <Tag color="blue" icon={<UserOutlined />}>User</Tag>;
    case 'assistant': return <Tag color="purple" icon={<RobotOutlined />}>Assistant</Tag>;
    case 'tool':      return <Tag color="gold" icon={<ToolOutlined />}>Tool result</Tag>;
    case 'system':    return <Tag color="default">System</Tag>;
    default:          return <Tag color="default">{role}</Tag>;
  }
}

function formatToolResult(content) {
  if (!content) return '';
  try {
    const parsed = JSON.parse(content);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return String(content);
  }
}

export default function SessionDetailPage() {
  const { id } = useParams();
  const router = useRouter();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);

  const reload = useCallback(() => {
    if (!id) return;
    setLoading(true);
    chatApi.getSession(id)
      .then((r) => setData(r.data.data))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => { reload(); }, [reload]);

  const handleToggleTakeover = async () => {
    const newState = !data.session.bot_disabled;
    try {
      await chatApi.takeover(id, newState);
      message.success(newState ? 'Bot disabled for this session' : 'Bot re-enabled');
      reload();
    } catch (e) {
      message.error(e?.response?.data?.message || 'Failed to toggle');
    }
  };

  // Continue this conversation — sends another turn into the SAME session and
  // refreshes the transcript with the assistant's reply.
  const sendReply = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      const r = await chatApi.sendMessage({ message: text, session_id: id });
      if (r.data?.code === 200) {
        setInput('');
        reload();
      } else {
        message.error(r.data?.message || 'Failed to send');
      }
    } catch (e) {
      message.error(e?.response?.data?.message || 'Failed to send');
    } finally {
      setSending(false);
    }
  };

  if (loading) {
    return <MainLayout><div style={{ textAlign: 'center', padding: 48 }}><Spin size="large" /></div></MainLayout>;
  }
  if (!data) {
    return <MainLayout><Card>Session not found</Card></MainLayout>;
  }

  const { session, messages } = data;

  return (
    <MainLayout>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
        <Space>
          <Button icon={<ArrowLeftOutlined />} onClick={() => router.push('/chatbot/sessions')}>Back</Button>
          <Title level={4} style={{ margin: 0 }}>Chat session</Title>
        </Space>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={reload}>Refresh</Button>
          {session.bot_disabled ? (
            <Popconfirm title="Re-enable the bot for this session?" onConfirm={handleToggleTakeover}>
              <Button type="primary" icon={<PlayCircleOutlined />}>Re-enable bot</Button>
            </Popconfirm>
          ) : (
            <Popconfirm title="Disable the bot? The next message will return 423 Locked." okText="Disable" okType="danger" onConfirm={handleToggleTakeover}>
              <Button danger icon={<StopOutlined />}>Take over from bot</Button>
            </Popconfirm>
          )}
        </Space>
      </div>

      <Card size="small" style={{ marginBottom: 16 }}>
        <Descriptions size="small" column={{ xs: 1, sm: 2, md: 3 }}>
          <Descriptions.Item label="Channel">{session.channel}</Descriptions.Item>
          <Descriptions.Item label="Session key">{session.channel_user_id}</Descriptions.Item>
          <Descriptions.Item label="Created">{dayjs(session.created_at).format('MMM D, YYYY HH:mm')}</Descriptions.Item>
          <Descriptions.Item label="Prospect">{session.viewer_name || <Text type="secondary">—</Text>}</Descriptions.Item>
          <Descriptions.Item label="Email">{session.viewer_email || <Text type="secondary">—</Text>}</Descriptions.Item>
          <Descriptions.Item label="Phone">{session.viewer_phone || <Text type="secondary">—</Text>}</Descriptions.Item>
          <Descriptions.Item label="Messages">{session.message_count}</Descriptions.Item>
          <Descriptions.Item label="Bookings">{session.booking_count}</Descriptions.Item>
          <Descriptions.Item label="Lead captured">{session.lead_captured ? 'Yes' : 'No'}</Descriptions.Item>
        </Descriptions>
      </Card>

      <Card size="small" title="Transcript">
        {messages.length === 0 ? (
          <Empty description="No messages yet" />
        ) : (
          <div style={{ maxWidth: 860 }}>
            {messages.map((m) => (
              <div key={m.id} style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <RoleBadge role={m.role} />
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {dayjs(m.created_at).format('HH:mm:ss')}
                    {m.tokens_in || m.tokens_out ? ` · ${m.tokens_in}→${m.tokens_out} tok` : ''}
                  </Text>
                </div>
                {m.role === 'tool' ? (
                  <div style={{ background: '#fff7e6', padding: 10, borderRadius: 6, border: '1px solid #ffe58f' }}>
                    <Text strong style={{ fontSize: 12 }}>{m.tool_name}</Text>
                    <pre style={{ fontSize: 12, margin: '6px 0 0', maxHeight: 260, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
                      {formatToolResult(m.content)}
                    </pre>
                  </div>
                ) : m.role === 'assistant' && m.tool_calls ? (
                  <div style={{ background: '#f9f0ff', padding: 10, borderRadius: 6, border: '1px solid #d3adf7' }}>
                    {m.content && <Paragraph style={{ margin: 0, marginBottom: 8 }}>{m.content}</Paragraph>}
                    <Text strong style={{ fontSize: 12, color: '#722ed1' }}>Tool calls:</Text>
                    {(typeof m.tool_calls === 'string' ? JSON.parse(m.tool_calls) : m.tool_calls).map((tc, i) => (
                      <div key={i} style={{ marginTop: 4, fontSize: 12, fontFamily: 'monospace' }}>
                        → <strong>{tc.function?.name}</strong>({tc.function?.arguments})
                      </div>
                    ))}
                  </div>
                ) : m.role === 'system' ? (
                  <div style={{ background: '#fafafa', padding: 10, borderRadius: 6, color: '#8c8c8c', fontSize: 12, whiteSpace: 'pre-wrap' }}>
                    {m.content}
                  </div>
                ) : (
                  <div style={{
                    background: m.role === 'user' ? '#e6f4ff' : '#f6ffed',
                    padding: 10, borderRadius: 6,
                    border: `1px solid ${m.role === 'user' ? '#91caff' : '#b7eb8f'}`,
                    whiteSpace: 'pre-wrap',
                  }}>
                    {m.content}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card size="small" style={{ marginTop: 16 }}>
        {session.bot_disabled ? (
          <Text type="secondary">
            The bot is taken over for this session — re-enable it above to continue the conversation here.
          </Text>
        ) : (
          <Space.Compact style={{ width: '100%' }}>
            <Input.TextArea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendReply(); } }}
              placeholder="Continue this conversation… (Enter to send, Shift+Enter for new line)"
              autoSize={{ minRows: 1, maxRows: 4 }}
              disabled={sending}
            />
            <Button type="primary" icon={<SendOutlined />} onClick={sendReply} loading={sending} disabled={!input.trim()}>
              Send
            </Button>
          </Space.Compact>
        )}
      </Card>
    </MainLayout>
  );
}
