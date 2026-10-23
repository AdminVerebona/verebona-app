'use client';

/**
 * Pertinence des « À traiter » documentaires — lot 61 (tickets « BUG P1 —
 * écarts résiduels du lot 58B » et « [P1] Fiabiliser la pertinence des
 * cartes »).
 *
 * Une carte, une colonne sur mobile, grilles à partir de `sm`, composants et
 * jetons existants seulement. Sans SQL ni commande, le PO :
 *   · voit la configuration T4 effective (contrat `t4_output_v3` actif ou
 *     non : l'évaluation structurée de l'intervention l'exige) ;
 *   · suit la réévaluation RÉTROACTIVE des cartes existantes : bilan AVANT /
 *     APRÈS par règle, issues (conservées, résolues, différées, retirées,
 *     remplacées par l'action réelle, en erreur), détail par carte filtrable
 *     (compte, issue) ;
 *   · lance la RECETTE du corpus livré avec le véritable T4 et lit, cas par
 *     cas, le résultat attendu et obtenu (trace IA).
 *   · lot 76 (C7 / C8) : distingue « parcours terminé » et « campagne
 *     terminée sans erreur », suit les reprises (en attente, bloquantes,
 *     réussies) ; voit les décisions appliquées NON tracées (reprise
 *     identifiable) et les relance.
 *   · lot 83E (C-Q9) : les campagnes sont un HISTORIQUE en lecture seule — la
 *     réévaluation est faite par le contrôle de cohérence (COH-TODO-RELEVANCE-
 *     CARDS, COH-TODO-STALE-DECISIONS, campagne quotidienne `coherence-
 *     control`) ; plus de bouton « Relancer une campagne » ni de reprise.
 */
import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ListChecks, AlertTriangle, RefreshCw, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { apiClient } from '@/lib/api-client';

interface Campaign {
  id: number; code: string; status: string; trigger: string; engineVersion: string; startedAt: string; finishedAt: string | null;
  lastRunAt: string | null; runs: number; before: Record<string, number>; after: Record<string, number> | null;
  outcomes: Record<string, number>; errorSample: string | null;
  /** Lot 72 (C6) : bilan par règle, familles, phase, éléments restants, erreurs. */
  outcomesByRule?: Record<string, Record<string, number>>; families?: Record<string, string>; phase?: string | null;
  remaining?: { cards: number; decisions: number } | null; errorItems?: number;
  /** Lot 76 (C7) : fin du parcours, périmètre, reprises, erreurs en attente / bloquantes / reprises avec succès. */
  traversalFinishedAt?: string | null; scope?: Record<string, unknown> | null; retries?: number;
  errors?: { pending: number; blocking: number; recovered: number } | null;
}
interface TraceRetry {
  id: number; accountId: number; source: string; ruleCode: string; targetType: string | null; targetId: number | null; status: string;
  attempts: number; error: string | null; originalAt: string; resolvedAt: string | null;
  decision: { outcome: unknown; reason: unknown; effect: unknown; actionIds: unknown };
}
interface Item {
  actionId: number | null; accountId: number; fileId: number | null; ruleCode: string; kindBefore: string | null; outcome: string; reason: string | null; createdAt: string;
  targetType?: string; targetId?: number; phase?: string;
  /** Lot 76 (C7) : issue après reprise, traitements, première / dernière erreur. */
  finalOutcome?: string | null; attempts?: number; firstError?: string | null; lastError?: string | null;
}
interface RecetteResult {
  caseId: string; label: string; ok: boolean; expected: { outcomes: string[]; card?: string | null; kinds?: string[]; never?: string[] };
  obtained: { outcome: string | null; card: string | null; kind: string | null; pertinence: string | null; derivation?: string | null; action?: string | null };
  aiCalled: boolean; aiStatus: string | null; traceId: string | null; reason: string; problems: string[];
  /** Lot 75I (F) : nature de la sortie IA, justification, avertissements du contrôle serveur. */
  aiOutput?: 'VALID' | 'AMBIGUOUS' | 'INCOHERENT' | 'ERROR' | null; justification?: string | null; warnings?: string[];
}
const SORTIE_IA: Record<string, string> = { VALID: 'valide', AMBIGUOUS: 'ambiguë', INCOHERENT: 'incohérente', ERROR: 'en erreur' };
interface RecetteRun {
  id: number; status: string; configRef: string | null; total: number; passed: number; failed: number; aiCalls: number;
  results: RecetteResult[]; error: string | null; startedAt: string; finishedAt: string | null;
  aiOutputs?: Record<string, number>;
}
interface Data {
  config: {
    ref: string; interventionCapable: boolean;
    /** Lot 72 (C3) : suivi des révisions sauvegardées de la version T4 active. */
    revisionTracked?: boolean; contentHash?: string | null;
    /** Lot 63 : seuils « À traiter » effectifs (BO › Configuration IA › Réglages). */
    thresholds?: { futureHorizonDays: number; historicalYears: number; deferUncertainDays: number; deferUndatedDays: number; deferTitleOnlyDays: number };
  };
  engineVersion: string;
  migrations: { decisions0444: boolean; campaigns0445: boolean; recette0446: boolean; ecarts0516?: boolean; campagne0517?: boolean; reprise0581?: boolean; traces0582?: boolean };
  campaigns: Campaign[]; items: Item[];
  recetteCases: Array<{ id: string; label: string; deterministic: boolean }>;
  recetteRuns: RecetteRun[];
  /** Lot 75I (D) : décisions en attente d'une configuration T4 compatible (dernière décision par document et règle). */
  incompatibleDecisions?: number;
  /** Lot 76 (C8) : décisions appliquées dont la trace a échoué (reprise 0582). */
  traceRetries?: { available: boolean; counts: Record<string, number>; items: TraceRetry[] };
}

