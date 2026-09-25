/**
 * Orchestration du cycle de vie d'une version — CDC BO IA WF-01 à WF-06.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * « ÉCHEC DE VALIDATION : AUCUNE TRANSITION D'ÉTAT »
 *
 * C'est la phrase du WF-02, et c'est toute la raison d'être de ce service.
 * Le dépôt sait faire transiter une version ; la machine à états sait si la
 * transition est permise. Ni l'un ni l'autre ne sait si la CONFIGURATION est
 * valide — et rien n'empêcherait un appelant de promouvoir un Brouillon dont
 * un prompt est vide.
 *
 * Ce service enchaîne donc, dans cet ordre et sans le raccourcir : diff,
 * contrôles, puis transition. Une version promue puis rétrogradée aurait déjà
 * pu être lue par une exécution en préproduction.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LES CATALOGUES SONT ASSEMBLÉS ICI
 *
 * `config-validation` les reçoit en paramètre pour rester testable sans base.
 * C'est ici qu'ils sont réellement construits : modèles servis et tarifés
 * viennent de la grille, garde-fous et déclencheurs des catalogues fermés.
 */
import { getAiEnvironment, allowsTestVersions } from './environment';
import { diffVersions, type ConfigDiff } from './config-diff.service';
import {
  validateVersion, type ConfigCatalogs, type ValidationResult,
} from './config-validation.service';
import { guardrailCodes, triggerCodes } from './catalogs';
import {
  getVersion, getActiveVersion, createDraft, saveEntry,
  promoteToTest, demoteToDraft, validateVersion as commitValidation,
  switchActive, archiveVersion,
} from './config-version.repository';
import type { ConfigVersionWithEntries, TreatmentConfig } from './config-types';

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

/**
 * Assemble les catalogues à partir du code et de la grille tarifaire.
 *
 * `listModelsWithoutPricing` renvoie ce qui MANQUE ; on a besoin de l'inverse.
 * On part donc du catalogue public, source des modèles servis, et on retire
 * ceux sans tarif connu.
 */
async function buildCatalogs(): Promise<ConfigCatalogs> {
  const { GEMINI_PUBLIC_CATALOG } = await import('../gateway/pricing/gemini-public-catalog');
  const { getCachedPrice, loadPricingCache, getCacheState } =
    await import('../gateway/pricing/pricing.repository');

  if (getCacheState().loadedAt === null) await loadPricingCache();

  const available = new Set(GEMINI_PUBLIC_CATALOG.map((e) => e.model));
  const priced = new Set<string>();
  for (const model of available) {
    if (getCachedPrice('gemini', model)) priced.add(model);
  }

  return {
    availableModels: available,
    pricedModels: priced,
    guardrailCodes: guardrailCodes(),
    triggerCodes: triggerCodes(),
    // Point resté ouvert : avertissement tant que l'arbitrage n'est pas rendu.
    requireActiveTrigger: false,
  };
}

async function load(versionId: number): Promise<ConfigVersionWithEntries> {
  const version = await getVersion(versionId);
  if (!version) {
    throw new ConfigOperationRefused('VERSION_NOT_FOUND', `Version ${versionId} introuvable.`);
  }
  return version;
}

// ── WF-01 — Brouillon ───────────────────────────────────────────────────────

export async function startDraft(userId: number, label?: string): Promise<ConfigVersionWithEntries> {
  return createDraft(userId, label ?? null);
}

export async function saveTreatmentConfig(
  versionId: number,
  config: TreatmentConfig,
  userId: number,
): Promise<void> {
  await saveEntry(versionId, config, userId);
}

// ── Diff et contrôles, sans transition ──────────────────────────────────────

/**
 * Diff d'une version contre l'Active de son environnement.
 *
 * Contre l'Active COURANTE, et non contre la version de base mémorisée : c'est
 * ce que le VER-003 demande, et c'est aussi le seul diff utile — l'administrateur
 * décide par rapport à ce qui tourne, pas par rapport à ce qui tournait quand il
 * a créé son Brouillon.
 */
export async function diffAgainstActive(versionId: number): Promise<{
  diff: ConfigDiff;
  version: ConfigVersionWithEntries;
  active: ConfigVersionWithEntries | null;
}> {
  const version = await load(versionId);
  const active = await getActiveVersion(version.environment);
  return {
    diff: diffVersions(active?.entries ?? [], version.entries),
    version,
    active,
  };
}

export async function checkVersion(versionId: number): Promise<ValidationResult> {
  const version = await load(versionId);
  return validateVersion(version.entries, await buildCatalogs());
}

// ── WF-02 — Promotion ───────────────────────────────────────────────────────

export interface PromotionResult {
  diff: ConfigDiff;
  validation: ValidationResult;
  promoted: boolean;
}

/**
 * Promeut un Brouillon en « À tester » (WF-02).
 *
 * Trois refus possibles, dans cet ordre — et aucun ne laisse d'écriture
 * derrière lui :
 *   · environnement de production, où le cycle de test n'existe pas ;
 *   · diff vide : promouvoir une version identique à l'Active n'a pas d'objet ;
 *   · contrôles en échec, rendus par traitement et par champ.
 *
 * Le diff et les contrôles sont rendus même en cas de refus : l'écran doit
 * pouvoir les afficher sans rappeler le serveur.
 */
