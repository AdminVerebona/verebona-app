'use client';

/**
 * Corpus de qualification — lot 100B (ticket 601 ; arbitrages PO A1, C2, C5).
 *
 * Section repliée de Configuration IA (écran existant) :
 *   · manifeste du corpus : un cas par carte, statut (RÉFÉRENCE_APPROUVÉE,
 *     GARDE_SERVEUR, E2E_MÉTIER, À_COMPLÉTER, HISTORIQUE, REJETÉE) et motif ;
 *   · oracle lisible (faits obligatoires, faits absents, preuves, entités,
 *     décisions, abstention, sources, équivalences) et APPROBATION
 *     INDIVIDUELLE : sources vérifiées cochées, un cas à la fois — aucune
 *     sélection multiple, aucune approbation en masse ; révocation et rejet
 *     motivés (aucune suppression) ;
 *   · verrou A1 par traitement (promotion automatique autorisée / manques),
 *     matrice de couverture par opération active, vue T2 « recherche de
 *     l'assistant » (CDC 4 §35 : précision mesurée, couverture suffisante ou
 *     non) ;
 *   · exclusions motivées, coûts mesurés (fournisseur / cache), tests de
 *     mutation, imports ; export JSON / CSV.
 * Cartes empilées : desktop (2 colonnes) et mobile (1 colonne), aucune table à
 * défilement horizontal ; boutons ≥ 44 px en mobile.
 */
import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, Download, RefreshCw, ShieldAlert, ShieldCheck, Undo2, XCircle } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { formatDateTime } from '@/lib/admin/format';
import { Button } from '@/components/ui/button';

type Status = 'REFERENCE_APPROUVEE' | 'GARDE_SERVEUR' | 'E2E_METIER' | 'A_COMPLETER' | 'HISTORIQUE' | 'REJETEE';
interface OracleFact { key: string; kind: string; value: unknown; unit?: string | null; critical: boolean; evidenceRequired: boolean; entity?: string | null; evidence: Array<{ source: string; excerpt?: string | null }> }
interface Oracle {
  version: number; requiredFacts: OracleFact[]; absentFacts: Array<{ key: string; kind: string; value: unknown; reason?: string }>;
  entities: { expected: unknown[]; forbidden: unknown[] }; decisions: { allowed: string[]; forbidden: string[] };
  abstention: { expected: string; criteria?: string | null }; allowedSources: string[]; equivalences: Array<{ key: string; values: unknown[] }>;
  serverExpected?: Record<string, unknown> | null; notes?: string | null;
}
interface Entry {
  id: string; sourceCaseId: string | null; file: string | null; operationCode: string | null; treatment: string | null; contract: string | null;
  riskFamily: string | null; riskLabel: string | null; difficulty: string | null; critical: boolean; pair: { id: string; side: string; discriminantChangesDecision: boolean } | null;
  provenance: string; inputMode: string; testType: string; evaluationType: string; status: Status; statusLabel: string; reason: string;
  historicalClassLabel: string | null; cdc35Category: string | null; oracle: Oracle | null; oracleFingerprint: string | null;
  approvalProblems: string[]; approvable: boolean; sourceChoices: string[]; requiredSources: string[];
  approval: { by: string; at: string; sources: string[] } | null; staleApproval: { by: string; at: string } | null;
  history: Array<{ decision: string; at: string; by: string; sources: string[]; comment: string | null; channel: string }>;
  expectedSummary: string | null; result: { outcome: string } | null;
}
interface Overview {
  readAt: string; environment: string;
  manifest: { version: number; generatedAt: string; reference: { ticket: string; announcedScenarios: number; announcedStress: number; zipReceived: boolean }; entries: number };
  activeOperations: Array<{ operationCode: string; treatment: string }>;
  counts: Record<string, number>; countsByClass: Record<string, number>;
  matrix: { operations: Array<{ treatment: string; operationCode: string; label: string; total: number; approvedReferences: number; critical: number; criticalApproved: number; guards: number; e2e: number; toComplete: number; excluded: number; covered: boolean }>; risks: Array<{ treatment: string; riskFamily: string; label: string; approvedReferences: number; required: boolean }> };
  a1: Array<{ treatment: string; allowed: boolean; blockers: Array<{ code: string; message: string }>; byCode: Array<{ code: string; label: string; n: number }> }>;
  t2: { target: number; minPerCategory: number; categories: Array<{ code: string; label: string; total: number; approved: number; executed: number; passed: number; failed: number }>; precision: { measured: number | null; passed: number; concluded: number; inconclusive: number }; verdict: string; gaps: string[] };
  exclusions: Array<{ id: string; operationCode: string | null; status: string; reason: string }>;
  costs: Array<{ campaignId: number; kind: string; operationCode: string; model: string; calls: number; cacheHits: number; providerCostMicros: number | null; unknownCost: number; attempts: number }>;
  mutations: { reports: number; applicable: number; ok: number; failures: Array<{ caseId: string; fact: string; label: string; detail: string }> };
  imports: Array<{ file: string; at: string; source: string; totals: Record<string, number> }>;
  entries: Entry[];
}

