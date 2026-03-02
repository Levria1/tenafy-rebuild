'use client';

import { Button, Result } from 'antd';
import { useRouter } from 'next/navigation';

export default function Error500Page() {
  const router = useRouter();

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: '#f0f2f5' }}>
      <Result
        status="500"
        title="500"
        subTitle="Sorry, something went wrong on our end."
        extra={<Button type="primary" onClick={() => router.push('/dashboard')}>Back to Dashboard</Button>}
      />
    </div>
  );
}
