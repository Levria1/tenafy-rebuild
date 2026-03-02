'use client';

import { Button, Result } from 'antd';
import { useRouter } from 'next/navigation';

export default function ForbiddenPage() {
  const router = useRouter();

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: '#f0f2f5' }}>
      <Result
        status="403"
        title="403"
        subTitle="Sorry, you don't have permission to access this page."
        extra={<Button type="primary" onClick={() => router.push('/dashboard')}>Back to Dashboard</Button>}
      />
    </div>
  );
}