const TONE: Record<string, string> = {
  ok: 'bg-[color:var(--bg-success)] text-[color:var(--text-success)] border-[color:var(--border-success)]',
  ko: 'bg-[color:var(--bg-danger)] text-[color:var(--text-danger)] border-[color:var(--border-danger)]',
  warn: 'bg-[color:var(--bg-warning)] text-[color:var(--text-warning)] border-[color:var(--border-warning)]',
  muted: 'bg-[color:var(--bg-page)] text-[color:var(--text-muted)] border-[color:var(--border-subtle)]',
  info: 'bg-[color:var(--accent-soft)] text-[color:var(--text-primary)] border-[color:var(--border-subtle)]',
};
const STATUS_TONE: Record<Status, string> = {
  REFERENCE_APPROUVEE: TONE.ok, GARDE_SERVEUR: TONE.info, E2E_METIER: TONE.info, A_COMPLETER: TONE.warn, HISTORIQUE: TONE.muted, REJETEE: TONE.ko,
};
const val = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
const euros = (micros: number | null) => (micros == null ? 'inconnu' : `${(micros / 1_000_000).toFixed(4)} $`);
const canal = (): 'mobile' | 'desktop' => (typeof window !== 'undefined' && window.matchMedia?.('(max-width: 640px)').matches ? 'mobile' : 'desktop');

function OracleView({ o }: { o: Oracle }) {
  return (
    <div className="space-y-1 text-xs text-[color:var(--text-secondary)] break-words">
      <p className="font-medium text-[color:var(--text-primary)]">Oracle v{o.version}</p>
      {o.requiredFacts.length > 0 && (
        <ul className="list-disc pl-4 space-y-0.5">
          {o.requiredFacts.map((f) => (
            <li key={f.key}>
              <span className="font-medium">{f.key}</span> ({f.kind}{f.critical ? ', critique' : ''}{f.evidenceRequired ? ', preuve exigée' : ''}) = {val(f.value)}{f.unit ? ` ${f.unit}` : ''}
              {f.entity ? ` · rattaché à ${f.entity}` : ''}
              {f.evidence.length > 0 && <span className="block text-[color:var(--text-muted)]">Preuve : {f.evidence.map((e) => `${e.source}${e.excerpt ? ` « ${e.excerpt} »` : ''}`).join(' ; ')}</span>}
            </li>
          ))}
        </ul>
      )}
      {o.absentFacts.length > 0 && <p>Jamais présent : {o.absentFacts.map((a) => `${a.key} = ${val(a.value)}`).join(' ; ')}</p>}
      {(o.entities.expected.length > 0 || o.entities.forbidden.length > 0) && <p>Entités attendues : {o.entities.expected.map(val).join(', ') || '—'} · interdites : {o.entities.forbidden.map(val).join(', ') || '—'}</p>}
      {(o.decisions.allowed.length > 0 || o.decisions.forbidden.length > 0) && <p>Décisions permises : {o.decisions.allowed.join(', ') || '—'} · interdites : {o.decisions.forbidden.join(', ') || '—'}</p>}
      <p>Abstention : {o.abstention.expected === 'ANSWER' ? 'interdite (réponse fiable attendue)' : o.abstention.expected === 'ABSTAIN' ? 'attendue' : 'non contrainte'}{o.abstention.criteria ? ` — ${o.abstention.criteria}` : ''}</p>
      {o.allowedSources.length > 0 && <p>Sources autorisées : {o.allowedSources.join(', ')}</p>}
      {o.equivalences.length > 0 && <p>Équivalences tolérées : {o.equivalences.map((e) => `${e.key} ≈ ${e.values.map(val).join(' | ')}`).join(' ; ')}</p>}
      {o.serverExpected && <p>Contrôle serveur attendu : <code className="break-all">{JSON.stringify(o.serverExpected).slice(0, 400)}</code></p>}
      {o.notes && <p className="text-[color:var(--text-muted)]">{o.notes}</p>}
    </div>
  );
}