const STATUT_CAMPAGNE: Record<string, string> = {
  DONE: 'terminée sans erreur', RUNNING: 'en cours', DONE_WITH_ERRORS: 'parcours terminé — erreurs maintenues bloquantes', ERROR: 'en erreur',
  SUPERSEDED: 'close — remplacée par le contrôle de cohérence (lot 83E)',
};
const STATUT_TRACE: Record<string, string> = { PENDING: 'à reprendre', REPLAYED: 'trace écrite après reprise', SUPERSEDED: 'remplacée par une décision plus récente', ABANDONED: 'reprises épuisées' };

const ISSUE_LABEL: Record<string, string> = {
  KEPT: 'conservées', AUTO_RESOLVED: 'résolues automatiquement', DEFERRED: 'différées', REMOVED: 'retirées (sans pertinence)',
  REPLACED_BY_INTERVENTION: 'remplacées par l’action réelle', RESOLVED_ELSEWHERE: 'résolues ailleurs', ERROR: 'en erreur', examined: 'examinées',
  NO_CARD: 'décision sans carte confirmée', CREATED: 'carte devenue justifiée',
};
const FAMILY_LABEL: Record<string, string> = { DOCUMENT: 'Documents', AGENDA_ITEM: 'Agenda', EQUIPMENT: 'Équipements', SUPPLIER: 'Fournisseurs' };
const TARGET_LABEL: Record<string, string> = { DOCUMENT: 'document', AGENDA_ITEM: 'événement', EQUIPMENT: 'équipement', SUPPLIER: 'fournisseur' };
const dt = (v: string | null) => (v ? new Date(v).toLocaleString('fr-FR') : '—');
const kv = (o: Record<string, number> | null | undefined, labels: Record<string, string> = {}) =>
  (o && Object.keys(o).length ? Object.entries(o).map(([k, v]) => `${labels[k] ?? k} ${v}`).join(' · ') : '—');
const total = (o: Record<string, number> | null | undefined) => (o ? Object.values(o).reduce((a, b) => a + b, 0) : 0);

