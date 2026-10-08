"use client";

/**
 * Diagnostic d'une exécution IA — BO « Exécutions & logs », lot 33D (ticket
 * « rapports d'échec IA diagnostiquables »).
 *
 * Répond, sans investigation complémentaire, aux questions du ticket : le
 * fournisseur a-t-il répondu ? le modèle a-t-il produit une sortie ? était-
 * elle complète, valide, conforme au schéma ? quelle validation, quel champ,
 * quelle valeur reçue, quelle valeur attendue ? pourquoi un fallback ? les
 * fallbacks ont-ils échoué pour la même raison ? quelles versions (code,
 * prompt, configuration, schéma) ? le job a-t-il seulement fini
 * techniquement, ou la tâche métier a-t-elle réussi ?
 *
 * La sortie du modèle n'est JAMAIS dans le détail : « Afficher la sortie
 * modèle » la demande à la route dédiée (accès journalisé).
 */
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api-client';
import {
  CONTROL_LABELS, FAMILY_LABELS, SUBTYPE_LABELS,
  type CallDiagnostic, type ControlChain, type ControlState,
} from '@/services/ai/gateway/diagnostics/taxonomy';
import { CopyBlockButton } from './CopyJson';

export interface CallReportView {
  callId: number;
  label: string;
  rank: string | null;
  model: string | null;
  callKind: 'analysis' | 'repair';
  status: 'SUCCEEDED' | 'REPAIRED' | 'FAILED';
  cause: string | null;
  stage: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number | null;
  costMicros: number | null;
  diagnostic: CallDiagnostic | null;
  diagnosticId: number | null;
  hasModelOutput: boolean;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface DiagnosisView {
  calls: CallReportView[];
  cascade: {
    analysisCalls: number; failedCalls: number; identical: boolean; signature: string | null;
    cause: string | null; path: string | null; expected: string | null; received: string | null; stage: string | null;
  };
  counters: { jobAttempts: number | null; modelCalls: number; modelFallbacks: number; repairCalls: number };
  result: { jobStatus: string | null; businessResult: string | null; cause: string | null; doneButFailed: boolean };
  finalDiagnosis: string[];
}

interface ModelOutput { diagnosticId: number; model: string | null; callIndex: number; raw: string | null; extracted: string | null; parsed: unknown }

const STATE: Record<ControlState, { mark: string; label: string; tone: string }> = {
  passed: { mark: '✓', label: 'valide', tone: 'text-emerald-500' },
  repaired: { mark: '✓', label: 'corrigé automatiquement', tone: 'text-amber-500' },
  failed: { mark: '✗', label: 'invalide', tone: 'text-red-400' },
  not_run: { mark: '·', label: 'non exécuté', tone: 'text-[color:var(--text-muted)]' },
  not_applicable: { mark: '·', label: 'sans objet', tone: 'text-[color:var(--text-muted)]' },
  absent: { mark: '✗', label: 'absent', tone: 'text-red-400' },
};

const STATUS_LABEL: Record<CallReportView['status'], string> = {
  SUCCEEDED: 'succès', REPAIRED: 'succès après correction', FAILED: 'échec',
};

const BUSINESS_LABEL: Record<string, string> = {
  SUCCEEDED: 'réussi', APPLIED: 'appliqué', NO_CHANGE: 'aucune modification', ABSTAIN: 'abstention',
  SUPERSEDED: 'rendu obsolète', TARGET_GONE: 'cible disparue', FAILED: 'ÉCHEC',
};

const fmtDuration = (ms: number | null) => (ms === null ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);
const fmtInt = (n: number | null | undefined) => (n === null || n === undefined ? '—' : n.toLocaleString('fr-FR'));

function causeLabel(d: CallDiagnostic | null): string | null {
  if (!d?.family) return null;
  const fam = FAMILY_LABELS[d.family] ?? d.family;
  return d.family === 'INVALID_OUTPUT' && d.subtype ? `${fam} — ${SUBTYPE_LABELS[d.subtype] ?? d.subtype}` : fam;
}

function Controls({ controls }: { controls: ControlChain }) {
  return (
    <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-0.5" data-testid="execution-call-controls">
      {(Object.keys(CONTROL_LABELS) as Array<keyof ControlChain>).map((k) => {
        const s = STATE[controls[k]] ?? STATE.not_run;
        return (
          <div key={k} className="contents">
            <dt className="text-[color:var(--text-muted)]">{CONTROL_LABELS[k]}</dt>
            <dd className={s.tone}>{s.mark} {s.label}</dd>
          </div>
        );
      })}
    </dl>
  );
}

function CallCard({ r }: { r: CallReportView }) {
  const d = r.diagnostic;
  const p = d?.provider;
  const first = d?.issues[0];
  return (
    <div className="rounded-lg border border-[color:var(--border-subtle)] p-3 space-y-1.5 text-xs text-[color:var(--text-secondary)]" data-testid="execution-call-report">
      <p className="font-medium text-[color:var(--text-primary)]">
        {r.label.charAt(0).toUpperCase() + r.label.slice(1)} — {r.model ?? 'modèle inconnu'}
      </p>
      <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-0.5">
        <dt className="text-[color:var(--text-muted)]">Statut</dt>
        <dd className={r.status === 'FAILED' ? 'text-red-400' : r.status === 'REPAIRED' ? 'text-amber-500' : 'text-emerald-500'}>
          {STATUS_LABEL[r.status]}
        </dd>
        {r.cause && (<><dt className="text-[color:var(--text-muted)]">Cause</dt><dd>{r.cause}{causeLabel(d) ? ` (${causeLabel(d)})` : ''}</dd></>)}
        {r.stage && (<><dt className="text-[color:var(--text-muted)]">Étape</dt><dd>{r.stage}</dd></>)}
        <dt className="text-[color:var(--text-muted)]">Entrée</dt><dd>{fmtInt(r.inputTokens)} tokens</dd>
        <dt className="text-[color:var(--text-muted)]">Sortie</dt>
        <dd>
          {fmtInt(r.outputTokens)} tokens
          {p?.configuredMaxOutputTokens ? ` / ${fmtInt(p.configuredMaxOutputTokens)} max` : ''}
          {p?.tokenUsage?.thoughts ? ` (+ ${fmtInt(p.tokenUsage.thoughts)} de raisonnement)` : ''}
        </dd>
        <dt className="text-[color:var(--text-muted)]">Durée</dt><dd>{fmtDuration(r.durationMs)}</dd>
        {p?.finishReason && (<><dt className="text-[color:var(--text-muted)]">Finish reason</dt><dd>{p.finishReason}</dd></>)}
        <dt className="text-[color:var(--text-muted)]">Sortie reçue</dt>
        <dd>{d ? (d.outputReceived ? 'oui' : 'aucune') : (r.outputTokens ?? 0) > 0 ? 'oui' : 'aucune'}</dd>
      </dl>

      {first && (
        <div className="space-y-0.5" data-testid="execution-call-error">
          <p className="text-red-400">
            Erreur : {first.subtype} — {first.path}
            {first.expected ? ` · attendu ${first.expected}` : ''}{first.received ? ` · reçu ${first.received}` : ''}
          </p>
          {first.missingField && <p>Champ obligatoire : {first.missingField}</p>}
          {first.allowedValues && first.allowedValues.length > 0 && <p>Valeurs autorisées : {first.allowedValues.join(', ')}</p>}
          {first.receivedValue && <pre className="whitespace-pre-wrap break-all">Valeur reçue : {first.receivedValue}</pre>}
          <p className="text-[color:var(--text-muted)]">Message du validateur : {first.message}</p>
          {d && d.issueCount > 1 && (
            <details>
              <summary className="cursor-pointer text-[color:var(--text-muted)]">{d.issueCount - 1} autre(s) erreur(s) de validation</summary>
              <ul className="list-disc pl-4">
                {d.issues.slice(1).map((i, k) => (
                  <li key={k}>{i.subtype} — {i.path}{i.expected ? ` · attendu ${i.expected}` : ''}{i.received ? ` · reçu ${i.received}` : ''}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
      {!first && d?.error?.message && r.status === 'FAILED' && <p className="text-red-400 break-all">Erreur : {d.error.message}</p>}
      {!d && r.errorMessage && <p className="text-red-400 break-all">{r.errorCode ? `${r.errorCode} — ` : ''}{r.errorMessage}</p>}
      {d?.error?.stack && (
        <details><summary className="cursor-pointer text-[color:var(--text-muted)]">Pile technique</summary><pre className="whitespace-pre-wrap break-all">{d.error.exception ? `${d.error.exception}\n` : ''}{d.error.stack}</pre></details>
      )}

      {d && (
        <details>
          <summary className="cursor-pointer text-[color:var(--text-muted)]">Chaîne de contrôles, fournisseur, contrat de sortie</summary>
          <div className="mt-1 space-y-1.5">
            <Controls controls={d.controls} />
            <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-0.5" data-testid="execution-call-provider">
              {([
                ['Fournisseur', p?.provider], ['Modèle servi', p?.modelVersion], ['Identifiant de réponse', p?.providerRequestId],
                ['Stop reason', p?.stopReason], ['Raison de sécurité', p?.safetyReason], ['Structured output', p?.structuredOutputStatus],
                ['Latence', p?.latencyMs != null ? fmtDuration(p.latencyMs) : null], ['Code erreur fournisseur', p?.providerErrorCode],
                ['Message fournisseur', p?.providerErrorMessage], ['HTTP', p?.httpStatus],
                ['Schéma de sortie', d.schema ? `${d.schema.version} · ${d.schema.hash}` : null],
                ['Signature d’échec', d.signature],
                ['Repli informé de l’erreur précédente', d.informedOfPreviousError ? 'oui' : null],
              ] as Array<[string, unknown]>).filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => (
                <div key={k} className="contents"><dt className="text-[color:var(--text-muted)]">{k}</dt><dd className="break-all">{String(v)}</dd></div>
              ))}
            </dl>
            {d.repairs.length > 0 && (
              <div data-testid="execution-call-repairs">
                <p className="text-[color:var(--text-muted)]">Corrections appliquées :</p>
                <ul className="list-disc pl-4">
                  {d.repairs.slice(0, 30).map((x, k) => <li key={k}>{x.stage} · {x.rule} · {x.path}{x.detail ? ` — ${x.detail}` : ''}</li>)}
                </ul>
              </div>
            )}
          </div>
        </details>
      )}
    </div>
  );
}

/** Sorties du modèle (route dédiée, accès journalisé). */
function ModelOutputs({ callId }: { callId: number }) {
  const [state, setState] = useState<'idle' | 'loading' | 'done'>('idle');
  const [outputs, setOutputs] = useState<ModelOutput[]>([]);
  const charger = async () => {
    setState('loading');
    try {
      const r = await apiClient.post<{ outputs: ModelOutput[] }>(`/api/admin/ai/executions/${callId}/model-output`, {});
      setOutputs(r.outputs ?? []);
      setState('done');
    } catch (e) {
      toast.error((e as Error).message || 'Sortie modèle indisponible');
      setState('idle');
    }
  };
  if (state !== 'done') {
    return (
      <Button size="sm" variant="outline" onClick={charger} disabled={state === 'loading'} data-testid="execution-model-output-button">
        {state === 'loading' && <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />}Afficher la sortie modèle
      </Button>
    );
  }
  if (outputs.length === 0) return <p className="text-xs text-[color:var(--text-muted)]">Aucune sortie conservée (appels réussis tels quels, assistant, ou rétention dépassée).</p>;
  return (
    <div className="space-y-2" data-testid="execution-model-outputs">
      <p className="text-xs text-[color:var(--text-muted)]">Données issues des documents de l’utilisateur — consultation journalisée.</p>
      {outputs.map((o) => (
        <div key={o.diagnosticId} className="text-xs text-[color:var(--text-secondary)] space-y-1">
          <p className="font-medium text-[color:var(--text-primary)]">Appel {o.callIndex + 1} — {o.model ?? 'modèle inconnu'}</p>
          {([['Réponse brute', o.raw], ['Après extraction', o.extracted], ['Après parsing', o.parsed]] as Array<[string, unknown]>).map(([label, v]) => (
            <div key={label}>
              <div className="flex items-center gap-1 text-[color:var(--text-muted)]">
                {label} :
                {v !== null && v !== undefined && <CopyBlockButton value={v} label={`${label.toLowerCase()} (appel ${o.callIndex + 1})`} />}
              </div>
              {v === null || v === undefined
                ? <p className="text-[color:var(--text-muted)]">{label === 'Réponse brute' ? 'aucune' : 'identique à la réponse brute ou non disponible'}</p>
                : <pre className="whitespace-pre-wrap break-all max-h-64 overflow-y-auto">{typeof v === 'string' ? v : JSON.stringify(v, null, 2)}</pre>}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function ExecutionDiagnosisPanel({ callId, diagnosis }: { callId: number; diagnosis: DiagnosisView }) {
  const { result, counters, cascade } = diagnosis;
  const failed = result.businessResult === 'FAILED';
  return (
    <>
      <section className="space-y-1" data-testid="execution-final-diagnosis">
        <h3 className="text-sm font-semibold text-[color:var(--text-primary)]">Diagnostic final</h3>
        <div className={`rounded-lg border p-3 text-xs space-y-0.5 ${failed ? 'border-red-500/30 bg-red-500/5' : 'border-[color:var(--border-subtle)]'}`}>
          {diagnosis.finalDiagnosis.map((l, i) => <p key={i} className={i === 0 ? 'font-medium text-[color:var(--text-primary)]' : 'text-[color:var(--text-secondary)]'}>{l}</p>)}
        </div>
        <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-0.5 text-xs" data-testid="execution-result">
          {result.jobStatus && (<><dt className="text-[color:var(--text-muted)]">Job</dt><dd className="text-[color:var(--text-secondary)]">{result.jobStatus}</dd></>)}
          <dt className="text-[color:var(--text-muted)]">Résultat métier</dt>
          <dd className={failed ? 'text-red-400 font-medium' : 'text-[color:var(--text-secondary)]'}>
            {result.businessResult ? `${result.businessResult}${BUSINESS_LABEL[result.businessResult] ? ` (${BUSINESS_LABEL[result.businessResult]})` : ''}` : '—'}
          </dd>
          {result.cause && (<><dt className="text-[color:var(--text-muted)]">Cause</dt><dd className="text-[color:var(--text-secondary)]">{result.cause}</dd></>)}
        </dl>
        {result.doneButFailed && (
          <p className="text-xs text-red-400">Le job est terminé techniquement (DONE) mais la tâche métier a échoué : ce n’est pas une réussite.</p>
        )}
        <p className="text-xs text-[color:var(--text-secondary)]" data-testid="execution-counters">
          {counters.jobAttempts !== null && <>Tentatives du job : {counters.jobAttempts} · </>}
          Appels modèle : {counters.modelCalls} · Fallbacks modèle : {counters.modelFallbacks}
          {counters.repairCalls > 0 && <> · Réparations ciblées : {counters.repairCalls}</>}
        </p>
      </section>

      {cascade.identical && (
        <section className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs space-y-0.5" data-testid="execution-cascade">
          <p className="font-medium text-[color:var(--text-primary)]">Diagnostic de cascade</p>
          <p className="text-[color:var(--text-secondary)]">{cascade.failedCalls}/{cascade.analysisCalls} modèles ont échoué sur : {cascade.cause}</p>
          {cascade.path && <p className="text-[color:var(--text-secondary)]">Même chemin : {cascade.path}</p>}
          {(cascade.expected || cascade.received) && (
            <p className="text-[color:var(--text-secondary)]">Même incompatibilité : {cascade.received ?? '?'} reçu / {cascade.expected ?? '?'} attendu</p>
          )}
          <p className="text-[color:var(--text-muted)]">Défaut probablement systémique (prompt, schéma, parser ou code) plutôt que propre à un modèle.</p>
        </section>
      )}

      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-[color:var(--text-primary)]">Appels de la chaîne de modèles</h3>
          {diagnosis.calls.some((c) => c.hasModelOutput) && <ModelOutputs callId={callId} />}
        </div>
        {diagnosis.calls.map((r) => <CallCard key={r.callId} r={r} />)}
      </section>
    </>
  );
}
