'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Card, Table, Button, Space, Tag, Statistic, Row, Col, DatePicker, Select } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import MainLayout from '../../../../../../components/Layout';
import { property as propertyApi } from '../../../../../../lib/api';

const { RangePicker } = DatePicker;

export default function UnitInventoryHistoryPage() {
  const params = useParams();
  const router = useRouter();
  const propertyId = params.id;
  const unitId = params.unitid;

  const [history, setHistory] = useState([]);
  const [inventorySum, setInventorySum] = useState(0);
  const [loading, setLoading] = useState(true);
  const [pagination, setPagination] = useState({ current: 1, pageSize: 20, total: 0 });
  const [filters, setFilters] = useState({});

  useEffect(() => {
    loadData();
  }, [unitId, pagination.current, filters]);

  useEffect(() => {
    propertyApi.getInventorySum(unitId)
      .then(r => { if (r.data.code === 200) setInventorySum(r.data.data?.total || 0); })
      .catch(() => {});
  }, [unitId]);

  const loadData = async () => {
    try {
      setLoading(true);
      const res = await propertyApi.getInventoryHistory(
        unitId,
        filters,
        { page: pagination.current, limit: pagination.pageSize }
      );
      if (res.data.code === 200) {
        const d = res.data.data;
        setHistory(d.content || []);
        setPagination(p => ({ ...p, total: d.totalElements || 0 }));
      }
    } catch (error) {
      console.error('Failed to load inventory history:', error);
    } finally {
      setLoading(false);
    }
  };

  const columns = [
    {
      title: 'Item', dataIndex: 'item_name', key: 'item_name',
      render: (name) => name || 'Unknown Item',
    },
    {
      title: 'Action', dataIndex: 'action', key: 'action',
      render: (action) => {
        const colors = { ADD: 'green', REMOVE: 'red', UPDATE: 'blue', ADJUST: 'orange' };
        return <Tag color={colors[action] || 'default'}>{action || 'UPDATE'}</Tag>;
      },
    },
    {
      title: 'Qty Before', dataIndex: 'quantity_before', key: 'quantity_before',
      render: (v) => v ?? '-',
    },
    {
      title: 'Qty After', dataIndex: 'quantity_after', key: 'quantity_after',
      render: (v) => v ?? '-',
    },
    { title: 'Note', dataIndex: 'note', key: 'note', ellipsis: true },
    {
      title: 'Date', dataIndex: 'created_at', key: 'created_at',
      render: (d) => d ? dayjs(d).format('MMM D, YYYY h:mm A') : '-',
    },
  ];

  return (
    <MainLayout>
      <div style={{ marginBottom: 16 }}>
        <Button
          icon={<ArrowLeftOutlined />}
          onClick={() => router.push(`/property/${propertyId}/unit/${unitId}`)}
          style={{ marginBottom: 16 }}
        >
          Back to Unit
        </Button>
        <h2 style={{ margin: 0 }}>Inventory History</h2>
      </div>

      <Row gutter={16} style={{ marginBottom: 24 }}>
        <Col span={8}>
          <Card>
            <Statistic
              title="Current Inventory Value"
              value={Number(inventorySum || 0)}
              precision={2}
              prefix="$"
            />
          </Card>
        </Col>
        <Col span={8}>
          <Card>
            <Statistic title="Total History Records" value={pagination.total} />
          </Card>
        </Col>
      </Row>

      <Card
        title="Change History"
        extra={
          <Space>
            <Select
              placeholder="Filter by action"
              allowClear
              style={{ width: 160 }}
              options={[
                { label: 'Add', value: 'ADD' },
                { label: 'Remove', value: 'REMOVE' },
                { label: 'Update', value: 'UPDATE' },
                { label: 'Adjust', value: 'ADJUST' },
              ]}
              onChange={(v) => {
                setFilters(f => ({ ...f, action: v }));
                setPagination(p => ({ ...p, current: 1 }));
              }}
            />
          </Space>
        }
      >
        <Table
          columns={columns}
          dataSource={history}
          rowKey={(r, i) => r.id || i}
          loading={loading}
          pagination={{
            current: pagination.current,
            pageSize: pagination.pageSize,
            total: pagination.total,
            onChange: (page) => setPagination(p => ({ ...p, current: page })),
          }}
        />
      </Card>
    </MainLayout>
  );
}
