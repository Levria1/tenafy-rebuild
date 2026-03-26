'use client';

import { Suspense, useEffect, useState, useCallback } from 'react';
import { Tabs, Table, Button, Select, DatePicker, Tag, Space, Input, Modal, Form, message, Popconfirm, Card, Typography } from 'antd';
import { SaveOutlined, PlusOutlined, DeleteOutlined, ThunderboltOutlined, EditOutlined } from '@ant-design/icons';
import MainLayout from '../../components/Layout';
import { cleaning, user } from '../../lib/api';
import dayjs from 'dayjs';
import isoWeek from 'dayjs/plugin/isoWeek';
dayjs.extend(isoWeek);

const { Text, Title } = Typography;

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAY_OPTIONS = DAY_LABELS.map((label, i) => ({ label, value: i }));

export default function CleaningPageWrapper() {
  return <Suspense fallback={<div />}><CleaningPage /></Suspense>;
}

function CleaningPage() {
  const [activeTab, setActiveTab] = useState('weekly');

  const items = [
    { key: 'weekly', label: 'Weekly Cleaning', children: <WeeklyCleaningTab /> },
    { key: 'checkout', label: 'Checkout Cleaning', children: <CheckoutCleaningTab /> },
    { key: 'checkoutNotes', label: 'Checkout Notes', children: <CheckoutNotesTab /> },
    { key: 'schedule', label: 'Weekly Schedule', children: <WeeklyScheduleTab /> },
    { key: 'settings', label: 'Settings', children: <CleanerSettingsTab /> },
  ];

  return (
    <MainLayout>
      <div style={{ marginBottom: 16 }}>
        <Title level={4} style={{ margin: 0 }}>Cleaning</Title>
      </div>
      <Tabs activeKey={activeTab} onChange={setActiveTab} items={items} />
    </MainLayout>
  );
}

// ─── TAB 1: Weekly Cleaning ──────────────────────────────────────────────────

