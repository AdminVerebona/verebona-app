/**
 * Versions de configuration IA — orchestration — lot 54 (54C), ticket
 * « BO-IA — Refonte de la gestion des versions, restauration et export ».
 *
 * ══════════════════════════════════════════════════════════════════════════
 * NOUVEAU FONCTIONNEMENT (remplace WF-01 à WF-06 du CDC BO IA)
 *
 *   · Créer / dupliquer une version (non active par défaut), la nommer, la
 *     décrire, la consulter et la MODIFIER, active ou non.
 *   · « Activer en préproduction » : une seule active ; l'ancienne est
 *     désactivée dans la même transaction ; la version active reste
 *     modifiable et chaque sauvegarde s'applique aux prochaines exécutions
 *     sans réactivation.
 *   · Chaque sauvegarde effective crée une révision restaurable ; restaurer
 *     une révision en crée une nouvelle (l'historique n'est jamais réécrit).
 *   · Suppression logique des versions non actives, révisions conservées.
 *   · Aucune activation ni publication en production depuis ce module.
 *
 * Les contrôles qui BLOQUENT restent ceux d'avant pour chaque geste :
 *   · sauvegarde : modèle NOUVELLEMENT choisi utilisable (lot 32B) et
 *     architecture `master` (lot 16b) ; les autres contrôles de la
 *     configuration sont rendus en avertissements ;
 *   · activation d'une version jamais active : modèles utilisables et
 *     cohérence avec le registre (lot 23/32B) ; réactivation d'une version
 *     déjà active par le passé et restauration d'une révision : aucun
 *     contrôle bloquant (retour arrière toujours possible, WF-06).
 */
import { diffVersions, type ConfigDiff } from './config-diff.service';
import {
  validateVersion, capabilityIssues, type ConfigCatalogs, type ValidationResult,
} from './config-validation.service';
import { guardrailCodes, triggerCodes } from './catalogs';
import * as repo from './config-version.repository';
import {
  getVersion, getActiveVersion, ConfigVersionRefused, type WriteOutcome,
} from './config-version.repository';
import { promptArchitectureOf, type ConfigVersionWithEntries, type TreatmentConfig } from './config-types';
import { checkPromptArchitectureChange } from './prompt-architecture';
import { mergeSnapshot, type ConfigSnapshot, type MasterPromptRef } from './config-snapshot';
import { isTreatment, type Treatment } from './treatments';
import { getAiEnvironment } from './environment';
import { recordConfigAudit } from './config-entry.audit';

/** Refus fonctionnel — distinct d'une erreur technique. */
export class ConfigOperationRefused extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ConfigOperationRefused';
  }
}

/** Refus du dépôt → refus de service (même code). */
function asRefusal(e: unknown): never {
  if (e instanceof ConfigVersionRefused) throw new ConfigOperationRefused(e.code, e.message, e.details);
  throw e;
}

/**
 * Assemble les catalogues à partir du code et de la grille tarifaire (lot
 * 32B/35B : un seul contexte, celui de `usableModelsForTreatment`).
 */
export async function buildCatalogs(): Promise<ConfigCatalogs> {
  // Lot 85C : fiches de capacités à jour pour les contrôles techniques.
  await (await import('../provider/model-capabilities.repository')).ensureModelCapabilitiesLoaded();
  const { loadUsableModelsContext, evaluateModelForTreatment } = await import('../registry/usable-models');
  const { selectableModels } = await import('../provider/model-catalog.service');
  const ctx = await loadUsableModelsContext();
  const available = selectableModels(ctx.codeCatalog, ctx.catalog as never);
  const priced = new Set<string>([...available].filter((m) => ctx.price(m) !== null));
  return {
    modelEligibility: (treatment, model) => evaluateModelForTreatment(treatment, model, ctx),
    availableModels: available,
    pricedModels: priced,
    guardrailCodes: guardrailCodes(),
    triggerCodes: triggerCodes(),
    requireActiveTrigger: false,
  };
}

/** Champs « modèle » d'une ligne (principal et replis). */
const MODEL_FIELDS = ['primaryModel', 'fallback1', 'fallback2'] as const;

/**
 * Lot 32B, §5 — enregistrement : un modèle NOUVELLEMENT choisi (absent de la
 * ligne enregistrée à ce rang) doit être utilisable pour le traitement, et
 * ne pas doubler un autre rang. Une valeur déjà enregistrée et devenue
 * inutilisable reste acceptée : signalée, jamais bloquante pour les autres champs.
 */
export async function assertNewModelSelections(
  current: TreatmentConfig | null | undefined,
  next: TreatmentConfig,
  catalogs?: Pick<ConfigCatalogs, 'modelEligibility'>,
): Promise<void> {
  const nouveaux = MODEL_FIELDS.filter((f) => next[f] && next[f] !== (current?.[f] ?? null));
  if (nouveaux.length === 0) return;
  const eligibility = (catalogs ?? await buildCatalogs()).modelEligibility!;
  const refus: Array<{ field: string; model: string; message: string }> = [];
  for (const f of nouveaux) {
    const model = next[f]!;
    const autres = MODEL_FIELDS.filter((x) => x !== f).map((x) => next[x]);
    if (autres.includes(model)) {
      refus.push({ field: f, model, message: `« ${model} » est déjà choisi à un autre rang de la chaîne de ${next.treatment}.` });
      continue;
    }
    const e = eligibility(next.treatment, model);
    if (!e.usable) {
      refus.push({ field: f, model, message: `Le modèle « ${model} » n’est pas utilisable pour ${next.treatment} : ${e.reasonText}.` });
    }
  }
  if (refus.length > 0) {
    throw new ConfigOperationRefused('MODEL_NOT_USABLE', refus.map((r) => r.message).join(' '), refus);
  }
}

