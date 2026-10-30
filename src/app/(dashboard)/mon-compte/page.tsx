'use client';

import { useEffect } from 'react';
import { useBreadcrumb } from '@/contexts/BreadcrumbContext';
import InformationsTab from './informations/InformationsTab';
import { NotificationsCard } from '@/components/account/NotificationsCard';
import { LegalInformationCard } from '@/components/account/LegalInformationCard';
import { WithdrawalCard } from '@/components/account/WithdrawalCard';
import { SubscriptionSummary } from '@/components/subscription/SubscriptionSummary';
import { MyDataCard } from './mes-donnees/MyDataCard';
import { ReferralCard } from '@/components/account/ReferralCard';

export default function MonComptePage() {
  const { setBreadcrumbs } = useBreadcrumb();
  // Lot 100D (décision PO A9) : parrainage et rétractation sont des droits
  // de l'utilisateur, affichés AUSSI dans l'application (le lot 97B les avait
  // masqués). Seul l'achat reste sur le site ; aucun prix dans ces cartes.

  useEffect(() => {
    setBreadcrumbs([{ label: 'Mon compte' }]);
  }, [setBreadcrumbs]);

  return (
    <div className="space-y-6 w-full max-w-full overflow-x-hidden">
      <div>
        <h1 className="vb-app-title">Mon compte</h1>
        <p className="text-muted-foreground mt-1">Gérez vos informations personnelles et votre abonnement</p>
      </div>
      {/* Récapitulatif d'abonnement — déplacé depuis `/mon-compte/offres`.
          Sa place est ici : « Mon compte » annonce « gérez vos informations
          personnelles et votre abonnement ». La page des offres sert à en
          choisir une, pas à consulter la sienne. */}
      {/* Lot 26 : l'espace de stockage (CDC BO STO-002) est une ligne de quota
          de « Mon abonnement » ; l'ancienne carte séparée est supprimée. */}
      <SubscriptionSummary />
      {/* Lot 26 : parrainage dans sa propre carte, sorti de « Mon abonnement ». */}
      <ReferralCard />
      {/* Lot 34 (point 10) : « Gestion des notifications » (et les blocs qui
          la suivent) AVANT la « Zone dangereuse », rendue en dernier par
          InformationsTab. */}
      <InformationsTab
        beforeDangerZone={
          <>
            <NotificationsCard />
            <WithdrawalCard />
            {/* Export RGPD « Mes données » (CDC BO GDP-020). */}
            <MyDataCard />
            <LegalInformationCard />
          </>
        }
      />
    </div>
  );
}
