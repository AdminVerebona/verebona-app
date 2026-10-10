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
  switchActive, archiveVersion, listVersions, markStaleDrafts,
} from './config-version.repository';
import { normalizeTreatmentConfig, promptArchitectureOf, type ConfigVersionWithEntries, type TreatmentConfig } from './config-types';
import { checkPromptArchitectureChange } from './prompt-architecture';

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
  // Lot 32B/35B : un seul contexte (catalogue fournisseur, tarifs informatifs,
  // qualification, état opérationnel) — celui de `usableModelsForTreatment`.
  const { loadUsableModelsContext, evaluateModelForTreatment } = await import('../registry/usable-models');
  const { selectableModels } = await import('../provider/model-catalog.service');
  const ctx = await loadUsableModelsContext();
  // E-04, WF-29, WF-40 : disponibilité réelle chez le fournisseur, au dernier
  // rafraîchissement du catalogue ; jamais rafraîchi → catalogue du code.
  const available = selectableModels(ctx.codeCatalog, ctx.catalog as never);
  const priced = new Set<string>([...available].filter((m) => ctx.price(m) !== null));

  return {
    modelEligibility: (treatment, model) => evaluateModelForTreatment(treatment, model, ctx),
    availableModels: available,
    pricedModels: priced,
    guardrailCodes: guardrailCodes(),
    triggerCodes: triggerCodes(),
    // Point resté ouvert : avertissement tant que l'arbitrage n'est pas rendu.
    requireActiveTrigger: false,
  };
}

/** Champs « modèle » d'une ligne (principal et replis). */
const MODEL_FIELDS = ['primaryModel', 'fallback1', 'fallback2'] as const;

/**
 * Lot 32B, §5 — enregistrement : un modèle NOUVELLEMENT choisi (absent de la
 * ligne enregistrée à ce rang) doit être utilisable pour le traitement, et
 * ne pas doubler un autre rang. Une valeur déjà enregistrée et devenue
 * inutilisable reste acceptée (brouillon incomplet ou hérité, §4) : elle est
 * signalée et bloque la promotion, jamais l'enregistrement d'autres champs.
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

// ── WF-01 — Brouillon ───────────────────────────────────────────────────────

export async function startDraft(userId: number, label?: string): Promise<ConfigVersionWithEntries> {
  return createDraft(userId, label ?? null);
}

export async function saveTreatmentConfig(
  versionId: number,
  config: TreatmentConfig,
  userId: number,
): Promise<{ before: TreatmentConfig | null; after: TreatmentConfig }> {
  // CDC 15 §29.1, D-04 : bascule d'architecture seulement dans un Brouillon,
  // et seulement vers un master déclaré. `saveEntry` refuse déjà toute
  // édition hors Brouillon ; ce contrôle rend le motif explicite.
  // Champ omis (client antérieur au lot 12) : l'architecture en place est
  // conservée, jamais remise à `steps` en silence.
  const version = await getVersion(versionId);
  const current = version?.entries.find((e) => e.treatment === config.treatment);
  // Valeur DEMANDÉE (brute) : pour tout traitement (lot 16b-3), `steps` explicitement demandé est
  // refusé (lot 16b) plutôt que ramené à `master` en silence.
  const next = config.promptArchitecture === undefined && current
    ? promptArchitectureOf(current)
    : (config.promptArchitecture ?? promptArchitectureOf(config));
  if (version) {
    const decision = checkPromptArchitectureChange({
      status: version.status, treatment: config.treatment,
      from: current ? promptArchitectureOf(current) : null, to: next,
    });
    if (!decision.allowed) throw new ConfigOperationRefused(decision.code, decision.message);
  }
  // Même règle pour le texte master (D-03) : omis ⇒ celui en place.
  const masterPrompt = config.masterPrompt === undefined ? (current?.masterPrompt ?? null) : config.masterPrompt;
  const enregistree: TreatmentConfig = { ...config, promptArchitecture: next, masterPrompt };
  // Lot 32B, §5 : le filtrage du BO n'est pas une règle de sécurité.
  // Version absente ou non modifiable : `saveEntry` rend le refus explicite.
  if (version?.status === 'DRAFT') await assertNewModelSelections(current, enregistree);
  await saveEntry(versionId, enregistree, userId);
  // CFG-01 (CDC 15) : une édition ne touche qu'un Brouillon (`saveEntry`
  // refuse tout autre statut), jamais la version effective. La clé partagée
  // est tout de même incrémentée : le coût est un rechargement par instance,
  // et la règle « toute écriture de configuration invalide partout » ne
  // dépend plus de ce que la machine à états autorise aujourd'hui.
  const { bumpConfigVersionCounter } = await import('./config-cache-version');
  await bumpConfigVersionCounter(`edit:${versionId}:${config.treatment}`);
  // Valeurs avant / après (après = ce que `upsertEntry` écrit réellement,
  // normalisation T5 comprise) : la route les journalise (tickets T4 / T5).
  return { before: current ?? null, after: normalizeTreatmentConfig(enregistree) };
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
async function invalidateCaches(reason: string): Promise<void> {
  const [{ invalidateConfigCache }, { invalidateConfigVersionCache }, { bumpConfigVersionCounter }] = await Promise.all([
    import('./config-resolver'),
    import('../telemetry/execution-context'),
    import('./config-cache-version'),
  ]);
  // CFG-01 (CDC 15) : la clé partagée d'abord, pour TOUTES les instances
  // (relue à chaque résolution) ; puis le cache local, pour celle-ci. Échec
  // de l'incrément : journalisé, les autres instances suivent au TTL.
  await bumpConfigVersionCounter(reason);
  invalidateConfigCache();
  invalidateConfigVersionCache();
  // CDC Assistant §15.14 : tout changement de la version effective refait le
  // contrôle du registre de modèles de l'assistant (non bloquant : le verdict
  // et l'alerte éventuelle suffisent).
  void import('@/services/verebona-assistant/core/model-startup-check')
    .then(({ runAssistantStartupCheck }) => runAssistantStartupCheck('config_change'))
    .catch(() => { /* contrôle impossible : journalisé par le module */ });
}

