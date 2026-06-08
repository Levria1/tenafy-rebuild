'use client';

/**
 * Lease review + send-for-signature page.
 *
 * Flow:
 *   1. Loads the lease + existing tenant data + lease templates + landlord
 *      signatures (and the property's default).
 *   2. Renders a live PDF preview using the chosen template + real lease data.
 *      Preview refreshes when staff change the template or click "Refresh".
 *   3. Staff confirm the signer list (pre-filled from the lease tenant), pick
 *      the landlord signature, optionally add a message, and click Send.
 *   4. Backend creates the signature_request + emails each signer the link.
 *   5. Redirect back to lease detail with a success message.
 *
 * Skip path: "Skip — just go to lease" navigates to /leasing/[id]/detail
 * without creating a request. The lease still exists; staff can come back
 * here later via the lease detail page's "Generate Lease for E-Signature"
 * button.
 */

import { useEffect, useState, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  Card, Button, Select, Input, Space, message, Spin, Empty,
  Form, Row, Col, Tag, Tooltip, InputNumber,
} from 'antd';
import {
  ArrowLeftOutlined, SendOutlined, EyeOutlined, PlusOutlined, DeleteOutlined,
} from '@ant-design/icons';
import MainLayout from '../../../../components/Layout';
import { leasing, leaseTemplate, signature } from '../../../../lib/api';

