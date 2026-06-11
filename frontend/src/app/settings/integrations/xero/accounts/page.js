'use client';

// Settings → Integrations → Xero → Account Mapping
//
// Each Xero BANK account (left) maps to one Tenafy account_setting (right).
// The sync engine uses this mapping to route incoming Xero transactions into
// the correct Tenafy account. Rows without a mapping are still pulled but
// land in the review queue as "unmapped" — the user has to fix before commit.
//
// Save uploads the full mapping set in one request; backend wipes + re-inserts
// in a transaction (small dataset, simpler than diff/patch).

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Card, Table, Select, Button, message, Spin, Typography, Tag, Space, Alert,
} from 'antd';
import {
  SaveOutlined, ArrowLeftOutlined, ReloadOutlined,
} from '@ant-design/icons';
import MainLayout from '../../../../../components/Layout';
import { xero } from '../../../../../lib/api';

const { Title, Paragraph, Text } = Typography;

// Sentinel mapping value for "skip this Xero account entirely". Kept in sync
// with the backend constant in routes/xero.js.
const IGNORE = '__IGNORE__';

export default function XeroAccountMappingPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [xeroAccounts, setXeroAccounts] = useState([]);
  const [tenafyAccounts, setTenafyAccounts] = useState([]);
  // Working copy of the mapping: { [xero_account_id]: tenafy_account_setting_id | null }
  const [mappings, setMappings] = useState({});
  const [dirty, setDirty] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const r = await xero.getAccounts();
      if (r.data?.code === 200) {
        const { xero_accounts, mappings: existing, tenafy_accounts } = r.data.data;
        setXeroAccounts(xero_accounts || []);
        setTenafyAccounts(tenafy_accounts || []);
        setMappings(existing || {});
        setDirty(false);
      } else {
        message.error(r.data?.message || 'Failed to load accounts');
      }
    } catch (e) {
      message.error(e.response?.data?.message || 'Failed to load Xero accounts');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const onChangeMapping = (xeroId, tenafyId) => {
    setMappings(prev => ({ ...prev, [xeroId]: tenafyId || null }));
    setDirty(true);
  };

  const onSave = async () => {
    setSaving(true);
    try {
      const payload = xeroAccounts.map(a => ({
        xero_account_id:   a.id,
        xero_account_code: a.code,
        xero_account_name: a.name,
        xero_account_type: a.type,
        // '__IGNORE__' sentinel → backend stores ignored=1 (no Tenafy target).
        ignored: mappings[a.id] === IGNORE,
        tenafy_account_setting_id: mappings[a.id] === IGNORE ? null : (mappings[a.id] || null),
      }));
      const r = await xero.saveAccountMap(payload);
      if (r.data?.code === 200) {
        message.success(`Saved ${r.data.data.saved} mappings.`);
        setDirty(false);
      } else {
        message.error(r.data?.message || 'Save failed');
      }
    } catch (e) {
      message.error(e.response?.data?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  // Count how many are mapped / ignored / unmapped so the user can see progress
  // at a glance — useful when you have 6+ accounts and want to know what's left.
  const ignoredCount = xeroAccounts.filter(a => mappings[a.id] === IGNORE).length;
  const mappedCount = xeroAccounts.filter(a => mappings[a.id] && mappings[a.id] !== IGNORE).length;
  const unmappedCount = xeroAccounts.length - mappedCount - ignoredCount;

  const columns = [
    {
      title: 'Xero Account',
      key: 'xero',
      render: (_, row) => (
        <div>
          <div style={{ fontWeight: 500 }}>{row.name}</div>
          <div style={{ fontSize: 11, color: '#999' }}>
            {row.code ? `Code ${row.code}` : null}
            {row.bankAccountNumber ? ` · ${row.bankAccountNumber}` : null}
            {row.currencyCode ? ` · ${row.currencyCode}` : null}
          </div>
        </div>
      ),
    },
    {
      title: 'Status', key: 'status', width: 100,
      render: (_, row) => (
        <Tag color={row.status === 'ACTIVE' ? 'green' : 'default'}>{row.status}</Tag>
      ),
    },
    {
      title: '→ Tenafy Account',
      key: 'tenafy',
      width: 360,
      render: (_, row) => (
        <Select
          showSearch
          allowClear
          placeholder="Pick a Tenafy account"
          style={{ width: '100%' }}
          value={mappings[row.id] || undefined}
          onChange={(v) => onChangeMapping(row.id, v)}
          options={[
            {
              label: '🚫 Ignore (don\'t sync this account)',
              value: IGNORE,
            },
            ...tenafyAccounts.map(a => ({
              label: a.name,
              value: a.id,
            })),
          ]}
          filterOption={(input, option) =>
            (option?.label || '').toLowerCase().includes(input.toLowerCase())
          }
        />
        {mappings[row.id] === IGNORE && (
          <div style={{ fontSize: 11, color: '#999', marginTop: 4 }}>
            Transactions from this account are skipped at sync — they won't appear in the review queue.
          </div>
        )}
      ),
    },
  ];

  return (
    <MainLayout>
      <div style={{ padding: '0 0 24px 0', maxWidth: 1100 }}>
        <Space style={{ marginBottom: 12 }}>
          <Button
            type="text"
            icon={<ArrowLeftOutlined />}
            onClick={() => router.push('/settings/integrations')}
          >
            Back to Integrations
          </Button>
        </Space>

        <Title level={3} style={{ marginBottom: 8 }}>Xero — Account Mapping</Title>
        <Paragraph type="secondary" style={{ marginBottom: 16 }}>
          Tell Tenafy which Tenafy account each Xero bank account should sync into.
          Transactions from unmapped Xero accounts will still be pulled, but they'll
          land in the review queue without a proposed account — you'll need to set
          one before approving them.
        </Paragraph>

        {loading ? (
          <Spin />
        ) : xeroAccounts.length === 0 ? (
          <Alert
            type="info"
            showIcon
            message="No bank accounts found in Xero"
            description="Make sure your Xero organisation has at least one BANK-type account, then click Refresh."
            action={<Button icon={<ReloadOutlined />} onClick={load}>Refresh</Button>}
          />
        ) : (
          <>
            <Card size="small" style={{ marginBottom: 12 }}>
              <Space size={24}>
                <span>
                  <Text strong>{xeroAccounts.length}</Text>
                  <Text type="secondary"> Xero bank accounts</Text>
                </span>
                <span>
                  <Text strong style={{ color: '#52c41a' }}>{mappedCount}</Text>
                  <Text type="secondary"> mapped</Text>
                </span>
                <span>
                  <Text strong style={{ color: unmappedCount > 0 ? '#faad14' : '#999' }}>
                    {unmappedCount}
                  </Text>
                  <Text type="secondary"> unmapped</Text>
                </span>
                <span>
                  <Text strong style={{ color: ignoredCount > 0 ? '#8c8c8c' : '#999' }}>
                    {ignoredCount}
                  </Text>
                  <Text type="secondary"> ignored</Text>
                </span>
              </Space>
            </Card>

            <Table
              rowKey="id"
              columns={columns}
              dataSource={xeroAccounts}
              pagination={false}
              size="small"
            />

            <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
              <Button
                type="primary"
                icon={<SaveOutlined />}
                loading={saving}
                disabled={!dirty}
                onClick={onSave}
              >
                Save Mappings
              </Button>
              <Button icon={<ReloadOutlined />} onClick={load} disabled={saving}>
                Refresh from Xero
              </Button>
              {dirty && (
                <Text type="warning" style={{ alignSelf: 'center', marginLeft: 8 }}>
                  Unsaved changes
                </Text>
              )}
            </div>
          </>
        )}
      </div>
    </MainLayout>
  );
}
