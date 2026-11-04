'use client';

/**
 * Mon compte — carte « Parrainage » (lot 26).
 *
 * Le parrainage était un sous-bloc de « Mon abonnement ». Il a désormais sa
 * propre carte, sur le modèle des autres tiroirs de Mon compte (titre, une
 * ligne, chevron). Même règle d'affichage qu'auparavant : le membre invité
 * d'un compte Duo n'a pas de parrainage (il ne paie pas l'abonnement).
 *
 * Lot 108H (décision PO) : plus de ligne de description sous le titre — elle
 * répétait le bénéfice et était tronquée sur mobile (« 1 mois offert pour
 * vous à chaque proche qui… »). Le bénéfice est dit une fois, dans le bloc.
 */
import { Gift } from 'lucide-react';
import { CollapsibleCard } from '@/components/ui/collapsible-card';
import { useSession } from '@/hooks/useSession';
import { ReferralBlock } from './ReferralBlock';

export function ReferralCard() {
  const { user } = useSession();
  if (!user || user.duoRole === 'MEMBER') return null;
  return (
    <CollapsibleCard
      icon={<Gift className="w-5 h-5" />}
      title="Parrainage"
    >
      <ReferralBlock withHeading={false} />
    </CollapsibleCard>
  );
}
