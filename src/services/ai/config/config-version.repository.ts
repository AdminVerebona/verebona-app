/**
 * Persistance des versions de configuration IA — CDC BO IA §7, WF-01 à WF-06.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LES BASCULES SONT ATOMIQUES ET ORDONNÉES
 *
 * Valider, activer, restaurer : chacune fait passer une version à `ACTIVE` et
 * l'ancienne à `VALIDATED`. Dans le mauvais ordre, l'index unique partiel
 * « une seule Active par environnement » rejette la promotion ; hors
 * transaction, un incident entre les deux laisserait l'environnement sans
 * configuration active.
 *
 * Chaque bascule est donc une transaction ORDONNÉE (WF-03, correctif) :
 * l'ancienne est rétrogradée PUIS la nouvelle promue, ou rien n'est écrit.
 * Une CTE unique ne convient pas : PostgreSQL ne garantit pas l'ordre des
 * CTE modifiantes, et l'index unique non différable voit l'état intermédiaire.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE STATUT D'ARRIVÉE VIENT DE LA MACHINE À ÉTATS
 *
 * Aucune de ces fonctions n'écrit un statut en dur. Elles demandent la
 * transition à `version-state-machine`, qui lève si elle n'est pas prévue.
 * Écrire « ACTIVE » directement contournerait les trois interdits du §7 sans
 * qu'aucun test ne s'en aperçoive.
 */
import { pgClient } from '@/db';
import { transition, type ConfigVersionEvent, type ConfigVersionStatus } from './version-state-machine';
import { getAiEnvironment, type AiEnvironment } from './environment';
import { TREATMENTS, type Treatment } from './treatments';
import {
  emptyTreatmentConfig, normalizeTreatmentConfig,
  type ConfigVersion, type ConfigVersionWithEntries, type TreatmentConfig,
} from './config-types';

type Row = Record<string, unknown>;

function toVersion(r: Row): ConfigVersion {
  return {
    id: Number(r.id),
    uid: String(r.uid),
    environment: String(r.environment) as AiEnvironment,
    status: String(r.status) as ConfigVersionStatus,
    visibleNumber: r.visible_number == null ? null : Number(r.visible_number),
    label: r.label == null ? null : String(r.label),
    baseVersionId: r.base_version_id == null ? null : Number(r.base_version_id),
    isStale: Boolean(r.is_stale),
    createdBy: r.created_by == null ? null : Number(r.created_by),
    createdAt: new Date(String(r.created_at)),
    validatedAt: r.validated_at ? new Date(String(r.validated_at)) : null,
    activatedAt: r.activated_at ? new Date(String(r.activated_at)) : null,
    archivedAt: r.archived_at ? new Date(String(r.archived_at)) : null,
  };
}

function toEntry(r: Row): TreatmentConfig {
  return {
    treatment: String(r.treatment) as Treatment,
    prompt: String(r.prompt ?? ''),
    primaryModel: r.primary_model == null ? null : String(r.primary_model),
    fallback1: r.fallback_1 == null ? null : String(r.fallback_1),
    fallback2: r.fallback_2 == null ? null : String(r.fallback_2),
    reasoningPrimary: (r.reasoning_primary ?? null) as TreatmentConfig['reasoningPrimary'],
    reasoningFallback1: (r.reasoning_fallback_1 ?? null) as TreatmentConfig['reasoningFallback1'],
    reasoningFallback2: (r.reasoning_fallback_2 ?? null) as TreatmentConfig['reasoningFallback2'],
    maxOutputTokens: r.max_output_tokens == null ? null : Number(r.max_output_tokens),
    guardrails: (r.guardrails ?? []) as TreatmentConfig['guardrails'],
    triggers: (r.triggers ?? []) as TreatmentConfig['triggers'],
    // `null` et non un objet par défaut : une version jamais configurée pour la
    // cascade laisse le code décider, plutôt que d'affirmer un arbitrage que
    // personne n'a rendu.
    cascade: (r.cascade ?? null) as TreatmentConfig['cascade'],
  };
}

const COLS = `id, uid, environment, status, visible_number, label, base_version_id,
              is_stale, created_by, created_at, validated_at, activated_at, archived_at`;

// ── Lectures ────────────────────────────────────────────────────────────────

