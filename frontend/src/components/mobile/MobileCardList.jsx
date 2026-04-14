'use client';

import { Spin, Empty, Pagination } from 'antd';

/**
 * Generic mobile card list — replaces <Table> on mobile screens.
 *
 * Props:
 *  - dataSource: array of row objects
 *  - renderCard: (record, index) => JSX — renders a single card
 *  - loading: boolean
 *  - pagination: { current, pageSize, total, onChange }  (optional)
 *  - rowKey: string | function  (optional, defaults to 'id')
 *  - emptyText: string (optional)
 *  - style: object (optional)
 */
export default function MobileCardList({
  dataSource = [],
  renderCard,
  loading = false,
  pagination,
  rowKey = 'id',
  emptyText = 'No data',
  style = {},
}) {
  const getKey = (record, index) => {
    if (typeof rowKey === 'function') return rowKey(record);
    return record[rowKey] ?? index;
  };

  if (loading) {
    return (
      <div style={{ padding: 40, textAlign: 'center' }}>
        <Spin />
      </div>
    );
  }

  if (!dataSource || dataSource.length === 0) {
    return <Empty description={emptyText} style={{ padding: '40px 0' }} />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, ...style }}>
      {dataSource.map((record, index) => (
        <div key={getKey(record, index)}>
          {renderCard(record, index)}
        </div>
      ))}
      {pagination && pagination.total > pagination.pageSize && (
        <div style={{ padding: '12px 0', textAlign: 'center' }}>
          <Pagination
            size="small"
            current={pagination.current}
            pageSize={pagination.pageSize}
            total={pagination.total}
            onChange={pagination.onChange}
            showSizeChanger={false}
            simple
          />
        </div>
      )}
    </div>
  );
}
