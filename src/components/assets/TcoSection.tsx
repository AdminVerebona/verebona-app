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
 *   · Lot 76G : trois indicateurs distincts — TCO total (cumulatif), TCO
 *     moyen annuel (coût annualisé, achat initial inclus) et dépenses de
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
 *
 * Aucun bouton « Modifier » du total : les corrections se font sur les
 * sources (fiche, document) ou par « Ajouter / Retirer du TCO » ligne par
 * ligne. Standard : présentation verrouillée, AUCUN montant reçu (403 serveur
 * avant toute lecture). Lecture seule (`canEdit` faux) : aucun geste.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { AlertCircle, ArrowLeft, ChevronDown, ChevronRight, ChevronUp, Loader2, Lock, MinusCircle, PlusCircle } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { toast } from 'sonner';
// Types seulement : les libellés viennent de la réponse (aucun module serveur ni registre dans le paquet client).
import { TCO_CALCULATION_INFO, type TcoDto } from '@/services/business-operations/tco/dto';
import { TcoJustificatif } from './tco-justificatif';
import { TcoAmountRecoveryNotice } from './tco-amount-recovery';
import { TcoUsageSection } from './TcoUsageSection';
import { createCoalescedRefresh, type CoalescedRefresh } from '@/lib/home/coalesced-refresh';
import { tcoKeptYear, TCO_REFRESH_WINDOW_MS, watchTcoMutations } from './tco-refresh';

interface Props {
  assetId: number;
  readOnly?: boolean;
  defaultOpen?: boolean;
}

type Line = TcoDto['lines'][number];
type Annual = TcoDto['annual'];

/** Lot 76G : années de possession, au dixième (« 2,8 ans »). */
function ansFr(n: number): string {
  const v = n.toLocaleString('fr-FR', { maximumFractionDigits: 1 });
  return `${v} an${n >= 2 ? 's' : ''}`;
}

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

/** Lot 76G / 81D / 107C : explication du TCO moyen annuel (calculé ou motif de non-calcul) — aucun seuil de durée. */
function moyenneExplication(a: Annual['average'], endSource: string): string {
  switch (a.status) {
    case 'COMPUTED': {
      const fin = endSource === 'TODAY' ? 'jusqu’à aujourd’hui' : `jusqu’à la cession le ${dateNum(a.end)}`;
      const duree = a.days === 1 ? '1 jour' : (a.days ?? 0) < 365 ? `${a.days} jours` : ansFr(a.years ?? 0);
      return `${depuis(a.start, a.startKind)} : ${duree} (${fin}).`;
    }
    case 'ACQUISITION_DATE_MISSING': return 'Date d’achat inconnue : moyenne non calculée. Renseignez la date d’achat de la fiche.';
    // Lot 107C : contradiction bloquante identifiable — jamais masquée derrière « Données manquantes ».
    case 'ACQUISITION_DATE_UNDETERMINED': return 'Date d’achat du bien incertaine (plusieurs dates possibles se contredisent) : moyenne non calculée. Confirmez la date d’achat sur la fiche du bien.';
    case 'ACQUISITION_DATE_INCOHERENT':
      return a.incoherence === 'INVALID_DATE' ? 'Date d’achat impossible (jour inexistant) : moyenne non calculée. Corrigez la date d’achat de la fiche.'
        : a.incoherence === 'AFTER_DISPOSAL' ? 'Date d’achat postérieure à la cession : moyenne non calculée. Vérifiez les dates de la fiche.'
          : 'Date d’achat postérieure à aujourd’hui : moyenne non calculée. Vérifiez la date d’achat de la fiche.';
    default: return '';
  }
}

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
const RETENUE = new Set(['RETAINED_DIRECT', 'RETAINED_CONSOLIDATED']);