function CaseCard({ e, busy, onAct }: { e: Entry; busy: boolean; onAct: (a: { action: string; e: Entry; sources?: string[]; comment?: string; reason?: string }) => void }) {
  const [sources, setSources] = useState<string[]>([]);
  const [comment, setComment] = useState('');
  const [reason, setReason] = useState('');
  const toutes = sources.length > 0 && e.requiredSources.every((s) => sources.includes(s));
  return (
    <details data-testid="corpus-case" className="rounded-lg border border-[color:var(--border-subtle)] p-3 min-w-0">
      <summary className="cursor-pointer list-none space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`text-xs px-2 py-0.5 rounded-full border ${STATUS_TONE[e.status]}`}>{e.statusLabel}</span>
          {e.critical && <span className={`text-xs px-2 py-0.5 rounded-full border ${TONE.warn}`}>critique</span>}
          {e.pair && <span className={`text-xs px-2 py-0.5 rounded-full border ${TONE.info}`}>paire {e.pair.id} · {e.pair.side}</span>}
          {e.result && <span className={`text-xs px-2 py-0.5 rounded-full border ${e.result.outcome === 'PASSED' ? TONE.ok : e.result.outcome === 'FAILED' ? TONE.ko : TONE.warn}`}>{e.result.outcome === 'PASSED' ? 'réussi' : e.result.outcome === 'FAILED' ? 'échec' : 'non concluant'}</span>}
        </div>
        <p className="text-sm font-medium text-[color:var(--text-primary)] break-words">{e.id}{e.sourceCaseId && e.sourceCaseId !== e.id ? ` (${e.sourceCaseId})` : ''}</p>
        <p className="text-xs text-[color:var(--text-muted)] break-words">{e.treatment ?? '—'} · {e.operationCode ?? 'scénario'} · {e.riskLabel ?? 'risque non classé'} · {e.difficulty ?? '—'} · {e.inputMode === 'FILE' ? 'fichier réel' : e.inputMode === 'TEXT' ? 'texte extrait' : 'contexte structuré'}</p>
      </summary>
      <div className="mt-2 space-y-2">
        <p className="text-xs text-[color:var(--text-secondary)] break-words"><span className="font-medium">Motif : </span>{e.reason}</p>
        {e.historicalClassLabel && <p className="text-xs text-[color:var(--text-muted)]">Classement historique : {e.historicalClassLabel} · provenance {e.provenance}</p>}
        {e.contract && <p className="text-xs text-[color:var(--text-muted)]">Contrat de sortie : {e.contract}</p>}
        {e.oracle ? <OracleView o={e.oracle} /> : <p className="text-xs text-[color:var(--text-warning-soft)]">Aucun oracle : attendu à rédiger depuis les sources.</p>}
        {e.approval && <p className="text-xs text-[color:var(--text-success)] break-words">Approuvé par {e.approval.by} le {formatDateTime(e.approval.at)} — sources vérifiées : {e.approval.sources.join(' ; ')}</p>}
        {e.staleApproval && <p className="text-xs text-[color:var(--text-warning-soft)]">Approbation du {formatDateTime(e.staleApproval.at)} caduque : l’oracle a été modifié depuis.</p>}
        {e.approvalProblems.length > 0 && (
          <ul className="text-xs text-[color:var(--text-warning-soft)] list-disc pl-4">{e.approvalProblems.map((p, k) => <li key={k}>{p}</li>)}</ul>
        )}
        {e.approvable && e.status === 'A_COMPLETER' && (
          <div className="rounded-lg border border-[color:var(--border-subtle)] p-2 space-y-2" data-testid="corpus-approve">
            <p className="text-xs font-medium text-[color:var(--text-primary)]">Approuver CE cas — cochez les sources que vous avez relues (jamais la sortie d’un modèle)</p>
            {e.sourceChoices.map((s) => (
              <label key={s} className="flex items-start gap-2 text-xs text-[color:var(--text-secondary)] min-h-[44px] sm:min-h-0 break-all">
                <input type="checkbox" className="mt-0.5" checked={sources.includes(s)} onChange={(ev) => setSources((l) => (ev.target.checked ? [...l, s] : l.filter((x) => x !== s)))} />
                <span>{s}{e.requiredSources.includes(s) ? ' (obligatoire)' : ''}</span>
              </label>
            ))}
            <textarea className="w-full rounded border border-[color:var(--border-subtle)] bg-transparent p-2 text-xs" rows={2} placeholder="Commentaire (facultatif)" value={comment} onChange={(ev) => setComment(ev.target.value)} />
            <Button size="sm" className="min-h-[44px] sm:min-h-0 w-full sm:w-auto" disabled={busy || !toutes} onClick={() => onAct({ action: 'approve', e, sources, comment })}>
              <CheckCircle2 className="w-3.5 h-3.5 mr-1.5" /> Approuver l’oracle v{e.oracle?.version}
            </Button>
          </div>
        )}
        <div className="flex flex-col sm:flex-row gap-2">
          <input className="flex-1 min-w-0 rounded border border-[color:var(--border-subtle)] bg-transparent p-2 text-xs min-h-[44px] sm:min-h-0" placeholder="Motif (révocation, rejet, rétablissement)" value={reason} onChange={(ev) => setReason(ev.target.value)} />
          {e.status === 'REFERENCE_APPROUVEE' && <Button size="sm" variant="outline" className="min-h-[44px] sm:min-h-0" disabled={busy || reason.trim().length < 5} onClick={() => onAct({ action: 'revoke', e, reason })}><Undo2 className="w-3.5 h-3.5 mr-1.5" /> Révoquer</Button>}
          {e.status !== 'REJETEE'
            ? <Button size="sm" variant="ghost" className="min-h-[44px] sm:min-h-0" disabled={busy || reason.trim().length < 5} onClick={() => onAct({ action: 'reject', e, reason })}><XCircle className="w-3.5 h-3.5 mr-1.5" /> Rejeter</Button>
            : <Button size="sm" variant="ghost" className="min-h-[44px] sm:min-h-0" disabled={busy || reason.trim().length < 5} onClick={() => onAct({ action: 'restore', e, reason })}><Undo2 className="w-3.5 h-3.5 mr-1.5" /> Rétablir</Button>}
        </div>
        {e.history.length > 0 && (
          <ul className="text-xs text-[color:var(--text-muted)] space-y-0.5">
            {e.history.map((h, k) => <li key={k} className="break-words">{formatDateTime(h.at)} · {h.decision === 'APPROVED' ? 'approuvé' : 'révoqué'} par {h.by} ({h.channel}){h.comment ? ` — ${h.comment}` : ''}</li>)}
          </ul>
        )}
      </div>
    </details>
  );
}

