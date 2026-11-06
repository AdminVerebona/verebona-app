'use client';

/**
 * Lot 113B (#690) — bloc « Coût total de possession » VERROUILLÉ (compte sans
 * fonctions Premium : Standard, et comptes restreints — essai échu, impayé,
 * résiliation — qui reçoivent le même 403 `PREMIUM_REQUIRED` du serveur).
 *
 *   · Titre et description : textes EXACTS du ticket PO #690 (« Vos données
 *     sont conservées » supprimé).
 *   · CTA « Découvrir les offres Premium » : modèle de CTA existant
 *     (`Button` + `Link` vers `OFFERS_PATH`, cf. `RestrictedStateNotice`,
 *     `SidebarPlanCard`) — mène DIRECTEMENT à la page « Offres »
 *     (`/mon-compte/offres`), sans écran intermédiaire ni appel Stripe.
 *   · Application iOS / Android : règle des stores (lot 97B, décision PO A9) —
 *     aucun lien d'offre ; à la place, le message sobre existant
 *     (`NativeCommerceNotice`). Le Web (desktop et mobile) affiche le CTA.
 *
 * Présentationnel : aucune donnée TCO reçue ni affichée (le serveur refuse
 * avant toute lecture financière). Jamais rendu pour Premium / Premium Duo /
 * essai actif (`TcoSection` ne l'affiche que sur `PREMIUM_REQUIRED`).
 */
import Link from 'next/link';
import { Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { NativeCommerceNotice } from '@/components/native/NativeCommerceNotice';
import { OFFERS_PATH } from '@/lib/write-blocked';

/** Textes du ticket #690, repris à l'identique. */
export const TCO_LOCKED_TITLE = 'Suivez le coût de possession de vos biens';
export const TCO_LOCKED_DESCRIPTION =
  'Visualisez combien vous coûte chaque bien dans le temps : achat, entretien, assurances, travaux et autres dépenses. Cette fonctionnalité est disponible avec Premium et Premium Duo.';
export const TCO_LOCKED_CTA_LABEL = 'Découvrir les offres Premium';

export function TcoLockedNotice({ commerceHidden }: { commerceHidden: boolean }) {
  return (
    <div className="rounded-lg border border-border p-4 text-sm space-y-2" data-tco-locked>
      <h3 className="flex items-start gap-2 font-semibold text-foreground">
        <Lock className="w-4 h-4 mt-0.5 shrink-0" aria-hidden />
        <span className="min-w-0">{TCO_LOCKED_TITLE}</span>
      </h3>
      <p className="text-muted-foreground">{TCO_LOCKED_DESCRIPTION}</p>
      <div className="pt-1">
        {commerceHidden ? (
          <NativeCommerceNotice className="text-xs text-[color:var(--text-muted)]" />
        ) : (
          <Button size="sm" asChild className="w-full sm:w-auto min-h-11 sm:min-h-8" data-tco-offers-cta>
            <Link href={OFFERS_PATH}>{TCO_LOCKED_CTA_LABEL}</Link>
          </Button>
        )}
      </div>
    </div>
  );
}
