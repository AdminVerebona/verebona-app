'use client';

/**
 * Exécutions & logs › vue technique › Schémas structurés — lot 114 (carte
 * #776, travail 10 ; cahier des charges §6, AC17).
 *
 * Ce que la passerelle a RÉELLEMENT transmis au fournisseur : appels portant
 * le schéma imposé et acceptés, refus HTTP 400, nouveaux essais sans schéma,
 * appels restés en mode JSON à cause d'un refus mémorisé — une réussite
 * finale n'est jamais présentée comme « aucun incident ». Filtres : période,
 * opération, modèle, version du contrat. Puis la mémoire de compatibilité par
 * couple (état, motif, prochain essai) et la projection courante de chaque
 * contrat. Compteurs, codes, versions et empreintes seulement.
 * Desktop et mobile : cartes empilées, aucun tableau à défilement horizontal.
 *
 * Carte #863 (C2, AC17/AC19) : trois vues de COÛT — « Analyses »,
 * « Réparations », « Toutes les tentatives » — sur les mêmes filtres (période,
 * type d'appel, modèle, version du contrat) : appels logiques, requêtes
 * réellement envoyées, minimum chiffré, inconnues (nombre et part), zéros
 * prouvés ; lecture indisponible, aucun envoi et coût inconnu sont trois
 * affichages distincts (jamais « 0 € » pour un coût inconnu) ; détail parent /
 * enfant paginé avec le coût de chaque tentative. Les indicateurs historiques
 * sont désignés « analyse seule ». Les raisons de dégradation et de
 * réservation sont affichées à part des refus et du « non demandé ».
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';
import { formatDateTime } from '@/lib/admin/format';
import { Button } from '@/components/ui/button';

interface Rates { acceptedRate: number | null; refusal400Rate: number | null; jsonModeRate: number | null; requestsPerCall: number | null }
interface Counts {
  calls: number; schemaSent: number; schemaAccepted: number; schemaRefused400: number; schemaFailedOther: number;
  retriesWithoutSchema: number; answeredAfterRetry: number; skippedKnownRejection: number; omittedStatic: number; notRequested: number;
  retests: number; finalSuccess: number; providerRequests: number; inputTokens: number; outputTokens: number; costMicros: number | null; failedAttemptMs: number;
  /** Lot 115 (#784, D1) : tentatives par nature de coût — observé, 0 € explicitement rendu, inconnu. */
  attemptsCostObserved: number; attemptsCostZero: number; attemptsCostUnknown: number;
  /** Carte #838 (A1, A2) / #863 (A3) : sans schéma pour bail détenu ailleurs, mémoire indisponible, report de requalification. */
  skippedQualificationInProgress?: number; skippedMemoryUnavailable?: number; skippedRequalificationDeferred?: number;
  /** Carte #863 (C1) : appels historiques sans détail (requêtes inconnues), tentatives non parties. */
  callsWithoutRequestDetail?: number; attemptsNotSent?: number;
}
/** Carte #863 (C2) : vue de coût d'une famille d'appels (analyses, réparations, toutes tentatives). */
export interface CostView {
  calls: number; providerRequests: number; finalSuccess: number;
  attemptsCostObserved: number; attemptsCostZero: number; attemptsCostUnknown: number; observedCostMicros: number;
  costStatus: 'OBSERVED' | 'ZERO_REPORTED' | 'PARTIAL' | 'NO_PRICE' | 'UNKNOWN' | 'NONE'; unknownShare: number | null;
  attemptsCostPartial?: number; attemptsNoPrice?: number; attemptsNotSent?: number; attemptsUnproven?: number;
  attemptsDispatchUndetermined?: number; callsWithoutDetail?: number;
}
export interface CostViews { views: { analysis: CostView; repair: CostView; total: CostView } | null; unavailable: string | null }
interface DetailAttempt {
  attemptId: string | null; step: number; kind: string; phase: string | null; parentAttemptId: string | null; dispatch: string | null;
  outcome: string; httpStatus: number | null; durationMs: number | null; inputTokens: number | null; outputTokens: number | null;
  thoughtsTokens: number | null; costMicros: number | null; costStatus: string | null; responseSchemaSent: boolean;
}
interface DetailCall { usageEventId: number; callKind: 'analysis' | 'repair'; parentCallIndex: number | null; model: string; status: string; costMicros: number | null; attempts: DetailAttempt[] }
export interface CostDetails {
  executions: Array<{ traceId: string; operationCode: string; createdAt: string; calls: DetailCall[] }>;
  page: number; pageSize: number; hasMore: boolean; unavailable: string | null;
}
interface Group extends Counts {
  operationCode: string; model: string; contractId: string | null; contractVersion: number | null; schemaHash: string | null;
  providerSchemaHash: string | null; durationP50Ms: number | null; durationP95Ms: number | null; rates: Rates;
}
interface Day { day: string; calls: number; schemaAccepted: number; schemaRefused400: number; skippedKnownRejection: number; notRequested: number; acceptedRate: number | null }
interface Couple {
  keyId: string; model: string; operationCode: string; contractId: string; contractVersion: number; schemaHash: string;
  providerSchemaHash: string | null; adapterVersion: string; state: string; stateLabel: string; reason: string | null; current: boolean;
  /** Lot 115 (#784, E1) : statut de routage réel du couple (absent : serveur antérieur). */
  routingStatus?: 'ACTIVE' | 'WITHDRAWN' | 'UNKNOWN'; routingLabel?: string;
  /** Lot 115 (#784, A3) : profil de génération effectif et version de modèle réellement servie. */
  generationProfileHash: string; servedModelVersion: string | null; versionUncertain: boolean;
  acceptedCount: number; rejectionCount: number; consecutiveRejections: number; retestCount: number;
  lastRejectedAt: string | null; lastAcceptedAt: string | null; nextRetestAt: string | null; retestInProgress: boolean;
  lastHttpStatus: number | null; lastProviderCode: string | null; appVersion: string | null;
}
interface StaticRow {
  operationCode: string; contractId: string; contractVersion: number; schemaHash: string; providerSchemaHash: string | null;
  adapterVersion: string; nodes: number; serializedChars: number | null; omitted: string | null; droppedKeywords: string[]; issues: string[]; lostBranches: string[];
}
interface Overview {
  usage: {
    days: number;
    /** Lot 115 (#784, D2) : totaux EXACTS de l'ensemble filtré, jamais la somme de la page affichée. */
    totals: Counts & { rates: Rates; durationP50Ms: number | null; durationP95Ms: number | null };
    groups: Group[];
    /** Nombre total de couples de l'ensemble ; `groupsTruncated` : la ventilation affichée est partielle. */
    groupCount: number | null; groupsTruncated: boolean;
    trend: Day[]; unavailable: string | null;
  };
  couples: Couple[] | null; staticMatrix: StaticRow[]; openAlerts: number | null; appVersion: string | null;
  policy: { version: number; firstRetestMs: number; retestAfterQualifiedMs: number; maxRetestMs: number };
  /** Carte #863 (C2) : vues de coût et détail parent / enfant (absents : serveur antérieur). */
  costViews?: CostViews; costDetails?: CostDetails;
  /** Carte #838 / #863 (A2) : décisions sans schéma de cette instance, par cause. */
  memoryDegraded?: { decisions: number; byCause: Record<string, number>; sharedHealthy: boolean; byWhy?: Record<string, number> } | null;
}
interface Bilan {
  examined: number; resolved: Record<string, number>; keptActive: number; keptUndetermined: number; raised: number; unavailable: boolean;
  /** Lot 115 (#784, E1/E2) : routage non établi, abstentions, exhaustivité et bilan chiffré. */
  keptRoutingUnknown: number; raiseSkippedRoutingUnknown: number; done: boolean; couplesScanned: number;
  before: { openAlerts: number | null }; after: { openAlerts: number | null };
  /** Lot 115 (#784, E3) : constat de coordination avec les alertes de couverture T1 (#775), lecture seule. */
  coverageCoordination?: { openCoverageAnomalies: number | null; openCoverageAnomaliesAfter: number | null; unchanged: boolean };
  /** Carte #863 (D1) : statut fidèle du passage et bilan cumulé du cycle. */
  checkpoint?: { status: string; cycle: number | null; cycleCompleted: boolean; lastError?: string | null } | null;
  cycleTotals?: { examined: number; failures: number; retries: number } | null;
}

