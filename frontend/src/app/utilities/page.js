'use client';

import { Suspense, useEffect, useState, useCallback } from 'react';
import { Tabs, Table, Button, Select, Input, InputNumber, Modal, Form, Row, Col, Tag, Space, DatePicker, message, Popconfirm, Card, Typography, Descriptions, Checkbox } from 'antd';
import { PlusOutlined, DeleteOutlined, SaveOutlined, ThunderboltOutlined, CheckCircleOutlined, FileTextOutlined, HistoryOutlined, EditOutlined, WarningOutlined } from '@ant-design/icons';
import MainLayout, { useAuth } from '../../components/Layout';
import { utility, property } from '../../lib/api';
import useIsMobile from '../../hooks/useIsMobile';
import MobileCardList from '../../components/mobile/MobileCardList';
import TypedDeleteModal from '../../components/TypedDeleteModal';
import dayjs from 'dayjs';

const { Title, Text } = Typography;

const METER_TYPE_LABELS = { 0: 'Electric', 1: 'Water', 2: 'Gas' };
const METER_TYPE_OPTIONS = [
  { label: 'Electric', value: 0 },
  { label: 'Water', value: 1 },
  { label: 'Gas', value: 2 },
];
const METER_CATEGORY_LABELS = { 0: 'Master', 1: 'Sub-meter' };
const METER_CATEGORY_OPTIONS = [
  { label: 'Master Meter', value: 0 },
  { label: 'Tenant Sub-meter', value: 1 },
];
const READING_TYPE_LABELS = { 0: 'Move-In', 1: 'Move-Out', 2: 'Billing', 3: 'Monthly', 4: 'Correction' };
const READING_TYPE_OPTIONS = [
  { label: 'Monthly', value: 3 },
  { label: 'Move-In', value: 0 },
  { label: 'Move-Out', value: 1 },
];

export default function UtilitiesPageWrapper() {
  return <Suspense fallback={<div />}><UtilitiesPage /></Suspense>;
}

function UtilitiesPage() {
  const [activeTab, setActiveTab] = useState('report');
  const [refreshKey, setRefreshKey] = useState(0);

  const handleTabChange = (key) => {
    setActiveTab(key);
    setRefreshKey(prev => prev + 1);
  };

  const items = [
    { key: 'report', label: 'Report', children: <ReportTab key={`report-${refreshKey}`} /> },
    { key: 'billing', label: 'Billing', children: <BillingTab key={`billing-${refreshKey}`} /> },
    { key: 'groups', label: 'Groups', children: <GroupsTab key={`groups-${refreshKey}`} /> },
    { key: 'meters', label: 'Meters', children: <MetersTab key={`meters-${refreshKey}`} /> },
    { key: 'settings', label: 'Settings', children: <SettingsTab key={`settings-${refreshKey}`} /> },
  ];

  return (
    <MainLayout>
      <div style={{ marginBottom: 16 }}>
        <Title level={4} style={{ margin: 0 }}>Utilities</Title>
      </div>
      <Tabs activeKey={activeTab} onChange={handleTabChange} items={items} />
    </MainLayout>
  );
}

// ─── REPORT TAB ─────────────────────────────────────────────

