'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Card, Descriptions, Button, Space, Tag, Tabs, Table, message } from 'antd';
import { EditOutlined, ArrowLeftOutlined } from '@ant-design/icons';
import MainLayout from '../../../../../components/Layout';
import { contact, accounting } from '../../../../../lib/api';

export default function PayeeDetailPage() {
  const [payee, setPayee] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const params = useParams();
  const payeeId = params.id;

  useEffect(() => {
    loadPayee();
    loadAccounts();
  }, [payeeId]);

  const loadPayee = async () => {
    try {
      const response = await contact.getPayee(payeeId);
      if (response.data.code === 200) {
        setPayee(response.data.data);
      }
    } catch (error) {
      message.error('Failed to load payee');
    } finally {
      setLoading(false);
    }
  };

  const loadAccounts = async () => {
    setAccountsLoading(true);
    try {
      const response = await accounting.list({ tenantId: payeeId });
      if (response.data.code === 200) {
        setAccounts(response.data.data?.list || response.data.data || []);
      }
    } catch (error) {
      console.error('Failed to load accounting records');
    } finally {
      setAccountsLoading(false);
    }
  };

  const accountColumns = [
    { title: 'Date', dataIndex: 'date', key: 'date', render: (v) => v ? new Date(v).toLocaleDateString() : '-' },
    { title: 'Transaction Code', dataIndex: 'transaction_code', key: 'transaction_code' },
    { title: 'Amount', dataIndex: 'amount', key: 'amount', render: (v) => `$${Number(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}` },
    { title: 'Type', dataIndex: 'type', key: 'type', render: (v) => <Tag>{v || '-'}</Tag> },
    { title: 'Category', dataIndex: 'category_name', key: 'category_name', render: (v) => v || '-' },
    { title: 'Note', dataIndex: 'note', key: 'note', render: (v) => v || '-' },
  ];

  const tabItems = [
    {
      key: 'profile',
      label: 'Profile',
      children: (
        <Descriptions bordered column={2}>
          <Descriptions.Item label="Name">{payee?.name}</Descriptions.Item>
          <Descriptions.Item label="Type">{payee?.type || '-'}</Descriptions.Item>
          <Descriptions.Item label="Email">{payee?.email || '-'}</Descriptions.Item>
          <Descriptions.Item label="Phone">{payee?.phone || '-'}</Descriptions.Item>
          <Descriptions.Item label="Address" span={2}>{payee?.address || '-'}</Descriptions.Item>
          <Descriptions.Item label="Status"><Tag color={payee?.status === 1 ? 'green' : 'red'}>{payee?.status === 1 ? 'Active' : 'Inactive'}</Tag></Descriptions.Item>
          <Descriptions.Item label="Notes" span={2}>{payee?.notes || '-'}</Descriptions.Item>
        </Descriptions>
      ),
    },
    {
      key: 'accounting',
      label: 'Accounting',
      children: (
        <Table
          columns={accountColumns}
          dataSource={accounts}
          rowKey="id"
          loading={accountsLoading}
          locale={{ emptyText: 'No accounting records found' }}
        />
      ),
    },
  ];

  return (
    <MainLayout>
      <Space direction="vertical" style={{ width: '100%' }} size="large">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Button icon={<ArrowLeftOutlined />} onClick={() => router.push('/contacts')}>Back to Contacts</Button>
          <Button type="primary" icon={<EditOutlined />} onClick={() => router.push(`/contacts/payee/${payeeId}/edit`)}>Edit Payee</Button>
        </div>
        <Card title={payee?.name || 'Payee Details'} loading={loading}>
          {payee && <Tabs items={tabItems} />}
        </Card>
      </Space>
    </MainLayout>
  );
}
