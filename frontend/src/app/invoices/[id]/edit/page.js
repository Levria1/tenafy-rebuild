'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Card, Form, Input, InputNumber, Select, DatePicker, Button, message, Row, Col } from 'antd';
import MainLayout from '../../../../components/Layout';
import { invoice, property, tenant } from '../../../../lib/api';

export default function InvoiceEditPage() {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [properties, setProperties] = useState([]);
  const [tenants, setTenants] = useState([]);
  const router = useRouter();
  const params = useParams();
  const invoiceId = params.id;

  useEffect(() => {
    loadData();
    loadInvoice();
  }, [invoiceId]);

  const loadData = async () => {
    try {
      const [propRes, tenantRes] = await Promise.all([
        property.getAll(),
        tenant.getAll()
      ]);
      if (propRes.data.code === 200) setProperties(propRes.data.data || []);
      if (tenantRes.data.code === 200) setTenants(tenantRes.data.data || []);
    } catch (error) {
      console.error('Failed to load data');
    }
  };

  const loadInvoice = async () => {
    try {
      const response = await invoice.get(invoiceId);
      if (response.data.code === 200) {
        const data = response.data.data;
        form.setFieldsValue({
          ...data,
          due_date: data.due_date ? { _d: new Date(data.due_date) } : null,
          issue_date: data.issue_date ? { _d: new Date(data.issue_date) } : null,
        });
      }
    } catch (error) {
      message.error('Failed to load invoice');
    } finally {
      setInitialLoading(false);
    }
  };

  const onFinish = async (values) => {
    try {
      setLoading(true);
      await invoice.update(invoiceId, {
        ...values,
        due_date: values.due_date?.format('YYYY-MM-DD'),
        issue_date: values.issue_date?.format('YYYY-MM-DD'),
      });
      message.success('Invoice updated successfully');
      router.push(`/invoices/${invoiceId}/detail`);
    } catch (error) {
      message.error('Failed to update invoice');
    } finally {
      setLoading(false);
    }
  };

  return (
    <MainLayout>
      <Card title="Edit Invoice" loading={initialLoading}>
        <Form form={form} layout="vertical" onFinish={onFinish}>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="tenant_id" label="Tenant" rules={[{ required: true }]}>
                <Select 
                  placeholder="Select Tenant"
                  options={tenants.map(t => ({ label: `${t.first_name} ${t.last_name}`, value: t.id }))}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="property_id" label="Property">
                <Select 
                  placeholder="Select Property"
                  options={properties.map(p => ({ label: p.display_name, value: p.id }))}
                />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="issue_date" label="Issue Date">
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="due_date" label="Due Date">
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="total_amount" label="Total Amount" rules={[{ required: true }]}>
            <InputNumber min={0} style={{ width: '100%' }} formatter={value => `$ ${value}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',')} />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={3} />
          </Form.Item>
          <Form.Item name="status" label="Status">
            <Select options={[
              { label: 'Pending', value: 'PENDING' },
              { label: 'Paid', value: 'PAID' },
              { label: 'Overdue', value: 'OVERDUE' },
              { label: 'Cancelled', value: 'CANCELLED' },
            ]} />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={loading}>Update Invoice</Button>
          </Form.Item>
        </Form>
      </Card>
    </MainLayout>
  );
}
