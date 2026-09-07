'use client';

// Smart Extract for tenant create/edit pages.
// Paste a screenshot of an HKID / passport / driver's license (or paste text)
// and the backend OCRs + LLM-parses it into structured fields:
//   first_name, last_name, middle_name, birth_date, id_card, sex
//
// The screenshot IS kept, and attached to the tenant's documents. It used to be
// discarded on the reasoning that ID photos are PII best not held; that was
// reversed deliberately, so the document a record was built from stays with the
// record. It also makes extraction bugs diagnosable — the passport misread that
// prompted the MRZ parser could not be reproduced, because the image was gone.
//
// Props:
//   onExtracted(patch) — called with an object of fields to prefill. Keys
//     correspond to Ant Form names (first_name, last_name, middle_name,
//     birth_date as a dayjs, id_card, sex as 1|2).
//   onFileSaved(fileId) — called with the id of the stored screenshot. The
//     Create form holds this until save, because the tenant it belongs to does
//     not exist yet; the Edit form can link it straight away.
//   compact — render a tighter version (defaults to false).

import { useState } from 'react';
import { Input, Button, Card, Upload, message, Alert } from 'antd';
import { ThunderboltOutlined, PictureOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { tenant } from '../lib/api';

// Shown if the server reports OCR is down but sends no message of its own.
const OCR_DOWN_FALLBACK =
  'Screenshot reading is unavailable — the Google Cloud Vision account needs updating. '
  + 'Type the details in, or paste them as text, until it is restored.';

export default function TenantSmartExtract({ onExtracted, onFileSaved, compact = false }) {
  const [text, setText] = useState('');
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);
  // Holds the reason OCR is unavailable, once the server has reported it. A
  // toast disappears; this keeps the real cause on screen so the next person to
  // try does not read it as their screenshot being unclear.
  const [ocrDown, setOcrDown] = useState('');

  // Pasting a screenshot anywhere inside the card picks it up from the
  // clipboard automatically (Ctrl+V). The file input still works for cases
  // where the user has the image saved on disk.
  const onPasteCapture = (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const blob = item.getAsFile();
        if (!blob) continue;
        const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
        const newFile = new File([blob], `pasted-${Date.now()}.${ext}`, { type: blob.type });
        setFile(newFile);
        message.success('Screenshot pasted');
        e.preventDefault();
        return;
      }
    }
  };

  const onExtract = async () => {
    const hasText = text.trim().length > 0;
    const hasImage = !!file;
    if (!hasText && !hasImage) {
      message.warning('Paste some text or pick a screenshot first.');
      return;
    }
    setLoading(true);
    try {
      const fd = new FormData();
      if (hasText) fd.append('text', text);
      if (hasImage) fd.append('image', file);
      const r = await tenant.parse(fd);
      if (r.data?.code !== 200) {
        message.error(r.data?.message || 'Parse failed');
        return;
      }
      const {
        fields = {}, file_id: fileId, mrz,
        // Set when OCR is down for everyone rather than failing on this image —
        // a lapsed Google Cloud Vision account, most often. Kept in state so the
        // reason stays on screen instead of vanishing with a toast.
        ocr_unavailable: ocrUnavailable, ocr_message: ocrMessage,
      } = r.data.data || {};
      setOcrDown(ocrUnavailable ? (ocrMessage || OCR_DOWN_FALLBACK) : '');

      // The saved screenshot. Handed up so the form can attach it to the tenant
      // on save — on the Create page there is no tenant id yet, so the link can
      // only happen once the record exists.
      if (fileId && typeof onFileSaved === 'function') onFileSaved(String(fileId));

      // Map LLM output to Ant Form field names. Dates become dayjs for the
      // DatePicker; sex normalises to 1=male / 2=female (the DB encoding).
      const patch = {};
      if (fields.first_name)  patch.first_name  = String(fields.first_name).trim();
      if (fields.last_name)   patch.last_name   = String(fields.last_name).trim();
      if (fields.middle_name) patch.middle_name = String(fields.middle_name).trim();
      if (fields.id_card)     patch.id_card     = String(fields.id_card).trim();
      if (fields.birth_date) {
        const d = dayjs(fields.birth_date);
        if (d.isValid()) patch.birth_date = d;
      }
      if (fields.sex != null) {
        // Accept either numeric (1/2) or string ("male"/"female"/"M"/"F")
        const raw = String(fields.sex).trim().toLowerCase();
        if (raw === '1' || raw.startsWith('m')) patch.sex = 1;
        else if (raw === '2' || raw.startsWith('f')) patch.sex = 2;
      }

      const filled = Object.keys(patch).length;
      if (filled === 0) {
        // Never blame the image when OCR never ran. Someone sent off to
        // rephotograph a perfectly good HKID will keep failing until an admin
        // sees the real reason.
        message.error(ocrUnavailable
          ? (ocrMessage || OCR_DOWN_FALLBACK)
          : 'Could not extract any fields. Try a clearer image or paste text.', 8);
        return;
      }
      onExtracted(patch);

      // Say when the ID number specifically could not be trusted. The parser
      // refuses to guess a passport number it cannot verify against the check
      // digits, and a silently blank field looks like a bug rather than a
      // deliberate abstention.
      // Fields came from the pasted text, not the screenshot — say so, or a
      // good-looking result reads as proof the screenshot was read.
      if (ocrUnavailable && hasImage) {
        message.warning('The screenshot was not read — those fields came from your pasted text.', 8);
      }

      const idCheck = mrz && mrz.checks && mrz.checks.document_number;
      if (!patch.id_card && (idCheck === 'unverified' || idCheck === 'ambiguous' || idCheck === 'failed')) {
        message.warning('Could not read the passport number reliably — please type it in.');
      }
      message.success(`Extracted ${filled} field${filled === 1 ? '' : 's'}.`
        + (fileId ? ' Screenshot saved to the tenant.' : ''));

      // Clear inputs after success so the user isn't tempted to re-extract
      // stale data on top of the form they just edited.
      setText('');
      setFile(null);
    } catch (e) {
      message.error(e.response?.data?.message || 'Parse failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card
      size="small"
      onPasteCapture={onPasteCapture}
      style={{
        marginBottom: compact ? 12 : 16,
        background: '#fafbff',
        borderColor: '#d6e4ff',
      }}
      title={
        <span style={{ fontSize: 13, fontWeight: 600, color: '#1677ff' }}>
          <ThunderboltOutlined /> Smart Extract
        </span>
      }
    >
      {ocrDown && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 8 }}
          message="Screenshot reading is offline"
          description={ocrDown}
        />
      )}
      <div style={{ marginBottom: 8 }}>
        <Input.TextArea
          rows={compact ? 2 : 3}
          placeholder="Paste a screenshot of an HKID, passport, or driver's license (Ctrl+V), or type out the details. Works in English / Chinese."
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Upload
          beforeUpload={(f) => { setFile(f); return false; }}
          onRemove={() => setFile(null)}
          fileList={file ? [{ uid: '1', name: file.name, status: 'done' }] : []}
          maxCount={1}
          accept="image/*"
        >
          <Button icon={<PictureOutlined />}>Screenshot (optional)</Button>
        </Upload>
        <Button
          type="primary"
          icon={<ThunderboltOutlined />}
          loading={loading}
          onClick={onExtract}
        >
          Extract
        </Button>
      </div>
      <div style={{ fontSize: 11, color: '#999', marginTop: 8 }}>
        The screenshot is saved to this tenant's documents and the details are
        read from it. Review the prefilled fields before saving.
      </div>
    </Card>
  );
}
