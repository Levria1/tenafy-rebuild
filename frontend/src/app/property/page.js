'use client';

import { useEffect, useState } from 'react';
import { Table, Button, Space, Tag, Card, Input, Modal, message } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, EyeOutlined } from '@ant-design/icons';
import { useRouter } from 'next/navigation';
import MainLayout from '../../components/Layout';
import { property } from '../../lib/api';

export default function PropertyPage() {
  const [properties, setProperties] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pagination, setPagination] = useState({ current: 1, pageSize: 20, total: 0 });
  const [searchText, setSearchText] = useState('');
  const router = useRouter();

  useEffect(() => {
    loadProperties();
  }, [pagination.current, pagination.pageSize]);

  const loadProperties = async () => {
    try {
      setLoading(true);
      const response = await property.list(
        searchText ? { search: searchText } : {}, 
        { page: pagination.current, limit: pagination.pageSize }
      );
      if (response.data.code === 200) {
        setProperties(response.data.data.content || []);
        setPagination({
          ...pagination,
          total: response.data.data.totalElements || 0,
        });
      }
    } catch (error) {
      console.error('Failed to load properties:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSearch = (value) => {
    setSearchText(value);
    setPagination({ ...pagination, current: 1 });
    loadProperties();
  };

  const handleTableChange = (pag) => {
    setPagination({ ...pagination, current: pag.current, pageSize: pag.pageSize });
  };

  const handleDelete = (record) => {
    Modal.confirm({
      title: 'Delete Property',
      content: `Are you sure you want to delete "${record.display_name}"?`,
      okText: 'Delete',
      okType: 'danger',
      onOk: async () => {
        try {
          await property.delete(record.id);
          message.success('Property deleted successfully');
          loadProperties();
        } catch (error) {
          message.error(error.response?.data?.message || 'Failed to delete property');
        }
      }
    });
  };

  const columns = [
    {
      title: 'Property Name',
      dataIndex: 'display_name',
      key: 'display_name',
    },
    {
      title: 'Address',
      dataIndex: 'address',
      key: 'address',
    },
    {
      title: 'Units',
      dataIndex: 'unit_count',
      key: 'unit_count',
    },
    {
      title: 'Occupied',
      dataIndex: 'occupied_count',
      key: 'occupied_count',
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      render: (status) => (
        <Tag color={status === 1 ? 'green' : 'red'}>
          {status === 1 ? 'Active' : 'Inactive'}
        </Tag>
      ),
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_, record) => (
        <Space>
          <Button
            type="link"
            icon={<EyeOutlined />}
            onClick={() => router.push(`/property/${record.id}/detail`)}
          >
            View
          </Button>
          <Button
            type="link"
            icon={<EditOutlined />}
            onClick={() => router.push(`/property/${record.id}/edit`)}
          >
            Edit
          </Button>
          <Button
            type="link"
            danger
            icon={<DeleteOutlined />}
            onClick={() => handleDelete(record)}
          >
            Delete
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <MainLayout>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <h1>Properties</h1>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => router.push('/property/create')}>
          Add Property
        </Button>
      </div>
      <Card>
        <Input.Search
          placeholder="Search properties..."
          style={{ width: 300, marginBottom: 16 }}
          onSearch={handleSearch}
          allowClear
        />
        <Table
          columns={columns}
          dataSource={properties}
          rowKey="id"
          loading={loading}
          pagination={pagination}
          onChange={handleTableChange}
        />
      </Card>
    </MainLayout>
  );
}
