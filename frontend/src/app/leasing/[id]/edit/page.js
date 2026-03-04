'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Card, Form, Input, DatePicker, InputNumber, Select, Button, message, Space } from 'antd';
import MainLayout from '../../../../components/Layout';
import { leasing, property, tenant as tenantApi } from '../../../../lib/api';

export default function LeasingEditPage() {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [properties, setProperties] = useState([]);
  const [units, setUnits] = useState([]);
  const [tenants, setTenants] = useState([]);
  const router = useRouter();
  const params = useParams();
  const leaseId = params.id;

  useEffect(() => {
    loadData();
    loadLease();
  }, [leaseId]);

  const loadData = async () => {
    try {
      const [propRes, tenantRes] = await Promise.all([
        property.getAllWithUnits(),
        tenantApi.getAll()
      ]);
      if (propRes.data.code === 200) {
        setProperties(propRes.data.data || []);
      }
      if (tenantRes.data.code === 200) {
        setTenants(tenantRes.data.data || []);
      }
    } catch (error) {
      console.error('Failed to load data');
    }
  };

  const loadLease = async () => {
    try {
      const response = await leasing.get(leaseId);
      if (response.data.code === 200) {
        const data = response.data.data;
        form.setFieldsValue({
          ...data,
          start_date: data.start_date ? { _d: new Date(data.start_date) } : null,
          end_date: data.end_date ? { _d: new Date(data.end_date) } : null,
          move_in_date: data.move_in_date ? { _d: new Date(data.move_in_date) } : null,
          move_out_date: data.move_out_date ? { _d: new Date(data.move_out_date) } : null,
          additionalTenantIds: (data.additional_tenants || []).map(t => t.id),
        });
        if (data.property_id) {
          const prop = properties.find(p => p.id === data.property_id);
          if (prop?.units) setUnits(prop.units);
        }
      }
    } catch (error) {
      message.error('Failed to load lease');
    } finally {
      setInitialLoading(false);
    }
  };

  const onPropertyChange = async (propertyId) => {
    try {
      const response = await property.getUnits(propertyId);
      if (response.data.code === 200) {
        setUnits(response.data.data || []);
      }
    } catch (error) {
      console.error('Failed to load units');
    }
  };

  const onFinish = async (values) => {
    try {
      setLoading(true);
      const data = {
        ...values,
        start_date: values.start_date?.format('YYYY-MM-DD'),
        end_date: values.end_date?.format('YYYY-MM-DD'),
        move_in_date: values.move_in_date?.format('YYYY-MM-DD'),
        move_out_date: values.move_out_date?.format('YYYY-MM-DD'),
        additionalTenantIds: values.additionalTenantIds || [],
      };
      await leasing.update(leaseId, data);
      message.success('Lease updated successfully');
      router.push(`/leasing/${leaseId}/detail`);
    } catch (error) {
      message.error('Failed to update lease');
    } finally {
      setLoading(false);
    }
  };

  return (
    <MainLayout>
      <Card title="Edit Lease" loading={initialLoading}>
        <Form form={form} layout="vertical" onFinish={onFinish}>
          <Form.Item name="property_id" label="Property" rules={[{ required: true }]}>
            <Select 
              placeholder="Select Property" 
              onChange={onPropertyChange}
              options={properties.map(p => ({ label: p.display_name, value: p.id }))}
            />
          </Form.Item>
          <Form.Item name="unit_id" label="Unit" rules={[{ required: true }]}>
            <Select 
              placeholder="Select Unit"
              options={units.map(u => ({ label: u.unit_number, value: u.id }))}
            />
          </Form.Item>
          <Form.Item name="tenant_id" label="Tenant" rules={[{ required: true }]}>
            <Select
              placeholder="Select Tenant"
              options={tenants.map(t => ({ label: `${t.first_name} ${t.last_name}`, value: t.id }))}
            />
          </Form.Item>
          <Form.Item name="additionalTenantIds" label="Additional Tenants">
            <Select
              mode="multiple"
              placeholder="Select additional tenants (optional)"
              showSearch
              optionFilterProp="label"
              allowClear
              options={tenants.map(t => ({ label: [t.first_name, t.last_name].filter(Boolean).join(' '), value: t.id }))}
            />
          </Form.Item>
          <Form.Item name="start_date" label="Start Date" rules={[{ required: true }]}>
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="end_date" label="End Date" rules={[{ required: true }]}>
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="monthly_rent" label="Monthly Rent" rules={[{ required: true }]}>
            <InputNumber min={0} style={{ width: '100%' }} formatter={value => `$ ${value}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',')} />
          </Form.Item>
          <Form.Item name="deposit" label="Security Deposit">
            <InputNumber min={0} style={{ width: '100%' }} formatter={value => `$ ${value}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',')} />
          </Form.Item>
          <Form.Item name="status" label="Status">
            <Select options={[
              { label: 'Active', value: 'ACTIVE' },
              { label: 'Pending', value: 'PENDING' },
              { label: 'Expired', value: 'EXPIRED' },
              { label: 'Terminated', value: 'TERMINATED' },
            ]} />
          </Form.Item>
          <Form.Item name="move_in_date" label="Move-in Date">
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="move_out_date" label="Move-out Date">
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="terms" label="Terms & Conditions">
            <Input.TextArea rows={4} />
          </Form.Item>
          <Form.Item>
            <Space>
              <Button type="primary" htmlType="submit" loading={loading}>Update Lease</Button>
              <Button onClick={() => router.push(`/leasing/${leaseId}/detail`)}>Cancel</Button>
            </Space>
          </Form.Item>
        </Form>
      </Card>
    </MainLayout>
  );
}
