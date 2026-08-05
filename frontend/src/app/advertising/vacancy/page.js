'use client';

// The Vacancy page moved to Leasing → /leasing/vacancy. Keep this path as a
// redirect so old bookmarks/links still work.
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function VacancyMoved() {
  const router = useRouter();
  useEffect(() => { router.replace('/leasing/vacancy'); }, [router]);
  return null;
}