/** Carte #863 (D1) : libellés des statuts d'un passage de réévaluation (à valider par le PO). */
const STATUT_PASSAGE: Record<string, string> = {
  RAN: 'passage exécuté', LEASE_HELD: 'une autre instance réévalue déjà (rien fait ici)', LEASE_LOST: 'passage interrompu : reprise par une autre instance',
  INTERRUPTED: 'passage interrompu sur erreur : reprise au dernier point sûr', UNAVAILABLE: 'point de reprise indisponible (migration absente)',
  NOTHING_TO_DO: 'aucun cycle dû',
};

const pct = (v: number | null): string => (v === null ? 'non mesurable' : `${(v * 100).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %`);
const euros = (micros: number | null): string => (micros === null ? 'non calculable' : `${(micros / 1_000_000).toLocaleString('fr-FR', { minimumFractionDigits: 4, maximumFractionDigits: 4 })} €`);
const heures = (ms: number): string => `${Math.round(ms / 3_600_000)} h`;

/**
 * Carte #863 (C2) — montant d'une vue selon la NATURE de son coût : un coût inconnu n'est JAMAIS « 0 € »,
 * un minimum est dit minimum, un zéro n'est affiché comme tel que s'il est prouvé. Pur.
 */
export function costLabel(v: Pick<CostView, 'costStatus' | 'observedCostMicros'>): string {
  switch (v.costStatus) {
    case 'NONE': return 'aucun envoi';
    case 'UNKNOWN': return 'inconnu';
    case 'NO_PRICE': return 'inconnu (tarif absent)';
    case 'ZERO_REPORTED': return '0 € (zéro prouvé par le fournisseur)';
    case 'PARTIAL': return `au moins ${euros(v.observedCostMicros)} (part inconnue)`;
    default: return `${euros(v.observedCostMicros)} (toutes requêtes chiffrées)`;
  }
}

