"use client"

/**
 * Section « Coût total de possession » — Bien › Informations (lot 61, ticket
 * P1 TCO §5 ; remplace le tiroir latéral ouvert depuis « Valorisation », lot
 * 54D). Section dépliable AUTONOME, au même niveau que « Valorisation » et
 * « Assurance », pour toutes les familles (immobilier, véhicule, objet) ;
 * même en-tête et mêmes jetons que les autres sections de l'onglet (cf.
 * `AssetAdditionalInfosSection`). Desktop et mobile : un seul composant responsive.
 *
 *   · Synthèse : coût cumulé documenté, coût d'acquisition, dépenses
 *     complémentaires, coût net estimé / final, complétude ;
 *   · Détail : ventilation par catégorie (montant, nombre), dépenses
 *     retenues (intitulé, date, montant, justificatif ouvrable, dépense
 *     consolidée éventuelle), avoirs / remboursements / indemnités ;
 *   · Valeur et cession ; lot 108C : « Dépenses d'usage » (`TcoUsageSection`) —
 *     forfaits = estimation COMPLÉMENTAIRE du réel par catégorie et période
 *     échue ; la synthèse distingue coût réel documenté, complément estimé et
 *     TCO avec estimations (aucun calcul ici, tout vient du moteur) ;
 *   · Dépenses non retenues ou non attribuées, avec leur motif ; alertes.
 *     Lot 68 : seulement ce qui est utile pour CE bien (non qualifiée, devise,
 *     non ventilée, prévision…) ; les justificatifs repris par une dépense
 *     consolidée s'ouvrent depuis la ligne retenue.
 *   · Lot 75D : détail paginé — nombre de lignes présentées / total TOUJOURS
 *     affiché quand la liste est abrégée, « Afficher les lignes suivantes »
 *     (chargement complémentaire ; totaux toujours exacts) ; montant inconnu
 *     jamais affiché « 0 € » ; rapprochement incertain signalé « à vérifier » ;
 *     coût d'acquisition « non renseigné » ou « sans objet ».
 *   · Lot 111F : synthèse compacte — Coût total, Coût annuel moyen de
 *     possession (HORS prix d'achat du bien), Coût net estimé (dernière
 *     estimation admissible postérieure à l'achat ; bien vendu : coût net
 *     final), Dépenses de l'année ; « – » + icône d'information (survol,
 *     toucher) avec le motif fourni par le moteur (`indicators`) ; sous-partie
 *     « Financement » (coût du crédit à date, prévisionnel, prêts) si utile.
 *   · Lot 76G : indicateurs annuels — dépenses de
 *     l'année (réellement constatées, sélecteur d'année) — DÉRIVÉS par le
 *     moteur (`tco/annual.ts`), jamais recalculés ici. « Dépenses retenues
 *     (N) » est un déclencheur fermé par défaut qui ouvre un SOUS-TIROIR à
 *     droite (mécanisme `Sheet` des autres sous-tiroirs de l'app ; pleine
 *     largeur sur mobile) : liste cumulée, ou filtrée sur l'année choisie.
 *   · Lot 80A : « Dépenses non retenues (N) » — même mécanisme, second
 *     sous-tiroir fermé par défaut (motif de chaque ligne en langage
 *     utilisateur). « Retirer du TCO » sur une retenue, « Ajouter au TCO » sur
 *     une non retenue : DÉCISION de l'utilisateur persistée et réversible
 *     (`POST /api/assets/[id]/tco/decisions`), confirmation légère dans la
 *     ligne (avertissement explicite si l'ajout crée un doublon présumé),
 *     totaux recalculés par le moteur et mis à jour immédiatement. Gestes
 *     calculés par le serveur (`line.actions`). « Justificatif » ouvre le
 *     tiroir document existant (`TcoJustificatif`, bug de la page
 *     `/documents/<id>` corrigé).
 *   · Lot 81D : aucune règle financière ici — le détail de l'année est la
 *     sélection du moteur (`line.annualYear`, `?linesYear=` si la liste est
 *     abrégée) ; brut / net de l'année, année « potentiellement incomplète »
 *     (dépenses sans date), dépenses non réalisées (exclues des trois
 *     indicateurs) ; moyenne sans seuil (« Valeur extrapolée… » fournie par le
 *     moteur) ; actualisation automatique sur les événements de mutation
 *     existants, regroupés (`./tco-refresh`), année choisie conservée.
 *   · Lot 109C : plus de paragraphes d’alertes génériques empilés —
 *     « Points à vérifier » (seulement s'il existe un cas OUVERT : anomalie à
 *     corriger ou information manquante, regroupée, avec nombre exact et accès
 *     à chaque source), lecture du montant en cours (108B, ton neutre), puis
 *     « Bon à savoir » (exclusions normales, déduplication prouvée, vos
 *     choix). Diagnostics calculés par le serveur (`tco/diagnostics.ts`).
 *     « Dépenses non retenues » : des LIGNES et leurs motifs (à revoir /
 *     exclusions normales), pas des erreurs. (Lot 113X : plus aucun état
 *     positif de complétude affiché.)
 *
 *   · Lot 113X (#722) : UNE seule information « dépenses sans date fiable »
 *     sous les indicateurs (près de « Dépenses de l'année »), nombre et
 *     montant calculés par le moteur (`undatedExpenses` = `annual.undated`),
 *     visible quelle que soit l'année choisie, et « Renseigner les dates (N) »
 *     (`TcoUndatedDatesSheet` : saisie dans le champ métier canonique) ; plus
 *     d'état positif de complétude (#722), plus d'avertissement sous la
 *     ventilation, et le point « date non établie » n'est plus répété dans
 *     « Points à vérifier » (`tcoSheetDiagnostics` ; DTO inchangé pour T2/BO).
 *
 *   · Lot 111V : gestes CONTEXTUELS calculés par le serveur (arbitrages :
 *     même fait, dépenses distinctes, exclusion confirmée, nature confirmée ;
 *     correction du document ; annulation d'un choix) dans « Points à
 *     vérifier » et dans chaque ligne ; « Vos choix confirmés » séparés des
 *     exclusions normales ; récupération du montant selon son état réel.
 *
 * Aucun bouton « Modifier » du total : les corrections se font sur les
 * sources (fiche, document) ou par « Ajouter / Retirer du TCO » ligne par
 * ligne. Standard : présentation verrouillée, AUCUN montant reçu (403 serveur
 * avant toute lecture) ; lot 113B : bloc `TcoLockedNotice` (textes PO #690 et
 * CTA « Découvrir les offres Premium » vers Offres). Lecture seule (`canEdit` faux) : aucun geste.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { AlertCircle, ArrowLeft, CalendarDays, ChevronDown, ChevronRight, ChevronUp, Info, Loader2, Lock, MinusCircle, PlusCircle } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { toast } from 'sonner';
// Types seulement : les libellés viennent de la réponse (aucun module serveur ni registre dans le paquet client).
import { TCO_CALCULATION_INFO, type TcoDto } from '@/services/business-operations/tco/dto';
import { TcoJustificatif } from './tco-justificatif';
import { TcoAmountRecoveryNotice } from './tco-amount-recovery';
import { TcoDecidedDiagnostics, TcoInformationDiagnostics, TcoOpenDiagnostics, type TcoDiagnosticsDecide } from './tco-diagnostics';
import { TcoDecisionActions, type TcoArbitrate } from './tco-decision-actions';
import { TCO_UNDATED_LABELS } from '@/services/business-operations/tco/user-decisions';
import { AMOUNT_RECOVERY_PENDING_STATES } from '@/services/business-operations/tco/amount-recovery';
import type { TcoDiagnosticSource } from '@/services/business-operations/tco/diagnostics';
import { TcoUsageSection } from './TcoUsageSection';
import { TcoInfoTip } from './tco-info-tip';
import { createCoalescedRefresh, type CoalescedRefresh } from '@/lib/home/coalesced-refresh';
import { tcoKeptYear, TCO_REFRESH_WINDOW_MS, watchTcoMutations } from './tco-refresh';
import { TcoLoanTermsSheet } from './TcoLoanTermsSheet';
import { TcoLockedNotice } from './tco-locked';
import { useNativeCommerceHidden } from '@/hooks/useNativeCommerceHidden';
import { tcoSheetDiagnostics, tcoUndatedButtonLabel, tcoUndatedMessage } from '@/services/business-operations/tco/undated-expenses';
import { TcoUndatedDatesSheet } from './TcoUndatedDatesSheet';

interface Props {
  assetId: number;
  readOnly?: boolean;
  defaultOpen?: boolean;
}

type Line = TcoDto['lines'][number];
type Annual = TcoDto['annual'];

/** Lot 107C : date au format JJ/MM/AAAA (« Depuis l'achat du bien le 15/03/2020 »). */
function dateNum(d: string | null | undefined): string {
  return d && /^\d{4}-\d{2}-\d{2}/.test(d) ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : '—';
}

/**
 * Lot 107C : point de départ affiché — date et nature fournies par le moteur
 * (`period.start`, `startKind`) : achat du bien, ou début de possession sans
 * achat (location, prêt, don). Aucune règle de date ici.
 */
