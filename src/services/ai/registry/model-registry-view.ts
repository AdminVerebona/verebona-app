/**
 * Vue du registre des modèles pour le BO (lecture seule) — CDC Assistant
 * §15.12, §15.13, §15.14, §32.6 (« visualiser les dates de dépréciation des
 * modèles ») ; lot 23.
 *
 * Assemble, sans rien écrire :
 *   · les alias de l'assistant (§15.11) résolus par la chaîne EFFECTIVE, avec
 *     les champs du §15.12 (statut, dates, capacités, prix, limites,
 *     prompts et schémas compatibles, rollback) ;
 *   · lot 35B : TOUS les modèles connus — exceptions du registre, catalogue
 *     découvert chez Google, modèles en usage — avec statut fournisseur
 *     (Preview visible, informatif), qualification technique, tarif
 *     (KNOWN avec montants, ou UNKNOWN et sa raison — jamais inventé),
 *     disponibilité et usage effectif ;
 *   · le contrôle de cohérence de la configuration effective et le verdict
 *     du dernier contrôle de démarrage (avec le dernier registre valide).
 * Les prix viennent du catalogue central (§15.9), les limites manquantes de
 * la liste du fournisseur (`ai_model_catalog`).
 */
import { AI_OPERATIONS } from './operations';
import {
  checkModelUses, DECLARED_MODELS, DECLARED_MODELS_VERSION, MODEL_STATUS_LABELS,
  type CoherenceIssue, type DeclaredModel, type ModelLifecycleStatus,
} from './models';
import { providerLifecycle } from './model-lifecycle';
import type { RegistryQualification } from '@/services/verebona-assistant/registries/model-registry';

type Row = Record<string, unknown>;

export interface RegistryViewModel {
  provider: string;
  model: string;
  status: ModelLifecycleStatus | 'unknown';
  statusLabel: string;
  activatedOn: string | null;
  retiresOn: string | null;
  capabilities: DeclaredModel['capabilities'];
  contextWindowTokens: number | null;
  maxOutputTokens: number | null;
  rateLimits: DeclaredModel['rateLimits'];
  rollbackModel: string | null;
  note?: string;
  price: { inputPerMillion: number; outputPerMillion: number; source: string | null } | null;
  /** Lot 35B : KNOWN | UNKNOWN (raison) — catalogue tarifaire synchronisé. */
  pricing: { status: 'KNOWN' | 'UNKNOWN'; reason: string | null; fetchedAt: string | null; lastChangedAt: string | null };
  /** Lot 35B : qualification technique (automatique, sinon historique). */
  qualification: RegistryQualification | null;
  /** Lot 35B : exception Verebona (registre). */
  declared: boolean;
  exclusion: string | null;
  /** Lot 35B : disponibilité chez le fournisseur (`null` : jamais listé). */
  available: boolean | null;
  firstSeenAt: string | null;
  displayName: string | null;
  /** Opérations qui l'utilisent dans la configuration effective (rang). */
  usedBy: string[];
}

export interface ModelRegistryViewDeps {
  query?: (sql: string, params?: unknown[]) => Promise<Row[]>;
  /** Lot 35B — injectables en test. */
  qualifications?: Map<string, { generate: boolean; structured: boolean | null; multimodal: boolean | null; thinking: boolean | null; qualifiedAt: string }>;
  priceStatuses?: Map<string, { status: 'KNOWN' | 'UNKNOWN'; reason: string | null; fetchedAt: string; lastChangedAt: string | null }>;
  resolve?: (op: string) => Promise<{ primaryModel: string; fallbackModels: string[]; maxOutputTokens: number | null }>;
}

