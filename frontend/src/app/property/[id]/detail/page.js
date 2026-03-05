'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Button, Spin, Tag, Space, message, Tabs, Modal, Dropdown } from 'antd';
import {
  ArrowLeftOutlined, PlusOutlined, HomeOutlined, UserOutlined,
  RightOutlined, EditOutlined, DeleteOutlined, CopyOutlined, EllipsisOutlined,
} from '@ant-design/icons';
import MainLayout from '../../../../components/Layout';
import { property, accounting } from '../../../../lib/api';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

// ---------------------------------------------------------------------------
// Simple SVG Line Chart
// ---------------------------------------------------------------------------
function FinancialChart({ data }) {
  if (!data || data.length === 0) {
    return <div style={{ color: '#999', padding: 20, textAlign: 'center' }}>No financial data available</div>;
  }
  const width = 500, height = 180;
  const padding = { top: 20, right: 20, bottom: 40, left: 65 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;
  const values = data.map(d => Number(d.paid) || 0);
  const maxVal = Math.max(...values, 1);
  const range = maxVal || 1;
  const points = data.map((d, i) => ({
    x: padding.left + (i / Math.max(data.length - 1, 1)) * chartW,
    y: padding.top + chartH - (Number(d.paid) / range) * chartH,
    ...d,
  }));
  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
  const tickCount = 4;
  const yTicks = Array.from({ length: tickCount + 1 }, (_, i) => ({
    val: (range / tickCount) * i,
    y: padding.top + chartH - (i / tickCount) * chartH,
  }));
  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: 'auto' }}>
      {yTicks.map((tick, i) => (
        <g key={i}>
          <line x1={padding.left} y1={tick.y} x2={width - padding.right} y2={tick.y} stroke="#f0f0f0" strokeWidth="1" />
          <text x={padding.left - 8} y={tick.y + 4} textAnchor="end" fontSize="9" fill="#999">
            {tick.val >= 1000000 ? (tick.val / 1000000).toFixed(1) + 'M' : tick.val >= 1000 ? (tick.val / 1000).toFixed(0) + 'K' : tick.val.toFixed(0)}
          </text>
        </g>
      ))}
      <path d={linePath} fill="none" stroke="#1890ff" strokeWidth="2" />
      {points.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r="3" fill="#1890ff" />)}
      {points.map((p, i) => (
        <text key={i} x={p.x} y={height - 8} textAnchor="middle" fontSize="8" fill="#999">
          {p.month?.substring(2, 7) || ''}
        </text>
      ))}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Occupancy Donut
