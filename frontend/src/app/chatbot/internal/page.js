'use client';

/**
 * Chat: Internal — staff-only assistant for querying Tenafy data (leases,
 * invoices, vacancy, ad-hoc). Talks to POST /api/chat/internal/message, which
 * runs a hardcoded ops persona + the internal toolset. Gated on CHAT_SETTINGS_VIEW.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Card, Typography, Input, Button, Space, Spin, Tag, Alert, Avatar, message as antMessage,
} from 'antd';
import { SendOutlined, DatabaseOutlined, UserOutlined, ClearOutlined } from '@ant-design/icons';
import MainLayout from '../../../components/Layout';
import { ImageOcrPreview, useChatImageOcr } from '../../../components/chatbot/ImageAttach';
import { chatApi } from '../../../lib/api';

const { Title, Text, Paragraph } = Typography;

function Bubble({ role, content, meta }) {
  const isUser = role === 'user';
  return (
    <div style={{ display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start', marginBottom: 12 }}>
      {!isUser && <Avatar style={{ marginRight: 8, background: '#2f54eb' }} icon={<DatabaseOutlined />} />}
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

export default function InternalChatPage() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [sessionId, setSessionId] = useState(null);
  const [error, setError] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const endRef = useRef(null);

  // Live "working" timer — a query can run 1–2 min (LLM tool loop + TaneChat
  // lookups). A ticking counter + changing phrase shows it's alive, not timed out.
  useEffect(() => {
    if (!sending) { setElapsed(0); return undefined; }
    setElapsed(0);
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [sending]);
  const imageOcr = useChatImageOcr({
    onError: (msg) => {
      setError(msg);
      antMessage.error(msg);
    },
  });

  const scrollToBottom = useCallback(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => { scrollToBottom(); }, [messages, scrollToBottom]);

  const send = async () => {
    if (sending || imageOcr.reading) return;
    if (!input.trim() && !imageOcr.attachment?.text) return;
    const text = imageOcr.composeMessage(input);
    setInput('');
    imageOcr.clearAttachment();
    setError(null);
    setMessages((ms) => [...ms, { role: 'user', content: text }]);
    setSending(true);
    try {
      const payload = { message: text };
      if (sessionId) payload.session_id = sessionId;
      const r = await chatApi.internalMessage(payload);
      const { session_id, reply } = r.data.data;
      setSessionId(session_id);
      setMessages((ms) => [...ms, { role: 'assistant', content: reply }]);
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
          <Title level={4} style={{ margin: 0 }}>Chat: Internal</Title>
          <Text type="secondary">
            Query your Tenafy data — leases, invoices, vacancy, and ad-hoc questions. Staff-only; not shown to prospects.
          </Text>
        </div>
        <Space wrap>
          {sessionId && (
            <Tag color="geekblue" style={{ fontFamily: 'monospace', fontSize: 11 }}>
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
        style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 240px)', minHeight: 480 }}
      >
        <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
          {messages.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 48, color: '#8c8c8c' }}>
              <DatabaseOutlined style={{ fontSize: 48, marginBottom: 12 }} />
              <Paragraph style={{ color: '#8c8c8c' }}>
                Ask about your portfolio. Try: <em>&quot;What units are vacant now?&quot;</em>,{' '}
                <em>&quot;Upcoming vacancies with no one moving in within 15 days&quot;</em>, or{' '}
                <em>&quot;Which leases expire in the next 60 days?&quot;</em>
              </Paragraph>
            </div>
          ) : (
            messages.map((m, i) => (
              <Bubble key={i} role={m.role} content={m.content} meta={m.meta} />
            ))
          )}
          {sending && (
            <div style={{ display: 'flex', alignItems: 'center', color: '#8c8c8c', marginBottom: 12 }}>
              <Avatar style={{ marginRight: 8, background: '#2f54eb' }} icon={<DatabaseOutlined />} />
              <Spin size="small" style={{ marginRight: 8 }} />
              <span>
                {elapsed < 4 ? 'Thinking…'
                  : elapsed < 10 ? 'Searching your data…'
                  : elapsed < 25 ? 'Running queries…'
                  : elapsed < 60 ? 'Cross-referencing leases & TaneChat…'
                  : 'Still working — complex lookups can take a minute or two…'}
                {' '}
                <Text type="secondary" style={{ fontVariantNumeric: 'tabular-nums' }}>({elapsed}s)</Text>
              </span>
            </div>
          )}
          <div ref={endRef} />
        </div>
        <div style={{ borderTop: '1px solid #f0f0f0', padding: 12 }} {...imageOcr.dropProps}>
          <ImageOcrPreview
            attachment={imageOcr.attachment}
            reading={imageOcr.reading}
            onRemove={imageOcr.clearAttachment}
          />
          <Space.Compact style={{ width: '100%' }}>
            {imageOcr.attachButton}
            <Input.TextArea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKey}
              {...imageOcr.textAreaProps}
              placeholder="Ask about leases, invoices, vacancy… (Enter to send, Shift+Enter for new line)"
              autoSize={{ minRows: 1, maxRows: 4 }}
              disabled={sending || imageOcr.reading}
            />
            <Button
              type="primary"
              icon={<SendOutlined />}
              onClick={send}
              loading={sending}
              disabled={imageOcr.reading || (!input.trim() && !imageOcr.attachment?.text)}
            >
              Send
            </Button>
          </Space.Compact>
        </div>
      </Card>
    </MainLayout>
  );
}