export default function ReviewAndSendPage() {
  const params = useParams();
  const router = useRouter();
  const leaseId = params?.id;
  const [form] = Form.useForm();

  const [lease, setLease] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [landlordSigs, setLandlordSigs] = useState([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState(null);
  const [selectedLandlordSigId, setSelectedLandlordSigId] = useState(null);
  const [parties, setParties] = useState([]);              // [{ signer_name, signer_email, role }]
  const [loading, setLoading] = useState(true);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [sending, setSending] = useState(false);
  const previewUrlRef = useRef(null);

  // Initial load
  useEffect(() => {
    if (!leaseId) return;
    (async () => {
      try {
        const [lr, tr, sr] = await Promise.all([
          leasing.get(leaseId),
          leaseTemplate.list(),
          signature.listLandlordSigs(),
        ]);
        const l = lr.data?.data || {};
        setLease(l);
        const tpls = tr.data?.data || [];
        setTemplates(tpls);
        // Pick the default template
        const defaultTpl = tpls.find(t => t.is_default) || tpls[0];
        if (defaultTpl) setSelectedTemplateId(String(defaultTpl.id));
        const sigs = sr.data?.data || [];
        setLandlordSigs(sigs);
        const defaultSig = sigs.find(s => s.is_default) || sigs[0];
        if (defaultSig) setSelectedLandlordSigId(String(defaultSig.id));

        // Pre-fill primary signer from lease tenant
        const tenantName = [l.tenant_first_name, l.tenant_last_name].filter(Boolean).join(' ');
        setParties([{
          signer_name: tenantName || '',
          signer_email: l.tenant_email || '',
          role: 'tenant',
        }]);
      } catch (e) {
        message.error('Failed to load lease data');
      } finally {
        setLoading(false);
      }
    })();
  }, [leaseId]);

  // Trigger preview when template changes
  useEffect(() => {
    if (selectedTemplateId && leaseId) refreshPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTemplateId]);

  const refreshPreview = async () => {
    if (!selectedTemplateId) return;
    setPreviewLoading(true);
    try {
      // Render real lease + template via the renderer's preview endpoint. We
      // don't have a dedicated "real lease render" endpoint yet — but we DO
      // get a render-on-create as a side effect of POST /api/signature/request.
      // For preview-before-send, use the template's sample-data preview as a
      // close approximation. (TODO: dedicated render-lease-with-template endpoint.)
      const r = await leaseTemplate.previewSaved(selectedTemplateId);
      const url = URL.createObjectURL(new Blob([r.data], { type: 'application/pdf' }));
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = url;
      setPreviewUrl(url);
    } catch (e) {
      message.error('Failed to render preview');
    } finally {
      setPreviewLoading(false);
    }
  };

  const updateParty = (idx, field, value) => {
    setParties(prev => prev.map((p, i) => i === idx ? { ...p, [field]: value } : p));
  };

  const addParty = () => {
    setParties(prev => [...prev, { signer_name: '', signer_email: '', role: 'tenant' }]);
  };

  const removeParty = (idx) => {
    setParties(prev => prev.filter((_, i) => i !== idx));
  };

  const onSend = async () => {
    if (!selectedTemplateId) return message.warning('Pick a template first.');
    const cleanParties = parties
      .map(p => ({ ...p, signer_name: (p.signer_name || '').trim(), signer_email: (p.signer_email || '').trim() }))
      .filter(p => p.signer_name && p.signer_email);
    if (!cleanParties.length) return message.warning('Add at least one signer with name and email.');

    setSending(true);
    try {
      const msg = form.getFieldValue('message');
      const exp = form.getFieldValue('expires_in_days') || 14;
      const r = await signature.createRequest({
        lease_id: leaseId,
        template_id: selectedTemplateId,
        landlord_signature_id: selectedLandlordSigId || null,
        parties: cleanParties,
        message: msg || null,
        expires_in_days: exp,
      });
      if (r.data?.code === 200) {
        message.success(`Signature request sent to ${cleanParties.length} signer${cleanParties.length === 1 ? '' : 's'}.`);
        router.push(`/leasing/${leaseId}/detail`);
      } else {
        message.error(r.data?.message || 'Failed to send');
      }
    } catch (e) {
      message.error(e.response?.data?.message || 'Failed to send');
    } finally {
      setSending(false);
    }
  };

  if (loading) return (
    <MainLayout>
      <div style={{ textAlign: 'center', padding: 60 }}><Spin size="large" /></div>
    </MainLayout>
  );

  return (
    <MainLayout>
      <div style={{ padding: '0 0 24px 0' }}>
        <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
          <Button icon={<ArrowLeftOutlined />} onClick={() => router.push(`/leasing/${leaseId}/detail`)}>
            Skip — go to lease
          </Button>
          <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0, color: '#333' }}>
            Send Lease for E-Signature
          </h2>
        </div>

        <Row gutter={16}>
          <Col xs={24} lg={11}>
            <Card title="Template" size="small" style={{ marginBottom: 12 }}>
              {templates.length === 0 ? (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={
                    <span>
                      No templates yet. <a onClick={() => router.push('/settings/lease-templates/create')}>Create one</a> first.
                    </span>
                  }
                />
              ) : (
                <Space style={{ width: '100%' }} direction="vertical">
                  <Select
                    style={{ width: '100%' }}
                    value={selectedTemplateId}
                    onChange={(v) => setSelectedTemplateId(v)}
                    options={templates.map(t => ({
                      value: String(t.id),
                      label: <span>{t.name} {t.is_default && <Tag color="gold">Default</Tag>}</span>,
                    }))}
                  />
                  <Button size="small" icon={<EyeOutlined />} onClick={refreshPreview} loading={previewLoading}>
                    Refresh Preview
                  </Button>
                </Space>
              )}
            </Card>

            <Card title="Signers" size="small" style={{ marginBottom: 12 }}>
              {parties.map((p, i) => (
                <Row key={i} gutter={8} style={{ marginBottom: 8 }}>
                  <Col span={10}>
                    <Input
                      placeholder="Full name"
                      value={p.signer_name}
                      onChange={e => updateParty(i, 'signer_name', e.target.value)}
                    />
                  </Col>
                  <Col span={11}>
                    <Input
                      placeholder="email@example.com"
                      value={p.signer_email}
                      onChange={e => updateParty(i, 'signer_email', e.target.value)}
                    />
                  </Col>
                  <Col span={3}>
                    {parties.length > 1 && (
                      <Tooltip title="Remove signer">
                        <Button danger icon={<DeleteOutlined />} onClick={() => removeParty(i)} />
                      </Tooltip>
                    )}
                  </Col>
                </Row>
              ))}
              <Button size="small" icon={<PlusOutlined />} onClick={addParty}>
                Add another signer
              </Button>
              <div style={{ fontSize: 11, color: '#888', marginTop: 8 }}>
                All signers get an email simultaneously. The lease is auto-stamped with the landlord signature once everyone signs.
              </div>
            </Card>

            <Card title="Landlord Signature (auto-stamp)" size="small" style={{ marginBottom: 12 }}>
              {landlordSigs.length === 0 ? (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={
                    <span>
                      No landlord signatures saved. <a onClick={() => router.push('/settings/landlord-signatures')}>Upload one</a> in Settings.
                    </span>
                  }
                />
              ) : (
                <Select
                  style={{ width: '100%' }}
                  value={selectedLandlordSigId}
                  onChange={(v) => setSelectedLandlordSigId(v)}
                  options={landlordSigs.map(s => ({
                    value: String(s.id),
                    label: <span>{s.label} {s.is_default && <Tag color="gold">Default</Tag>}</span>,
                  }))}
                />
              )}
            </Card>

            <Card size="small" style={{ marginBottom: 12 }}>
              <Form form={form} layout="vertical" initialValues={{ expires_in_days: 14 }}>
                <Form.Item name="message" label="Optional message to signers">
                  <Input.TextArea rows={3} placeholder="A short note that appears in the email." />
                </Form.Item>
                <Form.Item name="expires_in_days" label="Link expires in (days)">
                  <InputNumber min={1} max={90} style={{ width: 120 }} />
                </Form.Item>
              </Form>
            </Card>

            <Space size="middle">
              <Button
                type="primary"
                size="large"
                icon={<SendOutlined />}
                onClick={onSend}
                loading={sending}
                disabled={!templates.length}
              >
                Send for E-Signature
              </Button>
              <Button size="large" onClick={() => router.push(`/leasing/${leaseId}/detail`)}>
                Skip — go to lease
              </Button>
            </Space>
          </Col>

          <Col xs={24} lg={13}>
            <Card
              title="PDF Preview"
              size="small"
              extra={previewUrl && <a href={previewUrl} target="_blank" rel="noreferrer">Open in new tab</a>}
              bodyStyle={{ padding: 0, height: 'calc(100vh - 160px)', minHeight: 600 }}
            >
              {previewLoading ? (
                <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Spin />
                </div>
              ) : previewUrl ? (
                <iframe src={previewUrl} title="Lease preview" style={{ width: '100%', height: '100%', border: 0 }} />
              ) : (
                <Empty description="No preview yet" image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ marginTop: 80 }} />
              )}
            </Card>
            <div style={{ fontSize: 11, color: '#888', marginTop: 8 }}>
              Note: the preview currently shows sample data. The actual lease data will be filled in when the signer opens their link.
            </div>
          </Col>
        </Row>
      </div>
    </MainLayout>
  );
}
