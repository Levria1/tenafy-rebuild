'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Alert, Button, Card, Col, InputNumber, message, Row, Space, Spin, Typography,
} from 'antd';
import { ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import MainLayout from '../../../components/Layout';
import { advertisingApi } from '../../../lib/api';

const { Title, Text } = Typography;

export default function AdvertisingSettingsPage() {
  const [minGapDays, setMinGapDays] = useState(null);
  const [leadDaysNr, setLeadDaysNr] = useState(null);
  const [leadDaysOther, setLeadDaysOther] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setLoadError(false);
    advertisingApi.getAdSettings()
      .then(r => {
        const d = r.data?.data;
        if (!d) { setLoadError(true); return; }
        setMinGapDays(d.min_gap_days ?? null);
        setLeadDaysNr(d.lead_days_nr ?? null);
        setLeadDaysOther(d.lead_days_other ?? null);
      })
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleNullableDays = setter => value => {
    setter(value === null || value === undefined || value === '' ? null : Number(value));
  };

  const handleSave = async () => {
    if (loadError) return;

    setSaving(true);
    try {
      const r = await advertisingApi.updateAdSettings({
        min_gap_days: minGapDays,
        lead_days_nr: leadDaysNr,
        lead_days_other: leadDaysOther,
      });
      const d = r.data?.data;
      if (d) {
        setMinGapDays(d.min_gap_days ?? null);
        setLeadDaysNr(d.lead_days_nr ?? null);
        setLeadDaysOther(d.lead_days_other ?? null);
      }
      message.success('Saved');
    } catch (err) {
      message.error(err?.response?.data?.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <MainLayout>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <Title level={4} style={{ margin: 0 }}>Advertising Settings</Title>
          <Text type="secondary">When a unit becomes advertisable, and how long it must be free to be worth posting.</Text>
        </div>
        <Button icon={<ReloadOutlined />} onClick={load}>Refresh</Button>
      </div>

      <Card size="small" title="Availability windows" style={{ marginBottom: 16 }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 48 }}><Spin size="large" /></div>
        ) : (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            {loadError && (
              <Alert
                type="error"
                showIcon
                message="Couldn't load advertising settings."
                description="Saving is disabled until they load, so a failed read can't overwrite your real settings."
                action={<Button size="small" onClick={load}>Retry</Button>}
              />
            )}

            <Alert
              type="warning"
              showIcon
              message="These values are shared"
              description="They also govern what the chatbot offers in answer to inquiries, unless a per-field override is set on Chatbot → Settings → Leasing."
            />

            <Row gutter={24}>
              <Col xs={24} md={8} style={{ marginBottom: 16 }}>
                <div style={{ marginBottom: 4, fontWeight: 500 }}>Minimum vacancy worth posting</div>
                <InputNumber
                  min={0} max={365} value={minGapDays} onChange={handleNullableDays(setMinGapDays)}
                  disabled={loadError} addonAfter="days" style={{ width: '100%', maxWidth: 240 }}
                />
                <div style={{ color: '#888', fontSize: 12, marginTop: 6 }}>
                  A unit re-let sooner than this is effectively taken, so it is not advertised.
                </div>
              </Col>

              <Col xs={24} md={8} style={{ marginBottom: 16 }}>
                <div style={{ marginBottom: 4, fontWeight: 500 }}>Post a not-renewing unit from</div>
                <InputNumber
                  min={0} max={365} value={leadDaysNr} onChange={handleNullableDays(setLeadDaysNr)}
                  disabled={loadError} addonAfter="days out" style={{ width: '100%', maxWidth: 240 }}
                />
                <div style={{ color: '#888', fontSize: 12, marginTop: 6 }}>
                  The tenant has confirmed they are leaving, so a longer runway is safe.
                </div>
              </Col>

              <Col xs={24} md={8} style={{ marginBottom: 16 }}>
                <div style={{ marginBottom: 4, fontWeight: 500 }}>Post an other/may-renew unit from</div>
                <InputNumber
                  min={0} max={365} value={leadDaysOther} onChange={handleNullableDays(setLeadDaysOther)}
                  disabled={loadError} addonAfter="days out" style={{ width: '100%', maxWidth: 240 }}
                />
                <div style={{ color: '#888', fontSize: 12, marginTop: 6 }}>
                  Shorter on purpose: they may renew, and advertising too early markets a unit that might never come free.
                </div>
              </Col>
            </Row>

            <Button
              type="primary"
              icon={<SaveOutlined />}
              loading={saving}
              disabled={loadError}
              onClick={handleSave}
            >
              Save
            </Button>
          </Space>
        )}
      </Card>
    </MainLayout>
  );
}