/** Carte #863 (C2) : coût d'UNE tentative (statut individuel). Pur. */
function attemptCostLabel(a: Pick<DetailAttempt, 'costStatus' | 'costMicros' | 'dispatch'>): string {
  if (a.dispatch && a.dispatch !== 'SENT' && a.dispatch !== 'DEPARTURE_UNPROVEN') return 'non envoyée (aucun coût)';
  if (a.dispatch === 'DEPARTURE_UNPROVEN') return 'départ non prouvable · coût inconnu';
  if (a.costStatus === 'OBSERVED' && a.costMicros !== null) return euros(a.costMicros);
  if (a.costStatus === 'ZERO_REPORTED') return '0 € (prouvé)';
  if (a.costStatus === 'PARTIAL' && a.costMicros !== null) return `au moins ${euros(a.costMicros)}`;
  if (a.costStatus === 'NO_PRICE') return 'inconnu (tarif absent)';
  return 'inconnu';
}

export type CostViewTab = 'analysis' | 'repair' | 'total';
const ONGLETS: ReadonlyArray<[CostViewTab, string]> = [['analysis', 'Analyses'], ['repair', 'Réparations'], ['total', 'Toutes les tentatives']];

/**
 * Carte #863 (C2) — trois vues de coût (« Analyses », « Réparations », « Toutes les tentatives »), mêmes filtres que
 * le reste du panneau ; détail parent / enfant de la page courante. Présentation pure (testable sans réseau).
 */