export function CorpusCertification() {
  const [data, setData] = useState<Overview | null>(null);
  const [busy, setBusy] = useState(false);
  const [filtre, setFiltre] = useState<{ treatment: string; status: string; q: string }>({ treatment: '', status: 'A_COMPLETER', q: '' });
  const load = useCallback(async () => {
    try { setData(await apiClient.get<Overview>('/api/admin/ai/corpus', { policy: 'long' })); } catch { toast.error('Corpus de qualification indisponible.'); }
  }, []);
  const agir = async (a: { action: string; e: Entry; sources?: string[]; comment?: string; reason?: string }) => {
    setBusy(true);
    try {
      await apiClient.post('/api/admin/ai/corpus', {
        action: a.action, caseId: a.e.id, oracleFingerprint: a.e.oracleFingerprint, sources: a.sources, comment: a.comment, reason: a.reason, channel: canal(),
      });
      toast.success(a.action === 'approve' ? `${a.e.id} : oracle approuvé.` : a.action === 'revoke' ? `${a.e.id} : approbation révoquée.` : a.action === 'reject' ? `${a.e.id} : cas rejeté (conservé au manifeste).` : `${a.e.id} : cas rétabli.`);
      await load();
    } catch (e) {
      toast.error((e as { message?: string }).message ?? 'Action refusée.');
    } finally { setBusy(false); }
  };
  const visibles = useMemo(() => (data?.entries ?? []).filter((e) => (!filtre.treatment || e.treatment === filtre.treatment)
    && (!filtre.status || e.status === filtre.status) && (!filtre.q || `${e.id} ${e.sourceCaseId ?? ''} ${e.operationCode ?? ''}`.toLowerCase().includes(filtre.q.toLowerCase()))), [data, filtre]);
  return (
    <details className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)]" data-testid="corpus-certification"
      onToggle={(ev) => { if ((ev.target as HTMLDetailsElement).open && !data) void load(); }}>
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-[color:var(--text-primary)]">
        Corpus de qualification · références approuvées, couverture, verrou A1
        {data && <span className="ml-2 text-xs text-[color:var(--text-muted)]">• {data.counts.REFERENCE_APPROUVEE ?? 0} approuvée(s) sur {data.manifest.entries}</span>}
      </summary>
      {!data ? <p className="px-4 pb-4 text-sm text-[color:var(--text-muted)]">Chargement…</p> : (
        <div className="px-4 pb-4 space-y-4 min-w-0">
          <div className="flex flex-col sm:flex-row sm:items-center gap-2">
            <p className="flex-1 min-w-0 text-xs text-[color:var(--text-muted)] break-words">
              Manifeste v{data.manifest.version} · référence {data.manifest.reference.ticket} ({data.manifest.reference.announcedScenarios} scénarios + {data.manifest.reference.announcedStress} stress annoncés, {data.manifest.reference.zipReceived ? 'livraison importée' : 'livraison pas encore importée'}) · {data.activeOperations.length} opération(s) IA active(s) · lecture {formatDateTime(data.readAt)}.
            </p>
            <div className="flex flex-col sm:flex-row gap-2">
              <Button size="sm" variant="outline" className="min-h-[44px] sm:min-h-0" onClick={() => void load()}><RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Actualiser</Button>
              <a className="inline-flex items-center justify-center rounded-md border border-[color:var(--border-subtle)] px-3 text-xs min-h-[44px] sm:min-h-[32px]" href="/api/admin/ai/corpus/report?format=csv"><Download className="w-3.5 h-3.5 mr-1.5" /> CSV</a>
              <a className="inline-flex items-center justify-center rounded-md border border-[color:var(--border-subtle)] px-3 text-xs min-h-[44px] sm:min-h-[32px]" href="/api/admin/ai/corpus/report?format=json"><Download className="w-3.5 h-3.5 mr-1.5" /> JSON</a>
            </div>
          </div>
          <p className="text-xs text-[color:var(--text-secondary)] break-words">
            Une référence ne compte qu’après votre approbation, cas par cas, sur ses sources. Tant qu’une opération active, un risque critique ou une paire n’est pas couvert, aucune promotion automatique n’a lieu en préproduction ; l’activation manuelle d’un prompt reste possible et affiche ces manques.
          </p>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-2" data-testid="corpus-a1">
            {data.a1.map((a) => (
              <div key={a.treatment} className="rounded-lg border border-[color:var(--border-subtle)] p-3 text-xs space-y-1 min-w-0">
                <p className="flex items-center gap-2 font-medium text-[color:var(--text-primary)]">
                  {a.allowed ? <ShieldCheck className="w-4 h-4 text-[color:var(--text-success)]" /> : <ShieldAlert className="w-4 h-4 text-[color:var(--text-warning)]" />}
                  {a.treatment} · promotion automatique {a.allowed ? 'autorisée' : 'interdite'}
                </p>
                {a.byCode.map((b) => <p key={b.code} className="text-[color:var(--text-secondary)]">{b.label} : {b.n}</p>)}
                {a.blockers.length > 0 && (
                  <details><summary className="cursor-pointer text-[color:var(--text-muted)]">Détail des manques ({a.blockers.length})</summary>
                    <ul className="list-disc pl-4 mt-1 space-y-0.5">{a.blockers.slice(0, 40).map((b, k) => <li key={k} className="break-words">{b.message}</li>)}</ul>
                  </details>
                )}
              </div>
            ))}
          </div>

          <div className="rounded-lg border border-[color:var(--border-subtle)] p-3 text-xs space-y-1" data-testid="corpus-t2">
            <p className="font-medium text-[color:var(--text-primary)]">
              T2 · recherche de l’assistant (CDC 4 §35) : couverture {data.t2.verdict === 'SUFFISANTE' ? 'suffisante' : data.t2.verdict === 'NON_MESUREE' ? 'non mesurée' : 'insuffisante'}
            </p>
            <p className="text-[color:var(--text-secondary)]">
              Précision mesurée : {data.t2.precision.measured == null ? 'non mesurée' : `${(data.t2.precision.measured * 100).toFixed(1)} %`} ({data.t2.precision.passed}/{data.t2.precision.concluded} réponses justes) · objectif {data.t2.target * 100} % · {data.t2.minPerCategory} références approuvées par catégorie.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-1">
              {data.t2.categories.map((c) => <p key={c.code} className={c.approved >= data.t2.minPerCategory ? 'text-[color:var(--text-success)]' : 'text-[color:var(--text-warning-soft)]'}>{c.label} : {c.approved}/{data.t2.minPerCategory} ({c.total} au corpus)</p>)}
            </div>
            {data.t2.gaps.length > 0 && <ul className="list-disc pl-4 text-[color:var(--text-muted)]">{data.t2.gaps.slice(0, 12).map((g, k) => <li key={k} className="break-words">{g}</li>)}</ul>}
          </div>

          <details>
            <summary className="cursor-pointer text-xs text-[color:var(--text-secondary)]">Matrice de couverture par opération active ({data.matrix.operations.length})</summary>
            <div className="mt-2 grid grid-cols-1 lg:grid-cols-2 gap-2" data-testid="corpus-matrix">
              {data.matrix.operations.map((o) => (
                <div key={o.operationCode} className="rounded-lg border border-[color:var(--border-subtle)] p-2 text-xs space-y-0.5 min-w-0">
                  <p className="font-medium text-[color:var(--text-primary)] break-words">{o.treatment} · {o.operationCode} {o.covered ? '' : '— NON COUVERTE'}</p>
                  <p className="text-[color:var(--text-secondary)]">{o.total} cas · {o.approvedReferences} référence(s) approuvée(s) · critiques {o.criticalApproved}/{o.critical} · gardes {o.guards} · E2E {o.e2e} · à compléter {o.toComplete} · exclus {o.excluded}</p>
                </div>
              ))}
            </div>
            <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-1 text-xs">
              {data.matrix.risks.filter((r) => r.required).map((r) => <p key={`${r.treatment}${r.riskFamily}`} className={r.approvedReferences ? 'text-[color:var(--text-success)]' : 'text-[color:var(--text-warning-soft)]'}>{r.treatment} · {r.label} : {r.approvedReferences} référence(s)</p>)}
            </div>
          </details>

          <div className="space-y-2">
            <div className="flex flex-col sm:flex-row gap-2">
              <select className="rounded border border-[color:var(--border-subtle)] bg-transparent p-2 text-xs min-h-[44px] sm:min-h-0" value={filtre.treatment} onChange={(e) => setFiltre({ ...filtre, treatment: e.target.value })}>
                <option value="">Tous traitements</option>{['T1', 'T2', 'T3', 'T4', 'T6'].map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <select className="rounded border border-[color:var(--border-subtle)] bg-transparent p-2 text-xs min-h-[44px] sm:min-h-0" value={filtre.status} onChange={(e) => setFiltre({ ...filtre, status: e.target.value })}>
                <option value="">Tous statuts</option>
                {(['A_COMPLETER', 'REFERENCE_APPROUVEE', 'GARDE_SERVEUR', 'E2E_METIER', 'HISTORIQUE', 'REJETEE'] as const).map((s) => <option key={s} value={s}>{s.replace('_', ' ').toLowerCase()} ({data.counts[s] ?? 0})</option>)}
              </select>
              <input className="flex-1 min-w-0 rounded border border-[color:var(--border-subtle)] bg-transparent p-2 text-xs min-h-[44px] sm:min-h-0" placeholder="Rechercher un cas" value={filtre.q} onChange={(e) => setFiltre({ ...filtre, q: e.target.value })} />
            </div>
            <p className="text-xs text-[color:var(--text-muted)]">{visibles.length} cas affiché(s). Ouvrez un cas pour lire son oracle et l’approuver.</p>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
              {visibles.slice(0, 120).map((e) => <CaseCard key={e.id} e={e} busy={busy} onAct={(a) => void agir(a)} />)}
            </div>
          </div>

          <details>
            <summary className="cursor-pointer text-xs text-[color:var(--text-secondary)]">Exclusions motivées ({data.exclusions.length})</summary>
            <ul className="mt-2 space-y-1 text-xs text-[color:var(--text-secondary)]">{data.exclusions.map((x) => <li key={x.id} className="break-words"><span className="font-medium">{x.id}</span> · {x.status} · {x.reason}</li>)}</ul>
          </details>
          <details>
            <summary className="cursor-pointer text-xs text-[color:var(--text-secondary)]">Coûts mesurés par campagne et modèle ({data.costs.length})</summary>
            <div className="mt-2 grid grid-cols-1 lg:grid-cols-2 gap-2">
              {data.costs.map((c, k) => (
                <p key={k} className="rounded-lg border border-[color:var(--border-subtle)] p-2 text-xs text-[color:var(--text-secondary)] break-words">
                  Campagne {c.campaignId} ({c.kind}) · {c.operationCode} · {c.model} : {c.calls} appel(s), {c.attempts} essai(s), cache {c.cacheHits}, coût fournisseur {euros(c.providerCostMicros)}{c.unknownCost ? `, ${c.unknownCost} coût(s) inconnu(s)` : ''}
                </p>
              ))}
            </div>
          </details>
          <details>
            <summary className="cursor-pointer text-xs text-[color:var(--text-secondary)]">Tests de mutation des oracles : {data.mutations.ok}/{data.mutations.applicable} conformes ({data.mutations.reports} cas)</summary>
            <ul className="mt-2 space-y-1 text-xs text-[color:var(--text-warning-soft)]">{data.mutations.failures.map((f, k) => <li key={k} className="break-words">{f.caseId} · {f.fact} · {f.label} : {f.detail}</li>)}</ul>
          </details>
          <details>
            <summary className="cursor-pointer text-xs text-[color:var(--text-secondary)]">Imports de la livraison n° 601 ({data.imports.length})</summary>
            <ul className="mt-2 space-y-1 text-xs text-[color:var(--text-secondary)]">{data.imports.map((i) => <li key={i.file} className="break-words">{formatDateTime(i.at)} · {i.source} · {Object.entries(i.totals).map(([k, v]) => `${k} ${v}`).join(', ')}</li>)}</ul>
          </details>
        </div>
      )}
    </details>
  );
}
