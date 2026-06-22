'use client';

import { useEffect } from 'react';
import { useBreadcrumb } from '@/contexts/BreadcrumbContext';
import InformationsTab from './informations/InformationsTab';

export default function MonComptePage() {
  const { setBreadcrumbs } = useBreadcrumb();

  useEffect(() => {
    setBreadcrumbs([{ label: 'Mon compte' }]);
  }, [setBreadcrumbs]);

  return (
    <div className="space-y-6 w-full max-w-full overflow-x-hidden">
      <div>
        <h1 className="text-3xl font-bold">Mon compte</h1>
        <p className="text-muted-foreground mt-1">Gérez vos informations personnelles et votre abonnement</p>
      </div>
      <InformationsTab />
    </div>
  );
}
