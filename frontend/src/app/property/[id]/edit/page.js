'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Card, Form, Input, Button, Select, message, Spin, Tabs, Table, Tag, Space, Modal } from 'antd';
import { ArrowLeftOutlined, EditOutlined, DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import MainLayout from '../../../../components/Layout';
import { property } from '../../../../lib/api';

export default function PropertyEditPage() {
  const router = useRouter();
  const params = useParams();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(true);
  const [propertyData, setPropertyData] = useState(null);
  const [units, setUnits] = useState([]);
  const [unitsLoading, setUnitsLoading] = useState(true);

  useEffect(() => {
    if (params.id) {
      loadProperty();
    }
  }, [params.id]);

  const loadProperty = async () => {
    try {
      const response = await property.get(params.id);
      if (response.data.code === 200) {
        setPropertyData(response.data.data);
        form.setFieldsValue(response.data.data);
        
        if (response.data.data.units) {
          setUnits(response.data.data.units);
        }
      }
    } catch (error) {
      message.error('Failed to load property');
      router.push('/property');
    } finally {
      setFetching(false);
    }
  };

  const onFinish = async (values) => {
    try {
      setLoading(true);
      const response = await property.update(params.id, values);
      if (response.data.code === 200) {
        message.success('Property updated successfully');
        router.push('/property');
      } else {
        message.error(response.data.message || 'Failed to update property');
      }
    } catch (error) {
      message.error(error.response?.data?.message || 'Failed to update property');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = () => {
    Modal.confirm({
      title: 'Delete Property',
      content: 'Are you sure you want to delete this property?',
      onOk: async () => {
        try {
          await property.delete(params.id);
          message.success('Property deleted');
          router.push('/property');
        } catch (error) {
          message.error('Failed to delete property');
        }
      }
    });
  };

  const unitColumns = [
    { title: 'Unit', dataIndex: 'name', key: 'name' },
    { title: 'Type', dataIndex: 'type', key: 'type' },
    { title: 'Beds', dataIndex: 'beds', key: 'beds' },
    { title: 'Baths', dataIndex: 'baths', key: 'baths' },
    { title: 'Rent', dataIndex: 'rent_price_min', key: 'rent', 
      render: (val, record) => `$${val} - $${record.rent_price_max}` 
    },
    { title: 'Status', dataIndex: 'status', key: 'status',
      render: (status) => (
        <Tag color={status === 1 ? 'green' : 'red'}>
          {status === 1 ? 'Occupied' : 'Vacant'}
        </Tag>
      )
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_, record) => (
        <Space>
          <Button type="link" size="small" icon={<EditOutlined />}>Edit</Button>
        </Space>
      )
    }
  ];

  if (fetching) {
    return (
      <MainLayout>
        <div style={{ textAlign: 'center', padding: 50 }}>
          <Spin size="large" />
        </div>
      </MainLayout>
    );
  }

  return (
    <MainLayout>
      <div style={{ maxWidth: 1000, margin: '0 auto' }}>
        <Button 
          icon={<ArrowLeftOutlined />} 
          onClick={() => router.push('/property')}
          style={{ marginBottom: 16 }}
        >
          Back to Properties
        </Button>

        <Tabs 
          defaultActiveKey="details"
          items={[
            {
              key: 'details',
              label: 'Property Details',
              children: (
                <Card title="Edit Property">
                  <Form
                    form={form}
                    layout="vertical"
                    onFinish={onFinish}
                  >
                    <Form.Item
                      name="display_name"
                      label="Property Name"
                      rules={[{ required: true, message: 'Please enter property name' }]}
                    >
                      <Input placeholder="e.g., Sunset Apartments" />
                    </Form.Item>

                    <Form.Item
                      name="address"
                      label="Address"
                      rules={[{ required: true, message: 'Please enter address' }]}
                    >
                      <Input.TextArea rows={2} placeholder="Full address" />
                    </Form.Item>

                    <Form.Item
                      name="description"
                      label="Description"
                    >
                      <Input.TextArea rows={3} placeholder="Property description (optional)" />
                    </Form.Item>

                    <Form.Item
                      name="currency"
                      label="Currency"
                    >
                      <Select>
                        <Select.Option value="USD">USD - US Dollar</Select.Option>
                        <Select.Option value="EUR">EUR - Euro</Select.Option>
                        <Select.Option value="GBP">GBP - British Pound</Select.Option>
                        <Select.Option value="CAD">CAD - Canadian Dollar</Select.Option>
                      </Select>
                    </Form.Item>

                    <Form.Item
                      name="status"
                      label="Status"
                    >
                      <Select>
                        <Select.Option value={1}>Active</Select.Option>
                        <Select.Option value={0}>Inactive</Select.Option>
                      </Select>
                    </Form.Item>

                    <Form.Item>
                      <Space>
                        <Button type="primary" htmlType="submit" loading={loading}>
                          Update Property
                        </Button>
                        <Button danger onClick={handleDelete}>
                          Delete Property
                        </Button>
                      </Space>
                    </Form.Item>
                  </Form>
                </Card>
              )
            },
            {
              key: 'units',
              label: 'Units',
              children: (
                <Card 
                  title="Units" 
                  extra={
                    <Button type="primary" icon={<PlusOutlined />}>
                      Add Unit
                    </Button>
                  }
                >
                  <Table
                    columns={unitColumns}
                    dataSource={units}
                    rowKey="id"
                    loading={unitsLoading}
                  />
                </Card>
              )
            }
          ]}
        />
      </div>
    </MainLayout>
  );
}
