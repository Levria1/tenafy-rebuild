'use client';

import { useEffect, useState } from 'react';
import {
  Table, Card, Typography, Space, Tag, message, Button, Modal, Form,
  Select, Input, Popconfirm, Divider, Empty, Tooltip,
} from 'antd';
import {
  SoundOutlined, ReloadOutlined, ThunderboltOutlined, PlusOutlined, DeleteOutlined,
} from '@ant-design/icons';
import MainLayout from '../../../components/Layout';
import { advertisingApi } from '../../../lib/api';

const { Title, Text } = Typography;

export default function SchedulerPage() {
  const [slots, setSlots] = useState([]);
  const [urgent, setUrgent] = useState([]);
  const [meta, setMeta] = useState({ filled: 0, overflow: 0, slot_count: 20 });
  const [loading, setLoading] = useState(true);
  const [properties, setProperties] = useState([]); // for the urgent picker

  // Urgent add modal
  const [addOpen, setAddOpen] = useState(false);
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await advertisingApi.getScheduler();
      if (res.data.code === 200) {
        const d = res.data.data;
        setSlots(d.slots || []);
        setUrgent(d.urgent || []);
        setMeta({ filled: d.filled || 0, overflow: d.overflow || 0, slot_count: d.slot_count || 20 });
        // Property options for the urgent picker come from the filled slots.
        const props = (d.slots || []).filter(s => s.property_id)
          .map(s => ({ value: s.property_id, label: s.property_name }));
        setProperties(props);
      } else {
        message.error(res.data.message || 'Failed to load scheduler');
      }
    } catch (e) {
      message.error('Failed to load scheduler');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const addUrgent = async () => {
    try {
      const vals = await form.validateFields();
      setSaving(true);
      await advertisingApi.addUrgent(vals);
      message.success('Urgent entry added');
      setAddOpen(false);
      form.resetFields();
      load();
    } catch (e) {
      if (e?.errorFields) return;
      message.error('Failed to add urgent entry');
    } finally {
      setSaving(false);
    }
  };

  const slotColumns = [
    {
      title: '#',
      dataIndex: 'position',
      key: 'position',
      width: 60,
      render: (v) => <Text strong>{v}</Text>,
    },
    {
      title: 'Property',
      dataIndex: 'property_name',
      key: 'property_name',
      render: (v) => v || <Text type="secondary" style={{ fontStyle: 'italic' }}>— empty —</Text>,
    },
    {
      title: 'Units',
      dataIndex: 'unit_names',
      key: 'unit_names',
      render: (v, r) => v
        ? <Space size={[4, 4]} wrap>{r.units.map(u => (
            <Tag key={u.unit_id} color={u.status === 'vacant' ? 'red' : 'green'}>{u.unit_name}</Tag>
          ))}</Space>
        : <Text type="secondary">—</Text>,
    },
    {
      title: 'Vacant Date',
      dataIndex: 'vacant_date',
      key: 'vacant_date',
      width: 140,
      render: (v) => v || <Text type="secondary">—</Text>,
    },
  ];

  return (
    <MainLayout>
      <div style={{ padding: 24 }}>
        <Space align="center" style={{ marginBottom: 4 }}>
          <SoundOutlined style={{ fontSize: 22, color: '#1677ff' }} />
          <Title level={3} style={{ margin: 0 }}>Scheduler</Title>
        </Space>
        <div style={{ marginBottom: 16 }}>
          <Text type="secondary">
            A rolling roster of {meta.slot_count} slots, auto-ranked by how long each property has been
            vacant (longest first). Regenerates from live vacancy data. Urgent entries below are manual
            and carry their own forum rule.
          </Text>
        </div>

        <Card
          title={<Space><Text strong>Roster</Text><Tag color="blue">{meta.filled}/{meta.slot_count} filled</Tag>{meta.overflow > 0 && <Tooltip title="Vacancies beyond the 20 slots"><Tag color="orange">+{meta.overflow} waiting</Tag></Tooltip>}</Space>}
          extra={<a onClick={load}><ReloadOutlined /> Refresh</a>}
          styles={{ body: { padding: 0 } }}
          style={{ borderColor: '#e8e8e8', marginBottom: 24 }}
        >
          <Table
            rowKey="position"
            columns={slotColumns}
            dataSource={slots}
            loading={loading}
            pagination={false}
            size="small"
            rowClassName={(r) => (r.property_id ? '' : 'scheduler-empty-row')}
          />
        </Card>

        <Card
          title={<Space><ThunderboltOutlined style={{ color: '#faad14' }} /><Text strong>Urgent</Text><Text type="secondary" style={{ fontSize: 12 }}>manual — extra postings, own forum rule</Text></Space>}
          extra={<Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => setAddOpen(true)}>Add Urgent</Button>}
          styles={{ body: { padding: 16 } }}
          style={{ borderColor: '#e8e8e8' }}
        >
          {urgent.length === 0 ? (
            <Empty description="No urgent entries" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          ) : (
            <Table
              rowKey="id"
              pagination={false}
              size="small"
              dataSource={urgent}
              columns={[
                { title: 'Property / Label', key: 'what', render: (_, r) => r.property_name || r.label || <Text type="secondary">—</Text> },
                { title: 'Units', key: 'units', render: (_, r) => r.unit_ids?.length ? <Tag>{r.unit_ids.length} unit{r.unit_ids.length === 1 ? '' : 's'}</Tag> : <Text type="secondary">—</Text> },
                { title: 'Forum Rule', dataIndex: 'forum_rule', key: 'forum_rule', render: (v) => v || <Text type="secondary">— not set —</Text> },
                { title: 'Note', dataIndex: 'note', key: 'note', render: (v) => v || <Text type="secondary">—</Text> },
                {
                  title: '', key: 'actions', width: 50, render: (_, r) => (
                    <Popconfirm title="Remove this urgent entry?" onConfirm={async () => { await advertisingApi.deleteUrgent(r.id); message.success('Removed'); load(); }} okText="Remove" okButtonProps={{ danger: true }}>
                      <Button size="small" danger icon={<DeleteOutlined />} />
                    </Popconfirm>
                  ),
                },
              ]}
            />
          )}
        </Card>
      </div>

      <Modal
        title="Add Urgent Entry"
        open={addOpen}
        onCancel={() => setAddOpen(false)}
        onOk={addUrgent}
        confirmLoading={saving}
        okText="Add"
      >
        <Form form={form} layout="vertical">
          <Form.Item name="property_id" label="Property (optional)"
            tooltip="Pick a property currently in the roster, or leave blank and use a label.">
            <Select allowClear showSearch optionFilterProp="label" placeholder="Select a property" options={properties} />
          </Form.Item>
          <Form.Item name="label" label="Label (if no property)">
            <Input placeholder="e.g. Mercer 4A — urgent" />
          </Form.Item>
          <Form.Item name="forum_rule" label="Forum rule"
            tooltip="Which forum/account this urgent posting goes to. Free text for now — structured forum picker comes with the forum list.">
            <Input placeholder="e.g. Post daily to Group X on Account 1" />
          </Form.Item>
          <Form.Item name="note" label="Note (optional)">
            <Input.TextArea rows={2} placeholder="Anything to remember" />
          </Form.Item>
        </Form>
      </Modal>

      <style jsx global>{`
        .scheduler-empty-row td { background: #fafafa; }
      `}</style>
    </MainLayout>
  );
}
