'use client';

// Settings → Integrations
//
// Today only has Xero. The page is designed to scale to other integrations
// later (Stripe, etc.) — each one is a self-contained card with its own
// status / connect / disconnect actions.

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Card, Button, Tag, message, Popconfirm, Spin, Typography } from 'antd';
import {
  LinkOutlined, DisconnectOutlined, CheckCircleFilled,
  ExclamationCircleFilled,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import MainLayout from '../../../components/Layout';
import { xero } from '../../../lib/api';

const { Title, Paragraph, Text } = Typography;

export default function IntegrationsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [xeroStatus, setXeroStatus] = useState(null);
  const [loading, setLoading]       = useState(true);
  const [busy, setBusy]             = useState(false);

  // Surface OAuth round-trip outcome to the user (set by the callback redirect).
  useEffect(() => {
    if (searchParams.get('xero_connected') === '1') {
      message.success('Xero connected successfully.');
    }
    const err = searchParams.get('xero_error');
    if (err) message.error(`Xero connect failed: ${decodeURIComponent(err)}`);
  }, [searchParams]);

  const loadStatus = async () => {
    setLoading(true);
    try {
      const r = await xero.status();
      if (r.data?.code === 200) setXeroStatus(r.data.data);
    } catch (e) {
      message.error('Failed to load Xero status');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadStatus(); }, []);

  const onConnect = () => {
    // Full-page navigation — the OAuth flow needs the top-level URL to change
    // so Xero's redirect back lands in the same browser context.
    window.location.href = xero.connectUrl();
  };

  const onDisconnect = async () => {
    setBusy(true);
    try {
      await xero.disconnect();
      message.success('Xero disconnected.');
      await loadStatus();
    } catch (e) {
      message.error('Failed to disconnect Xero');
    } finally {
      setBusy(false);
    }
  };

  const connected = xeroStatus?.connected === true;

  return (
    <MainLayout>
      <div style={{ padding: '0 0 24px 0', maxWidth: 880 }}>
        <Title level={3} style={{ marginBottom: 8 }}>Integrations</Title>
        <Paragraph type="secondary" style={{ marginBottom: 24 }}>
          Connect Tenafy to your accounting and banking tools so transactions
          flow automatically.
        </Paragraph>

        {/* ───────────────── Xero card ───────────────── */}
        <Card
          style={{ marginBottom: 16 }}
          styles={{ body: { padding: 20 } }}
          title={
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{
                width: 32, height: 32, borderRadius: 4, background: '#13B5EA',
                color: 'white', display: 'inline-flex', alignItems: 'center',
                justifyContent: 'center', fontWeight: 700, fontSize: 14,
              }}>X</span>
              <span style={{ fontSize: 16, fontWeight: 600 }}>Xero</span>
              {loading ? null : connected ? (
                <Tag icon={<CheckCircleFilled />} color="success">Connected</Tag>
              ) : (
                <Tag icon={<ExclamationCircleFilled />} color="default">Not connected</Tag>
              )}
            </div>
          }
        >
          <Paragraph style={{ color: '#666', marginBottom: 16 }}>
            Pull bank transactions from Xero into Tenafy and auto-match them
            to invoices and accounts. Sync runs only when you click <strong>Sync Now</strong>
            on the Reconcile page — nothing auto-commits without your approval.
          </Paragraph>

          {loading ? (
            <Spin />
          ) : connected ? (
            <div>
              <div style={{
                background: '#f6ffed', border: '1px solid #b7eb8f',
                borderRadius: 4, padding: 12, marginBottom: 16,
              }}>
                <div style={{ marginBottom: 4 }}>
                  <Text strong>Connected to:</Text>{' '}
                  <Text>{xeroStatus.xero_tenant_name || '(unnamed org)'}</Text>
                </div>
                <div style={{ fontSize: 12, color: '#666' }}>
                  Connected {xeroStatus.connected_at
                    ? dayjs(xeroStatus.connected_at).format('YYYY-MM-DD HH:mm')
                    : '(unknown)'}
                  {xeroStatus.last_synced_at && (
                    <> · Last sync {dayjs(xeroStatus.last_synced_at).format('YYYY-MM-DD HH:mm')}</>
                  )}
                  {xeroStatus.last_sync_status === 'error' && (
                    <div style={{ color: '#ff4d4f', marginTop: 4 }}>
                      Last sync error: {xeroStatus.last_sync_message}
                    </div>
                  )}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <Button
                  type="primary"
                  onClick={() => router.push('/settings/integrations/xero/accounts')}
                >
                  Manage account mappings
                </Button>
                <Button
                  onClick={() => router.push('/settings/integrations/xero/rules')}
                >
                  Categorization rules
                </Button>
                <Popconfirm
                  title="Disconnect Xero?"
                  description="Tenafy will lose access to your Xero data. Existing imported transactions will remain. You can reconnect anytime."
                  onConfirm={onDisconnect}
                  okText="Disconnect"
                  okButtonProps={{ danger: true }}
                  cancelText="Cancel"
                >
                  <Button icon={<DisconnectOutlined />} loading={busy} danger>
                    Disconnect
                  </Button>
                </Popconfirm>
              </div>
            </div>
          ) : (
            <div>
              <Button type="primary" icon={<LinkOutlined />} onClick={onConnect}>
                Connect to Xero
              </Button>
              <div style={{ fontSize: 12, color: '#999', marginTop: 8 }}>
                You'll be redirected to Xero to approve access. Tenafy will
                only read transactions, contacts, and account settings — it
                cannot create or modify anything in Xero.
              </div>
            </div>
          )}
        </Card>
      </div>
    </MainLayout>
  );
}
