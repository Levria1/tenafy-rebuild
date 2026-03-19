'use client';

import { useState, useEffect, useCallback } from 'react';
import { Table, Button, Card, message, Switch, Space, Modal, Form, Input, Select, Tag, Typography, Tooltip } from 'antd';
import { PlusOutlined, ReloadOutlined, CopyOutlined, DeleteOutlined } from '@ant-design/icons';
import { master } from '../../../lib/api';
import dayjs from 'dayjs';

const { Text } = Typography;

export default function ApiKeysPage() {
  const [keys, setKeys] = useState([]);
  const [orgs, setOrgs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [newKeyResult, setNewKeyResult] = useState(null);
  const [form] = Form.useForm();

  const fetchKeys = useCallback(async () => {
    setLoading(true);
    try {
      const res = await master.listApiKeys();
      setKeys(res.data.data || []);
    } catch (err) {
      message.error('Failed to load API keys');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchOrgs = useCallback(async () => {
    try {
      const res = await master.listOrganizations();
      setOrgs(res.data.data || []);
    } catch (err) {
      // ignore
    }
  }, []);

  useEffect(() => {
    fetchKeys();
    fetchOrgs();
  }, [fetchKeys, fetchOrgs]);

  const handleCreate = async (values) => {
    try {
      const res = await master.createApiKey(values);
      setNewKeyResult(res.data.data);
      setCreateModalOpen(false);
      form.resetFields();
      fetchKeys();
    } catch (err) {
      message.error(err.response?.data?.message || 'Failed to create API key');
    }
  };

  const handleToggleStatus = async (record) => {
    const newStatus = Number(record.status) === 1 ? 0 : 1;
    try {
      await master.updateApiKey(record.id, { status: newStatus });
      message.success(`API key ${newStatus === 1 ? 'enabled' : 'disabled'}`);
      fetchKeys();
    } catch (err) {
      message.error('Failed to update API key');
    }
  };

  const handleDelete = (record) => {
    Modal.confirm({
      title: 'Delete API Key',
      content: `Are you sure you want to delete "${record.name}"? Any integrations using this key will stop working.`,
      okText: 'Delete',
      okType: 'danger',
      onOk: async () => {
        try {
          await master.deleteApiKey(record.id);
          message.success('API key deleted');
          fetchKeys();
        } catch (err) {
          message.error('Failed to delete API key');
        }
      },
    });
  };

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
    message.success('Copied to clipboard');
  };

  const columns = [
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
    },
    {
      title: 'Organization',
      dataIndex: 'org_name',
      key: 'org_name',
    },
    {
      title: 'API Key',
      dataIndex: 'api_key',
      key: 'api_key',
      render: (v) => (
        <Space>
          <Text code style={{ fontSize: 12 }}>{v.substring(0, 12)}...{v.substring(v.length - 6)}</Text>
          <Tooltip title="Copy full key">
            <Button type="text" size="small" icon={<CopyOutlined />} onClick={() => copyToClipboard(v)} />
          </Tooltip>
        </Space>
      ),
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      render: (status, record) => (
        <Switch
          checked={Number(status) === 1}
          checkedChildren="Active"
          unCheckedChildren="Disabled"
          onChange={() => handleToggleStatus(record)}
        />
      ),
    },
    {
      title: 'Last Used',
      dataIndex: 'last_used_at',
      key: 'last_used_at',
      render: (v) => v ? dayjs(v).format('MMM D, YYYY h:mm A') : <Tag>Never</Tag>,
    },
    {
      title: 'Created',
      dataIndex: 'created_at',
      key: 'created_at',
      render: (v) => v ? dayjs(v).format('MMM D, YYYY') : '-',
    },
    {
      title: '',
      key: 'actions',
      width: 50,
      render: (_, record) => (
        <Button type="text" danger size="small" icon={<DeleteOutlined />} onClick={() => handleDelete(record)} />
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>API Keys</h2>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={fetchKeys}>Refresh</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateModalOpen(true)}>
            Create API Key
          </Button>
        </Space>
      </div>

      <Card>
        <Table
          columns={columns}
          dataSource={keys}
          rowKey="id"
          loading={loading}
          pagination={false}
        />
      </Card>

      {/* Usage info */}
      <Card title="Usage" style={{ marginTop: 16 }}>
        <Text type="secondary">
          Use these API keys to access the public API. Pass the key via the <Text code>X-API-Key</Text> header.
        </Text>
        <pre style={{ background: '#f5f5f5', padding: 12, borderRadius: 6, marginTop: 12, fontSize: 13 }}>
{`# Get available units (defaults to today)
curl -H "X-API-Key: YOUR_KEY" https://yourdomain.com/api/public/units/available

# Get available units on a specific date
curl -H "X-API-Key: YOUR_KEY" https://yourdomain.com/api/public/units/available?date=2026-04-01

# Filter by property
curl -H "X-API-Key: YOUR_KEY" https://yourdomain.com/api/public/units/available?propertyId=123

# List properties with vacancy counts
curl -H "X-API-Key: YOUR_KEY" https://yourdomain.com/api/public/properties`}
        </pre>
      </Card>

      {/* Create Modal */}
      <Modal
        title="Create API Key"
        open={createModalOpen}
        onCancel={() => { setCreateModalOpen(false); form.resetFields(); }}
        onOk={() => form.submit()}
        okText="Create"
      >
        <Form form={form} layout="vertical" onFinish={handleCreate}>
          <Form.Item name="org_id" label="Organization" rules={[{ required: true, message: 'Select an organization' }]}>
            <Select
              placeholder="Select organization"
              options={orgs.filter(o => Number(o.status) === 1).map(o => ({ value: o.id, label: o.display_name }))}
              showSearch
              filterOption={(input, option) => option.label.toLowerCase().includes(input.toLowerCase())}
            />
          </Form.Item>
          <Form.Item name="name" label="Key Name" rules={[{ required: true, message: 'Enter a name' }]}>
            <Input placeholder="e.g. Scraper Bot, Partner Integration" />
          </Form.Item>
        </Form>
      </Modal>

      {/* New Key Result Modal */}
      <Modal
        title="API Key Created"
        open={!!newKeyResult}
        onCancel={() => setNewKeyResult(null)}
        footer={[
          <Button key="copy" type="primary" icon={<CopyOutlined />} onClick={() => { copyToClipboard(newKeyResult?.api_key); setNewKeyResult(null); }}>
            Copy & Close
          </Button>,
        ]}
      >
        <p>Your new API key has been created. <strong>Copy it now</strong> — you won't be able to see the full key again.</p>
        <Input.TextArea
          value={newKeyResult?.api_key}
          readOnly
          autoSize
          style={{ fontFamily: 'monospace', fontSize: 13 }}
        />
      </Modal>
    </div>
  );
}
