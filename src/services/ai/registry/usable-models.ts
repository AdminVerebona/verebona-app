/**
 * Modèles réellement utilisables par traitement — lot 32B, ticket « BO IA :
 * ne proposer que les modèles réellement utilisables par traitement » et
 * ticket « T2 — supprimer l'interdiction générale des modèles Pro ».
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE SEULE DÉFINITION D'UN MODÈLE UTILISABLE
 *
 * `usableModelsForTreatment(treatment, ctx)` est la source de vérité des
 * modèles sélectionnables (principal, repli 1, repli 2 — même base pour les
 * trois rangs). Elle est lue par :
 *   · `GET /api/admin/ai/config-catalogs` (`modelsByTreatment`, sélecteurs du
 *     BO — aucune règle recodée dans l'interface) ;
 *   · `config-validation.service` (contrôle bloquant à la mise à l'essai et à
 *     la validation), `config-version.service` (enregistrement d'un modèle
 *     nouvellement choisi, activation).
 * Le contrôle de démarrage de l'assistant garde ses contrôles d'exploitation
 * propres (alias, prix bloquant en production, rollback).
 *
 * Un modèle est utilisable pour un traitement si TOUTES les conditions
 * applicables sont satisfaites :
 *   A. servi par le fournisseur avec la clé active : présent au catalogue
 *      rafraîchi, `available`, `generateContent` (§7 : catalogue jamais
 *      vérifié → politique prudente, voir `providerAvailability`) ;
 *   B. déclaré au registre Verebona (`DECLARED_MODELS`) ;
 *   C. compatible : prompt maître du traitement déclaré dans
 *      `compatiblePrompts`, capacités requises par les opérations du
 *      traitement (sortie structurée, multimodal…) déclarées ;
 *   D. règles Verebona portées par le registre (compatibilité modèle par
 *      modèle) — AUCUNE règle sur le nom (« -pro », « flash ») ;
 *   E. preview : seulement si la politique preview effective l'autorise ;
 *   F. ni déprécié, ni arrivé à sa date de retrait ;
 *   G. tarif exploitable ;
 *   H. pas explicitement non opérationnel avec la clé active (dernière
 *      génération minimale connue — jamais d'appel fournisseur ici).
 *
 * Module PUR pour l'évaluation (contexte injecté, testable sans base) ;
 * `loadUsableModelsContext` assemble le contexte réel (lectures en base et
 * en mémoire, aucun appel fournisseur).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { DECLARED_MODELS, type DeclaredModel, type ModelCapability } from './models';
import { AI_OPERATIONS, type AiOperationDefinition } from './operations';
import { TREATMENTS, TREATMENT_DEFINITIONS, type Treatment } from '../config/treatments';

export type UnusableReason =
  | 'NOT_LISTED'
  | 'PROVIDER_UNAVAILABLE'
  | 'NO_GENERATE_CONTENT'
  | 'NOT_VERIFIED'
  | 'UNKNOWN_MODEL'
  | 'PROMPT_INCOMPATIBLE'
  | 'CAPABILITY_MISSING'
  | 'PREVIEW_NOT_ALLOWED'
  | 'DEPRECATED'
  | 'RETIRED'
  | 'NOT_PRICED'
  | 'NOT_OPERATIONAL';

/** Libellés courts, en français (sélecteurs et messages du BO). */
export const UNUSABLE_REASON_LABELS: Readonly<Record<UnusableReason, string>> = {
  NOT_LISTED: 'absent du catalogue du fournisseur',
  PROVIDER_UNAVAILABLE: 'non servi par la clé active',
  NO_GENERATE_CONTENT: 'génération non prise en charge',
  NOT_VERIFIED: 'disponibilité jamais vérifiée (actualisez le catalogue fournisseur)',
  UNKNOWN_MODEL: 'modèle inconnu du registre Verebona',
  PROMPT_INCOMPATIBLE: 'incompatible avec le prompt maître du traitement',
  CAPABILITY_MISSING: 'capacité requise absente',
  PREVIEW_NOT_ALLOWED: 'preview non autorisé',
  DEPRECATED: 'déprécié',
  RETIRED: 'retiré',
  NOT_PRICED: 'sans tarif',
  NOT_OPERATIONAL: 'non opérationnel avec la clé active',
};

