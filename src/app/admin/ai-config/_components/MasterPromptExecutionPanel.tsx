'use client';

/**
 * Configuration d'exécution d'un prompt maître et aperçu — lot 34D (ticket
 * « T4 : découpler le contrat d'exécution du texte du prompt maître »).
 *
 * Affiché seulement pour un prompt qui déclare un contrat d'exécution (T4) :
 *   · mode EXPLICITE de la version (contexte structuré / legacy), contrats
 *     d'entrée et de sortie, TASK autorisées — modifiables sur le brouillon
 *     seulement (une version active ou ancienne est immuable) ;
 *   · liste INFORMATIVE du contexte transmis automatiquement au modèle (plus
 *     aucun {{EVIDENCE}}, {{AGENDA_ITEM}}… à insérer dans le texte) ;
 *   · « Repartir du texte de référence » du mode choisi ;
 *   · aperçu / test : prompt envoyé, TASK, contrat d'entrée, contexte
 *     construit, contrat de sortie, sortie brute (enregistrée, sans appel
 *     modèle) et résultat validé, chacun dans son volet.
 *
 * Composants et jetons existants uniquement (« garde mon design »).
 */
import { useState } from 'react';
import { Loader2, Eye } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api-client';

export type ExecutionMode = 'LEGACY_TEMPLATE' | 'STRUCTURED_CONTEXT';
export interface ExecutionConfig {
  mode: ExecutionMode;
  inputContractVersion: string | null;
  outputContractVersion: string | null;
  allowedTasks: string[] | null;
}
export interface StructuredInfo {
  modes: Array<{ value: ExecutionMode; label: string }>;
  knownTasks: string[];
  inputContracts: string[];
  outputContracts: string[];
  context: Array<{ field: string; description: string; tasks: Array<{ task: string; requirement: 'requis' | 'optionnel' }> }>;
  references: Record<ExecutionMode, string>;
  scenarios: Array<{ id: string; task: string; description: string }>;
}
interface Preview {
  mode: ExecutionMode; task: string; versionNumber: number | null;
  scenario: { id: string; description: string } | null;
  prompt: string | null; promptError: string | null;
  inputContract: { version: string | null; fields: StructuredInfo['context'] };
  context: string | null;
  contextError: { code: string; message: string; field: string | null; step: string } | null;
  outputContract: { version: string | null; contractId: string; contractVersion: number; schemaVersion: string; schemaHash: string; jsonSchema: string } | null;
  rawOutput: string | null;
  validated: { ok: true; data: unknown; transformations: string[] } | { ok: false; message: string } | null;
}

const MODE_LABEL: Record<ExecutionMode, string> = {
  STRUCTURED_CONTEXT: 'Contexte structuré',
  LEGACY_TEMPLATE: 'Legacy (emplacements {{…}})',
};

const pre = 'mt-1 max-h-72 overflow-auto rounded bg-[color:var(--bg-page)] p-2 text-xs font-mono whitespace-pre-wrap text-[color:var(--text-secondary)]';

/** Résumé lisible d'une configuration (version active, historique). */
export function executionSummary(e: ExecutionConfig | null): string {
  if (!e) return '';
  if (e.mode === 'LEGACY_TEMPLATE') return MODE_LABEL.LEGACY_TEMPLATE;
  return `${MODE_LABEL.STRUCTURED_CONTEXT} · entrée ${e.inputContractVersion ?? '—'} · sortie ${e.outputContractVersion ?? '—'} · TASK ${(e.allowedTasks ?? ['toutes']).join(', ')}`;
}

function Volet({ titre, children, ouvert }: { titre: string; children: React.ReactNode; ouvert?: boolean }) {
  return (
    <details className="rounded-md border border-[color:var(--border-subtle)] p-2" open={ouvert}>
      <summary className="cursor-pointer text-xs font-medium text-[color:var(--text-primary)]">{titre}</summary>
      {children}
    </details>
  );
}