function CampaignBlock({ c }: { c: Campaign }) {
  return (
    <div className="rounded-lg border border-[color:var(--border-subtle)] p-3 space-y-1 min-w-0">
      <p className="text-xs text-[color:var(--text-secondary)] break-words">
        Campagne {c.code} · {STATUT_CAMPAGNE[c.status] ?? c.status}{c.status === 'RUNNING' && c.phase === 'RETRY' ? ' (reprise des erreurs)' : ''} · {c.trigger}
        {' · '}{dt(c.startedAt)} → {dt(c.finishedAt ?? c.lastRunAt)} · {c.runs} passage(s) · moteur {c.engineVersion}
      </p>
      <p className="text-xs break-words">
        <span className="text-[color:var(--text-secondary)]">Cartes actives AVANT : </span>
        <span className="text-[color:var(--text-muted)]">{total(c.before)} ({kv(c.before)})</span>
      </p>
      <p className="text-xs break-words">
        <span className="text-[color:var(--text-secondary)]">Cartes actives APRÈS : </span>
        <span className="text-[color:var(--text-muted)]">{c.after ? `${total(c.after)} (${kv(c.after)})` : 'campagne en cours'}</span>
      </p>
      <p className="text-xs break-words">
        <span className="text-[color:var(--text-secondary)]">Issues : </span>
        <span className="text-[color:var(--text-muted)]">{kv(c.outcomes, ISSUE_LABEL)}</span>
      </p>
      {c.outcomesByRule && Object.keys(c.outcomesByRule).length > 0 && (
        <ul className="grid gap-1 sm:grid-cols-2">
          {Object.entries(c.outcomesByRule).map(([regle, issues]) => (
            <li key={regle} className="text-xs break-words">
              <span className="text-[color:var(--text-secondary)]">{FAMILY_LABEL[c.families?.[regle] ?? ''] ?? c.families?.[regle] ?? '—'} · {regle} : </span>
              <span className="text-[color:var(--text-muted)]">{kv(issues, ISSUE_LABEL)}</span>
            </li>
          ))}
        </ul>
      )}
      {(c.remaining || (c.errorItems ?? 0) > 0) && (
        <p className="text-xs break-words">
          <span className="text-[color:var(--text-secondary)]">Reste à traiter : </span>
          <span className="text-[color:var(--text-muted)]">
            {c.remaining ? `${c.remaining.cards} carte(s)${c.phase === 'DECISIONS' ? ' · phase décisions sans carte en cours' : ''}` : 'rien'}
          </span>
          {(c.errorItems ?? 0) > 0 && <span className="text-[color:var(--text-danger)]"> · {c.errorItems} élément(s) en erreur (filtrer l’issue ERROR)</span>}
        </p>
      )}
      {(c.traversalFinishedAt || c.errors) && (
        <p className="text-xs break-words" data-testid="campaign-retries">
          <span className="text-[color:var(--text-secondary)]">Parcours : </span>
          <span className="text-[color:var(--text-muted)]">{c.traversalFinishedAt ? `terminé le ${dt(c.traversalFinishedAt)}` : 'en cours'}{` · ${c.retries ?? 0} reprise(s)`}</span>
          {c.errors && (
            <span className={c.errors.blocking + c.errors.pending > 0 ? 'text-[color:var(--text-danger)]' : 'text-[color:var(--text-muted)]'}>
              {` · erreurs : ${c.errors.pending} en attente de reprise, ${c.errors.blocking} bloquante(s), ${c.errors.recovered} reprise(s) avec succès`}
            </span>
          )}
        </p>
      )}
      {c.errorSample && <p className="text-xs text-[color:var(--text-danger)] break-words">Exemple d’erreur : {c.errorSample}</p>}
    </div>
  );
}