export interface ProviderModelState {
  model: string;
  available: boolean;
  supportsGeneration: boolean;
}

export interface UsableModelsContext {
  environment: 'local' | 'preprod' | 'production';
  /** Catalogue du fournisseur ; `refreshedAt` nul : jamais vérifié. */
  catalog: { refreshedAt: string | null; models: readonly ProviderModelState[] };
  /** Catalogue du code (`gemini-public-catalog`) : repli hors production tant que jamais vérifié. */
  codeCatalog: readonly string[];
  /** Tarif exploitable connu, et s'il est vérifié (grille du compte). */
  price: (model: string) => { verified: boolean } | null;
  /** Politique preview effective, par traitement. */
  previewAllowed: (treatment: Treatment) => boolean;
  /** Dernière génération minimale connue AVEC LA CLÉ ACTIVE, par modèle. */
  operational: ReadonlyMap<string, { ok: boolean; checkedAt?: string | null; error?: string | null }>;
  /** AAAA-MM-JJ (dates de retrait). */
  today: string;
  /** Injection de test ; par défaut le registre. */
  declared?: readonly DeclaredModel[];
  operations?: Readonly<Record<string, AiOperationDefinition | undefined>>;
}

export interface ModelEligibility {
  treatment: Treatment;
  model: string;
  usable: boolean;
  reasons: UnusableReason[];
  /** Phrase lisible (« déprécié, sans tarif »), vide si utilisable. */
  reasonText: string;
  status: DeclaredModel['status'] | 'unknown';
  priced: boolean;
  /** Tarif de la grille du compte (opposable à la facture). */
  verifiedPrice: boolean;
  /** Disponibilité établie par le catalogue fournisseur rafraîchi. */
  providerVerified: boolean;
  /** Dernière génération connue avec la clé active (`null` : inconnue). */
  operational: boolean | null;
}

/** Entrée d'un sélecteur (`modelsByTreatment`). */
export interface UsableModel {
  model: string;
  status: DeclaredModel['status'];
  priced: boolean;
  /** Tarif vérifié (grille du compte). Nom repris de l'ancienne liste globale. */
  verified: boolean;
  providerVerified: boolean;
  operational: boolean | null;
}

export interface TreatmentRequirements {
  masterPromptCode: string | null;
  capabilities: ModelCapability[];
}

/**
 * Exigences d'un traitement, lues dans le référentiel des opérations : prompt
 * maître de ses opérations modèle, sortie structurée si l'une d'elles valide
 * une sortie JSON, et capacités explicitement requises (`requiredCapabilities`).
 */
export function treatmentRequirements(
  treatment: Treatment,
  operations: Readonly<Record<string, AiOperationDefinition | undefined>> = AI_OPERATIONS,
): TreatmentRequirements {
  const useCase = TREATMENT_DEFINITIONS[treatment].useCaseCode;
  let masterPromptCode: string | null = null;
  const caps = new Set<ModelCapability>();
  for (const op of Object.values(operations)) {
    if (!op || op.useCaseCode !== useCase || op.provider === 'none' || !op.active) continue;
    if (!masterPromptCode && op.masterPromptCode) masterPromptCode = op.masterPromptCode;
    if (op.jsonResponse || (op.outputSchema && op.outputSchema !== 'none' && op.outputFormat !== 'text')) caps.add('structured_output');
    for (const c of op.requiredCapabilities ?? []) caps.add(c);
  }
  return { masterPromptCode, capabilities: [...caps].sort() };
}

/**
 * A — disponibilité fournisseur (§7).
 *   · catalogue rafraîchi : il fait foi, un modèle absent n'est JAMAIS
 *     réintroduit par le catalogue du code ;
 *   · jamais rafraîchi, en production : seul un modèle dont une génération a
 *     réussi avec la clé active est admis — sinon absent (politique prudente :
 *     sa disponibilité réelle n'a jamais été établie) ;
 *   · jamais rafraîchi, hors production : catalogue du code (comportement
 *     antérieur), signalé « non vérifié » (`providerVerified: false`).
 */