export function SchemaCostViewsSection({ costViews, costDetails, initialTab = 'total', onPage }: {
  costViews: CostViews | undefined; costDetails?: CostDetails; initialTab?: CostViewTab; onPage?: (page: number) => void;
}) {
  const [onglet, setOnglet] = useState<CostViewTab>(initialTab);
  if (!costViews) return null;
  const v = costViews.views?.[onglet] ?? null;
  const appels = (costDetails?.executions ?? []).map((x) => ({
    ...x, calls: x.calls.filter((c) => onglet === 'total' || c.callKind === onglet),
  })).filter((x) => x.calls.length > 0);
  return (
    <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 space-y-2 min-w-0" data-testid="schema-cost-views">
      <p className="text-sm font-medium text-[color:var(--text-primary)]">Coût des requêtes envoyées</p>
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Vue de coût">
        {ONGLETS.map(([cle, libelle]) => (
          <Button key={cle} size="sm" variant={onglet === cle ? 'default' : 'outline'} className="min-h-[44px] sm:min-h-0"
            role="tab" aria-selected={onglet === cle} data-testid={`schema-cost-tab-${cle}`} onClick={() => setOnglet(cle)}>{libelle}</Button>
        ))}
      </div>
      {costViews.unavailable !== null && (
        <p className="text-sm text-[color:var(--text-warning)] break-words" data-testid="schema-cost-unavailable">
          Lecture des coûts indisponible ({costViews.unavailable}) : aucun montant n’est affiché plutôt qu’un zéro trompeur.
        </p>
      )}
      {costViews.unavailable === null && v && v.costStatus === 'NONE' && (
        <p className="text-sm text-[color:var(--text-muted)]" data-testid="schema-cost-none">Aucune requête envoyée sur la période pour ces filtres.</p>
      )}
      {costViews.unavailable === null && v && v.costStatus !== 'NONE' && (
        <div className="space-y-0.5" data-testid={`schema-cost-view-${onglet}`}>
          <Ligne label="Coût">{costLabel(v)}</Ligne>
          <Ligne label="Appels logiques">{v.calls} · réussite finale {v.finalSuccess}</Ligne>
          <Ligne label="Requêtes réellement envoyées">{v.providerRequests}{(v.attemptsDispatchUndetermined ?? 0) > 0 ? ` (dont ${v.attemptsDispatchUndetermined} tracée(s) avant le suivi du départ)` : ''}</Ligne>
          <Ligne label="Minimum chiffré">{v.costStatus === 'UNKNOWN' || v.costStatus === 'NO_PRICE' ? 'aucun montant chiffrable' : euros(v.observedCostMicros)}</Ligne>
          <Ligne label="Coût inconnu">{v.attemptsCostUnknown} requête(s) · part {pct(v.unknownShare)}{(v.attemptsCostPartial ?? 0) > 0 ? ` · dont ${v.attemptsCostPartial} partiellement chiffrée(s)` : ''}{(v.attemptsNoPrice ?? 0) > 0 ? ` · dont ${v.attemptsNoPrice} sans tarif` : ''}</Ligne>
          <Ligne label="Zéros prouvés">{v.attemptsCostZero} requête(s) à 0 € rendu par le fournisseur</Ligne>
          {((v.attemptsNotSent ?? 0) > 0 || (v.attemptsUnproven ?? 0) > 0 || (v.callsWithoutDetail ?? 0) > 0) && (
            <Ligne label="Hors requêtes réelles">{v.attemptsNotSent ?? 0} tentative(s) non envoyée(s) (garde, construction, transfert) · {v.attemptsUnproven ?? 0} départ(s) non prouvable(s) · {v.callsWithoutDetail ?? 0} appel(s) historique(s) sans détail (nombre de requêtes inconnu)</Ligne>
          )}
        </div>
      )}
      {costDetails && costDetails.unavailable === null && appels.length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs text-[color:var(--text-secondary)] min-h-[44px] sm:min-h-0 flex items-center">Détail par exécution (page {costDetails.page + 1})</summary>
          <div className="mt-1 space-y-2">
            {appels.map((x) => (
              <div key={x.traceId} className="rounded-lg border border-[color:var(--border-subtle)] p-3 space-y-0.5 min-w-0" data-testid="schema-cost-execution">
                <p className="text-xs text-[color:var(--text-primary)] break-words">{x.operationCode} · {formatDateTime(x.createdAt)} · exécution {x.traceId.slice(0, 8)}</p>
                {x.calls.map((c) => (
                  <div key={c.usageEventId} className={c.callKind === 'repair' ? 'pl-3 border-l border-[color:var(--border-subtle)]' : ''}>
                    <Ligne label={c.callKind === 'repair' ? `Réparation (enfant de l’appel n° ${c.parentCallIndex ?? '?'})` : 'Analyse'}>
                      {c.model} · {c.status === 'success' ? 'réussite' : 'échec'} · {c.attempts.length === 0 ? 'détail des requêtes non tracé' : `${c.attempts.length} tentative(s)`}
                    </Ligne>
                    {c.attempts.map((a) => (
                      <p key={a.attemptId ?? `${c.usageEventId}-${a.step}`} className="text-xs text-[color:var(--text-secondary)] break-words" data-testid="schema-cost-attempt">
                        {a.step}. {a.kind}{a.responseSchemaSent ? ' (schéma)' : ''} · {a.outcome === 'SUCCESS' ? 'réponse' : `échec${a.httpStatus ? ` HTTP ${a.httpStatus}` : ''}`}
                        {a.durationMs !== null ? ` · ${a.durationMs} ms` : ''} · jetons {a.inputTokens ?? '?'} / {a.outputTokens ?? '?'}{a.thoughtsTokens ? ` + ${a.thoughtsTokens} réflexion` : ''} · {attemptCostLabel(a)}
                      </p>
                    ))}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </details>
      )}
      {costDetails?.unavailable && <p className="text-xs text-[color:var(--text-warning)] break-words">Détail des exécutions indisponible ({costDetails.unavailable}).</p>}
      {costDetails && onPage && (costDetails.page > 0 || costDetails.hasMore) && (
        <div className="flex gap-2">
          <Button size="sm" variant="outline" className="min-h-[44px] sm:min-h-0" disabled={costDetails.page === 0} onClick={() => onPage(costDetails.page - 1)}>Page précédente</Button>
          <Button size="sm" variant="outline" className="min-h-[44px] sm:min-h-0" disabled={!costDetails.hasMore} onClick={() => onPage(costDetails.page + 1)}>Page suivante</Button>
        </div>
      )}
      <p className="text-xs text-[color:var(--text-muted)] break-words">
        Les totaux portent sur toute la période filtrée, indépendamment de la page de détail. « Toutes les tentatives » = analyses + réparations, sans doublon.
      </p>
    </div>
  );
}

/** Motifs d'état (libellés à valider par le PO). */
const MOTIF: Record<string, string> = {
  EXPLICIT_SCHEMA_REJECTION: 'schéma refusé explicitement par le fournisseur',
  GENERIC_400_ANSWERED_WITHOUT_SCHEMA: 'requête avec schéma refusée (HTTP 400 sans précision), réponse obtenue sans schéma',
  ACCEPTED_ON_REAL_CALL: 'réponse du fournisseur à un appel réel portant le schéma',
  RETEST_INCONCLUSIVE: 'dernier essai avec schéma sans conclusion (délai, réseau ou autre refus)',
  // Lot 115 (#784, A3) — libellé à valider par le PO.
  SERVED_VERSION_CHANGED: 'version de modèle servie différente de celle du refus : un essai avec schéma est de nouveau dû',
};
const motifOf = (r: string | null): string => (r === null ? '—' : MOTIF[r] ?? (r.startsWith('STATIC_') ? `contrôle statique : ${r.slice(7)}` : r));

function Ligne({ label, children }: { label: string; children: ReactNode }) {
  return (
    <p className="text-xs text-[color:var(--text-secondary)] break-words">
      <span className="text-[color:var(--text-muted)]">{label} : </span>{children}
    </p>
  );
}

export function SchemaCompatibilityPanel({ initialOperation = '' }: { initialOperation?: string }) {
  const [days, setDays] = useState('7');
  const [operation, setOperation] = useState(initialOperation);
  const [model, setModel] = useState('');
  const [contractVersion, setContractVersion] = useState('');
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [bilan, setBilan] = useState<Bilan | null>(null);
  // Carte #863 (C2) : page du détail parent / enfant (les totaux n'en dépendent pas).
  const [page, setPage] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const q = new URLSearchParams({ days });
      if (operation) q.set('operation', operation);
      if (model) q.set('model', model);
      if (contractVersion) q.set('contractVersion', contractVersion);
      if (page > 0) q.set('page', String(page));
      setData(await apiClient.get<Overview>(`/api/admin/ai/schema-compatibility?${q}`));
    } catch {
      toast.error('Suivi des schémas structurés indisponible.');
    } finally {
      setLoading(false);
    }
  }, [days, operation, model, contractVersion, page]);
  useEffect(() => { void load(); }, [load]);

  const reevaluer = async () => {
    setBusy(true);
    try {
      setBilan(await apiClient.post<Bilan>('/api/admin/ai/schema-compatibility/reevaluate', {}));
      await load();
    } catch {
      toast.error('Réévaluation des alertes impossible.');
    } finally {
      setBusy(false);
    }
  };

  const operations = [...new Set([...(data?.staticMatrix ?? []).map((s) => s.operationCode), ...(data?.usage.groups ?? []).map((g) => g.operationCode)])].sort();
  const models = [...new Set([...(data?.usage.groups ?? []).map((g) => g.model), ...(data?.couples ?? []).map((c) => c.model)])].sort();
  const t = data?.usage.totals;
  const champ = 'min-h-[44px] sm:min-h-0 rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] px-2 py-1 text-sm text-[color:var(--text-primary)] min-w-0';

  return (
    <div className="space-y-4 min-w-0" data-testid="schema-compatibility">
      <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 space-y-3 min-w-0">
        <p className="text-xs text-[color:var(--text-muted)] break-words">
          Usage réel du schéma de sortie imposé au fournisseur, mesuré sur les appels enregistrés. Une réussite finale peut contenir un refus puis un nouvel essai sans schéma : ils sont comptés ici. Aucun contenu de document ni de prompt.
        </p>
        <div className="flex flex-col sm:flex-row sm:flex-wrap gap-2 sm:items-center">
          <label className="text-xs text-[color:var(--text-secondary)] flex flex-col sm:flex-row sm:items-center gap-1">Période
            <select className={champ} value={days} onChange={(e) => setDays(e.target.value)} aria-label="Période">
              {['1', '7', '30', '90'].map((d) => <option key={d} value={d}>{d === '1' ? '24 heures' : `${d} jours`}</option>)}
            </select>
          </label>
          <label className="text-xs text-[color:var(--text-secondary)] flex flex-col sm:flex-row sm:items-center gap-1">Type d’appel
            <select className={champ} value={operation} onChange={(e) => setOperation(e.target.value)} aria-label="Type d’appel">
              <option value="">Tous</option>
              {(operation && !operations.includes(operation) ? [operation, ...operations] : operations).map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </label>
          <label className="text-xs text-[color:var(--text-secondary)] flex flex-col sm:flex-row sm:items-center gap-1">Modèle
            <select className={champ} value={model} onChange={(e) => setModel(e.target.value)} aria-label="Modèle">
              <option value="">Tous</option>
              {(model && !models.includes(model) ? [model, ...models] : models).map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
          <label className="text-xs text-[color:var(--text-secondary)] flex flex-col sm:flex-row sm:items-center gap-1">Version du contrat
            <input className={`${champ} sm:w-20`} inputMode="numeric" value={contractVersion} placeholder="toutes"
              onChange={(e) => setContractVersion(e.target.value.replace(/\D/g, '').slice(0, 4))} aria-label="Version du contrat" />
          </label>
          <Button size="sm" variant="outline" className="min-h-[44px] sm:min-h-0" onClick={() => void load()} disabled={loading}>Actualiser</Button>
        </div>

        {!data && <p className="text-sm text-[color:var(--text-muted)]">Chargement…</p>}
        {data?.usage.unavailable && (
          <p className="text-sm text-[color:var(--text-warning)] break-words">Mesure indisponible ({data.usage.unavailable}) : aucun indicateur n’est affiché plutôt qu’un zéro trompeur.</p>
        )}
        {data && !data.usage.unavailable && t && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2" data-testid="schema-usage-totals">
            {([
              ['Schéma imposé accepté', `${pct(t.rates.acceptedRate)}`, `${t.schemaAccepted} appel(s) sur ${t.calls - t.notRequested} où il était demandé`],
              ['Refus HTTP 400 avec schéma', String(t.schemaRefused400), `${pct(t.rates.refusal400Rate)} des requêtes portant le schéma`],
              ['Nouveaux essais sans schéma', String(t.retriesWithoutSchema), `${t.answeredAfterRetry} appel(s) ont abouti ainsi`],
              ['Sans schéma : refus mémorisé', String(t.skippedKnownRejection), `${t.omittedStatic} pour motif statique · ${t.notRequested} non demandé`],
              // Carte #863 (A1-A3) : réservation, mémoire indisponible et report — jamais confondus avec un refus ou « non demandé ».
              ['Sans schéma : réservation ou mémoire', String((t.skippedQualificationInProgress ?? 0) + (t.skippedMemoryUnavailable ?? 0) + (t.skippedRequalificationDeferred ?? 0)),
                `${t.skippedQualificationInProgress ?? 0} essai réservé par une autre instance · ${t.skippedMemoryUnavailable ?? 0} mémoire indisponible · ${t.skippedRequalificationDeferred ?? 0} requalification reportée`],
              ['Réussite finale (analyse seule)', `${t.finalSuccess} / ${t.calls}`, 'appels d’analyse ayant sollicité le fournisseur'],
              ['Requêtes fournisseur réelles (analyse seule)', String(t.providerRequests),
                `${t.rates.requestsPerCall ?? '—'} par appel · ${t.retests} essai(s) de réexamen${(t.callsWithoutRequestDetail ?? 0) > 0 ? ` · ${t.callsWithoutRequestDetail} appel(s) historique(s) sans détail` : ''}`],
              ['Jetons (analyse seule)', `${t.inputTokens.toLocaleString('fr-FR')} / ${t.outputTokens.toLocaleString('fr-FR')}`, 'entrée / sortie'],
              ['Coût confirmé (analyse seule)', euros(t.costMicros),
                `${t.attemptsCostUnknown} tentative(s) au coût inconnu · ${t.attemptsCostZero} à 0 € rendu · ${Math.round(t.failedAttemptMs / 1000)} s dans des requêtes refusées — coût complet : vues ci-dessous`],
              ['Latence', `P50 ${t.durationP50Ms ?? '—'} ms · P95 ${t.durationP95Ms ?? '—'} ms`, 'sur l’ensemble de la période filtrée'],
            ] as const).map(([titre, valeur, detail]) => (
              <div key={titre} className="rounded-lg border border-[color:var(--border-subtle)] p-3 min-w-0">
                <p className="text-xs text-[color:var(--text-muted)] break-words">{titre}</p>
                <p className="text-lg font-semibold text-[color:var(--text-primary)] break-words">{valeur}</p>
                <p className="text-xs text-[color:var(--text-secondary)] break-words">{detail}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Carte #863 (C2) : vues de coût Analyses / Réparations / Toutes les tentatives, mêmes filtres. */}
      {data?.costViews && <SchemaCostViewsSection costViews={data.costViews} costDetails={data.costDetails} onPage={setPage} />}
      {data?.memoryDegraded && data.memoryDegraded.decisions > 0 && (
        <p className="text-xs text-[color:var(--text-warning)] break-words" data-testid="schema-memory-degraded">
          Mode dégradé de cette instance : {data.memoryDegraded.decisions} appel(s) sans schéma faute de mémoire prouvable
          ({Object.entries(data.memoryDegraded.byCause).map(([c, n]) => `${c} : ${n}`).join(' · ')}) — ni refus, ni « non demandé ».
        </p>
      )}

      {data && !data.usage.unavailable && (
        <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 space-y-2 min-w-0">
          <p className="text-sm font-medium text-[color:var(--text-primary)]">Par type d’appel, modèle et contrat (analyse seule)</p>
          {data.usage.groups.length === 0 && <p className="text-sm text-[color:var(--text-muted)]">Aucun appel sur la période.</p>}
          {data.usage.groupsTruncated && (
            <p className="text-xs text-[color:var(--text-secondary)] break-words">
              Ventilation partielle : {data.usage.groups.length} couple(s) affiché(s) sur {data.usage.groupCount ?? '—'}. Les totaux
              ci-dessus portent sur l’ensemble de la période filtrée, pas sur cette page.
            </p>
          )}
          {data.usage.groups.map((g) => (
            <div key={`${g.operationCode}|${g.model}|${g.schemaHash}|${g.providerSchemaHash}`} className="rounded-lg border border-[color:var(--border-subtle)] p-3 space-y-0.5 min-w-0" data-testid="schema-usage-group">
              <p className="text-sm text-[color:var(--text-primary)] break-words">
                {g.operationCode} · {g.model} · {g.contractId ?? 'contrat non tracé'}{g.contractVersion !== null ? ` v${g.contractVersion}` : ''}
              </p>
              <Ligne label="Empreintes">contrat {g.schemaHash ?? '—'} · schéma transmis {g.providerSchemaHash ?? '—'}</Ligne>
              <Ligne label="Schéma imposé accepté">{pct(g.rates.acceptedRate)} ({g.schemaAccepted} sur {g.calls - g.notRequested})</Ligne>
              <Ligne label="Refus HTTP 400 avec schéma">{g.schemaRefused400} · nouveaux essais sans schéma : {g.retriesWithoutSchema} · aboutis : {g.answeredAfterRetry}</Ligne>
              <Ligne label="Sans schéma">{g.skippedKnownRejection} par refus mémorisé · {g.omittedStatic} pour motif statique · {g.notRequested} non demandé</Ligne>
              <Ligne label="Appels">{g.calls} · réussite finale {g.finalSuccess} · requêtes fournisseur {g.providerRequests}</Ligne>
              <Ligne label="Jetons, coût, durée">{g.inputTokens.toLocaleString('fr-FR')} / {g.outputTokens.toLocaleString('fr-FR')} · {euros(g.costMicros)} · P50 {g.durationP50Ms ?? '—'} ms · P95 {g.durationP95Ms ?? '—'} ms</Ligne>
              <Ligne label="Tentatives chiffrées">{g.attemptsCostObserved} au coût observé · {g.attemptsCostZero} à 0 € rendu · {g.attemptsCostUnknown} au coût inconnu</Ligne>
            </div>
          ))}
          {data.usage.trend.length > 1 && (
            <details>
              <summary className="cursor-pointer text-xs text-[color:var(--text-secondary)] min-h-[44px] sm:min-h-0 flex items-center">Évolution par jour ({data.usage.trend.length} jours)</summary>
              <div className="mt-1 space-y-0.5">
                {data.usage.trend.map((d) => (
                  <p key={d.day} className="text-xs text-[color:var(--text-secondary)] break-words">
                    {d.day} · {d.calls} appel(s) · schéma accepté {pct(d.acceptedRate)} · refus 400 : {d.schemaRefused400} · sans schéma par refus mémorisé : {d.skippedKnownRejection}
                  </p>
                ))}
              </div>
            </details>
          )}
        </div>
      )}

      {data && (
        <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 space-y-2 min-w-0">
          <div className="flex flex-col sm:flex-row sm:items-center gap-2">
            <p className="flex-1 min-w-0 text-sm font-medium text-[color:var(--text-primary)] break-words">
              Compatibilité mémorisée par couple{data.openAlerts !== null ? ` · ${data.openAlerts} alerte(s) de compatibilité ouverte(s)` : ''}
            </p>
            <Button size="sm" variant="outline" className="min-h-[44px] sm:min-h-0" onClick={() => void reevaluer()} disabled={busy}>
              {busy ? 'Réévaluation…' : 'Réévaluer les alertes'}
            </Button>
          </div>
          <p className="text-xs text-[color:var(--text-muted)] break-words">
            Mémoire partagée entre les instances et conservée après redémarrage. Après un refus, le schéma n’est plus transmis au couple ; un seul essai avec schéma est retenté après {heures(data.policy.firstRetestMs)} (délai doublé à chaque nouveau refus, au plus {heures(data.policy.maxRetestMs)} ; {heures(data.policy.retestAfterQualifiedMs)} si le couple avait déjà été accepté). Politique n° {data.policy.version}. Le fournisseur n’indique pas la cause d’un refus HTTP 400 sans précision.
          </p>
          {bilan && (
            <p className="text-xs text-[color:var(--text-secondary)] break-words" data-testid="schema-reevaluation">
              Réévaluation : {bilan.examined} alerte(s) examinée(s) · {bilan.resolved.SCHEMA_ACCEPTED_AGAIN ?? 0} résolue(s) (schéma de nouveau accepté) · {bilan.resolved.SCHEMA_SUPERSEDED ?? 0} résolue(s) (contrat ou schéma remplacé) · {bilan.resolved.SCHEMA_MODEL_WITHDRAWN ?? 0} résolue(s) (modèle retiré du routage et du référentiel) · {bilan.keptActive} conservée(s) (refus toujours actif) · {bilan.keptUndetermined} conservée(s) faute de preuve · {bilan.keptRoutingUnknown} conservée(s) faute de routage établi · {bilan.raised} levée(s){bilan.raiseSkippedRoutingUnknown > 0 ? ` · ${bilan.raiseSkippedRoutingUnknown} non levée(s) faute de routage établi` : ''} · {bilan.couplesScanned} couple(s) parcouru(s){bilan.before.openAlerts !== null && bilan.after.openAlerts !== null ? ` · ouvertes ${bilan.before.openAlerts} → ${bilan.after.openAlerts}` : ''}{bilan.done ? ' · parcours terminé' : ' · parcours à poursuivre (budget du passage atteint)'}{bilan.unavailable ? ' · lecture incomplète' : ''}
            </p>
          )}
          {/* Carte #863 (D1) : statut FIDÈLE du passage (bail détenu, perdu, interrompu, indisponible, terminé) et bilan du cycle. */}
          {bilan?.checkpoint && (
            <p className="text-xs text-[color:var(--text-secondary)] break-words" data-testid="schema-reevaluation-status">
              Statut : {STATUT_PASSAGE[bilan.checkpoint.status] ?? bilan.checkpoint.status}{bilan.checkpoint.cycle !== null ? ` · cycle n° ${bilan.checkpoint.cycle}` : ''}
              {bilan.checkpoint.cycleCompleted ? ' · cycle terminé' : ' · cycle non terminé'}
              {bilan.cycleTotals ? ` · cumul du cycle : ${bilan.cycleTotals.examined} examinée(s), ${bilan.cycleTotals.failures} échec(s), ${bilan.cycleTotals.retries} reprise(s)` : ''}
              {bilan.checkpoint.lastError ? ` · dernière erreur : ${bilan.checkpoint.lastError}` : ''}
            </p>
          )}
          {/* Lot 115 (#784, E3) : coordination avec les alertes de couverture T1 (#775) — constat, jamais une action. */}
          {bilan?.coverageCoordination && (
            <p className="text-xs text-[color:var(--text-muted)] break-words" data-testid="schema-coverage-coordination">
              Alertes de couverture T1 (suivi séparé) : {bilan.coverageCoordination.openCoverageAnomalies ?? 'non mesurable'} ouverte(s)
              avant, {bilan.coverageCoordination.openCoverageAnomaliesAfter ?? 'non mesurable'} après —
              {bilan.coverageCoordination.unchanged ? ' inchangées (ce passage ne les touche pas).' : ' écart constaté, à vérifier.'}
              {' '}Une réussite en mode JSON après un refus de schéma ne ferme aucune lacune de couverture.
            </p>
          )}
          {data.couples === null && <p className="text-sm text-[color:var(--text-warning)]">Mémoire de compatibilité indisponible (migration 1710 non appliquée).</p>}
          {data.couples?.length === 0 && <p className="text-sm text-[color:var(--text-muted)]">Aucun couple observé pour ces filtres.</p>}
          {data.couples?.map((c) => (
            <div key={c.keyId} className="rounded-lg border border-[color:var(--border-subtle)] p-3 space-y-0.5 min-w-0" data-testid="schema-couple">
              <p className="text-sm text-[color:var(--text-primary)] break-words">
                {c.operationCode} · {c.model} · {c.contractId} v{c.contractVersion} —{' '}
                <span className={c.state === 'REJECTED_CONFIRMED' || c.state === 'NEEDS_RECHECK' ? 'text-[color:var(--text-warning)]' : ''}>{c.stateLabel}</span>
                {!c.current && <span className="text-[color:var(--text-muted)]"> (historique : ce schéma n’est plus celui transmis)</span>}
              </p>
              <Ligne label="Motif">{motifOf(c.reason)}{c.lastHttpStatus ? ` · HTTP ${c.lastHttpStatus}` : ''}{c.lastProviderCode ? ` ${c.lastProviderCode}` : ''}</Ligne>
              <Ligne label="Empreintes">contrat {c.schemaHash} · schéma transmis {c.providerSchemaHash ?? 'aucun'} · adaptateur {c.adapterVersion}</Ligne>
              {/* Lot 115 (#784, E1) : le statut de routage est CALCULÉ pour les alertes — il est maintenant affiché. */}
              {c.routingLabel && (
                <Ligne label="Routage">
                  <span className={c.routingStatus === 'UNKNOWN' ? 'text-[color:var(--text-warning)]' : undefined}>{c.routingLabel}</span>
                </Ligne>
              )}
              {/* Lot 115 (#784, A3) : ce qui identifie VRAIMENT le couple, et la version réellement servie. */}
              <Ligne label="Profil de génération">
                {c.generationProfileHash === '-' ? 'aucun paramètre matériel' : c.generationProfileHash}
              </Ligne>
              <Ligne label="Version de modèle servie">
                {c.servedModelVersion ?? 'jamais indiquée par le fournisseur'}
                {c.versionUncertain ? ' · non indiquée au dernier constat (incertitude conservée, aucune version supposée)' : ''}
              </Ligne>
              <Ligne label="Constats">{c.acceptedCount} acceptation(s) relevée(s) · {c.rejectionCount} refus ({c.consecutiveRejections} consécutif(s)) · {c.retestCount} réexamen(s)</Ligne>
              <Ligne label="Dates">dernier refus {c.lastRejectedAt ? formatDateTime(c.lastRejectedAt) : '—'} · dernière acceptation {c.lastAcceptedAt ? formatDateTime(c.lastAcceptedAt) : '—'}
                {c.nextRetestAt ? ` · prochain essai avec schéma au plus tôt ${formatDateTime(c.nextRetestAt)}` : ''}{c.retestInProgress ? ' · essai en cours' : ''}</Ligne>
              {c.appVersion && <Ligne label="Version de l’application">{c.appVersion.slice(0, 12)}</Ligne>}
            </div>
          ))}
        </div>
      )}

      {data && (
        <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 space-y-2 min-w-0">
          <p className="text-sm font-medium text-[color:var(--text-primary)] break-words">Schéma transmis aujourd’hui, par contrat (contrôle statique)</p>
          <p className="text-xs text-[color:var(--text-muted)] break-words">
            Calculé par cette version de l’application{data.appVersion ? ` (${data.appVersion.slice(0, 12)})` : ''}. Ce contrôle écarte les incompatibilités connues ; il ne prouve pas l’acceptation par le fournisseur, que seuls les appels réels établissent.
          </p>
          <details>
            <summary className="cursor-pointer text-xs text-[color:var(--text-secondary)] min-h-[44px] sm:min-h-0 flex items-center">{data.staticMatrix.length} contrat(s)</summary>
            <div className="mt-1 space-y-2">
              {data.staticMatrix.map((s) => (
                <div key={s.operationCode} className="rounded-lg border border-[color:var(--border-subtle)] p-3 space-y-0.5 min-w-0" data-testid="schema-static">
                  <p className="text-sm text-[color:var(--text-primary)] break-words">
                    {s.operationCode} · {s.contractId} v{s.contractVersion} — {s.omitted ? <span className="text-[color:var(--text-warning)]">non transmis ({s.omitted})</span> : 'transmissible'}
                  </p>
                  <Ligne label="Empreintes">contrat {s.schemaHash} · schéma transmis {s.providerSchemaHash ?? 'aucun'} · adaptateur {s.adapterVersion}</Ligne>
                  <Ligne label="Taille">{s.nodes} nœud(s){s.serializedChars !== null ? ` · ${s.serializedChars.toLocaleString('fr-FR')} caractères` : ''}</Ligne>
                  <Ligne label="Contraintes vérifiées par Verebona seulement">{s.droppedKeywords.length ? s.droppedKeywords.join(', ') : 'aucune'}</Ligne>
                  <Ligne label="Branches du contrat absentes du schéma transmis">{s.lostBranches.length ? s.lostBranches.join(', ') : 'aucune'}</Ligne>
                  {s.issues.length > 0 && <Ligne label="Écarts signalés">{s.issues.join(' ; ')}</Ligne>}
                </div>
              ))}
            </div>
          </details>
        </div>
      )}
    </div>
  );
}
