'use client';

import { useEffect, useLayoutEffect, useRef, useState, useMemo, Suspense } from 'react';
import { Select, Spin, Input, DatePicker, Tooltip } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import Link from 'next/link';
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
  const [statusFilter, setStatusFilter] = useState(null);        // occupancy
  const [renewalFilter, setRenewalFilter] = useState(null);      // contract_type (MR/MTM/NR/UC)
  const [leaseStatusFilter, setLeaseStatusFilter] = useState(null); // pending / unconfirmed / deposit_due
  const [dateRange, setDateRange] = useState([
    dayjs().subtract(1, 'month').startOf('month'),
    dayjs().add(6, 'month').endOf('month'),
  ]);

  // ── Sticky header plumbing ────────────────────────────────────────────────
  // The month header and the Unit Count row must stay readable while scrolling
  // through 118 units. Two things make that harder than `position: sticky` alone:
  //
  //  1. The table wrapper sets `overflow-x: auto`. Per CSS overflow rules a
  //     `visible` value on the other axis computes to `auto`, so the wrapper is
  //     ALREADY a scroll container — a sticky thead inside it sticks to the
  //     wrapper, not the viewport, and the wrapper's height is unconstrained, so
  //     it would scroll away with the page and appear not to work at all. The
  //     wrapper is therefore given a viewport-relative max height and becomes the
  //     vertical scroller too. A side benefit: the page itself stops scrolling,
  //     so the filters, legend and marker key above stay put without needing to
  //     be sticky at all.
  //  2. The count row sits BELOW the header row, so its offset is the header's
  //     rendered height. That is font- and zoom-dependent, so it is measured
  //     rather than guessed — a hard-coded value leaves a gap or an overlap the
  //     moment the browser font size differs from ours.
  const theadRef = useRef(null);
  const [countRowTop, setCountRowTop] = useState(0);

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

    // Pending overrides everything — staff need to see pending leases first
    // (they require action). Multiple pending can overlap pending, but if any
    // lease in this cell is pending, the cell renders yellow.
    const hasPending = overlapping.some(l => l.lease_state === 'pending');

    // Determine color
    let color;
    if (hasPending) {
      color = '#faad1440'; // yellow — pending lease in this cell
    } else if (expiringNoNext) {
      color = '#ff4d4f30'; // red — expiring, no next lease
    } else if (hasGap) {
      // Light blue — gap between leases. Was orange (#fa8c16), which sat one hue
      // away from the unconfirmed-lease yellow (#faad14) and was hard to tell
      // apart in a dense grid. Blue is unambiguous against green/yellow/red.
      color = '#1677ff30';
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
      status: hasPending ? 'pending' : expiringNoNext ? 'expiring' : hasGap ? 'gap' : 'booked',
      leases: overlapping,
    };
  };

  // Does any lease on this unit (within the shown window) match the lease-status
  // filter? Mirrors the tooltip markers exactly, so what you filter on is what
  // you see: a DRAFT lease is 'unconfirmed', a lease out for e-signature is
  // 'pending' (the API's `unconfirmed` flag covers both, hence the draft test).
  const matchesLeaseStatus = (unit, want) => {
    return (unit.leases || []).some(l => {
      const isDraft = l.lease_state === 'pending';
      if (want === 'unconfirmed') return isDraft;
      if (want === 'pending') return !isDraft && !!l.unconfirmed;
      if (want === 'deposit_due') return !!l.deposit_pending;
      if (want === 'paperwork_gap') return !!l.paperwork_gap;
      return false;
    });
  };

  const matchesRenewal = (unit, want) => {
    return (unit.leases || []).some(l => Number(l.contract_type) === Number(want));
  };

  // Occupancy + renewal status + lease status all narrow together (AND).
  const filteredData = useMemo(() => {
    if (!statusFilter && !renewalFilter && !leaseStatusFilter) return data;
    return data.map(prop => {
      const units = prop.units.filter(unit => {
        if (renewalFilter && !matchesRenewal(unit, renewalFilter)) return false;
        if (leaseStatusFilter && !matchesLeaseStatus(unit, leaseStatusFilter)) return false;
        if (!statusFilter) return true;

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
  }, [data, statusFilter, renewalFilter, leaseStatusFilter, dateRange, months]);

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
              <div style={{ fontWeight: 600 }}>
                {/* A DRAFT lease (lease_state 'pending') reads as *UNCONFIRMED* —
                    nothing about it is agreed yet. A lease that is out for
                    e-signature reads as *PENDING* — it's agreed and awaiting ink.
                    The backend's `unconfirmed` flag covers BOTH cases, so the
                    draft check has to come first. */}
                {l.lease_state === 'pending' && (
                  <span style={{ color: '#ffd666', fontWeight: 700, marginRight: 4 }}>*UNCONFIRMED*</span>
                )}
                {l.lease_state !== 'pending' && l.unconfirmed && (
                  <span style={{ color: '#ffd666', fontWeight: 700, marginRight: 4 }}>*PENDING*</span>
                )}
                {l.deposit_pending && (
                  <span style={{ color: '#ff7875', fontWeight: 700, marginRight: 4 }}>*DEPOSIT DUE*</span>
                )}
                {/* The term runs a month or more past the last signed document —
                    an extension that was never papered. */}
                {l.paperwork_gap && (
                  <span style={{ color: '#ffa940', fontWeight: 700, marginRight: 4 }}>*UNSIGNED PERIOD*</span>
                )}
                {l.tenant_name}
              </div>
              {l.phone && <div style={{ fontSize: 11, opacity: 0.85 }}>{l.phone}</div>}
              <div style={{ fontSize: 11 }}>
                {ls.format('DD MMM YYYY')} — {le ? le.format('DD MMM YYYY') : 'Open-ended'}
              </div>
              {leaseMonths !== null && <div style={{ fontSize: 11 }}>{leaseMonths} month{leaseMonths !== 1 ? 's' : ''}</div>}
              <div style={{ fontSize: 11 }}>${Number(l.amount || 0).toLocaleString()}/mo</div>
              {isMovingIn && <div style={{ fontSize: 11, color: '#52c41a', fontWeight: 600 }}>Moving In: {ls.format('DD MMM')}</div>}
              {isMovingOut && <div style={{ fontSize: 11, color: '#ff4d4f', fontWeight: 600 }}>Moving Out: {le.format('DD MMM')}</div>}
              {l.moved_out_early && <div style={{ fontSize: 11, color: '#ffd666' }}>Moved out early</div>}
              {l.moveout_notes && <div style={{ fontSize: 11, opacity: 0.85, whiteSpace: 'pre-wrap' }}>Note: {l.moveout_notes}</div>}
            </div>
          );
        })}
      </div>
    );
  };

  // Get the primary tenant name to display in the cell, plus the lease id for linking
  const getCellLabel = (cellInfo, month) => {
    if (cellInfo.leases.length === 0) return { text: '', leaseId: null };
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
    // Prefix the tenant name when the most-overlapping lease in this cell is a
    // draft — matches the tooltip's wording.
    const prefix = best.lease_state === 'pending' ? '*UNCONFIRMED* ' : '';
    const text = ct ? `${prefix}${best.tenant_name} (${ct})` : `${prefix}${best.tenant_name}`;
    return { text, leaseId: best.id || null };
  };

  const unitColWidth = 220;
  const tenantColWidth = 160;
  const endDateColWidth = 80;
  const statusColWidth = 60;

  // Measure the header row so the count row can sit exactly beneath it. A layout
  // effect, so the offset lands before paint rather than a frame late (which
  // shows as a visible jump). ResizeObserver keeps it right when the month
  // columns rewrap on a resize or zoom; the guard is for environments without
  // it, where the mount measurement alone is close enough.
  useLayoutEffect(() => {
    const el = theadRef.current;
    if (!el) return undefined;
    const measure = () => setCountRowTop(el.getBoundingClientRect().height || 0);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [loading, months.length]);

  return (
    <MainLayout>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ marginBottom: 16 }}>Lease Calendar</h1>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <DatePicker.RangePicker
            value={dateRange}
            onChange={(val) => { if (val && val[0] && val[1]) setDateRange([val[0], val[1]]); }}
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
          {/* Occupancy — what the cell colours mean. Was labelled "All Statuses",
              which read as if it filtered renewal status. */}
          <Select
            placeholder="All Occupancy"
            allowClear
            value={statusFilter}
            onChange={setStatusFilter}
            style={{ width: 160 }}
          >
            <Select.Option value="occupied">Occupied</Select.Option>
            <Select.Option value="vacant">Vacant</Select.Option>
            <Select.Option value="booked">Booked</Select.Option>
            <Select.Option value="gap">Gap</Select.Option>
            <Select.Option value="expiring">Expiring</Select.Option>
          </Select>
          {/* Renewal intent — the MR/MTM/NR/UC already shown in its own column. */}
          <Select
            placeholder="All Renewal Status"
            allowClear
            value={renewalFilter}
            onChange={setRenewalFilter}
            style={{ width: 180 }}
          >
            {/* "UC" is renewal-intent Unconfirmed — spelled out so it can't be
                confused with the Lease Status "Unconfirmed (draft)" beside it. */}
            {Object.entries(CONTRACT_TYPE_LABEL).map(([value, label]) => (
              <Select.Option key={value} value={Number(value)}>
                {CONTRACT_TYPE_MAP[value]} ({Number(value) === 4 ? 'Renewal unconfirmed' : label})
              </Select.Option>
            ))}
          </Select>
          {/* Lease status — the tooltip markers, now filterable. */}
          <Select
            placeholder="Lease Status"
            allowClear
            value={leaseStatusFilter}
            onChange={setLeaseStatusFilter}
            style={{ width: 190 }}
          >
            <Select.Option value="pending">Pending (awaiting e-sign)</Select.Option>
            <Select.Option value="unconfirmed">Unconfirmed (draft)</Select.Option>
            <Select.Option value="deposit_due">Deposit Due</Select.Option>
            <Select.Option value="paperwork_gap">Paperwork gap</Select.Option>
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
        <span><span style={{ display: 'inline-block', width: 14, height: 14, background: '#1677ff30', border: '1px solid #1677ff', borderRadius: 2, marginRight: 4, verticalAlign: 'middle' }} /> Gap Between Leases</span>
        <span><span style={{ display: 'inline-block', width: 14, height: 14, background: '#ff4d4f30', border: '1px solid #ff4d4f', borderRadius: 2, marginRight: 4, verticalAlign: 'middle' }} /> Expiring (No Next Lease)</span>
        <span><span style={{ display: 'inline-block', width: 14, height: 14, background: '#faad1440', border: '1px solid #faad14', borderRadius: 2, marginRight: 4, verticalAlign: 'middle' }} /> Unconfirmed Lease</span>
        <span><span style={{ display: 'inline-block', width: 14, height: 14, background: '#fff', border: '1px solid #d9d9d9', borderRadius: 2, marginRight: 4, verticalAlign: 'middle' }} /> Vacant</span>
      </div>
      <div style={{ marginBottom: 12, fontSize: 12, color: '#666' }}>
        Hover a cell for details. Markers: <span style={{ color: '#d48806', fontWeight: 700 }}>*UNCONFIRMED*</span> draft lease, not yet confirmed · <span style={{ color: '#d48806', fontWeight: 700 }}>*PENDING*</span> awaiting e-signature · <span style={{ color: '#ff4d4f', fontWeight: 700 }}>*DEPOSIT DUE*</span> deposit invoice unpaid · <span style={{ color: '#d46b08', fontWeight: 700 }}>*UNSIGNED PERIOD*</span> term runs past its paperwork
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 60 }}><Spin size="large" /></div>
      ) : filteredData.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 60, color: '#999' }}>No units found</div>
      ) : (
        /* The vertical scroller. Capped against the viewport so the table scrolls
           inside itself instead of scrolling the page — which is what keeps the
           filters, legend and marker key above permanently visible, and what makes
           position:sticky on the header meaningful (see the note by countRowTop).
           The floor stops the grid collapsing to a couple of rows on a short window
           or when the browser chrome is deep. */
        <div style={{ overflow: 'auto', maxHeight: 'calc(100vh - 330px)', minHeight: 300, border: '1px solid #e8e8e8', borderRadius: 4 }}>
          <table style={{ borderCollapse: 'separate', borderSpacing: 0, width: 'max-content', minWidth: '100%' }}>
            <thead ref={theadRef}>
              <tr style={{ background: '#fafafa' }}>
                <th style={{ position: 'sticky', top: 0, left: 0, zIndex: 5, background: '#fafafa', padding: '8px 12px', borderBottom: '2px solid #e8e8e8', borderRight: '1px solid #e8e8e8', textAlign: 'left', fontSize: 12, fontWeight: 700, width: unitColWidth, minWidth: unitColWidth }}>
                  PROPERTY / UNIT
                </th>
                <th style={{ position: 'sticky', top: 0, left: unitColWidth, zIndex: 5, background: '#fafafa', padding: '8px 12px', borderBottom: '2px solid #e8e8e8', borderRight: '1px solid #e8e8e8', textAlign: 'left', fontSize: 12, fontWeight: 700, width: tenantColWidth, minWidth: tenantColWidth }}>
                  TENANT
                </th>
                <th style={{ position: 'sticky', top: 0, left: unitColWidth + tenantColWidth, zIndex: 5, background: '#fafafa', padding: '8px 12px', borderBottom: '2px solid #e8e8e8', borderRight: '1px solid #e8e8e8', textAlign: 'left', fontSize: 12, fontWeight: 700, width: endDateColWidth, minWidth: endDateColWidth }} />
                <th style={{ position: 'sticky', top: 0, left: unitColWidth + tenantColWidth + endDateColWidth, zIndex: 5, background: '#fafafa', padding: '8px 12px', borderBottom: '2px solid #e8e8e8', borderRight: '1px solid #e8e8e8', textAlign: 'left', fontSize: 12, fontWeight: 700, width: statusColWidth, minWidth: statusColWidth }} />
                <th style={{ position: 'sticky', top: 0, left: unitColWidth + tenantColWidth + endDateColWidth + statusColWidth, zIndex: 5, background: '#fafafa', padding: '8px 12px', borderBottom: '2px solid #e8e8e8', borderRight: '2px solid #e8e8e8', textAlign: 'right', fontSize: 12, fontWeight: 700, minWidth: 80 }}>
                  RENT
                </th>
                {months.map((m, i) => {
                  const isCurrentMonth = m.isSame(dayjs(), 'month');
                  return (
                    <th key={i} style={{ position: 'sticky', top: 0, zIndex: 4, padding: '8px 12px', borderBottom: '2px solid #e8e8e8', borderRight: '1px solid #f0f0f0', textAlign: 'center', fontSize: 12, fontWeight: 600, minWidth: 130, background: isCurrentMonth ? '#e6f7ff' : '#fafafa' }}>
                      {m.format('D MMM YYYY')}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {/* Count row — pinned directly under the month header. It stays in the
                  tbody rather than moving into the thead so the colSpan={5} label keeps
                  spanning the frozen columns; `top` is the measured header height so
                  the two rows meet exactly. */}
              <tr style={{ background: '#fafafa', borderBottom: '2px solid #e8e8e8' }}>
                <td colSpan={5} style={{ position: 'sticky', top: countRowTop, left: 0, zIndex: 3, background: '#fafafa', padding: '4px 12px', borderRight: '2px solid #e8e8e8', borderBottom: '2px solid #e8e8e8', fontSize: 11, fontWeight: 600, color: '#666' }}>
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
                    <td key={mi} style={{ position: 'sticky', top: countRowTop, zIndex: 2, padding: '4px 8px', borderRight: '1px solid #f0f0f0', borderBottom: '2px solid #e8e8e8', fontSize: 11, fontWeight: 600, textAlign: 'center', color: '#333', background: isCurrentMonth ? '#e6f7ff' : '#fafafa' }}>
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
                        ? (unit.current_lease_id
                            ? <Link href={`/leasing/${unit.current_lease_id}/detail`} style={{ color: '#1890ff' }}>{unit.current_tenant}</Link>
                            : <span>{unit.current_tenant}</span>)
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
                            {label.text && label.leaseId
                              ? <Link href={`/leasing/${label.leaseId}/detail`} style={{ color: 'inherit', textDecoration: 'none' }}>{label.text}</Link>
                              : label.text}
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
