'use client';

import { useState, useEffect, useCallback } from 'react';
import { Table, Card, Select, DatePicker, Button, InputNumber, message, Typography, Tabs, Tag } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { reports, property as propertyApi } from '../../../lib/api';
import MainLayout, { useAuth } from '../../../components/Layout';
import useIsMobile from '../../../hooks/useIsMobile';
import MobileCardList from '../../../components/mobile/MobileCardList';

const { RangePicker } = DatePicker;
const { Text } = Typography;

const fmt = (n) => (n == null ? '-' : Number(n).toLocaleString('en-HK', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const fmtMoney = (n) => n == null ? '-' : '$' + fmt(n);

export default function VacancyCostPage() {
  const { hasPermission } = useAuth();
  const { isMobile } = useIsMobile();
  const canEditLeasingCost = hasPermission('LANDLORD/REPORT/LEASING_COST_EDIT');

  // Shared filters
  const [dateRange, setDateRange] = useState(() => [
    dayjs().subtract(1, 'month').startOf('month'),
    dayjs().subtract(1, 'month').endOf('month'),
  ]);
  const [selectedProperties, setSelectedProperties] = useState([]);
  const [properties, setProperties] = useState([]);
  const [propertiesWithUnits, setPropertiesWithUnits] = useState([]);

  // Tab 2 only filter
  const [selectedUnits, setSelectedUnits] = useState([]);

  // Summary tab state
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState([]);

  // Unit breakdown tab state
  const [unitLoading, setUnitLoading] = useState(false);
  const [unitRows, setUnitRows] = useState([]);

  // Setup tab state
  const [setupCosts, setSetupCosts] = useState({});
  const [originalCosts, setOriginalCosts] = useState({});
  const [dirtyIds, setDirtyIds] = useState(new Set());
  const [setupSaving, setSetupSaving] = useState(false);

  const [activeTab, setActiveTab] = useState('summary');

  // Load property list (for filter dropdown and setup tab)
  useEffect(() => {
    propertyApi.getAll().then(res => {
      if (res.data.code === 200) setProperties(res.data.data || []);
    }).catch(() => {});
    propertyApi.getAllWithUnits().then(res => {
      if (res.data.code === 200) setPropertiesWithUnits(res.data.data || []);
    }).catch(() => {});
  }, []);

  // Populate setup costs from properties (leasing_cost now included in getAll response)
  useEffect(() => {
    if (properties.length === 0) return;
    const costs = {};
    for (const p of properties) {
      costs[String(p.id)] = p.leasing_cost != null ? Number(p.leasing_cost) : 0;
    }
    setSetupCosts(costs);
    setOriginalCosts(costs);
    setDirtyIds(new Set());
  }, [properties]);

  // Reload setup costs when switching to Setup tab
  const reloadSetupCosts = useCallback(() => {
    propertyApi.getAll().then(res => {
      if (res.data.code === 200) {
        const data = res.data.data || [];
        setProperties(data);
        const costs = {};
        for (const p of data) {
          costs[String(p.id)] = p.leasing_cost != null ? Number(p.leasing_cost) : 0;
        }
        setSetupCosts(costs);
        setOriginalCosts(costs);
        setDirtyIds(new Set());
      }
    }).catch(() => {});
  }, []);

  const handleTabChange = (key) => {
    setActiveTab(key);
    if (key === 'setup') {
      reloadSetupCosts();
    }
  };

  // Derive available units based on selected properties
  const availableUnits = (() => {
    if (selectedProperties.length === 0) {
      return propertiesWithUnits.flatMap(p => (p.units || []).map(u => ({
        label: `${p.display_name} — ${u.name}`,
        value: String(u.id),
        propertyId: String(p.id),
      })));
    }
    return propertiesWithUnits
      .filter(p => selectedProperties.includes(String(p.id)))
      .flatMap(p => (p.units || []).map(u => ({
        label: `${p.display_name} — ${u.name}`,
        value: String(u.id),
        propertyId: String(p.id),
      })));
  })();

  const handlePropertyChange = (v) => {
    setSelectedProperties(v);
    if (v.length > 0) {
      const unitsBelongingToNewProps = propertiesWithUnits
        .filter(p => v.includes(String(p.id)))
        .flatMap(p => (p.units || []).map(u => String(u.id)));
      setSelectedUnits(prev => prev.filter(uid => unitsBelongingToNewProps.includes(uid)));
    } else {
      setSelectedUnits([]);
    }
  };

  const handleReset = () => {
    setSelectedProperties([]);
    setSelectedUnits([]);
    setDateRange([
      dayjs().subtract(1, 'month').startOf('month'),
      dayjs().subtract(1, 'month').endOf('month'),
    ]);
  };

  // Load Summary tab data
  const loadSummary = useCallback(async () => {
    if (!dateRange || !dateRange[0] || !dateRange[1]) return;
    try {
      setLoading(true);
      const params = {
        startDate: dateRange[0].format('YYYY-MM-DD'),
        endDate: dateRange[1].format('YYYY-MM-DD'),
      };
      if (selectedProperties.length > 0) params.propertyIds = selectedProperties.join(',');
      const res = await reports.vacancyCost(params);
      if (res.data.code === 200) {
        setRows(res.data.data.rows || []);
      }
    } catch (err) {
      console.error('Failed to load vacancy cost:', err);
      message.error('Failed to load report data');
    } finally {
      setLoading(false);
    }
  }, [dateRange, selectedProperties]);

  // Load Unit Breakdown tab data
  const loadUnitBreakdown = useCallback(async () => {
    if (!dateRange || !dateRange[0] || !dateRange[1]) return;
    try {
      setUnitLoading(true);
      const params = {
        startDate: dateRange[0].format('YYYY-MM-DD'),
        endDate: dateRange[1].format('YYYY-MM-DD'),
      };
      if (selectedProperties.length > 0) params.propertyIds = selectedProperties.join(',');
      if (selectedUnits.length > 0) params.unitIds = selectedUnits.join(',');
      const res = await reports.vacancyCostUnits(params);
      if (res.data.code === 200) {
        setUnitRows(res.data.data.rows || []);
      }
    } catch (err) {
      console.error('Failed to load unit breakdown:', err);
      message.error('Failed to load unit breakdown data');
    } finally {
      setUnitLoading(false);
    }
  }, [dateRange, selectedProperties, selectedUnits]);

  useEffect(() => {
    loadSummary();
  }, [loadSummary]);

  useEffect(() => {
    loadUnitBreakdown();
  }, [loadUnitBreakdown]);

  // Setup tab handlers
  const handleSetupCostChange = (propertyId, value) => {
    const pid = String(propertyId);
    setSetupCosts(prev => ({ ...prev, [pid]: value }));
    setDirtyIds(prev => {
      const next = new Set(prev);
      if (value !== originalCosts[pid]) {
        next.add(pid);
      } else {
        next.delete(pid);
      }
      return next;
    });
  };

  const saveAllSetupCosts = async () => {
    if (dirtyIds.size === 0) return;
    try {
      setSetupSaving(true);
      await Promise.all(
        [...dirtyIds].map(pid => propertyApi.updateLeasingCost(pid, setupCosts[pid] ?? 0))
      );
      message.success('Leasing costs saved');
      reloadSetupCosts();
    } catch (err) {
      message.error('Some values failed to save');
    } finally {
      setSetupSaving(false);
    }
  };

  // Summary total row
  const totalRow = (() => {
    if (rows.length === 0) return null;
    const totalActiveUnits = rows.reduce((s, r) => s + (r.active_units || 0), 0);
    const totalDays = rows.reduce((s, r) => s + (r.days || 0), 0);
    const totalRentalIncome = rows.reduce((s, r) => s + (r.rental_income || 0), 0);
    const totalLeasingCost = rows.reduce((s, r) => s + (r.leasing_cost || 0), 0);
    const totalVacantDays = rows.reduce((s, r) => s + (r.vacant_days || 0), 0);
    const totalVacantCost = rows.reduce((s, r) => s + (r.vacant_cost || 0), 0);
    const totalEl = rows.reduce((s, r) => s + (r.el || 0), 0);
    const totalVariance = rows.reduce((s, r) => s + (r.variance || 0), 0);
    const weightedRentPerUnit = totalDays > 0 ? totalRentalIncome / totalDays : 0;
    return {
      property_id: '__total__',
      property_name: 'TOTAL',
      active_units: totalActiveUnits,
      days: totalDays,
      rental_income: totalRentalIncome,
      rent_per_unit: weightedRentPerUnit,
      leasing_cost: totalLeasingCost,
      vacant_days: totalVacantDays,
      vacant_cost: totalVacantCost,
      el: totalEl,
      variance: totalVariance,
      isTotal: true,
    };
  })();

  const tableData = totalRow ? [...rows, totalRow] : rows;

  // Summary columns
  const summaryColumns = [
    {
      title: 'Property',
      dataIndex: 'property_name',
      key: 'property_name',
      width: 180,
      render: (v, record) => record.isTotal
        ? <Text strong style={{ color: '#1677ff' }}>{v}</Text>
        : v,
    },
    {
      title: 'Active Units',
      dataIndex: 'active_units',
      key: 'active_units',
      align: 'right',
      width: 100,
      render: (v, record) => record.isTotal ? <Text strong>{v}</Text> : v,
    },
    {
      title: 'Days',
      dataIndex: 'days',
      key: 'days',
      align: 'right',
      width: 80,
      render: (v, record) => record.isTotal ? <Text strong>{v}</Text> : v,
    },
    {
      title: 'Rental Income',
      dataIndex: 'rental_income',
      key: 'rental_income',
      align: 'right',
      width: 130,
      render: (v, record) => record.isTotal
        ? <Text strong>{fmtMoney(v)}</Text>
        : fmtMoney(v),
    },
    {
      title: 'Rent/Unit',
      dataIndex: 'rent_per_unit',
      key: 'rent_per_unit',
      align: 'right',
      width: 110,
      render: (v, record) => record.isTotal
        ? <Text strong>{fmtMoney(v)}</Text>
        : fmtMoney(v),
    },
    {
      title: 'Leasing Cost',
      dataIndex: 'leasing_cost',
      key: 'leasing_cost',
      align: 'right',
      width: 130,
      render: (v, record) => record.isTotal
        ? <Text strong>{fmtMoney(v)}</Text>
        : fmtMoney(v),
    },
    {
      title: 'Vacant Days',
      dataIndex: 'vacant_days',
      key: 'vacant_days',
      align: 'right',
      width: 100,
      render: (v, record) => record.isTotal ? <Text strong>{v}</Text> : v,
    },
    {
      title: 'Vacant Cost',
      dataIndex: 'vacant_cost',
      key: 'vacant_cost',
      align: 'right',
      width: 110,
      render: (v, record) => record.isTotal
        ? <Text strong>{fmtMoney(v)}</Text>
        : fmtMoney(v),
    },
    {
      title: 'EL',
      dataIndex: 'el',
      key: 'el',
      align: 'right',
      width: 110,
      render: (v, record) => record.isTotal
        ? <Text strong>{fmtMoney(v)}</Text>
        : fmtMoney(v),
    },
    {
      title: 'Variance',
      dataIndex: 'variance',
      key: 'variance',
      align: 'right',
      width: 110,
      render: (v, record) => {
        const val = Number(v) || 0;
        const color = val >= 0 ? '#52c41a' : '#ff4d4f';
        return record.isTotal
          ? <Text strong style={{ color }}>{fmtMoney(val)}</Text>
          : <Text style={{ color }}>{fmtMoney(val)}</Text>;
      },
    },
  ];

  // Unit Breakdown columns
  const unitColumns = [
    {
      title: 'Property',
      dataIndex: 'property_name',
      key: 'property_name',
      width: 160,
      sorter: (a, b) => a.property_name.localeCompare(b.property_name),
      defaultSortOrder: 'ascend',
    },
    {
      title: 'Unit',
      dataIndex: 'unit_name',
      key: 'unit_name',
      width: 100,
      sorter: (a, b) => a.unit_name.localeCompare(b.unit_name),
    },
    {
      title: 'Lease End',
      dataIndex: 'lease_end',
      key: 'lease_end',
      width: 110,
      sorter: (a, b) => (a.lease_end || '').localeCompare(b.lease_end || ''),
      render: (v) => v || '—',
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 90,
      sorter: (a, b) => a.status.localeCompare(b.status),
      render: (v) => v === 'Booked'
        ? <Tag color="green">Booked</Tag>
        : <Tag color="red">Vacant</Tag>,
    },
    {
      title: 'Booked On',
      dataIndex: 'booked_on',
      key: 'booked_on',
      width: 110,
      sorter: (a, b) => (a.booked_on || '').localeCompare(b.booked_on || ''),
      render: (v) => v || '—',
    },
    {
      title: 'Period Vacancy',
      dataIndex: 'period_vacancy',
      key: 'period_vacancy',
      align: 'right',
      width: 120,
      sorter: (a, b) => a.period_vacancy - b.period_vacancy,
    },
    {
      title: 'Days Vacant',
      dataIndex: 'days_vacant',
      key: 'days_vacant',
      align: 'right',
      width: 110,
      sorter: (a, b) => a.days_vacant - b.days_vacant,
    },
  ];

  // Setup tab columns
  const setupColumns = [
    {
      title: 'Property',
      dataIndex: 'display_name',
      key: 'display_name',
    },
    {
      title: 'Leasing Cost',
      key: 'leasing_cost',
      align: 'right',
      width: 200,
      render: (_, record) => {
        const pid = String(record.id);
        return (
          <InputNumber
            value={setupCosts[pid] ?? 0}
            min={0}
            precision={2}
            size="small"
            disabled={!canEditLeasingCost || setupSaving}
            style={{ width: 140 }}
            onChange={(val) => handleSetupCostChange(pid, val)}
          />
        );
      },
    },
  ];

  // Mobile card renderers
  const renderSummaryMobileCard = (record) => {
    if (record.isTotal) {
      return (
        <Card
          size="small"
          style={{ borderRadius: 8, background: '#e6f4ff', border: '1px solid #91caff' }}
          bodyStyle={{ padding: '12px 16px' }}
        >
          <Text strong style={{ color: '#1677ff', fontSize: 15 }}>TOTAL</Text>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 16px', marginTop: 8 }}>
            <div><Text type="secondary" style={{ fontSize: 12 }}>Active Units</Text><br /><Text strong>{record.active_units}</Text></div>
            <div><Text type="secondary" style={{ fontSize: 12 }}>Days</Text><br /><Text strong>{record.days}</Text></div>
            <div><Text type="secondary" style={{ fontSize: 12 }}>Rental Income</Text><br /><Text strong>{fmtMoney(record.rental_income)}</Text></div>
            <div><Text type="secondary" style={{ fontSize: 12 }}>Rent/Unit</Text><br /><Text strong>{fmtMoney(record.rent_per_unit)}</Text></div>
            <div><Text type="secondary" style={{ fontSize: 12 }}>Leasing Cost</Text><br /><Text strong>{fmtMoney(record.leasing_cost)}</Text></div>
            <div><Text type="secondary" style={{ fontSize: 12 }}>Vacant Days</Text><br /><Text strong>{record.vacant_days}</Text></div>
            <div><Text type="secondary" style={{ fontSize: 12 }}>Vacant Cost</Text><br /><Text strong>{fmtMoney(record.vacant_cost)}</Text></div>
            <div><Text type="secondary" style={{ fontSize: 12 }}>EL</Text><br /><Text strong>{fmtMoney(record.el)}</Text></div>
            <div><Text type="secondary" style={{ fontSize: 12 }}>Variance</Text><br /><Text strong style={{ color: Number(record.variance) >= 0 ? '#52c41a' : '#ff4d4f' }}>{fmtMoney(record.variance)}</Text></div>
          </div>
        </Card>
      );
    }

    return (
      <Card size="small" style={{ borderRadius: 8 }} bodyStyle={{ padding: '12px 16px' }}>
        <Text strong style={{ fontSize: 14 }}>{record.property_name}</Text>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 16px', marginTop: 8 }}>
          <div><Text type="secondary" style={{ fontSize: 12 }}>Active Units</Text><br /><Text>{record.active_units}</Text></div>
          <div><Text type="secondary" style={{ fontSize: 12 }}>Days</Text><br /><Text>{record.days}</Text></div>
          <div><Text type="secondary" style={{ fontSize: 12 }}>Rental Income</Text><br /><Text>{fmtMoney(record.rental_income)}</Text></div>
          <div><Text type="secondary" style={{ fontSize: 12 }}>Rent/Unit</Text><br /><Text>{fmtMoney(record.rent_per_unit)}</Text></div>
          <div><Text type="secondary" style={{ fontSize: 12 }}>Leasing Cost</Text><br /><Text>{fmtMoney(record.leasing_cost)}</Text></div>
          <div><Text type="secondary" style={{ fontSize: 12 }}>Vacant Days</Text><br /><Text>{record.vacant_days}</Text></div>
          <div><Text type="secondary" style={{ fontSize: 12 }}>Vacant Cost</Text><br /><Text>{fmtMoney(record.vacant_cost)}</Text></div>
          <div><Text type="secondary" style={{ fontSize: 12 }}>EL</Text><br /><Text>{fmtMoney(record.el)}</Text></div>
          <div>
            <Text type="secondary" style={{ fontSize: 12 }}>Variance</Text><br />
            <Text style={{ color: Number(record.variance) >= 0 ? '#52c41a' : '#ff4d4f' }}>{fmtMoney(record.variance)}</Text>
          </div>
        </div>
      </Card>
    );
  };

  const renderUnitMobileCard = (record) => (
    <Card size="small" style={{ borderRadius: 8 }} bodyStyle={{ padding: '12px 16px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <Text strong style={{ fontSize: 14 }}>{record.property_name} — {record.unit_name}</Text>
        {record.status === 'Booked'
          ? <Tag color="green">Booked</Tag>
          : <Tag color="red">Vacant</Tag>}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 16px' }}>
        <div><Text type="secondary" style={{ fontSize: 12 }}>Lease End</Text><br /><Text>{record.lease_end || '—'}</Text></div>
        <div><Text type="secondary" style={{ fontSize: 12 }}>Booked On</Text><br /><Text>{record.booked_on || '—'}</Text></div>
        <div><Text type="secondary" style={{ fontSize: 12 }}>Period Vacancy</Text><br /><Text>{record.period_vacancy}</Text></div>
        <div><Text type="secondary" style={{ fontSize: 12 }}>Days Vacant</Text><br /><Text>{record.days_vacant}</Text></div>
      </div>
    </Card>
  );

  // Tab items
  const tabItems = [
    {
      key: 'summary',
      label: 'Summary',
      children: isMobile ? (
        <MobileCardList
          dataSource={tableData}
          renderCard={renderSummaryMobileCard}
          loading={loading}
          rowKey="property_id"
          emptyText="No data for the selected period"
        />
      ) : (
        <Table
          columns={summaryColumns}
          dataSource={tableData}
          rowKey="property_id"
          loading={loading}
          size="small"
          pagination={false}
          scroll={{ x: 1100 }}
          rowClassName={(record) => record.isTotal ? 'vacancy-cost-total-row' : ''}
          onRow={(record) => ({
            style: record.isTotal
              ? { background: '#e6f4ff', fontWeight: 600 }
              : {},
          })}
          locale={{ emptyText: 'No data for the selected period' }}
        />
      ),
    },
    {
      key: 'units',
      label: 'Unit Breakdown',
      children: (
        <>
          <Card size="small" style={{ marginBottom: 16 }}>
            <div style={isMobile
              ? { display: 'flex', flexDirection: 'column', gap: 8 }
              : { display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }
            }>
              <Select
                mode="multiple"
                placeholder="All Properties"
                value={selectedProperties}
                onChange={handlePropertyChange}
                allowClear
                showSearch
                optionFilterProp="label"
                style={{ width: isMobile ? '100%' : 280 }}
                options={properties.map(p => ({
                  label: p.display_name,
                  value: String(p.id),
                }))}
              />
              <Select
                mode="multiple"
                placeholder={selectedProperties.length === 0 ? 'Select a property first' : 'All Units'}
                value={selectedUnits}
                onChange={(v) => setSelectedUnits(v)}
                allowClear
                showSearch
                optionFilterProp="label"
                disabled={selectedProperties.length === 0}
                style={{ width: isMobile ? '100%' : 340 }}
                options={availableUnits.map(u => ({
                  label: selectedProperties.length === 1
                    ? u.label.split(' — ').slice(1).join(' — ') || u.label
                    : u.label,
                  value: u.value,
                }))}
              />
            </div>
          </Card>
          {isMobile ? (
            <MobileCardList
              dataSource={unitRows}
              renderCard={renderUnitMobileCard}
              loading={unitLoading}
              rowKey={(r) => `${r.unit_id}_${r.lease_end}`}
              emptyText="No vacancies in the selected period"
            />
          ) : (
            <Table
              columns={unitColumns}
              dataSource={unitRows}
              rowKey={(r) => `${r.unit_id}_${r.lease_end}`}
              loading={unitLoading}
              size="small"
              pagination={{ pageSize: 50, showSizeChanger: true }}
              scroll={{ x: 800 }}
              locale={{ emptyText: 'No vacancies in the selected period' }}
            />
          )}
        </>
      ),
    },
    {
      key: 'setup',
      label: 'Setup',
      children: (
        <>
          {!canEditLeasingCost && (
            <div style={{ marginBottom: 12 }}>
              <Text type="secondary">View only — requires permission to edit</Text>
            </div>
          )}
          <Table
            columns={setupColumns}
            dataSource={properties}
            rowKey="id"
            size="small"
            pagination={false}
            locale={{ emptyText: 'No properties found' }}
          />
          <div style={{ marginTop: 16 }}>
            <Button
              type="primary"
              onClick={saveAllSetupCosts}
              disabled={!canEditLeasingCost || dirtyIds.size === 0 || setupSaving}
              loading={setupSaving}
            >
              Save All
            </Button>
          </div>
        </>
      ),
    },
  ];

  return (
    <MainLayout>
      <div style={{ padding: 0 }}>
        <h1 style={{ marginBottom: 20, fontSize: 22 }}>Vacancy Cost</h1>

        {activeTab !== 'setup' && (
        <Card size="small" style={{ marginBottom: 16 }}>
          <div style={isMobile
            ? { display: 'flex', flexDirection: 'column', gap: 8 }
            : { display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }
          }>
            <RangePicker
              value={dateRange}
              onChange={(v) => setDateRange(v)}
              style={{ width: isMobile ? '100%' : 260 }}
              allowClear={false}
            />
            {activeTab !== 'units' && (
              <Select
                mode="multiple"
                placeholder="All Properties"
                value={selectedProperties}
                onChange={handlePropertyChange}
                allowClear
                showSearch
                optionFilterProp="label"
                style={{ width: isMobile ? '100%' : 280 }}
                options={properties.map(p => ({
                  label: p.display_name,
                  value: String(p.id),
                }))}
              />
            )}
            <Button
              icon={<ReloadOutlined />}
              onClick={handleReset}
              block={isMobile}
            >
              Reset
            </Button>
          </div>
        </Card>
      )}

        <Tabs
          activeKey={activeTab}
          onChange={handleTabChange}
          items={tabItems}
        />
      </div>
    </MainLayout>
  );
}
