'use client';

/**
 * The documents attached to a tenant.
 *
 * Chiefly the ID screenshots Smart Extract saves when a record is created or
 * edited. Those used to be discarded after OCR, which meant that when a
 * passport number came out wrong there was no way to see what the machine had
 * actually been looking at. Keeping them gives the record its own evidence.
 *
 * Removing a document unlinks it from this tenant rather than destroying the
 * file, because the same image may be attached elsewhere.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Table, Button, Empty, Spin, Space, Tag, Modal, Image, Popconfirm, message, Typography,
} from 'antd';
import { DownloadOutlined, DeleteOutlined, EyeOutlined, FileOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { tenant } from '../lib/api';

const { Text } = Typography;

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'];

function readableSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default function TenantDocuments({ tenantId, canDelete = true }) {
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const r = await tenant.listFiles(tenantId);
      setFiles(r.data?.data || []);
    } catch (e) {
      message.error('Could not load documents');
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => { load(); }, [load]);

  const remove = async (fileId) => {
    try {
      await tenant.removeFile(tenantId, fileId);
      message.success('Document removed');
      load();
    } catch (e) {
      message.error(e.response?.data?.message || 'Could not remove document');
    }
  };

  const isImage = (f) => IMAGE_EXTENSIONS.includes(String(f.extension || '').toLowerCase());

  const columns = [
    {
      title: 'Document',
      dataIndex: 'filename',
      key: 'filename',
      render: (name, f) => (
        <Space>
          <FileOutlined style={{ color: '#8c8c8c' }} />
          <span>{name || f.item_name}</span>
          {isImage(f) && <Tag color="blue">image</Tag>}
        </Space>
      ),
    },
    {
      title: 'Added',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 170,
      render: (d) => (d ? dayjs(d).format('D MMM YYYY, HH:mm') : '—'),
    },
    {
      title: 'Size',
      dataIndex: 'file_size',
      key: 'file_size',
      width: 90,
      render: readableSize,
    },
    {
      title: '',
      key: 'actions',
      width: 190,
      render: (_, f) => (
        <Space size="small">
          {isImage(f) && (
            <Button size="small" icon={<EyeOutlined />} onClick={() => setPreview(f)}>View</Button>
          )}
          <Button
            size="small"
            icon={<DownloadOutlined />}
            href={`/api/file/download/${f.id}`}
          >
            Download
          </Button>
          {canDelete && (
            <Popconfirm
              title="Remove this document?"
              description="It stays in the system but is no longer attached to this tenant."
              onConfirm={() => remove(f.id)}
              okText="Remove"
              okButtonProps={{ danger: true }}
            >
              <Button size="small" danger icon={<DeleteOutlined />} />
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  if (loading) return <div style={{ padding: 32, textAlign: 'center' }}><Spin /></div>;

  if (!files.length) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          <span>
            No documents yet.<br />
            <Text type="secondary" style={{ fontSize: 12 }}>
              ID screenshots pasted into Smart Extract when adding or editing this
              tenant are kept here automatically.
            </Text>
          </span>
        }
      />
    );
  }

  return (
    <>
      <Table
        rowKey="id"
        size="small"
        columns={columns}
        dataSource={files}
        pagination={files.length > 10 ? { pageSize: 10 } : false}
      />
      <Modal
        open={!!preview}
        onCancel={() => setPreview(null)}
        footer={null}
        width={820}
        title={preview?.filename || 'Document'}
      >
        {preview && (
          <Image
            src={`/api/file/preview/${preview.id}`}
            alt={preview.filename || 'document'}
            style={{ width: '100%' }}
            preview={false}
          />
        )}
      </Modal>
    </>
  );
}