export async function promote(
  versionId: number,
  options: { acknowledgeStale?: boolean } = {},
): Promise<PromotionResult> {
  const environment = getAiEnvironment();
  if (!allowsTestVersions(environment)) {
    throw new ConfigOperationRefused(
      'PRODUCTION_ENVIRONMENT',
      'Le cycle de test n\'existe pas en production : une version y arrive par import '
      + 'et s\'active explicitement (VER-012).',
    );
  }

  const { diff, version } = await diffAgainstActive(versionId);

  // VER-002 : un seul « À tester ». Jusqu'ici l'index unique levait une
  // erreur transformée en 500 générique ; le refus est désormais explicite et
  // désigne la version à repasser en Brouillon (l'écran le propose).
  const existing = (await listVersions()).find((v) => v.status === 'TO_TEST' && v.id !== versionId);
  if (existing) {
    throw new ConfigOperationRefused(
      'TO_TEST_EXISTS',
      `La version « ${existing.label ?? existing.id} » est déjà À tester : repassez-la en Brouillon d'abord.`,
      { id: existing.id },
    );
  }
  // WF-27, WF-01 : pas de promotion silencieuse d'un Brouillon obsolète —
  // l'Active de base a changé ; l'administrateur doit avoir vu le diff.
  if (version.isStale && !options.acknowledgeStale) {
    throw new ConfigOperationRefused(
      'STALE_DRAFT',
      'Ce Brouillon est obsolète : l\'Active dont il dérive a changé. Relisez le diff puis confirmez.',
      { diff },
    );
  }

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
  await invalidateCaches(`promote:${versionId}`);
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
  await invalidateCaches(`demote:${versionId}`);
}

// ── Corpus des masters : plus une garde (BO-IA-PROMPTS-01) ──────────────────
//
// Jusqu'au lot 26, validation, activation et restauration exigeaient un
// corpus vert sur l'empreinte exacte de CHAQUE prompt maître de la version
// (CDC 15 §30, D-17) — exigence globale T1 → T6, commande en terminal,
// justification pour un rollback. Décision fonctionnelle BO-IA-PROMPTS-01 :
// le corpus n'est plus une condition de mise en production. Il reste un
// contrôle qualité facultatif (« Tester avec le corpus » au BO, `ai:corpus`
// en ligne de commande). Seuls les contrôles TECHNIQUES bloquent
// (`validateVersion` : prompt maître incomplet, emplacement inconnu…).

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
): Promise<{ visibleNumber: number; warnings: string[] }> {
  const version = await load(versionId);
  const validation = validateVersion(version.entries, await buildCatalogs());
  if (!validation.valid) {
    throw new ConfigOperationRefused(
      'VALIDATION_FAILED',
      'La configuration ne satisfait plus les contrôles.',
      validation.issues.filter((i) => i.blocking),
    );
  }
  // Lot 23 (§15.12) : modèles cohérents avec le registre déclaratif.
  const avertissements = await assertModelRegistryCoherence(version);
  const { visibleNumber } = await commitValidation(versionId, userId);
  await invalidateCaches(`validate:${versionId}`);
  return { visibleNumber, warnings: avertissements.map((i) => i.message) };
}

// ── §15.13, §32.7 — modèle preview en production : garde supprimée (lot 35B) ──

/*
 * Lot 35B (ticket « Catalogue IA dynamique Google ») : la garde « modèle
 * preview en production » (`assertPreviewModelsApproved`, réglage
 * « preview_models_allowed » à double validation, refus
 * PREVIEW_MODEL_NOT_APPROVED) est SUPPRIMÉE. Un modèle preview est
 * sélectionnable et activable dans les mêmes conditions techniques qu'un
 * stable (disponible avec la clé active + qualification réussie) ; son statut
 * reste visible au registre des modèles. Un modèle EXPÉRIMENTAL reste exclu
 * (`usableModelsForTreatment`, motif EXPERIMENTAL).
 */

// ── §15.12, §15.14 — cohérence avec le registre des modèles (lot 23) ────────

