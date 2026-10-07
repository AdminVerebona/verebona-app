'use client';

/**
 * Mon compte → Abonnement : rétractation — CDC 6 §6.2.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN SEUL AFFICHAGE (lot 32, décisions PO Q1/Q2)
 *
 * Date du paiement (départ du délai), date limite, bouton « Renoncer au
 * contrat ici », explication distinguant rétractation et résiliation, et
 * AVERTISSEMENT : la rétractation supprime le compte immédiatement.
 *
 * Plus de suivi de demande : la rétractation est traitée sur-le-champ et le
 * compte supprimé — il n'y a plus de Mon compte où suivre quoi que ce soit.
 *
 * Le §6.2 précise qu'« après expiration du délai, le bouton peut être masqué
 * dans l'espace personnel, mais le lien public reste disponible ». Lot 26 :
 * TOUT le bloc disparaît à la clôture du délai (J+15 à 00 h 00, Paris), et
 * plus seulement le bouton. La décision est prise par le serveur
 * (`offerWithdrawal`, `shouldOfferWithdrawal`) — même fonction que le refus
 * de l'API. Le lien public reste au pied des pages hors session.
 *
 * TIROIR FERMÉ PAR DÉFAUT — LE LIEN RESTE VISIBLE
 *
 * Le bloc est replié par défaut (ticket « tiroirs »). Mais la fonction de
 * rétractation doit rester visible et directement accessible pendant tout
 * le délai (§6.1, et directive (UE) 2023/2673 sur le « bouton de
 * rétractation ») : « Renoncer au contrat ici » est donc placé SOUS
 * l'en-tête, hors du contenu repliable, et reste affiché tiroir fermé.
 * ══════════════════════════════════════════════════════════════════════════
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { CollapsibleCard } from '@/components/ui/collapsible-card';
import { Button } from '@/components/ui/button';
import { AlertTriangle, FileMinus } from 'lucide-react';

interface Contract {
  offerLabel: string;
  billingPeriodLabel: string;
  contractConcludedAt: string | null;
  paidAt: string | null;
  withdrawalDeadlineAt: string | null;
  deadlineDeferred: boolean;
  deadlineDeferralReason: string | null;
  amountLabel: string;
}

function parisDate(iso: string | null): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'long' })
    .format(new Date(iso));
}

export function WithdrawalCard() {
  const [loading, setLoading] = useState(true);
  const [offerWithdrawal, setOfferWithdrawal] = useState(false);
  const [contract, setContract] = useState<Contract | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/withdrawal/eligibility', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) { setLoading(false); return; }
        setOfferWithdrawal(Boolean(data.offerWithdrawal));
        setContract(data.contract ?? null);
        setLoading(false);
      })
      .catch(() => setLoading(false));
    return () => { cancelled = true; };
  }, []);

  // Rien pendant le chargement : la plupart des comptes n'ont aucun bloc à
  // afficher (délai écoulé, essai), un squelette apparaîtrait puis s'effacerait.
  if (loading) return null;

  // ── Avant toute demande (§6.2) ────────────────────────────────────────
  // Délai écoulé, aucun contrat payant, membre Duo : aucun bloc (lot 26).
  if (!offerWithdrawal) return null;

  // Le lien de rétractation est rendu hors du tiroir : visible même fermé.
  const lienRetractation = (
    <Button variant="outline" className="w-full" asChild>
      {/* §6.1 : libellé imposé mot pour mot. */}
      <Link href="/retractation">Renoncer au contrat ici</Link>
    </Button>
  );

  return (
    <CollapsibleCard
      icon={<FileMinus className="w-5 h-5" />}
      title="Droit de rétractation"
      description="Quatorze jours pour renoncer à un abonnement souscrit en ligne."
      headerExtra={lienRetractation}
      contentClassName="space-y-4"
    >
      {/* Lot 32 (PO-Q1) : avertissement explicite AVANT toute action. */}
      <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-destructive" aria-hidden />
        <p>
          <strong>Votre compte sera supprimé immédiatement.</strong>{' '}
          Dès la confirmation, l&apos;accès est coupé et toutes vos données
          (biens, documents, fichiers, échéances) sont définitivement effacées.
          Exportez-les avant, depuis Mes informations.
        </p>
      </div>

      {/* §6.2 : « une explication distincte de la résiliation ». */}
      <div className="rounded-lg border border-[color:var(--border-subtle)] p-3 text-sm">
        <p className="text-muted-foreground">
          <strong className="text-[color:var(--text-primary)]">Ce n&apos;est pas une résiliation.</strong>{' '}
          La rétractation annule le contrat et donne lieu à un remboursement
          intégral. La résiliation met fin à l&apos;abonnement à son échéance,
          sans remboursement.
        </p>
      </div>

      {contract ? (
        <dl className="text-sm rounded-lg border border-[color:var(--border-subtle)] divide-y divide-[color:var(--border-subtle)]">
          <Row label="Offre" value={`${contract.offerLabel} — facturation ${contract.billingPeriodLabel}`} />
          <Row label="Payé le" value={parisDate(contract.paidAt ?? contract.contractConcludedAt)} />
          <Row
            label="Délai jusqu’au"
            value={
              parisDate(contract.withdrawalDeadlineAt) +
              (contract.deadlineDeferred && contract.deadlineDeferralReason
                ? ` (reporté : ${contract.deadlineDeferralReason})`
                : '')
            }
          />
          <Row label="Remboursement estimé" value={contract.amountLabel} />
        </dl>
      ) : null}
    </CollapsibleCard>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4 px-3 py-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`text-right ${mono ? 'font-mono' : ''}`}>{value}</dd>
    </div>
  );
}
