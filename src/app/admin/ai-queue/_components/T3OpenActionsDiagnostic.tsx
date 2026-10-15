'use client';

/**
 * Diagnostic des « À traiter » T3 — lot 57B (ticket P0 « T3 — Corriger les À
 * traiter non résolus et fiabiliser les logs », §3 et §4).
 *
 * Une carte, une colonne sur mobile, filtres en grille à partir de `sm`,
 * composants et jetons existants seulement :
 *   · par exécution T3 GLOBALE : issue (réussite complète, partielle,
 *     abstention métier, échec technique), état de chaque phase, compteurs
 *     DISTINCTS (ouvertes au début, examinées, réellement retentées,
 *     résolues et fermées, maintenues, déléguées, en erreur), appels IA par
 *     opération, cartes par motif ;
 *   · par carte : parcours (résolveur, étapes, job délégué, sources T1,
 *     candidats, IA, décision, écriture vérifiée) et motif de non-résolution.
 * Filtres : compte, job, passage, document, règle, action, résultat — le PO
 * diagnostique un job (ex. 1751) sans SQL ni export à recouper.
 */
import { useCallback, useState } from 'react';
import { ChevronDown, Search, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { apiClient } from '@/lib/api-client';

interface Phase { status: string; error: string | null; counts?: Record<string, number> }
interface Run {
  runId: number; accountId: number; jobId: number | null; jobStatus: string | null; businessResult: string | null;
  triggerType: string; triggerCode: string | null; scope: string | null; status: string; outcome: string | null;
  startedAt: string | null; finishedAt: string | null; phases: Record<string, Phase> | null;
  counters: Record<string, number | null>; aiCallsByOperation: Record<string, number>; byReasonCode: Record<string, number>;
}
interface Card {
  id: number; createdAt: string; accountId: number; runId: number | null; jobId: number | null; actionId: number; ruleCode: string;
  targetType: string | null; targetId: number | null; resolver: string; evaluationMode: string; actionEffect: string; reasonCode: string | null;
  resolutionAttempted: boolean; deterministicAttempted: boolean; aiCalled: boolean; candidateCount: number | null;
  previousResolution: string | null; newResolution: string | null; note: string | null; triggerCode: string | null; durationMs: number | null;
  lastStep: string | null; failedStep: string | null; delegatedJobId: number | null; delegatedJobStatus: string | null;
  knowledgeSources: Record<string, number> | null; missingSources: string[] | null; candidateOrigins: Record<string, number> | null;
  aiOperation: string | null; aiTraceId: string | null; aiStatus: string | null; aiError: string | null; decision: string | null;
  confidence: number | null; writeAttempted: boolean | null; writeVerified: boolean | null;
}
interface RuleEval {
  id: number; createdAt: string; lastSeenAt: string; seenCount: number; accountId: number; fileId: number; ruleCode: string;
  fieldKey: string | null; trigger: string; runRef: string | null; engineVersion: string; targetPresent: boolean | null;
  userValidated: boolean | null; sources: Record<string, number>; missingSources: string[];
  observations: Array<{ source: string; key: string | null; raw: string | null; normalized: string | null; status: string }>;
  proposals: Array<{ value: string | null; confidence: number }>; titleHint: { dates: string[]; confirmed: string[] } | null;
  pertinence: string | null; pertinenceReason: string | null; aiOperation: string | null; aiTraceId: string | null; aiStatus: string | null;
  decision: string; reasonCode: string | null; actionId: number | null; writeVerified: boolean | null; error: string | null; failedStep: string | null;
}
interface Data {
  migrations: { journal0371: boolean; diagnostic0410: boolean; documentRules0418?: boolean };
  runs: Run[]; cards: Card[]; nextBefore: number | null; documentRules?: RuleEval[];
}

/** Lot 58B — règles documentaires (pont « À traiter ») : décision et pertinence. */
const DECISION_LABEL: Record<string, string> = {
  WRITE: 'valeur écrite', CREATE: 'carte créée', UPDATE: 'carte actualisée', KEEP: 'carte maintenue', CLOSE: 'carte fermée', NONE: 'aucune action', ERROR: 'EN ERREUR',
};
const PERTINENCE_LABEL: Record<string, string> = {
  NOT_EVALUATED: 'non évaluée (règle sans échéance)', FUTURE_OR_UNDATED: 'date future ou inconnue : question utile',
  ACTION_REQUIRED: 'échéance passée, action attendue', NO_ACTION_NEEDED: 'échéance historique, aucune intervention', UNDECIDED: 'indécise (question maintenue)',
};
const TRIGGER_LABEL: Record<string, string> = { ANALYSIS: 'analyse T1', SWEEP: 'balayage', T3: 'passage T3', USER: 'correction utilisateur' };

const OUTCOME_LABEL: Record<string, string> = {
  SUCCESS: 'Réussite complète', PARTIAL_SUCCESS: 'Réussite partielle', BUSINESS_ABSTENTION: 'Abstention métier (cartes à arbitrer)',
  TECHNICAL_FAILURE: 'Échec technique',
};
const PHASE_LABEL: Record<string, string> = {
  ASSETS: 'Biens', OPEN_KNOWLEDGE: 'Connaissance ouverte', OPEN_ACTIONS: '« À traiter » ouverts', JOURNAL: 'Journal par carte',
};
const PHASE_STATUS: Record<string, string> = {
  DONE: 'exécutée', PARTIAL: 'partielle', FAILED: 'EN ÉCHEC', NOT_RUN: 'NON EXÉCUTÉE', NOT_CONFIGURED: 'non configurée',
};
const COUNTERS: Array<[string, string]> = [
  ['openAtStart', 'ouvertes au début'], ['examined', 'examinées'], ['resolutionAttempted', 'résolutions tentées'],
  ['resolved', 'résolues et fermées'], ['keptAmbiguous', 'maintenues (arbitrage)'], ['delegated', 'déléguées / reportées'],
  ['errors', 'en erreur'], ['journaled', 'journalisées'],
];
const EFFECT_LABEL: Record<string, string> = {
  CLOSED: 'fermée', UPDATED: 'actualisée', STILL_OPEN: 'maintenue', SKIPPED_NOT_T3: 'hors T3', SUPERSEDED: 'remplacée / sans objet', ERROR: 'en erreur',
};

const dt = (v: string | null) => (v ? new Date(v).toLocaleString('fr-FR') : '—');
const kv = (o: Record<string, number> | null | undefined) => (o && Object.keys(o).length ? Object.entries(o).map(([k, v]) => `${k} ${v}`).join(', ') : '—');
const tone = (s: string) => (s === 'DONE' || s === 'SUCCESS' || s === 'CLOSED' ? 'text-emerald-500'
  : s === 'FAILED' || s === 'NOT_RUN' || s === 'TECHNICAL_FAILURE' || s === 'ERROR' ? 'text-red-400' : 'text-amber-500');

const FILTERS: Array<[keyof Filters, string]> = [
  ['accountId', 'Compte'], ['jobId', 'Job'], ['runId', 'Passage'], ['documentId', 'Document'], ['ruleCode', 'Règle'], ['actionId', 'Action'],
  ['result', 'Résultat / motif'],
];
type Filters = Record<'accountId' | 'jobId' | 'runId' | 'documentId' | 'ruleCode' | 'actionId' | 'result', string>;

function RunBlock({ run, onFilter }: { run: Run; onFilter: (f: Partial<Filters>) => void }) {
  return (
    <div className="rounded-lg border border-[color:var(--border-subtle)] p-3 space-y-1.5 min-w-0">
      <p className="text-xs text-[color:var(--text-secondary)] break-words">
        Passage #{run.runId} · compte {run.accountId}
        {run.jobId ? <> · job <button type="button" className="text-[color:var(--accent)] hover:underline" onClick={() => onFilter({ jobId: String(run.jobId) })}>#{run.jobId}</button> ({run.jobStatus ?? '?'}{run.businessResult ? ` / ${run.businessResult}` : ''})</> : ''}
        {' · '}{run.triggerCode ?? run.triggerType} · {dt(run.startedAt)} → {dt(run.finishedAt)}
      </p>
      <p className={`text-xs font-medium ${tone(run.outcome ?? '')}`}>
        {run.outcome ? OUTCOME_LABEL[run.outcome] ?? run.outcome : `Issue non tracée (passage antérieur au lot 57) — statut ${run.status}`}
      </p>
      {run.phases ? (
        <ul className="grid gap-1 sm:grid-cols-2">
          {Object.entries(run.phases).map(([n, ph]) => (
            <li key={n} className="text-xs break-words">
              <span className="text-[color:var(--text-secondary)]">{PHASE_LABEL[n] ?? n} : </span>
              <span className={tone(ph.status)}>{PHASE_STATUS[ph.status] ?? ph.status}</span>
              {ph.error ? <span className="text-[color:var(--text-muted)]"> — {ph.error}</span> : null}
            </li>
          ))}
        </ul>
      ) : <p className="text-xs text-amber-500">Phases non tracées (migration 0410 absente ou passage antérieur).</p>}
      <p className="text-xs text-[color:var(--text-muted)] break-words">
        {COUNTERS.map(([k, l]) => `${run.counters[k] ?? '—'} ${l}`).join(' · ')}
      </p>
      <p className="text-xs text-[color:var(--text-muted)] break-words">Appels IA par opération : {kv(run.aiCallsByOperation)}</p>
      <p className="text-xs text-[color:var(--text-muted)] break-words">
        Cartes par motif :{' '}
        {Object.keys(run.byReasonCode).length === 0 ? '—' : Object.entries(run.byReasonCode).map(([k, v], i) => (
          <span key={k}>{i > 0 ? ', ' : ''}<button type="button" className="text-[color:var(--accent)] hover:underline" onClick={() => onFilter({ runId: String(run.runId), result: k })}>{k}</button> {v}</span>
        ))}
      </p>
    </div>
  );
}

function CardRow({ c }: { c: Card }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-lg border border-[color:var(--border-subtle)] p-2 min-w-0">
      <button type="button" className="w-full text-left flex items-start gap-2" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <ChevronDown className={`w-3.5 h-3.5 mt-0.5 shrink-0 transition-transform ${open ? '' : '-rotate-90'}`} />
        <span className="text-xs break-words min-w-0">
          <span className="font-medium text-[color:var(--text-primary)]">Action #{c.actionId}</span> · {c.ruleCode} · {c.targetType ?? '?'} {c.targetId ?? ''}
          {' · '}<span className={tone(c.actionEffect)}>{EFFECT_LABEL[c.actionEffect] ?? c.actionEffect}</span>
          {c.reasonCode ? <span className="text-[color:var(--text-secondary)]"> — {c.reasonCode}</span> : null}
          <span className="text-[color:var(--text-muted)]"> · {dt(c.createdAt)}</span>
        </span>
      </button>
      {open && (
        <dl className="mt-2 grid gap-x-3 gap-y-1 text-xs sm:grid-cols-2 break-words">
          {([
            ['Passage / job', `#${c.runId ?? '—'} / #${c.jobId ?? '—'} · déclencheur ${c.triggerCode ?? '—'}`],
            ['Résolveur', `${c.resolver} · ${c.evaluationMode}`],
            ['Tentative réelle', c.resolutionAttempted ? 'oui' : 'non'],
            ['Étapes', `dernière réussie ${c.lastStep ?? '—'} · en échec ${c.failedStep ?? '—'} · durée ${c.durationMs ?? '—'} ms`],
            ['Job délégué', c.delegatedJobId ? `#${c.delegatedJobId} (${c.delegatedJobStatus ?? '?'})` : '—'],
            ['Sources T1 chargées', kv(c.knowledgeSources)],
            ['Sources absentes / en échec', c.missingSources?.length ? c.missingSources.join(', ') : '—'],
            ['Candidats', `${c.candidateCount ?? '—'} · origines ${kv(c.candidateOrigins)}`],
            ['IA', c.aiCalled ? `oui · ${c.aiOperation ?? '?'} · ${c.aiStatus ?? '?'}${c.aiTraceId ? ` · trace ${c.aiTraceId}` : ''}${c.aiError ? ` · ${c.aiError}` : ''}` : `non${c.aiStatus === 'ERROR' && c.aiError ? ` · ${c.aiError}` : ''}`],
            ['Décision', `${c.decision ?? '—'}${c.confidence != null ? ` (confiance ${c.confidence})` : ''}`],
            ['Écriture', c.writeAttempted == null ? '—' : `${c.writeAttempted ? 'tentée' : 'non tentée'}${c.writeVerified == null ? '' : c.writeVerified ? ' · vérifiée en base' : ' · NON vérifiée'}`],
            ['Résolution', `${c.previousResolution ?? '∅'} → ${c.newResolution ?? '∅'}${c.note ? ` · ${c.note}` : ''}`],
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

function RuleRow({ r }: { r: RuleEval }) {
  const [open, setOpen] = useState(false);
  const decisionTone = r.decision === 'ERROR' ? 'text-red-400' : r.decision === 'CLOSE' || r.decision === 'WRITE' || r.decision === 'NONE' ? 'text-emerald-500' : 'text-amber-500';
  return (
    <li className="rounded-lg border border-[color:var(--border-subtle)] p-2 min-w-0">
      <button type="button" className="w-full text-left flex items-start gap-2" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <ChevronDown className={`w-3.5 h-3.5 mt-0.5 shrink-0 transition-transform ${open ? '' : '-rotate-90'}`} />
        <span className="text-xs break-words min-w-0">
          <span className="font-medium text-[color:var(--text-primary)]">Document {r.fileId}</span> · {r.ruleCode}
          {' · '}<span className={decisionTone}>{DECISION_LABEL[r.decision] ?? r.decision}</span>
          {r.reasonCode ? <span className="text-[color:var(--text-secondary)]"> — {r.reasonCode}</span> : null}
          <span className="text-[color:var(--text-muted)]"> · {TRIGGER_LABEL[r.trigger] ?? r.trigger} · {dt(r.lastSeenAt)}{r.seenCount > 1 ? ` (×${r.seenCount})` : ''}</span>
        </span>
      </button>
      {open && (
        <dl className="mt-2 grid gap-x-3 gap-y-1 text-xs sm:grid-cols-2 break-words">
          {([
            ['Compte / exécution', `${r.accountId} · ${r.runRef ?? '—'} · version ${r.engineVersion}`],
            ['Champ cible', `${r.fieldKey ?? '—'} · ${r.targetPresent == null ? '?' : r.targetPresent ? 'présent' : 'absent'}${r.userValidated ? ' · choix utilisateur' : ''}`],
            ['Sources consultées', kv(r.sources)],
            ['Sources absentes / en échec', r.missingSources.length ? r.missingSources.join(', ') : '—'],
            ['Valeurs lues (normalisation)', r.observations.length ? r.observations.map((o) => `${o.source}${o.key ? `/${o.key}` : ''} « ${o.raw ?? ''} » → ${o.normalized ?? 'rejetée'} (${o.status})`).join(' ; ') : '—'],
            ['Propositions retenues', r.proposals.length ? r.proposals.map((p) => `${p.value} (${p.confidence})`).join(', ') : '—'],
            ['Indice du titre', r.titleHint ? `${r.titleHint.dates.join(', ') || '—'} · retrouvé dans le contenu : ${r.titleHint.confirmed.join(', ') || 'non'}` : '—'],
            ['Pertinence métier', r.pertinence ? `${PERTINENCE_LABEL[r.pertinence] ?? r.pertinence}${r.pertinenceReason ? ` · ${r.pertinenceReason}` : ''}` : '—'],
            ['IA', r.aiOperation ? `${r.aiOperation} · ${r.aiStatus ?? '?'}${r.aiTraceId ? ` · trace ${r.aiTraceId}` : ''}` : 'non'],
            ['Décision', `${DECISION_LABEL[r.decision] ?? r.decision}${r.actionId ? ` · action #${r.actionId}` : ''}${r.writeVerified == null ? '' : r.writeVerified ? ' · vérifiée en base' : ' · NON vérifiée'}`],
            ['Erreur', r.error ? `${r.error}${r.failedStep ? ` (étape ${r.failedStep})` : ''}` : '—'],
            ['Première / dernière évaluation', `${dt(r.createdAt)} → ${dt(r.lastSeenAt)}`],
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

export function T3OpenActionsDiagnostic({ initialJobId }: { initialJobId?: number | null }) {
  const vide: Filters = { accountId: '', jobId: initialJobId ? String(initialJobId) : '', runId: '', documentId: '', ruleCode: '', actionId: '', result: '' };
  const [filters, setFilters] = useState<Filters>(vide);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const charger = useCallback(async (f: Filters, before?: number | null) => {
    setLoading(true);
    setError(null);
    try {
      const q = new URLSearchParams(Object.entries(f).filter(([, v]) => v.trim() !== ''));
      if (before) q.set('before', String(before));
      const r = await apiClient.get<Data>(`/api/admin/ai/queue/t3-open-actions?${q.toString()}`);
      setData((prev) => (before && prev ? { ...r, runs: prev.runs, cards: [...prev.cards, ...r.cards] } : r));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  const filtrer = (p: Partial<Filters>) => { const f = { ...filters, ...p }; setFilters(f); void charger(f); };

  return (
    <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Search className="w-4 h-4 text-[color:var(--text-muted)] shrink-0" />
        <h2 className="text-sm font-semibold text-[color:var(--text-primary)]">Diagnostic des « À traiter » T3</h2>
      </div>
      <form className="grid gap-2 grid-cols-2 sm:grid-cols-4" onSubmit={(e) => { e.preventDefault(); void charger(filters); }}>
        {FILTERS.map(([k, label]) => (
          <Input key={k} value={filters[k]} placeholder={label} aria-label={label} className="h-8 text-xs"
            onChange={(e) => setFilters((f) => ({ ...f, [k]: e.target.value }))} />
        ))}
        <Button type="submit" size="sm" disabled={loading}>{loading ? 'Recherche…' : 'Rechercher'}</Button>
      </form>
      {error && <p className="text-xs text-red-400 break-words flex items-start gap-1.5"><AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />{error}</p>}
      {data && (
        <>
          {(!data.migrations.journal0371 || !data.migrations.diagnostic0410) && (
            <p className="text-xs text-amber-500 break-words">
              Journal par carte {data.migrations.journal0371 ? 'présent' : 'ABSENT (migration 0371)'} · détail du parcours {data.migrations.diagnostic0410 ? 'présent' : 'ABSENT (migration 0410)'}.
            </p>
          )}
          <div className="space-y-2">
            <p className="text-xs text-[color:var(--text-secondary)]">Exécutions T3 globales ({data.runs.length})</p>
            {data.runs.length === 0 && <p className="text-xs text-[color:var(--text-muted)]">Aucune exécution pour ces filtres.</p>}
            {data.runs.map((r) => <RunBlock key={r.runId} run={r} onFilter={filtrer} />)}
          </div>
          <div className="space-y-2">
            <p className="text-xs text-[color:var(--text-secondary)]">Cartes ({data.cards.length}{data.nextBefore ? '+' : ''})</p>
            {data.cards.length === 0 && <p className="text-xs text-[color:var(--text-muted)]">Aucune carte journalisée pour ces filtres.</p>}
            <ul className="space-y-1.5">{data.cards.map((c) => <CardRow key={c.id} c={c} />)}</ul>
            {data.nextBefore && (
              <Button type="button" size="sm" variant="outline" disabled={loading} onClick={() => void charger(filters, data.nextBefore)}>Afficher plus</Button>
            )}
          </div>
          {data.migrations.documentRules0418 === false && (
            <p className="text-xs text-amber-500 break-words">Diagnostic des règles documentaires ABSENT (migration 0418).</p>
          )}
          {data.documentRules && data.documentRules.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs text-[color:var(--text-secondary)]">Règles documentaires — dates, fournisseur ({data.documentRules.length})</p>
              <ul className="space-y-1.5">{data.documentRules.map((r) => <RuleRow key={r.id} r={r} />)}</ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