/** Incompatibilités techniques BLOQUANTES d'une ligne (profils, capacités), par message. */
function bloquantes(entry: TreatmentConfig | null): Set<string> {
  if (!entry) return new Set();
  return new Set(capabilityIssues(entry, {}).filter((i) => i.blocking).map((i) => `${i.field}|${i.message}`));
}

/**
 * Lot 85C — enregistrement : refuse une incompatibilité technique NOUVELLE
 * (absente de la ligne enregistrée) ; une incompatibilité déjà présente
 * (capacités changées depuis) reste signalée sans empêcher d'enregistrer
 * d'autres champs.
 */
export function assertNoNewTechnicalIncompatibility(current: TreatmentConfig | null, next: TreatmentConfig): void {
  const avant = bloquantes(current);
  const nouvelles = [...bloquantes(next)].filter((k) => !avant.has(k));
  if (nouvelles.length > 0) {
    throw new ConfigOperationRefused('MODEL_PARAMETERS_INCOMPATIBLE',
      `Configuration techniquement incompatible pour ${next.treatment} : ${nouvelles.map((k) => k.split('|').slice(1).join('|')).join(' ')}`,
      nouvelles.map((k) => ({ field: k.split('|')[0], message: k.split('|').slice(1).join('|') })));
  }
}

/** Motifs d'éligibilité qui restent BLOQUANTS à une réactivation (contrôles techniques, décision PO 06). */
const REACTIVATION_BLOCKING = new Set(['PREVIEW', 'NOT_LISTED', 'PROVIDER_UNAVAILABLE', 'EXPERIMENTAL', 'FORBIDDEN', 'RETIRED', 'NO_GENERATE_CONTENT']);

/**
 * Lot 85C (décisions PO 02 et 06, CFG-03) — contrôles TECHNIQUES de toute
 * activation, réactivation comprise : combinaisons modèle / paramètres
 * connues comme incompatibles (constructeur unique), modèle Preview (aucune
 * nouvelle activation non conforme), modèle non servi par la clé active.
 * Aucun test métier imposé.
 */
export async function assertVersionTechnicallyCompatible(
  version: Pick<ConfigVersionWithEntries, 'entries'>,
  catalogs?: Pick<ConfigCatalogs, 'modelEligibility' | 'capabilities'>,
): Promise<void> {
  const cat = catalogs ?? await buildCatalogs();
  const refus: Array<{ treatment: string; field: string; message: string }> = [];
  for (const e of version.entries) {
    for (const i of capabilityIssues(e, cat)) {
      if (i.blocking) refus.push({ treatment: e.treatment, field: i.field, message: `${e.treatment} · ${i.message}` });
    }
    for (const f of MODEL_FIELDS) {
      const model = e[f];
      if (!model || !cat.modelEligibility) continue;
      const r = cat.modelEligibility(e.treatment, model);
      const motifs = r.reasons.filter((x) => REACTIVATION_BLOCKING.has(x));
      if (motifs.length) refus.push({ treatment: e.treatment, field: f, message: `${e.treatment} · « ${model} » : ${r.reasonText}.` });
    }
  }
  if (refus.length > 0) {
    throw new ConfigOperationRefused('TECHNICAL_CHECK_FAILED', `Activation impossible (contrôles techniques) : ${refus.map((r) => r.message).join(' ')}`, refus);
  }
}

async function load(versionId: number): Promise<ConfigVersionWithEntries> {
  const version = await getVersion(versionId);
  if (!version) {
    throw new ConfigOperationRefused('VERSION_NOT_FOUND', `Version ${versionId} introuvable.`);
  }
  return version;
}

/**
 * Caches locaux vidés après une écriture validée (la clé partagée a déjà été
 * incrémentée DANS la transaction : les autres instances suivent dès le
 * commit). Prompts maîtres basculés : cache du chargeur de prompts aussi.
 */
export async function afterCommit(reason: string, switches: WriteOutcome['masterPromptSwitches'] = []): Promise<void> {
  const [{ invalidateConfigCache }, { invalidateConfigVersionCache }, { forgetConfigVersionCounter, bumpConfigVersionCounter, hasTestCounterStore }, { invalidatePromptCache }] = await Promise.all([
    import('./config-resolver'),
    import('../telemetry/execution-context'),
    import('./config-cache-version'),
    import('../prompts/prompt-loader'),
  ]);
  // Stockage de test injecté (plusieurs « instances » simulées) : il ne voit
  // pas la base — on l'incrémente aussi, comme avant le lot 54.
  if (hasTestCounterStore()) await bumpConfigVersionCounter(reason);
  forgetConfigVersionCounter();
  invalidateConfigCache();
  invalidateConfigVersionCache();
  for (const s of switches) invalidatePromptCache(s.masterPromptCode);
  // Lot 99B : toute activation ou modification de configuration relance la détection des contrats de prompt (différée, non bloquante).
  void import('../prompt-conformity/trigger').then(({ notifyConfigurationChanged }) => notifyConfigurationChanged(reason)).catch(() => undefined);
  // CDC Assistant §15.14 : tout changement de configuration effective refait
  // le contrôle du registre de modèles de l'assistant (non bloquant).
  void import('@/services/verebona-assistant/core/model-startup-check')
    .then(({ runAssistantStartupCheck }) => runAssistantStartupCheck('config_change'))
    .catch(() => { /* contrôle impossible : journalisé par le module */ });
}

