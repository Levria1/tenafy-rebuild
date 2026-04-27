'use client';

import { useEffect, useState, useMemo, Suspense } from 'react';
import { Select, Spin, Input, DatePicker, Tooltip } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import MainLayout from '../../../components/Layout';
import { leasing, property as propertyApi } from '../../../lib/api';

const CONTRACT_TYPE_MAP = { 1: 'MR', 2: 'MTM', 3: 'NR', 4: 'UC' };
const CONTRACT_TYPE_LABEL = { 1: 'May Renew', 2: 'Month To Month', 3: 'Not Renewing', 4: 'Unconfirmed' };

function CalendarInner() {
  const [data, setData] = useState([]);
  const [properties, setProperties] = useState([]);
  const [loading, setLoading] = useState(true);
  const [propertyFilter, setPropertyFilter] = useState(null);
  const [unitFilter, setUnitFilter] = useState(null);
  const [allUnits, setAllUnits] = useState([]);
  const [filteredUnits, setFilteredUnits] = useState([]);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState(null);
  const [dateRange, setDateRange] = useState([
    dayjs().subtract(1, 'month').startOf('month'),
    dayjs().add(6, 'month').endOf('month'),
  ]);

  useEffect(() => {
    loadProperties();
  }, []);

  useEffect(() => {
    loadData();
  }, [dateRange, propertyFilter, unitFilter, search]);

  // Filter units dropdown when property changes
  useEffect(() => {
    if (propertyFilter) {
      setFilteredUnits(allUnits.filter(u => u.property_id === propertyFilter));
    } else {
      setFilteredUnits(allUnits);
    }
    setUnitFilter(null);
  }, [propertyFilter, allUnits]);

  const loadProperties = async () => {
    try {
      const res = await propertyApi.getAllWithUnits();
      const props = res.data.data || [];
      setProperties(props);
      const units = [];
      props.forEach(p => {
        if (p.units) p.units.forEach(u => units.push({ ...u, property_id: p.id, property_name: p.display_name }));
      });
      setAllUnits(units);
      setFilteredUnits(units);
    } catch { /* ignore */ }
  };

  const loadData = async () => {
    try {
      setLoading(true);
      const params = {
        startDate: dateRange[0].format('YYYY-MM-DD'),
        endDate: dateRange[1].format('YYYY-MM-DD'),
      };
      if (propertyFilter) params.propertyId = propertyFilter;
      if (unitFilter) params.unitId = unitFilter;
      if (search) params.search = search;
      const res = await leasing.getCalendar(params);
      if (res.data.code === 200) {
        setData(res.data.data.properties || []);
      }
    } catch (error) {
      console.error('Failed to load calendar:', error);
    } finally {
      setLoading(false);
    }
  };

  // Build list of months to display
  const months = useMemo(() => {
    const result = [];
    let current = dateRange[0].startOf('month');
    const end = dateRange[1].endOf('month');
    while (current.isBefore(end) || current.isSame(end, 'month')) {
      result.push(current);
      current = current.add(1, 'month');
    }
    return result;
  }, [dateRange]);

  // Normalize date to date-only dayjs (strips time/timezone to avoid leaking across months)
  const toDate = (d) => dayjs(dayjs(d).format('YYYY-MM-DD'));

  // For each unit+month, determine cell status and info
  const getCellInfo = (unit, month) => {
    const monthStart = month.startOf('month');
    const monthEnd = month.endOf('month');
    const today = dayjs();

    // Find leases that overlap this month
    const overlapping = (unit.leases || []).filter(l => {
      const ls = toDate(l.start_date);
      const le = l.end_date ? toDate(l.end_date) : null;
      return ls.isBefore(monthEnd.add(1, 'day')) && (!le || le.isAfter(monthStart.subtract(1, 'day')));
    });

    if (overlapping.length === 0) {
      return { color: '#fff', status: 'vacant', leases: [] };
    }

    // Check if fully covered for the month
    const hasExpiring = overlapping.some(l => {
      const le = l.end_date ? toDate(l.end_date) : null;
      return le && le.isBefore(monthEnd.add(1, 'day')) && le.isAfter(monthStart.subtract(1, 'day'));
    });

    const hasStarting = overlapping.some(l => {
      const ls = toDate(l.start_date);
      return ls.isAfter(monthStart) && ls.isBefore(monthEnd.add(1, 'day'));
    });

    // Check for gap: a lease ends this month and next lease starts after a gap
    const sortedByEnd = overlapping
      .filter(l => l.end_date)
      .sort((a, b) => toDate(a.end_date).diff(toDate(b.end_date)));

    const allLeasesSorted = (unit.leases || [])
      .slice()
      .sort((a, b) => toDate(a.start_date).diff(toDate(b.start_date)));

    let hasGap = false;
    let expiringNoNext = false;

    for (const lease of sortedByEnd) {
      const leaseEnd = toDate(lease.end_date);
      if (leaseEnd.isBefore(monthStart) || leaseEnd.isAfter(monthEnd)) continue;

      // Find next lease for this unit after this one ends
      const nextLease = allLeasesSorted.find(l =>
        l.id !== lease.id && toDate(l.start_date).isAfter(leaseEnd)
      );

      if (nextLease) {
        // There's a gap if next lease doesn't start the day after
        const dayAfterEnd = leaseEnd.add(1, 'day');
        if (toDate(nextLease.start_date).isAfter(dayAfterEnd)) {
          hasGap = true;
        }
      } else {
        // Lease is expiring with no upcoming lease
        expiringNoNext = true;
      }
    }

    // Determine color
    let color;
    if (expiringNoNext) {
      color = '#ff4d4f30'; // red — expiring, no next lease
    } else if (hasGap) {
      color = '#faad1440'; // yellow — gap between leases
    } else {
      // Check if fully booked for the entire month
      const coversFullMonth = overlapping.some(l => {
        const ls = toDate(l.start_date);
        const le = l.end_date ? toDate(l.end_date) : monthEnd.add(1, 'year'); // no end = indefinite
        return (ls.isBefore(monthStart.add(1, 'day')) || ls.isSame(monthStart, 'day')) &&
               (le.isAfter(monthEnd) || le.isSame(monthEnd, 'day'));
      });
      if (coversFullMonth) {
        color = '#52c41a30'; // green — fully booked
      } else if (hasStarting && !hasExpiring) {
        color = '#52c41a30'; // green — lease starting, covers rest
      } else {
        color = '#52c41a20'; // light green
      }
    }

    return {
      color,
      status: expiringNoNext ? 'expiring' : hasGap ? 'gap' : 'booked',
      leases: overlapping,
    };
  };

  // Filter data by unit status
  const filteredData = useMemo(() => {
    if (!statusFilter) return data;
    return data.map(prop => {
      const units = prop.units.filter(unit => {
        if (statusFilter === 'vacant' || statusFilter === 'occupied') {
          const refDate = dateRange[0];
          const hasLeaseOnDate = (unit.leases || []).some(l => {
            const ls = toDate(l.start_date);
            const le = l.end_date ? toDate(l.end_date) : null;
            return ls.isBefore(refDate.add(1, 'day')) && (!le || le.isAfter(refDate.subtract(1, 'day')));
          });
          return statusFilter === 'vacant' ? !hasLeaseOnDate : hasLeaseOnDate;
        }
        // For booked/gap/expiring, check if any month has that status
        for (const m of months) {
          const cellInfo = getCellInfo(unit, m);
          if (cellInfo.status === statusFilter) return true;
        }
        return false;
      });
      return units.length > 0 ? { ...prop, units } : null;
    }).filter(Boolean);
  }, [data, statusFilter, dateRange, months]);

  const renderTooltip = (cellInfo, unit, month) => {
    if (cellInfo.leases.length === 0) return 'Vacant';
    return (
      <div style={{ maxWidth: 280 }}>
        {cellInfo.leases.map((l, i) => {
          const ls = toDate(l.start_date);
          const le = l.end_date ? toDate(l.end_date) : null;
          const monthStart = month.startOf('month');
          const monthEnd = month.endOf('month');
          const isMovingIn = ls.isAfter(monthStart) && ls.isBefore(monthEnd.add(1, 'day'));
          const isMovingOut = le && le.isAfter(monthStart.subtract(1, 'day')) && le.isBefore(monthEnd.add(1, 'day'));
          const leaseMonths = le ? Math.round(le.diff(ls, 'month', true)) : null;

          return (
            <div key={l.id} style={{ marginBottom: i < cellInfo.leases.length - 1 ? 8 : 0, borderBottom: i < cellInfo.leases.length - 1 ? '1px solid rgba(255,255,255,0.2)' : 'none', paddingBottom: i < cellInfo.leases.length - 1 ? 8 : 0 }}>
              <div style={{ fontWeight: 600 }}>{l.tenant_name}</div>
              {l.phone && <div style={{ fontSize: 11, opacity: 0.85 }}>{l.phone}</div>}
              <div style={{ fontSize: 11 }}>
                {ls.format('DD MMM YYYY')} — {le ? le.format('DD MMM YYYY') : 'Open-ended'}
              </div>
              {leaseMonths !== null && <div style={{ fontSize: 11 }}>{leaseMonths} month{leaseMonths !== 1 ? 's' : ''}</div>}
              <div style={{ fontSize: 11 }}>${Number(l.amount || 0).toLocaleString()}/mo</div>
              {isMovingIn && <div style={{ fontSize: 11, color: '#52c41a', fontWeight: 600 }}>Moving In: {ls.format('DD MMM')}</div>}
              {isMovingOut && <div style={{ fontSize: 11, color: '#ff4d4f', fontWeight: 600 }}>Moving Out: {le.format('DD MMM')}</div>}
            </div>
          );
        })}
      </div>
    );
  };

  // Get the primary tenant name to display in the cell
  const getCellLabel = (cellInfo, month) => {
    if (cellInfo.leases.length === 0) return '';
    // Show the lease that covers most of this month
    const monthStart = month.startOf('month');
    const monthEnd = month.endOf('month');
    let best = cellInfo.leases[0];
    let bestDays = 0;
    for (const l of cellInfo.leases) {
      const ls = toDate(l.start_date);
      const le = l.end_date ? toDate(l.end_date) : monthEnd;
      const start = ls.isAfter(monthStart) ? ls : monthStart;
      const end = le.isBefore(monthEnd) ? le : monthEnd;
      const days = end.diff(start, 'day') + 1;
      if (days > bestDays) { bestDays = days; best = l; }
    }
    const ct = CONTRACT_TYPE_MAP[best.contract_type];
    return ct ? `${best.tenant_name} (${ct})` : best.tenant_name;
  };

  const headerHeight = 36;
  const rowHeight = 36;
  const unitColWidth = 220;
  const tenantColWidth = 160;
  const endDateColWidth = 80;
  const statusColWidth = 60;

  return (
    <MainLayout>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ marginBottom: 16 }}>Lease Calendar</h1>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <DatePicker.RangePicker
            value={dateRange}
            onChange={(val) => { if (val && val[0] && val[1]) setDateRange([val[0].startOf('month'), val[1].endOf('month')]); }}
            style={{ width: 260 }}
          />
          <Select
            placeholder="All Properties"
            allowClear
            showSearch
            optionFilterProp="children"
            value={propertyFilter}
            onChange={setPropertyFilter}
            style={{ width: 220 }}
          >
            {properties.map(p => (
              <Select.Option key={p.id} value={p.id}>{p.display_name}</Select.Option>
            ))}
          </Select>
          <Select
            placeholder="All Units"
            allowClear
            showSearch
            optionFilterProp="children"
            value={unitFilter}
            onChange={setUnitFilter}
            style={{ width: 160 }}
          >
            {filteredUnits.map(u => (
              <Select.Option key={u.id} value={u.id}>{u.name}{u.property_name ? ` (${u.property_name})` : ''}</Select.Option>
            ))}
          </Select>
          <Select
            placeholder="All Statuses"
            allowClear
            value={statusFilter}
            onChange={setStatusFilter}
            style={{ width: 180 }}
          >
            <Select.Option value="occupied">Occupied</Select.Option>
            <Select.Option value="vacant">Vacant</Select.Option>
            <Select.Option value="booked">Booked</Select.Option>
            <Select.Option value="gap">Gap</Select.Option>
            <Select.Option value="expiring">Expiring</Select.Option>
          </Select>
          <Input
            placeholder="Search tenant..."
            prefix={<SearchOutlined />}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onPressEnter={loadData}
            allowClear
            style={{ width: 200 }}
          />
        </div>
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', gap: 20, marginBottom: 12, fontSize: 12 }}>
        <span><span style={{ display: 'inline-block', width: 14, height: 14, background: '#52c41a30', border: '1px solid #52c41a', borderRadius: 2, marginRight: 4, verticalAlign: 'middle' }} /> Booked</span>
        <span><span style={{ display: 'inline-block', width: 14, height: 14, background: '#faad1440', border: '1px solid #faad14', borderRadius: 2, marginRight: 4, verticalAlign: 'middle' }} /> Gap Between Leases</span>
        <span><span style={{ display: 'inline-block', width: 14, height: 14, background: '#ff4d4f30', border: '1px solid #ff4d4f', borderRadius: 2, marginRight: 4, verticalAlign: 'middle' }} /> Expiring (No Next Lease)</span>
        <span><span style={{ display: 'inline-block', width: 14, height: 14, background: '#fff', border: '1px solid #d9d9d9', borderRadius: 2, marginRight: 4, verticalAlign: 'middle' }} /> Vacant</span>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 60 }}><Spin size="large" /></div>
      ) : filteredData.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 60, color: '#999' }}>No units found</div>
      ) : (
        <div style={{ overflowX: 'auto', border: '1px solid #e8e8e8', borderRadius: 4 }}>
          <table style={{ borderCollapse: 'collapse', width: 'max-content', minWidth: '100%' }}>
            <thead>
              <tr style={{ background: '#fafafa' }}>
                <th style={{ position: 'sticky', left: 0, zIndex: 2, background: '#fafafa', padding: '8px 12px', borderBottom: '2px solid #e8e8e8', borderRight: '1px solid #e8e8e8', textAlign: 'left', fontSize: 12, fontWeight: 700, width: unitColWidth, minWidth: unitColWidth }}>
                  PROPERTY / UNIT
                </th>
                <th style={{ position: 'sticky', left: unitColWidth, zIndex: 2, background: '#fafafa', padding: '8px 12px', borderBottom: '2px solid #e8e8e8', borderRight: '1px solid #e8e8e8', textAlign: 'left', fontSize: 12, fontWeight: 700, width: tenantColWidth, minWidth: tenantColWidth }}>
                  TENANT
                </th>
                <th style={{ position: 'sticky', left: unitColWidth + tenantColWidth, zIndex: 2, background: '#fafafa', padding: '8px 12px', borderBottom: '2px solid #e8e8e8', borderRight: '1px solid #e8e8e8', textAlign: 'left', fontSize: 12, fontWeight: 700, width: endDateColWidth, minWidth: endDateColWidth }} />
                <th style={{ position: 'sticky', left: unitColWidth + tenantColWidth + endDateColWidth, zIndex: 2, background: '#fafafa', padding: '8px 12px', borderBottom: '2px solid #e8e8e8', borderRight: '1px solid #e8e8e8', textAlign: 'left', fontSize: 12, fontWeight: 700, width: statusColWidth, minWidth: statusColWidth }} />
                <th style={{ position: 'sticky', left: unitColWidth + tenantColWidth + endDateColWidth + statusColWidth, zIndex: 2, background: '#fafafa', padding: '8px 12px', borderBottom: '2px solid #e8e8e8', borderRight: '2px solid #e8e8e8', textAlign: 'right', fontSize: 12, fontWeight: 700, minWidth: 80 }}>
                  RENT
                </th>
                {months.map((m, i) => {
                  const isCurrentMonth = m.isSame(dayjs(), 'month');
                  return (
                    <th key={i} style={{ padding: '8px 12px', borderBottom: '2px solid #e8e8e8', borderRight: '1px solid #f0f0f0', textAlign: 'center', fontSize: 12, fontWeight: 600, minWidth: 130, background: isCurrentMonth ? '#e6f7ff' : '#fafafa' }}>
                      {m.format('D MMM YYYY')}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {/* Count row */}
              <tr style={{ background: '#fafafa', borderBottom: '2px solid #e8e8e8' }}>
                <td colSpan={5} style={{ position: 'sticky', left: 0, zIndex: 1, background: '#fafafa', padding: '4px 12px', borderRight: '2px solid #e8e8e8', fontSize: 11, fontWeight: 600, color: '#666' }}>
                  {statusFilter ? `${statusFilter.charAt(0).toUpperCase() + statusFilter.slice(1)} Count` : 'Unit Count'}
                </td>
                {months.map((m, mi) => {
                  let count = 0;
                  filteredData.forEach(prop => {
                    prop.units.forEach(unit => {
                      const cellInfo = getCellInfo(unit, m);
                      if (!statusFilter || cellInfo.status === statusFilter ||
                          (statusFilter === 'occupied' && cellInfo.leases.length > 0) ||
                          (statusFilter === 'vacant' && cellInfo.leases.length === 0)) {
                        count++;
                      }
                    });
                  });
                  const isCurrentMonth = m.isSame(dayjs(), 'month');
                  return (
                    <td key={mi} style={{ padding: '4px 8px', borderRight: '1px solid #f0f0f0', fontSize: 11, fontWeight: 600, textAlign: 'center', color: '#333', background: isCurrentMonth ? '#e6f7ff' : '#fafafa' }}>
                      {count}
                    </td>
                  );
                })}
              </tr>
              {filteredData.map((prop) => (
                prop.units.map((unit, ui) => (
                  <tr key={unit.id} style={{ borderBottom: '1px solid #f0f0f0' }}>
                    <td style={{ position: 'sticky', left: 0, zIndex: 1, background: '#fff', padding: '6px 12px', borderRight: '1px solid #e8e8e8', borderBottom: '1px solid #f0f0f0', fontSize: 12, whiteSpace: 'nowrap' }}>
                      <span style={{ fontWeight: 600 }}>{prop.name}</span>
                      <span style={{ color: '#999', marginLeft: 6 }}>— {unit.name}</span>
                    </td>
                    <td style={{ position: 'sticky', left: unitColWidth, zIndex: 1, background: '#fff', padding: '6px 12px', borderRight: '1px solid #e8e8e8', borderBottom: '1px solid #f0f0f0', fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: tenantColWidth }}>
                      {unit.current_tenant
                        ? <span>{unit.current_tenant}</span>
                        : <span style={{ color: '#ccc' }}>—</span>}
                    </td>
                    <td style={{ position: 'sticky', left: unitColWidth + tenantColWidth, zIndex: 1, background: '#fff', padding: '6px 12px', borderRight: '1px solid #e8e8e8', borderBottom: '1px solid #f0f0f0', fontSize: 12, whiteSpace: 'nowrap', color: '#999', width: endDateColWidth, minWidth: endDateColWidth }}>
                      {unit.current_tenant && unit.current_end_date
                        ? toDate(unit.current_end_date).format('MMM D').toUpperCase()
                        : ''}
                    </td>
                    <td style={{ position: 'sticky', left: unitColWidth + tenantColWidth + endDateColWidth, zIndex: 1, background: '#fff', padding: '6px 12px', borderRight: '1px solid #e8e8e8', borderBottom: '1px solid #f0f0f0', fontSize: 12, whiteSpace: 'nowrap', color: '#999', width: statusColWidth, minWidth: statusColWidth }}>
                      {unit.current_tenant && CONTRACT_TYPE_MAP[unit.current_contract_type]
                        ? <Tooltip title={CONTRACT_TYPE_LABEL[unit.current_contract_type] ? `Tenant Status: ${CONTRACT_TYPE_LABEL[unit.current_contract_type]} (${CONTRACT_TYPE_MAP[unit.current_contract_type]})` : 'No tenant status set'}>
                            <span>{CONTRACT_TYPE_MAP[unit.current_contract_type]}</span>
                          </Tooltip>
                        : ''}
                    </td>
                    <td style={{ position: 'sticky', left: unitColWidth + tenantColWidth + endDateColWidth + statusColWidth, zIndex: 1, background: '#fff', padding: '6px 12px', borderRight: '2px solid #e8e8e8', borderBottom: '1px solid #f0f0f0', fontSize: 12, textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {unit.current_rent ? `$${Number(unit.current_rent).toLocaleString()}` : <span style={{ color: '#ccc' }}>—</span>}
                    </td>
                    {months.map((m, mi) => {
                      const cellInfo = getCellInfo(unit, m);
                      const label = getCellLabel(cellInfo, m);
                      const isCurrentMonth = m.isSame(dayjs(), 'month');
                      return (
                        <Tooltip key={mi} title={renderTooltip(cellInfo, unit, m)} placement="top">
                          <td style={{
                            padding: '6px 8px',
                            borderRight: '1px solid #f0f0f0',
                            borderBottom: '1px solid #f0f0f0',
                            background: cellInfo.color,
                            fontSize: 11,
                            cursor: cellInfo.leases.length > 0 ? 'pointer' : 'default',
                            textAlign: 'center',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            maxWidth: 130,
                            outline: isCurrentMonth ? '2px solid #1677ff20' : 'none',
                          }}>
                            {label}
                          </td>
                        </Tooltip>
                      );
                    })}
                  </tr>
                ))
              ))}
            </tbody>
          </table>
        </div>
      )}
    </MainLayout>
  );
}

export default function LeasingCalendarPage() {
  return <Suspense fallback={<div />}><CalendarInner /></Suspense>;
}
