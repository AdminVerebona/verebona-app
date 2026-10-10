/**
 * Export d'une exécution IA — BO « Exécutions & logs », lot 32 (point 5).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI
 *
 * Le panneau « Exécution — appel N » se lisait à l'écran mais ne se copiait
 * pas : pour analyser une exécution ailleurs (ticket, comparaison, outil
 * d'analyse), il fallait recopier bloc par bloc. Cet export rassemble TOUTE
 * l'exécution dans un JSON structuré et stable (`format`) : appel, trace,
 * configuration appliquée, appels de la chaîne, étapes, entrées/sorties du
 * modèle, erreurs, coûts, instantanés d'entrée, modifications, job de file,
 * sources T2.
 *
 * ── CE QUI N'Y EST JAMAIS ────────────────────────────────────────────────
 * L'export ne lit RIEN de plus que le détail déjà affiché
 * (`getExecutionDetail`) : la rédaction en place s'applique telle quelle.
 *   · le prompt rendu n'est pas conservé par la passerelle (« jamais le
 *     texte envoyé au modèle ») : l'export le dit (`renderedPrompt: null`)
 *     et donne ses références (version, prompt maître, TASK) ;
 *   · la sortie du modèle n'y figure qu'à l'état d'extrait masqué (500
 *     caractères, `previewForLog`) ou, pour l'assistant, d'empreinte
 *     (`sha256:… len:…`, CDC Assistant §29.6). Lot 33D : la sortie COMPLÈTE
 *     conservée pour un appel en échec (`ai_call_diagnostics`) n'est ajoutée
 *     (`modelOutputs`) que sur demande explicite de la route
 *     (`?includeModelOutput=1`), sous la même garde et avec journal d'accès ;
 *   · le contenu conversationnel T2 (accès restreint, justifié et tracé,
 *     LOG-UI-08) n'est pas inclus : seulement les références des sources ;
 *   · les textes libres (extraits, messages d'erreur, charge utile du job,
 *     détails) repassent par le même masquage que la passerelle (`redact`),
 *     par précaution — un masquage déjà appliqué reste inchangé.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { redact } from '@/services/ai/gateway/redaction';
import type { ExecutionDetail, ExecutionRow, ExecutionStep } from './execution-log.repository';
import { buildExecutionDiagnosis, type ExecutionDiagnosis } from './execution-diagnosis';
import type { ModelOutputView } from '../gateway/diagnostics/diagnostic.repository';

export const EXECUTION_EXPORT_FORMAT = 'verebona.ai-execution/v1';

/** Une sortie journalisée : empreinte (assistant) ou extrait masqué. */
export type OutputKind = 'digest' | 'excerpt';

export function outputKindOf(preview: string): OutputKind {
  return /^sha256:[0-9a-f]{6,64} len:\d+$/.test(preview.trim()) ? 'digest' : 'excerpt';
}

/** Masque récursivement les CHAÎNES d'une valeur (objets, tableaux). */
function masquer(v: unknown): unknown {
  if (typeof v === 'string') return redact(v);
  if (Array.isArray(v)) return v.map(masquer);
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, masquer(x)]));
  }
  return v;
}
const texte = (s: string | null | undefined): string | null => (s == null ? null : redact(s));
const iso = (d: Date | string | null | undefined): string | null => (d == null ? null : new Date(d).toISOString());
const usd = (micros: number | null | undefined): number | null => (micros == null ? null : Math.round(micros) / 1_000_000);

function appel(c: ExecutionRow) {
  return {
    id: c.id,
    createdAt: iso(c.createdAt),
    useCaseCode: c.useCaseCode,
    treatment: c.treatment,
    operationCode: c.operationCode,
    accountId: c.accountId,
    userId: c.userId,
    provider: c.provider,
    model: c.model,
    modelRank: c.modelRank,
    usedFallback: c.usedFallback,
    status: c.status,
    error: c.errorCode || c.errorMessage ? { code: c.errorCode, message: texte(c.errorMessage) } : null,
    durationMs: c.durationMs,
    inputTokens: c.inputTokens,
    outputTokens: c.outputTokens,
    costMicros: c.costMicros,
    costUsd: usd(c.costMicros),
    promptVersion: c.promptVersion,
    task: c.task,
    masterPrompt: c.masterPromptCode ? { code: c.masterPromptCode, version: c.masterPromptVersion } : null,
    reasoning: c.reasoning,
    maxOutputTokens: c.maxOutputTokens,
    engine: c.engine,
    trigger: c.callTrigger ?? c.trigger,
    origin: c.origin,
    callerMode: c.callerMode,
    configVersionId: c.configVersionId,
    configVisibleNumber: c.configVisibleNumber,
    appVersion: c.appVersion,
    jobId: c.jobId,
    object: c.objectType || c.objectId ? { type: c.objectType, id: c.objectId } : null,
    // Lot 34D : contrat runtime transmis / validé, structured output, schéma
    // fournisseur, transformations appliquées, contexte structuré (T4).
    runtimeContract: c.runtimeContract ?? null,
    transformations: c.transformations ? masquer(c.transformations) : null,
    structuredContext: c.structuredContext ?? null,
  };
}

