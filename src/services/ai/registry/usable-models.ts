/**
 * Modèles réellement utilisables par traitement — lot 32B, refondu au lot 35B
 * (ticket « Catalogue IA dynamique Google : modèles, tarifs, Preview et
 * alertes BO »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE SEULE DÉFINITION D'UN MODÈLE UTILISABLE
 *
 * `usableModelsForTreatment(treatment, ctx)` est la source de vérité des
 * modèles sélectionnables (principal, repli 1, repli 2 — même base pour les
 * trois rangs). Elle est lue par :
 *   · `GET /api/admin/ai/config-catalogs` (sélecteurs du BO) ;
 *   · `config-validation.service`, `config-version.service` (enregistrement
 *     d'un modèle nouvellement choisi, mise à l'essai, validation,
 *     activation) ;
 *   · le bandeau « Nouveau modèle Gemini disponible ».
 *
 * Hiérarchie (lot 35B) :
 *   DISPONIBILITÉ
 *     A. catalogue Google obtenu avec la clé active (`available`,
 *        `generateContent`) — un modèle retiré n'est plus proposé ;
 *     B. qualification technique Verebona, PAR CAPACITÉ requise par les
 *        opérations du traitement (génération, sortie structurée/schéma
 *        JSON, multimodal, raisonnement) — plus de compatibilité T1–T6
 *        déclarée à la main ;
 *     C. exclusion explicite Verebona (registre d'exceptions `models.ts` :
 *        interdit, exception documentée, déprécié / date de retrait) ;
 *     D. statut fournisseur EXPERIMENTAL → exclu (V1) ; PREVIEW → informatif ;
 *     E. pas explicitement non opérationnel avec la clé active.
 *   TARIFICATION : informative seulement (`priced`). Un modèle sans tarif
 *   connu (UNKNOWN) reste utilisable — NOT_PRICED n'existe plus.
 *   Plus de politique preview (réglage « preview_models_allowed », flag
 *   VEREBONA_ASSISTANT_ALLOW_PREVIEW_MODELS, PREVIEW_NOT_ALLOWED : supprimés).
 *
 * TRANSITION : une capacité jamais qualifiée automatiquement avec la clé
 * active est admise pour un modèle du registre qui la déclare (qualification
 * historique des lots 23–32B) — les sélecteurs ne se vident pas le temps de
 * la première synchronisation. Un modèle hors registre attend sa
 * qualification (`QUALIFICATION_PENDING`). Un résultat automatique prévaut
 * toujours.
 *
 * Module PUR pour l'évaluation (contexte injecté, testable sans base) ;
 * `loadUsableModelsContext` assemble le contexte réel (lectures en base et
 * en mémoire, aucun appel fournisseur).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { DECLARED_MODELS, type DeclaredModel, type ModelCapability, type ModelLifecycleStatus } from './models';
import { providerLifecycle } from './model-lifecycle';
import { AI_OPERATIONS, type AiOperationDefinition } from './operations';
import { TREATMENTS, TREATMENT_DEFINITIONS, type Treatment } from '../config/treatments';

export type UnusableReason =
  | 'NOT_LISTED'
  | 'PROVIDER_UNAVAILABLE'
  | 'NO_GENERATE_CONTENT'
  | 'NOT_VERIFIED'
  | 'EXPERIMENTAL'
  | 'FORBIDDEN'
  | 'EXCLUDED'
  | 'NOT_QUALIFIED'
  | 'QUALIFICATION_PENDING'
  | 'CAPABILITY_MISSING'
  | 'DEPRECATED'
  | 'RETIRED'
  | 'NOT_OPERATIONAL';

/** Libellés courts, en français (sélecteurs et messages du BO). */
export const UNUSABLE_REASON_LABELS: Readonly<Record<UnusableReason, string>> = {
  NOT_LISTED: 'absent du catalogue du fournisseur',
  PROVIDER_UNAVAILABLE: 'non servi par la clé active (retiré)',
  NO_GENERATE_CONTENT: 'génération non prise en charge',
  NOT_VERIFIED: 'disponibilité jamais vérifiée (actualisez le catalogue fournisseur)',
  EXPERIMENTAL: 'modèle expérimental (non sélectionnable)',
  FORBIDDEN: 'interdit par Verebona',
  EXCLUDED: 'exclu pour ce traitement (exception documentée)',
  NOT_QUALIFIED: 'qualification technique en échec',
  QUALIFICATION_PENDING: 'qualification technique en attente',
  CAPABILITY_MISSING: 'capacité requise non qualifiée',
  DEPRECATED: 'déprécié',
  RETIRED: 'retiré',
  NOT_OPERATIONAL: 'non opérationnel avec la clé active',
};

