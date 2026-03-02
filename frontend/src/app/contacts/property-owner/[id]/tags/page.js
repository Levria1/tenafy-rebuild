'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import {
  Table,
  Card,
  Button,
  Space,
  Modal,
  Input,
  Switch,
  message,
  Popconfirm,
  Typography,
  Spin,
} from 'antd';
import {
  ArrowLeftOutlined,
  PlusOutlined,
  DeleteOutlined,
  TagsOutlined,
} from '@ant-design/icons';
import MainLayout from '../../../../../components/Layout';
import { contact } from '../../../../../lib/api';

const { Title } = Typography;

export default function PropertyOwnerTagsPage() {
  const [tags, setTags] = useState([]);
  const [owner, setOwner] = useState(null);
  const [loading, setLoading] = useState(true);
  const [modalVisible, setModalVisible] = useState(false);
  const [newTagName, setNewTagName] = useState('');
  const [creating, setCreating] = useState(false);
  const router = useRouter();
  const params = useParams();
  const ownerId = params.id;

  useEffect(() => {
    loadOwner();
    loadTags();
  }, [ownerId]);

  const loadOwner = async () => {
    try {
      const response = await contact.getPropertyOwner(ownerId);
      if (response.data.code === 200) {
        setOwner(response.data.data);
      }
    } catch (error) {
      console.error('Failed to load owner:', error);
      message.error('Failed to load property owner');
    }
  };

  const loadTags = async () => {
    try {
      setLoading(true);
      const response = await contact.getOwnerTags(ownerId);
      if (response.data.code === 200) {
        setTags(response.data.data || []);
      }
    } catch (error) {
      console.error('Failed to load tags:', error);
      message.error('Failed to load tags');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateTag = async () => {
    if (!newTagName.trim()) {
      message.warning('Please enter a tag name');
      return;
    }

    try {
      setCreating(true);
      const response = await contact.createTag({
        property_owner_id: ownerId,
        name: newTagName.trim(),
      });

      if (response.data.code === 200 || response.data.code === 201) {
        message.success('Tag created successfully');
        setNewTagName('');
        setModalVisible(false);
        loadTags();
      } else {
        message.error(response.data.message || 'Failed to create tag');
      }
    } catch (error) {
      console.error('Failed to create tag:', error);
      message.error('Failed to create tag');
    } finally {
      setCreating(false);
    }
  };

  const handleDeleteTag = async (tagId) => {
    try {
      const response = await contact.deleteTag(tagId);
      if (response.data.code === 200) {
        message.success('Tag deleted successfully');
        loadTags();
      } else {
        message.error(response.data.message || 'Failed to delete tag');
      }
    } catch (error) {
      console.error('Failed to delete tag:', error);
      message.error('Failed to delete tag');
    }
  };

  const ownerName = owner
    ? `${owner.first_name || ''} ${owner.last_name || ''}`.trim()
    : 'Property Owner';

  const columns = [
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
    },
    {
      title: 'Enabled',
      key: 'enabled',
      render: (_, record) => (
        <Switch
          checked={record.status === 1 || record.status === undefined}
          onChange={(checked) => {
            if (!checked) {
              handleDeleteTag(record.id);
            }
          }}
        />
      ),
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 120,
      render: (_, record) => (
        <Popconfirm
          title="Delete Tag"
          description="Are you sure you want to delete this tag?"
          onConfirm={() => handleDeleteTag(record.id)}
          okText="Yes"
          cancelText="No"
        >
          <Button type="link" danger icon={<DeleteOutlined />}>
            Delete
          </Button>
        </Popconfirm>
      ),
    },
  ];

  return (
    <MainLayout>
      <Space direction="vertical" style={{ width: '100%' }} size="large">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Space>
            <Button icon={<ArrowLeftOutlined />} onClick={() => router.push('/contacts')}>
              Back to Contacts
            </Button>
          </Space>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => setModalVisible(true)}
          >
            Add Tag
          </Button>
        </div>

        <Card
          title={
            <Space>
              <TagsOutlined />
              <span>Tags for {ownerName}</span>
            </Space>
          }
        >
          <Spin spinning={loading}>
            <Table
              columns={columns}
              dataSource={tags}
              rowKey="id"
              pagination={false}
              locale={{ emptyText: 'No tags found. Click "Add Tag" to create one.' }}
            />
          </Spin>
        </Card>
      </Space>

      <Modal
        title="Add New Tag"
        open={modalVisible}
        onOk={handleCreateTag}
        onCancel={() => {
          setModalVisible(false);
          setNewTagName('');
        }}
        confirmLoading={creating}
        okText="Create"
      >
        <div style={{ marginTop: 16 }}>
          <label style={{ display: 'block', marginBottom: 8, fontWeight: 500 }}>
            Tag Name
          </label>
          <Input
            placeholder="Enter tag name"
            value={newTagName}
            onChange={(e) => setNewTagName(e.target.value)}
            onPressEnter={handleCreateTag}
            autoFocus
          />
        </div>
      </Modal>
    </MainLayout>
  );
}