export async function getVersion(id: number): Promise<ConfigVersionWithEntries | null> {
  const rows = await pgClient.unsafe(
    `SELECT ${COLS} FROM ai_config_versions WHERE id = $1 LIMIT 1`,
    [id] as never[],
  );
  const r = (rows as unknown as Row[])[0];
  if (!r) return null;
  return { ...toVersion(r), entries: await getEntries(id) };
}

export async function getEntries(versionId: number): Promise<TreatmentConfig[]> {
  const rows = await pgClient.unsafe(
    `SELECT treatment, prompt, primary_model, fallback_1, fallback_2,
            reasoning_primary, reasoning_fallback_1, reasoning_fallback_2,
            max_output_tokens, guardrails, triggers, cascade
       FROM ai_config_entries WHERE version_id = $1 ORDER BY treatment`,
    [versionId] as never[],
  );
  return (rows as unknown as Row[]).map(toEntry);
}

/** Version Active de l'environnement, s'il y en a une. */
export async function getActiveVersion(
  environment: AiEnvironment = getAiEnvironment(),
): Promise<ConfigVersionWithEntries | null> {
  const rows = await pgClient.unsafe(
    `SELECT ${COLS} FROM ai_config_versions
      WHERE environment = $1 AND status = 'ACTIVE' LIMIT 1`,
    [environment] as never[],
  );
  const r = (rows as unknown as Row[])[0];
  if (!r) return null;
  return { ...toVersion(r), entries: await getEntries(Number(r.id)) };
}

/**
 * Version qui s'applique réellement aux nouveaux démarrages.
 *
 * VER-004 : en préproduction, la version « À tester » prime sur l'Active. En
 * production elle n'existe pas, et l'Active fait foi.
 */
export async function getEffectiveVersion(
  environment: AiEnvironment = getAiEnvironment(),
): Promise<ConfigVersionWithEntries | null> {
  if (environment !== 'production') {
    const rows = await pgClient.unsafe(
      `SELECT ${COLS} FROM ai_config_versions
        WHERE environment = $1 AND status = 'TO_TEST' LIMIT 1`,
      [environment] as never[],
    );
    const r = (rows as unknown as Row[])[0];
    if (r) return { ...toVersion(r), entries: await getEntries(Number(r.id)) };
  }
  return getActiveVersion(environment);
}

