'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Card, Descriptions, Button, Space, Tag, Tabs, Table, message, Modal } from 'antd';
import { EditOutlined, ArrowLeftOutlined, DeleteOutlined, ExclamationCircleOutlined } from '@ant-design/icons';
import MainLayout, { useAuth } from '../../../../../components/Layout';
import { accounting } from '../../../../../lib/api';

export default function AccountDetailPage() {
  const [account, setAccount] = useState(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const params = useParams();
  const accountId = params.id;
  const { hasPermission } = useAuth();
  const canEdit = hasPermission ? hasPermission('LANDLORD/ACCOUNTING_EDIT') : false;
  const canDelete = hasPermission ? hasPermission('LANDLORD/ACCOUNTING_DELETE') : false;

  useEffect(() => {
    loadAccount();
  }, [accountId]);

  const loadAccount = async () => {
    try {
      const response = await accounting.get(accountId);
      if (response.data.code === 200) {
        setAccount(response.data.data);
      }
    } catch (error) {
      message.error('Failed to load account');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = () => {
    Modal.confirm({
      title: 'Delete Transaction',
      icon: <ExclamationCircleOutlined />,
      content: 'Are you sure you want to delete this transaction? This action cannot be undone.',
      okText: 'Delete',
      okType: 'danger',
      cancelText: 'Cancel',
      onOk: async () => {
        try {
          const res = await accounting.delete(accountId);
          if (res.data.code === 200) {
            message.success('Transaction deleted');
            router.push('/accounting');
          }
        } catch (error) {
          message.error(error.response?.data?.message || 'Failed to delete transaction');
        }
      },
    });
  };

  const linesColumns = [
    { title: 'Date', dataIndex: 'transaction_date', key: 'transaction_date' },
    { title: 'Description', dataIndex: 'description', key: 'description' },
    { title: 'Inflow', dataIndex: 'inflow', key: 'inflow', render: (v) => v ? `$${v.toLocaleString()}` : '-' },
    { title: 'Outflow', dataIndex: 'outflow', key: 'outflow', render: (v) => v ? `$${v.toLocaleString()}` : '-' },
    { title: 'Balance', dataIndex: 'balance', key: 'balance', render: (v) => `$${v?.toLocaleString()}` },
  ];

  return (
    <MainLayout>
      <Space direction="vertical" style={{ width: '100%' }} size="large">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Button icon={<ArrowLeftOutlined />} onClick={() => router.push('/accounting')}>Back to Accounting</Button>
          <Space>
            {canDelete && (
              <Button danger icon={<DeleteOutlined />} onClick={handleDelete}>Delete</Button>
            )}
            {canEdit && (
              <Button type="primary" icon={<EditOutlined />} onClick={() => router.push(`/accounting/accounts/${accountId}/edit`)}>Edit</Button>
            )}
          </Space>
        </div>
        <Card title={`Transaction #${accountId}`} loading={loading}>
          {account && (
            <>
              <Descriptions bordered column={2} style={{ marginBottom: 16 }}>
                <Descriptions.Item label="Date">{account.transaction_date}</Descriptions.Item>
                <Descriptions.Item label="Type"><Tag color={account.type === 'income' ? 'green' : 'red'}>{account.type}</Tag></Descriptions.Item>
                <Descriptions.Item label="Amount">${account.amount?.toLocaleString()}</Descriptions.Item>
                <Descriptions.Item label="Status"><Tag color={account.status === 'COMPLETED' ? 'green' : 'orange'}>{account.status}</Tag></Descriptions.Item>
                <Descriptions.Item label="Description" span={2}>{account.description}</Descriptions.Item>
              </Descriptions>
              <Card title="Transaction Lines">
                <Table columns={linesColumns} dataSource={account.lines || []} rowKey="id" pagination={false} />
              </Card>
            </>
          )}
        </Card>
      </Space>
    </MainLayout>
  );
}