function depuis(start: string | null | undefined, kind: string | null | undefined): string {
  return kind === 'POSSESSION' ? `Depuis le début de la possession le ${dateNum(start)} (sans achat)` : `Depuis l’achat du bien le ${dateNum(start)}`;
}

/** Lot 111F : l'explication du coût annuel moyen (calcul ou motif) vient du moteur (`indicators.annualAverage`). */
function eur(cents: number | null | undefined): string {
  if (cents == null) return '—';
  return (cents / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
}

function minor(amountMinor: number, currency: string): string {
  if (currency === 'XXX') return `${(amountMinor / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2 })} (devise à confirmer)`;
  try { return (amountMinor / 100).toLocaleString('fr-FR', { style: 'currency', currency }); } catch { return `${(amountMinor / 100).toFixed(2)} ${currency}`; }
}

function dateFr(d: string | null | undefined): string {
  if (!d) return '—';
  try { return new Date(`${d.slice(0, 10)}T00:00:00Z`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }); } catch { return d; }
}

/** Lot 108C : complément estimé de l'année affichée (moteur : `usage.complement.byYear`), 0 si aucun. */
function anneeSelEstime(c: TcoDto['usage']['complement'] | null, annual: Annual | null, year: number | null): number {
  if (!c || !annual) return 0;
  const y = tcoKeptYear(year, annual.years, annual.defaultYear);
  return c.byYear.find((x) => x.year === y)?.complementCents ?? 0;
}

const NEGATIVE = new Set(['REDUCTION', 'REFUND', 'INDEMNITY']);
/** Lot 111V : confirmation (toast) de chaque geste. */
const MESSAGES_CHOIX: Readonly<Record<string, string>> = {
  INCLUDE: 'Dépense ajoutée au coût de possession', EXCLUDE: 'Dépense retirée du coût de possession',
  CONFIRM_EXCLUSION: 'Exclusion confirmée', SAME_FACT: 'Même dépense confirmée : comptée une seule fois',
  DISTINCT_FACTS: 'Dépenses distinctes confirmées', REQUALIFY: 'Dépense comptée dans le coût de possession', REVERT: 'Votre choix est annulé',
  // Lot 113N : décision sur la date (la dépense reste comptée).
  CONFIRM_UNDATED: 'Dépense conservée sans date', REVERT_UNDATED: 'Votre choix est annulé',
};

const RETENUE = new Set(['RETAINED_DIRECT', 'RETAINED_CONSOLIDATED']);


/** Lot 111F : libellés des modes de valorisation (mêmes codes que la valorisation du bien). */
const VALUATION_MODE_LABELS: Record<string, string> = {
  ESTIMATION_AGENCE: 'Estimation agence', EXPERTISE_NOTARIALE: 'Expertise notariale', EXPERTISE_INDEPENDANTE: 'Expertise indépendante',
  AVIS_VALEUR: 'Avis de valeur', SIMULATION_OUTIL: 'Simulation outil en ligne', ESTIMATION_PERSONNELLE: 'Estimation personnelle',
};

/**
 * Lot 111F : indicateur compact — valeur, ou « – » (non calculable) ; l'icône d'information donne la définition ou le
 * motif fourni par le moteur (survol desktop, toucher mobile).
 */
function Indicateur({ titre, valeur, info, sous, note, ...rest }: { titre: string; valeur: string | null; info: string; sous?: string | null; note?: string | null } & Record<`data-${string}`, string>) {
  return (
    <div className="rounded-lg border border-border bg-card p-3 min-w-0" {...rest}>
      <div className="flex items-center gap-1">
        <p className="text-xs text-muted-foreground">{titre}</p>
        <TcoInfoTip label={titre} text={info} />
      </div>
      <p className={`text-lg font-semibold tabular-nums ${valeur == null ? 'text-muted-foreground' : 'text-[color:var(--text-primary)]'}`} data-tco-indicator-value>{valeur ?? '–'}</p>
      {sous && <p className="text-xs text-muted-foreground mt-0.5 break-words">{sous}</p>}
      {note && <p className="text-xs text-muted-foreground mt-0.5">{note}</p>}
    </div>
  );
}

function Bloc({ title, children, ...rest }: { title: string; children: React.ReactNode } & Record<`data-${string}`, boolean | string>) {
  return (
    <section className="space-y-2" {...rest}>
      <h3 className="vb-app-subsection m-0">{title}</h3>
      {children}
    </section>
  );
}

