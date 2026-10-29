'use client';

/**
 * Conformité des prompts — lot 99B (mise en conformité automatique des
 * prompts IA en préproduction, avec garantie de non-régression).
 *
 * Section repliée de Configuration IA (écran existant) :
 *   · une carte par incompatibilité entre un contrat IA du code et le prompt
 *     actif : contrat et prompt, cause, impact, nature (prompt / code /
 *     données), statut (détectée, correction en cours, tests, bloquée,
 *     activée, échec, retour arrière, résolue), occurrences regroupées,
 *     correction proposée ou appliquée (diff), couverture et résultats de la
 *     qualification, motifs précis de refus, rattrapage, anomalies
 *     résiduelles, journal ; « Nouvel essai » pour une incompatibilité
 *     bloquée, en échec ou annulée ;
 *   · « Vérifier maintenant » : passage immédiat (même service que la tâche
 *     planifiée) ;
 *   · registre des contrats exigés, avec leur état sur le prompt actif.
 * Cartes empilées : même composant en desktop (2 colonnes) et en mobile
 * (1 colonne), aucune table à défilement horizontal ; boutons ≥ 44 px.
 */
import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { RefreshCw, ShieldCheck, RotateCcw } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { formatDateTime } from '@/lib/admin/format';
import { Button } from '@/components/ui/button';

type Status = 'DETECTED' | 'CORRECTING' | 'TESTING' | 'BLOCKED' | 'ACTIVATED' | 'FAILED' | 'ROLLED_BACK' | 'RESOLVED';
interface Contract {
  id: string; treatment: string; label: string; lot: string; guideStep: number | null; version: string; task: string | null;
  operations: string[]; outputs: string[]; markers: string[]; validations: string[]; requires: string[]; blockIds: string[];
  expectedExecution: string | null; killSwitch: string | null; autoCorrectable: boolean; state: string; cause: string | null;
}
interface OperationResult {
  operationCode: string; referenceVerdict: string | null; candidateVerdict: string | null; decision: string;
  cases: { total: number; mandatory: number; verifiableMandatory: number; candidatePassed: number; referencePassed: number };
  regressions: string[]; inconclusive: string[]; defects: string[]; reasons: string[];
}
interface Issue {
  id: number; contractId: string; treatment: string; status: Status; statusLabel: string; faultLabel: string; defect: string;
  cause: string; impact: string; occurrences: number; firstDetectedAt: string; lastDetectedAt: string; decision: string | null;
  refusalReasons: string[]; activatedAt: string | null; watchUntil: string | null; rolledBackAt: string | null; resolvedAt: string | null;
  candidatePromptVersionId: number | null; candidateConfigVersionId: number | null; campaignId: number | null; retryRequestedAt: string | null;
  correction: { basedOnVersionNumber?: number; diff?: { added: number; removed: number; unified: string }; verification?: Array<{ message: string }> };
  qualification: { decision?: string | null; coverage?: { required: string | null; matchingCases: string[]; passed: string[]; ok: boolean } | null; operations?: OperationResult[]; refusal?: string | null };
  catchup: { summary?: Record<string, number>; decisions?: Array<{ objectType: string; objectId: number; field: string; decision: string; cause: string | null; proofs: number }>; error?: string };
  postCheck: { residualFindings?: number; after?: { total: number; invalid: number } };
  contract: Contract | null;
  events: Array<{ kind: string; message: string; at: string }>;
}
interface Overview { readAt: string; environment: string; mode: string; note: string; activationAllowed: boolean; registry: Contract[]; issues: Issue[] }

const TONE: Record<string, string> = {
  ok: 'bg-[color:var(--bg-success)] text-[color:var(--text-success)] border-[color:var(--border-success)]',
  ko: 'bg-[color:var(--bg-danger)] text-[color:var(--text-danger)] border-[color:var(--border-danger)]',
  warn: 'bg-[color:var(--bg-warning)] text-[color:var(--text-warning)] border-[color:var(--border-warning)]',
  info: 'bg-[color:var(--accent-soft)] text-[color:var(--text-primary)] border-[color:var(--border-subtle)]',
  muted: 'bg-[color:var(--bg-page)] text-[color:var(--text-muted)] border-[color:var(--border-subtle)]',
};
const STATUS_TONE: Record<Status, string> = {
  DETECTED: TONE.warn, CORRECTING: TONE.info, TESTING: TONE.info, BLOCKED: TONE.warn, ACTIVATED: TONE.ok, FAILED: TONE.ko, ROLLED_BACK: TONE.ko, RESOLVED: TONE.muted,
};
const STATE_LABEL: Record<string, string> = { SATISFIED: 'conforme', ABSENT: 'absent', OBSOLETE: 'obsolète', INCOMPLETE: 'incomplet', INCOMPATIBLE: 'incompatible', UNKNOWN: 'illisible' };
const VERDICT: Record<string, string> = { ADMISSIBLE: 'admissible', REFUSED: 'refusée', INCONCLUSIVE: 'non concluante', QUALIFIED: 'qualifiée' };