/**
 * Contrôle de cohérence d'une version avec les EXCEPTIONS du registre des
 * modèles (`registry/models.ts`), à la validation et à l'activation :
 *   · modèle interdit, ou exclu pour le prompt maître du traitement
 *     (exception documentée) → erreur ;
 *   · modèle de rollback déclaré absent ou non stable → erreur ;
 *   · déprécié, anomalie connue → avertissement rendu à l'appelant.
 * Lot 35B : un modèle ABSENT du registre n'est plus une incohérence ni un
 * « preview » — sa disponibilité et ses capacités sont établies par le
 * catalogue et la qualification automatique (`assertVersionModelsUsable`).
 * Plus aucune condition preview (PREVIEW_NOT_ALLOWED supprimé).
 *
 * Bloquant (`MODEL_REGISTRY_INCOHERENT`) dans tous les environnements. Pas
 * appliqué au rollback (WF-06).
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
 * Lot 32B, §5 — activation : les MODÈLES de la version doivent être
 * utilisables pour leur traitement, au moment de l'activation (un modèle
 * retiré par le fournisseur entre la validation et l'activation est refusé).
 * Seuls les contrôles de modèles sont rejoués : la version a déjà passé les
 * autres à sa validation. Pas appliqué au rollback (WF-06) — restaurer une
 * version déjà active doit rester possible pendant un incident.
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
    throw new ConfigOperationRefused(
      'MODEL_NOT_USABLE',
      `Activation impossible : ${refus.map((i) => i.message).join(' ')}`,
      refus,
    );
  }
}

// ── WF-05 et WF-06 — Activation et restauration ─────────────────────────────

export interface SwitchResult {
  previousId: number | null;
  /** `true` pour un rollback : les exécutions en cours ont été interrompues. */
  interrupts: boolean;
  /** Nombre de travaux remis en tête de file. Nul pour une activation normale. */
  requeuedJobs: number;
  /** Avertissements du registre des modèles (déprécié, inconnu) — lot 23. */
  warnings?: string[];
}

/** WF-05 — activation normale : n'interrompt aucune exécution en cours. */
export async function activate(versionId: number, userId: number): Promise<SwitchResult> {
  const version = await load(versionId);
  // Lot 32B, §5 : chaque modèle (principal, replis) ∈ usableModelsForTreatment.
  await assertVersionModelsUsable(version);
  // BO-IA-PROMPTS-01 : aucun corpus exigé. Contrôles techniques seulement.
  const avertissements = await assertModelRegistryCoherence(version);
  const r = await switchActive(versionId, userId, 'activate');
  await invalidateCaches(`activate:${versionId}`);
  // WF-27 : les Brouillons dérivés de l'Active remplacée deviennent obsolètes
  // (jusqu'ici seul `validateVersion` les marquait).
  if (r.previousId) await markStaleDrafts(r.previousId);
  // WF-05 : « aucune interruption des exécutions en cours ». Elles se terminent
  // avec leur configuration ; seuls les démarrages suivants utilisent celle-ci.
  return { previousId: r.previousId, interrupts: false, requeuedJobs: 0, warnings: avertissements.map((i) => i.message) };
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
  // BO-IA-PROMPTS-01 : restauration jamais conditionnée au corpus, sans
  // justification à saisir ; la bascule est tracée comme toute bascule.

  const r = await switchActive(versionId, userId, 'rollback');
  await invalidateCaches(`rollback:${versionId}`);
  if (r.previousId) await markStaleDrafts(r.previousId);

  const { requeueRunning } = await import('../queue/job-queue.repository');
  const { listBatchTreatments } = await import('./treatments');
  let requeued = 0;
  for (const t of listBatchTreatments()) {
    requeued += await requeueRunning(t, `restauration de la version ${version.visibleNumber ?? versionId}`);
  }

  return { previousId: r.previousId, interrupts: true, requeuedJobs: requeued };
}

/**
 * VER-008 et VER-009 — archivage définitif, impossible sur une Active.
 *
 * VER-020 : l'archivage ne doit jamais supprimer le DERNIER point de rollback
 * viable — une version Validée déjà active par le passé, autre que l'Active.
 * Sans elle, un incident sur l'Active n'aurait plus de retour arrière.
 */
export async function archive(versionId: number): Promise<void> {
  const versions = await listVersions(undefined, 500);
  if (isLastRollbackPoint(versionId, versions)) {
    throw new ConfigOperationRefused(
      'LAST_ROLLBACK',
      'Cette version est le dernier point de rollback viable : l\'archiver supprimerait tout retour arrière (VER-020).',
    );
  }
  await archiveVersion(versionId);
}

/** Pur : la version est-elle le seul rollback viable ? */
export function isLastRollbackPoint(
  versionId: number,
  versions: Array<Pick<ConfigVersionWithEntries, 'id' | 'status' | 'activatedAt'>>,
): boolean {
  const viables = versions.filter((v) => v.status === 'VALIDATED' && v.activatedAt !== null);
  return viables.length === 1 && viables[0].id === versionId;
}