/** Lot 112D : capital restant dû des prêts (par prêt si plusieurs) ; « non établi » + ce qui manque, jamais une estimation. */
function TcoOutstanding({ financing, canEdit = false, onOpenTerms }: { financing: NonNullable<TcoDto['indicators']>['financing']; canEdit?: boolean; onOpenTerms?: (loanKey: string) => void }) {
  const o = financing.outstanding;
  if (!o) return null;
  const loans = financing.loans.filter((p) => p.outstanding);
  const valeur = (x: { status: string; cents: number | null; asOf: string | null }) =>
    (x.status === 'ESTABLISHED' && x.cents != null ? `${eur(x.cents)}${x.asOf ? ` au ${x.asOf.slice(8, 10)}/${x.asOf.slice(5, 7)}/${x.asOf.slice(0, 4)}` : ''}` : 'non établi');
  return (
    <div className="space-y-1.5" data-tco-outstanding={o.status}>
      <div className="flex items-center gap-1.5">
        <span className="text-sm font-medium text-[color:var(--text-primary)]">Capital restant dû</span>
        <TcoInfoTip label="Capital restant dû" text={o.text} />
      </div>
      <div className="divide-y divide-border">
        {loans.length > 1 && o.cents != null && <Ligne label="Total des prêts" value={eur(o.cents)} strong />}
        {loans.map((p) => (
          <div key={p.key} className="py-1" data-tco-outstanding-loan={p.outstanding!.status}>
            <Ligne label={loans.length > 1 ? [p.label, p.lender, p.reference].filter(Boolean).join(' · ') : 'Montant'} value={valeur(p.outstanding!)} strong={loans.length === 1 && p.outstanding!.status === 'ESTABLISHED'} muted={p.outstanding!.status !== 'ESTABLISHED'} />
            <p className={`text-xs ${p.outstanding!.status === 'ESTABLISHED' ? 'text-muted-foreground' : 'text-[color:var(--attention-on-soft)]'}`} data-tco-outstanding-label>{p.outstanding!.label}</p>
            {p.outstanding!.installment && (
              <p className="text-xs text-muted-foreground" data-tco-outstanding-installment>
                Échéance hors assurance : {eur(p.outstanding!.installment.cents)}{p.outstanding!.installment.source === 'THEORETICAL' ? ' (calculée)' : ''}
                {p.outstanding!.installment.insuranceCents != null ? ` · assurance emprunteur : ${eur(p.outstanding!.installment.insuranceCents)} par échéance, distincte du capital` : ''}.
              </p>
            )}
            {p.outstanding!.notes.map((n, i) => <p key={i} className="text-xs text-muted-foreground">{n}</p>)}
            {/* Lot 112H : conditions du prêt — saisie (Premium / Duo / essai, bien modifiable) ou consultation seule. */}
            {onOpenTerms && p.operationId != null && p.outstanding!.fields && (
              <Button type="button" variant="ghost" size="sm" className="min-h-[44px] -ml-2 px-2 text-[color:var(--accent)]" onClick={() => onOpenTerms(p.key)} data-tco-loan-terms-open={p.key}>
                {!canEdit ? 'Voir les conditions du prêt' : p.outstanding!.status === 'ESTABLISHED' ? 'Modifier les conditions du prêt' : 'Compléter les conditions du prêt'}
                <ChevronRight className="h-4 w-4" aria-hidden />
              </Button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function Ligne({ label, value, muted, strong }: { label: string; value: string; muted?: boolean; strong?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 text-sm">
      <span className={`min-w-0 ${muted ? 'text-muted-foreground' : 'text-[color:var(--text-primary)]'}`}>{label}</span>
      <span className={`shrink-0 tabular-nums ${strong ? 'font-semibold text-[color:var(--text-primary)]' : ''}`}>{value}</span>
    </div>
  );
}

/**
 * Lot 109D : détail consultable d'une dépense (composition du prix net, méthode de calcul, contexte de rattachement)
 * — fermé par défaut : la ligne principale reste « intitulé — date — montant ».
 */
function TcoLigneDetail({ l }: { l: Line }) {
  const c = l.composition;
  if (!c && !l.context) return null;
  const m = (v: number) => (c ? minor(v, c.currency) : '');
  return (
    <details className="mt-0.5 text-xs text-muted-foreground" data-tco-line-detail>
      <summary className="cursor-pointer select-none min-h-[32px] md:min-h-0 inline-flex items-center text-primary">Détail du calcul</summary>
      <div className="mt-1 space-y-0.5 pl-1">
        {c && c.linesMinor > 0 && <p data-tco-composition="lines">Articles : {m(c.linesMinor)}</p>}
        {c && c.feesMinor > 0 && <p data-tco-composition="fees">Frais (livraison, port…) : + {m(c.feesMinor)}</p>}
        {c && c.discountsMinor > 0 && <p data-tco-composition="discounts">Remises : − {m(c.discountsMinor)} (intégrées au prix, pas un avoir)</p>}
        {c && <p data-tco-composition="net" className="text-[color:var(--text-primary)]">Prix net TTC : {m(c.netMinor)}</p>}
        {c && <p data-tco-composition="method">{c.method}</p>}
        {l.context && <p data-tco-line-context>{l.context}</p>}
      </div>
    </details>
  );
}

/** Lot 80A : geste « Ajouter / Retirer du TCO » demandé sur une ligne (confirmé dans la ligne). */
type Decide = (l: Line, action: 'INCLUDE' | 'EXCLUDE', confirmDuplicate: boolean) => Promise<{ ok: true } | { ok: false; duplicateWarning?: string }>;

function LigneDepense({ l, t, canEdit = false, onDecide, review = false, focused = false, arbitrate }: { l: Line; t: TcoDto; canEdit?: boolean; onDecide?: Decide; review?: boolean; focused?: boolean; arbitrate?: TcoArbitrate }) {
  const retenue = RETENUE.has(l.status);
  // Lot 80A : confirmation légère dans la ligne (pas de fenêtre), avertissement de doublon présumé explicite.
  const [confirm, setConfirm] = useState<null | { action: 'INCLUDE' | 'EXCLUDE'; duplicateWarning: string | null }>(null);
  const [busy, setBusy] = useState(false);
  const actions = l.actions;
  const parUtilisateur = l.userDecision?.applied ? l.userDecision.decision : null;
  const valider = async () => {
    if (!confirm || !onDecide) return;
    setBusy(true);
    try {
      const r = await onDecide(l, confirm.action, !!confirm.duplicateWarning);
      if (r.ok) setConfirm(null);
      else if (r.duplicateWarning) setConfirm({ action: 'INCLUDE', duplicateWarning: r.duplicateWarning });
    } finally {
      setBusy(false);
    }
  };
  const montant = retenue ? l.includedCents : l.eurCents;
  const signe = l.kind && NEGATIVE.has(l.kind) ? '− ' : '';
  // Lot 75D (D) : montant inconnu — jamais « 0,00 € ».
  const valeur = l.amountUnknown ? 'Montant inconnu' : montant != null ? `${signe}${eur(montant)}` : minor(l.amountMinor, l.currency);
  return (
    <div
      className={`py-2 text-sm outline-none ${focused ? 'rounded-md ring-2 ring-primary/40 bg-primary/5 px-2 -mx-2' : ''}`}
      tabIndex={-1} data-tco-line={l.id} data-tco-line-status={l.status} {...(review ? { 'data-tco-line-review': true } : {})}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[color:var(--text-primary)] break-words">{l.label}</p>
          <p className="text-xs text-muted-foreground">
            {dateFr(l.date)}
            {/* Lot 86F : fondement de la date (paiement, facture…) ou « Date non établie » — calculé par le serveur. */}
            {l.dateLabel && retenue ? <span data-tco-line-date-basis> ({l.dateLabel.charAt(0).toLowerCase()}{l.dateLabel.slice(1)})</span> : null}
            {l.category ? ` · ${t.categoryLabels[l.category]}` : ''}
            {l.operationLabel && l.source !== 'OPERATION' ? ` · ${l.operationLabel}` : ''}
          </p>
        </div>
        <span className={`shrink-0 tabular-nums ${l.amountUnknown ? 'text-muted-foreground' : ''}`}>{valeur}</span>
      </div>
      {/* Lot 109C : ligne concernée par un point à vérifier (mention écrite, pas seulement une couleur). */}
      {review && <p className="text-xs font-medium text-[color:var(--attention-on-soft)] mt-0.5" data-tco-line-review-label>À revoir — voir « Points à vérifier »</p>}
      {!retenue && (
        <p className="text-xs text-muted-foreground mt-0.5" data-tco-line-reason>
          {l.reason === 'USER_EXCLUDED' ? t.lineReasonLabels[l.reason] : <>{t.lineStatusLabels[l.status]}{l.reason ? ` — ${t.lineReasonLabels[l.reason]}` : ''}</>}
        </p>
      )}
      {parUtilisateur === 'INCLUDE' && retenue && (
        <p className="text-xs text-primary mt-0.5" data-tco-line-user-decision="INCLUDE">Ajoutée au coût de possession par vous.</p>
      )}
      {/* Lot 113N : dépense conservée sans date par l'utilisateur (mention « Date non établie » conservée ci-dessus). */}
      {retenue && l.undatedConfirmation && (
        <p className="text-xs text-muted-foreground mt-0.5" data-tco-line-undated-confirmed>{TCO_UNDATED_LABELS.decided}</p>
      )}
      {l.uncertain
        ? <p className="text-xs text-[color:var(--attention-on-soft)] mt-0.5" data-tco-line-uncertain>À vérifier : {l.note}</p>
        : l.note && l.reason !== 'USER_EXCLUDED' && !(parUtilisateur === 'INCLUDE' && retenue && l.note === 'Ajoutée au coût de possession par vous.') && (
          <p className={`text-xs mt-0.5 ${parUtilisateur === 'INCLUDE' ? 'text-[color:var(--attention-on-soft)]' : 'text-muted-foreground'}`} data-tco-line-note>
            {parUtilisateur === 'INCLUDE' ? l.note.replace(/^Ajoutée au coût de possession par vous\. /, '') : l.note}
          </p>
        )}
      <TcoLigneDetail l={l} />
      <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5">
        <TcoJustificatif fileId={l.fileId} />
        {/* Lot 68 : justificatifs repris par cette dépense consolidée (plus listés dans les non retenues). */}
        {(l.supportingDocuments ?? []).map((d) => <TcoJustificatif key={d.fileId} fileId={d.fileId} title={d.title} />)}
        {/* Lot 80A : décision de l'utilisateur (gestes calculés par le serveur). */}
        {canEdit && onDecide && actions && !confirm && (retenue ? actions.removable : actions.addable) && (
          <button
            type="button"
            onClick={() => setConfirm({ action: retenue ? 'EXCLUDE' : 'INCLUDE', duplicateWarning: retenue ? null : actions.duplicateWarning })}
            className="inline-flex min-h-[32px] md:min-h-0 items-center gap-1 text-xs text-primary hover:underline"
            data-tco-decision={retenue ? 'EXCLUDE' : 'INCLUDE'}
          >
            {retenue ? <MinusCircle className="w-3 h-3 shrink-0" aria-hidden /> : <PlusCircle className="w-3 h-3 shrink-0" aria-hidden />}
            {retenue ? 'Retirer du TCO' : 'Ajouter au TCO'}
          </button>
        )}
      </div>
      {canEdit && !retenue && actions && !actions.addable && actions.addBlockedReason && l.status !== 'OUT_OF_SCOPE' && !(actions.options ?? []).length && (
        <p className="text-xs text-muted-foreground mt-0.5" data-tco-add-blocked={actions.addBlockedCode ?? ''}>Ajout impossible : {actions.addBlockedReason}</p>
      )}
      {/* Lot 111V : motif réel + gestes adaptés (nature à confirmer, montant à renseigner, doublon, choix à annuler). */}
      {canEdit && !retenue && actions && !actions.addable && actions.addBlockedReason && (actions.options ?? []).length > 0 && (
        <p className="text-xs text-muted-foreground mt-0.5" data-tco-add-blocked={actions.addBlockedCode ?? ''}>{actions.addBlockedReason}</p>
      )}
      {canEdit && arbitrate && actions && !confirm && (
        <TcoDecisionActions
          lineId={l.id} lineKey={l.decisionKey ?? null} options={actions.options ?? []} onDecide={arbitrate}
          categoryLabels={t.categoryLabels} categories={t.requalifyCategories ?? []} exclude={['INCLUDE', 'EXCLUDE']}
        />
      )}
      {confirm && (
        <div className="mt-2 rounded-lg border border-border bg-muted/30 p-3 space-y-2" role="group" aria-label={confirm.action === 'EXCLUDE' ? 'Confirmer le retrait' : 'Confirmer l’ajout'} data-tco-decision-confirm={confirm.action}>
          {confirm.duplicateWarning && (
            <p className="text-xs text-[color:var(--attention-on-soft)] flex items-start gap-1.5" role="alert" data-tco-duplicate-warning>
              <AlertCircle className="w-3.5 h-3.5 mt-px shrink-0" aria-hidden /> <span>{confirm.duplicateWarning}</span>
            </p>
          )}
          <p className="text-xs text-[color:var(--text-primary)]">
            {confirm.action === 'EXCLUDE'
              ? (parUtilisateur === 'INCLUDE' ? 'Annuler votre ajout ? La dépense retrouve le traitement automatique.' : 'Retirer cette dépense du coût de possession ? Vous pourrez l’ajouter de nouveau.')
              : (parUtilisateur === 'EXCLUDE' ? 'Annuler votre retrait ? La dépense est de nouveau comptée.' : 'Ajouter cette dépense au coût de possession ? Vous pourrez la retirer de nouveau.')}
          </p>
          <div className="flex flex-wrap gap-2 justify-end">
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirm(null)} disabled={busy}>Annuler</Button>
            <Button type="button" size="sm" onClick={() => void valider()} disabled={busy} data-tco-decision-submit>
              {busy && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
              {confirm.action === 'EXCLUDE' ? 'Retirer du TCO' : confirm.duplicateWarning ? 'Ajouter quand même' : 'Ajouter au TCO'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function TcoSection({ assetId, readOnly = false, defaultOpen = false }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const [data, setData] = useState<TcoDto | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [locked, setLocked] = useState(false);
  const commerceHidden = useNativeCommerceHidden();
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  // Lot 75D (J) : lignes des pages suivantes (chargement complémentaire), remises à zéro à chaque recalcul.
  const [extra, setExtra] = useState<Line[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  // Lot 76G : année des « Dépenses de l'année » (null : année par défaut du calcul) — conservée aux recalculs.
  const [year, setYear] = useState<number | null>(null);
  // Lot 81D : détail d'une année quand la liste est abrégée — lignes sélectionnées par le moteur (`?linesYear=`).
  const [yearLines, setYearLines] = useState<{ year: number; lines: Line[]; total: number } | null>(null);
  const [retainedOpen, setRetainedOpen] = useState(false); // L76G : sous-tiroir fermé par défaut
  const [retainedFilter, setRetainedFilter] = useState<'ALL' | 'YEAR'>('ALL');
  const [excludedOpen, setExcludedOpen] = useState(false); // L80A : sous-tiroir des non retenues fermé par défaut
  // Lot 109C : ligne à montrer depuis un point à vérifier (sous-tiroir ouvert, ligne mise en évidence et focalisée).
  const [focusLine, setFocusLine] = useState<string | null>(null);
  const [loanTermsKey, setLoanTermsKey] = useState<string | null>(null); // L112H : feuille « Conditions du prêt »
  // Lot 113X : interface « Renseigner les dates » (une seule feuille ouverte à la fois).
  const [datesOpen, setDatesOpen] = useState(false);
  const datesTrigger = useRef<HTMLButtonElement | null>(null);

  // Lot 81D : lecture du TCO par le mécanisme existant de rafraîchissement regroupé (une lecture par rafale
  // d'événements, réponses anciennes écartées, données affichées conservées pendant la relecture).
  const coordinator = useRef<CoalescedRefresh | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const hasData = useRef(false);
  /** Écriture faite par le TCO lui-même en cours : son `verebona:data-mutated` ne relance pas de lecture. */
  const ownWrite = useRef(false);
  useEffect(() => {
    const c = createCoalescedRefresh<{ tco: TcoDto; canEdit: boolean }>({
      windowMs: TCO_REFRESH_WINDOW_MS,
      load: ({ signal }) => apiClient.get<{ tco: TcoDto; canEdit: boolean }>(`/api/assets/${assetId}/tco`, { signal }),
      apply: (r) => {
        hasData.current = true;
        setData(r.tco);
        setExtra([]);
        setYearLines(null);
        setCanEdit(!!r.canEdit && !readOnly);
        setLocked(false);
        setError(false);
      },
      onError: (e) => {
        if ((e as { code?: string }).code === 'PREMIUM_REQUIRED') { hasData.current = false; setLocked(true); setData(null); return; }
        // Relecture d'arrière-plan en échec : les valeurs affichées restent ; premier chargement : erreur.
        if (!hasData.current) { setError(true); setData(null); }
      },
      onBusyChange: setLoading,
    });
    coordinator.current = c;
    return () => { c.dispose(); if (coordinator.current === c) coordinator.current = null; };
  }, [assetId, readOnly]);

  const load = useCallback(async () => { coordinator.current?.refreshNow(); }, []);

  // Recalcul à chaque ouverture (et après « Réessayer »).
  useEffect(() => { if (open) coordinator.current?.refreshNow(); }, [open, assetId, readOnly]);

  // Lot 81D : actualisation automatique après toute mutation pertinente (événements existants, regroupés).
  useEffect(() => {
    // TCO_REFRESH_EVENTS : événements existants (`./tco-refresh`), regroupés par `createCoalescedRefresh`.
    const stop = watchTcoMutations({
      target: window, assetId, isOpen: () => openRef.current, isOwnWrite: () => ownWrite.current,
      invalidate: () => coordinator.current?.invalidate(),
    });
    // Retour sur l'onglet : une analyse ou une consolidation a pu aboutir en arrière-plan.
    const onVisible = () => { if (document.visibilityState === 'visible' && openRef.current) coordinator.current?.invalidate(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [assetId]);

  const loadMore = async () => {
    if (!data) return;
    setLoadingMore(true);
    try {
      const offset = data.linesOffset + data.lines.length + extra.length;
      const r = await apiClient.get<{ tco: TcoDto }>(`/api/assets/${assetId}/tco?linesOffset=${offset}`);
      // Données recalculées entre-temps : on repart de la première page (aucun mélange de deux calculs).
      if (r.tco.linesTotal !== data.linesTotal || r.tco.summary.cumulativeCostCents !== data.summary.cumulativeCostCents) { coordinator.current?.refreshNow(); return; }
      const vus = new Set([...data.lines, ...extra].map((l) => l.id));
      setExtra((prev) => [...prev, ...r.tco.lines.filter((l) => !vus.has(l.id))]);
    } catch {
      toast.error('Chargement des lignes suivantes impossible');
    } finally {
      setLoadingMore(false);
    }
  };

  // Lot 80A : « Ajouter / Retirer du TCO » — décision persistée ; le serveur rend le TCO recalculé (totaux à jour).
  const decide: Decide = async (l, action, confirmDuplicate) => {
    ownWrite.current = true;
    try {
      const r = await apiClient.post<{ tco: TcoDto; outcome: string }>(`/api/assets/${assetId}/tco/decisions`, {
        lineId: l.id, lineKey: l.decisionKey ?? null, action, confirmDuplicate,
      });
      // Le serveur rend le TCO recalculé : toute lecture encore en vol est désormais obsolète.
      coordinator.current?.supersede();
      setData(r.tco);
      setExtra([]);
      setYearLines(null);
      toast.success(action === 'EXCLUDE' ? 'Dépense retirée du coût de possession' : 'Dépense ajoutée au coût de possession');
      return { ok: true };
    } catch (e) {
      const err = e as { code?: string; serverMessage?: string };
      if (err.code === 'DUPLICATE_CONFIRMATION_REQUIRED' && err.serverMessage) return { ok: false, duplicateWarning: err.serverMessage };
      toast.error(err.serverMessage ?? 'La décision n’a pas pu être enregistrée');
      if (err.code === 'LINE_NOT_FOUND') void load();
      return { ok: false };
    } finally {
      ownWrite.current = false;
    }
  };

  // Lot 111V : arbitrages et gestes contextuels — même route, TCO recalculé rendu par le serveur (mise à jour immédiate).
  const arbitrate: TcoArbitrate = async ({ lineId, lineKey, action, category, confirmDuplicate }) => {
    ownWrite.current = true;
    try {
      const r = await apiClient.post<{ tco: TcoDto; outcome: string }>(`/api/assets/${assetId}/tco/decisions`, {
        lineId, lineKey, action, ...(category ? { category } : {}), ...(confirmDuplicate ? { confirmDuplicate: true } : {}),
      });
      coordinator.current?.supersede();
      setData(r.tco);
      setExtra([]);
      setYearLines(null);
      toast.success(MESSAGES_CHOIX[action] ?? 'Votre choix est enregistré');
      return { ok: true };
    } catch (e) {
      const err = e as { code?: string; serverMessage?: string };
      if (err.code === 'DUPLICATE_CONFIRMATION_REQUIRED' && err.serverMessage) return { ok: false, duplicateWarning: err.serverMessage };
      toast.error(err.serverMessage ?? 'Votre choix n’a pas pu être enregistré');
      if (err.code === 'LINE_NOT_FOUND' || err.code === 'NOT_APPLICABLE') void load();
      return { ok: false };
    } finally {
      ownWrite.current = false;
    }
  };
  const decideCtx: TcoDiagnosticsDecide | undefined = canEdit && data
    ? { onDecide: arbitrate, categoryLabels: data.categoryLabels, categories: data.requalifyCategories ?? [] } : undefined;

  // Lot 109C : « Voir la dépense » — ouvre le sous-tiroir de la ligne (retenue ou non), toutes années.
  const showLine = useCallback((src: TcoDiagnosticSource) => {
    if (!src.lineId) return;
    setFocusLine(src.lineId);
    if (src.retained) { setRetainedFilter('ALL'); setExcludedOpen(false); setRetainedOpen(true); } else { setRetainedOpen(false); setExcludedOpen(true); }
  }, []);
  useEffect(() => {
    if (!focusLine || !(retainedOpen || excludedOpen)) return;
    let essais = 10;
    let h: ReturnType<typeof setTimeout> | null = null;
    const viser = () => {
      const el = document.querySelector<HTMLElement>(`[data-tco-line="${typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(focusLine) : focusLine}"]`);
      if (el) { el.scrollIntoView({ block: 'center' }); el.focus({ preventScroll: true }); return; }
      if (essais-- > 0) h = setTimeout(viser, 60);
    };
    h = setTimeout(viser, 60);
    return () => { if (h) clearTimeout(h); };
  }, [focusLine, retainedOpen, excludedOpen]);
  // Sous-tiroirs refermés : plus de ligne mise en évidence (une réouverture normale ne la vise plus).
  useEffect(() => { if (!retainedOpen && !excludedOpen) setFocusLine(null); }, [retainedOpen, excludedOpen]);

  const t = data;
  // Lot 111F : indicateurs de la fiche calculés par le moteur (valeurs, motifs « – », financement).
  const ind = t?.indicators ?? null;
  // Lot 108C : complément estimé des dépenses d'usage (moteur) — distingue le réel documenté du TCO avec estimations.
  const estime = t?.summary.estimatedUsageComplementCents ?? 0;
  const avecEstimations = estime > 0;
  const usageC = t?.usage.complement ?? null;
  const estimeAnnee = anneeSelEstime(usageC, t?.annual ?? null, year);
  const toutes = t ? [...t.lines, ...extra] : [];
  const affichees = toutes.length;
  const restantes = t ? Math.max(0, t.linesTotal - t.linesOffset - affichees) : 0;
  const retenues = toutes.filter((l) => RETENUE.has(l.status));
  const ajustements = retenues.filter((l) => l.kind && NEGATIVE.has(l.kind));
  const depenses = retenues.filter((l) => !(l.kind && NEGATIVE.has(l.kind)) && l.kind !== 'PROCEED');
  // Lot 68 : le serveur ne transmet que les lignes utiles pour CE bien (`tcoUserView`) — ni « autre bien », ni
  // justificatif déjà porté par une dépense consolidée affichée (tous restent au diagnostic BO). Garde défensive.
  const ecartees = toutes.filter((l) => !RETENUE.has(l.status) && l.status !== 'OUT_OF_SCOPE');
  // Lot 109C : diagnostics du serveur — lignes « à revoir » (cas ouverts) vs exclusions normales.
  // Lot 113X : le point « date non établie » est porté par l'alerte unique (pas de répétition dans « Points à vérifier »).
  const diag = t?.diagnostics ? tcoSheetDiagnostics(t.diagnostics) : null;
  const sansDate = t?.undatedExpenses ?? null;
  const messageSansDate = sansDate ? tcoUndatedMessage(sansDate.count, sansDate.costsCents, eur) : null;
  const aRevoir = new Set(diag?.reviewLineIds ?? []);
  const ecarteesARevoir = ecartees.filter((l) => aRevoir.has(l.id));
  // Lot 111V : choix confirmés par l'utilisateur — groupe distinct des exclusions normales.
  const decidee = (l: Line) => !!l.userDecision?.applied && ['CONFIRM_EXCLUSION', 'SAME_FACT', 'DISTINCT_FACTS', 'REQUALIFY'].includes(l.userDecision.decision);
  const ecarteesDecidees = ecartees.filter((l) => !aRevoir.has(l.id) && decidee(l));
  const ecarteesNormales = ecartees.filter((l) => !aRevoir.has(l.id) && !decidee(l));
  const motifs = t?.otherLinesByReason ?? [];
  const lignesARevoir = motifs.reduce((n, m) => n + m.review, 0);
  const lignesNonRetenues = motifs.reduce((n, m) => n + m.count, 0);
  const enCours = t?.amountRecovery ? { ...t.amountRecovery, items: t.amountRecovery.items.filter((i) => AMOUNT_RECOVERY_PENDING_STATES.has(i.state)) } : null;
  const lignesDecidees = motifs.reduce((n, m) => n + (m.decided ?? 0), 0);
  // Lot 76G : indicateurs annuels calculés par le moteur (aucun recalcul ici).
  const annual = t?.annual ?? null;
  const anneeSel = annual ? tcoKeptYear(year, annual.years, annual.defaultYear) : null;
  const anneeCourante = annual?.years.find((y) => y.year === anneeSel) ?? null;
  // Lot 81D : détail de l'année = lignes que le MOTEUR rattache à l'année (`annualYear`) — jamais un filtrage sur la
  // date affichée ; liste abrégée : lignes de l'année demandées au serveur (`?linesYear=`).
  const filtreAnnee = retainedFilter === 'YEAR' && anneeSel != null;
  const lignesAnnee: Line[] | null = !filtreAnnee || !t ? null
    : t.linesTruncated ? (yearLines?.year === anneeSel ? yearLines.lines : [])
      : toutes.filter((l) => RETENUE.has(l.status) && l.annualYear === anneeSel);
  const depensesFiltrees = lignesAnnee ? lignesAnnee.filter((l) => l.kind === 'REALIZED_COST') : depenses;
  const creditsAnnee = lignesAnnee ? lignesAnnee.filter((l) => l.kind && NEGATIVE.has(l.kind)) : [];
  const chargementAnnee = filtreAnnee && !!t?.linesTruncated && yearLines?.year !== anneeSel;
  const besoinAnnee = retainedOpen && chargementAnnee ? anneeSel : null;
  useEffect(() => {
    if (besoinAnnee == null) return;
    let actif = true;
    apiClient.get<{ tco: TcoDto }>(`/api/assets/${assetId}/tco?linesYear=${besoinAnnee}&linesLimit=1000`)
      .then((r) => { if (actif) setYearLines({ year: besoinAnnee, lines: r.tco.lines, total: r.tco.linesTotal }); })
      .catch(() => { if (actif) toast.error('Chargement des dépenses de l’année impossible'); });
    return () => { actif = false; };
  }, [besoinAnnee, assetId, data]);

  return (
    <div id="asset-section-tco" className="border border-border rounded-lg overflow-hidden" data-asset-tco>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 bg-muted/30 hover:bg-muted/50 transition-colors text-left"
        aria-expanded={open}
        data-tco-toggle
      >
        <span className="flex items-center gap-2 min-w-0">
          <span className="font-medium text-sm">Coût total de possession</span>
          {open && t && !locked && (
            <span className="text-[10px] font-medium text-primary bg-primary/10 rounded-full px-1.5 py-0.5 shrink-0 tabular-nums">{eur(avecEstimations ? t.summary.totalWithEstimatesCents : t.summary.cumulativeCostCents)}</span>
          )}
          {locked && <Lock className="w-3.5 h-3.5 text-muted-foreground shrink-0" aria-label="Fonction Premium" />}
        </span>
        {open ? <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />}
      </button>

      {open && (
        <div className="p-4 space-y-5" data-tco-body>
          {loading && !t && !locked ? (
            <div className="flex justify-center py-6"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
          ) : locked ? (
            // Lot 113B (#690) : textes du ticket + CTA « Découvrir les offres Premium » (→ Offres ; app : message stores).
            <TcoLockedNotice commerceHidden={commerceHidden} />
          ) : error || !t ? (
            <div className="text-sm text-muted-foreground flex flex-wrap items-center gap-2" data-tco-error>
              <AlertCircle className="w-4 h-4 text-[color:var(--danger)]" />
              Le coût total de possession n’a pas pu être calculé.
              <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => void load()}>Réessayer</button>
            </div>
          ) : (
            <>
              {/* ── Lot 111F : synthèse compacte — Coût total, Coût annuel moyen de possession, Coût net estimé, Dépenses de l'année ──
                  Valeurs et motifs fournis par le moteur (`t.indicators`) ; « – » + icône d'information quand non calculable. */}
              <section className="rounded-lg border border-primary/20 bg-primary/5 p-4 space-y-3" data-tco-summary data-tco-annual>
                <p className="text-xs text-muted-foreground" data-tco-start-status={t.period.startStatus ?? (t.period.start ? 'RESOLVED' : 'MISSING')}>
                  {t.annual?.average.incoherence ? 'Date d’acquisition incohérente — '
                    : t.period.startStatus === 'UNDETERMINED' ? 'Date d’achat du bien incertaine — '
                      : t.period.start ? `${depuis(t.period.start, t.period.startKind)} ` : 'Date d’acquisition non renseignée — '}
                  {t.period.endSource === 'TODAY' ? (t.period.start && !t.annual?.average.incoherence ? 'jusqu’à aujourd’hui' : 'à aujourd’hui') : `jusqu’à la cession le ${dateNum(t.period.end)}`}
                </p>
                {ind && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
                    <Indicateur titre="Coût total" valeur={eur(ind.total.cents)} info={ind.total.info} data-tco-indicator="total"
                      sous={ind.total.estimatedShareCents > 0 ? `Dont ${eur(ind.total.estimatedShareCents)} estimés (dépenses d’usage)` : t.summary.acquisitionStatus === 'MISSING' ? 'Prix d’achat non renseigné' : null} />
                    <Indicateur titre="Coût annuel moyen de possession" valeur={ind.annualAverage.cents != null ? `${eur(ind.annualAverage.cents)} / an` : null}
                      info={ind.annualAverage.unavailableReason ?? ind.annualAverage.info} data-tco-indicator="average" data-tco-average-status={annual?.average.status ?? ''}
                      sous={ind.annualAverage.cents == null ? null : ind.annualAverage.estimatedShareCents > 0 ? `Hors prix d’achat · dont ${eur(ind.annualAverage.estimatedShareCents)} / an estimés` : 'Hors prix d’achat du bien'}
                      note={annual?.average.extrapolationLabel ? `${annual.average.extrapolationLabel}.` : null} />
                    <Indicateur titre={ind.net.kind === 'FINAL' ? 'Coût net final' : 'Coût net estimé'} valeur={ind.net.cents != null ? eur(ind.net.cents) : null}
                      info={ind.net.unavailableReason ?? ind.net.info} data-tco-indicator="net"
                      sous={ind.net.valuation ? `Estimation du ${dateNum(ind.net.valuation.date)}${ind.net.valuation.mode ? ` · ${VALUATION_MODE_LABELS[ind.net.valuation.mode] ?? ind.net.valuation.mode}` : ''} · ${ind.net.valuation.ageLabel}`
                        : ind.net.kind === 'FINAL' && ind.net.realizedPriceCents != null ? `Prix de vente réalisé ${eur(ind.net.realizedPriceCents)}` : null} />
                    {anneeCourante && annual && (
                      <div className="rounded-lg border border-border bg-card p-3 min-w-0" data-tco-indicator="year">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-xs text-muted-foreground">Dépenses de l’année</p>
                          <Select value={String(anneeSel)} onValueChange={(v) => setYear(Number(v))}>
                            <SelectTrigger className="h-8 w-[6.5rem] shrink-0" aria-label="Année des dépenses" data-tco-year-select><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {[...annual.years].reverse().map((y) => <SelectItem key={y.year} value={String(y.year)}>{y.year}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </div>
                        <p className="text-lg font-semibold text-[color:var(--text-primary)] tabular-nums" data-tco-year-total={anneeCourante.year}>{eur(anneeCourante.costsCents)}</p>
                        <p className="text-xs text-muted-foreground mt-1">
                          {anneeCourante.count === 0
                            ? `Aucune dépense datée du ${dateFr(anneeCourante.periodStart)} au ${dateFr(anneeCourante.periodEnd)}.`
                            : `${anneeCourante.count} dépense(s) du ${dateFr(anneeCourante.periodStart)} au ${dateFr(anneeCourante.periodEnd)} (montant brut).`}
                        </p>
                        {/* Lot 108C : complément estimé de l'année (périodes écoulées), à part des dépenses réellement constatées. */}
                        {estimeAnnee > 0 && (
                          <p className="text-xs text-muted-foreground mt-0.5" data-tco-year-estimated={estimeAnnee}>
                            Complément estimé des dépenses d’usage : + {eur(estimeAnnee)} · avec estimations {eur(anneeCourante.costsCents + estimeAnnee)}.
                          </p>
                        )}
                        {/* Lot 81D : brut et net de l'année, tels que calculés par le moteur. */}
                        {anneeCourante.creditsCents !== 0 && (
                          <p className="text-xs text-muted-foreground mt-0.5" data-tco-year-net={anneeCourante.netCents}>
                            Avoirs, remboursements et indemnités : − {eur(anneeCourante.creditsCents)} · net de l’année {eur(anneeCourante.netCents)}.
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                )}
                {/* ── Lot 113X (#722) : information UNIQUE sur les dépenses sans date fiable, près de « Dépenses de l'année » ──
                    Toutes années confondues (le filtre d'année ne la masque jamais) ; aucun état positif quand tout est daté. */}
                {sansDate && messageSansDate && (
                  <div className="rounded-lg border border-border bg-card p-3 space-y-2" role="group" aria-label="Dépenses sans date fiable" data-tco-undated={sansDate.count}>
                    <p className="text-xs text-[color:var(--text-primary)] flex items-start gap-1.5" data-tco-undated-message>
                      <Info className="w-3.5 h-3.5 mt-px shrink-0 text-muted-foreground" aria-hidden /> <span>{messageSansDate}</span>
                    </p>
                    {canEdit && (
                      <Button
                        ref={datesTrigger} type="button" variant="outline" size="sm" className="min-h-[44px] md:min-h-0 w-full sm:w-auto"
                        onClick={() => setDatesOpen(true)} aria-haspopup="dialog" aria-expanded={datesOpen} aria-controls="tco-undated-drawer" data-tco-undated-open
                      >
                        <CalendarDays className="w-3.5 h-3.5 mr-1.5" aria-hidden />{tcoUndatedButtonLabel(sansDate.count)}
                      </Button>
                    )}
                  </div>
                )}
                <div className="divide-y divide-border">
                  {avecEstimations && <Ligne label="Coût réel documenté (justificatifs et fiche)" value={eur(t.summary.cumulativeCostCents)} />}
                  <Ligne label="Coût d’acquisition" value={t.summary.acquisitionStatus === 'MISSING' ? 'non renseigné' : t.summary.acquisitionStatus === 'NOT_APPLICABLE' ? 'sans objet (aucun achat)' : eur(t.summary.acquisitionCents)} muted={t.summary.acquisitionStatus !== 'DOCUMENTED'} />
                  <Ligne label="Dépenses complémentaires" value={eur(t.summary.additionalCostsCents)} />
                  {t.reductionsCents + t.refundsCents + t.indemnitiesCents > 0 && (
                    <Ligne label="Avoirs, remboursements et indemnités" value={`− ${eur(t.reductionsCents + t.refundsCents + t.indemnitiesCents)}`} />
                  )}
                </div>
                {/* Lot 113X (#722) : plus aucune phrase « aucune anomalie » (état positif supprimé) ; seule une couverture
                    réellement incomplète est signalée. L'information « sans date » n'est plus répétée sous la ventilation. */}
                {t.status !== 'COMPLETE' && (
                  <p className="text-xs text-[color:var(--attention-on-soft)]" data-tco-completeness={t.status}>
                    {t.status === 'PARTIAL' ? 'Résultat partiel : seule une partie des éléments a pu être lue.'
                      : (diag?.open.families ?? 0) > 0 ? 'Couverture incomplète : voir les points à vérifier ci-dessous.'
                        : (diag?.inProgress ?? 0) > 0 ? 'Couverture incomplète : lecture automatique en cours (voir ci-dessous).'
                          : 'Couverture incomplète : certaines informations manquent.'}
                  </p>
                )}
                {annual && annual.notRealized.count > 0 && (
                  <p className="text-xs text-muted-foreground" data-tco-annual-not-realized>
                    {annual.notRealized.count} dépense(s) prévue(s) ou datée(s) après aujourd’hui{annual.notRealized.costsCents > 0 ? ` (${eur(annual.notRealized.costsCents)})` : ''} : non encore réalisée(s), comptée(s) dans aucun indicateur (voir « Dépenses non retenues »).
                  </p>
                )}
              </section>

              {/* ── Lot 111F : financement — prêts du bien consolidés (Opérations FINANCING), seulement si des données utiles existent ── */}
              {ind && ind.financing.loans.length > 0 && (
                <section className="space-y-2" data-tco-financing>
                  <div className="flex items-center gap-1.5">
                    <h3 className="vb-app-subsection m-0">Financement</h3>
                    <TcoInfoTip label="Financement" text={ind.financing.info} />
                  </div>
                  <div className="divide-y divide-border">
                    <Ligne label="Coût du crédit à date (intérêts, assurance, frais)" value={eur(ind.financing.costToDateCents)} strong />
                    <Ligne label={`Coût total prévisionnel du crédit${ind.financing.estimated ? ' (échéancier partiel)' : ''}`} value={ind.financing.contractualTotalCents != null ? eur(ind.financing.contractualTotalCents) : '–'} muted />
                    {ind.financing.loans.length > 1 && ind.financing.loans.map((p) => (
                      <Ligne key={p.key} label={[p.label, p.lender, p.reference].filter(Boolean).join(' · ')} value={eur(p.costToDateCents)} muted />
                    ))}
                  </div>
                  {ind.financing.basisLabel && <p className="text-xs text-muted-foreground" data-tco-financing-basis>{ind.financing.basisLabel}.</p>}
                  {/* Lot 112D : capital restant dû — valeur seulement s'il est établi (lu, saisi ou calculé exactement), sinon « non établi » et ce qui manque.
                      Information, jamais un coût : n'entre dans aucun total. */}
                  {ind.financing.outstanding && <TcoOutstanding financing={ind.financing} canEdit={canEdit} onOpenTerms={setLoanTermsKey} />}
                </section>
              )}

              {/* ── Détail des coûts ── */}
              <Bloc title="Détail des coûts" data-tco-breakdown>
                <div className="divide-y divide-border">
                  {t.breakdown.length === 0 && <p className="text-sm text-muted-foreground py-1.5">Aucun coût documenté.</p>}
                  {t.breakdown.map((b) => <Ligne key={b.category} label={`${b.label} (${b.count})`} value={eur(b.costsCents)} />)}
                  {t.reductionsCents > 0 && <Ligne label="Avoirs et réductions" value={`− ${eur(t.reductionsCents)}`} />}
                  {t.refundsCents > 0 && <Ligne label="Remboursements" value={`− ${eur(t.refundsCents)}`} />}
                  {t.indemnitiesCents > 0 && <Ligne label="Indemnités reçues" value={`− ${eur(t.indemnitiesCents)}`} />}
                  <Ligne label={avecEstimations ? 'Coût réel documenté' : 'Coût cumulé'} value={eur(t.summary.cumulativeCostCents)} strong />
                  {avecEstimations && <Ligne label="Complément estimé — dépenses d’usage (voir « Dépenses d’usage »)" value={`+ ${eur(estime)}`} muted />}
                  {avecEstimations && <Ligne label="TCO cumulé, estimations incluses" value={eur(t.summary.totalWithEstimatesCents)} strong />}
                </div>
              </Bloc>

              {/* Lot 75D (J) : liste abrégée — toujours signalée, même si elle ne contient que des dépenses retenues. */}
              {t.linesTruncated && (
                <div className="rounded-lg border border-border p-3 text-xs space-y-2" data-tco-lines-truncated>
                  <p className="text-muted-foreground" data-tco-lines-count>
                    {affichees} ligne(s) présentée(s) sur {t.linesTotal} ({t.retainedLinesTotal} retenue(s), {t.otherLinesTotal} non retenue(s)). Les totaux portent sur toutes les lignes.
                  </p>
                  {restantes > 0 && (
                    <Button variant="outline" size="sm" className="w-full sm:w-auto" onClick={() => void loadMore()} disabled={loadingMore} data-tco-load-more>
                      {loadingMore && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}Afficher les lignes suivantes ({restantes})
                    </Button>
                  )}
                </div>
              )}

              {/* Lot 76G (complément PO du 21/10) : liste fermée par défaut — le déclencheur ouvre le sous-tiroir. */}
              <section data-tco-retained>
                <button
                  type="button"
                  onClick={() => setRetainedOpen(true)}
                  aria-expanded={retainedOpen}
                  aria-haspopup="dialog"
                  className="w-full min-h-[44px] md:min-h-[36px] flex items-center justify-between gap-3 rounded-lg border border-border px-4 py-2.5 text-left hover:bg-muted/50 transition-colors"
                  data-tco-retained-trigger
                >
                  <span className="vb-app-subsection m-0">{`Dépenses retenues (${depenses.length}${t.linesTruncated ? ' · liste abrégée' : ''})`}</span>
                  <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" aria-hidden />
                </button>
              </section>

              {ajustements.length > 0 && (
                <Bloc title="Avoirs, remboursements et indemnités" data-tco-adjustments>
                  <div className="divide-y divide-border">{ajustements.map((l) => <LigneDepense key={l.id} l={l} t={t} canEdit={canEdit} onDecide={decide} />)}</div>
                </Bloc>
              )}

              {/* ── Valeur et cession ── */}
              {(t.disposed || t.disposal.desiredPriceCents != null || t.summary.currentValue) && (
                <Bloc title={t.disposed ? 'Cession' : 'Valeur actuelle et cession'} data-tco-disposal>
                  <div className="divide-y divide-border">
                    {!t.disposed && <Ligne label="Dernière valeur estimée (après l’achat)" value={t.summary.currentValue ? `${eur(t.summary.currentValue.cents)} · ${dateFr(t.summary.currentValue.date)}` : '–'} muted />}
                    {t.disposal.desiredPriceCents != null && <Ligne label="Prix souhaité" value={eur(t.disposal.desiredPriceCents)} muted />}
                    {t.disposed && <Ligne label="Prix réalisé" value={eur(t.disposal.realizedPriceCents)} />}
                    {t.disposal.feesCents > 0 && <Ligne label="Frais de cession (inclus dans les coûts)" value={eur(t.disposal.feesCents)} muted />}
                    {t.disposal.resultKind === 'FINAL' && <Ligne label="Résultat définitif (coût net final)" value={eur(t.summary.netFinalCents)} strong />}
                    {t.disposal.resultKind === 'PROVISIONAL' && <Ligne label="Simulation provisoire au prix souhaité" value={eur(t.disposal.provisionalNetCents)} />}
                  </div>
                  {t.disposal.resultKind === 'PROVISIONAL' && <p className="text-xs text-muted-foreground">Simulation : le prix souhaité n’est pas un prix de vente réalisé.</p>}
                </Bloc>
              )}

              {/* ── Lot 108C : dépenses d'usage (forfaits = estimation complémentaire du réel) ── */}
              <TcoUsageSection
                t={t} assetId={assetId} canEdit={canEdit} reload={load}
                applyTco={(tco) => { coordinator.current?.supersede(); setData(tco); setExtra([]); setYearLines(null); }}
                setOwnWrite={(v) => { ownWrite.current = v; }}
              />

              {/* ── Lot 80A : non retenues, non attribuées — déclencheur fermé par défaut, liste dans un sous-tiroir ── */}
              {ecartees.length > 0 && (
                <section data-tco-excluded>
                  <button
                    type="button"
                    onClick={() => setExcludedOpen(true)}
                    aria-expanded={excludedOpen}
                    aria-haspopup="dialog"
                    aria-label={`Dépenses non retenues : ${lignesNonRetenues || ecartees.length} ligne(s) examinée(s) et non comptée(s), avec leur motif${lignesARevoir ? `, dont ${lignesARevoir} à revoir` : ''}`}
                    className="w-full min-h-[44px] md:min-h-[36px] flex items-center justify-between gap-3 rounded-lg border border-border px-4 py-2.5 text-left hover:bg-muted/50 transition-colors"
                    data-tco-excluded-trigger
                  >
                    <span className="vb-app-subsection m-0">{`Dépenses non retenues (${ecartees.length}${t.linesTruncated ? ' · liste abrégée' : ''})`}</span>
                    <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" aria-hidden />
                  </button>
                </section>
              )}

              {/* ── Lot 109C : points à vérifier — seulement s'il existe un cas OUVERT (anomalie, information manquante) ── */}
              {diag && diag.open.families > 0 && (
                <Bloc title={`Points à vérifier (${diag.open.families})`} data-tco-warnings>
                  <TcoOpenDiagnostics diagnostics={diag} assetId={assetId} onShowLine={showLine} decide={decideCtx} />
                </Bloc>
              )}

              {/* ── Lot 108B : lecture automatique du montant en cours (ton neutre, rien à faire) ; échecs : points à vérifier ── */}
              <TcoAmountRecoveryNotice recovery={enCours} />

              {/* ── Lot 109C : informations neutres (exclusions normales, déduplication prouvée, vos choix) ── */}
              {diag && <TcoInformationDiagnostics diagnostics={diag} onShowLine={showLine} />}
              {diag && <TcoDecidedDiagnostics diagnostics={diag} onShowLine={showLine} decide={decideCtx} />}
              {/* Lot 108A (§D) : information neutre (texte exact de la décision PO) — jamais une alerte. */}
              <p className="text-xs text-muted-foreground" role="note" data-tco-calculation-info>{TCO_CALCULATION_INFO}</p>
            </>
          )}
        </div>
      )}

      {/* ── Lot 76G : sous-tiroir « Dépenses retenues » (à droite ; pleine largeur sur mobile) ── */}
      {t && (
        <Sheet open={retainedOpen} onOpenChange={setRetainedOpen}>
          <SheetContent side="right" id="tco-retained-drawer" className="w-full sm:max-w-lg flex flex-col gap-0 p-0" data-tco-retained-drawer>
            <SheetHeader className="px-5 pt-5 pb-3 border-b border-border">
              <button
                type="button"
                onClick={() => setRetainedOpen(false)}
                className="inline-flex min-h-[44px] md:min-h-[36px] items-center gap-1.5 self-start text-sm text-muted-foreground hover:text-[color:var(--text-primary)]"
                data-tco-retained-back
              >
                <ArrowLeft className="w-4 h-4" aria-hidden /> Coût total de possession
              </button>
              <SheetTitle>{`Dépenses retenues (${depensesFiltrees.length}${t.linesTruncated ? ' · liste abrégée' : ''})`}</SheetTitle>
              <SheetDescription>
                {retainedFilter === 'YEAR' && anneeCourante
                  ? `Dépenses de ${anneeCourante.year} : ${eur(anneeCourante.costsCents)} bruts (${anneeCourante.count} dépense(s))${anneeCourante.creditsCents !== 0 ? `, net ${eur(anneeCourante.netCents)} après avoirs, remboursements et indemnités` : ''}.`
                  : `Toutes les dépenses retenues dans le coût cumulé (${eur(t.summary.cumulativeCostCents)}).`}
              </SheetDescription>
              {anneeCourante && (
                <div className="flex flex-wrap gap-2 pt-1" role="group" aria-label="Période des dépenses" data-tco-retained-filter>
                  {([['ALL', 'Toutes les années'], ['YEAR', `Année ${anneeCourante.year}`]] as const).map(([v, label]) => (
                    <Button key={v} type="button" size="sm" variant={retainedFilter === v ? 'default' : 'outline'} aria-pressed={retainedFilter === v}
                      onClick={() => setRetainedFilter(v)} data-tco-retained-filter-option={v}>
                      {label}
                    </Button>
                  ))}
                </div>
              )}
            </SheetHeader>
            <div className="flex-1 overflow-y-auto px-5 py-3">
              <div className="divide-y divide-border">
                {chargementAnnee && <div className="flex justify-center py-4"><Loader2 className="w-4 h-4 animate-spin text-muted-foreground" /></div>}
                {!chargementAnnee && depensesFiltrees.length === 0 && (
                  <p className="text-sm text-muted-foreground py-1.5">{retainedFilter === 'YEAR' ? 'Aucune dépense retenue datée de cette année.' : 'Aucune dépense retenue.'}</p>
                )}
                {depensesFiltrees.map((l) => <LigneDepense key={l.id} l={l} t={t} canEdit={canEdit} onDecide={decide} arbitrate={arbitrate} review={aRevoir.has(l.id)} focused={focusLine === l.id} />)}
              </div>
              {/* Lot 81D : avoirs, remboursements et indemnités de l'année (net de l'indicateur, même sélection). */}
              {creditsAnnee.length > 0 && (
                <div className="pt-3" data-tco-retained-year-credits>
                  <p className="vb-app-subsection m-0">Avoirs, remboursements et indemnités de l’année</p>
                  <div className="divide-y divide-border">{creditsAnnee.map((l) => <LigneDepense key={l.id} l={l} t={t} canEdit={canEdit} onDecide={decide} />)}</div>
                </div>
              )}
              {retainedFilter === 'YEAR' && annual && annual.undated.count > 0 && (
                <p className="text-xs text-muted-foreground pt-2">Les dépenses sans date ne sont rattachées à aucune année : choisissez « Toutes les années » pour les voir.</p>
              )}
              {!filtreAnnee && t.linesTruncated && restantes > 0 && (
                <div className="pt-3 space-y-2">
                  <p className="text-xs text-muted-foreground">Liste abrégée : {affichees} ligne(s) présentée(s) sur {t.linesTotal}. Les totaux portent sur toutes les lignes.</p>
                  <Button variant="outline" size="sm" className="w-full sm:w-auto" onClick={() => void loadMore()} disabled={loadingMore}>
                    {loadingMore && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}Afficher les lignes suivantes ({restantes})
                  </Button>
                </div>
              )}
              {filtreAnnee && yearLines && yearLines.year === anneeSel && yearLines.lines.length < yearLines.total && (
                <p className="text-xs text-muted-foreground pt-2">Liste abrégée : {yearLines.lines.length} ligne(s) présentée(s) sur {yearLines.total}. Les totaux de l’année portent sur toutes les lignes.</p>
              )}
            </div>
          </SheetContent>
        </Sheet>
      )}

      {/* ── Lot 80A : sous-tiroir « Dépenses non retenues » (même mécanisme ; pleine largeur sur mobile) ── */}
      {t && (
        <Sheet open={excludedOpen} onOpenChange={setExcludedOpen}>
          <SheetContent side="right" id="tco-excluded-drawer" className="w-full sm:max-w-lg flex flex-col gap-0 p-0" data-tco-excluded-drawer>
            <SheetHeader className="px-5 pt-5 pb-3 border-b border-border">
              <button
                type="button"
                onClick={() => setExcludedOpen(false)}
                className="inline-flex min-h-[44px] md:min-h-[36px] items-center gap-1.5 self-start text-sm text-muted-foreground hover:text-[color:var(--text-primary)]"
                data-tco-excluded-back
              >
                <ArrowLeft className="w-4 h-4" aria-hidden /> Coût total de possession
              </button>
              <SheetTitle>{`Dépenses non retenues ou non attribuées (${ecartees.length}${t.linesTruncated ? ' · liste abrégée' : ''})`}</SheetTitle>
              <SheetDescription>
                Dépenses examinées mais non comptées dans le coût cumulé, avec leur motif : ce sont des lignes, pas des erreurs.{canEdit ? ' « Ajouter au TCO » les compte : votre choix prime sur le traitement automatique et reste réversible.' : ''}
              </SheetDescription>
            </SheetHeader>
            <div className="flex-1 overflow-y-auto px-5 py-3">
              {/* Lot 109C : synthèse par motif sur TOUTES les lignes (pas seulement la page) — exclusions normales vs à revoir. */}
              {motifs.length > 0 && (
                <div className="pb-3 border-b border-border space-y-1" data-tco-excluded-summary>
                  <p className="text-xs text-muted-foreground" data-tco-excluded-summary-counts>
                    {lignesNonRetenues} ligne(s) examinée(s) : {lignesNonRetenues - lignesARevoir - lignesDecidees} exclusion(s) normale(s){lignesARevoir ? `, ${lignesARevoir} à revoir` : ''}{lignesDecidees ? `, ${lignesDecidees} choix confirmé(s)` : ''}.
                    {diag && diag.open.decisions > 0 ? ` ${diag.open.decisions} choix à faire.` : ''}
                  </p>
                  <ul className="text-xs text-muted-foreground space-y-0.5">
                    {motifs.map((m) => (
                      <li key={`${m.status}|${m.reason ?? ''}`} className="flex items-start justify-between gap-3" data-tco-excluded-reason={m.reason ?? m.status}>
                        <span className="min-w-0 break-words">{m.label}{m.review ? ` (dont ${m.review} à revoir)` : ''}{m.decided ? ` (dont ${m.decided} confirmée(s) par vous)` : ''}</span>
                        <span className="shrink-0 tabular-nums">{m.count}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {ecartees.length === 0 && <p className="text-sm text-muted-foreground py-1.5">Aucune dépense non retenue.</p>}
              {ecarteesARevoir.length > 0 && (
                <div className="pt-3" data-tco-excluded-review>
                  <p className="vb-app-subsection m-0">{`À revoir (${ecarteesARevoir.length})`}</p>
                  <div className="divide-y divide-border">
                    {ecarteesARevoir.map((l) => <LigneDepense key={l.id} l={l} t={t} canEdit={canEdit} onDecide={decide} arbitrate={arbitrate} review focused={focusLine === l.id} />)}
                  </div>
                </div>
              )}
              {ecarteesDecidees.length > 0 && (
                <div className="pt-3" data-tco-excluded-decided>
                  <p className="vb-app-subsection m-0">{`Vos choix confirmés (${ecarteesDecidees.length})`}</p>
                  <div className="divide-y divide-border">
                    {ecarteesDecidees.map((l) => <LigneDepense key={l.id} l={l} t={t} canEdit={canEdit} onDecide={decide} arbitrate={arbitrate} focused={focusLine === l.id} />)}
                  </div>
                </div>
              )}
              {ecarteesNormales.length > 0 && (
                <div className="pt-3" data-tco-excluded-normal>
                  {(ecarteesARevoir.length > 0 || ecarteesDecidees.length > 0) && <p className="vb-app-subsection m-0">{`Exclusions normales (${ecarteesNormales.length})`}</p>}
                  <div className="divide-y divide-border">
                    {ecarteesNormales.map((l) => <LigneDepense key={l.id} l={l} t={t} canEdit={canEdit} onDecide={decide} arbitrate={arbitrate} focused={focusLine === l.id} />)}
                  </div>
                </div>
              )}
              {t.linesTruncated && restantes > 0 && (
                <div className="pt-3 space-y-2">
                  <p className="text-xs text-muted-foreground">Liste abrégée : {affichees} ligne(s) présentée(s) sur {t.linesTotal}. Les totaux portent sur toutes les lignes.</p>
                  <Button variant="outline" size="sm" className="w-full sm:w-auto" onClick={() => void loadMore()} disabled={loadingMore}>
                    {loadingMore && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}Afficher les lignes suivantes ({restantes})
                  </Button>
                </div>
              )}
            </div>
          </SheetContent>
        </Sheet>
      )}
      {/* Lot 113X (#722) : « Renseigner les dates » — TCO recalculé rendu par le serveur (mise à jour immédiate). */}
      {t && canEdit && (
        <TcoUndatedDatesSheet
          open={datesOpen} onOpenChange={setDatesOpen} assetId={assetId} tco={t} canEdit={canEdit} arbitrate={arbitrate}
          trigger={datesTrigger.current}
          onOwnWrite={(w) => { ownWrite.current = w; }}
          onSaved={(tco) => { coordinator.current?.supersede(); setData(tco); setExtra([]); setYearLines(null); }}
        />
      )}
      {/* Lot 112H : conditions du prêt — route PUT 112D, TCO recalculé rendu par le serveur (mise à jour immédiate). */}
      {t && ind && loanTermsKey && (
        <TcoLoanTermsSheet
          open={!!ind.financing.loans.find((p) => p.key === loanTermsKey)}
          onOpenChange={(v) => { if (!v) setLoanTermsKey(null); }}
          assetId={assetId}
          loan={ind.financing.loans.find((p) => p.key === loanTermsKey) ?? null}
          canEdit={canEdit}
          onOwnWrite={(w) => { ownWrite.current = w; }}
          onSaved={(tco) => { coordinator.current?.supersede(); setData(tco); setExtra([]); setYearLines(null); }}
        />
      )}
    </div>
  );
}
