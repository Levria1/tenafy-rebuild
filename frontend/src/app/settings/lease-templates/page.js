'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Card, Table, Button, Tag, Space, message, Popconfirm, Tooltip,
} from 'antd';
import {
  PlusOutlined, EditOutlined, CopyOutlined, DeleteOutlined,
  StarFilled, StarOutlined, EyeOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import MainLayout from '../../../components/Layout';
import { leaseTemplate } from '../../../lib/api';

export default function LeaseTemplatesListPage() {
  const router = useRouter();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const r = await leaseTemplate.list();
      if (r.data?.code === 200) setRows(r.data.data || []);
    } catch (e) {
      message.error('Failed to load templates');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  // Open preview PDF for a saved template in a new tab.
  const onPreview = async (id) => {
    try {
      const r = await leaseTemplate.previewSaved(id);
      const url = URL.createObjectURL(new Blob([r.data], { type: 'application/pdf' }));
      window.open(url, '_blank', 'noopener');
    } catch (e) {
      message.error('Preview failed');
    }
  };

  const onSetDefault = async (id) => {
    try {
      const r = await leaseTemplate.setDefault(id);
      if (r.data?.code === 200) {
        message.success('Default template updated');
        load();
      }
    } catch (e) {
      message.error('Failed to set default');
    }
  };

  const onDuplicate = async (id) => {
    try {
      const r = await leaseTemplate.duplicate(id);
      if (r.data?.code === 200) {
        message.success('Template duplicated');
        load();
      }
    } catch (e) {
      message.error('Failed to duplicate');
    }
  };

  const onDelete = async (id) => {
    try {
      const r = await leaseTemplate.remove(id);
      if (r.data?.code === 200) {
        message.success('Template archived');
        load();
      }
    } catch (e) {
      message.error('Failed to archive');
    }
  };

  const columns = [
    {
      title: 'Name',
      dataIndex: 'name',
      render: (v, row) => (
        <Space>
          <a onClick={() => router.push(`/settings/lease-templates/${row.id}/edit`)}>{v}</a>
          {row.is_default ? <Tag color="gold" icon={<StarFilled />}>Default</Tag> : null}
        </Space>
      ),
    },
    { title: 'Description', dataIndex: 'description', ellipsis: true,
      render: (v) => v || <span style={{ color: '#bbb' }}>—</span> },
    { title: 'Page', dataIndex: 'page_size', width: 80 },
    { title: 'Version', dataIndex: 'version', width: 90,
      render: (v) => <Tag>v{v}</Tag> },
    { title: 'Updated', dataIndex: 'updated_at', width: 160,
      render: (v) => v ? dayjs(v).format('YYYY-MM-DD HH:mm') : '—' },
    {
      title: 'Actions', width: 230, fixed: 'right',
      render: (_, row) => (
        <Space size="small">
          <Tooltip title="Preview PDF">
            <Button size="small" icon={<EyeOutlined />} onClick={() => onPreview(row.id)} />
          </Tooltip>
          <Tooltip title="Edit">
            <Button size="small" icon={<EditOutlined />} onClick={() => router.push(`/settings/lease-templates/${row.id}/edit`)} />
          </Tooltip>
          {!row.is_default && (
            <Tooltip title="Set as default">
              <Button size="small" icon={<StarOutlined />} onClick={() => onSetDefault(row.id)} />
            </Tooltip>
          )}
          <Tooltip title="Duplicate">
            <Button size="small" icon={<CopyOutlined />} onClick={() => onDuplicate(row.id)} />
          </Tooltip>
          <Popconfirm
            title="Archive this template?"
            description="Existing signed leases that used it are unaffected."
            okText="Archive"
            okType="danger"
            onConfirm={() => onDelete(row.id)}
          >
            <Button size="small" danger icon={<DeleteOutlined />} disabled={!!row.is_default} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <MainLayout>
      <div style={{ padding: '0 0 24px 0' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0, color: '#333' }}>Lease Templates</h2>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => router.push('/settings/lease-templates/create')}
          >
            New Template
          </Button>
        </div>
        <Card bodyStyle={{ padding: 0 }}>
          <Table
            rowKey="id"
            loading={loading}
            dataSource={rows}
            columns={columns}
            pagination={false}
            size="middle"
            locale={{ emptyText: 'No templates yet — click "New Template" to create your first one.' }}
          />
        </Card>
        <div style={{ marginTop: 12, fontSize: 12, color: '#888' }}>
          Templates use <code>{'{{VARIABLES}}'}</code> like <code>{'{{TENANT_NAME}}'}</code> that get replaced with real lease data when a lease PDF is generated. The default template is used unless staff override it on a specific lease.
        </div>
      </div>
    </MainLayout>
  );
}