export function MasterPromptExecutionPanel({
  treatment, info, execution, editable, versionTarget, disabled, onChange, onLoadReference,
}: {
  treatment: string;
  info: StructuredInfo;
  execution: ExecutionConfig | null;
  /** Brouillon : configuration modifiable ; version active : lecture seule. */
  editable: boolean;
  /** Version prévisualisée (`active`, identifiant du brouillon). */
  versionTarget: number | 'active';
  disabled?: boolean;
  onChange?: (e: ExecutionConfig) => void;
  onLoadReference?: (text: string) => void;
}) {
  const cfg: ExecutionConfig = execution ?? { mode: 'LEGACY_TEMPLATE', inputContractVersion: null, outputContractVersion: null, allowedTasks: null };
  const [task, setTask] = useState(info.knownTasks[0] ?? '');
  const [scenario, setScenario] = useState<string>('');
  const [apercu, setApercu] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const structure = cfg.mode === 'STRUCTURED_CONTEXT';
  const taches = cfg.allowedTasks ?? info.knownTasks;

  const changer = (patch: Partial<ExecutionConfig>) => {
    const next = { ...cfg, ...patch };
    if (patch.mode === 'STRUCTURED_CONTEXT') {
      next.inputContractVersion = next.inputContractVersion ?? info.inputContracts[0] ?? null;
      next.outputContractVersion = next.outputContractVersion ?? info.outputContracts[0] ?? null;
      next.allowedTasks = next.allowedTasks ?? [...info.knownTasks];
    }
    onChange?.(next);
  };

  const previsualiser = async () => {
    setBusy(true);
    try {
      setApercu(await apiClient.post<Preview>(`/api/admin/ai/master-prompts/${treatment}/preview`, {
        versionId: versionTarget, task, scenarioId: scenario || null,
      }));
    } catch (e) {
      toast.error((e as { message?: string })?.message || 'Aperçu indisponible.');
    } finally { setBusy(false); }
  };

  return (
    <div className="rounded-lg border border-[color:var(--border-subtle)] p-3 space-y-3" data-testid="master-prompt-execution">
      <div className="space-y-1">
        <p className="text-sm font-medium text-[color:var(--text-primary)]">Exécution</p>
        {editable ? (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <label className="text-[color:var(--text-muted)]" htmlFor={`mode-${treatment}`}>Mode</label>
            <select
              id={`mode-${treatment}`}
              className="rounded border border-[color:var(--border-subtle)] bg-[color:var(--bg-input)] px-2 py-1 text-[color:var(--text-primary)]"
              value={cfg.mode} disabled={disabled}
              onChange={(e) => changer({ mode: e.target.value as ExecutionMode })}
            >
              {info.modes.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
            {structure && (
              <>
                <label className="text-[color:var(--text-muted)]" htmlFor={`in-${treatment}`}>Contrat d’entrée</label>
                <select
                  id={`in-${treatment}`}
                  className="rounded border border-[color:var(--border-subtle)] bg-[color:var(--bg-input)] px-2 py-1 text-[color:var(--text-primary)]"
                  value={cfg.inputContractVersion ?? ''} disabled={disabled}
                  onChange={(e) => changer({ inputContractVersion: e.target.value })}
                >
                  {info.inputContracts.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
                <label className="text-[color:var(--text-muted)]" htmlFor={`out-${treatment}`}>Contrat de sortie</label>
                <select
                  id={`out-${treatment}`}
                  className="rounded border border-[color:var(--border-subtle)] bg-[color:var(--bg-input)] px-2 py-1 text-[color:var(--text-primary)]"
                  value={cfg.outputContractVersion ?? ''} disabled={disabled}
                  onChange={(e) => changer({ outputContractVersion: e.target.value })}
                >
                  {info.outputContracts.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </>
            )}
          </div>
        ) : (
          <p className="text-xs text-[color:var(--text-secondary)]">{executionSummary(cfg)}</p>
        )}
        {editable && structure && (
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <span className="text-[color:var(--text-muted)]">TASK autorisées</span>
            {info.knownTasks.map((t) => (
              <label key={t} className="flex items-center gap-1 text-[color:var(--text-secondary)]">
                <input
                  type="checkbox" disabled={disabled} checked={taches.includes(t)}
                  onChange={(e) => changer({ allowedTasks: e.target.checked ? [...new Set([...taches, t])] : taches.filter((x) => x !== t) })}
                />
                {t}
              </label>
            ))}
          </div>
        )}
        <p className="text-xs text-[color:var(--text-muted)]">
          {structure
            ? 'Les données sont transmises automatiquement au modèle (bloc EXECUTION_CONTEXT) : le texte est libre, aucun emplacement {{…}} ni titre de section n’est exigé.'
            : 'Mode legacy : le texte doit contenir {{TASK}}, les emplacements de données et une section « BRANCHE TASK = … » par TASK.'}
          {' '}Retour au mode legacy : choisir « Legacy » sur un brouillon (texte de référence legacy), ou réactiver une version legacy depuis l’historique.
        </p>
        {editable && onLoadReference && (
          <Button size="sm" variant="outline" disabled={disabled || !info.references[cfg.mode]} onClick={() => onLoadReference(info.references[cfg.mode])}>
            Repartir du texte de référence ({MODE_LABEL[cfg.mode]})
          </Button>
        )}
      </div>

      {structure && (
        <Volet titre="Contexte transmis automatiquement (informatif)">
          <ul className="mt-1 space-y-1 text-xs">
            {info.context.map((c) => (
              <li key={c.field} className="text-[color:var(--text-secondary)]">
                <span className="font-mono text-[color:var(--text-primary)]">{c.field}</span> — {c.description}
                {c.tasks.length > 0 && (
                  <span className="text-[color:var(--text-muted)]"> ({c.tasks.map((t) => `${t.task} : ${t.requirement}`).join(' · ')})</span>
                )}
              </li>
            ))}
          </ul>
        </Volet>
      )}

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-[color:var(--text-muted)]">Aperçu</span>
          <select
            aria-label="TASK de l’aperçu"
            className="rounded border border-[color:var(--border-subtle)] bg-[color:var(--bg-input)] px-2 py-1 text-[color:var(--text-primary)]"
            value={task} onChange={(e) => { setTask(e.target.value); setScenario(''); }}
          >
            {info.knownTasks.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <select
            aria-label="Scénario de l’aperçu"
            className="rounded border border-[color:var(--border-subtle)] bg-[color:var(--bg-input)] px-2 py-1 text-[color:var(--text-primary)] max-w-xs"
            value={scenario} onChange={(e) => setScenario(e.target.value)}
          >
            <option value="">Premier scénario</option>
            {info.scenarios.filter((s) => s.task === task).map((s) => <option key={s.id} value={s.id}>{s.id}</option>)}
          </select>
          <Button size="sm" variant="outline" disabled={busy || disabled} onClick={() => void previsualiser()}>
            {busy ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Eye className="w-3.5 h-3.5 mr-1.5" />}
            Prévisualiser
          </Button>
        </div>
        {editable && (
          <p className="text-xs text-[color:var(--text-muted)]">L’aperçu porte sur le brouillon ENREGISTRÉ (texte et configuration).</p>
        )}
        {apercu && (
          <div className="space-y-2" data-testid="master-prompt-preview">
            <p className="text-xs text-[color:var(--text-secondary)]">
              TASK <span className="font-mono">{apercu.task}</span> · {MODE_LABEL[apercu.mode]}
              {apercu.scenario ? ` · scénario ${apercu.scenario.id} — ${apercu.scenario.description}` : ' · aucun scénario'}
            </p>
            <Volet titre="Prompt maître envoyé">
              {apercu.promptError
                ? <p className="mt-1 text-xs text-red-400">{apercu.promptError}</p>
                : <pre className={pre}>{apercu.prompt ?? '—'}</pre>}
            </Volet>
            <Volet titre={`Contrat d’entrée${apercu.inputContract.version ? ` (${apercu.inputContract.version})` : ''}`}>
              <ul className="mt-1 space-y-0.5 text-xs text-[color:var(--text-secondary)]">
                {apercu.inputContract.fields.map((f) => (
                  <li key={f.field}><span className="font-mono">{f.field}</span> : {f.tasks.find((t) => t.task === apercu.task)?.requirement ?? 'sans objet'}</li>
                ))}
                {apercu.inputContract.fields.length === 0 && <li>Mode legacy : données substituées dans les emplacements du texte.</li>}
              </ul>
            </Volet>
            <Volet titre="Contexte d’exécution construit" ouvert={Boolean(apercu.contextError)}>
              {apercu.contextError
                ? <p className="mt-1 text-xs text-red-400">{apercu.contextError.code} — {apercu.contextError.message} (étape {apercu.contextError.step}{apercu.contextError.field ? `, champ ${apercu.contextError.field}` : ''})</p>
                : <pre className={pre}>{apercu.context ?? '— (mode legacy)'}</pre>}
            </Volet>
            <Volet titre={`Contrat de sortie${apercu.outputContract ? ` (${apercu.outputContract.contractId} v${apercu.outputContract.contractVersion} · ${apercu.outputContract.schemaHash})` : ''}`}>
              <pre className={pre}>{apercu.outputContract?.jsonSchema ?? '—'}</pre>
            </Volet>
            <Volet titre="Réponse brute du modèle (enregistrée, sans appel)">
              <pre className={pre}>{apercu.rawOutput ?? '—'}</pre>
            </Volet>
            <Volet titre="Résultat validé" ouvert>
              {!apercu.validated ? <p className="mt-1 text-xs text-[color:var(--text-muted)]">—</p>
                : apercu.validated.ok
                  ? <pre className={pre}>{JSON.stringify(apercu.validated.data, null, 2)}{apercu.validated.transformations.length ? `\n\nTransformations : ${apercu.validated.transformations.join(' ; ')}` : ''}</pre>
                  : <p className="mt-1 text-xs text-red-400">{apercu.validated.message}</p>}
            </Volet>
          </div>
        )}
      </div>
    </div>
  );
}