function Bloc({ title, children, ...rest }: { title: string; children: React.ReactNode } & Record<`data-${string}`, boolean | string>) {
  return (
    <section className="space-y-2" {...rest}>
      <h3 className="vb-app-subsection m-0">{title}</h3>
      {children}
    </section>
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

/** Lot 80A : geste « Ajouter / Retirer du TCO » demandé sur une ligne (confirmé dans la ligne). */
type Decide = (l: Line, action: 'INCLUDE' | 'EXCLUDE', confirmDuplicate: boolean) => Promise<{ ok: true } | { ok: false; duplicateWarning?: string }>;

function LigneDepense({ l, t, canEdit = false, onDecide }: { l: Line; t: TcoDto; canEdit?: boolean; onDecide?: Decide }) {
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
    <div className="py-2 text-sm" data-tco-line={l.id} data-tco-line-status={l.status}>
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
      {!retenue && (
        <p className="text-xs text-muted-foreground mt-0.5" data-tco-line-reason>
          {l.reason === 'USER_EXCLUDED' ? t.lineReasonLabels[l.reason] : <>{t.lineStatusLabels[l.status]}{l.reason ? ` — ${t.lineReasonLabels[l.reason]}` : ''}</>}
        </p>
      )}
      {parUtilisateur === 'INCLUDE' && retenue && (
        <p className="text-xs text-primary mt-0.5" data-tco-line-user-decision="INCLUDE">Ajoutée au coût de possession par vous.</p>
      )}
      {l.uncertain
        ? <p className="text-xs text-[color:var(--attention-on-soft)] mt-0.5" data-tco-line-uncertain>À vérifier : {l.note}</p>
        : l.note && l.reason !== 'USER_EXCLUDED' && !(parUtilisateur === 'INCLUDE' && retenue && l.note === 'Ajoutée au coût de possession par vous.') && (
          <p className={`text-xs mt-0.5 ${parUtilisateur === 'INCLUDE' ? 'text-[color:var(--attention-on-soft)]' : 'text-muted-foreground'}`} data-tco-line-note>
            {parUtilisateur === 'INCLUDE' ? l.note.replace(/^Ajoutée au coût de possession par vous\. /, '') : l.note}
          </p>
        )}
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
      {canEdit && !retenue && actions && !actions.addable && actions.addBlockedReason && l.status !== 'OUT_OF_SCOPE' && (
        <p className="text-xs text-muted-foreground mt-0.5" data-tco-add-blocked>Ajout impossible : {actions.addBlockedReason}</p>
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

  const t = data;
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
            <div className="rounded-lg border border-border p-4 text-sm space-y-2" data-tco-locked>
              <div className="flex items-center gap-2 font-semibold"><Lock className="w-4 h-4" /> Fonction Premium</div>
              <p className="text-muted-foreground">Le coût total de possession (coûts documentés, valeur, résultat de cession) est disponible avec Premium et Premium Duo. Vos données sont conservées.</p>
            </div>
          ) : error || !t ? (
            <div className="text-sm text-muted-foreground flex flex-wrap items-center gap-2" data-tco-error>
              <AlertCircle className="w-4 h-4 text-[color:var(--danger)]" />
              Le coût total de possession n’a pas pu être calculé.
              <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => void load()}>Réessayer</button>
            </div>
          ) : (
            <>
              {/* ── Synthèse ── */}
              <div className="rounded-lg border border-primary/20 bg-primary/5 p-4" data-tco-summary>
                {/* Lot 108C : un total qui inclut des estimations n'est jamais intitulé « Coût cumulé documenté ». */}
                <p className="text-[13px] font-semibold text-primary mb-1" data-tco-summary-title>{avecEstimations ? 'Coût total de possession (estimations incluses)' : 'Coût cumulé documenté'}</p>
                <p className="text-2xl font-bold text-[color:var(--text-primary)] tabular-nums" data-tco-summary-total>{eur(avecEstimations ? t.summary.totalWithEstimatesCents : t.summary.cumulativeCostCents)}</p>
                <p className="text-xs text-muted-foreground mt-1" data-tco-start-status={t.period.startStatus ?? (t.period.start ? 'RESOLVED' : 'MISSING')}>
                  {t.annual?.average.incoherence ? 'Date d’acquisition incohérente — '
                    : t.period.startStatus === 'UNDETERMINED' ? 'Date d’achat du bien incertaine — '
                      : t.period.start ? `${depuis(t.period.start, t.period.startKind)} ` : 'Date d’acquisition non renseignée — '}
                  {t.period.endSource === 'TODAY' ? (t.period.start && !t.annual?.average.incoherence ? 'jusqu’à aujourd’hui' : 'à aujourd’hui') : `jusqu’à la cession le ${dateNum(t.period.end)}`}
                </p>
                <div className="mt-3 divide-y divide-border">
                  {avecEstimations && <Ligne label="Coût réel documenté (justificatifs et fiche)" value={eur(t.summary.cumulativeCostCents)} strong />}
                  {avecEstimations && <Ligne label="Complément estimé (dépenses d’usage sans justificatif)" value={eur(estime)} muted />}
                  <Ligne label="Coût d’acquisition" value={t.summary.acquisitionStatus === 'MISSING' ? 'non renseigné' : t.summary.acquisitionStatus === 'NOT_APPLICABLE' ? 'sans objet (aucun achat)' : eur(t.summary.acquisitionCents)} muted={t.summary.acquisitionStatus !== 'DOCUMENTED'} />
                  <Ligne label="Dépenses complémentaires" value={eur(t.summary.additionalCostsCents)} />
                  {t.reductionsCents + t.refundsCents + t.indemnitiesCents > 0 && (
                    <Ligne label="Avoirs, remboursements et indemnités" value={`− ${eur(t.reductionsCents + t.refundsCents + t.indemnitiesCents)}`} />
                  )}
                  {!t.disposed && <Ligne label="Coût net estimé (après valeur actuelle)" value={t.summary.netEstimatedCents != null ? eur(t.summary.netEstimatedCents) : 'non calculable'} strong />}
                  {!t.disposed && avecEstimations && usageC?.netEstimatedWithEstimatesCents != null && <Ligne label="Coût net estimé, estimations d’usage incluses" value={eur(usageC.netEstimatedWithEstimatesCents)} muted />}
                  {t.disposed && <Ligne label="Coût net final (après cession)" value={t.summary.netFinalCents != null ? eur(t.summary.netFinalCents) : 'non établi'} strong />}
                  {t.disposed && avecEstimations && usageC?.netFinalWithEstimatesCents != null && <Ligne label="Coût net final, estimations d’usage incluses" value={eur(usageC.netFinalWithEstimatesCents)} muted />}
                </div>
                {avecEstimations && (
                  <p className="text-xs mt-2 text-muted-foreground" data-tco-summary-estimates>
                    Dont {eur(estime)} estimés à partir de vos forfaits d’usage, pour les périodes écoulées sans justificatif suffisant : ce ne sont ni des factures ni des preuves de paiement.
                  </p>
                )}
                <p className={`text-xs mt-2 ${t.status === 'COMPLETE' ? 'text-muted-foreground' : 'text-[color:var(--attention-on-soft)]'}`} data-tco-completeness={t.status}>
                  {t.status === 'COMPLETE' ? `Calcul complet : ${t.reliability.operationsCounted + t.reliability.documentsCounted} élément(s) documenté(s).`
                    : t.status === 'PARTIAL' ? 'Résultat partiel : seule une partie des éléments a pu être lue.'
                      : 'Couverture incomplète : voir les alertes ci-dessous.'}
                </p>
              </div>

              {/* ── Lot 76G : indicateurs annuels (TCO total, TCO moyen annuel, dépenses de l'année) ── */}
              {annual && anneeCourante && (
                <section className="space-y-2" data-tco-annual>
                  <h3 className="vb-app-subsection m-0">Indicateurs annuels</h3>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <div className="rounded-lg border border-border p-3 min-w-0" data-tco-indicator="total">
                      <p className="text-xs text-muted-foreground">{avecEstimations ? 'TCO total (estimations incluses)' : 'TCO total'}</p>
                      <p className="text-lg font-semibold text-[color:var(--text-primary)] tabular-nums">{eur(avecEstimations ? t.summary.totalWithEstimatesCents : annual.average.totalCents)}</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Coût cumulé {t.period.start && !annual.average.incoherence ? `depuis le ${dateNum(t.period.start)}` : 'documenté'}{t.period.endSource === 'TODAY' ? '' : ` jusqu’à la cession (${dateNum(t.period.end)})`}.
                        {avecEstimations ? ` Réel documenté ${eur(annual.average.totalCents)} + complément estimé ${eur(estime)}.` : ''}
                      </p>
                    </div>
                    <div className="rounded-lg border border-border p-3 min-w-0" data-tco-indicator="average" data-tco-average-status={annual.average.status}>
                      <p className="text-xs text-muted-foreground">{avecEstimations ? 'TCO moyen annuel (estimations incluses)' : 'TCO moyen annuel'}</p>
                      <p className={`text-lg font-semibold tabular-nums ${annual.average.cents == null ? 'text-muted-foreground' : 'text-[color:var(--text-primary)]'}`}>
                        {annual.average.cents != null ? `${eur(avecEstimations && usageC?.averageWithEstimatesCents != null ? usageC.averageWithEstimatesCents : annual.average.cents)} / an` : 'Non calculé'}
                      </p>
                      {avecEstimations && annual.average.cents != null && (
                        <p className="text-xs text-muted-foreground mt-0.5" data-tco-average-documented>Réel documenté seul : {eur(annual.average.cents)} / an.</p>
                      )}
                      <p className="text-xs text-muted-foreground mt-1 break-words">{moyenneExplication(annual.average, t.period.endSource)}</p>
                      {annual.average.extrapolationLabel && (
                        <p className="text-xs text-[color:var(--attention-on-soft)] mt-0.5" data-tco-average-extrapolated>{annual.average.extrapolationLabel}.</p>
                      )}
                      {annual.average.cents != null && annual.average.incomplete && (
                        <p className="text-xs text-[color:var(--attention-on-soft)] mt-0.5">Données manquantes : valeur incomplète (voir les alertes).</p>
                      )}
                    </div>
                    <div className="rounded-lg border border-border p-3 min-w-0" data-tco-indicator="year">
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
                          : `${anneeCourante.count} dépense(s) réellement constatée(s) du ${dateFr(anneeCourante.periodStart)} au ${dateFr(anneeCourante.periodEnd)} (montant brut).`}
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
                      {anneeCourante.possiblyIncomplete && (
                        <p className="text-xs text-[color:var(--attention-on-soft)] mt-0.5" data-tco-year-incomplete>
                          {anneeCourante.count === 0 ? 'Absence de dépense non certaine : ' : 'Montant potentiellement incomplet : '}des dépenses sans date ne sont rattachées à aucune année.
                        </p>
                      )}
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Le TCO moyen annuel est un coût annualisé : l’achat initial y est inclus, ce n’est donc pas le budget annuel récurrent d’utilisation.
                    Les dépenses de l’année sont les dépenses réellement constatées, à leur date, pendant l’année choisie{avecEstimations ? ' ; le complément estimé des dépenses d’usage est indiqué à part' : ''}.
                  </p>
                  {(annual.undated.count > 0 || annual.undated.creditsCents > 0) && (
                    <p className="text-xs text-[color:var(--attention-on-soft)]" data-tco-annual-undated>
                      {annual.undated.count} dépense(s) sans date fiable ({eur(annual.undated.costsCents)}) : comptée(s) dans le TCO total, rattachée(s) à aucune année — les montants par année peuvent être incomplets.
                    </p>
                  )}
                  {annual.notRealized.count > 0 && (
                    <p className="text-xs text-muted-foreground" data-tco-annual-not-realized>
                      {annual.notRealized.count} dépense(s) prévue(s) ou datée(s) après aujourd’hui{annual.notRealized.costsCents > 0 ? ` (${eur(annual.notRealized.costsCents)})` : ''} : non encore réalisée(s), comptée(s) dans aucun indicateur (voir « Dépenses non retenues »).
                    </p>
                  )}
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
                    {!t.disposed && <Ligne label="Valeur actuelle" value={t.summary.currentValue ? `${eur(t.summary.currentValue.cents)} · ${dateFr(t.summary.currentValue.date)}` : 'non disponible'} muted />}
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
                    className="w-full min-h-[44px] md:min-h-[36px] flex items-center justify-between gap-3 rounded-lg border border-border px-4 py-2.5 text-left hover:bg-muted/50 transition-colors"
                    data-tco-excluded-trigger
                  >
                    <span className="vb-app-subsection m-0">{`Dépenses non retenues (${ecartees.length}${t.linesTruncated ? ' · liste abrégée' : ''})`}</span>
                    <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" aria-hidden />
                  </button>
                </section>
              )}

              {/* ── Lot 108B : justificatifs sans montant (lecture en cours, à confirmer, introuvable) ── */}
              <TcoAmountRecoveryNotice recovery={t.amountRecovery} />

              {/* ── Alertes ── */}
              {(t.warningLabels.length > 0 || t.reliability.unconverted.length > 0) && (
                <Bloc title="Alertes de couverture" data-tco-warnings>
                  {t.warningLabels.map((w) => <p key={w} className="text-xs text-[color:var(--attention-on-soft)]">{w}</p>)}
                  {t.reliability.unconverted.length > 0 && (
                    <p className="text-xs text-muted-foreground">Non converti : {t.reliability.unconverted.map((u) => minor(u.amountMinor, u.currency)).join(', ')}.</p>
                  )}
                </Bloc>
              )}
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
                {depensesFiltrees.map((l) => <LigneDepense key={l.id} l={l} t={t} canEdit={canEdit} onDecide={decide} />)}
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
                Dépenses examinées mais non comptées dans le coût cumulé, avec leur motif.{canEdit ? ' « Ajouter au TCO » les compte : votre choix prime sur le traitement automatique et reste réversible.' : ''}
              </SheetDescription>
            </SheetHeader>
            <div className="flex-1 overflow-y-auto px-5 py-3">
              <div className="divide-y divide-border">
                {ecartees.length === 0 && <p className="text-sm text-muted-foreground py-1.5">Aucune dépense non retenue.</p>}
                {ecartees.map((l) => <LigneDepense key={l.id} l={l} t={t} canEdit={canEdit} onDecide={decide} />)}
              </div>
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
    </div>
  );
}
