'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Card, Form, Input, Button, Select, message } from 'antd';
import MainLayout from '../../../../components/Layout';
import { contact, tenant } from '../../../../lib/api';

const { TextArea } = Input;

export default function SendEmailPage() {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [groups, setGroups] = useState([]);
  const [tenants, setTenants] = useState([]);
  const [recipients, setRecipients] = useState([]);
  const router = useRouter();
  const searchParams = useSearchParams();
  const groupId = searchParams.get('group');

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const [groupRes, tenantRes] = await Promise.all([
        contact.listEmailGroups({}),
        tenant.getAll()
      ]);
      if (groupRes.data.code === 200) {
        setGroups(groupRes.data.data.content || []);
      }
      if (tenantRes.data.code === 200) {
        setTenants(tenantRes.data.data || []);
      }
      if (groupId) {
        form.setFieldValue('group_id', parseInt(groupId));
      }
    } catch (error) {
      console.error('Failed to load data');
    }
  };

  const onGroupChange = async (groupId) => {
    try {
      const response = await contact.getEmailGroup(groupId);
      if (response.data.code === 200) {
        setRecipients(response.data.data.members || []);
      }
    } catch (error) {
      console.error('Failed to load group members');
    }
  };

  const onFinish = async (values) => {
    try {
      setLoading(true);
      await contact.sendEmail(values);
      message.success('Email sent successfully');
      router.push('/contacts?tab=groups');
    } catch (error) {
      message.error('Failed to send email');
    } finally {
      setLoading(false);
    }
  };

  return (
    <MainLayout>
      <Card title="Send Email">
        <Form form={form} layout="vertical" onFinish={onFinish}>
          <Form.Item name="group_id" label="Email Group" rules={[{ required: true }]}>
            <Select 
              placeholder="Select Email Group"
              onChange={onGroupChange}
              options={groups.map(g => ({ label: g.name, value: g.id }))}
            />
          </Form.Item>
          <Form.Item name="recipients" label="Recipients" rules={[{ required: true }]}>
            <Select 
              mode="multiple"
              placeholder="Select Recipients"
              options={tenants.map(t => ({ label: `${t.first_name} ${t.last_name} (${t.email})`, value: t.email }))}
            />
          </Form.Item>
          <Form.Item name="subject" label="Subject" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="body" label="Message" rules={[{ required: true }]}>
            <TextArea rows={8} />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={loading}>Send Email</Button>
          </Form.Item>
        </Form>
      </Card>
    </MainLayout>
  );
}