export async function listVersions(
  environment: AiEnvironment = getAiEnvironment(),
  limit = 50,
): Promise<ConfigVersion[]> {
  const rows = await pgClient.unsafe(
    `SELECT ${COLS} FROM ai_config_versions
      WHERE environment = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [environment, limit] as never[],
  );
  return (rows as unknown as Row[]).map(toVersion);
}

// ── Écritures ───────────────────────────────────────────────────────────────

/**
 * Crée un Brouillon dérivé de l'Active (WF-01).
 *
 * Plusieurs Brouillons peuvent coexister (VER-001) : rien n'est vérifié de ce
 * côté. Sans Active — premier démarrage —, le Brouillon part de cinq
 * configurations vides plutôt que d'échouer : il faut bien un point de départ.
 */
export async function createDraft(
  userId: number,
  label: string | null = null,
  environment: AiEnvironment = getAiEnvironment(),
): Promise<ConfigVersionWithEntries> {
  const base = await getActiveVersion(environment);

  const rows = await pgClient.unsafe(
    `INSERT INTO ai_config_versions (environment, status, label, base_version_id, created_by)
     VALUES ($1, 'DRAFT', $2, $3, $4)
     RETURNING ${COLS}`,
    [environment, label, base?.id ?? null, userId] as never[],
  );
  const version = toVersion((rows as unknown as Row[])[0]);

  const source = new Map((base?.entries ?? []).map((e) => [e.treatment, e]));
  for (const t of TREATMENTS) {
    await upsertEntry(version.id, source.get(t) ?? emptyTreatmentConfig(t), userId);
  }

  return { ...version, entries: await getEntries(version.id) };
}

/**
 * Enregistre la configuration d'un traitement dans un Brouillon (WF-01).
 *
 * Refuse toute version qui n'est pas un Brouillon : le VER-002 met l'Active en
 * lecture seule, et une version « À tester » modifiée en place changerait le
 * comportement de la préproduction sans passer par le diff du VER-003.
 */
export async function saveEntry(
  versionId: number,
  config: TreatmentConfig,
  userId: number,
): Promise<void> {
  const rows = await pgClient.unsafe(
    `SELECT status FROM ai_config_versions WHERE id = $1 LIMIT 1`,
    [versionId] as never[],
  );
  const statut = (rows as unknown as Row[])[0]?.status;
  if (!statut) throw new Error(`[config] Version ${versionId} introuvable.`);
  if (statut !== 'DRAFT') {
    throw new Error(
      `[config] Version ${versionId} au statut « ${statut} » : seule une version ` +
      'au statut Brouillon est modifiable (VER-002).',
    );
  }
  await upsertEntry(versionId, config, userId);
}

async function upsertEntry(versionId: number, config: TreatmentConfig, userId: number): Promise<void> {
  // Point de passage unique de createDraft et saveEntry : un prompt T5 hérité
  // de l'Active, ou envoyé par un client, n'entre jamais en base (E-02).
  const c = normalizeTreatmentConfig(config);
  await pgClient.unsafe(
    `INSERT INTO ai_config_entries (
       version_id, treatment, prompt, primary_model, fallback_1, fallback_2,
       reasoning_primary, reasoning_fallback_1, reasoning_fallback_2,
       max_output_tokens, guardrails, triggers, cascade, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13::jsonb, $14, NOW())
     ON CONFLICT (version_id, treatment) DO UPDATE SET
       prompt = EXCLUDED.prompt,
       primary_model = EXCLUDED.primary_model,
       fallback_1 = EXCLUDED.fallback_1,
       fallback_2 = EXCLUDED.fallback_2,
       reasoning_primary = EXCLUDED.reasoning_primary,
       reasoning_fallback_1 = EXCLUDED.reasoning_fallback_1,
       reasoning_fallback_2 = EXCLUDED.reasoning_fallback_2,
       max_output_tokens = EXCLUDED.max_output_tokens,
       guardrails = EXCLUDED.guardrails,
       triggers = EXCLUDED.triggers,
       cascade = EXCLUDED.cascade,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()`,
    [
      versionId, c.treatment, c.prompt, c.primaryModel, c.fallback1, c.fallback2,
      c.reasoningPrimary, c.reasoningFallback1, c.reasoningFallback2,
      c.maxOutputTokens, JSON.stringify(c.guardrails), JSON.stringify(c.triggers),
      c.cascade === null ? null : JSON.stringify(c.cascade), userId,
    ] as never[],
  );
}

/** Applique une transition simple, sans bascule d'Active. */
async function applyTransition(
  versionId: number,
  event: ConfigVersionEvent,
  extra = '',
  params: unknown[] = [],
): Promise<ConfigVersionStatus> {
  const rows = await pgClient.unsafe(
    `SELECT status FROM ai_config_versions WHERE id = $1 LIMIT 1`,
    [versionId] as never[],
  );
  const from = (rows as unknown as Row[])[0]?.status as ConfigVersionStatus | undefined;
  if (!from) throw new Error(`[config] Version ${versionId} introuvable.`);

  // Lève si la transition n'est pas prévue — c'est la machine qui décide.
  const to = transition(from, event);

  await pgClient.unsafe(
    `UPDATE ai_config_versions SET status = $2, updated_at = NOW()${extra} WHERE id = $1`,
    [versionId, to, ...params] as never[],
  );
  return to;
}

/** WF-02 — promotion d'un Brouillon en « À tester ». Préproduction seulement. */
export async function promoteToTest(versionId: number): Promise<ConfigVersionStatus> {
  return applyTransition(versionId, 'promote');
}

/** VER-005 — retour en Brouillon : la préproduction revient sur la dernière Active. */
export async function demoteToDraft(versionId: number): Promise<ConfigVersionStatus> {
  return applyTransition(versionId, 'demote');
}

export async function archiveVersion(versionId: number): Promise<ConfigVersionStatus> {
  return applyTransition(versionId, 'archive', ', archived_at = NOW()');
}

/**
 * Sérialise les bascules d'un environnement (validation, activation, rollback).
 *
 * Verrou transactionnel consultatif : relâché automatiquement au COMMIT ou au
 * ROLLBACK. Deux bascules concurrentes du même environnement s'exécutent l'une
 * après l'autre ; celle qui arrive en second relit un état cohérent au lieu
 * de heurter l'index unique « une seule Active » (VER-001).
 */
async function lockEnvironment(tx: TxLike, environment: string): Promise<void> {
  await tx.unsafe(
    `SELECT pg_advisory_xact_lock(hashtext('ai_config_versions:' || $1))`,
    [environment] as never[],
  );
}

/** Sous-ensemble du client `postgres` utilisé dans une transaction. */
type TxLike = { unsafe: (query: string, params?: never[]) => Promise<unknown> };

/**
 * WF-03 — validation : la version « À tester » devient Active et reçoit son vN.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE NUMÉRO NAÎT EN PRÉPRODUCTION, ET NULLE PART AILLEURS
 *
 * Ce n'est pas une convention choisie ici : c'est ce que le CDC décrit. Le
 * WF-04 conserve « le numéro de version visible » dans le package, et le
 * VER-012 réserve l'arrivée en production à un import au statut Validé. La
 * production ne valide donc jamais, et ne numérote jamais.
 *
 * La garantie est structurelle plutôt que vérifiée ici : `promote` refuse la
 * production, donc aucune version n'y atteint « À tester », donc aucune n'y est
 * validée.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * TRANSACTION ORDONNÉE, ET NON CTE UNIQUE (correctif WF-03)
 *
 * L'ancienne écriture était une CTE unique dont le SELECT final ne lisait que
 * la branche `promue`. PostgreSQL exécute d'abord les CTE modifiantes lues
 * par la requête principale, puis les autres « en fin de requête » : la
 * promotion passait AVANT la rétrogradation, et l'index partiel unique
 * `ai_config_versions_single_active_idx` (non différable) rejetait la ligne
 * dès qu'une Active existait. Seule la toute première validation passait.
 *
 * L'ordre ne dépend plus désormais de l'optimiseur : une transaction, et dans
 * cet ordre explicite —
 *   1. verrou de l'environnement (bascules concurrentes sérialisées) ;
 *   2. rétrogradation de l'ancienne Active en Validée ;
 *   3. promotion de la version et calcul de son numéro, dans la même
 *      instruction (le numéro ne peut pas être réclamé deux fois) ;
 *   4. marquage des Brouillons dérivés de l'ancienne Active (attribut
 *      `is_stale`, jamais statut — §4.1).
 * Un échec à n'importe quelle étape annule le tout : l'environnement n'est
 * jamais laissé sans Active.
 */
export async function validateVersion(
  versionId: number,
  userId: number,
): Promise<{ status: ConfigVersionStatus; visibleNumber: number }> {
  const rows0 = await pgClient.unsafe(
    `SELECT status, environment FROM ai_config_versions WHERE id = $1 LIMIT 1`,
    [versionId] as never[],
  );
  const r0 = (rows0 as unknown as Row[])[0];
  if (!r0) throw new Error(`[config] Version ${versionId} introuvable.`);
  const to = transition(r0.status as ConfigVersionStatus, 'validate');
  const environment = String(r0.environment);

  const n = await pgClient.begin(async (tx) => {
    const t = tx as unknown as TxLike;
    await lockEnvironment(t, environment);

    // Revérification sous verrou : une autre session a pu valider ou
    // rétrograder la version entre la lecture ci-dessus et le verrou.
    const cur = (await t.unsafe(
      `SELECT status FROM ai_config_versions WHERE id = $1 FOR UPDATE`,
      [versionId] as never[],
    )) as Row[];
    if (!cur[0]) throw new Error(`[config] Version ${versionId} introuvable.`);
    transition(cur[0].status as ConfigVersionStatus, 'validate');

    // 2. D'abord libérer la place d'Active.
    const anciennes = (await t.unsafe(
      `UPDATE ai_config_versions
          SET status = 'VALIDATED', updated_at = NOW()
        WHERE environment = $1 AND status = 'ACTIVE' AND id <> $2
        RETURNING id`,
      [environment, versionId] as never[],
    )) as Row[];

    // 3. Puis promouvoir et numéroter en une instruction.
    const promue = (await t.unsafe(
      `UPDATE ai_config_versions
          SET status = $2,
              visible_number = (
                SELECT COALESCE(MAX(visible_number), 0) + 1
                  FROM ai_config_versions WHERE environment = $3
              ),
              validated_by = $4, validated_at = NOW(),
              activated_by = $4, activated_at = NOW(), updated_at = NOW()
        WHERE id = $1
        RETURNING visible_number`,
      [versionId, to, environment, userId] as never[],
    )) as Row[];

    // 4. WF-03 : les Brouillons dérivés de l'ancienne Active deviennent
    // potentiellement obsolètes.
    const idsAnciennes = anciennes.map((a) => Number(a.id));
    if (idsAnciennes.length > 0) {
      await t.unsafe(
        `UPDATE ai_config_versions
            SET is_stale = TRUE, updated_at = NOW()
          WHERE status = 'DRAFT' AND base_version_id = ANY($1::int[])`,
        [idsAnciennes] as never[],
      );
    }
    return promue[0]?.visible_number;
  });

  if (n == null) throw new Error(`[config] Validation impossible pour la version ${versionId}.`);
  return { status: to, visibleNumber: Number(n) };
}

/**
 * WF-05 et WF-06 — activation ou restauration.
 *
 * Même écriture, deux événements : c'est l'APPELANT qui doit ensuite laisser
 * terminer les exécutions en cours (activation) ou les interrompre et remettre
 * les jobs en tête de file (rollback). Cette fonction ne fait que la bascule ;
 * elle rend l'événement pour que l'appelant ne puisse pas l'ignorer.
 *
 * Même structure que `validateVersion` (transaction ordonnée : rétrograder puis
 * promouvoir). L'ancienne CTE fonctionnait parce que son SELECT lisait
 * `ancienne` en premier — un ordre d'évaluation que PostgreSQL ne garantit
 * pas contractuellement. On ne s'appuie plus dessus.
 */
export async function switchActive(
  versionId: number,
  userId: number,
  event: Extract<ConfigVersionEvent, 'activate' | 'rollback'>,
): Promise<{ status: ConfigVersionStatus; event: typeof event; previousId: number | null }> {
  const rows0 = await pgClient.unsafe(
    `SELECT status, environment FROM ai_config_versions WHERE id = $1 LIMIT 1`,
    [versionId] as never[],
  );
  const r0 = (rows0 as unknown as Row[])[0];
  if (!r0) throw new Error(`[config] Version ${versionId} introuvable.`);
  const to = transition(r0.status as ConfigVersionStatus, event);
  const environment = String(r0.environment);

  const r = await pgClient.begin(async (tx) => {
    const t = tx as unknown as TxLike;
    await lockEnvironment(t, environment);

    const cur = (await t.unsafe(
      `SELECT status FROM ai_config_versions WHERE id = $1 FOR UPDATE`,
      [versionId] as never[],
    )) as Row[];
    if (!cur[0]) throw new Error(`[config] Version ${versionId} introuvable.`);
    transition(cur[0].status as ConfigVersionStatus, event);

    const anciennes = (await t.unsafe(
      `UPDATE ai_config_versions
          SET status = 'VALIDATED', updated_at = NOW()
        WHERE environment = $1 AND status = 'ACTIVE' AND id <> $2
        RETURNING id`,
      [environment, versionId] as never[],
    )) as Row[];

    const promue = (await t.unsafe(
      `UPDATE ai_config_versions
          SET status = $2, activated_by = $3, activated_at = NOW(), updated_at = NOW()
        WHERE id = $1
        RETURNING id`,
      [versionId, to, userId] as never[],
    )) as Row[];

    return { previousId: anciennes[0]?.id ?? null, promotedId: promue[0]?.id ?? null };
  });

  if (r.promotedId == null) {
    throw new Error(`[config] Bascule impossible pour la version ${versionId}.`);
  }
  return {
    status: to,
    event,
    previousId: r.previousId == null ? null : Number(r.previousId),
  };
}

/** WF-01 — un Brouillon dont l'Active de base a changé est marqué obsolète. */
export async function markStaleDrafts(baseVersionId: number): Promise<number> {
  const rows = await pgClient.unsafe(
    `UPDATE ai_config_versions
        SET is_stale = TRUE, updated_at = NOW()
      WHERE status = 'DRAFT' AND base_version_id = $1 AND is_stale = FALSE
      RETURNING id`,
    [baseVersionId] as never[],
  );
  return (rows as unknown as Row[]).length;
}
