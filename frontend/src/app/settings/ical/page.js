'use client';

import { useEffect, useState } from 'react';
import { Button, Card, Modal, Space, Table, Typography, message } from 'antd';
import { CopyOutlined, ReloadOutlined, SyncOutlined } from '@ant-design/icons';
import MainLayout from '../../../components/Layout';
import { icalApi } from '../../../lib/api';

const { Paragraph, Text } = Typography;

function csvValue(value) {
  return `"${String(value == null ? '' : value).replace(/"/g, '""')}"`;
}

function buildCsv(rows) {
  const header = ['Property', 'Unit', 'Feed URL'];
  const lines = rows.map((row) => [
    row.property_name,
    row.unit_name,
    row.feed_url,
  ].map(csvValue).join(','));
  return [header.map(csvValue).join(','), ...lines].join('\n');
}

async function copyText(text, successMessage) {
  await navigator.clipboard.writeText(text);
  message.success(successMessage);
}

export default function IcalSettingsPage() {
  const [rows, setRows] = useState([]);
  const [baseUrl, setBaseUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [rotatingId, setRotatingId] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const r = await icalApi.listTokens();
      if (r.data?.code === 200) {
        setBaseUrl(r.data.data?.base_url || '');
        setRows(r.data.data?.units || []);
      }
    } catch (e) {
      message.error('Failed to load iCal feeds');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const rotate = (row) => {
    Modal.confirm({
      title: 'Rotate feed URL?',
      content: 'The old URL will stop working. Update the Airbnb listing with the new URL after rotating.',
      okText: 'Rotate',
      okButtonProps: { danger: true },
      async onOk() {
        setRotatingId(row.unit_id);
        try {
          const r = await icalApi.rotateToken(row.unit_id);
          if (r.data?.code === 200) {
            const feedUrl = r.data.data?.feed_url;
            setRows((current) => current.map((item) => (
              item.unit_id === row.unit_id ? { ...item, feed_url: feedUrl } : item
            )));
            message.success('Feed URL rotated');
          }
        } catch (e) {
          message.error('Failed to rotate feed URL');
        } finally {
          setRotatingId(null);
        }
      },
    });
  };

  const columns = [
    {
      title: 'Property',
      dataIndex: 'property_name',
      width: 220,
      sorter: (a, b) => String(a.property_name || '').localeCompare(String(b.property_name || '')),
    },
    {
      title: 'Unit',
      dataIndex: 'unit_name',
      width: 140,
      sorter: (a, b) => String(a.unit_name || '').localeCompare(String(b.unit_name || '')),
    },
    {
      title: 'Feed URL',
      dataIndex: 'feed_url',
      ellipsis: true,
      render: (value) => (
        <Text
          copyable={false}
          style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace', fontSize: 12 }}
        >
          {value}
        </Text>
      ),
    },
    {
      title: 'Actions',
      width: 180,
      fixed: 'right',
      render: (_, row) => (
        <Space size="small">
          <Button
            size="small"
            icon={<CopyOutlined />}
            onClick={() => copyText(row.feed_url, 'Feed URL copied')}
          >
            Copy
          </Button>
          <Button
            size="small"
            danger
            icon={<ReloadOutlined />}
            loading={rotatingId === row.unit_id}
            onClick={() => rotate(row)}
          >
            Rotate
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <MainLayout>
      <div style={{ padding: '0 0 24px 0' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', marginBottom: 16 }}>
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0, color: '#333' }}>Airbnb iCal Feeds</h2>
            <Paragraph style={{ margin: '8px 0 0 0', maxWidth: 820, color: '#666' }}>
              Paste the URL into the Airbnb listing under <Text strong>Availability &gt; Sync calendars &gt; Import calendar</Text>.
              Airbnb refreshes every 1-2 hours. The feed blocks dates only and does not set prices. Treat the URL as a secret because it reveals occupancy.
            </Paragraph>
            {baseUrl ? (
              <div style={{ marginTop: 8, fontSize: 12, color: '#888' }}>
                Base URL: <Text code>{baseUrl}</Text>
              </div>
            ) : null}
          </div>
          <Space>
            <Button icon={<SyncOutlined />} onClick={load} loading={loading}>
              Refresh
            </Button>
            <Button
              type="primary"
              icon={<CopyOutlined />}
              disabled={!rows.length}
              onClick={() => copyText(buildCsv(rows), 'CSV copied')}
            >
              Copy all as CSV
            </Button>
          </Space>
        </div>

        <Card bodyStyle={{ padding: 0 }}>
          <Table
            rowKey="unit_id"
            loading={loading}
            dataSource={rows}
            columns={columns}
            pagination={false}
            scroll={{ x: 900 }}
            locale={{ emptyText: 'No units found.' }}
          />
        </Card>
      </div>
    </MainLayout>
  );
}
