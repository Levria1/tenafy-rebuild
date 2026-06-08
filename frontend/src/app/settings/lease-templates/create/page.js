'use client';

import MainLayout from '../../../../components/Layout';
import LeaseTemplateEditor from '../../../../components/LeaseTemplateEditor';

export default function CreateLeaseTemplatePage() {
  return (
    <MainLayout>
      <LeaseTemplateEditor mode="create" />
    </MainLayout>
  );
}