// ── Création, duplication ───────────────────────────────────────────────────

export async function createConfigVersion(userId: number, p: {
  label?: string | null; description?: string | null;
  /** Dupliquer cette version (sa révision courante). */
  sourceVersionId?: number | null;
  /** Repartir d'une révision précise (récupération, version supprimée comprise). */
  sourceRevisionId?: number | null;
  /** Sans source : copie de la configuration active (sinon configuration vide). */
}): Promise<ConfigVersionWithEntries> {
  const source = p.sourceRevisionId ? { revisionId: p.sourceRevisionId }
    : p.sourceVersionId ? { versionId: p.sourceVersionId } : { active: true as const };
  const v = await repo.createVersion({ userId, label: p.label ?? null, description: p.description ?? null, source }).catch(asRefusal);
  await recordConfigAudit('ai_config_version_create', userId, null, {
    versionId: v.id, number: v.visibleNumber, label: v.label, source,
  });
  return v;
}

/** Compatibilité : « Créer un brouillon » = nouvelle version copiée de l'active. */
export async function startDraft(userId: number, label?: string): Promise<ConfigVersionWithEntries> {
  return createConfigVersion(userId, { label: label ?? null });
}

// ── Sauvegarde ──────────────────────────────────────────────────────────────

export interface SaveInput {
  /** Révision éditée (contrôle de concurrence). Obligatoire depuis l'écran. */
  expectedRevision: number | null;
  /** Traitements modifiés (configuration complète de chacun). */
  entries?: TreatmentConfig[];
  /** Prompt maître retenu par traitement : id de version, `null` = non piloté. */
  masterPromptVersionIds?: Partial<Record<Treatment, number | null>>;
  label?: string | null;
  description?: string | null;
  comment?: string | null;
}

export interface SaveResult {
  versionId: number;
  revisionNumber: number;
  changed: boolean;
  active: boolean;
  /** Contrôles non bloquants de la configuration enregistrée. */
  warnings: string[];
}

async function resolveMasterPromptRefs(
  ids: Partial<Record<Treatment, number | null>> | undefined,
  environment: string,
): Promise<ConfigSnapshot['masterPrompts']> {
  const out: ConfigSnapshot['masterPrompts'] = {};
  for (const [t, id] of Object.entries(ids ?? {})) {
    if (!isTreatment(t)) continue;
    if (id == null) { out[t] = null; continue; }
    const ref = await repo.getMasterPromptVersionRef(id);
    if (!ref || ref.treatment !== t || ref.environment !== environment) {
      throw new ConfigOperationRefused('MASTER_PROMPT_VERSION_NOT_FOUND', `Version de prompt maître ${id} introuvable pour ${t}.`);
    }
    if (ref.status === 'DRAFT') {
      throw new ConfigOperationRefused('MASTER_PROMPT_IS_DRAFT',
        `Le prompt maître ${t} v${ref.versionNumber} est un brouillon : activez-le dans « Prompts maîtres » avant de le retenir.`);
    }
    const { treatment: _t, environment: _e, status: _s, ...pure } = ref;
    out[t] = pure as MasterPromptRef;
  }
  return out;
}

/**
 * Enregistre la configuration d'une version (active ou non) : UNE révision
 * pour l'ensemble des traitements modifiés, ou rien si rien ne change.
 */