function RecetteRow({ r }: { r: RecetteResult }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-lg border border-[color:var(--border-subtle)] p-2 min-w-0">
      <button type="button" className="w-full text-left flex items-start gap-2" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <ChevronDown className={`w-3.5 h-3.5 mt-0.5 shrink-0 transition-transform ${open ? '' : '-rotate-90'}`} />
        <span className="text-xs break-words min-w-0">
          <span className={r.ok ? 'text-[color:var(--text-success)]' : 'text-[color:var(--text-danger)]'}>{r.ok ? 'Conforme' : 'NON CONFORME'}</span>
          {' · '}<span className="font-medium text-[color:var(--text-primary)]">{r.caseId}</span> · {r.label}
        </span>
      </button>
      {open && (
        <dl className="mt-2 grid gap-x-3 gap-y-1 text-xs sm:grid-cols-2 break-words">
          {([
            ['Attendu', `${r.expected.outcomes.join(' | ') || '—'}${r.expected.card ? ` · carte ${r.expected.card}` : ''}${r.expected.kinds ? ` · ${r.expected.kinds.join(' | ')}` : ''}${r.expected.never?.length ? ` · jamais ${r.expected.never.join(', ')}` : ''}`],
            ['Obtenu', `${r.obtained.outcome ?? '—'}${r.obtained.card ? ` · carte ${r.obtained.card}` : ''}${r.obtained.kind ? ` · ${r.obtained.kind}` : ''}${r.obtained.derivation ? ` · calcul ${r.obtained.derivation}` : ''}`],
            ['Action formulée', r.obtained.action ?? '—'],
            ['Pertinence', r.obtained.pertinence ?? '—'],
            ['IA', r.aiCalled ? `t4_classify_event · ${r.aiStatus ?? '?'}${r.traceId ? ` · trace ${r.traceId}` : ''}` : 'aucun appel (décision du code)'],
            ['Sortie IA', r.aiOutput ? `${SORTIE_IA[r.aiOutput] ?? r.aiOutput}${r.warnings?.length ? ` · ${r.warnings.join(', ')}` : ''}` : '—'],
            ['Justification T4', r.justification ?? '—'],
            ['Motif', r.reason],
            ['Écarts', r.problems.length ? r.problems.join(' ; ') : '—'],
          ] as Array<[string, string]>).map(([k, v]) => (
            <div key={k} className="min-w-0">
              <dt className="text-[color:var(--text-secondary)]">{k}</dt>
              <dd className="text-[color:var(--text-muted)]">{v}</dd>
            </div>
          ))}
        </dl>
      )}
    </li>
  );
}

