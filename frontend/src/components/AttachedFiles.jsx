'use client';

/**
 * Files attached to an invoice (or a payment), and the upload box that adds them.
 *
 * The invoice forms used to have an upload box with beforeUpload={() => false}:
 * it accepted a file and then discarded it, and the invoice drawer printed a
 * hard-coded "—". Uploads now go to /api/file/upload straight away, the ids
 * returned are sent with the save as file_ids, and the server links them through
 * object_file and marks them private (the same path as payment receipts).
 */

import { Button, Space, Popconfirm, Upload, message } from 'antd';
import { PaperClipOutlined, UploadOutlined } from '@ant-design/icons';
import { file as fileApi } from '../lib/api';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export function formatFileSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Read-only list with View / Download, plus Remove when onDetach is given. */
export function AttachedFileList({ files, onDetach, emptyText = '—' }) {
  if (!files || files.length === 0) return <div style={{ color: '#999' }}>{emptyText}</div>;
  return (
    <Space direction="vertical" size={6} style={{ width: '100%' }}>
      {files.map(f => (
        <div
          key={f.id}
          style={{ display: 'flex', alignItems: 'center', gap: 10, border: '1px solid #f0f0f0', borderRadius: 6, padding: 6 }}
        >
          {f.is_image ? (
            // Attachments are private: this loads only for a signed-in user of the owning org.
            <a href={`${API_BASE}${f.preview_url}`} target="_blank" rel="noreferrer">
              <img
                src={`${API_BASE}${f.preview_url}`}
                alt={f.filename}
                style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 4, display: 'block' }}
              />
            </a>
          ) : (
            <PaperClipOutlined style={{ fontSize: 20, color: '#8c8c8c' }} />
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, wordBreak: 'break-all' }}>{f.filename}</div>
            <div style={{ fontSize: 11, color: '#999' }}>{formatFileSize(f.file_size)}</div>
          </div>
          <Space size={0}>
            <Button size="small" type="link" href={`${API_BASE}${f.preview_url}`} target="_blank" rel="noreferrer">View</Button>
            <Button size="small" type="link" href={`${API_BASE}${f.download_url}`}>Download</Button>
            {onDetach && (
              <Popconfirm
                title="Remove this file from the invoice?"
                description="The file itself is kept and can be attached again."
                onConfirm={() => onDetach(f.id)}
                okText="Remove"
                cancelText="Cancel"
              >
                <Button size="small" type="link" danger>Remove</Button>
              </Popconfirm>
            )}
          </Space>
        </div>
      ))}
    </Space>
  );
}

/**
 * Upload box. `value` is [{ id, name }] for files uploaded but not yet saved;
 * the caller sends value.map(f => f.id) as file_ids when the form is saved.
 */
export function FileUploadBox({ value, onChange, hint = 'Added to this invoice when you save.' }) {
  const uploads = value || [];
  return (
    <Upload.Dragger
      name="file"
      multiple
      fileList={uploads.map(u => ({ uid: u.id, name: u.name, status: 'done' }))}
      customRequest={async ({ file, onSuccess, onError }) => {
        try {
          const fd = new FormData();
          fd.append('file', file);
          const r = await fileApi.upload(fd);
          const id = r?.data?.data?.id;
          if (!id) throw new Error('Upload did not return a file id');
          onChange(prev => [...prev, { id: String(id), name: file.name }]);
          onSuccess(r.data, file);
        } catch (err) {
          message.error(`Could not upload ${file.name}`);
          onError(err);
        }
      }}
      onRemove={(f) => { onChange(prev => prev.filter(u => u.id !== f.uid)); return true; }}
      style={{ padding: '20px 0' }}
    >
      <p className="ant-upload-drag-icon"><UploadOutlined style={{ fontSize: 32, color: '#1890ff' }} /></p>
      <p className="ant-upload-text">Upload</p>
      <p className="ant-upload-hint">{hint}</p>
    </Upload.Dragger>
  );
}