export async function saveConfiguration(versionId: number, input: SaveInput, userId: number): Promise<SaveResult> {
  const version = await load(versionId);
  if (version.deletedAt) {
    throw new ConfigOperationRefused('VERSION_DELETED', 'Cette version a été supprimée : restaurez-la dans la liste avant de la modifier.');
  }
  // Contrôle précoce (revérifié sous verrou par le dépôt).
  if (input.expectedRevision != null && version.currentRevisionNumber != null && input.expectedRevision !== version.currentRevisionNumber) {
    throw new ConfigOperationRefused('REVISION_CONFLICT',
      `La version a été enregistrée entre-temps (révision ${version.currentRevisionNumber}, vous éditiez la révision ${input.expectedRevision}). `
      + 'Rechargez-la : vos modifications non enregistrées ne sont pas appliquées.',
      { currentRevision: version.currentRevisionNumber, expectedRevision: input.expectedRevision });
  }
  const entries: TreatmentConfig[] = [];
  let catalogs: ConfigCatalogs | null = null;
  if ((input.entries ?? []).length) await (await import('../provider/model-capabilities.repository')).ensureModelCapabilitiesLoaded();
  for (const raw of input.entries ?? []) {
    if (!isTreatment(String(raw.treatment))) {
      throw new ConfigOperationRefused('UNKNOWN_TREATMENT', `Traitement « ${String(raw.treatment)} » inconnu ou retiré.`);
    }
    const current = version.entries.find((e) => e.treatment === raw.treatment);
    // Champ omis (client antérieur) : architecture et texte master en place.
    const next = raw.promptArchitecture === undefined && current ? promptArchitectureOf(current) : (raw.promptArchitecture ?? promptArchitectureOf(raw));
    const decision = checkPromptArchitectureChange({
      status: version.status, treatment: raw.treatment,
      from: current ? promptArchitectureOf(current) : null, to: next,
    });
    if (!decision.allowed) throw new ConfigOperationRefused(decision.code, decision.message);
    const masterPrompt = raw.masterPrompt === undefined ? (current?.masterPrompt ?? null) : raw.masterPrompt;
    const entry: TreatmentConfig = { ...raw, promptArchitecture: next, masterPrompt };
    // Lot 85C : champ omis (client antérieur) → profils en place conservés.
    if (raw.operationProfiles === undefined) entry.operationProfiles = current?.operationProfiles ?? {};
    // Lot 32B, §5 : le filtrage du BO n'est pas une règle de sécurité.
    const nouveaux = MODEL_FIELDS.some((f) => entry[f] && entry[f] !== (current?.[f] ?? null));
    if (nouveaux) {
      catalogs ??= await buildCatalogs();
      await assertNewModelSelections(current, entry, catalogs);
    }
    // Lot 85C (ACT-02, CFG-03) : modification directe autorisée sans tests
    // métier, mais une incompatibilité TECHNIQUE nouvelle (profil invalide,
    // combinaison modèle / paramètres connue comme refusée) reste bloquante.
    assertNoNewTechnicalIncompatibility(current ?? null, entry);
    entries.push(entry);
  }
  const masterPrompts = await resolveMasterPromptRefs(input.masterPromptVersionIds, version.environment);

  const outcome = await repo.writeSnapshot({
    versionId, userId, kind: 'save', expectedRevision: input.expectedRevision,
    comment: input.comment ?? null,
    label: input.label === undefined ? undefined : (input.label?.trim() || null),
    description: input.description === undefined ? undefined : (input.description?.trim() || null),
    next: (cur) => mergeSnapshot(cur, { entries, masterPrompts }),
  }).catch(asRefusal);

  if (outcome.changed) {
    await afterCommit(`save:${versionId}:r${outcome.revisionNumber}`, outcome.masterPromptSwitches);
    await recordConfigAudit('ai_config_version_save', userId,
      { versionId, revision: version.currentRevisionNumber },
      { versionId, revision: outcome.revisionNumber, active: outcome.active, treatments: entries.map((e) => e.treatment), masterPrompts: Object.keys(masterPrompts) });
  }
  // Contrôles non bloquants de ce qui est désormais enregistré.
  let warnings: string[] = [];
  try {
    const saved = await load(versionId);
    const v = validateVersion(saved.entries, catalogs ?? await buildCatalogs());
    warnings = v.issues.map((i) => `${i.treatment} · ${i.label} : ${i.message}`);
  } catch { /* contrôles indisponibles : la sauvegarde est faite */ }
  return { versionId, revisionNumber: outcome.revisionNumber, changed: outcome.changed, active: outcome.active, warnings };
}

/**
 * Compatibilité (route historique par traitement, scénarios antérieurs) :
 * enregistre UN traitement. Rend les valeurs avant / après (journal T4).
 */
export async function saveTreatmentConfig(
  versionId: number,
  config: TreatmentConfig,
  userId: number,
  expectedRevision: number | null = null,
): Promise<{ before: TreatmentConfig | null; after: TreatmentConfig; revisionNumber: number }> {
  const version = await load(versionId);
  const before = version.entries.find((e) => e.treatment === config.treatment) ?? null;
  const r = await saveConfiguration(versionId, { expectedRevision, entries: [config] }, userId);
  const after = (await load(versionId)).entries.find((e) => e.treatment === config.treatment) ?? config;
  return { before, after, revisionNumber: r.revisionNumber };
}

// ── Restauration d'une révision ─────────────────────────────────────────────

/**
 * Restaure INTÉGRALEMENT une révision antérieure d'une version : nouvelle
 * révision identique à celle choisie (les révisions intermédiaires restent).
 * Version active : appliquée aux prochaines exécutions, sans réactivation.
 */
export async function restoreRevision(versionId: number, revisionId: number, userId: number, opts: {
  expectedRevision?: number | null; comment?: string | null;
} = {}): Promise<SaveResult> {
  const rev = await repo.getRevision(revisionId);
  if (!rev || rev.versionId !== versionId) {
    throw new ConfigOperationRefused('REVISION_NOT_FOUND', `Révision ${revisionId} introuvable pour cette version.`);
  }
  const outcome = await repo.writeSnapshot({
    versionId, userId, kind: 'restore', expectedRevision: opts.expectedRevision ?? null,
    restoredFrom: rev.id,
    comment: opts.comment?.trim() || `Restauration de la révision ${rev.revisionNumber}`,
    next: () => rev.snapshot,
  }).catch(asRefusal);
  await afterCommit(`restore:${versionId}:r${outcome.revisionNumber}`, outcome.masterPromptSwitches);
  await recordConfigAudit('ai_config_revision_restore', userId,
    { versionId, fromRevision: rev.revisionNumber },
    { versionId, revision: outcome.revisionNumber, active: outcome.active });
  const warnings = (await assertModelRegistryCoherence(rev.snapshot).catch((e: ConfigOperationRefused) => [{ message: e.message }])).map((i) => i.message);
  return { versionId, revisionNumber: outcome.revisionNumber, changed: true, active: outcome.active, warnings };
}

// ── Diff et contrôles, sans écriture ────────────────────────────────────────

/** Diff d'une version contre l'active de son environnement. */
export async function diffAgainstActive(versionId: number): Promise<{
  diff: ConfigDiff;
  version: ConfigVersionWithEntries;
  active: ConfigVersionWithEntries | null;
}> {
  const version = await load(versionId);
  const active = await getActiveVersion(version.environment);
  return { diff: diffVersions(active?.entries ?? [], version.entries), version, active };
}

export async function checkVersion(versionId: number): Promise<ValidationResult> {
  const version = await load(versionId);
  return validateVersion(version.entries, await buildCatalogs());
}

// ── §15.12, §15.14 — cohérence avec le registre des modèles (lot 23) ────────