export function ToProcessRelevancePanel() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filters, setFilters] = useState({ accountId: '', outcome: '' });

  const charger = useCallback(async (f = filters) => {
    setError(null);
    try {
      const q = new URLSearchParams(Object.entries(f).filter(([, v]) => v.trim() !== ''));
      setData(await apiClient.get<Data>(`/api/admin/ai/queue/to-process-relevance?${q.toString()}`));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [filters]);
  useEffect(() => { void charger(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const lancer = async (action: 'recette' | 'retry-traces') => {
    setBusy(true);
    setError(null);
    try {
      await apiClient.post(`/api/admin/ai/queue/to-process-relevance`, { action });
      await charger();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const recette = data?.recetteRuns[0] ?? null;
  return (
    <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <ListChecks className="w-4 h-4 text-[color:var(--text-muted)] shrink-0" />
        <h2 className="vb-app-section">Pertinence des « À traiter »</h2>
        <Button type="button" size="sm" variant="outline" className="ml-auto h-8" onClick={() => void charger()} disabled={busy}>
          <RefreshCw className="w-3.5 h-3.5 mr-1" />Actualiser
        </Button>
      </div>
      {error && <p className="text-xs text-[color:var(--text-danger)] break-words flex items-start gap-1.5"><AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />{error}</p>}
      {data && (
        <>
          <p className="text-xs break-words">
            <span className="text-[color:var(--text-secondary)]">Configuration T4 : </span>
            <span className="text-[color:var(--text-muted)]">{data.config.ref} · moteur {data.engineVersion} · </span>
            <span className={data.config.interventionCapable ? 'text-[color:var(--text-success)]' : 'text-[color:var(--text-warning-soft)]'}>
              {data.config.interventionCapable
                ? 'évaluation structurée de l’intervention active (t4_output_v3)'
                : 'version active SANS t4_output_v3 : aucune question ni carte par défaut, décisions différées et signalées (contrat incompatible). Activer la version de référence dans Prompts maîtres › T4 : elles seront réévaluées automatiquement.'}
            </span>
            {!!data.incompatibleDecisions && (
              <span className="text-[color:var(--text-warning-soft)]"> · {data.incompatibleDecisions} décision(s) en attente d’une configuration T4 compatible.</span>
            )}
            {data.config.revisionTracked === false && (
              <span className="text-[color:var(--text-warning-soft)]"> · révisions sauvegardées de la version active NON suivies (migration 0516 absente) : seul un changement de version invalide les décisions IA.</span>
            )}
          </p>
          {data.config.thresholds && (
            <p className="text-xs break-words" data-testid="to-process-thresholds">
              <span className="text-[color:var(--text-secondary)]">Seuils (Configuration IA › Réglages) : </span>
              <span className="text-[color:var(--text-muted)]">
                horizon {data.config.thresholds.futureHorizonDays} j · historique {data.config.thresholds.historicalYears} ans · réévaluation
                {' '}incertaine {data.config.thresholds.deferUncertainDays} j / sans date {data.config.thresholds.deferUndatedDays} j / titre seul {data.config.thresholds.deferTitleOnlyDays} j
              </span>
            </p>
          )}
          {(data.migrations.reprise0581 === false || data.migrations.traces0582 === false) && (
            <p className="text-xs text-[color:var(--text-warning-soft)] break-words">
              Migrations lot 76 : reprise des erreurs de campagne {data.migrations.reprise0581 === false ? 'ABSENTE (0581) : erreurs consignées sans reprise automatique' : 'présente'}
              {' · '}reprise des traces {data.migrations.traces0582 === false ? 'ABSENTE (0582) : échecs de trace visibles au bilan des balayages seulement' : 'présente'}.
            </p>
          )}
          {(!data.migrations.decisions0444 || !data.migrations.campaigns0445 || !data.migrations.recette0446 || data.migrations.ecarts0516 === false || data.migrations.campagne0517 === false) && (
            <p className="text-xs text-[color:var(--text-warning-soft)] break-words">
              Migrations : décisions {data.migrations.decisions0444 ? 'présentes' : 'ABSENTES (0444)'} · campagnes {data.migrations.campaigns0445 ? 'présentes' : 'ABSENTES (0445)'} · recette {data.migrations.recette0446 ? 'présente' : 'ABSENTE (0446)'}
              {' · '}traçabilité lot 72 {data.migrations.ecarts0516 === false ? 'ABSENTE (0516)' : 'présente'} · campagne multi-familles {data.migrations.campagne0517 === false ? 'ABSENTE (0517) : cartes documentaires seules' : 'présente'}.
            </p>
          )}

          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-xs text-[color:var(--text-secondary)]">Historique des campagnes de réévaluation rétroactive (lecture seule)</p>
            </div>
            <p className="text-xs text-[color:var(--text-muted)] break-words">
              Depuis le lot 83E, la pertinence des cartes existantes et des décisions sans carte est vérifiée chaque jour par le contrôle de cohérence
              (tâche « coherence-control ») ; les cas non résolus remontent dans Supervision.
            </p>
            {data.campaigns.length === 0 && <p className="text-xs text-[color:var(--text-muted)]">Aucune campagne historique.</p>}
            {data.campaigns.slice(0, 3).map((c) => (
              <div key={c.id} className="space-y-1">
                <CampaignBlock c={c} />
              </div>
            ))}
            <form className="grid gap-2 grid-cols-2 sm:grid-cols-4" onSubmit={(e) => { e.preventDefault(); void charger(filters); }}>
              <Input value={filters.accountId} placeholder="Compte" aria-label="Compte" className="h-8 text-xs"
                onChange={(e) => setFilters((f) => ({ ...f, accountId: e.target.value }))} />
              <Input value={filters.outcome} placeholder="Issue (ex. DEFERRED)" aria-label="Issue" className="h-8 text-xs"
                onChange={(e) => setFilters((f) => ({ ...f, outcome: e.target.value.toUpperCase() }))} />
              <Button type="submit" size="sm" disabled={busy}>Filtrer</Button>
            </form>
            {data.items.length > 0 && (
              <ul className="space-y-1">
                {data.items.map((i) => (
                  <li key={`${i.actionId ?? 'd'}-${i.targetType ?? 'DOCUMENT'}-${i.targetId ?? i.fileId}-${i.ruleCode}`} className="text-xs break-words rounded border border-[color:var(--border-subtle)] px-2 py-1">
                    <span className="text-[color:var(--text-primary)]">{i.actionId ? `Action #${i.actionId}` : 'Décision sans carte'}</span> · compte {i.accountId} · {TARGET_LABEL[i.targetType ?? 'DOCUMENT'] ?? i.targetType} {i.targetId ?? i.fileId} · {i.ruleCode}
                    {' · '}<span className={(i.finalOutcome ?? i.outcome) === 'ERROR' ? 'text-[color:var(--text-danger)]' : 'text-[color:var(--text-secondary)]'}>{ISSUE_LABEL[i.finalOutcome ?? i.outcome] ?? (i.finalOutcome ?? i.outcome)}</span>
                    {i.finalOutcome && i.finalOutcome !== i.outcome ? <span className="text-[color:var(--text-muted)]"> (après {Math.max(0, (i.attempts ?? 1) - 1)} reprise(s) ; initialement {ISSUE_LABEL[i.outcome] ?? i.outcome})</span> : null}
                    {i.reason ? <span className="text-[color:var(--text-muted)]"> — {i.lastError ?? i.reason}</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {data.traceRetries && (
            <div className="space-y-2" data-testid="trace-retries">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-xs text-[color:var(--text-secondary)]">
                  Décisions appliquées dont la trace a échoué
                  {data.traceRetries.available ? ` : ${kv(data.traceRetries.counts, STATUT_TRACE)}` : ' : suivi indisponible (migration 0582 absente) — les échecs restent au bilan des balayages'}
                </p>
                {(data.traceRetries.counts.ABANDONED ?? 0) > 0 && (
                  <Button type="button" size="sm" variant="outline" className="h-8" disabled={busy} onClick={() => void lancer('retry-traces')}>
                    <RefreshCw className="w-3.5 h-3.5 mr-1" />Relancer les reprises
                  </Button>
                )}
              </div>
              {data.traceRetries.items.filter((t) => t.status === 'PENDING' || t.status === 'ABANDONED').slice(0, 20).map((t) => (
                <p key={t.id} className="text-xs break-words rounded border border-[color:var(--border-subtle)] px-2 py-1">
                  <span className="text-[color:var(--text-primary)]">Reprise n° {t.id}</span> · compte {t.accountId} · {TARGET_LABEL[t.targetType ?? ''] ?? t.targetType} {t.targetId ?? '—'} · {t.ruleCode}
                  {' · '}<span className="text-[color:var(--text-danger)]">{STATUT_TRACE[t.status] ?? t.status}</span> ({t.attempts} tentative(s)) · décision du {dt(t.originalAt)}
                  <span className="text-[color:var(--text-muted)]"> — issue {String(t.decision.outcome ?? '—')} · motif {String(t.decision.reason ?? '—')}{t.error ? ` — ${t.error}` : ''}</span>
                </p>
              ))}
            </div>
          )}

          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-xs text-[color:var(--text-secondary)]">Recette avec le véritable T4 ({data.recetteCases.length} cas)</p>
              <Button type="button" size="sm" className="h-8" disabled={busy || recette?.status === 'RUNNING'} onClick={() => void lancer('recette')}>
                <Play className="w-3.5 h-3.5 mr-1" />{recette?.status === 'RUNNING' ? 'Recette en cours…' : 'Lancer la recette T4 réelle'}
              </Button>
            </div>
            {!recette && <p className="text-xs text-[color:var(--text-muted)]">Aucune recette lancée. Les appels IA sont imputés au compte sélectionné.</p>}
            {recette && (
              <>
                <p className="text-xs break-words">
                  <span className={recette.failed === 0 && recette.status === 'DONE' ? 'text-[color:var(--text-success)]' : recette.status === 'RUNNING' ? 'text-[color:var(--text-secondary)]' : 'text-[color:var(--text-danger)]'}>
                    {recette.status === 'RUNNING' ? 'En cours' : recette.status === 'DONE' ? 'Terminée' : 'En erreur'}
                  </span>
                  <span className="text-[color:var(--text-muted)]">
                    {' · '}{recette.passed}/{recette.total} conformes · {recette.failed} non conformes · {recette.aiCalls} appel(s) IA · {recette.configRef ?? '—'} · {dt(recette.startedAt)}
                    {recette.aiOutputs ? ` · sorties IA : ${Object.entries(recette.aiOutputs).map(([k, n]) => `${SORTIE_IA[k] ?? k} ${n}`).join(', ')}` : ''}
                  </span>
                </p>
                {recette.error && <p className="text-xs text-[color:var(--text-danger)] break-words">{recette.error}</p>}
                <ul className="space-y-1.5">{recette.results.map((r) => <RecetteRow key={r.caseId} r={r} />)}</ul>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
