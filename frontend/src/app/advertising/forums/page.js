'use client';

import { useEffect, useState } from 'react';
import {
  Table, Card, Tabs, Button, Space, Typography, Modal, Form, Input, message,
  Tag, Popconfirm, Select, Empty,
} from 'antd';
import {
  SoundOutlined, PlusOutlined, EditOutlined, DeleteOutlined, TeamOutlined, LinkOutlined,
} from '@ant-design/icons';
import MainLayout from '../../../components/Layout';
import { advertisingApi } from '../../../lib/api';

const { Title, Text } = Typography;

export default function ForumsPage() {
  const [forums, setForums] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);

  const [forumModal, setForumModal] = useState(null); // {mode:'new'|'edit', row?}
  const [acctModal, setAcctModal] = useState(null);
  const [memberModal, setMemberModal] = useState(null); // forum row
  const [memberIds, setMemberIds] = useState([]);
  const [forumForm] = Form.useForm();
  const [acctForm] = Form.useForm();
  const [saving, setSaving] = useState(false);

  const [footer, setFooter] = useState('');
  const [photoRoot, setPhotoRoot] = useState('');
  const [savingSettings, setSavingSettings] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [f, a, s] = await Promise.all([advertisingApi.listForums(), advertisingApi.listAccounts(), advertisingApi.getAdSettings()]);
      if (f.data.code === 200) setForums(f.data.data || []);
      if (a.data.code === 200) setAccounts(a.data.data || []);
      if (s.data.code === 200) { setFooter(s.data.data.footer || ''); setPhotoRoot(s.data.data.photo_root || ''); }
    } catch (e) {
      message.error('Failed to load forums');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const saveSettings = async () => {
    setSavingSettings(true);
    try {
      await advertisingApi.updateAdSettings({ footer, photo_root: photoRoot });
      message.success('Settings saved');
    } catch (e) { message.error('Failed to save settings'); }
    finally { setSavingSettings(false); }
  };

  // ---- Forum create/edit ----
  const openForum = (row) => {
    setForumModal({ mode: row ? 'edit' : 'new', row });
    forumForm.setFieldsValue(row ? { name: row.name, url: row.url, notes: row.notes } : { name: '', url: '', notes: '' });
  };
  const saveForum = async () => {
    try {
      const vals = await forumForm.validateFields();
      setSaving(true);
      if (forumModal.mode === 'edit') await advertisingApi.updateForum(forumModal.row.id, vals);
      else await advertisingApi.createForum(vals);
      message.success('Saved');
      setForumModal(null);
      load();
    } catch (e) { if (!e?.errorFields) message.error('Failed to save forum'); }
    finally { setSaving(false); }
  };

  // ---- Account create/edit ----
  const openAcct = (row) => {
    setAcctModal({ mode: row ? 'edit' : 'new', row });
    acctForm.setFieldsValue(row ? { name: row.name, email: row.email, notes: row.notes } : { name: '', email: '', notes: '' });
  };
  const saveAcct = async () => {
    try {
      const vals = await acctForm.validateFields();
      setSaving(true);
      if (acctModal.mode === 'edit') await advertisingApi.updateAccount(acctModal.row.id, vals);
      else await advertisingApi.createAccount(vals);
      message.success('Saved');
      setAcctModal(null);
      load();
    } catch (e) { if (!e?.errorFields) message.error('Failed to save account'); }
    finally { setSaving(false); }
  };

  // ---- Membership ----
  const openMembers = (forum) => {
    setMemberModal(forum);
    setMemberIds((forum.accounts || []).map(a => a.id));
  };
  const saveMembers = async () => {
    setSaving(true);
    try {
      await advertisingApi.setForumMembers(memberModal.id, memberIds);
      message.success('Members updated');
      setMemberModal(null);
      load();
    } catch (e) { message.error('Failed to update members'); }
    finally { setSaving(false); }
  };

  const acctLabel = (a) => a.name || a.email || '(unnamed)';

  const forumColumns = [
    { title: 'Forum', dataIndex: 'name', key: 'name', render: (v, r) => (
      <div><Text strong>{v}</Text>{r.status === 0 && <Tag style={{ marginLeft: 8 }}>Archived</Tag>}
        {r.url ? <div><a href={r.url} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}><LinkOutlined /> {r.url.length > 44 ? r.url.slice(0, 44) + '…' : r.url}</a></div> : null}
      </div>
    ) },
    { title: 'Accounts that can post', key: 'accounts', render: (_, r) => (
      r.accounts?.length
        ? <Space size={[4, 4]} wrap>{r.accounts.map(a => <Tag key={a.id} color="geekblue">{acctLabel(a)}</Tag>)}</Space>
        : <Text type="secondary">— none set —</Text>
    ) },
    { title: 'Actions', key: 'act', width: 240, render: (_, r) => (
      <Space size="small">
        <Button size="small" icon={<TeamOutlined />} onClick={() => openMembers(r)}>Members</Button>
        <Button size="small" icon={<EditOutlined />} onClick={() => openForum(r)} />
        <Popconfirm title="Delete this forum?" onConfirm={async () => { await advertisingApi.deleteForum(r.id); message.success('Deleted'); load(); }} okText="Delete" okButtonProps={{ danger: true }}>
          <Button size="small" danger icon={<DeleteOutlined />} />
        </Popconfirm>
      </Space>
    ) },
  ];

  const acctColumns = [
    { title: 'Facebook Name', dataIndex: 'name', key: 'name', render: (v) => v || <Text type="secondary">(map later)</Text> },
    { title: 'Email', dataIndex: 'email', key: 'email', render: (v) => v || <Text type="secondary">—</Text> },
    { title: 'Notes', dataIndex: 'notes', key: 'notes', render: (v) => v || <Text type="secondary">—</Text> },
    { title: 'Actions', key: 'act', width: 120, render: (_, r) => (
      <Space size="small">
        <Button size="small" icon={<EditOutlined />} onClick={() => openAcct(r)} />
        <Popconfirm title="Delete this account?" description="It will be removed from all forums." onConfirm={async () => { await advertisingApi.deleteAccount(r.id); message.success('Deleted'); load(); }} okText="Delete" okButtonProps={{ danger: true }}>
          <Button size="small" danger icon={<DeleteOutlined />} />
        </Popconfirm>
      </Space>
    ) },
  ];

  return (
    <MainLayout>
      <div style={{ padding: 24 }}>
        <Space align="center" style={{ marginBottom: 4 }}>
          <SoundOutlined style={{ fontSize: 22, color: '#1677ff' }} />
          <Title level={3} style={{ margin: 0 }}>Forums & Accounts</Title>
        </Space>
        <div style={{ marginBottom: 16 }}>
          <Text type="secondary">
            The Facebook groups you post to, the accounts that post, and which account can post in
            which group. The Scheduler only ever pairs a forum with an account that&apos;s a member.
          </Text>
        </div>

        <Card styles={{ body: { padding: 16 } }} style={{ borderColor: '#e8e8e8' }}>
          <Tabs
            items={[
              {
                key: 'forums', label: `Forums (${forums.length})`,
                children: (
                  <>
                    <Button type="primary" icon={<PlusOutlined />} onClick={() => openForum(null)} style={{ marginBottom: 16 }}>New Forum</Button>
                    <Table rowKey="id" columns={forumColumns} dataSource={forums} loading={loading} pagination={false}
                      locale={{ emptyText: <Empty description="No forums yet" /> }} />
                  </>
                ),
              },
              {
                key: 'accounts', label: `Accounts (${accounts.length})`,
                children: (
                  <>
                    <Button type="primary" icon={<PlusOutlined />} onClick={() => openAcct(null)} style={{ marginBottom: 16 }}>New Account</Button>
                    <Table rowKey="id" columns={acctColumns} dataSource={accounts} loading={loading} pagination={false}
                      locale={{ emptyText: <Empty description="No accounts yet" /> }} />
                  </>
                ),
              },
              {
                key: 'settings', label: 'Settings',
                children: (
                  <div style={{ maxWidth: 640 }}>
                    <div style={{ marginBottom: 16 }}>
                      <Text strong>Shared footer</Text>
                      <div><Text type="secondary" style={{ fontSize: 12 }}>Appended to the end of every post (contact info, minimum rental, etc.).</Text></div>
                      <Input.TextArea rows={4} value={footer} onChange={(e) => setFooter(e.target.value)}
                        style={{ marginTop: 8 }} placeholder="If you're interested, please contact +852 …  Minimum one month rental." />
                    </div>
                    <div style={{ marginBottom: 16 }}>
                      <Text strong>Photo root</Text>
                      <div><Text type="secondary" style={{ fontSize: 12 }}>Local folder on the posting PC where images live; the plan returns hints like <code>Property/Unit</code> under this.</Text></div>
                      <Input value={photoRoot} onChange={(e) => setPhotoRoot(e.target.value)} style={{ marginTop: 8 }} placeholder="~/tenafy-photos" />
                    </div>
                    <Button type="primary" loading={savingSettings} onClick={saveSettings}>Save Settings</Button>
                  </div>
                ),
              },
            ]}
          />
        </Card>
      </div>

      {/* Forum modal */}
      <Modal title={forumModal?.mode === 'edit' ? 'Edit Forum' : 'New Forum'} open={!!forumModal}
        onCancel={() => setForumModal(null)} onOk={saveForum} confirmLoading={saving} okText="Save">
        <Form form={forumForm} layout="vertical">
          <Form.Item name="name" label="Forum name" rules={[{ required: true, message: 'Name is required' }]}>
            <Input placeholder="e.g. Find A Room In Hong Kong" />
          </Form.Item>
          <Form.Item name="url" label="Facebook group URL">
            <Input placeholder="https://www.facebook.com/groups/…" />
          </Form.Item>
          <Form.Item name="notes" label="Notes"><Input.TextArea rows={2} /></Form.Item>
        </Form>
      </Modal>

      {/* Account modal */}
      <Modal title={acctModal?.mode === 'edit' ? 'Edit Account' : 'New Account'} open={!!acctModal}
        onCancel={() => setAcctModal(null)} onOk={saveAcct} confirmLoading={saving} okText="Save">
        <Form form={acctForm} layout="vertical">
          <Form.Item name="name" label="Facebook name" tooltip="The Facebook username/display name — placeholder for now, map later.">
            <Input placeholder="(map later)" />
          </Form.Item>
          <Form.Item name="email" label="Email">
            <Input placeholder="account@gmail.com" />
          </Form.Item>
          <Form.Item name="notes" label="Notes"><Input.TextArea rows={2} /></Form.Item>
        </Form>
      </Modal>

      {/* Membership modal */}
      <Modal title={`Members — ${memberModal?.name || ''}`} open={!!memberModal}
        onCancel={() => setMemberModal(null)} onOk={saveMembers} confirmLoading={saving} okText="Save">
        <Text type="secondary" style={{ fontSize: 13 }}>Which accounts can post to this forum?</Text>
        <Select mode="multiple" allowClear style={{ width: '100%', marginTop: 8 }} placeholder="Select accounts"
          value={memberIds} onChange={setMemberIds} optionFilterProp="label"
          options={accounts.map(a => ({ value: a.id, label: acctLabel(a) }))} />
      </Modal>
    </MainLayout>
  );
}
