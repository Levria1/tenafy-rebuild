'use client';

import { useParams } from 'next/navigation';
import MainLayout from '../../../../../components/Layout';
import LeaseTemplateEditor from '../../../../../components/LeaseTemplateEditor';

export default function EditLeaseTemplatePage() {
  const params = useParams();
  const id = params?.id;
  return (
    <MainLayout>
      <LeaseTemplateEditor mode="edit" templateId={id} />
    </MainLayout>
  );
}
