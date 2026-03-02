'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, Table, Button, Tag, Space, message, Typography, Popconfirm } from 'antd';
import { CheckOutlined, DeleteOutlined, WarningOutlined, InfoCircleOutlined, CloseCircleOutlined, CheckCircleOutlined } from '@ant-design/icons';
import MainLayout from '../../components/Layout';
import { notification as notificationApi } from '../../lib/api';

const { Text } = Typography;

const typeConfig = {
  error:   { color: 'red',    icon: <CloseCircleOutlined />,  label: 'Error' },
  warning: { color: 'orange', icon: <WarningOutlined />,      label: 'Warning' },
  success: { color: 'green',  icon: <CheckCircleOutlined />,  label: 'Success' },
  info:    { color: 'blue',   icon: <InfoCircleOutlined />,   label: 'Info' },
};

export default function NotificationsPage() {
  const router = useRouter();
  const [notifications, setNotifications] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pagination, setPagination] = useState({ current: 1, pageSize: 20, total: 0 });

  const loadData = async (page = 1) => {
    try {
      setLoading(true);
      const res = await notificationApi.list({ page, limit: 20 });
      if (res.data.code === 200) {
        setNotifications(res.data.data.content || []);
        setPagination(prev => ({
          ...prev,
          current: page,
          total: res.data.data.totalElements || 0,
        }));
      }
    } catch (error) {
      console.error('Failed to load notifications:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadData(); }, []);

  const handleMarkRead = async (id) => {
    try {
      await notificationApi.markRead(id);
      message.success('Marked as read');
      loadData(pagination.current);
    } catch (err) {
      message.error('Failed');
    }
  };

  const handleMarkAllRead = async () => {
    try {
      await notificationApi.markAllRead();
      message.success('All marked as read');
      loadData(pagination.current);
    } catch (err) {
      message.error('Failed');
    }
  };

  const handleDelete = async (id) => {
    try {
      await notificationApi.delete(id);
      message.success('Deleted');
      loadData(pagination.current);
    } catch (err) {
      message.error('Failed');
    }
  };

  const columns = [
    {
      title: 'Type',
      dataIndex: 'type',
      key: 'type',
      width: 100,
      render: (type) => {
        const cfg = typeConfig[type] || typeConfig.info;
        return <Tag color={cfg.color} icon={cfg.icon}>{cfg.label}</Tag>;
      },
    },
    {
      title: 'Title',
      dataIndex: 'title',
      key: 'title',
      render: (title, r) => (
        <Text strong={!r.is_read} style={{ cursor: r.link ? 'pointer' : 'default' }}
          onClick={() => r.link && router.push(r.link)}>
          {title}
        </Text>
      ),
    },
    {
      title: 'Message',
      dataIndex: 'message',
      key: 'message',
      ellipsis: true,
      render: (msg) => <Text type="secondary">{msg}</Text>,
    },
    {
      title: 'Date',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 160,
      render: (d) => new Date(d).toLocaleString(),
    },
    {
      title: 'Status',
      dataIndex: 'is_read',
      key: 'is_read',
      width: 90,
      render: (read) => read ? <Tag>Read</Tag> : <Tag color="blue">Unread</Tag>,
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 120,
      render: (_, r) => (
        <Space>
          {!r.is_read && (
            <Button type="text" size="small" icon={<CheckOutlined />} onClick={() => handleMarkRead(r.id)} title="Mark read" />
          )}
          <Popconfirm title="Delete this notification?" onConfirm={() => handleDelete(r.id)} okText="Yes" cancelText="No">
            <Button type="text" size="small" danger icon={<DeleteOutlined />} title="Delete" />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <MainLayout>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h1 style={{ margin: 0 }}>Notifications</h1>
        <Button onClick={handleMarkAllRead} icon={<CheckOutlined />}>Mark All Read</Button>
      </div>
      <Card>
        <Table
          columns={columns}
          dataSource={notifications}
          rowKey="id"
          loading={loading}
          pagination={{
            ...pagination,
            onChange: (page) => loadData(page),
            showSizeChanger: false,
            showTotal: (total) => `Total ${total} notifications`,
          }}
          rowClassName={(r) => r.is_read ? '' : 'notification-unread'}
        />
      </Card>
      <style jsx global>{`
        .notification-unread { background: #f6f8ff !important; }
        .notification-unread:hover td { background: #eef1ff !important; }
      `}</style>
    </MainLayout>
  );
}
