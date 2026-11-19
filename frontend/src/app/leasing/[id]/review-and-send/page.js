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
  Form, Row, Col, Tag, Tooltip, InputNumber, DatePicker, Checkbox, Alert, Modal,
} from 'antd';
import {
  ArrowLeftOutlined, SendOutlined, EyeOutlined, PlusOutlined, DeleteOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import MainLayout from '../../../../components/Layout';
import { leasing, leaseTemplate, signature, pdf } from '../../../../lib/api';

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
  // The PERIOD this document covers. A tenancy extended by editing its end date
  // needs a document for the new period only, so this is not always the whole
  // lease. Prefilled from the server's uncovered stretch.
  const [termFrom, setTermFrom] = useState(null);
  const [paperworkReason, setPaperworkReason] = useState(null);
  const [periodIsGuess, setPeriodIsGuess] = useState(false);
  const [emptyFields, setEmptyFields] = useState([]);
  const [jointTemplateReady,setJointTemplateReady]=useState(false);
  const [documentSnapshot,setDocumentSnapshot]=useState(null);
  const [termTo, setTermTo] = useState(null);
  const [stampLonger, setStampLonger] = useState(false);
  const [termStampEnd, setTermStampEnd] = useState(null);

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
        const allTpls = tr.data?.data || [];
        // Restrict to the property's allowlist. If the property has an allowlist
        // (one or more entries), staff can ONLY pick those templates. An empty
        // allowlist means the property is unrestricted (show every template).
        const allowed = (l.allowed_template_ids || []).map(String);
        const tpls = allowed.length
          ? allTpls.filter(t => allowed.includes(String(t.id)))
          : allTpls;
        setTemplates(tpls);
        // Pre-select the org default if it's in the allowed set, else the first
        // allowed template. Staff can still change it within the allowed set.
        const defaultTpl = tpls.find(t => t.is_default) || tpls[0];
        if (defaultTpl) setSelectedTemplateId(String(defaultTpl.id));
        const sigs = sr.data?.data || [];
        setLandlordSigs(sigs);
        const defaultSig = sigs.find(s => s.is_default) || sigs[0];
        if (defaultSig) setSelectedLandlordSigId(String(defaultSig.id));

        setParties(l.signing_tenants || []);

        // Prefill the period from the server's uncovered stretch, so an extension
        // defaults to the new period rather than the whole tenancy.
        //
        // When the server cannot work out what is already covered we still have to put
        // something in the fields, and the lease's own dates are the only candidate — but
        // that is a GUESS, and for an extension it is the wrong one. Printing the whole
        // tenancy on a document that covers one extra month is a wrong date on a legal
        // agreement, so the guess is flagged rather than left to look authoritative.
        const gap = l.paperwork?.uncovered;
        const reason = l.paperwork?.reason || null;
        setPaperworkReason(reason);
        setPeriodIsGuess(!gap?.from);
        setTermFrom(gap?.from ? dayjs(gap.from) : (l.start_date ? dayjs(l.start_date) : null));
        setTermTo(gap?.to ? dayjs(gap.to) : (l.end_date ? dayjs(l.end_date) : null));
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
  }, [selectedTemplateId, termFrom, termTo, stampLonger, termStampEnd]);

  const refreshPreview = async () => {
    if (!selectedTemplateId) return;
    setPreviewLoading(true);
    setJointTemplateReady(false);
    setDocumentSnapshot(null);
    try {
      // THIS lease's real data rendered against the chosen template. Previously
      // this called leaseTemplate.previewSaved(), which renders the template's
      // SAMPLE data — so the preview always showed "Alice Wong / 1 September 2026"
      // and you could never see the real dates (notably the stamped Term of
      // Tenancy) before sending the lease out for signature.
      const r = await pdf.fetchLeaseWithTemplate(leaseId, selectedTemplateId, {
        from: termFrom ? termFrom.format('YYYY-MM-DD') : null,
        to: termTo ? termTo.format('YYYY-MM-DD') : null,
        stampEnd: stampLonger && termStampEnd ? termStampEnd.format('YYYY-MM-DD') : null,
      });
      // Fields that printed as blanks. The document renders the LABEL with nothing after
      // it, which looks like a broken template but is really missing data — and on a signed
      // tenancy agreement an empty identification line is worth catching before it goes out.
      const blanks = (r.headers?.['x-empty-placeholders'] || '')
        .split(',').map(x => x.trim()).filter(Boolean);
      setEmptyFields(blanks);
      setJointTemplateReady(r.headers?.['x-tenant-template-ready']==='true');
      setDocumentSnapshot(r.headers?.['x-document-snapshot']||null);

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
    setParties(prev => [...prev, { signer_name: '', signer_email: '', role: 'other' }]);
  };

  const removeParty = (idx) => {
    setParties(prev => prev.filter((p, i) => i !== idx || p.tenant_id));
  };

  const onSend = async () => {
    if (!selectedTemplateId) return message.warning('Pick a template first.');
    if(!documentSnapshot)return message.warning('Refresh the contract preview before sending.');
    if((lease?.signing_tenants?.length||0)>1&&!jointTemplateReady)return message.warning('Upgrade the template to show every tenant, then refresh the preview.');
    const cleanParties = parties
      .map(p => ({ ...p, signer_name: (p.signer_name || '').trim(), signer_email: (p.signer_email || '').trim() }));
    if (!cleanParties.length || cleanParties.some(p=>!p.signer_name||!p.signer_email)) return message.warning('Every signer needs a full name and email. No tenant can be omitted.');

    const payload = {
      lease_id: leaseId,
      template_id: selectedTemplateId,
      landlord_signature_id: selectedLandlordSigId || null,
      parties: cleanParties,
      document_snapshot:documentSnapshot,
      message: form.getFieldValue('message') || null,
      expires_in_days: form.getFieldValue('expires_in_days') || 14,
      term_start: termFrom ? termFrom.format('YYYY-MM-DD') : null,
      term_end: termTo ? termTo.format('YYYY-MM-DD') : null,
      term_stamp_end: stampLonger && termStampEnd ? termStampEnd.format('YYYY-MM-DD') : null,
    };
    const sendRequest = async (data) => {
      const r = await signature.createRequest(data);
      if (r.data?.code === 200) {
        message.success(`Signature request sent to ${cleanParties.length} signer${cleanParties.length === 1 ? '' : 's'}.`);
        router.push(`/leasing/${leaseId}/detail`);
      } else {
        message.error(r.data?.message || 'Failed to send');
      }
    };

    setSending(true);
    try {
      await sendRequest(payload);
    } catch (e) {
      const conflictData = e.response?.data?.data;
      if (e.response?.status === 409 && conflictData?.reason === 'overlapping_request') {
        Modal.confirm({
          title: 'Another document is already out for signature',
          content: (
            <div>
              <ul style={{ margin: '8px 0', paddingLeft: 20 }}>
                {(conflictData.conflicts || []).map(conflict => (
                  <li key={conflict.id}>
                    {conflict.term_start && conflict.term_end
                      ? `${dayjs(conflict.term_start).format('D MMM YYYY')} \u2013 ${dayjs(conflict.term_end).format('D MMM YYYY')}`
                      : 'Period not recorded'}
                    {conflict.sent_at ? ` \u00b7 sent ${dayjs(conflict.sent_at).format('D MMM YYYY')}` : ''}
                  </li>
                ))}
              </ul>
              <div>Sending this will cancel the older request &mdash; its signing link stops working.</div>
            </div>
          ),
          okText: 'Cancel older and send',
          okButtonProps: { danger: true },
          onOk: async () => {
            setSending(true);
            try {
              await sendRequest({ ...payload, replace_overlapping: true });
            } catch (retryError) {
              message.error(retryError.response?.data?.message || 'Failed to send');
            } finally {
              setSending(false);
            }
          },
        });
        return;
      }
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
                      // Number(): is_default arrives as 0/1, and `0 && <Tag/>` renders
                      // the NUMBER 0 in JSX — that's the stray "0" that appeared after
                      // every non-default template name ("...Contract Template 0").
                      label: <span>{t.name} {Number(t.is_default) === 1 && <Tag color="gold">Default</Tag>}</span>,
                    }))}
                  />
                  <Button size="small" icon={<EyeOutlined />} onClick={refreshPreview} loading={previewLoading}>
                    Refresh Preview
                  </Button>
                </Space>
              )}
            </Card>

            {(lease?.signing_tenants?.length||0)>1&&!jointTemplateReady&&!previewLoading && <Alert type="warning" showIcon style={{marginBottom:12}}
              message="This template needs joint-tenant blocks" description="Open this template in Settings → Lease Templates and preview the automatic tenant-block upgrade before saving. Refresh this signing preview afterward." />}
            {emptyFields.length > 0 && (
              <Alert
                type="warning" showIcon style={{ marginBottom: 12 }}
                message={`${emptyFields.length} field${emptyFields.length === 1 ? '' : 's'} will print blank on this contract`}
                description={
                  <>
                    <div style={{ marginBottom: 6 }}>
                      The template asks for {emptyFields.length === 1 ? 'this' : 'these'}, but the record is empty,
                      so the contract shows the label with nothing after it:
                    </div>
                    <div style={{ fontFamily: 'monospace', fontSize: 12, marginBottom: 6 }}>
                      {emptyFields.join(', ')}
                    </div>
                    <div>Fill it in on the tenant or lease record, then refresh the preview.</div>
                  </>
                }
              />
            )}

            {/* The period this document covers. The contract prints these as its
                term, and the preview re-renders when they change so what you
                approve is what the signer receives. */}
            <Card title="Period this document covers" size="small" style={{ marginBottom: 12 }}>
              {periodIsGuess && (
                <Alert
                  type="warning" showIcon style={{ marginBottom: 12 }}
                  message="Check these dates — we could not work out what is already covered"
                  description={
                    paperworkReason === 'period_not_recorded'
                      ? 'This lease has an earlier signed document, but no period was recorded against it, so we cannot tell what it covered. The dates below are the WHOLE tenancy. If this document only covers an extension, set the start to the day after the last signed period ended.'
                      : 'No signed document is on file for this lease, so the dates below are the whole tenancy. If this document only covers an extension or a renewal, set the period yourself — otherwise the contract will print the full term.'
                  }
                />
              )}
              <Space wrap>
                <DatePicker value={termFrom} onChange={setTermFrom} placeholder="From" />
                <DatePicker value={termTo} onChange={setTermTo} placeholder="To" />
              </Space>
              <div style={{ fontSize: 12, color: '#888', marginTop: 8 }}>
                For an extension this starts the day after the last signed period ended.
              </div>
              <div style={{ marginTop: 12 }}>
                <Checkbox
                  checked={stampLonger}
                  onChange={(e) => {
                    setStampLonger(e.target.checked);
                    // +2 years - 1 day from the period start, matching the lease form.
                    setTermStampEnd(e.target.checked && termFrom
                      ? termFrom.add(2, 'year').subtract(1, 'day') : null);
                  }}
                >
                  Stamp this period for a longer term
                </Checkbox>
                {stampLonger && (
                  <div style={{ marginTop: 8 }}>
                    <DatePicker value={termStampEnd} onChange={setTermStampEnd} />
                    <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>
                      Prints as the Term of Tenancy on this document only. The lease&apos;s own
                      stamped term is left untouched.
                    </div>
                  </div>
                )}
              </div>
            </Card>

            <Card title="Signers" size="small" style={{ marginBottom: 12 }}>
              {parties.map((p, i) => (
                <Row key={i} gutter={8} style={{ marginBottom: 8 }}>
                  <Col span={10}>
                    {p.tenant_id && <Tag>Required lease tenant</Tag>}
                    <Input
                      placeholder="Full name"
                      value={p.signer_name}
                      readOnly={!!p.tenant_id}
                      onChange={e => updateParty(i, 'signer_name', e.target.value)}
                    />
                  </Col>
                  <Col span={11}>
                    <Input
                      placeholder="email@example.com"
                      value={p.signer_email}
                      readOnly={!!p.tenant_id}
                      onChange={e => updateParty(i, 'signer_email', e.target.value)}
                    />
                  </Col>
                  <Col span={3}>
                    {!p.tenant_id && (
                      <Tooltip title="Remove signer">
                        <Button danger icon={<DeleteOutlined />} onClick={() => removeParty(i)} />
                      </Tooltip>
                    )}
                  </Col>
                </Row>
              ))}
              <Button size="small" icon={<PlusOutlined />} onClick={addParty}>
                Add non-tenant signer
              </Button>
              {parties.filter(p=>!p.tenant_id).map((p,i)=><div key={i} style={{marginTop:8}}>
                <span>Role for {p.signer_name || 'additional signer'}: </span>
                <Select value={p.role} style={{width:150}} options={[{value:'guarantor',label:'Guarantor'},{value:'other',label:'Other'}]}
                  onChange={role=>updateParty(parties.indexOf(p),'role',role)} />
              </div>)}
              <div style={{fontSize:12,marginTop:8}}>Tenant names and emails come from the contact records and must match the PDF. Correct them on the contact record, then reload this page.</div>
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
              This preview shows this lease&apos;s real data. Signatures are added when each signer opens their link.
            </div>
          </Col>
        </Row>
      </div>
    </MainLayout>
  );
}