/**
 * Contrôle de cohérence d'une configuration avec les EXCEPTIONS du registre
 * des modèles : modèle interdit ou exclu pour le prompt maître → erreur
 * (`MODEL_REGISTRY_INCOHERENT`) ; déprécié, anomalie connue → avertissement.
 */
export async function assertModelRegistryCoherence(
  version: Pick<ConfigVersionWithEntries, 'entries'>,
): Promise<import('../registry/models').CoherenceIssue[]> {
  const [{ checkModelUses }, { AI_OPERATIONS }, { treatmentForUseCase }] = await Promise.all([
    import('../registry/models'), import('../registry/operations'), import('./treatments'),
  ]);
  const masterDe = new Map<string, string>();
  for (const op of Object.values(AI_OPERATIONS)) {
    if (!op.masterPromptCode) continue;
    try {
      const t = treatmentForUseCase(op.useCaseCode);
      if (!masterDe.has(t)) masterDe.set(t, op.masterPromptCode);
    } catch { /* usage sans traitement : hors configuration versionnée */ }
  }
  const uses = version.entries.flatMap((e) => [e.primaryModel, e.fallback1, e.fallback2]
    .filter((m): m is string => typeof m === 'string' && m.trim() !== '')
    .map((model) => ({ where: e.treatment, model, promptCode: masterDe.get(e.treatment) ?? null })));
  const issues = checkModelUses(uses);
  const erreurs = issues.filter((i) => i.level === 'error');
  if (erreurs.length > 0) {
    throw new ConfigOperationRefused(
      'MODEL_REGISTRY_INCOHERENT',
      `Configuration incohérente avec le registre des modèles : ${erreurs.map((i) => i.message).join(' ')}`,
      erreurs,
    );
  }
  return issues.filter((i) => i.level === 'warning');
}

/**
 * Lot 32B, §5 — activation : chaque modèle (principal, replis) doit être
 * utilisable pour son traitement au moment de l'activation.
 */
export async function assertVersionModelsUsable(
  version: Pick<ConfigVersionWithEntries, 'entries'>,
  catalogs?: Pick<ConfigCatalogs, 'modelEligibility'>,
): Promise<void> {
  const eligibility = (catalogs ?? await buildCatalogs()).modelEligibility!;
  const refus: Array<{ treatment: string; field: string; model: string; message: string }> = [];
  for (const e of version.entries) {
    for (const f of MODEL_FIELDS) {
      const model = e[f];
      if (!model) continue;
      const r = eligibility(e.treatment, model);
      if (!r.usable) {
        refus.push({ treatment: e.treatment, field: f, model, message: `Le modèle « ${model} » n’est pas utilisable pour ${e.treatment} : ${r.reasonText}.` });
      }
    }
  }
  if (refus.length > 0) {
    throw new ConfigOperationRefused('MODEL_NOT_USABLE', `Activation impossible : ${refus.map((i) => i.message).join(' ')}`, refus);
  }
}

// ── Activation ──────────────────────────────────────────────────────────────

export interface SwitchResult {
  previousId: number | null;
  /** Toujours `false` : les exécutions démarrées gardent leur révision. */
  interrupts: boolean;
  /** Toujours 0 (plus de remise en file à l'activation). */
  requeuedJobs: number;
  revisionNumber: number;
  alreadyActive: boolean;
  /** Avertissements du registre des modèles. */
  warnings?: string[];
}

/**
 * « Activer en préproduction » (ou réactiver une version précédente) : le
 * dernier état enregistré de la version devient la configuration appliquée
 * aux nouveaux démarrages, atomiquement.
 *
 * Rien ici n'agit sur un AUTRE environnement : la préproduction n'active ni
 * ne publie jamais en production. Dans la console de production elle-même
 * (paramétrage indépendant, à partir du fichier exporté), l'activation exige
 * la confirmation explicite de l'environnement, vérifiée par le serveur.
 */
export async function activate(versionId: number, userId: number, opts: { confirmProduction?: boolean } = {}): Promise<SwitchResult> {
  if (getAiEnvironment() === 'production' && opts.confirmProduction !== true) {
    throw new ConfigOperationRefused('PRODUCTION_CONFIRMATION_REQUIRED',
      'Environnement de PRODUCTION : saisissez « production » pour confirmer l’activation.');
  }
  const version = await load(versionId);
  if (version.deletedAt) {
    throw new ConfigOperationRefused('VERSION_DELETED', 'Cette version a été supprimée : restaurez-la dans la liste avant de l’activer.');
  }
  let warnings: string[] = [];
  // Version jamais active : mêmes contrôles qu'avant (lot 23, 32B). Déjà
  // active par le passé : retour arrière sans test métier (WF-06), MAIS
  // lot 85C (décision PO 06) : les contrôles TECHNIQUES (capacités, Preview,
  // modèle servi par la clé) s'appliquent à toute activation.
  const catalogs = await buildCatalogs();
  if (version.activatedAt === null && !version.active) {
    await assertVersionModelsUsable(version, catalogs);
    await assertVersionTechnicallyCompatible(version, catalogs);
    warnings = (await assertModelRegistryCoherence(version)).map((i) => i.message);
  } else {
    if (!version.active) await assertVersionTechnicallyCompatible(version, catalogs);
    warnings = (await assertModelRegistryCoherence(version).catch((e: ConfigOperationRefused) => [{ message: e.message }])).map((i) => i.message);
  }
  const r = await repo.activateVersion(versionId, userId).catch(asRefusal);
  if (!r.alreadyActive) {
    await afterCommit(`activate:${versionId}:r${r.revisionNumber}`, r.masterPromptSwitches);
    await recordConfigAudit('ai_config_version_activate', userId,
      { activeVersionId: r.previousId },
      { activeVersionId: versionId, revision: r.revisionNumber });
  }
  return { previousId: r.previousId, interrupts: false, requeuedJobs: 0, revisionNumber: r.revisionNumber, alreadyActive: r.alreadyActive, warnings };
}

