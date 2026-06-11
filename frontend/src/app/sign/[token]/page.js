'use client';

/**
 * Public signer page — opened by the tenant via emailed link
 *   https://platform.tenafy.com/sign/<party_token>
 *
 * No login required. Loads the signing context via /api/signature/public/:token,
 * shows the lease PDF inline, captures a drawn signature + typed name, submits.
 * Standalone page — no MainLayout (no sidebar/auth chrome).
 */

import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import {
  Card, Button, Input, Checkbox, Spin, Result, Space, message, Modal, Typography, Tabs, Upload,
} from 'antd';
import {
  ClearOutlined, EditOutlined, CloseCircleOutlined, HighlightOutlined,
  FontSizeOutlined, UploadOutlined, PictureOutlined, DownloadOutlined,
} from '@ant-design/icons';
import { signature } from '../../../lib/api';

const { Title, Text } = Typography;

// Cursive web fonts the signer can pick from. Loaded via the Google Fonts
// link injected when the page mounts (see useEffect below). When the signer
// uses Type mode, the picked font is rendered onto an off-screen canvas to
// produce the same PNG format the Draw mode produces.
const CURSIVE_FONTS = [
  { key: 'Great Vibes', label: 'Elegant', css: "'Great Vibes', cursive" },
  { key: 'Dancing Script', label: 'Casual', css: "'Dancing Script', cursive" },
  { key: 'Allura', label: 'Refined', css: "'Allura', cursive" },
];

