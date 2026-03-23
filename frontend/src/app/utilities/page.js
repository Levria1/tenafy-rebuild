'use client';

import { Suspense, useEffect, useState, useCallback } from 'react';
import { Tabs, Table, Button, Select, Input, InputNumber, Modal, Form, Row, Col, Tag, Space, DatePicker, message, Popconfirm, Card, Typography, Descriptions } from 'antd';
import { PlusOutlined, DeleteOutlined, SaveOutlined, ThunderboltOutlined, CheckCircleOutlined, FileTextOutlined } from '@ant-design/icons';
import MainLayout from '../../components/Layout';
import { utility, property } from '../../lib/api';
import dayjs from 'dayjs';

const { Title, Text } = Typography;

const METER_TYPE_LABELS = { 0: 'Electric', 1: 'Water', 2: 'Gas' };
const METER_TYPE_OPTIONS = [
  { label: 'Electric', value: 0 },
  { label: 'Water', value: 1 },
  { label: 'Gas', value: 2 },
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

  return (
    <div>
      {reportData.map(group => {
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

  return (
    <div>
      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text strong>Assign units to billing groups</Text>
        <Button type="primary" icon={<SaveOutlined />} onClick={handleSave} loading={saving} disabled={!dirty}>
          Save
        </Button>
      </div>
      <Table
        dataSource={tableData}
        columns={columns}
        rowKey="id"
        size="small"
        loading={loading}
        pagination={false}
        rowClassName={(row) => row._type === 'property' ? 'utility-property-row' : ''}
      />
      <style>{`.utility-property-row td { background: #fafafa !important; }`}</style>
    </div>
  );
}

// ─── SETTINGS TAB ────────────────────────────────────────────

function SettingsTab() {
  const [groups, setGroups] = useState([]);
  const [properties, setProperties] = useState([]);
  const [units, setUnits] = useState([]);
  const [loading, setLoading] = useState(false);
  const [groupModal, setGroupModal] = useState(false);
  const [meterModal, setMeterModal] = useState(false);
  const [editingGroup, setEditingGroup] = useState(null);
  const [selectedGroupForMeter, setSelectedGroupForMeter] = useState(null);
  const [meters, setMeters] = useState([]);
  const [groupForm] = Form.useForm();
  const [meterForm] = Form.useForm();

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [gRes, pRes] = await Promise.all([
        utility.getGroups(),
        property.getAllWithUnits(),
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

  const handleDeleteGroup = async (id) => {
    try {
      await utility.deleteGroup(id);
      message.success('Group deleted');
      loadData();
      if (selectedGroupForMeter === id) {
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
      await utility.createMeter({ ...values, group_id: selectedGroupForMeter });
      message.success('Meter added');
      setMeterModal(false);
      meterForm.resetFields();
      loadMeters(selectedGroupForMeter);
      loadData();
    } catch (err) {
      if (err.response?.data?.message) message.error(err.response.data.message);
    }
  };

  const handleDeleteMeter = async (id) => {
    try {
      await utility.deleteMeter(id);
      message.success('Meter deleted');
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
          <Popconfirm title="Delete this group?" onConfirm={() => handleDeleteGroup(row.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      )
    }
  ];

  const meterColumns = [
    { title: 'Meter #', dataIndex: 'meter_number', key: 'meter_number' },
    { title: 'Type', dataIndex: 'meter_type', key: 'meter_type', render: v => METER_TYPE_LABELS[v] || 'Electric', width: 100 },
    { title: 'Unit', key: 'unit', render: (_, row) => row.unit_name ? `${row.property_name} - ${row.unit_name}` : <Tag color="blue">Common Area</Tag> },
    { title: 'Current Reading', dataIndex: 'current_reading', key: 'current_reading', width: 140, render: v => Number(v).toLocaleString() },
    {
      title: '', key: 'actions', width: 50,
      render: (_, row) => (
        <Popconfirm title="Delete this meter?" onConfirm={() => handleDeleteMeter(row.id)}>
          <Button size="small" danger icon={<DeleteOutlined />} />
        </Popconfirm>
      )
    }
  ];

  const selectedGroup = groups.find(g => g.id === selectedGroupForMeter);

  return (
    <div>
      <Row gutter={24}>
        {/* Groups */}
        <Col span={selectedGroupForMeter ? 12 : 24}>
          <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text strong>Billing Groups</Text>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => {
              setEditingGroup(null);
              groupForm.resetFields();
              setGroupModal(true);
            }}>Add Group</Button>
          </div>
          <Table
            dataSource={groups}
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
                  meterForm.resetFields();
                  setMeterModal(true);
                }}>Add Meter</Button>
                <Button onClick={() => { setSelectedGroupForMeter(null); setMeters([]); }}>Close</Button>
              </Space>
            </div>
            <Table
              dataSource={meters}
              columns={meterColumns}
              rowKey="id"
              size="small"
              pagination={false}
            />
          </Col>
        )}
      </Row>

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
        title="Add Meter"
        open={meterModal}
        onOk={handleSaveMeter}
        onCancel={() => { setMeterModal(false); meterForm.resetFields(); }}
      >
        <Form form={meterForm} layout="vertical">
          <Form.Item name="meter_number" label="Meter Number" rules={[{ required: true, message: 'Meter number is required' }]}>
            <Input placeholder="e.g. MTR-001" />
          </Form.Item>
          <Form.Item name="meter_type" label="Meter Type" initialValue={0}>
            <Select options={METER_TYPE_OPTIONS} />
          </Form.Item>
          <Form.Item name="unit_id" label="Unit (leave blank for common area)">
            <Select allowClear showSearch placeholder="Select unit" optionFilterProp="label"
              options={units.map(u => ({ label: `${u.property_name} - ${u.name}`, value: u.id }))}
            />
          </Form.Item>
          <Form.Item name="current_reading" label="Initial Meter Reading" initialValue={0}>
            <InputNumber style={{ width: '100%' }} min={0} precision={2} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

// ─── METERS TAB ──────────────────────────────────────────────

function MetersTab() {
  const [meters, setMeters] = useState([]);
  const [loading, setLoading] = useState(false);

  const loadMeters = useCallback(async () => {
    setLoading(true);
    try {
      const res = await utility.getMeters({});
      setMeters(res.data?.data || []);
    } catch (err) {
      message.error('Failed to load meters');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadMeters(); }, [loadMeters]);

  const columns = [
    { title: 'Meter #', dataIndex: 'meter_number', key: 'meter_number' },
    { title: 'Type', dataIndex: 'meter_type', key: 'meter_type', render: v => METER_TYPE_LABELS[v] || 'Electric', width: 100 },
    { title: 'Group', dataIndex: 'group_name', key: 'group_name' },
    {
      title: 'Unit', key: 'unit',
      render: (_, row) => row.unit_name ? `${row.property_name || ''} - ${row.unit_name}` : <Tag color="blue">Common Area</Tag>
    },
    { title: 'Current Reading', dataIndex: 'current_reading', key: 'current_reading', render: v => Number(v).toLocaleString() },
  ];

  return (
    <Table
      dataSource={meters}
      columns={columns}
      rowKey="id"
      size="small"
      loading={loading}
      pagination={false}
    />
  );
}

// ─── BILLING TAB ─────────────────────────────────────────────

function BillingTab() {
  const [groups, setGroups] = useState([]);
  const [selectedGroup, setSelectedGroup] = useState(null);
  const [bills, setBills] = useState([]);
  const [selectedBill, setSelectedBill] = useState(null);
  const [billDetail, setBillDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [billModal, setBillModal] = useState(false);
  const [billForm] = Form.useForm();

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
      const res = await utility.getBills({ group_id: groupId });
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

  useEffect(() => { loadGroups(); }, [loadGroups]);

  useEffect(() => {
    if (selectedGroup) loadBills(selectedGroup);
  }, [selectedGroup, loadBills]);

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

  const handleDeleteBill = async (id) => {
    try {
      await utility.deleteBill(id);
      message.success('Bill deleted');
      if (selectedBill === id) {
        setSelectedBill(null);
        setBillDetail(null);
      }
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

  const handleGenerateInvoices = async () => {
    try {
      const res = await utility.generateInvoices(selectedBill);
      message.success(res.data?.message || 'Invoices generated');
      loadBillDetail(selectedBill);
    } catch (err) {
      message.error(err.response?.data?.message || 'Failed to generate invoices');
    }
  };

  const billColumns = [
    {
      title: 'Period', key: 'period',
      render: (_, row) => `${dayjs(row.period_start).format('MMM D, YYYY')} - ${dayjs(row.period_end).format('MMM D, YYYY')}`
    },
    { title: 'Total', dataIndex: 'total_amount', key: 'total_amount', render: v => `$${Number(v).toFixed(2)}`, width: 110 },
    { title: 'kW', dataIndex: 'total_kw', key: 'total_kw', render: v => Number(v).toLocaleString(), width: 80 },
    { title: 'Rate', dataIndex: 'rate_per_kw', key: 'rate_per_kw', render: v => `$${Number(v).toFixed(4)}`, width: 90 },
    {
      title: 'Status', dataIndex: 'status', key: 'status', width: 100,
      render: v => Number(v) === 1 ? <Tag color="green">Finalized</Tag> : <Tag color="orange">Draft</Tag>
    },
    {
      title: '', key: 'actions', width: 100,
      render: (_, row) => (
        <Space>
          <Button size="small" onClick={() => { setSelectedBill(row.id); loadBillDetail(row.id); }}>View</Button>
          {Number(row.status) === 0 && (
            <Popconfirm title="Delete this bill?" onConfirm={() => handleDeleteBill(row.id)}>
              <Button size="small" danger icon={<DeleteOutlined />} />
            </Popconfirm>
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
      { title: 'Start', dataIndex: 'starting_reading', key: 'starting_reading', width: 100, render: v => Number(v).toLocaleString() },
      {
        title: 'End', key: 'ending_reading', width: 140,
        render: (_, row) => {
          if (isFinalized) return Number(row.ending_reading).toLocaleString();
          return (
            <InputNumber
              size="small"
              value={Number(row.ending_reading) || undefined}
              min={Number(row.starting_reading)}
              precision={2}
              style={{ width: 120 }}
              onBlur={(e) => {
                const val = parseFloat(e.target.value);
                if (!isNaN(val) && val !== Number(row.ending_reading)) {
                  handleUpdateLine(row.id, val);
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
              <Popconfirm title="Generate invoices for all tenants who owe?" onConfirm={handleGenerateInvoices}>
                <Button type="primary" icon={<FileTextOutlined />}>Generate Invoices</Button>
              </Popconfirm>
            )}
          </Space>
        </div>

        <Card size="small" style={{ marginBottom: 16 }}>
          <Row gutter={24}>
            <Col span={6}><Text type="secondary">Total Bill:</Text> <Text strong>${Number(billDetail.total_amount).toFixed(2)}</Text></Col>
            <Col span={6}><Text type="secondary">Total kW:</Text> <Text strong>{Number(billDetail.total_kw).toLocaleString()}</Text></Col>
            <Col span={6}><Text type="secondary">Rate:</Text> <Text strong>${Number(billDetail.rate_per_kw).toFixed(4)}/kW</Text></Col>
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
      </div>
    );
  }

  // Bill list view
  return (
    <div>
      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Space>
          <Text strong>Group:</Text>
          <Select
            style={{ width: 300 }}
            placeholder="Select a meter group"
            value={selectedGroup}
            onChange={v => { setSelectedGroup(v); setSelectedBill(null); setBillDetail(null); }}
            options={groups.map(g => ({ label: g.name, value: g.id }))}
            allowClear
          />
        </Space>
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
      </div>

      {selectedGroup && (
        <Table
          dataSource={bills}
          columns={billColumns}
          rowKey="id"
          size="small"
          loading={loading}
          pagination={false}
        />
      )}

      {!selectedGroup && (
        <div style={{ textAlign: 'center', padding: 60, color: '#999' }}>
          Select a meter group to view and create bills
        </div>
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
    </div>
  );
}