export interface ProviderModelState {
  model: string;
  available: boolean;
  supportsGeneration: boolean;
  /** Statut fournisseur (0303) ; absent : règle isolée appliquée au nom. */
  lifecycle?: ModelLifecycleStatus | null;
  displayName?: string | null;
}

/** Qualification automatique connue (clé active) — `model-qualification.service`. */
export interface QualificationState {
  generate: boolean;
  structured: boolean | null;
  multimodal: boolean | null;
  thinking: boolean | null;
}

export interface UsableModelsContext {
  environment: 'local' | 'preprod' | 'production';
  /** Catalogue du fournisseur ; `refreshedAt` nul : jamais vérifié. */
  catalog: { refreshedAt: string | null; models: readonly ProviderModelState[] };
  /** Catalogue du code (relevé embarqué) : repli hors production tant que jamais vérifié. */
  codeCatalog: readonly string[];
  /** Tarif connu (informatif), et s'il est vérifié (grille du compte). */
  price: (model: string) => { verified: boolean } | null;
  /** Dernière génération minimale connue AVEC LA CLÉ ACTIVE, par modèle. */
  operational: ReadonlyMap<string, { ok: boolean; checkedAt?: string | null; error?: string | null }>;
  /** Qualification automatique AVEC LA CLÉ ACTIVE, par modèle (vide : aucune). */
  qualifications?: ReadonlyMap<string, QualificationState>;
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
  /** Phrase lisible (« déprécié, qualification en attente »), vide si utilisable. */
  reasonText: string;
  /** Statut (exception déclarée, sinon statut fournisseur). */
  status: ModelLifecycleStatus;
  /** Tarif connu (informatif : jamais un motif de refus). */
  priced: boolean;
  /** Tarif de la grille du compte (opposable à la facture). */
  verifiedPrice: boolean;
  /** Disponibilité établie par le catalogue fournisseur rafraîchi. */
  providerVerified: boolean;
  /** Dernière génération connue avec la clé active (`null` : inconnue). */
  operational: boolean | null;
  /** `auto` : qualification automatique ; `historical` : registre (transition). */
  qualification: 'auto' | 'historical' | 'none';
}

