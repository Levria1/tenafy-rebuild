'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, Table, Button, Space, Tag, Typography } from 'antd';
import { PlusOutlined, EyeOutlined, EditOutlined } from '@ant-design/icons';
import MainLayout from '../../../components/Layout';
import { contact } from '../../../lib/api';

const { Title } = Typography;

export default function PayeesPage() {
  const router = useRouter();
  const [payees, setPayees] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      setLoading(true);
      const res = await contact.listPayees({});
      if (res.data.code === 200) {
        setPayees(res.data.data.content || res.data.data || []);
      }
    } catch (err) {
      console.error('Failed to load payees:', err);
    } finally {
      setLoading(false);
    }
  };

  const columns = [
    { title: 'Name', dataIndex: 'name', key: 'name' },
    { title: 'Email', dataIndex: 'email', key: 'email' },
    { title: 'Phone', dataIndex: 'phone', key: 'phone' },
    { title: 'Type', dataIndex: 'type', key: 'type' },
    {
      title: 'Status', dataIndex: 'status', key: 'status',
      render: (s) => <Tag color={s === 1 ? 'green' : 'red'}>{s === 1 ? 'Active' : 'Inactive'}</Tag>,
    },
    {
      title: 'Actions', key: 'actions', width: 180,
      render: (_, r) => (
        <Space>
          <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => router.push(`/contacts/payee/${r.id}/detail`)}>View</Button>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => router.push(`/contacts/payee/${r.id}/edit`)}>Edit</Button>
        </Space>
      ),
    },
  ];

  return (
    <MainLayout>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Title level={4} style={{ margin: 0 }}>Payees</Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => router.push('/contacts/payee/create')}>
          Add Payee
        </Button>
      </div>
      <Card>
        <Table columns={columns} dataSource={payees} rowKey="id" loading={loading} />
      </Card>
    </MainLayout>
  );
}