function providerAvailability(model: string, ctx: UsableModelsContext): { reasons: UnusableReason[]; verified: boolean } {
  if (ctx.catalog.refreshedAt) {
    const row = ctx.catalog.models.find((m) => m.model === model);
    if (!row) return { reasons: ['NOT_LISTED'], verified: true };
    const reasons: UnusableReason[] = [];
    if (!row.available) reasons.push('PROVIDER_UNAVAILABLE');
    if (!row.supportsGeneration) reasons.push('NO_GENERATE_CONTENT');
    return { reasons, verified: true };
  }
  const op = ctx.operational.get(model);
  if (op?.ok) return { reasons: [], verified: false };
  if (ctx.environment === 'production') return { reasons: ['NOT_VERIFIED'], verified: false };
  return { reasons: ctx.codeCatalog.includes(model) ? [] : ['NOT_LISTED'], verified: false };
}

/** Éligibilité d'UN modèle pour UN traitement, avec tous ses motifs de refus. */
export function evaluateModelForTreatment(treatment: Treatment, model: string, ctx: UsableModelsContext): ModelEligibility {
  const declared = (ctx.declared ?? DECLARED_MODELS).find((m) => m.model === model);
  const req = treatmentRequirements(treatment, ctx.operations ?? AI_OPERATIONS);
  const reasons: UnusableReason[] = [];

  const dispo = providerAvailability(model, ctx);
  reasons.push(...dispo.reasons);

  if (!declared) {
    reasons.push('UNKNOWN_MODEL');
  } else {
    if (req.masterPromptCode && !declared.compatiblePrompts.includes(req.masterPromptCode)) reasons.push('PROMPT_INCOMPATIBLE');
    if (req.capabilities.some((c) => !declared.capabilities.includes(c))) reasons.push('CAPABILITY_MISSING');
    if (declared.status === 'preview' && !ctx.previewAllowed(treatment)) reasons.push('PREVIEW_NOT_ALLOWED');
    if (declared.status === 'deprecated') reasons.push('DEPRECATED');
    if (declared.retiresOn && declared.retiresOn <= ctx.today) reasons.push('RETIRED');
  }

  const price = ctx.price(model);
  if (!price) reasons.push('NOT_PRICED');

  const op = ctx.operational.get(model);
  if (op && !op.ok) reasons.push('NOT_OPERATIONAL');

  return {
    treatment, model,
    usable: reasons.length === 0,
    reasons,
    reasonText: reasons.map((r) => UNUSABLE_REASON_LABELS[r]).join(', '),
    status: declared?.status ?? 'unknown',
    priced: price !== null,
    verifiedPrice: price?.verified ?? false,
    providerVerified: dispo.verified,
    operational: op ? op.ok : null,
  };
}

/** Modèles candidats : déclarés, listés par le fournisseur, catalogue du code. */
export function candidateModels(ctx: UsableModelsContext): string[] {
  const out: string[] = [];
  const add = (m: string) => { if (!out.includes(m)) out.push(m); };
  for (const m of ctx.declared ?? DECLARED_MODELS) add(m.model);
  for (const m of ctx.catalog.models) add(m.model);
  for (const m of ctx.codeCatalog) add(m);
  return out;
}

/**
 * SOURCE DE VÉRITÉ des modèles sélectionnables pour un traitement (ordre du
 * registre déclaratif). Un modèle non utilisable est ABSENT — jamais grisé.
 */
export function usableModelsForTreatment(treatment: Treatment, ctx: UsableModelsContext): UsableModel[] {
  return candidateModels(ctx)
    .map((m) => evaluateModelForTreatment(treatment, m, ctx))
    .filter((e) => e.usable)
    .map((e) => ({
      model: e.model, status: e.status as DeclaredModel['status'], priced: e.priced, verified: e.verifiedPrice,
      providerVerified: e.providerVerified, operational: e.operational,
    }));
}