function ReportTab() {
  const [reportData, setReportData] = useState([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const { isMobile } = useIsMobile();

  const loadReport = useCallback(async () => {
    setLoading(true);
    try {
      const res = await utility.getReport();
      setReportData(res.data?.data || []);
    } catch (err) {
      message.error('Failed to load report');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadReport(); }, [loadReport]);

  if (loading) return <div style={{ textAlign: 'center', padding: 60, color: '#999' }}>Loading report...</div>;
  if (reportData.length === 0) return <div style={{ textAlign: 'center', padding: 60, color: '#999' }}>No finalized bills yet</div>;

  const INVOICE_STATUS = { 0: { color: 'blue', text: 'Open' }, 1: { color: 'green', text: 'Paid' }, 2: { color: 'red', text: 'Overdue' } };

  const q = search.toLowerCase();
  const filteredReport = q ? reportData.map(group => {
    const groupMatch = (group.group_name || '').toLowerCase().includes(q);
    const filteredUnits = (group.units || []).filter(u =>
      (u.unit_name || '').toLowerCase().includes(q) ||
      (u.tenant_name || '').toLowerCase().includes(q)
    );
    if (groupMatch) return group;
    if (filteredUnits.length > 0) return { ...group, units: filteredUnits };
    return null;
  }).filter(Boolean) : reportData;

  // Mobile: render each unit as a card with per-bill data stacked
  const renderMobileReport = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {filteredReport.map(group => {
        const bills = group.bills || [];
        const units = group.units || [];
        return (
          <div key={group.group_id}>
            <div style={{ background: '#f5f5f5', padding: '8px 12px', border: '1px solid #d9d9d9', fontWeight: 600, fontSize: 15, marginBottom: 8, borderRadius: 4 }}>
              {group.group_name}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {units.map((unit, idx) => (
                <Card key={idx} size="small" style={{ borderRadius: 8 }} bodyStyle={{ padding: '10px 14px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                    <Text strong>{unit.unit_name}</Text>
                    {unit.tenant_name ? (
                      <Text style={{ fontSize: 13 }}>{unit.tenant_name}</Text>
                    ) : (
                      <Text type="secondary" style={{ fontStyle: 'italic', fontSize: 13 }}>Vacant</Text>
                    )}
                  </div>
                  {bills.map(b => {
                    const m = unit.months[b.id.toString()];
                    if (!m) return null;
                    const s = m.invoice_status !== null ? INVOICE_STATUS[m.invoice_status] || INVOICE_STATUS[0] : null;
                    return (
                      <div key={b.id} style={{ background: '#fafafa', borderRadius: 4, padding: '6px 10px', marginBottom: 4, fontSize: 12 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                          <Text strong style={{ fontSize: 12 }}>{dayjs(b.period_start).format('MMM YYYY')}</Text>
                          {s && <Tag color={s.color} style={{ fontSize: 10, padding: '0 4px', margin: 0 }}>{s.text}</Tag>}
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, color: '#666' }}>
                          <span>Meter: {m.meter_reading.toLocaleString()}</span>
                          <span>kWh: {m.kw_used.toLocaleString()}</span>
                          <span>Gross: ${m.gross_amount.toFixed(2)}</span>
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, color: '#666' }}>
                          {Number(m.utility_credit) > 0 && <span>Credit: ${m.utility_credit.toFixed(0)}</span>}
                          <span style={{ fontWeight: m.fees_due > 0 ? 600 : 400, color: m.fees_due > 0 ? '#cf1322' : '#52c41a' }}>
                            Due: ${m.fees_due.toFixed(2)}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </Card>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <Input.Search placeholder="Search by group, unit, or tenant..." value={search} onChange={e => setSearch(e.target.value)} allowClear style={{ width: isMobile ? '100%' : 350 }} />
      </div>
      {isMobile ? renderMobileReport() : (
        <>
          {filteredReport.map(group => {
            const bills = group.bills || [];
            const units = group.units || [];

            return (
              <div key={group.group_id} style={{ marginBottom: 32 }}>
                {/* Group header */}
                <div style={{ background: '#f5f5f5', padding: '8px 12px', border: '1px solid #d9d9d9', marginBottom: 0, fontWeight: 600, fontSize: 16 }}>
                  {group.group_name}
                </div>

                {/* Bill header row */}
                <div style={{ display: 'flex', borderBottom: '2px solid #d9d9d9' }}>
                  <div style={{ width: 280, minWidth: 280, padding: '6px 12px', fontWeight: 600, borderRight: '1px solid #d9d9d9' }}>
                    <Row>
                      <Col span={8}><Text strong style={{ fontSize: 11 }}>Unit</Text></Col>
                      <Col span={8}><Text strong style={{ fontSize: 11 }}>Tenant</Text></Col>
                      <Col span={8}>
                        <div style={{ background: '#fa8c16', padding: '2px 4px', color: '#fff', fontSize: 10, textAlign: 'center' }}>
                          <div>Bill Amount</div>
                          <div>KWH Used</div>
                          <div>$/kW</div>
                        </div>
                      </Col>
                    </Row>
                  </div>
                  {bills.map(b => (
                    <div key={b.id} style={{ flex: 1, padding: '4px 8px', borderRight: '1px solid #f0f0f0', textAlign: 'center', fontSize: 11, background: '#fafafa' }}>
                      <div style={{ fontWeight: 600 }}>{dayjs(b.period_start).format('MMM YYYY')}</div>
                      <div style={{ fontSize: 10, color: '#888' }}>{dayjs(b.period_start).format('MMM D')} - {dayjs(b.period_end).format('MMM D')}</div>
                      <div style={{ marginTop: 2, fontSize: 10, color: '#666' }}>
                        ${b.total_amount.toFixed(0)} | {b.total_kw.toLocaleString()} kW | ${b.rate_per_kw.toFixed(2)}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Unit rows */}
                {units.map((unit, idx) => (
                  <div key={idx} style={{ display: 'flex', borderBottom: '1px dashed #e8e8e8' }}>
                    <div style={{ width: 280, minWidth: 280, padding: '6px 12px', borderRight: '1px solid #d9d9d9' }}>
                      <Row>
                        <Col span={8}><Text strong style={{ fontSize: 12 }}>{unit.unit_name}</Text></Col>
                        <Col span={8}><Text style={{ fontSize: 11 }}>{unit.tenant_name || <span style={{ color: '#bbb', fontStyle: 'italic' }}>Vacant</span>}</Text></Col>
                        <Col span={8}>
                          <div style={{ background: '#52c41a', padding: '2px 4px', color: '#fff', fontSize: 9, textAlign: 'center' }}>
                            <div>Meter</div>
                            <div>KWH</div>
                            <div>Credit</div>
                            <div>Gross</div>
                            <div>Fees Due</div>
                            <div>Status</div>
                          </div>
                        </Col>
                      </Row>
                    </div>
                    {bills.map(b => {
                      const m = unit.months[b.id.toString()];
                      if (!m) {
                        return <div key={b.id} style={{ flex: 1, padding: '4px 8px', borderRight: '1px solid #f0f0f0', textAlign: 'center', fontSize: 11, color: '#ddd' }}>-</div>;
                      }
                      const s = m.invoice_status !== null ? INVOICE_STATUS[m.invoice_status] || INVOICE_STATUS[0] : null;
                      return (
                        <div key={b.id} style={{ flex: 1, padding: '4px 8px', borderRight: '1px solid #f0f0f0', textAlign: 'center', fontSize: 11 }}>
                          <div>{m.meter_reading.toLocaleString()}</div>
                          <div>{m.kw_used.toLocaleString()}</div>
                          <div>${m.utility_credit.toFixed(0)}</div>
                          <div>${m.gross_amount.toFixed(2)}</div>
                          <div style={{ fontWeight: m.fees_due > 0 ? 600 : 400, color: m.fees_due > 0 ? '#cf1322' : '#52c41a' }}>
                            ${m.fees_due.toFixed(2)}
                          </div>
                          <div>
                            {s ? <Tag color={s.color} style={{ fontSize: 10, padding: '0 4px', margin: 0 }}>{s.text}</Tag> : <Text type="secondary" style={{ fontSize: 10 }}>-</Text>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

// ─── GROUPS TAB ──────────────────────────────────────────────

function GroupsTab() {
  const [groups, setGroups] = useState([]);
  const [properties, setProperties] = useState([]);
  const [assignments, setAssignments] = useState({}); // { unitId: groupId }
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [search, setSearch] = useState('');
  const { isMobile } = useIsMobile();

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [gRes, pRes, ugRes] = await Promise.all([
        utility.getGroups(),
        utility.getPropertiesUnits(),
        utility.getUnitGroups(),
      ]);
      const grps = gRes.data?.data || [];
      const props = pRes.data?.data || [];
      const unitGroups = ugRes.data?.data || [];
      setGroups(grps);
      setProperties(props);

      // Build initial assignments from unit_id → group_id
      const initial = {};
      unitGroups.forEach(ug => {
        initial[ug.unit_id.toString()] = ug.group_id.toString();
      });
      setAssignments(initial);
      setDirty(false);
    } catch (err) {
      message.error('Failed to load data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const handleChange = (unitId, groupId) => {
    setAssignments(prev => {
      const next = { ...prev };
      if (groupId) {
        next[unitId.toString()] = groupId.toString();
      } else {
        delete next[unitId.toString()];
      }
      return next;
    });
    setDirty(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const arr = Object.entries(assignments).map(([unit_id, group_id]) => ({ unit_id, group_id }));
      await utility.assignUnitGroups({ assignments: arr });
      message.success('Group assignments saved');
      setDirty(false);
      loadData();
    } catch (err) {
      message.error(err.response?.data?.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  // Flatten properties into rows: one header row per property, then unit rows
  const tableData = [];
  properties.forEach(p => {
    const units = p.units || [];
    tableData.push({ _type: 'property', id: `prop-${p.id}`, display_name: p.display_name, unit_count: units.length });
    units.forEach(u => {
      tableData.push({ _type: 'unit', id: u.id, unit_id: u.id, unit_name: u.name, tenant_name: u.tenant_name, property_id: p.id, property_name: p.display_name });
    });
  });

  const columns = [
    {
      title: 'Property / Unit', key: 'name',
      render: (_, row) => {
        if (row._type === 'property') {
          return <Text strong>{row.display_name}</Text>;
        }
        return <Text style={{ paddingLeft: 24 }}>{row.unit_name}</Text>;
      }
    },
    {
      title: 'Tenant', key: 'tenant', width: 200,
      render: (_, row) => {
        if (row._type === 'property') return <Text type="secondary">{row.unit_count} units</Text>;
        return row.tenant_name ? <Text>{row.tenant_name}</Text> : <Text type="secondary" style={{ fontStyle: 'italic' }}>Vacant</Text>;
      }
    },
    {
      title: 'Billing Group', key: 'group', width: 300,
      render: (_, row) => {
        if (row._type !== 'unit') return null;
        return (
          <Select
            style={{ width: '100%' }}
            placeholder="Select group"
            value={assignments[row.unit_id.toString()] || undefined}
            onChange={v => handleChange(row.unit_id, v)}
            allowClear
            options={groups.map(g => ({ label: g.name, value: g.id.toString() }))}
          />
        );
      }
    },
  ];

  const gq = search.toLowerCase();
  const filteredTableData = gq ? tableData.filter(row => {
    if (row._type === 'property') {
      // Keep property header if it or any of its units match
      const propUnits = tableData.filter(r => r._type === 'unit' && r.property_id === row.id?.replace?.('prop-', ''));
      return (row.display_name || '').toLowerCase().includes(gq) ||
        propUnits.some(u => (u.unit_name || '').toLowerCase().includes(gq) || (u.tenant_name || '').toLowerCase().includes(gq));
    }
    return (row.unit_name || '').toLowerCase().includes(gq) ||
      (row.tenant_name || '').toLowerCase().includes(gq) ||
      (row.property_name || '').toLowerCase().includes(gq);
  }) : tableData;

  const renderGroupAssignmentCard = (record) => {
    if (record._type === 'property') {
      return (
        <Card size="small" style={{ borderRadius: 8, background: '#fafafa' }} bodyStyle={{ padding: '10px 16px' }}>
          <Text strong style={{ fontSize: 14 }}>{record.display_name}</Text>
          <Text type="secondary" style={{ marginLeft: 8 }}>{record.unit_count} units</Text>
        </Card>
      );
    }
    return (
      <Card size="small" style={{ borderRadius: 8, marginLeft: 8 }} bodyStyle={{ padding: '10px 16px' }}>
        <div style={{ marginBottom: 6 }}>
          <Text strong>{record.unit_name}</Text>
          {record.tenant_name ? (
            <Text style={{ marginLeft: 8, fontSize: 13 }}>{record.tenant_name}</Text>
          ) : (
            <Text type="secondary" style={{ fontStyle: 'italic', marginLeft: 8, fontSize: 13 }}>Vacant</Text>
          )}
        </div>
        <Select
          style={{ width: '100%' }}
          placeholder="Select group"
          value={assignments[record.unit_id.toString()] || undefined}
          onChange={v => handleChange(record.unit_id, v)}
          allowClear
          options={groups.map(g => ({ label: g.name, value: g.id.toString() }))}
        />
      </Card>
    );
  };

  return (
    <div>
      <div style={isMobile
        ? { marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 8 }
        : { marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }
      }>
        {isMobile ? (
          <>
            <Text strong>Assign units to billing groups</Text>
            <Input.Search placeholder="Search property, unit, tenant..." value={search} onChange={e => setSearch(e.target.value)} allowClear style={{ width: '100%' }} />
            <Button type="primary" icon={<SaveOutlined />} onClick={handleSave} loading={saving} disabled={!dirty} block>
              Save
            </Button>
          </>
        ) : (
          <>
            <Space>
              <Text strong>Assign units to billing groups</Text>
              <Input.Search placeholder="Search property, unit, tenant..." value={search} onChange={e => setSearch(e.target.value)} allowClear style={{ width: 300 }} />
            </Space>
            <Button type="primary" icon={<SaveOutlined />} onClick={handleSave} loading={saving} disabled={!dirty}>
              Save
            </Button>
          </>
        )}
      </div>
      {isMobile ? (
        <MobileCardList
          dataSource={filteredTableData}
          renderCard={renderGroupAssignmentCard}
          loading={loading}
          rowKey="id"
          emptyText="No units found"
        />
      ) : (
        <Table
          dataSource={filteredTableData}
          columns={columns}
          rowKey="id"
          size="small"
          loading={loading}
          pagination={false}
          rowClassName={(row) => row._type === 'property' ? 'utility-property-row' : ''}
        />
      )}
      <style>{`.utility-property-row td { background: #fafafa !important; }`}</style>
    </div>
  );
}

// ─── SETTINGS TAB ────────────────────────────────────────────

function SettingsTab() {
  const { hasPermission } = useAuth();
  const canDeleteMeter = hasPermission ? hasPermission('LANDLORD/UTILITY_METER_DELETE') : false;
  const canDeleteGroup = hasPermission ? hasPermission('LANDLORD/UTILITY_GROUP_DELETE') : false;
  const [groups, setGroups] = useState([]);
  const [properties, setProperties] = useState([]);
  const [units, setUnits] = useState([]);
  const [loading, setLoading] = useState(false);
  const [groupModal, setGroupModal] = useState(false);
  const [meterModal, setMeterModal] = useState(false);
  const [editingMeter, setEditingMeter] = useState(null); // null = adding new
  const [deletingMeter, setDeletingMeter] = useState(null); // row pending typed-confirm delete
  const [deletingGroup, setDeletingGroup] = useState(null); // group pending typed-confirm delete
  const [editingGroup, setEditingGroup] = useState(null);
  const [selectedGroupForMeter, setSelectedGroupForMeter] = useState(null);
  const [meters, setMeters] = useState([]);
  const [meterCategoryValue, setMeterCategoryValue] = useState(1);
  const [groupForm] = Form.useForm();
  const [meterForm] = Form.useForm();

  const [unitGroupMap, setUnitGroupMap] = useState({}); // unitId → groupId
  const [settingsSearch, setSettingsSearch] = useState('');
  const { isMobile } = useIsMobile();

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [gRes, pRes, ugRes] = await Promise.all([
        utility.getGroups(),
        property.getAllWithUnits(),
        utility.getUnitGroups(),
      ]);
      setGroups(gRes.data?.data || []);
      const props = pRes.data?.data || [];
      setProperties(props);
      const allUnits = [];
      props.forEach(p => {
        (p.units || []).forEach(u => {
          allUnits.push({ ...u, property_name: p.display_name, property_id: p.id });
        });
      });
      setUnits(allUnits);

      // Build unit → group map
      const ugMap = {};
      (ugRes.data?.data || []).forEach(ug => {
        ugMap[ug.unit_id.toString()] = ug.group_id.toString();
      });
      setUnitGroupMap(ugMap);
    } catch (err) {
      message.error('Failed to load data');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadMeters = useCallback(async (groupId) => {
    try {
      const res = await utility.getMeters({ group_id: groupId });
      setMeters(res.data?.data || []);
    } catch (err) {
      message.error('Failed to load meters');
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const handleSaveGroup = async () => {
    try {
      const values = await groupForm.validateFields();
      if (editingGroup) {
        await utility.updateGroup(editingGroup.id, { name: values.name });
        message.success('Group updated');
      } else {
        await utility.createGroup({ name: values.name });
        message.success('Group created');
      }
      setGroupModal(false);
      groupForm.resetFields();
      setEditingGroup(null);
      loadData();
    } catch (err) {
      if (err.response?.data?.message) message.error(err.response.data.message);
    }
  };

  const handleDeleteGroup = async () => {
    if (!deletingGroup) return;
    try {
      await utility.deleteGroup(deletingGroup.id);
      message.success('Group deleted');
      setDeletingGroup(null);
      loadData();
      if (selectedGroupForMeter === deletingGroup.id) {
        setSelectedGroupForMeter(null);
        setMeters([]);
      }
    } catch (err) {
      message.error(err.response?.data?.message || 'Failed to delete');
    }
  };

  const handleSaveMeter = async () => {
    try {
      const values = await meterForm.validateFields();
      if (editingMeter) {
        const r = await utility.updateMeter(editingMeter.id, values);
        const correction = r?.data?.data?.correction;
        // Name the correction. "Meter updated" was reported even when the reading
        // was silently discarded, which is how a no-op passed for a save.
        message.success(correction
          ? `Reading corrected from ${Number(correction.from).toLocaleString()} to ${Number(correction.to).toLocaleString()}, logged in the reading history.`
          : 'Meter updated');
      } else {
        await utility.createMeter({ ...values, group_id: selectedGroupForMeter });
        message.success('Meter added');
      }
      setMeterModal(false);
      setEditingMeter(null);
      meterForm.resetFields();
      loadMeters(selectedGroupForMeter);
      loadData();
    } catch (err) {
      if (err.response?.data?.message) message.error(err.response.data.message);
    }
  };

  const openEditMeter = (row) => {
    setEditingMeter(row);
    setMeterCategoryValue(Number(row.meter_category));
    meterForm.setFieldsValue({
      meter_category: Number(row.meter_category),
      meter_number: row.meter_number,
      meter_type: Number(row.meter_type),
      unit_id: row.unit_id ? String(row.unit_id) : null,
      current_reading: Number(row.last_reading ?? row.current_reading ?? 0),
    });
    setMeterModal(true);
  };

  const handleDeleteMeter = async () => {
    if (!deletingMeter) return;
    try {
      await utility.deleteMeter(deletingMeter.id);
      message.success('Meter deleted');
      setDeletingMeter(null);
      loadMeters(selectedGroupForMeter);
      loadData();
    } catch (err) {
      message.error(err.response?.data?.message || 'Failed to delete');
    }
  };

  const groupColumns = [
    { title: 'Group Name', dataIndex: 'name', key: 'name' },
    { title: 'Meters', dataIndex: 'meter_count', key: 'meter_count', width: 80 },
    {
      title: 'Actions', key: 'actions', width: 180,
      render: (_, row) => (
        <Space>
          <Button size="small" onClick={() => {
            setEditingGroup(row);
            groupForm.setFieldsValue({ name: row.name });
            setGroupModal(true);
          }}>Edit</Button>
          <Button size="small" onClick={() => {
            setSelectedGroupForMeter(row.id);
            loadMeters(row.id);
          }}>Meters</Button>
          {canDeleteGroup && (
            <Button size="small" danger icon={<DeleteOutlined />} onClick={() => setDeletingGroup(row)} />
          )}
        </Space>
      )
    }
  ];

  const meterColumns = [
    { title: 'Meter #', dataIndex: 'meter_number', key: 'meter_number' },
    { title: 'Category', key: 'meter_category', width: 100, render: (_, row) => Number(row.meter_category) === 0 ? <Tag color="gold">Master</Tag> : <Tag>Sub-meter</Tag> },
    { title: 'Type', dataIndex: 'meter_type', key: 'meter_type', render: v => METER_TYPE_LABELS[v] || 'Electric', width: 100 },
    { title: 'Unit', key: 'unit', render: (_, row) => Number(row.meter_category) === 0 ? <Tag color="blue">Master</Tag> : row.unit_name ? `${row.property_name} - ${row.unit_name}` : <Tag color="blue">Common Area</Tag> },
    { title: 'Last Reading', key: 'last_reading', width: 140, render: (_, row) => Number(row.last_reading ?? row.current_reading).toLocaleString() },
    {
      title: '', key: 'actions', width: 100,
      render: (_, row) => (
        <Space size="small">
          <Button size="small" icon={<EditOutlined />} onClick={() => openEditMeter(row)} />
          {canDeleteMeter && (
            <Button size="small" danger icon={<DeleteOutlined />} onClick={() => setDeletingMeter(row)} />
          )}
        </Space>
      )
    }
  ];

  const selectedGroup = groups.find(g => g.id === selectedGroupForMeter);

  const renderSettingsGroupCard = (record) => (
    <Card size="small" style={{ borderRadius: 8, background: record.id === selectedGroupForMeter ? '#e6f4ff' : undefined, cursor: 'pointer' }}
      bodyStyle={{ padding: '10px 16px' }}
      onClick={() => { setSelectedGroupForMeter(record.id); loadMeters(record.id); }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <Text strong>{record.name}</Text>
          <Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>{record.meter_count} meters</Text>
        </div>
        <Space size="small">
          <Button size="small" onClick={(e) => { e.stopPropagation(); setEditingGroup(record); groupForm.setFieldsValue({ name: record.name }); setGroupModal(true); }}>Edit</Button>
          {canDeleteGroup && (
            <Button size="small" danger icon={<DeleteOutlined />} onClick={(e) => { e.stopPropagation(); setDeletingGroup(record); }} />
          )}
        </Space>
      </div>
    </Card>
  );

  const renderSettingsMeterCard = (record) => {
    const isMaster = Number(record.meter_category) === 0;
    return (
      <Card size="small" style={{ borderRadius: 8 }} bodyStyle={{ padding: '10px 16px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <Text strong>{record.meter_number}</Text>
          {isMaster ? <Tag color="gold">Master</Tag> : <Tag>Sub-meter</Tag>}
        </div>
        <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>
          {METER_TYPE_LABELS[record.meter_type] || 'Electric'}
          {' | '}
          {isMaster ? <Tag color="blue" style={{ fontSize: 10 }}>Master</Tag> : (record.unit_name ? `${record.property_name} - ${record.unit_name}` : <Tag color="blue" style={{ fontSize: 10 }}>Common Area</Tag>)}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text type="secondary" style={{ fontSize: 12 }}>Last: {Number(record.last_reading ?? record.current_reading).toLocaleString()}</Text>
          <Space size="small">
            <Button size="small" icon={<EditOutlined />} onClick={() => openEditMeter(record)} />
            {canDeleteMeter && (
              <Button size="small" danger icon={<DeleteOutlined />} onClick={() => setDeletingMeter(record)} />
            )}
          </Space>
        </div>
      </Card>
    );
  };

  const filteredGroups = settingsSearch ? groups.filter(g => (g.name || '').toLowerCase().includes(settingsSearch.toLowerCase())) : groups;
  const filteredSettingsMeters = settingsSearch ? meters.filter(m => (m.meter_number || '').toLowerCase().includes(settingsSearch.toLowerCase()) || (m.unit_name || '').toLowerCase().includes(settingsSearch.toLowerCase())) : meters;

  return (
    <div>
      {isMobile ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Groups section */}
          <div>
            <div style={{ marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Text strong>Billing Groups</Text>
              <Input.Search placeholder="Search groups, meters..." value={settingsSearch} onChange={e => setSettingsSearch(e.target.value)} allowClear style={{ width: '100%' }} />
              <Button type="primary" icon={<PlusOutlined />} block onClick={() => {
                setEditingGroup(null);
                groupForm.resetFields();
                setGroupModal(true);
              }}>Add Group</Button>
            </div>
            <MobileCardList
              dataSource={filteredGroups}
              renderCard={renderSettingsGroupCard}
              loading={loading}
              rowKey="id"
              emptyText="No groups"
            />
          </div>

          {/* Meters for selected group */}
          {selectedGroupForMeter && (
            <div>
              <div style={{ marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <Text strong>Meters in: {selectedGroup?.name}</Text>
                <div style={{ display: 'flex', gap: 8 }}>
                  <Button type="primary" icon={<PlusOutlined />} style={{ flex: 1 }} onClick={() => {
                    setEditingMeter(null);
                    meterForm.resetFields();
                    setMeterCategoryValue(1);
                    setMeterModal(true);
                  }}>Add Meter</Button>
                  <Button style={{ flex: 1 }} onClick={() => { setSelectedGroupForMeter(null); setMeters([]); }}>Close</Button>
                </div>
              </div>
              <MobileCardList
                dataSource={filteredSettingsMeters}
                renderCard={renderSettingsMeterCard}
                rowKey="id"
                emptyText="No meters"
              />
            </div>
          )}
        </div>
      ) : (
        <Row gutter={24}>
          {/* Groups */}
          <Col span={selectedGroupForMeter ? 12 : 24}>
            <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Space>
                <Text strong>Billing Groups</Text>
                <Input.Search placeholder="Search groups, meters..." value={settingsSearch} onChange={e => setSettingsSearch(e.target.value)} allowClear style={{ width: 250 }} />
              </Space>
              <Button type="primary" icon={<PlusOutlined />} onClick={() => {
                setEditingGroup(null);
                groupForm.resetFields();
                setGroupModal(true);
              }}>Add Group</Button>
            </div>
            <Table
              dataSource={filteredGroups}
              columns={groupColumns}
              rowKey="id"
              size="small"
              loading={loading}
              pagination={false}
              onRow={(record) => ({
                style: { cursor: 'pointer', background: record.id === selectedGroupForMeter ? '#e6f4ff' : undefined },
              })}
            />
          </Col>

          {/* Meters for selected group */}
          {selectedGroupForMeter && (
            <Col span={12}>
              <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text strong>Meters in: {selectedGroup?.name}</Text>
                <Space>
                  <Button type="primary" icon={<PlusOutlined />} onClick={() => {
                    setEditingMeter(null);
                    meterForm.resetFields();
                    setMeterCategoryValue(1);
                    setMeterModal(true);
                  }}>Add Meter</Button>
                  <Button onClick={() => { setSelectedGroupForMeter(null); setMeters([]); }}>Close</Button>
                </Space>
              </div>
              <Table
                dataSource={filteredSettingsMeters}
                columns={meterColumns}
                rowKey="id"
                size="small"
                pagination={false}
              />
            </Col>
          )}
        </Row>
      )}

      {/* Group Modal */}
      <Modal
        title={editingGroup ? 'Edit Group' : 'New Billing Group'}
        open={groupModal}
        onOk={handleSaveGroup}
        onCancel={() => { setGroupModal(false); setEditingGroup(null); groupForm.resetFields(); }}
      >
        <Form form={groupForm} layout="vertical">
          <Form.Item name="name" label="Group Name" rules={[{ required: true, message: 'Name is required' }]}>
            <Input placeholder="e.g. Building A - Electric" />
          </Form.Item>
        </Form>
      </Modal>

      {/* Meter Modal */}
      <Modal
        title={editingMeter ? 'Edit Meter' : 'Add Meter'}
        open={meterModal}
        onOk={handleSaveMeter}
        okText={editingMeter ? 'Save' : 'Add'}
        onCancel={() => { setMeterModal(false); setEditingMeter(null); meterForm.resetFields(); setMeterCategoryValue(1); }}
      >
        <Form form={meterForm} layout="vertical">
          <Form.Item name="meter_category" label="Meter Category" initialValue={1}>
            <Select options={METER_CATEGORY_OPTIONS} onChange={v => setMeterCategoryValue(v)} />
          </Form.Item>
          <Form.Item name="meter_number" label="Meter Number" rules={[{ required: true, message: 'Meter number is required' }]}>
            <Input placeholder="e.g. MTR-001" />
          </Form.Item>
          <Form.Item name="meter_type" label="Meter Type" initialValue={0}>
            <Select options={METER_TYPE_OPTIONS} />
          </Form.Item>
          {meterCategoryValue === 1 && (
            <Form.Item name="unit_id" label="Unit (leave blank for common area)">
              <Select allowClear showSearch placeholder="Select unit" optionFilterProp="label"
                options={units
                  .filter(u => selectedGroupForMeter && unitGroupMap[u.id.toString()] === selectedGroupForMeter.toString())
                  .map(u => ({ label: `${u.property_name} - ${u.name}`, value: u.id }))}
              />
            </Form.Item>
          )}
          <Form.Item
            name="current_reading"
            label={editingMeter ? 'Meter Reading' : 'Initial Meter Reading'}
            initialValue={0}
            extra={editingMeter
              ? 'Changing this logs a dated correction in the reading history. Leave it alone if you only meant to edit the details above.'
              : undefined}
          >
            <InputNumber style={{ width: '100%' }} min={0} precision={2} />
          </Form.Item>
        </Form>
      </Modal>

      <TypedDeleteModal
        open={!!deletingMeter}
        onCancel={() => setDeletingMeter(null)}
        onConfirm={handleDeleteMeter}
        itemLabel={deletingMeter?.meter_number}
        itemType="meter"
        warning="All readings logged on this meter will be lost. This cannot be undone."
      />

      <TypedDeleteModal
        open={!!deletingGroup}
        onCancel={() => setDeletingGroup(null)}
        onConfirm={handleDeleteGroup}
        itemLabel={deletingGroup?.name}
        itemType="billing group"
        warning="The group will be deleted only if it has no meters or bills attached. Re-assign meters first if needed."
      />
    </div>
  );
}

// ─── METERS TAB ──────────────────────────────────────────────

function MetersTab() {
  const [meters, setMeters] = useState([]);
  const [groups, setGroups] = useState([]);
  const [filterGroup, setFilterGroup] = useState(null);
  const [loading, setLoading] = useState(false);
  const [readingModal, setReadingModal] = useState(false);
  const [historyModal, setHistoryModal] = useState(false);
  const [selectedMeter, setSelectedMeter] = useState(null);
  const [readings, setReadings] = useState([]);
  const [readingForm] = Form.useForm();
  const [search, setSearch] = useState('');
  const { isMobile } = useIsMobile();

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [mRes, gRes] = await Promise.all([
        utility.getMeters(filterGroup ? { group_id: filterGroup } : {}),
        utility.getGroups(),
      ]);
      setMeters(mRes.data?.data || []);
      setGroups(gRes.data?.data || []);
    } catch (err) {
      message.error('Failed to load meters');
    } finally {
      setLoading(false);
    }
  }, [filterGroup]);

  useEffect(() => { loadData(); }, [loadData]);

  const handleLogReading = async () => {
    try {
      const values = await readingForm.validateFields();
      const res = await utility.logMeterReading({
        meter_id: selectedMeter.id,
        reading_value: values.reading_value,
        reading_date: values.reading_date?.format('YYYY-MM-DD') || new Date().toISOString().split('T')[0],
        reading_type: values.reading_type,
        tenant_id: selectedMeter.tenant_id || null,
        notes: values.notes || null,
      });
      if (res.data?.data?.warning) {
        message.warning(res.data.data.warning);
      }
      // A back-dated entry is filed as history and does not become the meter's
      // current value. Saying so is the difference between a deliberate correction
      // and quietly rewinding the meter, which is what used to happen.
      if (res.data?.data?.meter_advanced === false) {
        message.warning('Logged as history. A newer reading already exists for this meter, so its current value is unchanged.', 8);
      } else {
        message.success('Reading logged');
      }
      setReadingModal(false);
      readingForm.resetFields();
      loadData();
    } catch (err) {
      if (err.response?.data?.message) message.error(err.response.data.message);
    }
  };

  const loadHistory = async (meter) => {
    setSelectedMeter(meter);
    setHistoryModal(true);
    try {
      const res = await utility.getMeterReadings({ meter_id: meter.id });
      setReadings(res.data?.data || []);
    } catch (err) {
      message.error('Failed to load readings');
    }
  };

  const columns = [
    { title: 'Meter #', dataIndex: 'meter_number', key: 'meter_number' },
    { title: 'Category', key: 'meter_category', width: 100, render: (_, row) => Number(row.meter_category) === 0 ? <Tag color="gold">Master</Tag> : <Tag>Sub-meter</Tag> },
    { title: 'Type', dataIndex: 'meter_type', key: 'meter_type', render: v => METER_TYPE_LABELS[v] || 'Electric', width: 90 },
    { title: 'Group', dataIndex: 'group_name', key: 'group_name' },
    {
      title: 'Unit', key: 'unit',
      render: (_, row) => Number(row.meter_category) === 0 ? <Tag color="blue">Master</Tag> : row.unit_name ? `${row.property_name || ''} - ${row.unit_name}` : <Tag color="blue">Common Area</Tag>
    },
    {
      title: 'Tenant', key: 'tenant', width: 200,
      render: (_, row) => {
        if (Number(row.meter_category) === 0) return null;
        const name = [row.tenant_first_name, row.tenant_last_name].filter(Boolean).join(' ');
        if (!name) return <Text type="secondary" style={{ fontStyle: 'italic' }}>Vacant</Text>;
        const isCurrent = Number(row.is_current_tenant) === 1;
        const checkoutDate = row.lease_end_date ? dayjs(row.lease_end_date).format('MMM D, YYYY') : null;
        return (
          <div>
            <div>{name} {!isCurrent && <Tag color="orange" style={{ fontSize: 10 }}>Past</Tag>}</div>
            {!isCurrent && checkoutDate && <div style={{ fontSize: 11, color: '#888' }}>Checkout: {checkoutDate}</div>}
          </div>
        );
      }
    },
    {
      title: 'Last Reading', key: 'last_reading', width: 120,
      render: (_, row) => Number(row.last_reading ?? row.current_reading).toLocaleString()
    },
    {
      title: 'Last Date', key: 'last_date', width: 100,
      render: (_, row) => row.last_reading_date ? dayjs(row.last_reading_date).format('MMM D, YYYY') : '-'
    },
    {
      title: 'Last Type', key: 'last_type', width: 90,
      render: (_, row) => row.last_reading_type != null ? <Tag>{READING_TYPE_LABELS[Number(row.last_reading_type)] || '-'}</Tag> : '-'
    },
    {
      title: 'Actions', key: 'actions', width: 160,
      render: (_, row) => (
        <Space>
          <Button size="small" icon={<EditOutlined />} onClick={() => {
            setSelectedMeter(row);
            readingForm.resetFields();
            readingForm.setFieldsValue({ reading_date: dayjs(), reading_type: 3 });
            setReadingModal(true);
          }}>Log</Button>
          <Button size="small" icon={<HistoryOutlined />} onClick={() => loadHistory(row)}>History</Button>
        </Space>
      )
    }
  ];

  const historyColumns = [
    { title: 'Date', dataIndex: 'reading_date', key: 'date', render: v => dayjs(v).format('MMM D, YYYY') },
    { title: 'Reading', dataIndex: 'reading_value', key: 'value', render: v => Number(v).toLocaleString() },
    { title: 'Type', dataIndex: 'reading_type', key: 'type', render: v => <Tag>{READING_TYPE_LABELS[Number(v)] || '-'}</Tag> },
    { title: 'Tenant', key: 'tenant', render: (_, row) => [row.tenant_first_name, row.tenant_last_name].filter(Boolean).join(' ') || '-' },
    { title: 'Notes', dataIndex: 'notes', key: 'notes', render: v => v || '-' },
  ];

  const lastReading = selectedMeter ? Number(selectedMeter.last_reading ?? selectedMeter.current_reading) : 0;

  const renderMeterCard = (record) => {
    const isMaster = Number(record.meter_category) === 0;
    const tenantName = [record.tenant_first_name, record.tenant_last_name].filter(Boolean).join(' ');
    const isCurrent = Number(record.is_current_tenant) === 1;
    return (
      <Card size="small" style={{ borderRadius: 8 }} bodyStyle={{ padding: '12px 16px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <Text strong style={{ fontSize: 14 }}>{record.meter_number}</Text>
          {isMaster ? <Tag color="gold">Master</Tag> : <Tag>Sub-meter</Tag>}
        </div>
        <div style={{ marginBottom: 4 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>Type: </Text>
          <Text style={{ fontSize: 13 }}>{METER_TYPE_LABELS[record.meter_type] || 'Electric'}</Text>
          {record.group_name && (
            <Text type="secondary" style={{ fontSize: 12, marginLeft: 12 }}>Group: {record.group_name}</Text>
          )}
        </div>
        <div style={{ marginBottom: 4 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>Unit: </Text>
          {isMaster ? <Tag color="blue" style={{ fontSize: 11 }}>Master</Tag> : (
            record.unit_name ? <Text style={{ fontSize: 13 }}>{record.property_name || ''} - {record.unit_name}</Text> : <Tag color="blue" style={{ fontSize: 11 }}>Common Area</Tag>
          )}
        </div>
        {!isMaster && (
          <div style={{ marginBottom: 4 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>Tenant: </Text>
            {tenantName ? (
              <Text style={{ fontSize: 13 }}>{tenantName} {!isCurrent && <Tag color="orange" style={{ fontSize: 10 }}>Past</Tag>}</Text>
            ) : (
              <Text type="secondary" style={{ fontStyle: 'italic', fontSize: 13 }}>Vacant</Text>
            )}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
          <div>
            <Text type="secondary" style={{ fontSize: 12 }}>Last: </Text>
            <Text strong>{Number(record.last_reading ?? record.current_reading).toLocaleString()}</Text>
            {record.last_reading_date && (
              <Text type="secondary" style={{ fontSize: 11, marginLeft: 4 }}>({dayjs(record.last_reading_date).format('MMM D')})</Text>
            )}
          </div>
          <Space size="small">
            <Button size="small" icon={<EditOutlined />} onClick={(e) => { e.stopPropagation(); setSelectedMeter(record); readingForm.resetFields(); readingForm.setFieldsValue({ reading_date: dayjs(), reading_type: 3 }); setReadingModal(true); }}>Log</Button>
            <Button size="small" icon={<HistoryOutlined />} onClick={(e) => { e.stopPropagation(); loadHistory(record); }}>History</Button>
          </Space>
        </div>
      </Card>
    );
  };

  return (
    <div>
      <div style={isMobile
        ? { marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 8 }
        : { marginBottom: 16 }
      }>
        {isMobile ? (
          <>
            <Select
              style={{ width: '100%' }}
              placeholder="All groups"
              value={filterGroup}
              onChange={v => setFilterGroup(v)}
              allowClear
              options={groups.map(g => ({ label: g.name, value: g.id }))}
            />
            <Input.Search placeholder="Search meter, unit, tenant..." value={search} onChange={e => setSearch(e.target.value)} allowClear style={{ width: '100%' }} />
          </>
        ) : (
        <Space>
          <Text strong>Filter by group:</Text>
          <Select
            style={{ width: 250 }}
            placeholder="All groups"
            value={filterGroup}
            onChange={v => setFilterGroup(v)}
            allowClear
            options={groups.map(g => ({ label: g.name, value: g.id }))}
          />
          <Input.Search placeholder="Search meter, unit, tenant..." value={search} onChange={e => setSearch(e.target.value)} allowClear style={{ width: 300 }} />
        </Space>
        )}
      </div>
      {(() => {
        const mq = search.toLowerCase();
        const filteredMeters = mq ? meters.filter(m =>
          (m.meter_number || '').toLowerCase().includes(mq) ||
          (m.unit_name || '').toLowerCase().includes(mq) ||
          (m.property_name || '').toLowerCase().includes(mq) ||
          (m.group_name || '').toLowerCase().includes(mq) ||
          [m.tenant_first_name, m.tenant_last_name].filter(Boolean).join(' ').toLowerCase().includes(mq)
        ) : meters;
        return isMobile ? (
          <MobileCardList
            dataSource={filteredMeters}
            renderCard={renderMeterCard}
            loading={loading}
            rowKey="id"
            emptyText="No meters found"
          />
        ) : (
          <Table
            dataSource={filteredMeters}
            columns={columns}
            rowKey="id"
            size="small"
            loading={loading}
            pagination={false}
          />
        );
      })()}

      {/* Log Reading Modal */}
      <Modal
        title={`Log Reading — ${selectedMeter?.meter_number || ''}${selectedMeter?.tenant_first_name ? ` — ${[selectedMeter.tenant_first_name, selectedMeter.tenant_last_name].filter(Boolean).join(' ')}` : ''}`}
        open={readingModal}
        onOk={handleLogReading}
        onCancel={() => { setReadingModal(false); readingForm.resetFields(); }}
      >
        <Form form={readingForm} layout="vertical">
          <div style={{ marginBottom: 16, padding: 12, background: '#fafafa', borderRadius: 6 }}>
            {selectedMeter?.unit_name && (
              <div style={{ marginBottom: 4 }}>
                <Text type="secondary">Unit: </Text>
                <Text strong>{selectedMeter.property_name} — {selectedMeter.unit_name}</Text>
                {selectedMeter?.tenant_first_name && (
                  <Text type="secondary"> ({[selectedMeter.tenant_first_name, selectedMeter.tenant_last_name].filter(Boolean).join(' ')})</Text>
                )}
              </div>
            )}
            <div>
              <Text type="secondary">Last reading: </Text>
              <Text strong>{lastReading.toLocaleString()}</Text>
              {selectedMeter?.last_reading_date && (
                <Text type="secondary"> ({dayjs(selectedMeter.last_reading_date).format('MMM D, YYYY')})</Text>
              )}
            </div>
          </div>
          <Form.Item name="reading_value" label="New Reading" rules={[{ required: true, message: 'Reading is required' }]}>
            <InputNumber style={{ width: '100%' }} min={0} precision={2} placeholder="Enter meter reading" />
          </Form.Item>
          <Form.Item name="reading_date" label="Reading Date" rules={[{ required: true, message: 'Date is required' }]}>
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="reading_type" label="Reading Type" rules={[{ required: true, message: 'Type is required' }]}>
            <Select options={READING_TYPE_OPTIONS} placeholder="Select type" />
          </Form.Item>
          <Form.Item name="notes" label="Notes (optional)">
            <Input.TextArea rows={2} placeholder="e.g. Tenant moved in today" />
          </Form.Item>
        </Form>
      </Modal>

      {/* History Modal */}
      <Modal
        title={`Reading History — ${selectedMeter?.meter_number || ''}`}
        open={historyModal}
        onCancel={() => { setHistoryModal(false); setReadings([]); }}
        footer={null}
        width={700}
      >
        <Table
          dataSource={readings}
          columns={historyColumns}
          rowKey="id"
          size="small"
          pagination={false}
        />
      </Modal>
    </div>
  );
}

// ─── BILLING TAB ─────────────────────────────────────────────

function BillingTab() {
  const { hasPermission } = useAuth();
  const canDeleteBill = hasPermission ? hasPermission('LANDLORD/UTILITY_BILL_DELETE') : false;
  const [groups, setGroups] = useState([]);
  const [selectedGroup, setSelectedGroup] = useState(null);
  const [bills, setBills] = useState([]);
  const [deletingBill, setDeletingBill] = useState(null); // bill row pending typed-confirm delete
  const [selectedBill, setSelectedBill] = useState(null);
  const [billDetail, setBillDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [billModal, setBillModal] = useState(false);
  const [checkoutModal, setCheckoutModal] = useState(false);
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [checkoutResult, setCheckoutResult] = useState(null);
  const [checkoutMeters, setCheckoutMeters] = useState([]);
  const [highestRate, setHighestRate] = useState(null);
  const [useHighestRate, setUseHighestRate] = useState(false);
  const [selectedCheckoutMeter, setSelectedCheckoutMeter] = useState(null);
  const [billForm] = Form.useForm();
  const [checkoutForm] = Form.useForm();
  const [billSearch, setBillSearch] = useState('');
  const { isMobile } = useIsMobile();

  const loadGroups = useCallback(async () => {
    try {
      const res = await utility.getGroups();
      setGroups(res.data?.data || []);
    } catch (err) {
      message.error('Failed to load groups');
    }
  }, []);

  const loadBills = useCallback(async (groupId) => {
    setLoading(true);
    try {
      const params = groupId ? { group_id: groupId } : {};
      const res = await utility.getBills(params);
      setBills(res.data?.data || []);
    } catch (err) {
      message.error('Failed to load bills');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadBillDetail = useCallback(async (billId) => {
    try {
      const res = await utility.getBill(billId);
      setBillDetail(res.data?.data || null);
    } catch (err) {
      message.error('Failed to load bill detail');
    }
  }, []);

  useEffect(() => {
    loadGroups();
    loadBills();
  }, [loadGroups]);

  useEffect(() => {
    loadBills(selectedGroup);
  }, [selectedGroup]);

  const handleCreateBill = async () => {
    try {
      const values = await billForm.validateFields();
      const payload = {
        group_id: selectedGroup,
        period_start: values.start_date.format('YYYY-MM-DD'),
        period_end: values.end_date.format('YYYY-MM-DD'),
        total_amount: values.total_amount,
        total_kw: values.total_kw,
      };
      const res = await utility.createBill(payload);
      message.success('Bill created');
      setBillModal(false);
      billForm.resetFields();
      loadBills(selectedGroup);
      // Auto-open the new bill
      setSelectedBill(res.data?.data?.id);
      loadBillDetail(res.data?.data?.id);
    } catch (err) {
      if (err.response?.data?.message) message.error(err.response.data.message);
    }
  };

  const handleDeleteBill = async () => {
    if (!deletingBill) return;
    try {
      await utility.deleteBill(deletingBill.id);
      message.success('Bill deleted');
      if (selectedBill === deletingBill.id) {
        setSelectedBill(null);
        setBillDetail(null);
      }
      setDeletingBill(null);
      loadBills(selectedGroup);
    } catch (err) {
      message.error(err.response?.data?.message || 'Failed to delete');
    }
  };

  const handleUpdateLine = async (lineId, endingReading) => {
    try {
      await utility.updateBillLine(lineId, { ending_reading: endingReading });
      loadBillDetail(selectedBill);
    } catch (err) {
      message.error(err.response?.data?.message || 'Failed to update');
    }
  };

  const handleFinalize = async () => {
    try {
      await utility.finalizeBill(selectedBill);
      message.success('Bill finalized');
      loadBillDetail(selectedBill);
      loadBills(selectedGroup);
    } catch (err) {
      message.error(err.response?.data?.message || 'Failed to finalize');
    }
  };

  const [invoiceModal, setInvoiceModal] = useState(false);
  const [selectedLineIds, setSelectedLineIds] = useState([]);

  const openInvoiceModal = () => {
    if (!billDetail) return;
    const tenantLines = (billDetail.lines || []).filter(l => !Number(l.is_common_area));
    const eligible = tenantLines.filter(l => Number(l.net_amount) > 0 && !l.invoice_id && l.tenant_id);
    setSelectedLineIds(eligible.map(l => l.id));
    setInvoiceModal(true);
  };

  const handleGenerateInvoices = async () => {
    try {
      if (selectedLineIds.length === 0) {
        message.warning('No tenants selected');
        return;
      }
      const res = await utility.generateInvoices(selectedBill, { line_ids: selectedLineIds });
      message.success(res.data?.message || 'Invoices generated');
      setInvoiceModal(false);
      loadBillDetail(selectedBill);
    } catch (err) {
      message.error(err.response?.data?.message || 'Failed to generate invoices');
    }
  };

  const billColumns = [
    { title: 'Group', dataIndex: 'group_name', key: 'group_name', width: 180 },
    {
      title: 'Period', key: 'period',
      render: (_, row) => `${dayjs(row.period_start).format('MMM D, YYYY')} - ${dayjs(row.period_end).format('MMM D, YYYY')}`
    },
    { title: 'Total', dataIndex: 'total_amount', key: 'total_amount', render: v => `$${Number(v).toFixed(2)}`, width: 110 },
    { title: 'kW', dataIndex: 'total_kw', key: 'total_kw', render: v => Number(v).toLocaleString(), width: 80 },
    { title: 'Rate', dataIndex: 'rate_per_kw', key: 'rate_per_kw', render: v => `$${Number(v).toFixed(2)}`, width: 90 },
    {
      title: 'Status', dataIndex: 'status', key: 'status', width: 100,
      render: v => Number(v) === 1 ? <Tag color="green">Finalized</Tag> : <Tag color="orange">Draft</Tag>
    },
    {
      title: '', key: 'actions', width: 100,
      render: (_, row) => (
        <Space>
          <Button size="small" onClick={() => { setSelectedBill(row.id); loadBillDetail(row.id); }}>View</Button>
          {canDeleteBill && (
            <Button size="small" danger icon={<DeleteOutlined />} onClick={() => setDeletingBill(row)} />
          )}
        </Space>
      )
    }
  ];

  // Bill detail view
  if (selectedBill && billDetail) {
    const isFinalized = Number(billDetail.status) === 1;
    const tenantLines = (billDetail.lines || []).filter(l => !Number(l.is_common_area));
    const commonLines = (billDetail.lines || []).filter(l => Number(l.is_common_area));
    const hasUninvoiced = tenantLines.some(l => Number(l.net_amount) > 0 && !l.invoice_id);
    const allReadingsEntered = (billDetail.lines || []).every(l => Number(l.ending_reading) > 0);
    const totalKwEntered = (billDetail.lines || []).reduce((sum, l) => sum + Number(l.kw_used), 0);

    const lineColumns = [
      { title: 'Meter', dataIndex: 'meter_number', key: 'meter_number', width: 120 },
      {
        title: 'Unit / Tenant', key: 'unit_tenant',
        render: (_, row) => {
          const tenant = [row.tenant_first_name, row.tenant_last_name].filter(Boolean).join(' ');
          return (
            <div>
              <div>{row.unit_name || 'Common Area'}</div>
              {tenant && <div style={{ fontSize: 12, color: '#888' }}>{tenant}</div>}
            </div>
          );
        }
      },
      { title: 'Last Reading', dataIndex: 'starting_reading', key: 'starting_reading', width: 110, render: v => Number(v).toLocaleString() },
      {
        title: 'New Reading', key: 'ending_reading', width: 140,
        render: (_, row) => {
          if (isFinalized) return Number(row.ending_reading).toLocaleString();
          return (
            <InputNumber
              size="small"
              value={Number(row.ending_reading) || undefined}
              precision={2}
              status={Number(row.ending_reading) > 0 && Number(row.ending_reading) < Number(row.starting_reading) ? 'warning' : undefined}
              style={{ width: 120 }}
              onBlur={(e) => {
                const val = parseFloat(e.target.value);
                if (!isNaN(val) && val !== Number(row.ending_reading)) {
                  if (val < Number(row.starting_reading)) {
                    Modal.confirm({
                      title: 'Warning',
                      content: `New reading (${val}) is less than last reading (${Number(row.starting_reading)}). Are you sure?`,
                      onOk: () => handleUpdateLine(row.id, val),
                    });
                  } else {
                    handleUpdateLine(row.id, val);
                  }
                }
              }}
              onPressEnter={(e) => {
                const val = parseFloat(e.target.value);
                if (!isNaN(val)) handleUpdateLine(row.id, val);
              }}
            />
          );
        }
      },
      { title: 'kW Used', dataIndex: 'kw_used', key: 'kw_used', width: 90, render: v => Number(v).toLocaleString() },
      { title: 'Gross', dataIndex: 'gross_amount', key: 'gross_amount', width: 100, render: v => `$${Number(v).toFixed(2)}` },
      { title: 'Credit', dataIndex: 'prorated_credit', key: 'prorated_credit', width: 100, render: (v, row) => {
        if (Number(v) === 0) return '-';
        const days = row.prorated_days;
        const total = row.total_period_days;
        const isProrated = days < total;
        return (
          <span>
            -${Number(v).toFixed(2)}
            {isProrated && <span style={{ fontSize: 11, color: '#888' }}> ({days}d)</span>}
          </span>
        );
      }},
      { title: 'Net', dataIndex: 'net_amount', key: 'net_amount', width: 100, render: v => {
        const n = Number(v);
        return <Text strong style={{ color: n > 0 ? '#cf1322' : '#52c41a' }}>${n.toFixed(2)}</Text>;
      }},
      {
        title: 'Invoice', key: 'invoice', width: 120,
        render: (_, row) => {
          if (Number(row.is_common_area)) return <Tag>N/A</Tag>;
          if (!row.tenant_id) return <Tag color="red">No tenant</Tag>;
          if (Number(row.net_amount) <= 0) return <Tag color="green">No charge</Tag>;
          if (row.invoice_id) {
            const statusMap = { 0: { color: 'blue', text: 'Open' }, 1: { color: 'green', text: 'Paid' }, 2: { color: 'red', text: 'Overdue' } };
            const s = statusMap[Number(row.invoice_status)] || statusMap[0];
            return <Tag color={s.color}>{row.invoice_code} - {s.text}</Tag>;
          }
          return <Tag color="orange">Pending</Tag>;
        }
      }
    ];

    // Calculate totals
    const totalKwUsed = tenantLines.reduce((sum, l) => sum + Number(l.kw_used), 0);
    const totalGross = tenantLines.reduce((sum, l) => sum + Number(l.gross_amount), 0);
    const totalCredit = tenantLines.reduce((sum, l) => sum + Number(l.prorated_credit), 0);
    const totalNet = tenantLines.reduce((sum, l) => sum + Number(l.net_amount), 0);
    const commonKw = commonLines.reduce((sum, l) => sum + Number(l.kw_used), 0);

    return (
      <div>
        <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Space>
            <Button onClick={() => { setSelectedBill(null); setBillDetail(null); }}>Back to Bills</Button>
            <Text strong>{billDetail.group_name}</Text>
            <Text type="secondary">
              {dayjs(billDetail.period_start).format('MMM D, YYYY')} - {dayjs(billDetail.period_end).format('MMM D, YYYY')}
            </Text>
            {isFinalized ? <Tag color="green">Finalized</Tag> : <Tag color="orange">Draft</Tag>}
          </Space>
          <Space>
            {!isFinalized && !allReadingsEntered && (
              <Text type="secondary" style={{ fontSize: 12 }}>Enter all meter readings to verify</Text>
            )}
            {!isFinalized && allReadingsEntered && (
              <Popconfirm
                title={<div>
                  <div>Verify and finalize this bill?</div>
                  <div style={{ fontSize: 12, marginTop: 4, color: '#666' }}>
                    Total kW metered: {totalKwEntered.toLocaleString()} | Bill kW: {Number(billDetail.total_kw).toLocaleString()}
                  </div>
                  <div style={{ fontSize: 12, color: '#666' }}>Meter current readings will be updated.</div>
                </div>}
                onConfirm={handleFinalize}
              >
                <Button type="primary" icon={<CheckCircleOutlined />}>Verify & Finalize</Button>
              </Popconfirm>
            )}
            {isFinalized && hasUninvoiced && (
              <Button type="primary" icon={<FileTextOutlined />} onClick={openInvoiceModal}>Generate Invoices</Button>
            )}
          </Space>
        </div>

        <Card size="small" style={{ marginBottom: 16 }}>
          <Row gutter={24}>
            <Col span={6}><Text type="secondary">Total Bill:</Text> <Text strong>${Number(billDetail.total_amount).toFixed(2)}</Text></Col>
            <Col span={6}><Text type="secondary">Total kW:</Text> <Text strong>{Number(billDetail.total_kw).toLocaleString()}</Text></Col>
            <Col span={6}><Text type="secondary">Rate:</Text> <Text strong>${Number(billDetail.rate_per_kw).toFixed(2)}/kW</Text></Col>
            <Col span={6}><Text type="secondary">Tenant Net Total:</Text> <Text strong style={{ color: '#cf1322' }}>${totalNet.toFixed(2)}</Text></Col>
          </Row>
        </Card>

        <Text strong style={{ display: 'block', marginBottom: 8 }}>Tenant Meters</Text>
        <Table
          dataSource={tenantLines}
          columns={lineColumns}
          rowKey="id"
          size="small"
          pagination={false}
          summary={() => (
            <Table.Summary.Row>
              <Table.Summary.Cell index={0} colSpan={4}><Text strong>Totals</Text></Table.Summary.Cell>
              <Table.Summary.Cell index={4}><Text strong>{totalKwUsed.toLocaleString()}</Text></Table.Summary.Cell>
              <Table.Summary.Cell index={5}><Text strong>${totalGross.toFixed(2)}</Text></Table.Summary.Cell>
              <Table.Summary.Cell index={6}><Text strong>-${totalCredit.toFixed(2)}</Text></Table.Summary.Cell>
              <Table.Summary.Cell index={7}><Text strong>${totalNet.toFixed(2)}</Text></Table.Summary.Cell>
              <Table.Summary.Cell index={8} />
            </Table.Summary.Row>
          )}
        />

        {commonLines.length > 0 && (
          <>
            <Text strong style={{ display: 'block', marginTop: 16, marginBottom: 8 }}>Common Area Meters (absorbed)</Text>
            <Table
              dataSource={commonLines}
              columns={lineColumns.filter(c => !['invoice'].includes(c.key))}
              rowKey="id"
              size="small"
              pagination={false}
            />
          </>
        )}

        {/* Selective Invoice Generation Modal */}
        <Modal
          title="Generate Invoices"
          open={invoiceModal}
          onOk={handleGenerateInvoices}
          okText={`Generate ${selectedLineIds.length} Invoice(s)`}
          onCancel={() => setInvoiceModal(false)}
          width={700}
        >
          <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
            Select which tenants should receive utility invoices. Uncheck tenants who should not be billed (e.g. Airbnb/Agoda).
          </Text>
          <Table
            dataSource={tenantLines.filter(l => Number(l.net_amount) > 0 && !l.invoice_id && l.tenant_id)}
            columns={[
              {
                title: 'Unit / Tenant', key: 'unit_tenant',
                render: (_, row) => {
                  const tenant = [row.tenant_first_name, row.tenant_last_name].filter(Boolean).join(' ');
                  return <div><div>{row.unit_name}</div>{tenant && <div style={{ fontSize: 12, color: '#888' }}>{tenant}</div>}</div>;
                }
              },
              { title: 'kW Used', dataIndex: 'kw_used', key: 'kw_used', width: 80, render: v => Number(v).toLocaleString() },
              { title: 'Gross', dataIndex: 'gross_amount', key: 'gross', width: 90, render: v => `$${Number(v).toFixed(2)}` },
              { title: 'Credit', dataIndex: 'prorated_credit', key: 'credit', width: 90, render: v => Number(v) > 0 ? `-$${Number(v).toFixed(2)}` : '-' },
              { title: 'Net', dataIndex: 'net_amount', key: 'net', width: 90, render: v => <Text strong>${Number(v).toFixed(2)}</Text> },
            ]}
            rowKey="id"
            size="small"
            pagination={false}
            rowSelection={{
              selectedRowKeys: selectedLineIds,
              onChange: (keys) => setSelectedLineIds(keys),
            }}
          />
        </Modal>
      </div>
    );
  }

  // Checkout settlement handlers
  const openCheckoutModal = async () => {
    checkoutForm.resetFields();
    setCheckoutResult(null);
    setUseHighestRate(false);
    setHighestRate(null);
    setSelectedCheckoutMeter(null);

    // Load all sub-meters with all tenant leases (current and past)
    try {
      const res = await utility.getCheckoutMeters();
      setCheckoutMeters(res.data?.data || []);
    } catch (err) {
      message.error('Failed to load meters');
    }
    setCheckoutModal(true);
  };

  const handleCheckoutMeterChange = async (comboKey) => {
    const meter = checkoutMeters.find(m => `${m.meter_id}_${m.leasing_id}` === comboKey);
    if (!meter) { setSelectedCheckoutMeter(null); return; }
    setSelectedCheckoutMeter(meter);
    // Pre-fill the last reading from current_reading
    checkoutForm.setFieldsValue({ last_reading: Number(meter.current_reading) });
    // Load highest rate for this meter's group
    try {
      const res = await utility.getHighestRate({ group_id: meter.group_id });
      setHighestRate(res.data?.data?.highest_rate || null);
    } catch (err) { /* ignore */ }
  };

  const handleCheckoutSettlement = async () => {
    try {
      const values = await checkoutForm.validateFields();
      const meter = checkoutMeters.find(m => `${m.meter_id}_${m.leasing_id}` === values.meter_id?.toString());
      if (!meter) return message.error('Meter not found');

      setCheckoutLoading(true);
      const res = await utility.checkoutSettlement({
        meter_id: meter.meter_id,
        tenant_id: meter.tenant_id,
        leasing_id: meter.leasing_id,
        checkout_reading: values.checkout_reading,
        manual_rate: values.manual_rate,
        reading_date: values.reading_date?.format('YYYY-MM-DD') || undefined,
        last_reading_override: values.last_reading != null ? values.last_reading : undefined,
      });
      setCheckoutResult(res.data?.data);
      message.success('Checkout settlement completed');
    } catch (err) {
      message.error(err.response?.data?.message || 'Failed to process settlement');
    } finally {
      setCheckoutLoading(false);
    }
  };

  const bq = billSearch.toLowerCase();
  const filteredBills = bq ? bills.filter(b =>
    (b.group_name || '').toLowerCase().includes(bq) ||
    dayjs(b.period_start).format('MMM D, YYYY').toLowerCase().includes(bq) ||
    dayjs(b.period_end).format('MMM D, YYYY').toLowerCase().includes(bq)
  ) : bills;

  const renderBillCard = (record) => {
    const isFinalized = Number(record.status) === 1;
    return (
      <Card size="small" style={{ borderRadius: 8 }} bodyStyle={{ padding: '12px 16px' }}
        onClick={() => { setSelectedBill(record.id); loadBillDetail(record.id); }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <Text strong style={{ fontSize: 14 }}>{record.group_name}</Text>
          {isFinalized ? <Tag color="green">Finalized</Tag> : <Tag color="orange">Draft</Tag>}
        </div>
        <div style={{ marginBottom: 4, fontSize: 13 }}>
          {dayjs(record.period_start).format('MMM D, YYYY')} - {dayjs(record.period_end).format('MMM D, YYYY')}
        </div>
        <div style={{ display: 'flex', gap: 16, fontSize: 12, color: '#666' }}>
          <span>Total: <Text strong>${Number(record.total_amount).toFixed(2)}</Text></span>
          <span>kW: <Text strong>{Number(record.total_kw).toLocaleString()}</Text></span>
          <span>Rate: <Text strong>${Number(record.rate_per_kw).toFixed(2)}</Text></span>
        </div>
      </Card>
    );
  };

  // Bill list view
  return (
    <div>
      <div style={isMobile
        ? { marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 8 }
        : { marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }
      }>
        {isMobile ? (
          <>
            <Select
              style={{ width: '100%' }}
              placeholder="All groups"
              value={selectedGroup}
              onChange={v => { setSelectedGroup(v); setSelectedBill(null); setBillDetail(null); }}
              options={groups.map(g => ({ label: g.name, value: g.id }))}
              allowClear
            />
            <Input.Search placeholder="Search bills..." value={billSearch} onChange={e => setBillSearch(e.target.value)} allowClear style={{ width: '100%' }} />
            <div style={{ display: 'flex', gap: 8 }}>
              <Button onClick={openCheckoutModal} style={{ flex: 1 }}>Checkout Settlement</Button>
              {selectedGroup && (
                <Button type="primary" icon={<PlusOutlined />} style={{ flex: 1 }} onClick={async () => {
                  billForm.resetFields();
                  try {
                    const res = await utility.getLastBillDate({ group_id: selectedGroup });
                    const data = res.data?.data;
                    if (data?.next_start) {
                      billForm.setFieldsValue({ start_date: dayjs(data.next_start) });
                    }
                  } catch (err) { /* ignore */ }
                  setBillModal(true);
                }}>New Bill</Button>
              )}
            </div>
          </>
        ) : (
          <>
            <Space>
              <Text strong>Filter by group:</Text>
              <Select
                style={{ width: 300 }}
                placeholder="All groups"
                value={selectedGroup}
                onChange={v => { setSelectedGroup(v); setSelectedBill(null); setBillDetail(null); }}
                options={groups.map(g => ({ label: g.name, value: g.id }))}
                allowClear
              />
              <Input.Search placeholder="Search bills..." value={billSearch} onChange={e => setBillSearch(e.target.value)} allowClear style={{ width: 250 }} />
            </Space>
            <Space>
              <Button onClick={openCheckoutModal}>Checkout Settlement</Button>
              {selectedGroup && (
                <Button type="primary" icon={<PlusOutlined />} onClick={async () => {
                  billForm.resetFields();
                  try {
                    const res = await utility.getLastBillDate({ group_id: selectedGroup });
                    const data = res.data?.data;
                    if (data?.next_start) {
                      billForm.setFieldsValue({ start_date: dayjs(data.next_start) });
                    }
                  } catch (err) { /* ignore */ }
                  setBillModal(true);
                }}>New Bill</Button>
              )}
            </Space>
          </>
        )}
      </div>

      {isMobile ? (
        <MobileCardList
          dataSource={filteredBills}
          renderCard={renderBillCard}
          loading={loading}
          rowKey="id"
          emptyText="No bills found"
        />
      ) : (
        <Table
          dataSource={filteredBills}
          columns={billColumns}
          rowKey="id"
          size="small"
          loading={loading}
          pagination={false}
        />
      )}

      {/* New Bill Modal */}
      <Modal
        title="New Utility Bill"
        open={billModal}
        onOk={handleCreateBill}
        onCancel={() => { setBillModal(false); billForm.resetFields(); }}
      >
        <Form form={billForm} layout="vertical">
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="start_date" label="Bill Start Date" rules={[{ required: true, message: 'Start date is required' }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="end_date" label="Bill End Date" rules={[{ required: true, message: 'End date is required' }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="total_amount" label="Bill Amount ($)" rules={[{ required: true, message: 'Amount is required' }]}>
                <InputNumber style={{ width: '100%' }} min={0} precision={2} placeholder="0.00" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="total_kw" label="KWH Used" rules={[{ required: true, message: 'kWh is required' }]}>
                <InputNumber style={{ width: '100%' }} min={0.01} precision={2} placeholder="0.00" />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>

      {/* Checkout Settlement Modal */}
      <Modal
        title="Checkout Settlement"
        open={checkoutModal}
        onOk={checkoutResult ? () => { setCheckoutModal(false); setCheckoutResult(null); loadBills(selectedGroup); } : handleCheckoutSettlement}
        okText={checkoutResult ? 'Done' : 'Calculate & Settle'}
        confirmLoading={checkoutLoading}
        onCancel={() => { setCheckoutModal(false); setCheckoutResult(null); }}
        width={600}
      >
        {!checkoutResult ? (
          <Form form={checkoutForm} layout="vertical">
            <Form.Item name="meter_id" label="Tenant Sub-Meter" rules={[{ required: true, message: 'Select a meter' }]}>
              <Select
                showSearch
                optionFilterProp="label"
                placeholder="Select tenant's meter"
                onChange={handleCheckoutMeterChange}
                options={checkoutMeters.map(m => {
                  const name = [m.tenant_first_name, m.tenant_last_name].filter(Boolean).join(' ');
                  const checkout = m.lease_end_date ? ` [${dayjs(m.lease_end_date).format('MMM D, YYYY')}]` : '';
                  return {
                    label: `${name} — ${m.unit_name} (${m.property_name} - ${m.meter_number})${checkout}`,
                    value: `${m.meter_id}_${m.leasing_id}`,
                  };
                })}
              />
            </Form.Item>
            {selectedCheckoutMeter && (
              <Form.Item name="last_reading" label="Last Reading (editable)">
                <InputNumber style={{ width: '100%' }} min={0} precision={2} />
              </Form.Item>
            )}
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item name="checkout_reading" label="Checkout Meter Reading" rules={[{ required: true, message: 'Reading is required' }]}>
                  <InputNumber style={{ width: '100%' }} min={0} precision={2} placeholder="Enter reading" />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item name="reading_date" label="Date" initialValue={dayjs()}>
                  <DatePicker style={{ width: '100%' }} />
                </Form.Item>
              </Col>
            </Row>
            <Form.Item
              name="manual_rate"
              label={
                <Space>
                  <span>Manual $/kWh Rate</span>
                  {highestRate && (
                    <Checkbox
                      checked={useHighestRate}
                      onChange={e => {
                        setUseHighestRate(e.target.checked);
                        if (e.target.checked) {
                          checkoutForm.setFieldsValue({ manual_rate: highestRate });
                        }
                      }}
                    >
                      Use highest rate (${Number(highestRate).toFixed(2)}/kWh)
                    </Checkbox>
                  )}
                </Space>
              }
              rules={[{ required: true, message: 'Rate is required' }]}
            >
              <InputNumber style={{ width: '100%' }} min={0} precision={4} placeholder="e.g. 2.0000" />
            </Form.Item>
          </Form>
        ) : (
          <div>
            <Descriptions bordered column={1} size="small">
              <Descriptions.Item label="Last Reading">{Number(checkoutResult.start_reading).toLocaleString()}</Descriptions.Item>
              <Descriptions.Item label="Checkout Reading">{Number(checkoutResult.checkout_reading).toLocaleString()}</Descriptions.Item>
              <Descriptions.Item label="kWh Used">{Number(checkoutResult.kw_used).toLocaleString()}</Descriptions.Item>
              <Descriptions.Item label="Rate">${Number(checkoutResult.rate).toFixed(2)}/kWh</Descriptions.Item>
              <Descriptions.Item label="Gross Amount">${Number(checkoutResult.gross_amount).toFixed(2)}</Descriptions.Item>
              <Descriptions.Item label="Prorated Credit ({checkoutResult.period_days} days)">-${Number(checkoutResult.prorated_credit).toFixed(2)}</Descriptions.Item>
              <Descriptions.Item label="Net Amount"><Text strong style={{ color: Number(checkoutResult.net_amount) > 0 ? '#cf1322' : '#52c41a' }}>${Number(checkoutResult.net_amount).toFixed(2)}</Text></Descriptions.Item>
            </Descriptions>
            {checkoutResult.next_lease_updated && (
              <div style={{ marginTop: 12 }}>
                <Tag color="blue">Next tenant's check-in meter updated automatically</Tag>
              </div>
            )}
          </div>
        )}
      </Modal>

      <TypedDeleteModal
        open={!!deletingBill}
        onCancel={() => setDeletingBill(null)}
        onConfirm={handleDeleteBill}
        itemLabel={deletingBill ? `${deletingBill.group_name || 'Bill'} — ${deletingBill.period_start ? dayjs(deletingBill.period_start).format('MMM D, YYYY') : ''}` : ''}
        itemType="utility bill"
        warning="The bill and all its line items will be deleted. Generated invoices remain — review them separately if needed."
      />
    </div>
  );
}