// ---------------------------------------------------------------------------
function OccupancyDonut({ occupied, vacant, total }) {
  const pct = total > 0 ? Math.round((occupied / total) * 100) : 0;
  const circumference = 2 * Math.PI * 40;
  const occupiedDash = (pct / 100) * circumference;
  return (
    <div style={{ textAlign: 'center' }}>
      <svg viewBox="0 0 100 100" style={{ width: 120, height: 120 }}>
        <circle cx="50" cy="50" r="40" fill="none" stroke="#f0f0f0" strokeWidth="8" />
        <circle cx="50" cy="50" r="40" fill="none" stroke="#1890ff" strokeWidth="8"
          strokeDasharray={`${occupiedDash} ${circumference}`}
          strokeDashoffset="0" transform="rotate(-90 50 50)" strokeLinecap="round" />
        <text x="50" y="46" textAnchor="middle" fontSize="10" fill="#1890ff" fontWeight="600">OCCUPIED</text>
        <text x="50" y="60" textAnchor="middle" fontSize="12" fill="#1890ff" fontWeight="700">{pct.toFixed(2)} %</text>
      </svg>
      <div style={{ display: 'flex', justifyContent: 'center', gap: 12, marginTop: 8, fontSize: 11 }}>
        <span><span style={{ display: 'inline-block', width: 8, height: 8, background: '#1890ff', borderRadius: 2, marginRight: 4 }} />{occupied} OCCUPIED</span>
        <span><span style={{ display: 'inline-block', width: 8, height: 8, background: '#faad14', borderRadius: 2, marginRight: 4 }} />{vacant} VACANT</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Unit Card Row
// ---------------------------------------------------------------------------
function UnitCard({ unit, propertyId, router }) {
  const isOccupied = unit.status === 1;
  const tenantName = [unit.tenant_first_name, unit.tenant_last_name].filter(Boolean).join(' ');
  const sizeText = unit.size ? `${unit.size} ${unit.size_unit || 'sqft'}` : '';
  return (
    <div style={{ display: 'flex', alignItems: 'center', padding: '14px 20px', gap: 16, borderBottom: '1px solid #f0f0f0' }}>
      <div style={{ width: 56, height: 45, borderRadius: 6, overflow: 'hidden', flexShrink: 0, background: '#f5f5f5', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {unit.photo
          ? <img src={`${API_URL}/api/file/preview/${unit.photo}`} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          : <HomeOutlined style={{ fontSize: 20, color: '#ccc' }} />}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>{unit.name}</span>
          <Tag color={isOccupied ? 'red' : 'green'} style={{ fontSize: 11, lineHeight: '18px' }}>{isOccupied ? 'Occupied' : 'Vacant'}</Tag>
        </div>
        <div style={{ color: '#888', fontSize: 12 }}>{unit.type ? unit.type.charAt(0).toUpperCase() + unit.type.slice(1) : 'Apartment'}</div>
        <div style={{ color: '#666', fontSize: 12, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {sizeText && <span>Room Size: <strong>{sizeText}</strong></span>}
          <span>Bedrooms: <strong>{unit.beds ?? '-'}</strong></span>
          <span>Bathrooms: <strong>{unit.baths ?? '-'}</strong></span>
        </div>
      </div>
      <div style={{ textAlign: 'center', minWidth: 100 }}>
        <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>Tenant</div>
        {tenantName ? (
          <>
            <div style={{ width: 36, height: 36, borderRadius: '50%', background: '#fff1f0', border: '2px solid #ff4d4f', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 4px' }}>
              <UserOutlined style={{ fontSize: 14, color: '#ff4d4f' }} />
            </div>
            <div style={{ fontSize: 11, color: '#333' }}>{tenantName}</div>
          </>
        ) : <div style={{ color: '#ccc', fontSize: 24 }}>—</div>}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
        <Button size="small" style={{ fontSize: 11, width: 100 }}>Add Listing</Button>
        <Button size="small" style={{ fontSize: 11, width: 100 }} onClick={() => router.push(`/leasing/create?unit=${unit.id}&property=${propertyId}`)}>Create Lease</Button>
        <Button size="small" type="primary" ghost style={{ fontSize: 11, width: 100 }} onClick={() => router.push(`/property/${propertyId}/unit/${unit.id}`)}>View Unit <RightOutlined style={{ fontSize: 9 }} /></Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Property Information tab
// ---------------------------------------------------------------------------
function PropertyInfoTab({ propertyData, amenities }) {
  const SectionHeader = ({ title }) => (
    <div style={{ fontSize: 11, fontWeight: 700, color: '#888', letterSpacing: 1, marginBottom: 14, marginTop: 28, borderBottom: '1px solid #f0f0f0', paddingBottom: 6 }}>
      {title}
    </div>
  );

  return (
    <div style={{ padding: '4px 20px 32px' }}>

      {/* General Information */}
      <SectionHeader title="GENERAL INFORMATION" />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '18px 24px' }}>
        {[
          { label: 'PROPERTY NAME',   value: propertyData.display_name },
          { label: 'YEAR BUILT',      value: propertyData.year_of_built },
          { label: 'PROPERTY ID',     value: propertyData.mls },
          { label: 'TYPE',            value: propertyData.type === 2 ? 'Commercial' : 'Residential' },
          { label: 'ADDRESS',         value: propertyData.street_address },
          { label: 'DISTRICT',        value: propertyData.district },
          { label: 'CITY',            value: propertyData.city },
          { label: 'STATE / PROVINCE',value: propertyData.state },
          { label: 'COUNTRY',         value: propertyData.country },
          { label: 'CURRENCY',        value: propertyData.currency },
          { label: 'STATUS',          value: null, custom: (
            <Tag color={propertyData.status === 1 ? 'green' : 'red'}>
              {propertyData.status === 1 ? 'Active' : 'Inactive'}
            </Tag>
          )},
        ].map(({ label, value, custom }) => (
          <div key={label}>
            <div style={{ color: '#aaa', fontSize: 11, marginBottom: 3 }}>{label}</div>
            {custom || <div style={{ fontWeight: 500, fontSize: 13 }}>{value || '—'}</div>}
          </div>
        ))}
      </div>

      {/* Property Amenities — show only selected amenities */}
      <SectionHeader title="PROPERTY AMENITIES" />
      {(() => {
        const selected = amenities.filter(a => Number(a.selected) === 1);
        return selected.length === 0 ? (
          <div style={{ color: '#bbb', fontSize: 13 }}>No amenities selected.</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px 0' }}>
            {selected.map(a => (
              <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                <span style={{ color: '#52c41a', fontWeight: 700, fontSize: 15 }}>✓</span>
                <span style={{ color: '#333' }}>{a.display_name}</span>
              </div>
            ))}
          </div>
        );
      })()}

      {/* Payment Instructions */}
      <SectionHeader title="PAYMENT INSTRUCTIONS" />
      <div style={{ color: propertyData.payment_instructions ? '#333' : '#bbb', fontSize: 13, whiteSpace: 'pre-wrap' }}>
        {propertyData.payment_instructions || '—'}
      </div>

      {/* Attachments */}
      <SectionHeader title="ATTACHMENTS" />
      <div style={{ color: '#bbb', fontSize: 13 }}>—</div>

      {/* Notes */}
      <SectionHeader title="NOTES" />
      <div style={{ color: propertyData.notes ? '#333' : '#bbb', fontSize: 13, whiteSpace: 'pre-wrap' }}>
        {propertyData.notes || '—'}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Property Detail page
// ---------------------------------------------------------------------------
export default function PropertyDetailPage() {
  const router = useRouter();
  const params = useParams();
  const [loading, setLoading] = useState(true);
  const [propertyData, setPropertyData] = useState(null);
  const [units, setUnits] = useState([]);
  const [graphData, setGraphData] = useState([]);
  const [amenities, setAmenities] = useState([]);

  useEffect(() => {
    if (params.id) loadAll();
  }, [params.id]);

  const loadAll = async () => {
    try {
      setLoading(true);
      const [propRes, unitsRes, graphRes, amenitiesRes] = await Promise.all([
        property.get(params.id),
        property.getUnits(params.id),
        accounting.getPropertyGraph(params.id, { months: 12 }).catch(() => ({ data: { data: [] } })),
        property.getPropertyAmenities(params.id).catch(() => ({ data: { data: [] } })),
      ]);
      if (propRes.data.code === 200) setPropertyData(propRes.data.data);
      if (unitsRes.data.code === 200) setUnits(unitsRes.data.data || []);
      if (graphRes.data.code === 200) setGraphData(graphRes.data.data || []);
      if (amenitiesRes.data.code === 200) setAmenities(amenitiesRes.data.data || []);
    } catch (error) {
      console.error('Failed to load property detail:', error);
      message.error('Failed to load property');
      router.push('/property');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = () => {
    Modal.confirm({
      title: 'Delete Property',
      content: 'Are you sure you want to delete this property? This action cannot be undone.',
      okText: 'Delete',
      okType: 'danger',
      onOk: async () => {
        try {
          const res = await property.delete(params.id);
          if (res.data.code === 200) {
            message.success('Property deleted');
            router.push('/property');
          } else {
            message.error(res.data.message || 'Failed to delete property');
          }
        } catch (error) {
          // 409 = active lease exists
          const msg = error.response?.data?.message || 'Failed to delete property';
          message.error(msg);
        }
      },
    });
  };

  if (loading) {
    return <MainLayout><div style={{ textAlign: 'center', padding: 80 }}><Spin size="large" /></div></MainLayout>;
  }
  if (!propertyData) return null;

  const totalUnits = propertyData.total_units || 0;
  const occupiedUnits = propertyData.occupied_units || 0;
  const vacantUnits = totalUnits - occupiedUnits;
  const addressParts = [propertyData.street_address, propertyData.city, propertyData.state, propertyData.country].filter(Boolean);
  const fullAddress = addressParts.join(', ');

  return (
    <MainLayout>
      <div style={{ fontSize: 14, marginBottom: 8 }}>Property Detail</div>

      {/* Header row: back + name on left, Edit + Delete on right */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Button type="text" icon={<ArrowLeftOutlined />} onClick={() => router.push('/property')} style={{ padding: '0 4px' }} />
          <span style={{ fontSize: 15, fontWeight: 500 }}>{propertyData.display_name}</span>
        </div>
        <Dropdown
          trigger={['hover']}
          placement="bottomRight"
          menu={{
            items: [
              { key: 'edit', icon: <EditOutlined />, label: 'Edit', onClick: () => router.push(`/property/${params.id}/edit`) },
              { key: 'clone', icon: <CopyOutlined />, label: 'Clone' },
              { key: 'delete', icon: <DeleteOutlined />, label: 'Delete', danger: true, onClick: handleDelete },
            ],
          }}
        >
          <Button
            shape="circle"
            icon={<EllipsisOutlined style={{ fontSize: 18 }} />}
            style={{ border: '1px solid #d9d9d9' }}
          />
        </Dropdown>
      </div>

      {/* Top 3-column grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.5fr 0.8fr', gap: 16, marginBottom: 16 }}>
        {/* Photo card */}
        <div style={{ background: '#fff', border: '1px solid #e8e8e8', borderRadius: 8, overflow: 'hidden', textAlign: 'center' }}>
          <div style={{ width: '100%', aspectRatio: '4/3', background: '#f5f5f5', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
            {propertyData.photo
              ? <img src={`${API_URL}/api/file/preview/${propertyData.photo}`} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              : <HomeOutlined style={{ fontSize: 64, color: '#ccc' }} />}
          </div>
          <div style={{ padding: '12px 16px' }}>
            <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>{propertyData.display_name}</div>
            <div style={{ color: '#888', fontSize: 12, marginBottom: 6 }}>{fullAddress}</div>
            <div style={{ fontSize: 12 }}>
              <span style={{ color: '#888' }}>Status: </span>
              <span style={{ fontWeight: 500 }}>{propertyData.status === 1 ? 'Active' : 'Inactive'}</span>
            </div>
          </div>
        </div>

        {/* Financial chart */}
        <div style={{ background: '#fff', border: '1px solid #e8e8e8', borderRadius: 8, padding: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontWeight: 600, fontSize: 14 }}>Financial, {propertyData.currency || 'HKD'}</span>
            <Button type="link" size="small" onClick={() => router.push(`/accounting?propertyId=${params.id}`)}>See details</Button>
          </div>
          <FinancialChart data={graphData} />
        </div>

        {/* Donut */}
        <div style={{ background: '#fff', border: '1px solid #e8e8e8', borderRadius: 8, padding: 16 }}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 12 }}>Units</div>
          <OccupancyDonut occupied={occupiedUnits} vacant={vacantUnits} total={totalUnits} />
          <div style={{ textAlign: 'center', marginTop: 12 }}>
            <Button size="small" onClick={() => router.push(`/property/${params.id}/unit/create`)}>Add Unit</Button>
          </div>
        </div>
      </div>

      {/* Bottom Tabs */}
      <div style={{ background: '#fff', border: '1px solid #e8e8e8', borderRadius: 8 }}>
        <Tabs
          defaultActiveKey="units"
          style={{ padding: '0 16px' }}
          items={[
            {
              key: 'units',
              label: 'Property Units',
              children: (
                <div>
                  {units.length === 0
                    ? <div style={{ padding: 40, textAlign: 'center', color: '#999' }}>No units found</div>
                    : units.map(unit => <UnitCard key={unit.id} unit={unit} propertyId={params.id} router={router} />)}
                </div>
              ),
            },
            {
              key: 'info',
              label: 'Property Information',
              children: <PropertyInfoTab propertyData={propertyData} amenities={amenities} />,
            },
          ]}
        />
      </div>
    </MainLayout>
  );
}