/** Compatibilité : « Restaurer » une ancienne version = la réactiver. */
export async function rollback(versionId: number, userId: number, opts: { confirmProduction?: boolean } = {}): Promise<SwitchResult> {
  return activate(versionId, userId, opts);
}

// ── Suppression ─────────────────────────────────────────────────────────────

/** Suppression LOGIQUE d'une version non active (révisions conservées). */
export async function deleteConfigVersion(versionId: number, userId: number): Promise<void> {
  await load(versionId);
  const r = await repo.deleteVersion(versionId, userId).catch(asRefusal);
  if (!r.alreadyDeleted) await recordConfigAudit('ai_config_version_delete', userId, { versionId }, { versionId, deleted: true });
}

/** Compatibilité : « Archiver » = supprimer (logiquement). */
export async function archive(versionId: number, userId = 0): Promise<void> {
  return deleteConfigVersion(versionId, userId);
}

/** Remet une version supprimée dans la liste, NON active. */
export async function restoreDeletedVersion(versionId: number, userId: number): Promise<void> {
  await load(versionId);
  await repo.undeleteVersion(versionId, userId).catch(asRefusal);
  await recordConfigAudit('ai_config_version_undelete', userId, { versionId, deleted: true }, { versionId, deleted: false });
}

// ── Lot 86A : candidates automatiques (VER-01, ACT-01, décision PO 06) ──────

/**
 * Prépare une candidate AUTOMATIQUE : copie de la configuration active dont
 * le modèle principal d'un traitement est remplacé, créée NON active (l'active
 * n'est jamais modifiée pendant les tests), origine `auto`, état `CREATED`.
 * Action du système : aucun auteur humain (`created_by` nul), raison tracée.
 */
export async function createAutomaticCandidate(p: {
  treatment: Treatment; primaryModel: string; key: string; reason: string; campaignId: number | null;
  /** Lot 113I : objectif d'amélioration et numéro de variante (≤ maximum administré). */
  objective?: { id: number; variant: number } | null;
}): Promise<ConfigVersionWithEntries> {
  const v = await repo.createVersion({
    userId: null, label: `Candidate automatique ${p.treatment} · ${p.primaryModel}`.slice(0, 200), description: p.reason.slice(0, 1000),
    source: { active: true },
    candidate: {
      key: p.key, reason: p.reason, campaignId: p.campaignId, treatment: p.treatment, objective: p.objective ?? null,
      transform: (s) => ({ ...s, entries: s.entries.map((e) => (e.treatment === p.treatment ? { ...e, primaryModel: p.primaryModel } : e)) }),
    },
  }).catch(asRefusal);
  return v;
}

/**
 * Active AUTOMATIQUEMENT une candidate QUALIFIÉE — en PRÉPRODUCTION
 * seulement (décision 06, VER-01, OBJ-04 : la production n'expérimente pas de
 * nouveau couple). Contrôles techniques de toute activation conservés
 * (capacités, Preview, modèle servi par la clé).
 *
 * Lot 105B (§3, R5) : l'objet A1 transmis n'est qu'une RÉCLAMATION. Tout est
 * revalidé DEPUIS LA BASE ici (`promotion-gate.revalidatePromotion` : état
 * QUALIFIED, préproduction, identité candidate + traitement + campagne,
 * décision A1 journalisée et COURANTE, empreintes corpus / oracles / contrats
 * / profils / modèles, preuve admissible de chaque opération, verrou A1
 * recalculé sur les résultats persistés, gel) puis dans la TRANSACTION finale
 * (`transactionGuard` : certification, configuration active, révision,
 * campagne, gel inchangés). Tout refus est journalisé avec la version de
 * référence. L'activation manuelle (#345) ne passe jamais par ici.
 */
