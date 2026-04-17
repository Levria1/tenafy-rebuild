'use client';

import { useEffect, useState, useCallback } from 'react';
import { Button, Input, Tag, Badge, Spin, Empty, Popover, Radio, Space, Pagination } from 'antd';
import {
  PlusOutlined,
  SearchOutlined,
  FilterOutlined,
  TeamOutlined,
  DollarOutlined,
  FileTextOutlined,
  DownOutlined,
  UpOutlined,
  UserOutlined,
  RightOutlined,
  HomeOutlined,
} from '@ant-design/icons';
import { useRouter } from 'next/navigation';
import MainLayout from '../../components/Layout';
import useIsMobile from '../../hooks/useIsMobile';
import { property } from '../../lib/api';
import { formatBeds, formatUnitType } from '../../lib/format';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

// ---------------------------------------------------------------------------
// Property Card component
// ---------------------------------------------------------------------------
function PropertyCard({ prop, router, isMobile }) {
  const [expanded, setExpanded] = useState(false);
  const [units, setUnits] = useState([]);
  const [unitsLoading, setUnitsLoading] = useState(false);
  const [unitsLoaded, setUnitsLoaded] = useState(false);

  const totalUnits = prop.total_units || 0;
  const occupiedUnits = prop.occupied_units || 0;
  const vacantUnits = totalUnits - occupiedUnits;

  const toggleExpand = async () => {
    if (!expanded && !unitsLoaded) {
      setUnitsLoading(true);
      try {
        const res = await property.getUnits(prop.id);
        if (res.data.code === 200) {
          setUnits(res.data.data || []);
        }
      } catch (err) {
        console.error('Failed to load units:', err);
      } finally {
        setUnitsLoading(false);
        setUnitsLoaded(true);
      }
    }
    setExpanded(!expanded);
  };

  // Build full address
  const addressParts = [prop.street_address, prop.city, prop.state, prop.country].filter(Boolean);
  const fullAddress = addressParts.join(', ');

  return (
    <div style={{ border: '1px solid #e8e8e8', borderRadius: 8, marginBottom: 16, background: '#fff' }}>
      {/* Property header row */}
      <div style={{
        display: 'flex',
        alignItems: isMobile ? 'flex-start' : 'center',
        padding: isMobile ? '12px 14px' : '16px 20px',
        gap: isMobile ? 12 : 20,
        flexDirection: isMobile ? 'column' : 'row',
      }}>
        {/* Top part: image + name (on mobile, side by side) */}
        {isMobile ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%' }}>
            <div style={{
              width: 60, height: 48, borderRadius: 6, overflow: 'hidden', flexShrink: 0,
              background: '#f5f5f5', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              {prop.photo ? (
                <img src={`${API_URL}/api/file/preview/${prop.photo}`} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              ) : (
                <HomeOutlined style={{ fontSize: 22, color: '#bbb' }} />
              )}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{prop.display_name}</div>
              <div style={{ color: '#888', fontSize: 12, marginTop: 2 }}>{fullAddress || 'No address'}</div>
            </div>
          </div>
        ) : (
          <>
            {/* Property image */}
            <div style={{
              width: 80, height: 60, borderRadius: 6, overflow: 'hidden', flexShrink: 0,
              background: '#f5f5f5', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              {prop.photo ? (
                <img src={`${API_URL}/api/file/preview/${prop.photo}`} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              ) : (
                <HomeOutlined style={{ fontSize: 28, color: '#bbb' }} />
              )}
            </div>

            {/* Property name + address */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 15 }}>{prop.display_name}</div>
              <div style={{ color: '#888', fontSize: 13, marginTop: 2 }}>{fullAddress || 'No address'}</div>
            </div>
          </>
        )}

        {/* Unit counts */}
        {isMobile ? (
          <div style={{ display: 'flex', gap: 16, fontSize: 12, width: '100%' }}>
            <span style={{ fontWeight: 500 }}>Units: {totalUnits}</span>
            <span style={{ color: '#52c41a', fontWeight: 500 }}>{occupiedUnits} OCCUPIED</span>
            <span style={{ color: '#ff4d4f', fontWeight: 500 }}>{vacantUnits} VACANT</span>
          </div>
        ) : (
          <div style={{ textAlign: 'left', minWidth: 180 }}>
            <div style={{ fontWeight: 500, marginBottom: 4 }}>Units: {totalUnits}</div>
            <div style={{ display: 'flex', gap: 24 }}>
              <span style={{ color: '#52c41a', fontWeight: 500 }}>{occupiedUnits} OCCUPIED</span>
              <span style={{ color: '#ff4d4f', fontWeight: 500 }}>{vacantUnits} VACANT</span>
            </div>
          </div>
        )}

        {/* Action icons */}
        <div style={{ display: 'flex', gap: isMobile ? 20 : 28, ...(isMobile ? { width: '100%', justifyContent: 'flex-start' } : {}) }}>
          <div
            onClick={() => router.push(`/contacts/tenants?propertyId=${prop.id}`)}
            style={{ textAlign: 'center', cursor: 'pointer', color: '#555' }}
          >
            <TeamOutlined style={{ fontSize: isMobile ? 18 : 22, display: 'block', marginBottom: 2 }} />
            <span style={{ fontSize: 11, fontWeight: 500 }}>TENANTS</span>
          </div>
          <div
            onClick={() => router.push(`/accounting?propertyId=${prop.id}`)}
            style={{ textAlign: 'center', cursor: 'pointer', color: '#555' }}
          >
            <DollarOutlined style={{ fontSize: isMobile ? 18 : 22, display: 'block', marginBottom: 2 }} />
            <span style={{ fontSize: 11, fontWeight: 500 }}>ACCOUNTING</span>
          </div>
          <div
            onClick={() => router.push(`/property/${prop.id}/detail`)}
            style={{ textAlign: 'center', cursor: 'pointer', color: '#555' }}
          >
            <FileTextOutlined style={{ fontSize: isMobile ? 18 : 22, display: 'block', marginBottom: 2 }} />
            <span style={{ fontSize: 11, fontWeight: 500 }}>DETAIL</span>
          </div>
        </div>
      </div>

      {/* Show Detail toggle */}
      <div
        onClick={toggleExpand}
        style={{
          textAlign: 'center', padding: '8px 0', cursor: 'pointer', borderTop: '1px solid #f0f0f0',
          color: '#888', fontSize: 13, userSelect: 'none', display: 'flex', alignItems: 'center',
          justifyContent: 'center', gap: 6,
        }}
      >
        {expanded ? 'Hide Detail' : 'Show Detail'}
        {expanded ? <UpOutlined style={{ fontSize: 10 }} /> : <DownOutlined style={{ fontSize: 10 }} />}
      </div>

      {/* Expanded unit list */}
      {expanded && (
        <div style={{ borderTop: '1px solid #e8e8e8' }}>
          {unitsLoading ? (
            <div style={{ padding: 32, textAlign: 'center' }}><Spin /></div>
          ) : units.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: '#999' }}>No units found</div>
          ) : (
            units.map((unit, idx) => (
              <UnitRow key={unit.id} unit={unit} propId={prop.id} router={router} isLast={idx === units.length - 1} isMobile={isMobile} />
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Unit row inside expanded property
// ---------------------------------------------------------------------------
function UnitRow({ unit, propId, router, isLast, isMobile }) {
  const isOccupied = !!unit.tenant_id;
  const tenantName = (unit.tenant_first_name || unit.tenant_last_name)
    ? `${unit.tenant_first_name || ''} ${unit.tenant_last_name || ''}`.trim()
    : null;

  const sizeText = unit.size ? `${unit.size} ${unit.size_unit || 'sqft'}` : '-';
  const rentMin = unit.rent_price_min ? Number(unit.rent_price_min).toLocaleString() : null;
  const rentMax = unit.rent_price_max ? Number(unit.rent_price_max).toLocaleString() : null;
  const rentRange = rentMin && rentMax ? `${rentMin} - ${rentMax}` : rentMin || rentMax || '-';

  if (isMobile) {
    return (
      <div style={{
        padding: '12px 14px',
        borderBottom: isLast ? 'none' : '1px solid #f0f0f0',
      }}>
        {/* Top: image + name + tag */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <div style={{
            width: 48, height: 40, borderRadius: 6, overflow: 'hidden', flexShrink: 0,
            background: '#f5f5f5', display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            {unit.photo ? (
              <img src={`${API_URL}/api/file/preview/${unit.photo}`} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            ) : (
              <HomeOutlined style={{ fontSize: 18, color: '#ccc' }} />
            )}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontWeight: 600, fontSize: 13 }}>{unit.name}</span>
              <Tag color={isOccupied ? 'green' : 'red'} style={{ fontSize: 10, lineHeight: '16px' }}>
                {isOccupied ? 'Occupied' : 'Vacant'}
              </Tag>
            </div>
            <div style={{ color: '#888', fontSize: 11 }}>
              {unit.type ? formatUnitType(unit.type) : 'Unit'}
            </div>
          </div>
          {tenantName && (
            <div
              style={{ fontSize: 11, color: '#1677ff', cursor: 'pointer', textAlign: 'right', flexShrink: 0 }}
              onClick={() => unit.tenant_id && router.push(`/contacts/tenant/${unit.tenant_id}/detail`)}
            >
              <UserOutlined style={{ marginRight: 4 }} />{tenantName}
            </div>
          )}
        </div>
        {/* Details row */}
        <div style={{ color: '#666', fontSize: 11, display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
          <span>Size: <strong>{sizeText}</strong></span>
          <span>Bed: <strong>{formatBeds(unit.beds)}</strong></span>
          <span>Bath: <strong>{unit.baths ?? '-'}</strong></span>
          <span>Rent: <strong>{rentRange}</strong></span>
        </div>
        {/* Action buttons */}
        <div style={{ display: 'flex', gap: 8 }}>
          <Button size="small" style={{ fontSize: 11, flex: 1 }}>Listing</Button>
          <Button size="small" style={{ fontSize: 11, flex: 1 }} onClick={() => router.push(`/leasing/create?unit=${unit.id}&property=${propId}`)}>
            Lease
          </Button>
          <Button size="small" type="primary" ghost style={{ fontSize: 11, flex: 1 }}
            onClick={() => router.push(`/property/${propId}/unit/${unit.id}`)}>
            View <RightOutlined style={{ fontSize: 9 }} />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', padding: '14px 20px 14px 40px', gap: 16,
      borderBottom: isLast ? 'none' : '1px solid #f0f0f0',
    }}>
      {/* Unit image placeholder */}
      <div style={{
        width: 60, height: 50, borderRadius: 6, overflow: 'hidden', flexShrink: 0,
        background: '#f5f5f5', display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {unit.photo ? (
          <img src={`${API_URL}/api/file/preview/${unit.photo}`} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : (
          <HomeOutlined style={{ fontSize: 22, color: '#ccc' }} />
        )}
      </div>

      {/* Unit info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>{unit.name}</span>
          <Tag color={isOccupied ? 'green' : 'red'} style={{ fontSize: 11, lineHeight: '18px' }}>
            {isOccupied ? 'Occupied' : 'Vacant'}
          </Tag>
        </div>
        <div style={{ color: '#888', fontSize: 12, marginBottom: 2 }}>
          {unit.type ? formatUnitType(unit.type) : 'Unit'}
        </div>
        <div style={{ color: '#666', fontSize: 12, display: 'flex', gap: 16 }}>
          <span>Room Size: <strong>{sizeText}</strong></span>
          <span>Bedrooms <strong>{formatBeds(unit.beds)}</strong></span>
          <span>Bathrooms <strong>{unit.baths ?? '-'}</strong></span>
        </div>
        <div style={{ fontSize: 12, marginTop: 4 }}>
          <span style={{ fontWeight: 600 }}>RENT RANGE</span>{' '}
          <span style={{ color: '#666' }}>{rentRange}</span>
        </div>
      </div>

      {/* Tenant section */}
      <div style={{ textAlign: 'center', minWidth: 120 }}>
        <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 4 }}>Tenant</div>
        {tenantName ? (
          <>
            <div style={{
              width: 36, height: 36, borderRadius: '50%', background: '#fff1f0', border: '2px solid #ff4d4f',
              display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 4px',
            }}>
              <UserOutlined style={{ fontSize: 16, color: '#ff4d4f' }} />
            </div>
            <div
              style={{ fontSize: 12, color: '#1677ff', cursor: 'pointer' }}
              onClick={() => unit.tenant_id && router.push(`/contacts/tenant/${unit.tenant_id}/detail`)}
            >{tenantName}</div>
          </>
        ) : (
          <div style={{ color: '#ccc', fontSize: 12 }}>—</div>
        )}
      </div>

      {/* Action buttons */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
        <Button size="small" style={{ fontSize: 12 }}>Add Listing</Button>
        <Button size="small" style={{ fontSize: 12 }} onClick={() => router.push(`/leasing/create?unit=${unit.id}&property=${propId}`)}>
          Create Lease
        </Button>
        <Button
          size="small"
          type="primary"
          ghost
          style={{ fontSize: 12 }}
          onClick={() => router.push(`/property/${propId}/unit/${unit.id}`)}
        >
          View Unit <RightOutlined style={{ fontSize: 10 }} />
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Properties page
// ---------------------------------------------------------------------------
export default function PropertyPage() {
  const [properties, setProperties] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pagination, setPagination] = useState({ current: 1, pageSize: 20, total: 0 });
  const [searchText, setSearchText] = useState('');
  const [filterVisible, setFilterVisible] = useState(false);

  // Filters — property type: 1=residential, 2=commercial (matches original Java source)
  const [propertyType, setPropertyType] = useState(null);     // null=all, 1=residential, 2=commercial
  const [propertyStatus, setPropertyStatus] = useState(null);  // null=all (shows active by default on backend), 1=active, 0=inactive
  const [unitStatus, setUnitStatus] = useState(null);          // null=all, 'vacant', 'occupied'

  const filterCount = [propertyType, propertyStatus, unitStatus].filter(v => v !== null).length;

  const router = useRouter();
  const { isMobile } = useIsMobile();

  const loadProperties = useCallback(async (page = 1) => {
    try {
      setLoading(true);
      const body = {};
      if (searchText) body.search = searchText;
      if (propertyType !== null) body.propertyType = propertyType;
      if (propertyStatus !== null) body.propertyStatus = propertyStatus;
      if (unitStatus !== null) body.unitStatus = unitStatus;
      const response = await property.list(body, { page, limit: pagination.pageSize });
      if (response.data.code === 200) {
        setProperties(response.data.data.content || []);
        setPagination(prev => ({
          ...prev,
          current: page,
          total: response.data.data.totalElements || 0,
        }));
      }
    } catch (error) {
      console.error('Failed to load properties:', error);
    } finally {
      setLoading(false);
    }
  }, [searchText, propertyType, propertyStatus, unitStatus, pagination.pageSize]);

  useEffect(() => { loadProperties(1); }, [propertyType, propertyStatus, unitStatus]);

  const handleSearch = (value) => {
    setSearchText(value);
    setTimeout(() => loadProperties(1), 0);
  };

  const resetFilters = () => {
    setPropertyType(null);
    setPropertyStatus(null);
    setUnitStatus(null);
  };

  // Filter popover content matching the original Tenafy layout
  const filterContent = (
    <div style={{ width: 280, padding: 8 }}>
      {/* Property Type */}
      <div style={{ fontWeight: 600, marginBottom: 8 }}>Property Type</div>
      <Radio.Group
        value={propertyType}
        onChange={(e) => setPropertyType(e.target.value)}
        style={{ marginBottom: 16 }}
      >
        <Radio value={null}>All</Radio>
        <Radio value={1}>Residential</Radio>
        <Radio value={2}>Commercial</Radio>
      </Radio.Group>

      {/* Property Status */}
      <div style={{ fontWeight: 600, marginBottom: 8 }}>Property Status</div>
      <Radio.Group
        value={propertyStatus}
        onChange={(e) => setPropertyStatus(e.target.value)}
        style={{ marginBottom: 16 }}
      >
        <Radio value={null}>All</Radio>
        <Radio value={1}>Active</Radio>
        <Radio value={0}>Inactive</Radio>
      </Radio.Group>

      {/* Unit Status */}
      <div style={{ fontWeight: 600, marginBottom: 8 }}>Unit Status</div>
      <Radio.Group
        value={unitStatus}
        onChange={(e) => setUnitStatus(e.target.value)}
        style={{ marginBottom: 16 }}
      >
        <Radio value={null}>All</Radio>
        <Radio value="vacant">Vacant</Radio>
        <Radio value="occupied">Occupied</Radio>
      </Radio.Group>

      {/* Buttons */}
      <div style={{ display: 'flex', gap: 8 }}>
        <Button type="primary" size="small" danger onClick={resetFilters}>
          Reset
        </Button>
        <Button size="small" onClick={() => setFilterVisible(false)}>
          Close
        </Button>
      </div>
    </div>
  );

  return (
    <MainLayout>
      <h1 style={{ marginBottom: 16 }}>Properties</h1>

      {/* Top bar: total, search, filter, add button */}
      <div style={{
        background: '#fff', border: '1px solid #e8e8e8', borderRadius: 8,
        padding: isMobile ? '10px 12px' : '12px 20px',
        marginBottom: 16,
        display: 'flex',
        alignItems: isMobile ? 'stretch' : 'center',
        justifyContent: 'space-between',
        flexDirection: isMobile ? 'column' : 'row',
        gap: isMobile ? 10 : 0,
      }}>
        <div style={{ fontWeight: 500, fontSize: 15 }}>
          <span style={{ color: '#1890ff', fontSize: 18, fontWeight: 700, marginRight: 6 }}>{pagination.total}</span>
          Total
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? 8 : 12, flexWrap: isMobile ? 'wrap' : 'nowrap' }}>
          <Input
            placeholder="Type here to search"
            prefix={<SearchOutlined style={{ color: '#bbb' }} />}
            style={{ width: isMobile ? '100%' : 220, flex: isMobile ? 1 : undefined, minWidth: isMobile ? 0 : undefined }}
            allowClear
            onPressEnter={(e) => handleSearch(e.target.value)}
            onChange={(e) => { if (!e.target.value) handleSearch(''); }}
          />
          <Popover content={filterContent} trigger="click" open={filterVisible} onOpenChange={setFilterVisible} placement="bottomRight">
            <Badge count={filterCount} size="small" offset={[-4, 0]}>
              <Button icon={<FilterOutlined />}>{isMobile ? '' : 'Filter'}</Button>
            </Badge>
          </Popover>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => router.push('/property/create')}>
            {isMobile ? 'Add' : '+ Add Property'}
          </Button>
        </div>
      </div>

      {/* Property cards */}
      {loading ? (
        <div style={{ padding: 48, textAlign: 'center' }}><Spin size="large" /></div>
      ) : properties.length === 0 ? (
        <Empty description="No properties found" />
      ) : (
        <>
          {properties.map(prop => (
            <PropertyCard key={prop.id} prop={prop} router={router} isMobile={isMobile} />
          ))}

          {/* Pagination */}
          {pagination.total > pagination.pageSize && (
            <div style={{ textAlign: 'center', marginTop: 16 }}>
              <Pagination
                current={pagination.current}
                total={pagination.total}
                pageSize={pagination.pageSize}
                onChange={(page) => loadProperties(page)}
                showTotal={(total) => `Total ${total} properties`}
                showSizeChanger={false}
              />
            </div>
          )}
        </>
      )}
    </MainLayout>
  );
}