export async function buildModelRegistryView(deps: ModelRegistryViewDeps = {}) {
  const notes: string[] = [];
  const query = deps.query ?? (async (sql: string, params: unknown[] = []) => {
    const { pgClient } = await import('@/db');
    return (await pgClient.unsafe(sql, params as never[])) as unknown as Row[];
  });
  const resolve = deps.resolve ?? (async (op: string) => (await import('../config/config-resolver')).resolveOperationConfig(op));

  const pricing = await import('../gateway/pricing/pricing.repository');
  if (pricing.getCacheState().loadedAt === null) await pricing.loadPricingCache().catch(() => 0);
  const prix = (provider: string, model: string) => {
    const p = pricing.getCachedPrice(provider, model);
    return p ? { inputMicros: p.inputMicros, outputMicros: p.outputMicros, sourceReference: p.sourceReference ?? null } : null;
  };

  const fournisseur = new Map<string, {
    inputTokenLimit: number | null; outputTokenLimit: number | null; deprecationDate: string | null;
    available: boolean; lifecycle: ModelLifecycleStatus | null; firstSeenAt: string | null; displayName: string | null;
  }>();
  try {
    const rows = await query(
      `SELECT model, input_token_limit, output_token_limit, to_char(deprecation_date, 'YYYY-MM-DD') AS d,
              available, lifecycle, first_seen_at, display_name
         FROM ai_model_catalog WHERE provider = 'gemini'`,
    ).catch(() => query(
      `SELECT model, input_token_limit, output_token_limit, to_char(deprecation_date, 'YYYY-MM-DD') AS d,
              available, first_seen_at, display_name
         FROM ai_model_catalog WHERE provider = 'gemini'`,
    ));
    for (const r of rows) {
      const lc = ['stable', 'preview', 'experimental', 'deprecated'].includes(String(r.lifecycle)) ? r.lifecycle as ModelLifecycleStatus : null;
      fournisseur.set(String(r.model), {
        inputTokenLimit: r.input_token_limit == null ? null : Number(r.input_token_limit),
        outputTokenLimit: r.output_token_limit == null ? null : Number(r.output_token_limit),
        deprecationDate: r.d == null ? null : String(r.d),
        available: r.available == null ? true : Boolean(r.available),
        lifecycle: lc,
        firstSeenAt: r.first_seen_at == null ? null : new Date(String(r.first_seen_at)).toISOString(),
        displayName: r.display_name == null ? null : String(r.display_name),
      });
    }
  } catch (e) {
    notes.push(`Liste du fournisseur illisible (${(e as Error).message.slice(0, 120)}) : limites non complétées.`);
  }

  // Lot 35B : qualification (clé active) et catalogue tarifaire.
  const qualifs = deps.qualifications ?? await (await import('../provider/model-qualification.service')).loadQualifications().catch(() => new Map());
  const statutsPrix = deps.priceStatuses ?? await (await import('../gateway/pricing/pricing-sync.service')).loadPriceStatuses().catch(() => new Map());
  const statutDe = (model: string): ModelLifecycleStatus | 'unknown' => {
    const d = DECLARED_MODELS.find((x) => x.model === model);
    if (d) return d.status;
    const f = fournisseur.get(model);
    return f?.lifecycle ?? providerLifecycle({ model, displayName: f?.displayName ?? null }).status;
  };
  const qualifDe = (model: string): RegistryQualification | null => {
    const q = qualifs.get(model);
    if (q) {
      return { source: 'auto', generate: q.generate, structured: q.structured, multimodal: q.multimodal, thinking: q.thinking, qualifiedAt: q.qualifiedAt };
    }
    const d = DECLARED_MODELS.find((x) => x.model === model);
    return d
      ? { source: 'historical', generate: true, structured: d.capabilities.includes('structured_output'), multimodal: d.capabilities.includes('multimodal'), thinking: d.capabilities.includes('thinking'), qualifiedAt: null }
      : null;
  };

  // Usage effectif, opération par opération (configuration versionnée, sinon code).
  const { treatmentForUseCase } = await import('../config/treatments');
  const usages: Array<{ where: string; model: string; promptCode: string | null; rank: number }> = [];
  for (const op of Object.values(AI_OPERATIONS)) {
    if (op.provider === 'none' || op.active === false) continue;
    let t: string;
    try { t = treatmentForUseCase(op.useCaseCode); } catch { t = op.useCaseCode; }
    const c = await resolve(op.operationCode).catch(() => ({ primaryModel: op.primaryModel, fallbackModels: op.fallbackModels, maxOutputTokens: null }));
    [c.primaryModel, ...c.fallbackModels].filter(Boolean).forEach((model, rank) => usages.push({
      where: `${t} · ${op.operationCode}`, model, promptCode: op.masterPromptCode ?? op.promptCode ?? null, rank,
    }));
  }
  const issues: CoherenceIssue[] = checkModelUses(usages);

  const usagePar = new Map<string, string[]>();
  for (const u of usages) {
    const l = usagePar.get(u.model) ?? [];
    l.push(`${u.where} (${u.rank === 0 ? 'principal' : `repli ${u.rank}`})`);
    usagePar.set(u.model, l);
  }
  const saisies = (await import('@/services/verebona-assistant/registries/model-registry')).configuredDeprecations();
  const vue = (m: DeclaredModel | { provider: string; model: string }): RegistryViewModel => {
    const d = 'status' in m ? m : null;
    const f = fournisseur.get(m.model);
    const p = prix(m.provider, m.model);
    const status = statutDe(m.model);
    const sp = statutsPrix.get(m.model);
    return {
      provider: m.provider, model: m.model, status, statusLabel: MODEL_STATUS_LABELS[status],
      activatedOn: d?.activatedOn ?? null,
      retiresOn: d?.retiresOn ?? saisies.get(m.model) ?? f?.deprecationDate ?? null,
      capabilities: d?.capabilities ?? [],
      contextWindowTokens: d?.contextWindowTokens ?? f?.inputTokenLimit ?? null,
      maxOutputTokens: d?.maxOutputTokens ?? f?.outputTokenLimit ?? null,
      rateLimits: d?.rateLimits ?? { requestsPerMinute: null, tokensPerMinute: null },
      rollbackModel: d?.rollbackModel ?? null,
      note: [d?.anomaly, d?.note].filter(Boolean).join(' ') || undefined,
      price: p ? { inputPerMillion: p.inputMicros, outputPerMillion: p.outputMicros, source: p.sourceReference } : null,
      // Tarif servi au calcul : KNOWN ; sinon UNKNOWN, avec la raison relevée
      // par la synchronisation (jamais un montant de remplacement).
      pricing: p
        ? { status: 'KNOWN', reason: null, fetchedAt: sp?.fetchedAt ?? null, lastChangedAt: sp?.lastChangedAt ?? null }
        : { status: 'UNKNOWN', reason: sp?.reason ?? (sp ? null : 'jamais relevé'), fetchedAt: sp?.fetchedAt ?? null, lastChangedAt: sp?.lastChangedAt ?? null },
      qualification: qualifDe(m.model),
      declared: Boolean(d),
      exclusion: d?.excludedPrompts ? `${d.excludedPrompts.prompts.join(', ')} : ${d.excludedPrompts.reason}` : d?.forbidden ? `interdit : ${d.forbidden.reason}` : null,
      available: f ? f.available : null,
      firstSeenAt: f?.firstSeenAt ?? null,
      displayName: f?.displayName ?? null,
      usedBy: usagePar.get(m.model) ?? [],
    };
  };
  const declares = new Set(DECLARED_MODELS.map((m) => m.model));
  const autres = [...new Set([...fournisseur.keys(), ...usagePar.keys()])]
    .filter((m) => !declares.has(m))
    .sort()
    .map((model) => vue({ provider: 'gemini', model }));

  // Alias de l'assistant (§15.11) : lignes du registre.
  const reg = await import('@/services/verebona-assistant/registries/model-registry');
  const { getAssistantConfig } = await import('@/services/verebona-assistant/config/assistant-config');
  const cfg = getAssistantConfig();
  const t2 = await resolve('t2_answer').catch(() => null);
  const chaine = t2
    ? { operationCode: 't2_answer', default: t2.primaryModel || null, escalation: t2.fallbackModels[0] ?? null }
    : await reg.resolveAliases('t2_answer');
  const aliases = reg.modelRegistryRows(chaine, {
    qualification: qualifDe,
    providerStatus: (model) => { const s = statutDe(model); return s === 'unknown' ? null : s; },
    price: prix,
    providerCatalog: fournisseur,
    limits: {
      maxInputTokens: cfg.maxInputTokens,
      maxOutputTokens: t2?.maxOutputTokens ?? AI_OPERATIONS.t2_answer?.defaultMaxOutputTokens ?? null,
      timeoutMs: cfg.aiTimeoutMs,
      maxCallsPerMessage: cfg.maxAiCallsPerRequest,
    },
  });

  const { currentStartupVerdict, lastValidRegistry } = await import('@/services/verebona-assistant/core/model-startup-check');
  return {
    registryVersion: reg.MODEL_REGISTRY_VERSION,
    declaredModelsVersion: DECLARED_MODELS_VERSION,
    aliases,
    models: [...DECLARED_MODELS.map(vue), ...autres],
    coherence: issues,
    startup: { verdict: currentStartupVerdict(), lastValid: lastValidRegistry() },
    notes,
  };
}

export type ModelRegistryView = Awaited<ReturnType<typeof buildModelRegistryView>>;
