'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Card, Typography, Input, Button, Space, Spin, Tag, Alert, Avatar, message as antMessage,
} from 'antd';
import { SendOutlined, RobotOutlined, UserOutlined, ReloadOutlined, ClearOutlined } from '@ant-design/icons';
import MainLayout from '../../../components/Layout';
import { chatApi } from '../../../lib/api';

const { Title, Text, Paragraph } = Typography;

function Bubble({ role, content, meta }) {
  const isUser = role === 'user';
  return (
    <div style={{ display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start', marginBottom: 12 }}>
      {!isUser && <Avatar style={{ marginRight: 8, background: '#722ed1' }} icon={<RobotOutlined />} />}
      <div style={{ maxWidth: '70%' }}>
        <div
          style={{
            background: isUser ? '#1677ff' : '#f5f5f5',
            color: isUser ? '#fff' : '#000',
            padding: '10px 14px',
            borderRadius: 12,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {content}
        </div>
        {meta && (
          <div style={{ fontSize: 11, color: '#8c8c8c', marginTop: 4, textAlign: isUser ? 'right' : 'left' }}>
            {meta}
          </div>
        )}
      </div>
      {isUser && <Avatar style={{ marginLeft: 8, background: '#1677ff' }} icon={<UserOutlined />} />}
    </div>
  );
}

export default function TestChatPage() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [sessionId, setSessionId] = useState(null);
  const [error, setError] = useState(null);
  const endRef = useRef(null);

  const scrollToBottom = useCallback(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => { scrollToBottom(); }, [messages, scrollToBottom]);

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput('');
    setError(null);
    const userMsg = { role: 'user', content: text };
    setMessages((ms) => [...ms, userMsg]);
    setSending(true);
    try {
      const payload = { message: text };
      if (sessionId) payload.session_id = sessionId;
      const r = await chatApi.sendMessage(payload);
      const { session_id, reply, usage } = r.data.data;
      setSessionId(session_id);
      setMessages((ms) => [...ms, {
        role: 'assistant',
        content: reply,
      }]);
    } catch (e) {
      const msg = e?.response?.data?.message || e.message || 'Request failed';
      setError(msg);
      setMessages((ms) => [...ms, { role: 'assistant', content: `⚠️ ${msg}`, meta: 'error' }]);
    } finally {
      setSending(false);
    }
  };

  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const reset = () => {
    setMessages([]);
    setSessionId(null);
    setError(null);
  };

  return (
    <MainLayout>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <Title level={4} style={{ margin: 0 }}>Assistant</Title>
          <Text type="secondary">
            Chat with the assistant to answer prospect enquiries. Conversations are saved — reopen and continue any of them from Sessions.
          </Text>
        </div>
        <Space wrap>
          {sessionId && (
            <Tag color="blue" style={{ fontFamily: 'monospace', fontSize: 11 }}>
              Session: {String(sessionId).slice(-10)}
            </Tag>
          )}
          <Button icon={<ClearOutlined />} onClick={reset} disabled={!messages.length && !sessionId}>
            New conversation
          </Button>
          {sessionId && (
            <Link href={`/chatbot/sessions/${sessionId}`}>
              <Button>View full transcript</Button>
            </Link>
          )}
        </Space>
      </div>

      <Alert
        type="info"
        showIcon
        message="This is a live conversation — replies and any bookings the bot makes are real (source='bot')."
        description="Each conversation is saved and can be reopened and continued from the Sessions page."
        style={{ marginBottom: 16 }}
      />

      {error && (
        <Alert
          type="error"
          showIcon
          closable
          message={error}
          onClose={() => setError(null)}
          style={{ marginBottom: 16 }}
        />
      )}

      <Card
        bodyStyle={{ padding: 0 }}
        style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 280px)', minHeight: 480 }}
      >
        <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
          {messages.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 48, color: '#8c8c8c' }}>
              <RobotOutlined style={{ fontSize: 48, marginBottom: 12 }} />
              <Paragraph style={{ color: '#8c8c8c' }}>
                Say hi to start. Try: <em>&quot;What 2BR units do you have under $1500?&quot;</em>
              </Paragraph>
            </div>
          ) : (
            messages.map((m, i) => (
              <Bubble key={i} role={m.role} content={m.content} meta={m.meta} />
            ))
          )}
          {sending && (
            <div style={{ display: 'flex', alignItems: 'center', color: '#8c8c8c', marginBottom: 12 }}>
              <Avatar style={{ marginRight: 8, background: '#722ed1' }} icon={<RobotOutlined />} />
              <Spin size="small" style={{ marginRight: 8 }} /> thinking…
            </div>
          )}
          <div ref={endRef} />
        </div>
        <div style={{ borderTop: '1px solid #f0f0f0', padding: 12 }}>
          <Space.Compact style={{ width: '100%' }}>
            <Input.TextArea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKey}
              placeholder="Ask anything… (Enter to send, Shift+Enter for new line)"
              autoSize={{ minRows: 1, maxRows: 4 }}
              disabled={sending}
            />
            <Button
              type="primary"
              icon={<SendOutlined />}
              onClick={send}
              loading={sending}
              disabled={!input.trim()}
            >
              Send
            </Button>
          </Space.Compact>
        </div>
      </Card>
    </MainLayout>
  );
}