export default function SignPage() {
  const params = useParams();
  const token = params?.token;
  const [ctx, setCtx] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [typedName, setTypedName] = useState('');
  const [initials, setInitials] = useState('');           // per-page initials text
  const [initialsEdited, setInitialsEdited] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [signed, setSigned] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [declineOpen, setDeclineOpen] = useState(false);
  const [declineReason, setDeclineReason] = useState('');
  const [sigMode, setSigMode] = useState('draw');                    // 'draw' | 'type' | 'upload'
  const [typedFont, setTypedFont] = useState(CURSIVE_FONTS[0].key);  // selected cursive font
  const [uploadedPng, setUploadedPng] = useState(null);              // data URL of uploaded image
  const canvasRef = useRef(null);
  const sigPadRef = useRef(null);

  // Convert an uploaded file → data URL. Returns false from beforeUpload so
  // Ant Design's <Upload> doesn't actually upload anywhere — we just want the
  // bytes in state to ship along with the sign submission.
  const handleUpload = (file) => {
    // Sanity: PNG/JPG only, max 2 MB. Bigger images make the PDF huge and
    // the LONGTEXT row slow to load.
    const okType = file.type === 'image/png' || file.type === 'image/jpeg';
    if (!okType) {
      message.error('Please upload a PNG or JPG image.');
      return false;
    }
    if (file.size > 2 * 1024 * 1024) {
      message.error('Image is too large (max 2 MB).');
      return false;
    }
    const reader = new FileReader();
    reader.onload = () => setUploadedPng(reader.result);
    reader.readAsDataURL(file);
    return false;
  };

  // Inject the Google Fonts stylesheet once. Done client-side so the public
  // signer page doesn't need a global font setup. document.fonts.ready is
  // awaited at submit time to make sure the typed-mode canvas renders the
  // right glyphs (not a fallback sans-serif).
  useEffect(() => {
    const id = 'tenafy-sig-fonts';
    if (document.getElementById(id)) return;
    const link = document.createElement('link');
    link.id = id;
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Great+Vibes&family=Dancing+Script:wght@400;700&family=Allura&display=swap';
    document.head.appendChild(link);
  }, []);

  // Load signing context
  useEffect(() => {
    if (!token) return;
    setLoading(true);
    signature.getPublic(token)
      .then(r => {
        if (r.data?.code === 200) {
          setCtx(r.data.data);
          if (r.data.data?.party?.signer_name) setTypedName(r.data.data.party.signer_name);
          if (r.data.data?.completed) setCompleted(true);
          else if (r.data.data?.already_signed) setSigned(true);
        } else {
          setError(r.data?.message || 'Invalid link');
        }
      })
      .catch(e => setError(e.response?.data?.message || 'Failed to load signing page'))
      .finally(() => setLoading(false));
  }, [token]);

  // Initialize the signature pad after the canvas mounts (and when we have ctx)
  useEffect(() => {
    if (!ctx || signed || error) return;
    let cancelled = false;
    import('signature_pad').then(({ default: SignaturePad }) => {
      if (cancelled || !canvasRef.current) return;
      // Resize canvas to its container width
      const resize = () => {
        if (!canvasRef.current) return;
        const ratio = Math.max(window.devicePixelRatio || 1, 1);
        canvasRef.current.width = canvasRef.current.offsetWidth * ratio;
        canvasRef.current.height = canvasRef.current.offsetHeight * ratio;
        canvasRef.current.getContext('2d').scale(ratio, ratio);
        if (sigPadRef.current) sigPadRef.current.clear();
      };
      sigPadRef.current = new SignaturePad(canvasRef.current, {
        penColor: '#222',
        backgroundColor: 'rgba(255,255,255,0)',
        minWidth: 1,
        maxWidth: 2.5,
      });
      resize();
      window.addEventListener('resize', resize);
      return () => window.removeEventListener('resize', resize);
    });
    return () => { cancelled = true; };
  }, [ctx, signed, error]);

  const clearSig = () => sigPadRef.current?.clear();

  // Render typed name in the chosen cursive font onto an off-screen canvas
  // and return a PNG data URL — matches the Draw mode output format so the
  // backend and pdf-lib stamper don't need a separate code path.
  const renderTypedSignaturePng = async () => {
    // Wait for the Google Font to actually load — otherwise the canvas
    // draws with a sans-serif fallback and the signer's "cursive" signature
    // looks like plain Arial.
    if (document.fonts && document.fonts.load) {
      try { await document.fonts.load(`64px '${typedFont}'`); } catch {}
    }
    if (document.fonts && document.fonts.ready) {
      try { await document.fonts.ready; } catch {}
    }
    const text = typedName.trim() || ctx?.party?.signer_name || '';
    const canvas = document.createElement('canvas');
    canvas.width = 700;
    canvas.height = 160;
    const g = canvas.getContext('2d');
    // Transparent background — strokes will land naturally on the lease PDF.
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = '#222';
    g.font = `72px '${typedFont}', cursive`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, canvas.width / 2, canvas.height / 2);
    return canvas.toDataURL('image/png');
  };

  // Initials default to the signer's name initials (first letter of each word).
  const deriveInitials = (name) =>
    (name || '').trim().split(/\s+/).filter(Boolean).map(w => w[0].toUpperCase()).join('').slice(0, 4);
  const effectiveInitials = initialsEdited ? initials : deriveInitials(typedName || ctx?.party?.signer_name);

  // Render the initials text in the chosen cursive font → small PNG, same
  // format as the signature. Used for the per-page initials stamp.
  const renderInitialsPng = async (text) => {
    if (!text) return null;
    if (document.fonts && document.fonts.load) {
      try { await document.fonts.load(`64px '${typedFont}'`); } catch {}
    }
    if (document.fonts && document.fonts.ready) {
      try { await document.fonts.ready; } catch {}
    }
    const canvas = document.createElement('canvas');
    canvas.width = 260;
    canvas.height = 120;
    const g = canvas.getContext('2d');
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = '#222';
    g.font = `64px '${typedFont}', cursive`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, canvas.width / 2, canvas.height / 2);
    return canvas.toDataURL('image/png');
  };

  const onSign = async () => {
    if (!typedName.trim()) return message.warning('Please type your full name.');
    if (!agreed) return message.warning('Please tick the confirmation checkbox.');

    let signature_png;
    if (sigMode === 'draw') {
      if (!sigPadRef.current || sigPadRef.current.isEmpty()) {
        return message.warning('Please draw your signature in the box above.');
      }
      signature_png = sigPadRef.current.toDataURL('image/png');
    } else if (sigMode === 'type') {
      signature_png = await renderTypedSignaturePng();
    } else {
      // Upload mode
      if (!uploadedPng) return message.warning('Please upload a signature image.');
      signature_png = uploadedPng;
    }

    // Render per-page initials (cursive PNG). Non-fatal if it fails — the
    // backend treats initials_png as optional.
    let initials_png = null;
    try {
      initials_png = await renderInitialsPng(effectiveInitials);
    } catch { /* ignore — initials are optional */ }

    setSubmitting(true);
    try {
      const r = await signature.sign(token, {
        signature_png,
        typed_name: typedName.trim(),
        initials_png,
      });
      if (r.data?.code === 200) {
        setSigned(true);
      } else {
        message.error(r.data?.message || 'Failed to sign');
      }
    } catch (e) {
      message.error(e.response?.data?.message || 'Failed to sign');
    } finally {
      setSubmitting(false);
    }
  };

  const onDecline = async () => {
    setSubmitting(true);
    try {
      const r = await signature.decline(token, { reason: declineReason.trim() || null });
      if (r.data?.code === 200) {
        setDeclineOpen(false);
        setError('You have declined to sign this lease. The sender has been notified.');
      } else {
        message.error(r.data?.message || 'Failed to decline');
      }
    } catch (e) {
      message.error(e.response?.data?.message || 'Failed to decline');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: '#f0f2f5' }}>
        <Spin size="large" />
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ minHeight: '100vh', background: '#f0f2f5', padding: 24 }}>
        <div style={{ maxWidth: 600, margin: '60px auto' }}>
          <Result status="warning" title="Cannot open this signing link" subTitle={error} />
        </div>
      </div>
    );
  }

  // Fully completed (all parties signed) — offer a download of the signed copy
  // instead of a dead-end. Works even after the original signing window lapsed.
  if (completed) {
    const dl = ctx?.lease;
    return (
      <div style={{ minHeight: '100vh', background: '#f0f2f5', padding: 24 }}>
        <div style={{ maxWidth: 600, margin: '60px auto' }}>
          <Result
            status="success"
            title="This lease is fully signed"
            subTitle={dl ? `${dl.property_name || ''}${dl.unit_name ? ` — ${dl.unit_name}` : ''}${dl.lease_no ? ` (Lease ${dl.lease_no})` : ''}` : 'All parties have signed.'}
            extra={
              ctx?.signed_available ? (
                <Button
                  type="primary"
                  size="large"
                  icon={<DownloadOutlined />}
                  href={`/api/signature/public/${token}/pdf`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Download signed lease
                </Button>
              ) : (
                <Typography.Text type="secondary">Your signed copy was emailed to you.</Typography.Text>
              )
            }
          />
        </div>
      </div>
    );
  }

  if (signed) {
    return (
      <div style={{ minHeight: '100vh', background: '#f0f2f5', padding: 24 }}>
        <div style={{ maxWidth: 600, margin: '60px auto' }}>
          <Result
            status="success"
            title="Lease signed successfully"
            subTitle="Thank you. Once all parties sign, the fully-signed PDF will be emailed to you."
          />
        </div>
      </div>
    );
  }

  const lease = ctx?.lease;
  return (
    <div style={{ minHeight: '100vh', background: '#f0f2f5', padding: '24px 16px' }}>
      <div style={{ maxWidth: 900, margin: '0 auto' }}>
        <Card style={{ marginBottom: 16 }}>
          <Title level={4} style={{ marginTop: 0 }}>Lease Agreement — Please Review &amp; Sign</Title>
          {lease && (
            <Space direction="vertical" size={4}>
              <Text><strong>Property:</strong> {lease.property_name || '—'}{lease.unit_name ? ` · ${lease.unit_name}` : ''}</Text>
              {lease.lease_no && <Text><strong>Lease #:</strong> {lease.lease_no}</Text>}
              {lease.start_date && <Text><strong>Term:</strong> {String(lease.start_date).slice(0,10)} to {lease.end_date ? String(lease.end_date).slice(0,10) : 'open-ended'}</Text>}
              {lease.amount != null && <Text><strong>Monthly Rent:</strong> HK${Number(lease.amount).toLocaleString()}</Text>}
              {lease.deposit != null && <Text><strong>Deposit:</strong> HK${Number(lease.deposit).toLocaleString()}</Text>}
            </Space>
          )}
        </Card>

        <Card title="Lease Document" style={{ marginBottom: 16 }} bodyStyle={{ padding: 0 }}>
          <iframe
            src={signature.publicPdfUrl(token)}
            style={{ width: '100%', height: '70vh', border: 0 }}
            title="Lease PDF"
          />
        </Card>

        <Card title="Sign Below">
          {/* Typed name is always required — used as the legal name on the
              certificate of completion AND used to pre-fill the Type mode
              preview. */}
          <Input
            value={typedName}
            onChange={e => setTypedName(e.target.value)}
            placeholder="Type your full legal name"
            prefix={<EditOutlined />}
            size="large"
            style={{ marginBottom: 16 }}
          />

          {/* Initials — stamped on every page. Auto-filled from the name; the
              signer can adjust. Kept compact so it doesn't dominate the form. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
            <span style={{ fontSize: 13, color: '#666', whiteSpace: 'nowrap' }}>Your initials:</span>
            <Input
              value={effectiveInitials}
              onChange={e => { setInitialsEdited(true); setInitials(e.target.value.toUpperCase().slice(0, 4)); }}
              maxLength={4}
              style={{ width: 90, textTransform: 'uppercase', fontWeight: 600, letterSpacing: 1 }}
            />
            <span style={{ fontSize: 12, color: '#999' }}>(initialled on every page)</span>
          </div>

          <Tabs
            activeKey={sigMode}
            onChange={setSigMode}
            items={[
              {
                key: 'draw',
                label: <span><HighlightOutlined /> Draw</span>,
                children: (
                  <div>
                    <div style={{ marginBottom: 8 }}>
                      <Text type="secondary">Draw your signature inside the box:</Text>
                    </div>
                    <div style={{
                      border: '1px dashed #999', borderRadius: 6, background: '#fff',
                      height: 180, position: 'relative', marginBottom: 8,
                    }}>
                      <canvas
                        ref={canvasRef}
                        style={{ width: '100%', height: '100%', cursor: 'crosshair', display: 'block' }}
                      />
                    </div>
                    <Button size="small" icon={<ClearOutlined />} onClick={clearSig}>
                      Clear
                    </Button>
                  </div>
                ),
              },
              {
                key: 'type',
                label: <span><FontSizeOutlined /> Type</span>,
                children: (
                  <div>
                    <div style={{ marginBottom: 8 }}>
                      <Text type="secondary">Pick a cursive style for your typed name:</Text>
                    </div>
                    {!typedName.trim() && (
                      <div style={{ padding: 12, background: '#fffbe6', border: '1px solid #ffe58f', borderRadius: 4, marginBottom: 8, fontSize: 13, color: '#874d00' }}>
                        Type your full name above first, then pick a style below.
                      </div>
                    )}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 8 }}>
                      {CURSIVE_FONTS.map(f => (
                        <div
                          key={f.key}
                          onClick={() => setTypedFont(f.key)}
                          style={{
                            border: typedFont === f.key ? '2px solid #1677ff' : '1px solid #d9d9d9',
                            borderRadius: 6, padding: 12, background: '#fff', cursor: 'pointer',
                            textAlign: 'center', minHeight: 90,
                            display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
                          }}
                        >
                          <div style={{
                            fontFamily: f.css, fontSize: 36, lineHeight: 1.1, color: '#222',
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          }}>
                            {typedName.trim() || ctx?.party?.signer_name || 'Your Name'}
                          </div>
                          <div style={{ fontSize: 11, color: typedFont === f.key ? '#1677ff' : '#888', marginTop: 6 }}>
                            {f.label} {typedFont === f.key && '✓'}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ),
              },
              {
                key: 'upload',
                label: <span><PictureOutlined /> Upload</span>,
                children: (
                  <div>
                    <div style={{ marginBottom: 8 }}>
                      <Text type="secondary">Upload a photo or scan of your signature (PNG / JPG, max 2 MB):</Text>
                    </div>
                    <Upload
                      accept="image/png,image/jpeg"
                      beforeUpload={handleUpload}
                      showUploadList={false}
                    >
                      <Button icon={<UploadOutlined />}>Choose image</Button>
                    </Upload>
                    {uploadedPng ? (
                      <div style={{
                        marginTop: 12, padding: 12, border: '1px solid #f0f0f0', borderRadius: 6,
                        background: '#fafafa', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
                      }}>
                        <img src={uploadedPng} alt="signature preview" style={{ maxHeight: 100, maxWidth: '70%', background: '#fff', borderRadius: 4 }} />
                        <Button size="small" onClick={() => setUploadedPng(null)}>Remove</Button>
                      </div>
                    ) : (
                      <div style={{
                        marginTop: 12, padding: 24, border: '1px dashed #d9d9d9',
                        borderRadius: 6, background: '#fafafa', textAlign: 'center',
                        color: '#999', fontSize: 13,
                      }}>
                        No image selected
                      </div>
                    )}
                    <div style={{ marginTop: 8, fontSize: 11, color: '#888' }}>
                      Tip: a PNG with transparent background looks cleanest on the signed PDF.
                    </div>
                  </div>
                ),
              },
            ]}
            style={{ marginBottom: 16 }}
          />

          <Checkbox checked={agreed} onChange={e => setAgreed(e.target.checked)} style={{ marginBottom: 16 }}>
            I confirm that I am <strong>{typedName.trim() || ctx?.party?.signer_name}</strong> and I intend to sign this lease agreement electronically.
          </Checkbox>

          <Space size="middle" style={{ width: '100%', justifyContent: 'space-between' }}>
            <Button
              danger
              icon={<CloseCircleOutlined />}
              onClick={() => setDeclineOpen(true)}
              disabled={submitting}
            >
              Decline
            </Button>
            <Button
              type="primary"
              size="large"
              onClick={onSign}
              loading={submitting}
            >
              Sign and Submit
            </Button>
          </Space>
        </Card>

        <div style={{ textAlign: 'center', marginTop: 24, color: '#999', fontSize: 12 }}>
          Powered by Tenafy · Your signature, IP, and timestamp are recorded in the audit trail.
        </div>
      </div>

      <Modal
        title="Decline to sign?"
        open={declineOpen}
        onCancel={() => setDeclineOpen(false)}
        onOk={onDecline}
        okText="Decline"
        okType="danger"
        confirmLoading={submitting}
      >
        <p>The sender will be notified. You can include an optional reason.</p>
        <Input.TextArea
          rows={3}
          placeholder="Reason (optional)"
          value={declineReason}
          onChange={e => setDeclineReason(e.target.value)}
        />
      </Modal>
    </div>
  );
}