export async function activateQualifiedCandidate(versionId: number, opts: {
  summary?: string;
  /**
   * Réclamation du VERROU A1 rendue par `certification/promotion.assessPromotion` (jeton désignant l'évaluation
   * journalisée, la campagne, la candidate, le périmètre et l'empreinte de contexte). Jamais suffisante seule.
   */
  a1?: unknown;
  /** Lot 105B : options de cas de la campagne (mêmes empreintes de corpus que la qualification). */
  caseOptions?: import('../qualification/promotion-gate').GateCaseOptions;
  /** Lot 113I : contexte de la surveillance persistée dans la transaction de promotion (SQL-006). */
  watch?: { campaignId?: number | null; operations?: string[]; now?: Date };
} = {}): Promise<SwitchResult & { reference?: import('../qualification/promotion-gate').GateReference; targeted?: repo.TargetedPromotionRecord | null }> {
  if (getAiEnvironment() === 'production') {
    throw new ConfigOperationRefused('CANDIDATE_ACTIVATION_PREPROD_ONLY',
      'Activation automatique d’une candidate refusée : elle n’a lieu qu’en préproduction (la production importe le fichier global, décision 06).');
  }
  const version = await load(versionId);
  if (version.origin !== 'auto') {
    throw new ConfigOperationRefused('CANDIDATE_NOT_QUALIFIED', 'Seule une candidate automatique peut être activée par l’optimisation (une version manuelle s’active à la main).');
  }
  if (version.candidateState !== 'QUALIFIED') {
    throw new ConfigOperationRefused('CANDIDATE_NOT_QUALIFIED',
      `Version ${versionId} : seule une candidate automatique QUALIFIÉE peut être activée automatiquement (état ${version.candidateState ?? 'aucun'}).`);
  }
  if (!opts.a1) {
    throw new ConfigOperationRefused('A1_COVERAGE_LOCK',
      'Activation automatique refusée : verrou A1 non levé (couverture du corpus de qualification insuffisante ou non évaluée). L’activation manuelle reste possible.');
  }
  const gate = await import('../qualification/promotion-gate');
  const d = await gate.revalidatePromotion({ versionId, claim: opts.a1, caseOptions: opts.caseOptions });
  if (!d.ok) {
    throw new ConfigOperationRefused('PROMOTION_REVALIDATION_REFUSED',
      `Activation automatique refusée après revalidation depuis la base (${d.code}) : ${gate.GATE_CODE_LABELS[d.code!]} — ${d.reasons.join(' ; ')}`.slice(0, 1500),
      { gateCode: d.code, reference: d.reference });
  }
  await assertVersionTechnicallyCompatible(version);
  const { recordPromotionEvent } = await import('../qualification/promotion-journal');
  // Lot 113I (PRO-03..05, SQL-004..006) : promotion CIBLÉE — seule la part du traitement qualifié est fusionnée sur la
  // DERNIÈRE configuration active ; état antérieur du traitement et surveillance WATCHING dans le même commit.
  const { initialWatch } = await import('../qualification/promotion-watch');
  let r: Awaited<ReturnType<typeof repo.promoteTreatment>>;
  // Lot 114 (carte #771, A03) : contrôle FINAL de disponibilité dans la transaction d'activation — un modèle de la
  // chaîne promue confirmé indisponible depuis le démarrage des tests ou le verrou A1 fait refuser l'activation
  // (`BLOCKED_MODEL_UNAVAILABLE`, journalisé) ; les preuves de qualification de la candidate sont conservées.
  const gardeA1 = gate.transactionGuard(d.reference);
  const chainePromue = version.entries.filter((e) => d.reference.treatment === null || e.treatment === d.reference.treatment)
    .flatMap((e) => MODEL_FIELDS.map((f) => e[f])).filter((m): m is string => Boolean(m));
  const gardeFinale = async (sql: repo.SqlLike): Promise<void> => {
    await gardeA1(sql);
    const { operationalRefusalInTx } = await import('../provider/model-operational.service');
    for (const model of new Set(chainePromue)) {
      const indispo = await operationalRefusalInTx(sql, model);
      if (indispo !== null) {
        throw new ConfigOperationRefused('BLOCKED_MODEL_UNAVAILABLE',
          `Activation annulée dans la transaction : « ${model} » est confirmé indisponible pour la clé active${indispo.error ? ` (${indispo.error})` : ''}.`,
          { model, checkedAt: indispo.checkedAt });
      }
    }
  };
  try {
    r = await repo.promoteTreatment(versionId, {
      summary: opts.summary, guard: gardeFinale, now: opts.watch?.now,
      watch: (t) => initialWatch(t, { campaignId: opts.watch?.campaignId ?? d.reference.campaignId, operations: opts.watch?.operations, previousVersionId: t.globalActiveBefore?.versionId ?? null, now: opts.watch?.now }) as unknown as Record<string, unknown>,
    });
  } catch (e) {
    const code = e instanceof gate.PromotionGateRefused ? e.gateCode : (e as { code?: string }).code ?? 'ERROR';
    await recordPromotionEvent({
      environment: d.reference.environment, kind: 'ACTIVATION_TX', candidateVersionId: versionId, campaignId: d.reference.campaignId, treatment: d.reference.treatment,
      allowed: false, code, message: (e as Error).message.slice(0, 1500), reference: d.reference as unknown as Record<string, unknown>,
    });
    if (e instanceof gate.PromotionGateRefused) throw new ConfigOperationRefused('PROMOTION_REVALIDATION_REFUSED', e.message, { gateCode: e.gateCode, reference: d.reference });
    asRefusal(e);
  }
  // Après commit : invalidations et journal NON bloquants (la surveillance est déjà persistée, PRO-03 point 6).
  if (!r.alreadyActive) await afterCommit(`activate-candidate:${versionId}:r${r.revisionNumber}`, r.masterPromptSwitches).catch(() => undefined);
  await recordPromotionEvent({
    environment: d.reference.environment, kind: r.alreadyActive ? 'ACTIVATED' : 'TARGETED_PROMOTION', candidateVersionId: versionId, campaignId: d.reference.campaignId, treatment: d.reference.treatment,
    allowed: true, code: r.alreadyActive ? 'ALREADY_ACTIVE' : null,
    message: r.alreadyActive ? `Candidate ${versionId} déjà active : aucune seconde activation (idempotent).`
      : `Candidate ${versionId} promue en préproduction : seule la configuration de ${r.targeted?.treatment ?? d.reference.treatment} est remplacée (axes ${r.targeted?.axes.join(', ') || '—'}), autres traitements conservés depuis la configuration ${r.previousId ?? '—'} ; surveillance ouverte.`,
    reference: { ...d.reference, previousVersionId: r.previousId, targeted: r.targeted ? { treatment: r.targeted.treatment, baselineFingerprint: r.targeted.baselineFingerprint, afterFingerprint: r.targeted.afterFingerprint, globalActiveBefore: r.targeted.globalActiveBefore, globalActiveAfter: r.targeted.globalActiveAfter } : null } as unknown as Record<string, unknown>,
  });
  return { previousId: r.previousId, interrupts: false, requeuedJobs: 0, revisionNumber: r.revisionNumber, alreadyActive: r.alreadyActive, reference: d.reference, targeted: r.targeted };
}

