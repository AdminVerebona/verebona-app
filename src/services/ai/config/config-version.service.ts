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
  validateVersion, type ConfigCatalogs, type ValidationResult,
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
async function buildCatalogs(): Promise<ConfigCatalogs> {
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
async function afterCommit(reason: string, switches: WriteOutcome['masterPromptSwitches'] = []): Promise<void> {
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
    // Lot 32B, §5 : le filtrage du BO n'est pas une règle de sécurité.
    const nouveaux = MODEL_FIELDS.some((f) => entry[f] && entry[f] !== (current?.[f] ?? null));
    if (nouveaux) {
      catalogs ??= await buildCatalogs();
      await assertNewModelSelections(current, entry, catalogs);
    }
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
  // active par le passé : retour arrière, jamais bloqué (WF-06).
  if (version.activatedAt === null && !version.active) {
    await assertVersionModelsUsable(version);
    warnings = (await assertModelRegistryCoherence(version)).map((i) => i.message);
  } else {
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