function WeeklyCleaningTab() {
  const [configs, setConfigs] = useState([]);
  const [cleaners, setCleaners] = useState([]);
  const [overrides, setOverrides] = useState({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [checkoutMap, setCheckoutMap] = useState({});
  const [weekNotes, setWeekNotes] = useState({}); // { propertyId: notes }

  // The selected week for overrides (default: next Monday)
  const [selectedWeek, setSelectedWeek] = useState(() => {
    const today = dayjs();
    const dayOfWeek = today.day(); // 0=Sun
    const daysUntilMon = dayOfWeek === 0 ? 1 : (8 - dayOfWeek);
    return today.add(daysUntilMon, 'day').format('YYYY-MM-DD');
  });

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [cfgRes, cleanerRes, checkoutRes] = await Promise.all([
        cleaning.getConfig(),
        cleaning.getCleaners(),
        cleaning.getCheckout(),
      ]);

      const cfgData = cfgRes.data?.data || [];
      const cleanerData = (cleanerRes.data?.data || []).filter(c => Number(c.status) === 1);
      setCleaners(cleanerData);

      // Config endpoint now returns ALL active units with their config + current tenant
      const merged = cfgData.map(r => ({
        unit_id: r.unit_id,
        unit_name: r.unit_name,
        property_id: r.property_id,
        property_name: r.property_name,
        cleaning_day: r.cleaning_day !== null && r.cleaning_day !== undefined ? Number(r.cleaning_day) : null,
        cleaner_id: r.cleaner_id,
        tenant_name: [r.tenant_first_name, r.tenant_last_name].filter(Boolean).join(' ') || null,
        tenant_cleaning_notes: r.tenant_cleaning_notes || null,
      }));
      setConfigs(merged);

      // Build checkout map: unit_id -> checkout info
      const coMap = {};
      for (const co of (checkoutRes.data?.data || [])) {
        coMap[co.unit_id.toString()] = co;
      }
      setCheckoutMap(coMap);

      // Load overrides for selected week
      await loadOverrides(selectedWeek);
    } catch (err) {
      console.error(err);
      message.error('Failed to load cleaning data');
    } finally {
      setLoading(false);
    }
  }, [selectedWeek]);

  const loadOverrides = async (weekOf) => {
    try {
      const [overRes, notesRes] = await Promise.all([
        cleaning.getOverrides(weekOf),
        cleaning.getWeekNotes(weekOf),
      ]);
      const map = {};
      for (const o of (overRes.data?.data || [])) {
        map[o.unit_id.toString()] = o;
      }
      setOverrides(map);
      const nMap = {};
      for (const n of (notesRes.data?.data || [])) {
        nMap[n.property_id.toString()] = n.notes;
      }
      setWeekNotes(nMap);
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => { loadData(); }, [loadData]);

  useEffect(() => { loadOverrides(selectedWeek); }, [selectedWeek]);

  const handleConfigChange = (unitId, field, value) => {
    setConfigs(prev => prev.map(c =>
      c.unit_id.toString() === unitId.toString()
        ? { ...c, [field]: value }
        : c
    ));
    setDirty(true);
  };

  const handleOverrideChange = async (unitId, value) => {
    // value: null = Normal, 'skip' = skip, number = move to day
    let override_type = null;
    let override_day = null;

    if (value === 'skip') {
      override_type = 0;
    } else if (value !== null && value !== undefined && value !== 'normal') {
      override_type = 1;
      override_day = Number(value);
    }

    // Preserve existing notes when changing override type
    const existingNotes = overrides[unitId.toString()]?.notes || null;

    // If setting to Normal but there are notes, use type=2 (notes-only) to preserve them
    let effectiveType = override_type;
    if (override_type === null && existingNotes) {
      effectiveType = 2;
    }

    try {
      await cleaning.saveOverride({
        unit_id: unitId,
        week_of: selectedWeek,
        override_type: effectiveType,
        override_day,
        notes: existingNotes,
      });
      // Update local state
      if (effectiveType === null) {
        setOverrides(prev => {
          const copy = { ...prev };
          delete copy[unitId.toString()];
          return copy;
        });
      } else {
        setOverrides(prev => ({
          ...prev,
          [unitId.toString()]: { override_type: effectiveType, override_day, notes: existingNotes },
        }));
      }
    } catch (err) {
      message.error('Failed to save override');
    }
  };

  const handleOverrideNotes = async (unitId, notes) => {
    const existing = overrides[unitId.toString()];
    const override_type = existing?.override_type;
    const override_day = existing?.override_day;

    try {
      if ((override_type === null || override_type === undefined) && !notes?.trim()) {
        // No override and no notes — nothing to save
        return;
      }

      // If no override exists but notes are being added, use type=2 (notes-only)
      const effectiveType = (override_type !== null && override_type !== undefined) ? override_type : 2;

      await cleaning.saveOverride({
        unit_id: unitId,
        week_of: selectedWeek,
        override_type: effectiveType,
        override_day: override_day ?? null,
        notes: notes || null,
      });
      setOverrides(prev => ({
        ...prev,
        [unitId.toString()]: { ...existing, override_type: effectiveType, override_day: override_day ?? null, notes },
      }));
    } catch (err) {
      message.error('Failed to save notes');
    }
  };

  const handlePropertyNotes = async (propertyId, notes) => {
    try {
      await cleaning.saveWeekNotes({
        property_id: propertyId,
        week_of: selectedWeek,
        notes: notes || null,
      });
      setWeekNotes(prev => ({ ...prev, [propertyId.toString()]: notes }));
    } catch (err) {
      message.error('Failed to save property notes');
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await cleaning.saveConfig({
        configs: configs.map(c => ({
          unit_id: c.unit_id,
          property_id: c.property_id,
          cleaning_day: c.cleaning_day,
          cleaner_id: c.cleaner_id,
        })),
      });
      message.success('Cleaning config saved');
      setDirty(false);
    } catch (err) {
      message.error('Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const getOverrideValue = (unitId) => {
    const o = overrides[unitId.toString()];
    if (!o) return 'normal';
    if (Number(o.override_type) === 0) return 'skip';
    if (Number(o.override_type) === 2) return 'normal'; // notes-only, keep normal
    return o.override_day;
  };

  const columns = [
    {
      title: 'Property',
      dataIndex: 'property_name',
      width: 180,
      onFilter: (value, record) => record.property_name === value,
      filters: [...new Set(configs.map(c => c.property_name))].map(p => ({ text: p, value: p })),
    },
    {
      title: 'Unit',
      dataIndex: 'unit_name',
      width: 120,
    },
    {
      title: 'Tenant',
      dataIndex: 'tenant_name',
      width: 150,
      render: v => v || <Text type="secondary">Vacant</Text>,
    },
    {
      title: 'Cleaning Notes',
      dataIndex: 'tenant_cleaning_notes',
      width: 180,
      render: v => v ? <Text type="secondary" style={{ fontSize: 12 }}>{v}</Text> : null,
    },
    {
      title: 'Day',
      dataIndex: 'cleaning_day',
      width: 130,
      render: (val, record) => (
        <Select
          value={val !== null && val !== undefined ? Number(val) : undefined}
          onChange={v => handleConfigChange(record.unit_id, 'cleaning_day', v)}
          options={DAY_OPTIONS}
          placeholder="Select day"
          allowClear
          style={{ width: 110 }}
          size="small"
        />
      ),
    },
    {
      title: 'Cleaner',
      dataIndex: 'cleaner_id',
      width: 160,
      render: (val, record) => (
        <Select
          value={val ? val.toString() : undefined}
          onChange={v => handleConfigChange(record.unit_id, 'cleaner_id', v)}
          options={cleaners.map(c => ({ label: c.name, value: c.id.toString() }))}
          placeholder="Select cleaner"
          allowClear
          style={{ width: 140 }}
          size="small"
        />
      ),
    },
    {
      title: `Change (week of ${dayjs(selectedWeek).format('MMM D')})`,
      width: 180,
      render: (_, record) => {
        const overrideVal = getOverrideValue(record.unit_id);
        return (
          <Select
            value={overrideVal}
            onChange={v => handleOverrideChange(record.unit_id, v)}
            style={{ width: 160 }}
            size="small"
            options={[
              { label: 'Normal', value: 'normal' },
              { label: 'No Cleaning', value: 'skip' },
              ...DAY_OPTIONS.map(d => ({ label: `Move to ${d.label}`, value: d.value })),
            ]}
          />
        );
      },
    },
    {
      title: '',
      width: 80,
      render: (_, record) => {
        const co = checkoutMap[record.unit_id.toString()];
        if (co) {
          return <Tag color="orange">退房 {dayjs(co.cleaning_date).format('M/D')}</Tag>;
        }
        return null;
      },
    },
    {
      title: 'Notes',
      width: 200,
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Space>
          <Text>Override week:</Text>
          <DatePicker
            value={dayjs(selectedWeek)}
            onChange={d => d && setSelectedWeek(d.startOf('week').add(1, 'day').format('YYYY-MM-DD'))}
            picker="week"
            size="small"
          />
        </Space>
        <Button type="primary" icon={<SaveOutlined />} onClick={handleSave} loading={saving} disabled={!dirty}>
          Save Config
        </Button>
      </div>
      <Table
        dataSource={(() => {
          // Insert property header rows before each property group
          const rows = [];
          let lastProp = null;
          for (const c of configs) {
            if (c.property_id?.toString() !== lastProp) {
              lastProp = c.property_id?.toString();
              rows.push({ _type: 'property', property_id: c.property_id, property_name: c.property_name, unit_id: `prop-${c.property_id}` });
            }
            rows.push(c);
          }
          return rows;
        })()}
        columns={columns.map(col => {
          if (col.dataIndex === 'property_name') {
            return {
              ...col,
              render: (val, record) => {
                if (record._type === 'property') {
                  return <Text strong style={{ fontSize: 13 }}>{record.property_name}</Text>;
                }
                return val;
              },
            };
          }
          if (col.title === 'Notes') {
            return {
              ...col,
              render: (_, record) => {
                if (record._type === 'property') {
                  return (
                    <Input
                      size="small"
                      placeholder="Property notes for this week..."
                      value={weekNotes[record.property_id.toString()] || ''}
                      onChange={e => setWeekNotes(prev => ({ ...prev, [record.property_id.toString()]: e.target.value }))}
                      onBlur={e => handlePropertyNotes(record.property_id, e.target.value)}
                      onPressEnter={e => handlePropertyNotes(record.property_id, e.target.value)}
                      style={{ fontWeight: 'bold' }}
                    />
                  );
                }
                const o = overrides[record.unit_id.toString()];
                return (
                  <Input
                    size="small"
                    placeholder="Special notes..."
                    value={o?.notes || ''}
                    onChange={e => {
                      setOverrides(prev => ({
                        ...prev,
                        [record.unit_id.toString()]: { ...prev[record.unit_id.toString()], notes: e.target.value },
                      }));
                    }}
                    onBlur={e => handleOverrideNotes(record.unit_id, e.target.value)}
                    onPressEnter={e => handleOverrideNotes(record.unit_id, e.target.value)}
                  />
                );
              },
            };
          }
          // For property rows, render empty cells for other columns
          const origRender = col.render;
          return {
            ...col,
            render: (val, record, idx) => {
              if (record._type === 'property' && col.dataIndex !== 'property_name' && col.title !== 'Notes') {
                return null;
              }
              return origRender ? origRender(val, record, idx) : val;
            },
          };
        })}
        rowKey="unit_id"
        loading={loading}
        size="small"
        pagination={false}
        scroll={{ y: 600 }}
        rowClassName={(record) => record._type === 'property' ? 'cleaning-property-row' : ''}
      />
      <style>{`.cleaning-property-row td { background: #f5f5f5 !important; }`}</style>
    </div>
  );
}

// ─── TAB 2: Checkout Cleaning ────────────────────────────────────────────────

function CheckoutCleaningTab() {
  const [data, setData] = useState([]);
  const [cleaners, setCleaners] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selectedMonth, setSelectedMonth] = useState(dayjs());

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const monthStr = selectedMonth.format('YYYY-MM');
      const [coRes, cleanerRes] = await Promise.all([
        cleaning.getCheckout(monthStr),
        cleaning.getCleaners(),
      ]);
      setData(coRes.data?.data || []);
      setCleaners((cleanerRes.data?.data || []).filter(c => Number(c.status) === 1));
    } catch (err) {
      message.error('Failed to load checkout cleaning');
    } finally {
      setLoading(false);
    }
  }, [selectedMonth]);

  useEffect(() => { loadData(); }, [loadData]);

  const handleUpdate = async (id, field, value) => {
    try {
      await cleaning.updateCheckout(id, { [field]: value });
      message.success('Updated');
      loadData();
    } catch (err) {
      message.error('Failed to update');
    }
  };

  const columns = [
    {
      title: 'Property',
      dataIndex: 'property_name',
      width: 160,
    },
    {
      title: 'Unit',
      dataIndex: 'unit_name',
      width: 100,
    },
    {
      title: 'Tenant',
      width: 150,
      render: (_, r) => [r.first_name, r.last_name].filter(Boolean).join(' '),
    },
    {
      title: 'Lease End',
      dataIndex: 'lease_end_date',
      width: 110,
      render: v => v ? dayjs(v).format('YYYY-MM-DD') : '-',
      sorter: (a, b) => new Date(a.lease_end_date) - new Date(b.lease_end_date),
      defaultSortOrder: 'ascend',
    },
    {
      title: 'Cleaning Date',
      dataIndex: 'cleaning_date',
      width: 140,
      render: (v, r) => (
        <DatePicker
          value={v ? dayjs(v) : null}
          onChange={d => handleUpdate(r.id, 'cleaning_date', d ? d.format('YYYY-MM-DD') : null)}
          size="small"
        />
      ),
    },
    {
      title: 'Cleaner',
      dataIndex: 'cleaner_id',
      width: 150,
      render: (v, r) => (
        <Select
          value={v ? v.toString() : undefined}
          onChange={val => handleUpdate(r.id, 'cleaner_id', val)}
          options={cleaners.map(c => ({ label: c.name, value: c.id.toString() }))}
          placeholder="Assign"
          allowClear
          style={{ width: 130 }}
          size="small"
        />
      ),
    },
    {
      title: 'Next Lease Start',
      dataIndex: 'next_lease_start',
      width: 130,
      render: (v, r) => v ? (
        <span>{dayjs(v).format('YYYY-MM-DD')}{r.next_tenant_name ? ` (${r.next_tenant_name})` : ''}</span>
      ) : <Text type="secondary">None</Text>,
    },
  ];

  return (
    <div>
      <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
        <span>Month:</span>
        <DatePicker
          picker="month"
          value={selectedMonth}
          onChange={v => v && setSelectedMonth(v)}
          allowClear={false}
          size="small"
        />
      </div>
      <Table
        dataSource={data}
        columns={columns}
        rowKey="id"
        loading={loading}
        size="small"
        pagination={false}
        scroll={{ y: 600 }}
      />
    </div>
  );
}