/** Entrée d'un sélecteur (`modelsByTreatment`). */
export interface UsableModel {
  model: string;
  status: ModelLifecycleStatus;
  priced: boolean;
  /** Tarif vérifié (grille du compte). Nom repris de l'ancienne liste globale. */
  verified: boolean;
  providerVerified: boolean;
  operational: boolean | null;
  qualification: 'auto' | 'historical' | 'none';
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
 *     réussi avec la clé active est admis ;
 *   · jamais rafraîchi, hors production : catalogue du code, signalé « non
 *     vérifié » (`providerVerified: false`).
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

/** Statut d'un modèle : exception déclarée, sinon statut fournisseur, sinon règle isolée. */
export function modelStatus(model: string, ctx: Pick<UsableModelsContext, 'catalog' | 'declared'>): ModelLifecycleStatus {
  const declared = (ctx.declared ?? DECLARED_MODELS).find((m) => m.model === model);
  if (declared) return declared.status;
  const row = ctx.catalog.models.find((m) => m.model === model);
  if (row?.lifecycle) return row.lifecycle;
  return providerLifecycle({ model, displayName: row?.displayName ?? null }).status;
}

const CAP_KEY: Record<ModelCapability, keyof QualificationState> = {
  structured_output: 'structured', multimodal: 'multimodal', thinking: 'thinking',
};

/**
 * B — qualification par capacité requise. Résultat automatique (clé active)
 * s'il existe ; sinon qualification historique du registre ; sinon attente.
 */
function qualificationReasons(
  model: string, req: TreatmentRequirements, declared: DeclaredModel | undefined, ctx: UsableModelsContext,
): { reasons: UnusableReason[]; source: ModelEligibility['qualification'] } {
  const q = ctx.qualifications?.get(model);
  if (q && !q.generate) return { reasons: ['NOT_QUALIFIED'], source: 'auto' };
  const reasons = new Set<UnusableReason>();
  let historique = false;
  if (!q && !declared) reasons.add('QUALIFICATION_PENDING');
  if (!q && declared) historique = true;
  for (const cap of req.capabilities) {
    const v = q ? q[CAP_KEY[cap]] : null;
    if (v === true) continue;
    if (v === false) { reasons.add('CAPABILITY_MISSING'); continue; }
    // Non concluant ou jamais qualifié : qualification historique du registre.
    if (declared?.capabilities.includes(cap)) { historique = true; continue; }
    // Registre sans la capacité et aucun résultat automatique : absente ;
    // épreuve non concluante ou jamais jouée : en attente.
    reasons.add(declared && !q ? 'CAPABILITY_MISSING' : 'QUALIFICATION_PENDING');
  }
  return { reasons: [...reasons], source: q ? (historique ? 'historical' : 'auto') : declared ? 'historical' : 'none' };
}

/** Éligibilité d'UN modèle pour UN traitement, avec tous ses motifs de refus. */
export function evaluateModelForTreatment(treatment: Treatment, model: string, ctx: UsableModelsContext): ModelEligibility {
  const declared = (ctx.declared ?? DECLARED_MODELS).find((m) => m.model === model);
  const req = treatmentRequirements(treatment, ctx.operations ?? AI_OPERATIONS);
  const status = modelStatus(model, ctx);
  const reasons: UnusableReason[] = [];

  const dispo = providerAvailability(model, ctx);
  reasons.push(...dispo.reasons);

  // D — expérimental exclu en V1 (statut fournisseur) ; preview : informatif.
  if (status === 'experimental') reasons.push('EXPERIMENTAL');
  // C — exceptions Verebona.
  if (declared?.forbidden) reasons.push('FORBIDDEN');
  if (declared?.excludedPrompts && req.masterPromptCode && declared.excludedPrompts.prompts.includes(req.masterPromptCode)) reasons.push('EXCLUDED');
  if (status === 'deprecated') reasons.push('DEPRECATED');
  if (declared?.retiresOn && declared.retiresOn <= ctx.today) reasons.push('RETIRED');

  const qualif = qualificationReasons(model, req, declared, ctx);
  reasons.push(...qualif.reasons);

  const op = ctx.operational.get(model);
  if (op && !op.ok) reasons.push('NOT_OPERATIONAL');

  const price = ctx.price(model);
  return {
    treatment, model,
    usable: reasons.length === 0,
    reasons,
    reasonText: reasons.map((r) => UNUSABLE_REASON_LABELS[r]).join(', '),
    status,
    priced: price !== null,
    verifiedPrice: price?.verified ?? false,
    providerVerified: dispo.verified,
    operational: op ? op.ok : null,
    qualification: qualif.source,
  };
}

/** Modèles candidats : registre, listés par le fournisseur, catalogue du code. */
export function candidateModels(ctx: UsableModelsContext): string[] {
  const out: string[] = [];
  const add = (m: string) => { if (!out.includes(m)) out.push(m); };
  for (const m of ctx.declared ?? DECLARED_MODELS) add(m.model);
  for (const m of ctx.catalog.models) add(m.model);
  for (const m of ctx.codeCatalog) add(m);
  return out;
}

/**
 * SOURCE DE VÉRITÉ des modèles sélectionnables pour un traitement. Un modèle
 * non utilisable est ABSENT — jamais grisé.
 */
export function usableModelsForTreatment(treatment: Treatment, ctx: UsableModelsContext): UsableModel[] {
  return candidateModels(ctx)
    .map((m) => evaluateModelForTreatment(treatment, m, ctx))
    .filter((e) => e.usable)
    .map((e) => ({
      model: e.model, status: e.status, priced: e.priced, verified: e.verifiedPrice,
      providerVerified: e.providerVerified, operational: e.operational, qualification: e.qualification,
    }));
}

export function usableModelsByTreatment(ctx: UsableModelsContext): Record<Treatment, UsableModel[]> {
  return Object.fromEntries(TREATMENTS.map((t) => [t, usableModelsForTreatment(t, ctx)])) as Record<Treatment, UsableModel[]>;
}

/** Utilisable pour AU MOINS un traitement (bandeau « nouveau modèle »). */
export function usableForAnyTreatment(model: string, ctx: UsableModelsContext): boolean {
  return TREATMENTS.some((t) => evaluateModelForTreatment(t, model, ctx).usable);
}

/**
 * Modèles connus NON utilisables, avec leur motif, par traitement : sert au
 * BO à nommer une valeur enregistrée qui n'est plus proposée. Ne sert JAMAIS
 * de liste de choix.
 */
export function excludedModelsByTreatment(ctx: UsableModelsContext): Record<Treatment, Array<{ model: string; reasons: UnusableReason[]; reasonText: string }>> {
  const candidats = candidateModels(ctx);
  return Object.fromEntries(TREATMENTS.map((t) => [t, candidats
    .map((m) => evaluateModelForTreatment(t, m, ctx))
    .filter((e) => !e.usable)
    .map((e) => ({ model: e.model, reasons: e.reasons, reasonText: e.reasonText }))])) as Record<Treatment, Array<{ model: string; reasons: UnusableReason[]; reasonText: string }>>;
}

/**
 * Contexte réel : catalogue fournisseur (dernier rafraîchissement), grille
 * tarifaire en mémoire, état opérationnel et qualification avec la clé
 * active. Lectures seulement — AUCUN appel fournisseur.
 */
export async function loadUsableModelsContext(): Promise<UsableModelsContext> {
  const [{ GEMINI_PUBLIC_CATALOG }, pricing, { getCatalogState }, { loadOperationalStatuses }, { loadQualifications }, { getAiEnvironment }, secrets] = await Promise.all([
    import('../gateway/pricing/gemini-public-catalog'),
    import('../gateway/pricing/pricing.repository'),
    import('../provider/model-catalog.service'),
    import('../provider/model-operational.service'),
    import('../provider/model-qualification.service'),
    import('../config/environment'),
    import('../provider/provider-secret'),
  ]);
  if (pricing.getCacheState().loadedAt === null) await pricing.loadPricingCache().catch(() => undefined);
  const state = await getCatalogState().catch(() => ({ refreshedAt: null, models: [] as ProviderModelState[] }));
  // Environnement illisible : politique la plus prudente (production).
  let environment: UsableModelsContext['environment'] = 'production';
  try { environment = getAiEnvironment(); } catch { /* prudence */ }
  const secret = await secrets.getProviderSecret('gemini').catch(() => null);
  return {
    environment,
    catalog: {
      refreshedAt: state.refreshedAt,
      models: state.models.map((m) => ({
        model: m.model, available: m.available, supportsGeneration: m.supportsGeneration,
        lifecycle: (m as { lifecycle?: ModelLifecycleStatus }).lifecycle ?? null,
        displayName: (m as { displayName?: string | null }).displayName ?? null,
      })),
    },
    codeCatalog: GEMINI_PUBLIC_CATALOG.map((e) => e.model),
    price: (model) => {
      const p = pricing.getCachedPrice('gemini', model);
      return p ? { verified: Boolean(p.verified) } : null;
    },
    operational: await loadOperationalStatuses(secret),
    qualifications: await loadQualifications(secret),
    today: new Date().toISOString().slice(0, 10),
  };
}