/**
 * Lot 113I — SERVICE UNIQUE DE RESTAURATION CIBLÉE (CDC V2 SQL-007/008/009, PRO-05/06, MON-03, EC-16). Utilisé par la
 * surveillance des modèles ET par la mise en conformité des prompts : seule la part du traitement promu revient à son
 * état antérieur, dans une nouvelle révision de la configuration active ; les autres traitements sont conservés.
 *   · empreinte courante ≠ empreinte promue (geste humain, nouvelle promotion) → refus, surveillance REPLACED
 *     (preuve de régression conservée, aucune révision humaine écrasée) ;
 *   · gel actif ou illisible → refus, ROLLBACK_FAILED + alerte critique (l'état réel reste affiché) ;
 *   · déjà effectué → idempotent.
 * Jamais en production ; jamais par réactivation d'une ancienne version globale.
 */
export async function rollbackPromotedTreatment(candidateVersionId: number, p: {
  reason: string; evidence?: Record<string, unknown>; watch?: Record<string, unknown> | null; now?: Date;
  /** Promotion antérieure au lot 113I (aucune référence ciblée) : rendre NO_PREVIOUS_STATE sans effet, l'appelant a un repli. */
  legacyFallback?: boolean;
}): Promise<{ status: 'ROLLED_BACK' | 'REPLACED' | 'ROLLBACK_FAILED' | 'ALREADY_ROLLED_BACK'; message: string; activeVersionId?: number; code?: string }> {
  const env = getAiEnvironment();
  const { recordPromotionEvent } = await import('../qualification/promotion-journal');
  const now = p.now ?? new Date();
  const base = { ...(p.watch ?? {}) };
  if (env === 'production') return { status: 'ROLLBACK_FAILED', message: 'Production : aucun retour arrière automatique (PRD-01).' };
  const r = await repo.rollbackTreatment(candidateVersionId, {
    reason: p.reason,
    watchPatch: ({ activeVersionId, revisionNumber }) => ({ ...base, status: 'ROLLED_BACK', endedAt: now.toISOString(), endReason: `Retour arrière ciblé : ${p.reason}`.slice(0, 1000), rollback: { activeVersionId, revisionNumber, at: now.toISOString(), evidence: p.evidence ?? null } }),
  });
  if (r.ok) {
    await afterCommit(`rollback-cible:${r.treatment}:${r.activeVersionId}:r${r.revisionNumber}`, r.masterPromptSwitches).catch(() => undefined);
    await recordPromotionEvent({ environment: env, kind: 'TARGETED_ROLLBACK', candidateVersionId, treatment: r.treatment, allowed: true, code: 'ROLLED_BACK',
      message: `Retour arrière automatique CIBLÉ de ${r.treatment} (configuration active ${r.activeVersionId}, révision ${r.revisionNumber}) : ${p.reason}. Autres traitements inchangés.`.slice(0, 2000),
      reference: { activeVersionId: r.activeVersionId, revisionNumber: r.revisionNumber, evidence: p.evidence ?? null } });
    return { status: 'ROLLED_BACK', message: `Retour arrière ciblé de ${r.treatment} effectué.`, activeVersionId: r.activeVersionId };
  }
  if (r.code === 'ALREADY_ROLLED_BACK') return { status: 'ALREADY_ROLLED_BACK', message: r.message, code: r.code };
  if (r.code === 'NO_PREVIOUS_STATE' && p.legacyFallback && !r.treatment) return { status: 'ROLLBACK_FAILED', message: r.message, code: r.code };
  const remplace = r.code === 'ROLLBACK_CONFLICT';
  const statut = remplace ? 'REPLACED' : 'ROLLBACK_FAILED';
  await repo.mergeCandidatePromotion(candidateVersionId, {
    watch: { ...base, status: statut, endedAt: now.toISOString(), endReason: `${remplace ? 'Remplacée avant le retour arrière (révision la plus récente conservée)' : 'Régression prouvée, retour arrière impossible'} : ${r.message}`.slice(0, 1000), regressionEvidence: { reason: p.reason, evidence: p.evidence ?? null } },
  }).catch(() => undefined);
  await recordPromotionEvent({ environment: env, kind: remplace ? 'ROLLBACK_REFUSED' : 'ROLLBACK_FAILED', candidateVersionId, treatment: r.treatment, allowed: false, code: r.code,
    message: `${remplace ? 'Retour arrière refusé' : 'Retour arrière IMPOSSIBLE'} (${r.code}) : ${r.message} — motif initial : ${p.reason}`.slice(0, 2000), reference: { evidence: p.evidence ?? null } });
  if (!remplace) {
    const { raiseAlert } = await import('../alerts/alerts.repository');
    await raiseAlert({ kind: 'guardrail', code: 'IMPROVEMENT_ROLLBACK_FAILED', severity: 'critical', treatment: r.treatment ?? null,
      message: `Régression imputable prouvée sur ${r.treatment ?? 'un traitement'} (candidate ${candidateVersionId}) mais retour arrière automatique impossible (${r.code}) : réactiver l’état précédent à la main (BO › Configuration IA).`,
      details: { candidateVersionId, code: r.code }, dedupeKey: `improvement-rollback-failed:${env}:${candidateVersionId}`, drilldownHref: '/admin/ai-config#auto-promotion' }).catch(() => undefined);
  }
  return { status: statut, message: r.message, code: r.code };
}
