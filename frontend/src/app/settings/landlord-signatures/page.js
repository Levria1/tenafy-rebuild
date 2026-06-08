'use client';

/**
 * Landlord signatures management — Settings page.
 *
 * Lets staff upload or draw landlord signatures. Multiple signatures per org
 * (one per entity / signing officer); one can be marked default. The default
 * is used to auto-stamp leases at signing time unless a specific signature
 * is picked on the /review-and-send page.
 *
 * Two input methods:
 *   - Upload PNG/JPG (e.g. a scanned signature)
 *   - Draw directly with signature_pad
 */

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Card, Table, Button, Modal, Input, Space, message, Tag, Popconfirm, Upload, Tabs,
} from 'antd';
import {
  PlusOutlined, DeleteOutlined, StarOutlined, StarFilled,
  EditOutlined, ClearOutlined, UploadOutlined,
} from '@ant-design/icons';
import MainLayout from '../../../components/Layout';
import { signature } from '../../../lib/api';

export default function LandlordSignaturesPage() {
  const router = useRouter();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [label, setLabel] = useState('');
  const [activeTab, setActiveTab] = useState('draw');
  const [uploadedPng, setUploadedPng] = useState(null);
  const canvasRef = useRef(null);
  const sigPadRef = useRef(null);

  const load = async () => {
    setLoading(true);
    try {
      const r = await signature.listLandlordSigs();
      if (r.data?.code === 200) setRows(r.data.data || []);
    } catch (e) {
      message.error('Failed to load signatures');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  // Init signature pad when the Draw tab is visible and modal is open
  useEffect(() => {
    if (!modalOpen || activeTab !== 'draw') return;
    let cancelled = false;
    import('signature_pad').then(({ default: SignaturePad }) => {
      if (cancelled || !canvasRef.current) return;
      const resize = () => {
        if (!canvasRef.current) return;
        const ratio = Math.max(window.devicePixelRatio || 1, 1);
        canvasRef.current.width = canvasRef.current.offsetWidth * ratio;
        canvasRef.current.height = canvasRef.current.offsetHeight * ratio;
        canvasRef.current.getContext('2d').scale(ratio, ratio);
        sigPadRef.current?.clear();
      };
      sigPadRef.current = new SignaturePad(canvasRef.current, {
        penColor: '#000',
        backgroundColor: 'rgba(255,255,255,0)',
        minWidth: 1,
        maxWidth: 2.5,
      });
      setTimeout(resize, 50); // wait one tick for the modal animation
      window.addEventListener('resize', resize);
      return () => window.removeEventListener('resize', resize);
    });
    return () => { cancelled = true; };
  }, [modalOpen, activeTab]);

  const openCreate = () => {
    setEditing(null);
    setLabel('');
    setUploadedPng(null);
    setActiveTab('draw');
    setModalOpen(true);
  };
  const openEditLabel = (row) => {
    setEditing(row);
    setLabel(row.label);
    setUploadedPng(null);
    setActiveTab('label');
    setModalOpen(true);
  };

  const onSave = async () => {
    if (!label.trim()) return message.warning('Enter a label first.');
    let signature_png = null;
    if (activeTab === 'draw') {
      if (!sigPadRef.current || sigPadRef.current.isEmpty()) {
        return message.warning('Draw a signature first.');
      }
      signature_png = sigPadRef.current.toDataURL('image/png');
    } else if (activeTab === 'upload') {
      if (!uploadedPng) return message.warning('Upload an image first.');
      signature_png = uploadedPng;
    }
    try {
      if (editing) {
        const payload = { label: label.trim() };
        if (signature_png) payload.signature_png = signature_png;
        await signature.updateLandlordSig(editing.id, payload);
      } else {
        await signature.createLandlordSig({ label: label.trim(), signature_png });
      }
      message.success(editing ? 'Signature updated' : 'Signature saved');
      setModalOpen(false);
      load();
    } catch (e) {
      message.error('Save failed');
    }
  };

  const onSetDefault = async (row) => {
    try {
      await signature.updateLandlordSig(row.id, { is_default: 1 });
      message.success('Default signature updated');
      load();
    } catch (e) {
      message.error('Failed');
    }
  };

  const onDelete = async (row) => {
    try {
      await signature.deleteLandlordSig(row.id);
      message.success('Signature deleted');
      load();
    } catch (e) {
      message.error('Failed to delete');
    }
  };

  const columns = [
    {
      title: 'Signature', dataIndex: 'signature_png', width: 220,
      render: (v) => v ? (
        <img src={v} alt="signature" style={{ height: 60, maxWidth: 200, background: '#fafafa', border: '1px solid #f0f0f0', borderRadius: 4 }} />
      ) : <span style={{ color: '#bbb' }}>—</span>,
    },
    {
      title: 'Label', dataIndex: 'label',
      render: (v, row) => (
        <Space>
          <span>{v}</span>
          {row.is_default ? <Tag color="gold" icon={<StarFilled />}>Default</Tag> : null}
        </Space>
      ),
    },
    {
      title: 'Actions', width: 250, fixed: 'right',
      render: (_, row) => (
        <Space size="small">
          {!row.is_default && (
            <Button size="small" icon={<StarOutlined />} onClick={() => onSetDefault(row)}>Set default</Button>
          )}
          <Button size="small" icon={<EditOutlined />} onClick={() => openEditLabel(row)}>Edit</Button>
          <Popconfirm
            title="Delete this signature?"
            description="Leases already signed are unaffected."
            okText="Delete"
            okType="danger"
            onConfirm={() => onDelete(row)}
          >
            <Button size="small" danger icon={<DeleteOutlined />} disabled={!!row.is_default} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const handleUpload = (file) => {
    const reader = new FileReader();
    reader.onload = () => setUploadedPng(reader.result);
    reader.readAsDataURL(file);
    return false;
  };

  return (
    <MainLayout>
      <div style={{ padding: '0 0 24px 0' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0, color: '#333' }}>Landlord Signatures</h2>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            Add Signature
          </Button>
        </div>
        <Card bodyStyle={{ padding: 0 }}>
          <Table
            rowKey="id"
            loading={loading}
            dataSource={rows}
            columns={columns}
            pagination={false}
            locale={{ emptyText: 'No landlord signatures yet — click "Add Signature".' }}
          />
        </Card>
        <div style={{ marginTop: 12, fontSize: 12, color: '#888' }}>
          The default signature is auto-stamped onto every fully-signed lease. Override per-lease on the Send for E-Signature page if needed.
        </div>
      </div>

      <Modal
        title={editing ? 'Edit Signature' : 'Add Landlord Signature'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={onSave}
        okText="Save"
        width={640}
      >
        <Input
          placeholder="Label (e.g. HK Corp Ltd, Alex Wong)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          style={{ marginBottom: 12 }}
        />
        {!editing && (
          <Tabs activeKey={activeTab} onChange={setActiveTab}
            items={[
              {
                key: 'draw', label: 'Draw',
                children: (
                  <div>
                    <div style={{ border: '1px dashed #999', borderRadius: 6, background: '#fff', height: 180, marginBottom: 8 }}>
                      <canvas
                        ref={canvasRef}
                        style={{ width: '100%', height: '100%', cursor: 'crosshair', display: 'block' }}
                      />
                    </div>
                    <Button size="small" icon={<ClearOutlined />} onClick={() => sigPadRef.current?.clear()}>
                      Clear
                    </Button>
                  </div>
                ),
              },
              {
                key: 'upload', label: 'Upload PNG/JPG',
                children: (
                  <div>
                    <Upload
                      accept="image/png,image/jpeg"
                      beforeUpload={handleUpload}
                      showUploadList={false}
                    >
                      <Button icon={<UploadOutlined />}>Pick an image</Button>
                    </Upload>
                    {uploadedPng && (
                      <div style={{ marginTop: 12, padding: 12, border: '1px solid #f0f0f0', borderRadius: 4 }}>
                        <img src={uploadedPng} alt="preview" style={{ maxHeight: 100 }} />
                      </div>
                    )}
                    <div style={{ marginTop: 8, fontSize: 12, color: '#888' }}>
                      Tip: a PNG with transparent background looks cleanest when stamped onto the lease PDF.
                    </div>
                  </div>
                ),
              },
            ]}
          />
        )}
      </Modal>
    </MainLayout>
  );
}