function etape(s: ExecutionStep) {
  return {
    stepOrder: s.stepOrder,
    stepName: s.stepName,
    status: s.status,
    provider: s.provider,
    model: s.model,
    promptVersion: s.promptVersion,
    durationMs: s.durationMs,
    costMicros: s.costMicros,
    costUsd: usd(s.costMicros),
    isFallback: s.isFallback,
    fallbackReason: s.fallbackReason,
    error: s.errorCode || s.errorMessage ? { code: s.errorCode, message: texte(s.errorMessage) } : null,
    output: s.outputPreview == null ? null : { kind: outputKindOf(s.outputPreview), text: redact(s.outputPreview) },
  };
}

export interface ExecutionExport {
  format: typeof EXECUTION_EXPORT_FORMAT;
  exportedAt: string;
  callId: number;
  traceId: string | null;
  summary: {
    treatment: string | null;
    operationCode: string | null;
    status: string;
    model: string | null;
    modelRank: string | null;
    accountId: number | null;
    createdAt: string | null;
  };
  appliedConfiguration: Record<string, unknown>;
  modelIO: {
    renderedPrompt: null;
    renderedPromptNote: string;
    promptVersion: string | null;
    masterPrompt: { code: string; version: string | null } | null;
    task: string | null;
    responses: Array<{ stepOrder: number; stepName: string; model: string | null; status: string; kind: OutputKind; text: string }>;
    responseNote: string;
  };
  errors: Array<{ where: string; code: string | null; message: string | null }>;
  costs: {
    totalCostMicros: number;
    totalCostUsd: number;
    inputTokens: number;
    outputTokens: number;
    totalDurationMs: number;
    calls: number;
    failedCalls: number;
  };
  calls: ReturnType<typeof appel>[];
  steps: ReturnType<typeof etape>[];
  inputs: Array<{ label: string; value: unknown }>;
  modifications: Array<{ kind: string; label: string; detail: string | null; at: string | null }>;
  job: Record<string, unknown> | null;
  t2: { requestId: string; sources: unknown[]; contentNote: string } | null;
  /**
   * Lot 33D — diagnostic : rapport par appel (cause, étape, erreurs par
   * chemin, chaîne de contrôles, métadonnées fournisseur, contrat de sortie,
   * corrections), diagnostic de cascade, compteurs, résultat métier, diagnostic
   * final. Jamais la sortie du modèle.
   */
  diagnosis: ExecutionDiagnosis;
  /** Lot 33D — sorties du modèle, UNIQUEMENT sur demande explicite (route, accès journalisé). */
  modelOutputs?: ModelOutputView[];
  redaction: string;
}

/**
 * Construit l'export complet d'une exécution à partir de son détail (pur :
 * aucune lecture en base, testé).
 */