// ─── TAB 3: Weekly Schedule ──────────────────────────────────────────────────

function WeeklyScheduleTab() {
  const [schedule, setSchedule] = useState([]);
  const [cleaners, setCleaners] = useState([]);
  const [selectedCleaner, setSelectedCleaner] = useState(null);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [weekNotes, setWeekNotes] = useState([]);

  // Default to upcoming Monday
  const [selectedMonday, setSelectedMonday] = useState(() => {
    const today = dayjs();
    const dayOfWeek = today.day(); // 0=Sun
    const daysUntilMon = dayOfWeek === 0 ? 1 : dayOfWeek === 1 ? 0 : (8 - dayOfWeek);
    return today.add(daysUntilMon, 'day').format('YYYY-MM-DD');
  });

  // Calculate the month view: first Monday of the month that selectedMonday falls in
  const selectedMonth = dayjs(selectedMonday);

  const loadSchedule = useCallback(async () => {
    setLoading(true);
    try {
      const [res, cleanerRes, notesRes] = await Promise.all([
        cleaning.getSchedule(selectedMonday),
        cleaning.getCleaners(),
        cleaning.getWeekNotes(selectedMonday),
      ]);
      setSchedule(res.data?.data || []);
      setCleaners((cleanerRes.data?.data || []).filter(c => Number(c.status) === 1));
      setWeekNotes(notesRes.data?.data || []);
    } catch (err) {
      message.error('Failed to load schedule');
    } finally {
      setLoading(false);
    }
  }, [selectedMonday]);

  useEffect(() => { loadSchedule(); }, [loadSchedule]);

  // Filter schedule by selected cleaner
  const filteredSchedule = selectedCleaner
    ? schedule.filter(s => s.cleaner_id && s.cleaner_id.toString() === selectedCleaner)
    : schedule;

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const res = await cleaning.generateSchedule({ week_of: selectedMonday });
      message.success(res.data?.message || 'Schedule generated');
      loadSchedule();
    } catch (err) {
      message.error(err.response?.data?.message || 'Failed to generate');
    } finally {
      setGenerating(false);
    }
  };

  // Group by date, then by property
  const grouped = {};
  for (const item of filteredSchedule) {
    const dateKey = item.scheduled_date;
    if (!grouped[dateKey]) grouped[dateKey] = {};
    const propKey = item.property_name;
    if (!grouped[dateKey][propKey]) grouped[dateKey][propKey] = [];
    grouped[dateKey][propKey].push(item);
  }

  const sortedDates = Object.keys(grouped).sort();

  // Get all Mondays in the selected month
  const monthStart = selectedMonth.startOf('month');
  const monthEnd = selectedMonth.endOf('month');
  const mondays = [];
  let cursor = monthStart.startOf('week').add(1, 'day'); // First Monday
  if (cursor.isAfter(monthStart)) {
    cursor = cursor.subtract(7, 'day');
  }
  while (cursor.isBefore(monthEnd) || cursor.isSame(monthEnd, 'day')) {
    if (cursor.month() === selectedMonth.month() || cursor.add(6, 'day').month() === selectedMonth.month()) {
      mondays.push(cursor.format('YYYY-MM-DD'));
    }
    cursor = cursor.add(7, 'day');
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Space>
          <Text strong>Month:</Text>
          <DatePicker
            value={selectedMonth}
            onChange={d => {
              if (!d) return;
              // Find first Monday of that month
              let first = d.startOf('month');
              while (first.day() !== 1) first = first.add(1, 'day');
              setSelectedMonday(first.format('YYYY-MM-DD'));
            }}
            picker="month"
            size="small"
          />
        </Space>
        <Space>
          <Text>Cleaner:</Text>
          <Select
            value={selectedCleaner}
            onChange={v => setSelectedCleaner(v)}
            options={[
              { label: 'All Cleaners', value: null },
              ...cleaners.map(c => ({ label: c.name, value: c.id.toString() })),
            ]}
            placeholder="All Cleaners"
            allowClear
            onClear={() => setSelectedCleaner(null)}
            style={{ width: 150 }}
            size="small"
          />
          <Text>Week of:</Text>
          <Select
            value={selectedMonday}
            onChange={v => setSelectedMonday(v)}
            options={mondays.map(m => ({ label: `Wk ${dayjs(m).isoWeek()} — ${dayjs(m).format('MMM D')}`, value: m }))}
            style={{ width: 180 }}
            size="small"
          />
          <Button type="primary" icon={<ThunderboltOutlined />} onClick={handleGenerate} loading={generating}>
            Generate
          </Button>
        </Space>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 40 }}>Loading...</div>
      ) : filteredSchedule.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#999' }}>
          No schedule generated for this week. Click Generate to create one.
        </div>
      ) : (
        <div>
          {sortedDates.map(date => {
            const dayLabel = dayjs(date).format('ddd');
            const dateLabel = dayjs(date).format('M/D/YYYY');
            const props = grouped[date];
            return (
              <div key={date} style={{ marginBottom: 8, display: 'flex', borderBottom: '1px solid #f0f0f0', padding: '8px 0' }}>
                <div style={{ width: 40, fontWeight: 'bold', color: '#666' }}>{dayLabel}</div>
                <div style={{ width: 90, color: '#999' }}>{dateLabel}</div>
                <div style={{ flex: 1 }}>
                  {Object.entries(props).map(([propName, units]) => {
                    const unitLabels = units.map(u => {
                      const isCheckout = Number(u.type) === 1;
                      return isCheckout ? `${u.unit_name} (退房清家)` : u.unit_name;
                    });
                    const cleanerName = units[0]?.cleaner_name;
                    return (
                      <span key={propName} style={{ marginRight: 16 }}>
                        <Text strong>{propName}</Text>{' '}
                        <Text>{unitLabels.join(', ')}</Text>
                        {cleanerName && <Text type="secondary" style={{ marginLeft: 6 }}>({cleanerName})</Text>}
                        <Text style={{ marginLeft: 4 }}>; </Text>
                      </span>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {/* Notes section at bottom */}
          {(() => {
            // Override notes (one-off weekly notes per unit)
            const overrideNotes = filteredSchedule.filter(s => s.notes).map(s => ({
              unit_name: s.unit_name,
              cleaner_name: s.cleaner_name,
              notes: s.notes,
              property_name: s.property_name,
            }));
            // Tenant cleaning notes (persistent from tenant profile)
            const seen = new Set();
            const cleaningNotes = filteredSchedule.filter(s => {
              if (!s.cleaning_notes) return false;
              const key = s.unit_id?.toString();
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            }).map(s => ({
              unit_name: s.unit_name,
              property_name: s.property_name,
              cleaning_notes: s.cleaning_notes,
            }));
            // Property-level notes
            const propNotes = weekNotes.filter(n => n.notes);

            if (overrideNotes.length === 0 && cleaningNotes.length === 0 && propNotes.length === 0) return null;

            return (
              <div style={{ marginTop: 16, padding: 12, background: '#fffbe6', border: '1px solid #ffe58f', borderRadius: 4 }}>
                <Text strong style={{ display: 'block', marginBottom: 8 }}>Special Notes</Text>
                {propNotes.map((n, i) => {
                  const propItem = filteredSchedule.find(s => s.property_id?.toString() === n.property_id?.toString());
                  const propName = propItem?.property_name || 'Property';
                  return (
                    <div key={`prop-${i}`} style={{ marginBottom: 4 }}>
                      <Text strong>{propName}:</Text> <Text>{n.notes}</Text>
                    </div>
                  );
                })}
                {overrideNotes.map((n, i) => (
                  <div key={`override-${i}`} style={{ marginBottom: 4 }}>
                    <Text strong>{n.property_name} - {n.unit_name}</Text>
                    {n.cleaner_name && <Text type="secondary"> ({n.cleaner_name})</Text>}
                    <Text>: {n.notes}</Text>
                  </div>
                ))}
                {cleaningNotes.length > 0 && (
                  <>
                    <Text strong style={{ display: 'block', marginTop: 8, marginBottom: 4 }}>Cleaning Notes</Text>
                    {cleaningNotes.map((n, i) => (
                      <div key={`clean-${i}`} style={{ marginBottom: 4 }}>
                        <Text strong>{n.property_name} - {n.unit_name}</Text>
                        <Text>: {n.cleaning_notes}</Text>
                      </div>
                    ))}
                  </>
                )}
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}

// ─── TAB 4: Settings (Cleaners) ──────────────────────────────────────────────

function CleanerSettingsTab() {
  const [cleaners, setCleaners] = useState([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingCleaner, setEditingCleaner] = useState(null);
  const [form] = Form.useForm();

  const loadCleaners = useCallback(async () => {
    setLoading(true);
    try {
      const res = await cleaning.getCleaners();
      setCleaners(res.data?.data || []);
    } catch (err) {
      message.error('Failed to load cleaners');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadCleaners(); }, [loadCleaners]);

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      if (editingCleaner) {
        await cleaning.updateCleaner(editingCleaner.id, { name: values.name, status: 1 });
        message.success('Cleaner updated');
      } else {
        await cleaning.createCleaner({ name: values.name });
        message.success('Cleaner created');
      }
      setModalOpen(false);
      form.resetFields();
      setEditingCleaner(null);
      loadCleaners();
    } catch (err) {
      if (err.errorFields) return; // validation error
      message.error('Failed to save cleaner');
    }
  };

  const handleDelete = async (id) => {
    try {
      await cleaning.deleteCleaner(id);
      message.success('Cleaner deleted');
      loadCleaners();
    } catch (err) {
      message.error(err.response?.data?.message || 'Failed to delete cleaner');
    }
  };

  const columns = [
    {
      title: 'Name',
      dataIndex: 'name',
      width: 300,
    },
    {
      title: 'Status',
      dataIndex: 'status',
      width: 100,
      render: v => Number(v) === 1 ? <Tag color="green">Active</Tag> : <Tag color="red">Inactive</Tag>,
    },
    {
      title: 'Actions',
      width: 150,
      render: (_, record) => (
        <Space>
          <Button
            type="link"
            size="small"
            icon={<EditOutlined />}
            onClick={() => {
              setEditingCleaner(record);
              form.setFieldsValue({ name: record.name });
              setModalOpen(true);
            }}
          >
            Edit
          </Button>
          <Popconfirm
            title="Delete this cleaner?"
            onConfirm={() => handleDelete(record.id)}
            okText="Yes"
            cancelText="No"
          >
            <Button type="link" size="small" danger icon={<DeleteOutlined />}>
              Delete
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => {
            setEditingCleaner(null);
            form.resetFields();
            setModalOpen(true);
          }}
        >
          Add Cleaner
        </Button>
      </div>
      <Table
        dataSource={cleaners}
        columns={columns}
        rowKey="id"
        loading={loading}
        size="small"
        pagination={false}
      />
      <Modal
        title={editingCleaner ? 'Edit Cleaner' : 'Add Cleaner'}
        open={modalOpen}
        onOk={handleSave}
        onCancel={() => { setModalOpen(false); setEditingCleaner(null); form.resetFields(); }}
        okText="Save"
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="Cleaner Name" rules={[{ required: true, message: 'Name is required' }]}>
            <Input placeholder="Enter cleaner name" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

// ─── TAB: Checkout Notes ─────────────────────────────────────────────────────

function CheckoutNotesTab() {
  const [data, setData] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [propertyFilter, setPropertyFilter] = useState(null);
  const [notesLocal, setNotesLocal] = useState({});

  // Default to current week's Monday
  const [selectedWeek, setSelectedWeek] = useState(() => {
    const today = dayjs();
    const dow = today.day(); // 0=Sun
    const daysSinceMon = dow === 0 ? 6 : (dow - 1);
    return today.subtract(daysSinceMon, 'day').format('YYYY-MM-DD');
  });

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await cleaning.getCheckoutNotes(selectedWeek);
      if (res.data.code === 200) setData(res.data.data || []);
    } catch (err) { console.error('Load checkout notes error:', err); }
    finally { setLoading(false); }
  }, [selectedWeek]);

  const loadUsers = async () => {
    try {
      const res = await user.listUsers({ status: 1 }, { page: 1, limit: 200 });
      if (res.data.code === 200) setUsers(res.data.data.content || []);
    } catch (err) { console.error('Load users error:', err); }
  };

  useEffect(() => { loadData(); setNotesLocal({}); }, [loadData]);
  useEffect(() => { loadUsers(); }, []);

  const handleUpdate = async (id, field, value) => {
    try {
      await cleaning.updateCheckoutNotes(id, { [field]: value });
    } catch (err) {
      message.error('Failed to save');
    }
  };

  const handleSaveNotes = async () => {
    const entries = Object.entries(notesLocal);
    if (entries.length === 0) { message.info('No notes to save'); return; }
    setSaving(true);
    try {
      for (const [id, notes] of entries) {
        await cleaning.updateCheckoutNotes(id, { notes });
      }
      message.success('Notes saved');
      setNotesLocal({});
      loadData();
    } catch (err) {
      message.error('Failed to save notes');
    } finally { setSaving(false); }
  };

  const filteredData = propertyFilter
    ? data.filter(r => r.property_name === propertyFilter)
    : data;

  const propertyOptions = [...new Set(data.map(r => r.property_name))].sort();

  const weekLabel = dayjs(selectedWeek).isValid()
    ? `Wk ${dayjs(selectedWeek).isoWeek()} — ${dayjs(selectedWeek).format('MMM D')}`
    : '';

  const columns = [
    {
      title: 'Property', dataIndex: 'property_name', width: 140,
      filters: propertyOptions.map(p => ({ text: p, value: p })),
      onFilter: (value, record) => record.property_name === value,
    },
    { title: 'Unit', dataIndex: 'unit_name', width: 90 },
    {
      title: 'Lease End', dataIndex: 'lease_end', width: 110,
      render: v => v ? dayjs(v).format('MMM D') : '-',
      sorter: (a, b) => dayjs(a.lease_end).unix() - dayjs(b.lease_end).unix(),
    },
    {
      title: 'Check Out', dataIndex: 'checkout_date', width: 110,
      render: v => v ? dayjs(v).format('MMM D') : '-',
    },
    {
      title: 'Next Check-In', dataIndex: 'next_checkin', width: 110,
      render: v => v ? dayjs(v).format('MMM D') : '-',
    },
    { title: 'Old Code', dataIndex: 'old_code', width: 140, render: v => v || '-' },
    { title: 'New Code', dataIndex: 'new_code', width: 140, render: v => v || '-' },
    {
      title: 'Assigned To', dataIndex: 'assigned_user_id', width: 160,
      render: (val, record) => (
        <Select
          size="small"
          style={{ width: '100%' }}
          value={val || undefined}
          placeholder="Select user"
          allowClear
          showSearch
          optionFilterProp="label"
          options={users.map(u => ({
            label: [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username,
            value: Number(u.id),
          }))}
          onChange={v => {
            setData(prev => prev.map(r => r.id === record.id ? { ...r, assigned_user_id: v || null } : r));
            handleUpdate(record.id, 'assigned_user_id', v || null);
          }}
        />
      ),
    },
    {
      title: 'Notes', dataIndex: 'notes', width: 220,
      render: (val, record) => (
        <Input
          size="small"
          value={notesLocal[record.id] !== undefined ? notesLocal[record.id] : (val || '')}
          onChange={e => setNotesLocal(prev => ({ ...prev, [record.id]: e.target.value }))}
          placeholder="Add notes..."
        />
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
        <Space>
          <Text>Checkout Week:</Text>
          <DatePicker
            value={dayjs(selectedWeek)}
            onChange={d => d && setSelectedWeek(d.startOf('week').add(1, 'day').format('YYYY-MM-DD'))}
            picker="week"
            size="small"
          />
          <Tag color="blue">{weekLabel}</Tag>
        </Space>
        <Space>
          <Text>Property:</Text>
          <Select
            size="small"
            style={{ width: 180 }}
            value={propertyFilter}
            onChange={v => setPropertyFilter(v)}
            allowClear
            placeholder="All Properties"
            options={propertyOptions.map(p => ({ label: p, value: p }))}
          />
        </Space>
      </div>
      <Table
        dataSource={filteredData}
        columns={columns}
        rowKey="id"
        size="small"
        loading={loading}
        pagination={false}
        scroll={{ x: 1200 }}
        locale={{ emptyText: 'No checkouts this week' }}
      />
      {filteredData.length > 0 && (
        <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end' }}>
          <Button
            type="primary"
            icon={<SaveOutlined />}
            onClick={handleSaveNotes}
            loading={saving}
            disabled={Object.keys(notesLocal).length === 0}
          >
            Save Notes
          </Button>
        </div>
      )}
    </div>
  );
}
