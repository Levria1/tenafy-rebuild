'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Collapse, Image, Space, Spin, Tag, Typography } from 'antd';
import { CloseOutlined, PaperClipOutlined } from '@ant-design/icons';
import { chatApi } from '../../lib/api';

const { Text } = Typography;

const ACCEPTED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.85;

function imageSizeLabel(bytes) {
  if (!bytes) return '0 KB';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new window.Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read that image.'));
    };
    img.src = url;
  });
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Could not resize that image.'));
    }, 'image/jpeg', JPEG_QUALITY);
  });
}

async function prepareImage(file) {
  if (!file || !ACCEPTED_TYPES.has(file.type)) {
    throw new Error('Only PNG, JPEG, WebP, or GIF images are supported.');
  }

  const img = await loadImage(file);
  const longEdge = Math.max(img.naturalWidth, img.naturalHeight);
  if (longEdge <= MAX_EDGE && file.size <= MAX_UPLOAD_BYTES) return file;

  const scale = longEdge > MAX_EDGE ? MAX_EDGE / longEdge : 1;
  const width = Math.max(1, Math.round(img.naturalWidth * scale));
  const height = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);

  const blob = await canvasToBlob(canvas);
  if (blob.size > MAX_UPLOAD_BYTES) {
    throw new Error('Image too large after resizing (max 10 MB).');
  }

  const baseName = file.name ? file.name.replace(/\.[^.]+$/, '') : 'chat-image';
  return new File([blob], `${baseName}.jpg`, { type: 'image/jpeg' });
}

function firstImageFromPaste(e) {
  const items = Array.from(e.clipboardData?.items || []);
  const imageItem = items.find((item) => item.kind === 'file' && item.type?.startsWith('image/'));
  return imageItem ? imageItem.getAsFile() : null;
}

function firstImageFromDrop(e) {
  const files = Array.from(e.dataTransfer?.files || []);
  return files.find((file) => file.type?.startsWith('image/')) || null;
}

export function useChatImageOcr({ onError } = {}) {
  const [attachment, setAttachment] = useState(null);
  const [reading, setReading] = useState(false);
  const inputRef = useRef(null);

  const clearAttachment = useCallback(() => {
    setAttachment((current) => {
      if (current?.previewUrl) URL.revokeObjectURL(current.previewUrl);
      return null;
    });
  }, []);

  useEffect(() => () => {
    if (attachment?.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
  }, [attachment]);

  const reportError = useCallback((err) => {
    const msg = err?.response?.data?.message || err?.message || 'OCR failed';
    onError?.(msg);
  }, [onError]);

  const readImage = useCallback(async (file) => {
    if (!file || reading) return;
    setReading(true);
    try {
      const prepared = await prepareImage(file);
      const previewUrl = URL.createObjectURL(prepared);
      const res = await chatApi.ocrImage(prepared);
      const data = res.data?.data || {};
      clearAttachment();
      setAttachment({
        previewUrl,
        name: prepared.name || file.name || 'image',
        size: prepared.size,
        text: String(data.text || '').trim(),
        message: data.message || '',
      });
    } catch (err) {
      reportError(err);
    } finally {
      setReading(false);
    }
  }, [clearAttachment, reading, reportError]);

  const openFilePicker = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const attachButton = (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          readImage(file);
        }}
      />
      <Button icon={<PaperClipOutlined />} onClick={openFilePicker} disabled={reading} />
    </>
  );

  const textAreaProps = {
    onPaste: (e) => {
      const file = firstImageFromPaste(e);
      if (!file) return;
      e.preventDefault();
      readImage(file);
    },
  };

  const dropProps = {
    onDragOver: (e) => {
      if (Array.from(e.dataTransfer?.items || []).some((item) => item.type?.startsWith('image/'))) {
        e.preventDefault();
      }
    },
    onDrop: (e) => {
      const file = firstImageFromDrop(e);
      if (!file) return;
      e.preventDefault();
      readImage(file);
    },
  };

  const composeMessage = useCallback((typedText) => {
    const question = typedText.trim() || 'Please answer based on the text extracted from the attached image.';
    if (!attachment?.text) return question;
    return [
      '[Attached image - text extracted by OCR]',
      attachment.text,
      '',
      question,
    ].join('\n');
  }, [attachment]);

  return {
    attachment,
    reading,
    attachButton,
    textAreaProps,
    dropProps,
    clearAttachment,
    composeMessage,
    // NOTE: deliberately no `canSend` here. Whether Send is enabled depends on
    // the page's own typed-text state as well as the attachment, so each page
    // computes it: `reading || (!input.trim() && !attachment?.text)`.
  };
}

export function ImageOcrPreview({ attachment, reading, onRemove }) {
  if (reading) {
    return (
      <div style={{ marginBottom: 8, color: '#595959' }}>
        <Spin size="small" style={{ marginRight: 8 }} />
        Reading image...
      </div>
    );
  }
  if (!attachment) return null;

  const text = attachment.text || attachment.message || '';
  return (
    <div style={{ marginBottom: 8, border: '1px solid #f0f0f0', borderRadius: 8, padding: 8 }}>
      <Space align="center" style={{ width: '100%', justifyContent: 'space-between' }}>
        <Space size={8}>
          <Image
            src={attachment.previewUrl}
            alt={attachment.name}
            width={40}
            height={40}
            preview={false}
            style={{ objectFit: 'cover', borderRadius: 4, border: '1px solid #f0f0f0' }}
          />
          <div>
            <Tag color={attachment.text ? 'blue' : 'default'}>
              OCR {attachment.text.length} chars
            </Tag>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {imageSizeLabel(attachment.size)}
            </Text>
          </div>
        </Space>
        <Button size="small" type="text" icon={<CloseOutlined />} onClick={onRemove} />
      </Space>
      <Collapse
        size="small"
        ghost
        style={{ marginTop: 6 }}
        items={[{
          key: 'ocr',
          label: 'Extracted text',
          children: (
            <div style={{ maxHeight: 180, overflowY: 'auto', whiteSpace: 'pre-wrap', fontSize: 12 }}>
              {text}
            </div>
          ),
        }]}
      />
    </div>
  );
}