export function buildExecutionExport(
  detail: ExecutionDetail, now: Date = new Date(), opts: { modelOutputs?: ModelOutputView[] } = {},
): ExecutionExport {
  const c = detail.call;
  const calls = (detail.calls.length ? detail.calls : [c]);
  const steps = [...detail.steps].sort((a, b) => a.stepOrder - b.stepOrder);
  const job = detail.job;

  const errors: ExecutionExport['errors'] = [];
  for (const x of calls) {
    if (x.status === 'error' || x.errorCode || x.errorMessage) {
      errors.push({ where: `appel ${x.id} (${x.model ?? 'modèle inconnu'})`, code: x.errorCode, message: texte(x.errorMessage) });
    }
  }
  for (const s of steps) {
    if (s.errorCode || s.errorMessage) errors.push({ where: `étape ${s.stepName}`, code: s.errorCode, message: texte(s.errorMessage) });
  }
  if (job?.lastError) errors.push({ where: `job ${job.id}`, code: null, message: texte(job.lastError) });

  const somme = (f: (x: ExecutionRow) => number | null) => calls.reduce((t, x) => t + (f(x) ?? 0), 0);
  const totalCostMicros = somme((x) => x.costMicros);

  return {
    format: EXECUTION_EXPORT_FORMAT,
    exportedAt: now.toISOString(),
    callId: c.id,
    traceId: detail.traceId,
    summary: {
      treatment: c.treatment, operationCode: c.operationCode, status: c.status, model: c.model,
      modelRank: c.modelRank, accountId: c.accountId, createdAt: iso(c.createdAt),
    },
    appliedConfiguration: {
      engine: c.engine,
      trigger: c.callTrigger ?? job?.triggerCode ?? null,
      task: c.task,
      masterPrompt: c.masterPromptCode ? { code: c.masterPromptCode, version: c.masterPromptVersion } : null,
      reasoning: c.reasoning,
      maxOutputTokens: c.maxOutputTokens,
      promptVersion: c.promptVersion,
      configVersionId: c.configVersionId,
      configVisibleNumber: c.configVisibleNumber,
      appVersion: c.appVersion,
    },
    modelIO: {
      renderedPrompt: null,
      renderedPromptNote: 'Prompt rendu non conservé par la passerelle IA (aucun texte envoyé au modèle n’est stocké) : voir promptVersion, masterPrompt et task.',
      promptVersion: c.promptVersion,
      masterPrompt: c.masterPromptCode ? { code: c.masterPromptCode, version: c.masterPromptVersion } : null,
      task: c.task,
      responses: steps.filter((s) => s.outputPreview != null).map((s) => ({
        stepOrder: s.stepOrder, stepName: s.stepName, model: s.model, status: s.status,
        kind: outputKindOf(s.outputPreview!), text: redact(s.outputPreview!),
      })),
      responseNote: steps.some((s) => s.outputPreview != null)
        ? 'Étapes : extrait masqué (500 caractères au plus) ou, pour l’assistant, empreinte sha256 et longueur. Sortie complète d’un appel en échec : BO, « Afficher la sortie modèle » (accès journalisé).'
        : 'Aucune sortie journalisée pour cette exécution (appel sans étape de pipeline) : sortie complète d’un appel en échec consultable dans le BO (accès journalisé).',
    },
    errors,
    costs: {
      totalCostMicros,
      totalCostUsd: usd(totalCostMicros) ?? 0,
      inputTokens: somme((x) => x.inputTokens),
      outputTokens: somme((x) => x.outputTokens),
      totalDurationMs: somme((x) => x.durationMs),
      calls: calls.length,
      failedCalls: calls.filter((x) => x.status === 'error').length,
    },
    calls: calls.map(appel),
    steps: steps.map(etape),
    inputs: detail.inputs.map((i) => ({ label: i.label, value: masquer(i.value) })),
    modifications: detail.modifications.map((m) => ({ kind: m.kind, label: m.label, detail: texte(m.detail), at: m.at })),
    job: job ? {
      id: job.id, treatment: job.treatment, status: job.status, origin: job.origin, triggerCode: job.triggerCode,
      attempts: job.attempts, configVersionId: job.configVersionId, accountId: job.accountId,
      target: job.targetType || job.targetId ? { type: job.targetType, id: job.targetId } : null,
      createdAt: iso(job.createdAt), startedAt: iso(job.startedAt), finishedAt: iso(job.finishedAt),
      lastError: texte(job.lastError),
    } : null,
    t2: detail.t2 ? {
      requestId: detail.t2.requestId,
      sources: detail.t2.sources,
      contentNote: 'Contenu conversationnel non inclus (accès restreint, justifié et tracé — LOG-UI-08).',
    } : null,
    diagnosis: masquer(detail.diagnosis ?? buildExecutionDiagnosis({
      treatment: c.treatment, calls, diagnostics: [], job: job ? { status: job.status, attempts: job.attempts } : null,
    })) as ExecutionDiagnosis,
    ...(opts.modelOutputs ? { modelOutputs: masquer(opts.modelOutputs) as ModelOutputView[] } : {}),
    redaction: 'Export limité au détail affiché dans le BO ; textes libres repassés par le masquage de la passerelle (IBAN, cartes, clés d’API, NIR).',
  };
}

/** Nom de fichier proposé au téléchargement. */
export function executionExportFileName(callId: number, at: Date = new Date()): string {
  return `execution-ia-appel-${callId}-${at.toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
}
