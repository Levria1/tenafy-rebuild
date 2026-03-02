'use client';

import { useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';

export default function PropertyDynamicPage() {
  const router = useRouter();
  const params = useParams();

  useEffect(() => {
    if (params.id) {
      router.replace(`/property/${params.id}/detail`);
    }
  }, [params.id, router]);

  return null;
}
