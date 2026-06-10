'use client';

// Settings → Integrations → Xero → Categorization Rules
//
// A rule says "if a Xero transaction's description CONTAINS <pattern>, set the
// proposed category to <category>". Rules are applied in priority order
// (ascending — lower wins). First match wins. If no rule matches, the sync
// engine falls back to an LLM categorization for amounts ≥ HK$100.
//
// Workflow:
//   1. After a few syncs, look at the review queue for transactions you keep
//      categorizing the same way.
//   2. Pick a substring from the description that uniquely identifies them
//      (e.g. "HKE LEC" for HK Electric bills).
//   3. Add a rule here so next sync auto-categorizes them.
//
// hit_count is shown so you can see which rules are actually pulling weight —
// useful for pruning dead rules later.

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Card, Table, Button, Modal, Form, Input, InputNumber, Select, Switch,
  message, Space, Tag, Popconfirm, Typography, Tooltip,
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, ArrowLeftOutlined,
  ThunderboltOutlined, InfoCircleOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import MainLayout from '../../../../../components/Layout';
import { xero, accountingApi } from '../../../../../lib/api';

const { Title, Paragraph, Text } = Typography;

export default function XeroRulesPage() {
  const router = useRouter();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(true);
  const [rules, setRules] = useState([]);
  const [categories, setCategories] = useState([]);
  const [modal, setModal] = useState({ open: false, editing: null });

  const loadRules = async () => {
    setLoading(true);
    try {
      const r = await xero.getRules();
      if (r.data?.code === 200) setRules(r.data.data.rules || []);
    } catch (e) {
      message.error('Failed to load rules');
    } finally {
      setLoading(false);
    }
  };

  const loadCategories = async () => {
    try {
      const r = await accountingApi.getCategories();
      if (r.data?.code === 200) {
        const data = r.data.data;
        setCategories(Array.isArray(data) ? data : (data?.content || []));
      }
    } catch (e) {
      // Non-fatal — modal dropdown will be empty.
    }
  };

  useEffect(() => { loadRules(); loadCategories(); }, []);

  const openCreate = () => {
    form.resetFields();
    form.setFieldsValue({ priority: 100, enabled: true });
    setModal({ open: true, editing: null });
  };

  const openEdit = (rule) => {
    form.setFieldsValue({
      description_pattern: rule.description_pattern,
      category_id: rule.category_id,
      priority: rule.priority,
      enabled: rule.enabled === 1 || rule.enabled === true,
    });
    setModal({ open: true, editing: rule });
  };

  const onSave = async () => {
    try {
      const values = await form.validateFields();
      const body = {
        description_pattern: values.description_pattern,
        category_id: values.category_id,
        priority: values.priority,
        enabled: values.enabled,
      };
      const r = modal.editing
        ? await xero.updateRule(modal.editing.id, body)
        : await xero.createRule(body);
      if (r.data?.code === 200) {
        message.success(modal.editing ? 'Rule updated.' : 'Rule created.');
        setModal({ open: false, editing: null });
        await loadRules();
      } else {
        message.error(r.data?.message || 'Save failed');
      }
    } catch (e) {
      if (e?.errorFields) return; // validation failure already shown by Form
      message.error(e.response?.data?.message || 'Save failed');
    }
  };

  const onDelete = async (rule) => {
    try {
      const r = await xero.deleteRule(rule.id);
      if (r.data?.code === 200) {
        message.success('Rule deleted.');
        setRules(rs => rs.filter(x => x.id !== rule.id));
      } else {
        message.error(r.data?.message || 'Delete failed');
      }
    } catch (e) {
      message.error('Delete failed');
    }
  };

  const onToggleEnabled = async (rule) => {
    try {
      const r = await xero.updateRule(rule.id, { enabled: !rule.enabled });
      if (r.data?.code === 200) {
        setRules(rs => rs.map(x => x.id === rule.id ? { ...x, enabled: !rule.enabled ? 1 : 0 } : x));
      }
    } catch (e) {
      message.error('Failed to toggle rule');
    }
  };

  const columns = [
    {
      title: <span>Priority <Tooltip title="Lower runs first. Use 1-50 for rare/specific rules, 100+ for general fallbacks."><InfoCircleOutlined /></Tooltip></span>,
      dataIndex: 'priority', width: 100, align: 'center',
      sorter: (a, b) => a.priority - b.priority,
      defaultSortOrder: 'ascend',
    },
    {
      title: 'When description contains',
      dataIndex: 'description_pattern',
      render: v => <code style={{ background: '#fafafa', padding: '2px 6px', borderRadius: 3 }}>{v}</code>,
    },
    {
      title: '→ Category',
      dataIndex: 'category_name',
      render: v => v || <Text type="danger">(missing — category deleted?)</Text>,
    },
    {
      title: 'Hits', dataIndex: 'hit_count', width: 80, align: 'right',
      render: (v, row) => (
        <Tooltip title={row.last_hit_at ? `Last hit ${dayjs(row.last_hit_at).fromNow ? dayjs(row.last_hit_at).fromNow() : dayjs(row.last_hit_at).format('YYYY-MM-DD')}` : 'Never matched yet'}>
          <span>{v || 0}</span>
        </Tooltip>
      ),
    },
    {
      title: 'Enabled', dataIndex: 'enabled', width: 90, align: 'center',
      render: (v, row) => (
        <Switch
          size="small"
          checked={v === 1 || v === true}
          onChange={() => onToggleEnabled(row)}
        />
      ),
    },
    {
      title: 'Action', key: 'act', width: 140, align: 'center',
      render: (_, row) => (
        <Space size={4}>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(row)} />
          <Popconfirm title="Delete this rule?" onConfirm={() => onDelete(row)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
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

        <Title level={3} style={{ marginBottom: 8 }}>Xero — Categorization Rules</Title>
        <Paragraph type="secondary" style={{ marginBottom: 16 }}>
          When the sync engine pulls a transaction whose description matches one of
          these patterns, it pre-selects the matching category in the review queue.
          If no rule matches, the engine falls back to an AI categorization (for
          amounts ≥ HK$100). Rules are checked in priority order — lower runs first.
        </Paragraph>

        <Card
          size="small"
          style={{ marginBottom: 16, background: '#fafbff', borderColor: '#d6e4ff' }}
        >
          <Space>
            <ThunderboltOutlined style={{ color: '#1677ff' }} />
            <Text>
              <strong>Pro tip:</strong> after each sync, look at the review queue.
              When you see the same transaction type 3+ times being manually categorized,
              add a rule here so you stop doing it next time.
            </Text>
          </Space>
        </Card>

        <div style={{ marginBottom: 12 }}>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            Add Rule
          </Button>
        </div>

        <Table
          rowKey="id"
          columns={columns}
          dataSource={rules}
          loading={loading}
          pagination={false}
          size="small"
          locale={{ emptyText: 'No rules yet. Add one to auto-categorize recurring transactions.' }}
        />

        <Modal
          title={modal.editing ? 'Edit Rule' : 'Add Rule'}
          open={modal.open}
          onCancel={() => setModal({ open: false, editing: null })}
          onOk={onSave}
          okText={modal.editing ? 'Save' : 'Create'}
        >
          <Form form={form} layout="vertical" preserve={false}>
            <Form.Item
              label="When description contains (case-insensitive)"
              name="description_pattern"
              rules={[{ required: true, message: 'Pattern is required' }]}
              extra="Substring match. Pick the most distinctive part of the description — e.g. 'HKE LEC' for HK Electric, 'STARBUCKS' for coffee."
            >
              <Input placeholder="e.g. HKE LEC" />
            </Form.Item>
            <Form.Item
              label="Set category to"
              name="category_id"
              rules={[{ required: true, message: 'Pick a category' }]}
            >
              <Select
                showSearch
                placeholder="Pick a category"
                options={categories.map(c => ({ label: c.name, value: String(c.id) }))}
                filterOption={(input, option) =>
                  (option?.label || '').toLowerCase().includes(input.toLowerCase())
                }
              />
            </Form.Item>
            <Form.Item
              label="Priority"
              name="priority"
              extra="Lower runs first. Use 1-50 for specific rules, 100+ for general fallbacks. Default 100."
            >
              <InputNumber min={1} max={9999} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item label="Enabled" name="enabled" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Form>
        </Modal>
      </div>
    </MainLayout>
  );
}
