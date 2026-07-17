'use client';

/**
 * Page shell shared by /chatbot/rules and /chatbot/faq.
 *
 * Both pages are the same shape — heading, Refresh, locked banner, then the
 * KnowledgeCard — and both need `settings_locked` from GET /api/chat/settings
 * to know whether editing is allowed. Keeping that in one place means the two
 * route files stay one-liners.
 */

import { useCallback, useEffect, useState } from 'react';
import { Typography, Button, Alert, Spin, message } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import MainLayout from '../Layout';
import KnowledgeCard from './KnowledgeCard';
import { chatApi } from '../../lib/api';

const { Title, Text } = Typography;

// Titles match the sidebar labels ("Rules Database" / "FAQ Database") so the
// page you land on is named the same as the link you clicked.
const COPY = {
  rule: {
    title: 'Rules Database',
    subtitle: "Behavior rules that shape how the bot responds.",
  },
  faq: {
    title: 'FAQ Database',
    subtitle: 'Question-and-answer entries the bot falls back on when live data has no answer.',
  },
};

export default function KnowledgePage({ kind }) {
  const [locked, setLocked] = useState(false);
  const [loading, setLoading] = useState(true);
  // Bumped by Refresh — passed down so the card re-fetches without remounting
  // (which would otherwise wipe the user's filter/search selection).
  const [refreshToken, setRefreshToken] = useState(0);

  const loadSettings = useCallback(() => {
    setLoading(true);
    chatApi.getSettings()
      .then((r) => setLocked(Boolean(r.data?.data?.settings_locked)))
      .catch(() => message.error('Failed to load settings'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadSettings(); }, [loadSettings]);

  const onRefresh = () => {
    loadSettings();
    setRefreshToken((t) => t + 1);
  };

  const copy = COPY[kind] || COPY.rule;

  if (loading) {
    return <MainLayout><div style={{ textAlign: 'center', padding: 48 }}><Spin size="large" /></div></MainLayout>;
  }

  return (
    <MainLayout>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <Title level={4} style={{ margin: 0 }}>{copy.title}</Title>
          <Text type="secondary">{copy.subtitle}</Text>
        </div>
        <Button icon={<ReloadOutlined />} onClick={onRefresh}>Refresh</Button>
      </div>

      {locked && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="Settings are locked by the platform operator"
          description="You can view these entries but cannot edit them. Contact support to request changes."
        />
      )}

      <KnowledgeCard kind={kind} locked={locked} refreshToken={refreshToken} />
    </MainLayout>
  );
}