function Diff({ unified }: { unified: string }) {
  return (
    <pre className="text-[11px] leading-snug whitespace-pre-wrap break-words rounded-lg border border-[color:var(--border-subtle)] p-2 max-h-80 overflow-y-auto">
      {unified.split('\n').map((l, i) => (
        <span key={i} className={l.startsWith('+') ? 'block text-[color:var(--text-success)]' : l.startsWith('-') ? 'block text-[color:var(--text-danger)]' : l.startsWith('@@') ? 'block text-[color:var(--text-muted)]' : 'block text-[color:var(--text-secondary)]'}>{l || ' '}</span>
      ))}
    </pre>
  );
}

function IssueCard({ i, busy, onRetry }: { i: Issue; busy: boolean; onRetry: (i: Issue) => void }) {
  const q = i.qualification ?? {};
  const s = i.catchup?.summary;
  return (
    <div data-testid="conformity-issue" className="rounded-lg border border-[color:var(--border-subtle)] p-3 space-y-2 min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`text-xs px-2 py-0.5 rounded-full border ${STATUS_TONE[i.status]}`}>{i.statusLabel}</span>
        <span className="text-xs text-[color:var(--text-secondary)]">{i.treatment} · {i.faultLabel} · {i.occurrences} occurrence(s)</span>
      </div>
      <p className="text-sm font-medium text-[color:var(--text-primary)] break-words">{i.contract?.label ?? i.contractId}</p>
      <p className="text-xs text-[color:var(--text-muted)] break-words">Contrat <code>{i.contractId}</code>{i.contract?.guideStep ? ` · étape ${i.contract.guideStep} du guide` : ''}</p>
      <p className="text-xs text-[color:var(--text-secondary)] break-words"><span className="font-medium">Cause : </span>{i.cause}</p>
      <p className="text-xs text-[color:var(--text-secondary)] break-words"><span className="font-medium">Impact : </span>{i.impact}</p>
      {i.decision && <p className="text-xs text-[color:var(--text-primary)] break-words"><span className="font-medium">Décision : </span>{i.decision}</p>}
      {i.refusalReasons.length > 0 && (
        <ul className="text-xs text-[color:var(--text-warning-soft)] list-disc pl-4 space-y-0.5 break-words" data-testid="conformity-reasons">
          {i.refusalReasons.slice(0, 8).map((r, k) => <li key={k}>{r}</li>)}
        </ul>
      )}
      {i.correction?.diff && (
        <details>
          <summary className="cursor-pointer text-xs text-[color:var(--text-secondary)]">
            Correction {i.correction.basedOnVersionNumber ? `à partir de v${i.correction.basedOnVersionNumber}` : ''} : +{i.correction.diff.added} / −{i.correction.diff.removed} ligne(s)
          </summary>
          <div className="mt-2"><Diff unified={i.correction.diff.unified} /></div>
        </details>
      )}
      {q.operations && q.operations.length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs text-[color:var(--text-secondary)]">
            Qualification {q.decision ? `: ${VERDICT[q.decision] ?? q.decision}` : ''}{i.campaignId ? ` (campagne n° ${i.campaignId})` : ''}
            {q.coverage?.required ? ` · couverture ${q.coverage.ok ? 'suffisante' : 'insuffisante'}` : ''}
          </summary>
          <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
            {q.operations.map((o) => (
              <div key={o.operationCode} className="rounded-lg border border-[color:var(--border-subtle)] p-2 text-xs space-y-0.5 min-w-0">
                <p className="font-medium text-[color:var(--text-primary)] break-words">{o.operationCode}</p>
                <p className="text-[color:var(--text-secondary)]">Ancienne : {VERDICT[o.referenceVerdict ?? ''] ?? '—'} · candidate : {VERDICT[o.candidateVerdict ?? ''] ?? '—'}</p>
                <p className="text-[color:var(--text-secondary)]">Cas : {o.cases.candidatePassed}/{o.cases.total} réussis (ancienne {o.cases.referencePassed}) · obligatoires vérifiables {o.cases.verifiableMandatory}/{o.cases.mandatory}</p>
                {o.regressions.length > 0 && <p className="text-[color:var(--text-danger)] break-words">Régressions : {o.regressions.join(', ')}</p>}
                {o.reasons.slice(0, 3).map((r, k) => <p key={k} className="text-[color:var(--text-warning-soft)] break-words">{r}</p>)}
              </div>
            ))}
          </div>
        </details>
      )}
      {s && (
        <p className="text-xs text-[color:var(--text-secondary)] break-words" data-testid="conformity-catchup">
          Rattrapage : {s.objectsInFinding ?? 0} objet(s) en constat — {s.objectsWithWrite ?? 0} avec valeur(s) écrite(s) avec preuve, {s.objectsAbstainedOnly ?? 0} laissé(s) vide(s) avec abstention justifiée ({s.written ?? 0} propriété(s) écrite(s), {s.abstained ?? 0} abstention(s)) ; {s.residualFindings ?? 0} constat(s) résiduel(s).
        </p>
      )}
      {i.postCheck?.after && (
        <p className="text-xs text-[color:var(--text-muted)]">Après activation : {i.postCheck.after.invalid} sortie(s) refusée(s) sur {i.postCheck.after.total} appel(s).</p>
      )}
      <p className="text-xs text-[color:var(--text-muted)]">
        Détectée le {formatDateTime(i.firstDetectedAt)} · vue le {formatDateTime(i.lastDetectedAt)}
        {i.activatedAt ? ` · activée le ${formatDateTime(i.activatedAt)}` : ''}{i.rolledBackAt ? ` · annulée le ${formatDateTime(i.rolledBackAt)}` : ''}
      </p>
      {i.events.length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs text-[color:var(--text-secondary)]">Journal ({i.events.length})</summary>
          <ul className="mt-1 space-y-0.5">
            {i.events.map((e, k) => <li key={k} className="text-xs text-[color:var(--text-secondary)] break-words">{formatDateTime(e.at)} · {e.message}</li>)}
          </ul>
        </details>
      )}
      {['BLOCKED', 'FAILED', 'ROLLED_BACK'].includes(i.status) && (
        <Button size="sm" variant="ghost" className="min-h-[44px] sm:min-h-0" disabled={busy || Boolean(i.retryRequestedAt)} onClick={() => onRetry(i)}>
          <RotateCcw className="w-3.5 h-3.5 mr-1.5" /> {i.retryRequestedAt ? 'Nouvel essai demandé' : 'Nouvel essai'}
        </Button>
      )}
    </div>
  );
}