export function usableModelsByTreatment(ctx: UsableModelsContext): Record<Treatment, UsableModel[]> {
  return Object.fromEntries(TREATMENTS.map((t) => [t, usableModelsForTreatment(t, ctx)])) as Record<Treatment, UsableModel[]>;
}

/**
 * Modèles connus NON utilisables, avec leur motif, par traitement : sert au
 * BO à nommer une valeur enregistrée qui n'est plus proposée (« gemini-X —
 * indisponible (déprécié) »). Ne sert JAMAIS de liste de choix.
 */
export function excludedModelsByTreatment(ctx: UsableModelsContext): Record<Treatment, Array<{ model: string; reasons: UnusableReason[]; reasonText: string }>> {
  const candidats = candidateModels(ctx);
  return Object.fromEntries(TREATMENTS.map((t) => [t, candidats
    .map((m) => evaluateModelForTreatment(t, m, ctx))
    .filter((e) => !e.usable)
    .map((e) => ({ model: e.model, reasons: e.reasons, reasonText: e.reasonText }))])) as Record<Treatment, Array<{ model: string; reasons: UnusableReason[]; reasonText: string }>>;
}

/**
 * Politique preview effective (E), mêmes règles que les gardes existantes :
 *   · réglage « Modèles preview en production » accordé (double validation,
 *     lot 21) → autorisé partout ;
 *   · T2 : flag `VEREBONA_ASSISTANT_ALLOW_PREVIEW_MODELS` (contrôle de
 *     démarrage de l'assistant), sinon refusé dans TOUS les environnements ;
 *   · autres traitements : autorisés hors production (recette), refusés en
 *     production (`assertPreviewModelsApproved`).
 */
export function previewPolicy(p: {
  environment: UsableModelsContext['environment'];
  settingAllowed: boolean;
  assistantFlag: boolean;
}): (treatment: Treatment) => boolean {
  return (t) => {
    if (p.settingAllowed) return true;
    if (t === 'T2') return p.assistantFlag;
    return p.environment !== 'production';
  };
}

/**
 * Contexte réel : catalogue fournisseur (dernier rafraîchissement), grille
 * tarifaire en mémoire, politique preview, état opérationnel avec la clé
 * active. Lectures seulement — AUCUN appel fournisseur.
 */
export async function loadUsableModelsContext(): Promise<UsableModelsContext> {
  const [{ GEMINI_PUBLIC_CATALOG }, pricing, { getCatalogState }, { loadOperationalStatuses }, { getAiEnvironment }] = await Promise.all([
    import('../gateway/pricing/gemini-public-catalog'),
    import('../gateway/pricing/pricing.repository'),
    import('../provider/model-catalog.service'),
    import('../provider/model-operational.service'),
    import('../config/environment'),
  ]);
  if (pricing.getCacheState().loadedAt === null) await pricing.loadPricingCache().catch(() => undefined);
  const state = await getCatalogState().catch(() => ({ refreshedAt: null, models: [] as ProviderModelState[] }));
  let settingAllowed = false;
  try {
    const { refreshAssistantSettings, effectiveSetting } = await import('@/services/verebona-assistant/config/assistant-settings');
    await refreshAssistantSettings();
    settingAllowed = effectiveSetting('preview_models_allowed') === true;
  } catch { /* réglage illisible : non accordé */ }
  // Environnement illisible : politique la plus prudente (production).
  let environment: UsableModelsContext['environment'] = 'production';
  try { environment = getAiEnvironment(); } catch { /* prudence */ }
  return {
    environment,
    catalog: { refreshedAt: state.refreshedAt, models: state.models },
    codeCatalog: GEMINI_PUBLIC_CATALOG.map((e) => e.model),
    price: (model) => {
      const p = pricing.getCachedPrice('gemini', model);
      return p ? { verified: Boolean(p.verified) } : null;
    },
    previewAllowed: previewPolicy({
      environment, settingAllowed,
      assistantFlag: /^(on|true|1)$/i.test(process.env.VEREBONA_ASSISTANT_ALLOW_PREVIEW_MODELS ?? ''),
    }),
    operational: await loadOperationalStatuses(),
    today: new Date().toISOString().slice(0, 10),
  };
}
