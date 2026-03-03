'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, Table, Button, Space, Typography, message } from 'antd';
import { PlusOutlined, EditOutlined, SendOutlined } from '@ant-design/icons';
import MainLayout from '../../../components/Layout';
import { contact } from '../../../lib/api';

const { Title } = Typography;

export default function EmailGroupsPage() {
  const router = useRouter();
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      setLoading(true);
      const res = await contact.listEmailGroups({});
      if (res.data.code === 200) {
        setGroups(res.data.data.content || res.data.data || []);
      }
    } catch (err) {
      console.error('Failed to load groups:', err);
    } finally {
      setLoading(false);
    }
  };

  const columns = [
    { title: 'Name', dataIndex: 'name', key: 'name' },
    { title: 'Description', dataIndex: 'description', key: 'description', ellipsis: true },
    { title: 'Members', dataIndex: 'member_count', key: 'member_count', width: 100 },
    {
      title: 'Actions', key: 'actions', width: 180,
      render: (_, r) => (
        <Space>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => router.push(`/contacts/group/${r.id}/edit`)}>Edit</Button>
          <Button type="link" size="small" icon={<SendOutlined />} onClick={() => router.push(`/contacts/email/send?group=${r.id}`)}>Send Email</Button>
        </Space>
      ),
    },
  ];

  return (
    <MainLayout>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Title level={4} style={{ margin: 0 }}>Email Groups</Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => router.push('/contacts/group/create')}>
          Add Group
        </Button>
      </div>
      <Card>
        <Table columns={columns} dataSource={groups} rowKey="id" loading={loading} />
      </Card>
    </MainLayout>
  );
}