export function PromptConformity() {
  const [data, setData] = useState<Overview | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      setData(await apiClient.get<Overview>('/api/admin/ai/prompt-conformity'));
    } catch {
      toast.error('Conformité des prompts indisponible.');
    }
  }, []);
  const lancer = async () => {
    setBusy(true);
    try {
      await apiClient.post('/api/admin/ai/prompt-conformity', { action: 'run' });
      toast.success('Vérification lancée : détection, puis au plus une correction qualifiée. Actualisez dans quelques minutes.');
    } catch (e) {
      toast.error((e as { message?: string }).message ?? 'Vérification impossible.');
    } finally {
      setBusy(false);
    }
  };
  const relancer = async (i: Issue) => {
    setBusy(true);
    try {
      await apiClient.post('/api/admin/ai/prompt-conformity', { action: 'retry', issueId: i.id });
      toast.success('Nouvel essai demandé : il aura lieu au prochain passage.');
      await load();
    } catch (e) {
      toast.error((e as { message?: string }).message ?? 'Nouvel essai impossible.');
    } finally {
      setBusy(false);
    }
  };
  const ouvertes = data?.issues.filter((i) => i.status !== 'RESOLVED') ?? [];
  const resolues = data?.issues.filter((i) => i.status === 'RESOLVED') ?? [];
  return (
    <details
      className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)]"
      data-testid="prompt-conformity"
      onToggle={(e) => { if ((e.target as HTMLDetailsElement).open && !data) void load(); }}
    >
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-[color:var(--text-primary)]">
        Conformité des prompts · contrats IA, corrections automatiques, retours arrière
        {data && ouvertes.length > 0 && <span className="ml-2 text-xs text-[color:var(--text-warning-soft)]">• {ouvertes.length} incompatibilité(s)</span>}
      </summary>
      {!data ? (
        <p className="px-4 pb-4 text-sm text-[color:var(--text-muted)]">Chargement…</p>
      ) : (
        <div className="px-4 pb-4 space-y-4 min-w-0">
          <div className="flex flex-col sm:flex-row sm:items-center gap-2">
            <p className="flex-1 min-w-0 text-xs text-[color:var(--text-muted)] break-words">
              Environnement {data.environment} · {data.note}. Lecture : {formatDateTime(data.readAt)}.
            </p>
            <div className="flex flex-col sm:flex-row gap-2">
              <Button size="sm" variant="outline" className="min-h-[44px] sm:min-h-0" disabled={busy || data.mode === 'off'} onClick={() => void lancer()}>
                <ShieldCheck className="w-3.5 h-3.5 mr-1.5" /> Vérifier maintenant
              </Button>
              <Button size="sm" variant="outline" className="min-h-[44px] sm:min-h-0" onClick={() => void load()}>
                <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Actualiser
              </Button>
            </div>
          </div>
          <p className="text-xs text-[color:var(--text-secondary)] break-words">
            Seuls les blocs officiels du guide du PO sont insérés, à partir de la version active ; une révision n’est activée qu’en préproduction, après une qualification
            concluante sans régression sur toutes les branches du prompt. Sinon l’ancienne version reste active et le motif est affiché ici.
          </p>

          <div className="space-y-2">
            <h3 className="text-sm font-medium text-[color:var(--text-primary)]">Incompatibilités en cours</h3>
            {ouvertes.length === 0 ? (
              <p className="text-xs text-[color:var(--text-muted)]">Aucune : tous les contrats suivis sont portés par les prompts actifs.</p>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
                {ouvertes.map((i) => <IssueCard key={i.id} i={i} busy={busy} onRetry={(x) => void relancer(x)} />)}
              </div>
            )}
          </div>

          {resolues.length > 0 && (
            <details>
              <summary className="cursor-pointer text-xs text-[color:var(--text-secondary)]">Résolues ({resolues.length})</summary>
              <div className="mt-2 grid grid-cols-1 lg:grid-cols-2 gap-2">
                {resolues.map((i) => <IssueCard key={i.id} i={i} busy={busy} onRetry={(x) => void relancer(x)} />)}
              </div>
            </details>
          )}

          <details>
            <summary className="cursor-pointer text-xs text-[color:var(--text-secondary)]">Registre des contrats exigés ({data.registry.length})</summary>
            <div className="mt-2 grid grid-cols-1 lg:grid-cols-2 gap-2" data-testid="conformity-registry">
              {data.registry.map((c) => (
                <div key={c.id} className="rounded-lg border border-[color:var(--border-subtle)] p-2 text-xs space-y-0.5 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`px-2 py-0.5 rounded-full border ${c.state === 'SATISFIED' ? TONE.ok : TONE.warn}`}>{STATE_LABEL[c.state] ?? c.state}</span>
                    <span className="text-[color:var(--text-secondary)]">{c.treatment} · lot {c.lot}{c.guideStep ? ` · étape ${c.guideStep}` : ''}</span>
                  </div>
                  <p className="text-[color:var(--text-primary)] break-words">{c.label}</p>
                  <p className="text-[color:var(--text-muted)] break-words">Contrat <code>{c.id}</code>{c.task ? ` · branche ${c.task}` : ''} · {c.operations.join(', ') || '—'}</p>
                  {c.markers.length > 0 && <p className="text-[color:var(--text-muted)] break-words">Marqueurs : {c.markers.join(' · ')}</p>}
                  {c.expectedExecution && <p className="text-[color:var(--text-muted)] break-words">Mode d’exécution attendu : {c.expectedExecution}</p>}
                  <p className="text-[color:var(--text-muted)] break-words">
                    {c.autoCorrectable ? `Correction automatique : bloc(s) ${c.blockIds.join(', ') || '— (configuration seule)'}` : 'Surveillé seulement (aucun bloc officiel)'}
                    {c.killSwitch ? ` · coupure : ${c.killSwitch}=0` : ''}
                  </p>
                  {c.state !== 'SATISFIED' && c.cause && <p className="text-[color:var(--text-warning-soft)] break-words">{c.cause}</p>}
                </div>
              ))}
            </div>
          </details>
        </div>
      )}
    </details>
  );
}
