'use client';

/**
 * Mon compte → Abonnement : rétractation et suivi — CDC 6 §6.2 et §7.5.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DEUX AFFICHAGES, SELON QU'UNE DEMANDE EXISTE OU NON
 *
 * Avant demande (§6.2) : date de souscription, date limite, bouton
 * « Renoncer au contrat ici », et une explication distinguant rétractation et
 * résiliation — la confusion entre les deux est la principale source de
 * litige, l'une remboursant intégralement et l'autre pas.
 *
 * Après demande (§7.5) : « Rétractation enregistrée », date et heure,
 * référence, statut de l'annulation, statut du remboursement, montant, date
 * limite de récupération des données, liens d'export et de suppression.
 *
 * Le §6.2 précise qu'« après expiration du délai, le bouton peut être masqué
 * dans l'espace personnel, mais le lien public reste disponible ». C'est ce
 * que fait ce composant : il masque le bouton et renvoie vers /retractation.
 * ══════════════════════════════════════════════════════════════════════════
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, FileMinus, Download, ExternalLink } from 'lucide-react';

interface Contract {
  offerLabel: string;
  billingPeriodLabel: string;
  contractConcludedAt: string | null;
  withdrawalDeadlineAt: string | null;
  deadlineDeferred: boolean;
  deadlineDeferralReason: string | null;
  amountLabel: string;
}

interface ExistingRequest {
  publicReference: string;
  status: string;
  requestedAt: string;
  cancellationStatus: string;
  amountExpected: number | null;
  amountRefunded: number;
  dataExportDeadlineAt: string | null;
}

const STATUS_LABELS: Record<string, string> = {
  received: 'Enregistrée, traitement en cours',
  manual_review: 'En cours d’examen par nos équipes',
  processing: 'Traitement en cours',
  completed: 'Traitée',
  failed: 'Incident technique — nos équipes sont alertées',
  rejected: 'Examinée et non retenue',
};

const CANCELLATION_LABELS: Record<string, string> = {
  pending: 'En cours',
  cancelled: 'Abonnement annulé',
  failed: 'Incident — nos équipes interviennent',
  not_applicable: 'Sans objet',
};

function parisDate(iso: string | null): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'long' })
    .format(new Date(iso));
}

function parisDateTime(iso: string): string {
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris', dateStyle: 'long', timeStyle: 'short',
  }).format(new Date(iso));
}

function euros(cents: number | null): string {
  if (cents === null) return '—';
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(cents / 100);
}

export function WithdrawalCard() {
  const [loading, setLoading] = useState(true);
  const [eligible, setEligible] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [contract, setContract] = useState<Contract | null>(null);
  const [request, setRequest] = useState<ExistingRequest | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/withdrawal/eligibility', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) { setLoading(false); return; }
        setEligible(Boolean(data.eligible));
        setMessage(data.message ?? null);
        setContract(data.contract ?? null);
        setRequest(data.existingRequest ?? null);
        setLoading(false);
      })
      .catch(() => setLoading(false));
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <Card>
        <CardContent className="py-6 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Chargement…
        </CardContent>
      </Card>
    );
  }

  // ── Suivi d'une demande enregistrée (§7.5) ────────────────────────────
  if (request) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileMinus className="w-5 h-5" />
            Rétractation enregistrée
          </CardTitle>
          <CardDescription>
            Votre déclaration a bien été reçue. Voici son avancement.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="text-sm rounded-lg border border-[color:var(--border-subtle)] divide-y divide-[color:var(--border-subtle)]">
            <Row label="Référence" value={request.publicReference} mono />
            <Row label="Reçue le" value={parisDateTime(request.requestedAt)} />
            <Row label="Statut" value={STATUS_LABELS[request.status] ?? request.status} />
            <Row label="Abonnement" value={CANCELLATION_LABELS[request.cancellationStatus] ?? request.cancellationStatus} />
            <Row label="Remboursement" value={`${euros(request.amountRefunded)} sur ${euros(request.amountExpected)}`} />
            <Row label="Données récupérables jusqu’au" value={parisDate(request.dataExportDeadlineAt)} />
          </dl>

          {/* §7.5 : « les liens d'export et de suppression du compte ». */}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" asChild>
              <Link href="/mon-compte/informations">
                <Download className="w-4 h-4 mr-1.5" />
                Exporter mes données
              </Link>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link href={`/retractation/suivi/${request.publicReference}`}>
                <ExternalLink className="w-4 h-4 mr-1.5" />
                Détail de la demande
              </Link>
            </Button>
          </div>

          <p className="text-xs text-muted-foreground">
            Souscrire un nouvel abonnement avant cette date réactive votre compte et
            annule la suppression prévue.
          </p>
        </CardContent>
      </Card>
    );
  }

  // ── Avant toute demande (§6.2) ────────────────────────────────────────
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileMinus className="w-5 h-5" />
          Droit de rétractation
        </CardTitle>
        <CardDescription>
          Quatorze jours pour renoncer à un abonnement souscrit en ligne.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* §6.2 : « une explication distincte de la résiliation ». */}
        <div className="rounded-lg border border-[color:var(--border-subtle)] p-3 text-sm">
          <p className="text-muted-foreground">
            <strong className="text-[color:var(--text-primary)]">Ce n&apos;est pas une résiliation.</strong>{' '}
            La rétractation annule le contrat et donne lieu à un remboursement
            intégral. La résiliation met fin à l&apos;abonnement à son échéance,
            sans remboursement.
          </p>
        </div>

        {contract && (
          <dl className="text-sm rounded-lg border border-[color:var(--border-subtle)] divide-y divide-[color:var(--border-subtle)]">
            <Row label="Offre" value={`${contract.offerLabel} — facturation ${contract.billingPeriodLabel}`} />
            <Row label="Souscrit le" value={parisDate(contract.contractConcludedAt)} />
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
        )}

        {eligible ? (
          <Button variant="outline" className="w-full" asChild>
            {/* §6.1 : libellé imposé mot pour mot. */}
            <Link href="/retractation">Renoncer au contrat ici</Link>
          </Button>
        ) : (
          <div className="space-y-2">
            <Badge variant="outline" className="text-muted-foreground">
              Rétractation en ligne indisponible
            </Badge>
            {message && <p className="text-sm text-muted-foreground">{message}</p>}
            {/* §6.2 : le bouton peut être masqué, le lien public demeure. */}
            <p className="text-xs">
              <Link href="/retractation" className="text-primary hover:underline">
                Renoncer au contrat ici
              </Link>
            </p>
          </div>
        )}
      </CardContent>
    </Card>
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
