'use client';

import { useEffect } from 'react';
import { useBreadcrumb } from '@/contexts/BreadcrumbContext';
import InformationsTab from './informations/InformationsTab';
import { NotificationsCard } from '@/components/account/NotificationsCard';
import { LegalInformationCard } from '@/components/account/LegalInformationCard';
import { WithdrawalCard } from '@/components/account/WithdrawalCard';
import { SubscriptionSummary } from '@/components/subscription/SubscriptionSummary';
import { MyDataCard } from './mes-donnees/MyDataCard';

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
      {/* Récapitulatif d'abonnement — déplacé depuis `/mon-compte/offres`.
          Sa place est ici : « Mon compte » annonce « gérez vos informations
          personnelles et votre abonnement ». La page des offres sert à en
          choisir une, pas à consulter la sienne. */}
      <SubscriptionSummary />
      <InformationsTab />
      <NotificationsCard />
      <WithdrawalCard />
      {/* Export RGPD « Mes données » (CDC BO GDP-020). */}
      <MyDataCard />
      <LegalInformationCard />
    </div>
  );
}