/**
 * Vide les caches de configuration après une bascule.
 *
 * Sans cela, une activation mettrait jusqu'à trente secondes à s'appliquer :
 * l'administrateur verrait la version active changer à l'écran, tandis que les
 * appels continueraient d'utiliser l'ancienne. Un délai bref est acceptable
 * pour une lecture opportuniste ; il ne l'est pas juste après un geste
 * délibéré, et encore moins après un rollback fait pendant un incident.
 */
async function invalidateCaches(): Promise<void> {
  const [{ invalidateConfigCache }, { invalidateConfigVersionCache }] = await Promise.all([
    import('./config-resolver'),
    import('../telemetry/execution-context'),
  ]);
  invalidateConfigCache();
  invalidateConfigVersionCache();
}

export async function promote(versionId: number): Promise<PromotionResult> {
  const environment = getAiEnvironment();
  if (!allowsTestVersions(environment)) {
    throw new ConfigOperationRefused(
      'PRODUCTION_ENVIRONMENT',
      'Le cycle de test n\'existe pas en production : une version y arrive par import '
      + 'et s\'active explicitement (VER-012).',
    );
  }

  const { diff, version } = await diffAgainstActive(versionId);
  const validation = validateVersion(version.entries, await buildCatalogs());

  if (diff.identical) {
    return { diff, validation, promoted: false };
  }
  if (!validation.valid) {
    return { diff, validation, promoted: false };
  }

  // La machine à états refusera si la version n'est pas un Brouillon.
  await promoteToTest(versionId);
  // La version « À tester » devient effective en préproduction (VER-004) :
  // même raison que pour une bascule d'Active, elle doit s'appliquer tout de suite.
  await invalidateCaches();
  return { diff, validation, promoted: true };
}

/**
 * VER-012 (partie II) / VER-005 — retour « À tester » → Brouillon : la
 * préproduction revient sur la dernière Active.
 *
 * Les caches sont vidés : la version « À tester » était la version EFFECTIVE
 * en préproduction (VER-004) ; sans invalidation, les appels continueraient de
 * l'utiliser jusqu'à trente secondes après le retour — précisément la version
 * qu'on vient de juger mauvaise.
 */
export async function backToDraft(versionId: number): Promise<void> {
  await demoteToDraft(versionId);
  await invalidateCaches();
}

// ── WF-03 — Validation ──────────────────────────────────────────────────────

/**
 * Valide la version « À tester » : elle devient Active et reçoit son numéro.
 *
 * Les contrôles sont rejoués. La configuration n'a pas pu changer depuis la
 * promotion — une version « À tester » n'est pas modifiable —, mais les
 * catalogues, eux, ont pu bouger : un modèle peut avoir été retiré par le
 * fournisseur entre les tests et la validation. C'est arrivé.
 */
export async function validate(
  versionId: number,
  userId: number,
): Promise<{ visibleNumber: number }> {
  const version = await load(versionId);
  const validation = validateVersion(version.entries, await buildCatalogs());
  if (!validation.valid) {
    throw new ConfigOperationRefused(
      'VALIDATION_FAILED',
      'La configuration ne satisfait plus les contrôles.',
      validation.issues.filter((i) => i.blocking),
    );
  }
  const { visibleNumber } = await commitValidation(versionId, userId);
  await invalidateCaches();
  return { visibleNumber };
}

// ── WF-05 et WF-06 — Activation et restauration ─────────────────────────────

export interface SwitchResult {
  previousId: number | null;
  /** `true` pour un rollback : les exécutions en cours ont été interrompues. */
  interrupts: boolean;
  /** Nombre de travaux remis en tête de file. Nul pour une activation normale. */
  requeuedJobs: number;
}

/** WF-05 — activation normale : n'interrompt aucune exécution en cours. */
export async function activate(versionId: number, userId: number): Promise<SwitchResult> {
  const r = await switchActive(versionId, userId, 'activate');
  await invalidateCaches();
  // WF-05 : « aucune interruption des exécutions en cours ». Elles se terminent
  // avec leur configuration ; seuls les démarrages suivants utilisent celle-ci.
  return { previousId: r.previousId, interrupts: false, requeuedJobs: 0 };
}

/**
 * WF-06 — restauration d'une ancienne Active.
 *
 * À la différence de l'activation normale, le rollback INTERROMPT : le WF-06
 * exige d'arrêter immédiatement les exécutions concernées et de remettre les
 * jobs batch en tête de file, pour qu'ils reprennent depuis le début avec la
 * version restaurée.
 *
 * L'ordre compte. La bascule d'abord, la remise en file ensuite : un job remis
 * en tête avant la bascule pourrait être repris par une autre instance sous
 * l'ancienne configuration, c'est-à-dire précisément celle qu'on abandonne.
 */
export async function rollback(versionId: number, userId: number): Promise<SwitchResult> {
  const version = await load(versionId);
  if (version.activatedAt === null) {
    throw new ConfigOperationRefused(
      'NEVER_ACTIVE',
      'Cette version n\'a jamais été active : la restaurer ne serait pas un retour en arrière (VER-007).',
    );
  }

  const r = await switchActive(versionId, userId, 'rollback');
  await invalidateCaches();

  const { requeueRunning } = await import('../queue/job-queue.repository');
  const { listBatchTreatments } = await import('./treatments');
  let requeued = 0;
  for (const t of listBatchTreatments()) {
    requeued += await requeueRunning(t, `restauration de la version ${version.visibleNumber ?? versionId}`);
  }

  return { previousId: r.previousId, interrupts: true, requeuedJobs: requeued };
}

/** VER-008 et VER-009 — archivage définitif, impossible sur une Active. */
export async function archive(versionId: number): Promise<void> {
  await archiveVersion(versionId);
}
