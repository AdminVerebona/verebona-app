/**
 * Rattrapage BO « Sinistres : nettoyage de l'ancien modèle » — lot 83D
 * (CDC « Opérations, Agenda, Timeline, Sinistres v5 » §15 à §18, E14, E15,
 * E16 ; arbitrages PO V-Q1, V-Q2 — en préproduction, sans migration
 * historique — et C-Q5 / C-Q8 — point de restauration AVANT).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUI EST PURGÉ (données PROPRES à l'ancien bloc « Sinistres » du bien)
 *
 *   ACTIONS      business_operation_claim_actions      lignes supprimées
 *                (§18.1 : une étape est un élément d'Agenda)
 *   EXCHANGES    business_operation_claim_exchanges    lignes supprimées
 *                (§18.2 : un échange est un document)
 *   CHILDREN     business_operations.parent_operation_id  remis à vide
 *                (§18.4, AC39 : plus d'intervention enfant ; l'intervention
 *                elle-même est CONSERVÉE)
 *   LEGACY_FORM  asset_additional_infos.claim_json     remis à `{}`
 *                (ancien formulaire, plus lu)
 *   MIGRATION_MARKS business_operation_claim_migration_marks  supprimés
 *                (repères techniques de la migration de cet ancien formulaire)
 *   CARDS        cartes « À traiter » OPERATION-CLAIM-PARENT / -DETACH
 *                encore ouvertes : closes « obsolètes » (tracé)
 *
 * CE QUI EST PRÉSERVÉ (vérifié par l'e2e L83D-E06) : documents et fichiers,
 * Opérations (y compris l'intervention qui était « enfant »), éléments
 * d'Agenda, événements, Pièces, équipements, détails d'assurance, dommages
 * détaillés et leurs photos / justificatifs, sources (décisions comprises),
 * liens et références. Aucune de ces tables n'est écrite ; les tables
 * purgées ne sont la cible d'aucune clé étrangère (pas de cascade).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * GARDE-FOUS
 *
 *   · SIMULER : lecture seule — mêmes requêtes, rapport exact, aucune écriture
 *     (seule l'exécution est tracée dans `claim_legacy_cleanup_runs`).
 *   · APPLIQUER : REFUSÉ (rien n'est écrit, refus tracé) sans POINT DE
 *     RESTAURATION de moins de 24 h compatible avec le schéma courant
 *     (points du lot 82E, `listDatabaseBackups` + `checkRestoreCompatibility`).
 *     Une transaction par compte sous le verrou Opération du compte
 *     (39101) ; image AVANT de chaque ligne dans `claim_legacy_cleanup_journal`.
 *     Puis une campagne de cohérence (orchestrateur 82B) est demandée sur les
 *     comptes ÉLIGIBLES touchés (C-Q10 : jamais un compte inactif).
 *   · RESTAURER : par identifiant d'exécution, journal rejoué à l'envers ;
 *     une ligne modifiée depuis est signalée en conflit, jamais écrasée.
 *   · Idempotent : une seconde application ne trouve rien et n'écrit rien.
 *
 * Aucune tâche planifiée : lancé uniquement depuis le BO (Exploitation ›
 * Rattrapages). Aucune passerelle de compatibilité : le code de l'ancien
 * modèle est retiré dans la même livraison.
 *
 * Lot 84A (O-10) : ÉTAPE FINALE « Finaliser » (`legacy-finalize.ts`) —
 * suppression définitive des tables et colonnes inertes, possible seulement
 * quand ce nettoyage ne trouve plus rien sur AUCUN compte. Ce module lit
 * donc chaque objet de l'ancien modèle SEULEMENT S'IL EST PRÉSENT
 * (`readLegacyClaimSchema`) : après la finalisation, Simuler / Appliquer
 * rendent « ancien modèle supprimé définitivement », et Restaurer est
 * REFUSÉ (code `LEGACY_MODEL_FINALIZED`, rien n'est écrit).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { RETIRED_CLAIM_PARENT_RULES } from '@/services/to-process/operation-cards';
import { lastLegacyFinalization, legacyClaimModelComplete, legacyClaimModelPresent, readLegacyClaimSchema, type LegacyClaimSchema } from './legacy-schema';

type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;
type Row = Record<string, unknown>;

export const CLEANUP_CATEGORIES = ['ACTIONS', 'EXCHANGES', 'CHILDREN', 'LEGACY_FORM', 'MIGRATION_MARKS', 'CARDS'] as const;
type CleanupCategory = (typeof CLEANUP_CATEGORIES)[number];

export const CATEGORY_LABELS: Readonly<Record<CleanupCategory, string>> = {
  ACTIONS: 'Actions de sinistre (ancien modèle)',
  EXCHANGES: 'Échanges de sinistre (ancien modèle)',
  CHILDREN: 'Interventions « enfant » d’un sinistre (lien retiré, intervention conservée)',
  LEGACY_FORM: 'Ancien formulaire Sinistre du bien (claim_json)',
  MIGRATION_MARKS: 'Repères de migration de l’ancien formulaire',
  CARDS: 'Questions « À traiter » de lien intervention ↔ sinistre encore ouvertes',
};

/** Point de restauration exigé avant d'appliquer (C-Q8) : 24 heures. */
const RESTORE_POINT_MAX_AGE_MS = 24 * 3_600_000;

export interface RestorePointCheck {
  ok: boolean;
  backupId: string | null;
  finishedAt: string | null;
  /** Motif du refus (lisible au BO) ; null si un point valide existe. */
  reason: string | null;
}

/** Point de restauration candidat (manifeste format 2 du lot 82E, avec sa compatibilité au schéma courant). */
export interface RestorePointInfo {
  backupId: string | null;
  version: number | null;
  finishedAt: string | null;
  restorable: boolean;
}

/**
 * Points de restauration disponibles (API du lot 82E) : manifestes du
 * stockage, compatibilité au schéma COURANT. Stockage non configuré ou
 * illisible : aucun point (l'application est alors refusée).
 */
export async function listRestorePoints(sql: Sql): Promise<RestorePointInfo[]> {
  const { isS3Configured } = await import('@/lib/s3-config');
  if (!isS3Configured()) return [];
  const [{ listDatabaseBackups }, { readSchemaSignature, checkRestoreCompatibility }] = await Promise.all([
    import('@/services/backup/database-backup.service'), import('@/services/backup/schema-signature'),
  ]);
  const current = await readSchemaSignature(async (q, p = []) => (await sql.unsafe(q, p as never[])) as unknown as Row[]);
  return (await listDatabaseBackups(60)).map((b) => ({
    backupId: b.backupId,
    version: b.version,
    finishedAt: b.manifest && b.manifest.version === 2 ? b.manifest.finishedAt : null,
    restorable: !!b.manifest && checkRestoreCompatibility(b.manifest as never, current).restorable,
  }));
}

/** Un point de restauration de moins de 24 h, restaurable dans le schéma courant ? (pur) */
export function pickRecentRestorePoint(points: readonly RestorePointInfo[], now: Date, maxAgeMs = RESTORE_POINT_MAX_AGE_MS): RestorePointCheck {
  const recents = points
    .filter((p) => p.version === 2 && !!p.backupId && !!p.finishedAt && !Number.isNaN(Date.parse(p.finishedAt)))
    .filter((p) => now.getTime() - Date.parse(p.finishedAt!) <= maxAgeMs && Date.parse(p.finishedAt!) <= now.getTime() + 60_000)
    .sort((a, b) => Date.parse(b.finishedAt!) - Date.parse(a.finishedAt!));
  const ok = recents.find((p) => p.restorable);
  if (ok) return { ok: true, backupId: ok.backupId, finishedAt: ok.finishedAt, reason: null };
  if (recents.length) {
    return { ok: false, backupId: null, finishedAt: null, reason: 'Le point de restauration de moins de 24 h n’est pas restaurable dans le schéma actuel (base modifiée depuis) : créez un nouveau point de restauration (bloc 0) puis relancez.' };
  }
  return { ok: false, backupId: null, finishedAt: null, reason: 'Aucun point de restauration de moins de 24 h : créez-en un (bloc 0 « Point de restauration de la base », Appliquer) avant d’appliquer ce nettoyage.' };
}

interface CleanupOptions {
  sql: Sql;
  mode: 'SIMULATE' | 'APPLY';
  accountId?: number | null;
  reason?: string | null;
  adminUserId?: number | null;
  now?: Date;
  log?: (m: string) => void;
  /** Tests : points de restauration (défaut : stockage réel, `listRestorePoints`). */
  restorePoints?: () => Promise<RestorePointInfo[]>;
  /** Tests : demande de campagne de cohérence (défaut : orchestrateur 82B). */
  requestCoherence?: (accountIds: number[], runId: string) => Promise<number | null>;
}

export type CategoryCounters = Record<CleanupCategory, number>;

export interface CleanupResult {
  runId: string;
  mode: 'SIMULATE' | 'APPLY';
  status: 'succeeded' | 'refused' | 'failed';
  refusal: string | null;
  restorePoint: { backupId: string | null; finishedAt: string | null } | null;
  accounts: number[];
  counters: CategoryCounters;
  byAccount: Array<{ accountId: number; counters: CategoryCounters }>;
  /** Échantillons lisibles (bornés) : ce qui serait / a été purgé. */
  samples: Array<{ accountId: number; category: CleanupCategory; label: string }>;
  journalRows: number;
  coherence: { requested: boolean; campaignId: number | null; eligibleAccounts: number[]; skippedAccounts: number[] };
  /** Lot 84A : ancien modèle supprimé définitivement (finalisation O-10) — plus rien à nettoyer. */
  finalized?: { at: string | null; runId: string | null } | null;
}

const zero = (): CategoryCounters => Object.fromEntries(CLEANUP_CATEGORIES.map((c) => [c, 0])) as CategoryCounters;
const SAMPLES_MAX = 60;

/**
 * Requêtes « ce qui reste de l'ancien modèle », par catégorie : `(compte, n)`.
 * Seuls les objets PRÉSENTS sont lus (lot 84A). Une seule définition sert au
 * nettoyage (comptes à traiter) et à la finalisation (nettoyage complet ?).
 */
function remainingQueries(schema: LegacyClaimSchema): Array<{ category: CleanupCategory; sql: string }> {
  const out: Array<{ category: CleanupCategory; sql: string }> = [];
  if (schema.tables.business_operation_claim_actions) {
    out.push({ category: 'ACTIONS', sql: `SELECT o.account_id FROM business_operation_claim_actions a JOIN business_operations o ON o.id = a.operation_id` });
  }
  if (schema.tables.business_operation_claim_exchanges) {
    out.push({ category: 'EXCHANGES', sql: `SELECT o.account_id FROM business_operation_claim_exchanges x JOIN business_operations o ON o.id = x.operation_id` });
  }
  if (schema.parentColumn) out.push({ category: 'CHILDREN', sql: `SELECT account_id FROM business_operations WHERE parent_operation_id IS NOT NULL` });
  if (schema.claimJsonColumn) out.push({ category: 'LEGACY_FORM', sql: `SELECT account_id FROM asset_additional_infos WHERE claim_json IS DISTINCT FROM '{}'::jsonb` });
  if (schema.tables.business_operation_claim_migration_marks) out.push({ category: 'MIGRATION_MARKS', sql: `SELECT account_id FROM business_operation_claim_migration_marks` });
  out.push({ category: 'CARDS', sql: `SELECT account_id FROM to_process_actions WHERE resolved_at IS NULL AND rule_code = ANY($1::text[])` });
  return out;
}

/** Comptes qui portent encore une donnée de l'ancien modèle (ordre croissant). */
async function accountsToClean(sql: Sql | Tx, accountId: number | null, schema: LegacyClaimSchema): Promise<number[]> {
  const parts = remainingQueries(schema).map((q) => q.sql);
  const r = await sql.unsafe<Array<{ account_id: number }>>(
    `SELECT DISTINCT account_id FROM (${parts.join(' UNION ')}) x WHERE $2::int IS NULL OR account_id = $2::int ORDER BY account_id`,
    [[...RETIRED_CLAIM_PARENT_RULES], accountId] as never[],
  );
  return r.map((x) => Number(x.account_id));
}

/**
 * Lot 84A — ce qui reste de l'ancien modèle sur TOUS les comptes (lecture
 * seule) : décompte par catégorie et comptes concernés. Condition de la
 * finalisation : tout à zéro.
 */
export async function countLegacyRemaining(sql: Sql | Tx, schema: LegacyClaimSchema): Promise<{ counters: CategoryCounters; accounts: number[] }> {
  const counters = zero();
  const qs = remainingQueries(schema);
  const r = await sql.unsafe<Array<{ category: CleanupCategory; n: number }>>(
    qs.map((q) => `SELECT '${q.category}'::text AS category, count(*)::int AS n FROM (${q.sql}) x`).join(' UNION ALL '),
    [[...RETIRED_CLAIM_PARENT_RULES]] as never[],
  );
  for (const x of r) counters[x.category] = Number(x.n);
  return { counters, accounts: await accountsToClean(sql, null, schema) };
}

interface Found { category: CleanupCategory; table: string; key: Row; before: Row; label: string }

/** Inventaire d'un compte (lecture seule) — la même lecture sert à simuler et à appliquer. Objets présents seulement (lot 84A). */
async function inventory(tx: Sql | Tx, accountId: number, schema: LegacyClaimSchema): Promise<Found[]> {
  const out: Found[] = [];
  const rows = async (q: postgres.PendingQuery<Row[]>) => (await q) as unknown as Array<{ r: Row; k: Row; label: string }>;
  if (schema.tables.business_operation_claim_actions) for (const x of await rows(tx`
      SELECT row_to_json(a.*)::jsonb AS r, jsonb_build_object('id', a.id) AS k,
             coalesce(a.date::text || ' · ', '') || a.title AS label
        FROM business_operation_claim_actions a JOIN business_operations o ON o.id = a.operation_id
       WHERE o.account_id = ${accountId} ORDER BY a.id`)) out.push({ category: 'ACTIONS', table: 'business_operation_claim_actions', key: x.k, before: x.r, label: x.label });
  if (schema.tables.business_operation_claim_exchanges) for (const x of await rows(tx`
      SELECT row_to_json(e.*)::jsonb AS r, jsonb_build_object('id', e.id) AS k,
             coalesce(e.date::text || ' · ', '') || e.summary AS label
        FROM business_operation_claim_exchanges e JOIN business_operations o ON o.id = e.operation_id
       WHERE o.account_id = ${accountId} ORDER BY e.id`)) out.push({ category: 'EXCHANGES', table: 'business_operation_claim_exchanges', key: x.k, before: x.r, label: x.label });
  if (schema.parentColumn) for (const x of await rows(tx`
      SELECT jsonb_build_object('parent_operation_id', o.parent_operation_id) AS r, jsonb_build_object('id', o.id) AS k,
             'Opération #' || o.id || ' (' || coalesce(o.type_code, '—') || ') enfant de #' || o.parent_operation_id AS label
        FROM business_operations o WHERE o.account_id = ${accountId} AND o.parent_operation_id IS NOT NULL ORDER BY o.id`)) out.push({ category: 'CHILDREN', table: 'business_operations', key: x.k, before: x.r, label: x.label });
  if (schema.claimJsonColumn) for (const x of await rows(tx`
      SELECT jsonb_build_object('claim_json', ai.claim_json) AS r, jsonb_build_object('asset_id', ai.asset_id) AS k,
             'Bien #' || ai.asset_id AS label
        FROM asset_additional_infos ai WHERE ai.account_id = ${accountId} AND ai.claim_json IS DISTINCT FROM '{}'::jsonb ORDER BY ai.asset_id`)) out.push({ category: 'LEGACY_FORM', table: 'asset_additional_infos', key: x.k, before: x.r, label: x.label });
  if (schema.tables.business_operation_claim_migration_marks) for (const x of await rows(tx`
      SELECT row_to_json(m.*)::jsonb AS r, jsonb_build_object('asset_id', m.asset_id) AS k,
             'Bien #' || m.asset_id || ' : ' || m.outcome AS label
        FROM business_operation_claim_migration_marks m WHERE m.account_id = ${accountId} ORDER BY m.asset_id`)) out.push({ category: 'MIGRATION_MARKS', table: 'business_operation_claim_migration_marks', key: x.k, before: x.r, label: x.label });
  for (const x of await rows(tx`
      SELECT jsonb_build_object('resolved_at', t.resolved_at, 'resolution_reason', t.resolution_reason, 'updated_at', t.updated_at) AS r,
             jsonb_build_object('id', t.id) AS k, t.rule_code || ' : ' || coalesce(t.question, '') AS label
        FROM to_process_actions t
       WHERE t.account_id = ${accountId} AND t.resolved_at IS NULL AND t.rule_code = ANY(${[...RETIRED_CLAIM_PARENT_RULES]}::text[]) ORDER BY t.id`)) out.push({ category: 'CARDS', table: 'to_process_actions', key: x.k, before: x.r, label: x.label });
  return out;
}

async function journal(tx: Tx, runId: string, accountId: number, table: string, key: Row, action: 'DELETE' | 'UPDATE' | 'INSERT', before: Row | null, after: Row | null): Promise<void> {
  await tx`
    INSERT INTO claim_legacy_cleanup_journal (run_id, account_id, target_table, target_key, action, before_row, after_row)
    VALUES (${runId}, ${accountId}, ${table}, ${JSON.stringify(key)}::jsonb, ${action}, ${before === null ? null : JSON.stringify(before)}::jsonb, ${after === null ? null : JSON.stringify(after)}::jsonb)`;
}

/** Applique l'inventaire d'un compte (dans SA transaction, sous le verrou Opération du compte). */
async function applyAccount(tx: Tx, runId: string, accountId: number, items: Found[], now: Date): Promise<number> {
  let n = 0;
  for (const it of items) {
    const id = Number(it.key.id ?? it.key.asset_id);
    switch (it.category) {
      case 'ACTIONS':
        await journal(tx, runId, accountId, it.table, it.key, 'DELETE', it.before, null);
        await tx`DELETE FROM business_operation_claim_actions WHERE id = ${id}`;
        break;
      case 'EXCHANGES':
        await journal(tx, runId, accountId, it.table, it.key, 'DELETE', it.before, null);
        await tx`DELETE FROM business_operation_claim_exchanges WHERE id = ${id}`;
        break;
      case 'CHILDREN':
        await journal(tx, runId, accountId, it.table, it.key, 'UPDATE', it.before, { parent_operation_id: null });
        await tx`UPDATE business_operations SET parent_operation_id = NULL WHERE id = ${id} AND account_id = ${accountId}`;
        break;
      case 'LEGACY_FORM':
        await journal(tx, runId, accountId, it.table, it.key, 'UPDATE', it.before, { claim_json: {} });
        // Ni version ni date de « Préparation des dossiers » : la donnée n'est plus lue (aucun conflit 409 parasite).
        await tx`UPDATE asset_additional_infos SET claim_json = '{}'::jsonb WHERE asset_id = ${id} AND account_id = ${accountId}`;
        break;
      case 'MIGRATION_MARKS':
        await journal(tx, runId, accountId, it.table, it.key, 'DELETE', it.before, null);
        await tx`DELETE FROM business_operation_claim_migration_marks WHERE asset_id = ${id} AND account_id = ${accountId}`;
        break;
      case 'CARDS': {
        await journal(tx, runId, accountId, it.table, it.key, 'UPDATE', it.before, { resolution_reason: 'OBSOLETE' });
        const [a] = await tx<{ id: number; target_type: string; target_id: number; relation_key: string | null; rule_code: string }[]>`
          UPDATE to_process_actions SET resolved_at = ${now.toISOString()}::timestamptz, resolution_reason = 'OBSOLETE', updated_at = ${now.toISOString()}::timestamptz
           WHERE id = ${id} AND account_id = ${accountId} AND resolved_at IS NULL
          RETURNING id, target_type, target_id, relation_key, rule_code`;
        if (a) {
          const [ev] = await tx<{ id: number }[]>`
            INSERT INTO to_process_action_events (action_id, account_id, event, actor_user_id, target_type, target_id, field_key, details, created_at)
            VALUES (${a.id}, ${accountId}, 'OBSOLETE', NULL, ${a.target_type}, ${a.target_id}, ${a.relation_key},
                    ${JSON.stringify({ ruleCode: a.rule_code, reason: 'L83D_CLAIM_PARENT_RETIRED', runId })}::jsonb, ${now.toISOString()}::timestamptz)
            RETURNING id`;
          await journal(tx, runId, accountId, 'to_process_action_events', { id: Number(ev.id) }, 'INSERT', null, null);
          n++;
        }
        break;
      }
    }
    n++;
  }
  return n;
}

async function startRun(sql: Sql, p: { runId: string; mode: string; accountId: number | null; reason: string | null; adminUserId: number | null; restoreOf?: string | null }): Promise<void> {
  await sql`
    INSERT INTO claim_legacy_cleanup_runs (id, mode, account_filter, reason, admin_user_id, restore_of)
    VALUES (${p.runId}, ${p.mode}, ${p.accountId}, ${p.reason}, ${p.adminUserId}, ${p.restoreOf ?? null})`;
}

async function finishRun(sql: Sql, runId: string, p: { status: string; counters?: Row; accounts?: number[]; error?: string | null; restorePoint?: { backupId: string | null; finishedAt: string | null } | null; campaignId?: number | null; mode?: string }): Promise<void> {
  await sql`
    UPDATE claim_legacy_cleanup_runs
       SET status = ${p.status}, counters = ${JSON.stringify(p.counters ?? {})}::jsonb, accounts = ${p.accounts ?? []}::int[], error = ${p.error ?? null},
           restore_point_id = ${p.restorePoint?.backupId ?? null}, restore_point_at = ${p.restorePoint?.finishedAt ?? null}::timestamptz,
           coherence_campaign_id = ${p.campaignId ?? null}, mode = COALESCE(${p.mode ?? null}, mode), finished_at = now()
     WHERE id = ${runId}`;
}

/** Campagne de cohérence (82B) sur les comptes ÉLIGIBLES touchés (C-Q10). */
async function defaultRequestCoherence(accountIds: number[], runId: string): Promise<number | null> {
  const { coherenceTablesReady, startCampaign } = await import('@/services/coherence/orchestrator');
  if (!accountIds.length || !(await coherenceTablesReady())) return null;
  return startCampaign({ kind: 'MANUAL', trigger: `claims-legacy-cleanup:${runId}`.slice(0, 120), scopeAccountIds: accountIds });
}

/** Simuler ou appliquer le nettoyage (voir l'en-tête). */
export async function runClaimLegacyCleanup(opts: CleanupOptions): Promise<CleanupResult> {
  const { sql } = opts;
  const now = opts.now ?? new Date();
  const log = opts.log ?? (() => undefined);
  const runId = randomUUID();
  const accountFilter = opts.accountId ?? null;
  const result: CleanupResult = {
    runId, mode: opts.mode, status: 'succeeded', refusal: null, restorePoint: null, accounts: [], counters: zero(), byAccount: [], samples: [],
    journalRows: 0, coherence: { requested: false, campaignId: null, eligibleAccounts: [], skippedAccounts: [] },
  };
  await startRun(sql, { runId, mode: opts.mode, accountId: accountFilter, reason: opts.reason ?? null, adminUserId: opts.adminUserId ?? null });

  // Lot 84A (O-10) : ancien modèle supprimé définitivement → plus rien à nettoyer (aucun point de restauration requis).
  const schema = await readLegacyClaimSchema(sql);
  if (!legacyClaimModelPresent(schema)) {
    const fin = await lastLegacyFinalization(sql);
    result.finalized = { at: fin?.at ?? null, runId: fin?.runId ?? null };
    await finishRun(sql, runId, { status: 'succeeded', counters: { ...result.counters, finalized: true } });
    log(`ancien modèle supprimé définitivement${fin ? ` le ${fin.at}` : ''} : rien à nettoyer`);
    return result;
  }

  // C-Q8 : aucun écrit sans point de restauration de moins de 24 h (vérifié AVANT toute lecture d'inventaire).
  if (opts.mode === 'APPLY') {
    let check: RestorePointCheck;
    try {
      check = pickRecentRestorePoint(await (opts.restorePoints ?? (() => listRestorePoints(sql)))(), now);
    } catch (e) {
      check = { ok: false, backupId: null, finishedAt: null, reason: `Points de restauration illisibles (${(e as Error).message}) : application refusée.` };
    }
    if (!check.ok) {
      result.status = 'refused';
      result.refusal = check.reason;
      await finishRun(sql, runId, { status: 'refused', mode: 'REFUSED', error: check.reason });
      log(`refusé : ${check.reason}`);
      return result;
    }
    result.restorePoint = { backupId: check.backupId, finishedAt: check.finishedAt };
    log(`point de restauration ${check.backupId} (${check.finishedAt})`);
  }

  try {
    const comptes = await accountsToClean(sql, accountFilter, schema);
    for (const accountId of comptes) {
      const traiter = async (tx: Sql | Tx) => {
        const items = await inventory(tx, accountId, schema);
        const c = zero();
        for (const it of items) c[it.category]++;
        if (opts.mode === 'APPLY' && items.length) result.journalRows += await applyAccount(tx as Tx, runId, accountId, items, now);
        return { items, c };
      };
      const { items, c } = opts.mode === 'APPLY'
        ? await sql.begin(async (tx) => {
          await tx`SELECT pg_advisory_xact_lock(39101::int, ${accountId}::int)`;
          return traiter(tx);
        })
        : await traiter(sql);
      if (!items.length) continue;
      result.accounts.push(accountId);
      result.byAccount.push({ accountId, counters: c });
      for (const k of CLEANUP_CATEGORIES) result.counters[k] += c[k];
      for (const it of items) if (result.samples.length < SAMPLES_MAX) result.samples.push({ accountId, category: it.category, label: it.label.slice(0, 160) });
      log(`compte ${accountId} : ${CLEANUP_CATEGORIES.filter((k) => c[k]).map((k) => `${k} ${c[k]}`).join(', ')}`);
    }

    if (opts.mode === 'APPLY' && result.accounts.length) {
      // V-Q2 : après nettoyage, cohérence globale sur les comptes actifs concernés (jamais un compte inéligible).
      const { filterEligibleAccountIds } = await import('@/services/account/processing-eligibility');
      const eligibles = await filterEligibleAccountIds(result.accounts, now);
      result.coherence.eligibleAccounts = result.accounts.filter((a) => eligibles.has(a));
      result.coherence.skippedAccounts = result.accounts.filter((a) => !eligibles.has(a));
      if (result.coherence.eligibleAccounts.length) {
        try {
          result.coherence.campaignId = await (opts.requestCoherence ?? defaultRequestCoherence)(result.coherence.eligibleAccounts, runId);
          result.coherence.requested = result.coherence.campaignId !== null;
        } catch (e) {
          log(`campagne de cohérence non demandée : ${(e as Error).message}`);
        }
      }
    }
    await finishRun(sql, runId, { status: 'succeeded', counters: result.counters, accounts: result.accounts, restorePoint: result.restorePoint, campaignId: result.coherence.campaignId });
    return result;
  } catch (e) {
    result.status = 'failed';
    await finishRun(sql, runId, { status: 'failed', counters: result.counters, accounts: result.accounts, error: (e as Error).message, restorePoint: result.restorePoint });
    throw e;
  }
}

export interface CleanupRestoreReport { runId: string; restoreRunId: string; restored: number; conflicts: string[] }

/** Lot 84A : restauration d'un nettoyage refusée après la suppression définitive de l'ancien modèle. */
class LegacyModelFinalizedError extends Error {
  readonly code = 'LEGACY_MODEL_FINALIZED';
  constructor(readonly finalizedAt: string | null) {
    super(`Restauration refusée : l’ancien modèle Sinistres a été supprimé définitivement${finalizedAt ? ` le ${finalizedAt.slice(0, 16).replace('T', ' à ')} (UTC)` : ''} `
      + '(finalisation du nettoyage). Les tables et colonnes que ce nettoyage avait vidées n’existent plus : le nettoyage ne peut plus être '
      + 'restauré. Rien n’a été modifié ; le journal de l’exécution reste consultable.');
    this.name = 'LegacyModelFinalizedError';
  }
}

/**
 * Restaure une APPLICATION par son identifiant : journal rejoué à l'envers,
 * dans UNE transaction. Une ligne déjà présente (supprimée puis recréée) ou
 * modifiée depuis l'application est signalée, jamais écrasée.
 */
export async function restoreClaimLegacyCleanup(sql: Sql, runId: string, opts: { reason?: string | null; adminUserId?: number | null } = {}): Promise<CleanupRestoreReport> {
  const [run] = await sql<{ mode: string; status: string }[]>`SELECT mode, status FROM claim_legacy_cleanup_runs WHERE id = ${runId}`;
  if (!run || run.mode !== 'APPLY') throw new Error(`Exécution ${runId} introuvable ou non appliquée : rien à restaurer.`);
  // Lot 84A (O-10) : après la finalisation (même partielle), aucune restauration — refus tracé, rien d'écrit.
  if (!legacyClaimModelComplete(await readLegacyClaimSchema(sql))) {
    const fin = await lastLegacyFinalization(sql);
    const err = new LegacyModelFinalizedError(fin?.at ?? null);
    const refusRunId = randomUUID();
    await startRun(sql, { runId: refusRunId, mode: 'REFUSED', accountId: null, reason: opts.reason ?? null, adminUserId: opts.adminUserId ?? null, restoreOf: runId });
    await finishRun(sql, refusRunId, { status: 'refused', error: err.message });
    throw err;
  }
  const restoreRunId = randomUUID();
  await startRun(sql, { runId: restoreRunId, mode: 'RESTORE', accountId: null, reason: opts.reason ?? null, adminUserId: opts.adminUserId ?? null, restoreOf: runId });
  const out: CleanupRestoreReport = { runId, restoreRunId, restored: 0, conflicts: [] };
  const comptes = new Set<number>();
  await sql.begin(async (tx) => {
    const lignes = await tx<{ id: number; account_id: number; target_table: string; target_key: Row; action: string; before_row: Row | null; after_row: Row | null }[]>`
      SELECT id, account_id, target_table, target_key, action, before_row, after_row FROM claim_legacy_cleanup_journal
       WHERE run_id = ${runId} AND restored_at IS NULL ORDER BY id DESC`;
    for (const accountId of [...new Set(lignes.map((l) => Number(l.account_id)))].sort((a, b) => a - b)) {
      await tx`SELECT pg_advisory_xact_lock(39101::int, ${accountId}::int)`;
    }
    for (const l of lignes) {
      comptes.add(Number(l.account_id));
      const id = Number(l.target_key.id ?? l.target_key.asset_id);
      let ok = false;
      await tx.savepoint(async (sp) => {
        switch (`${l.target_table}:${l.action}`) {
          case 'business_operation_claim_actions:DELETE':
          case 'business_operation_claim_exchanges:DELETE':
          case 'business_operation_claim_migration_marks:DELETE': {
            const r = await sp.unsafe(
              `INSERT INTO ${l.target_table} SELECT * FROM jsonb_populate_record(NULL::${l.target_table}, $1::jsonb) ON CONFLICT DO NOTHING RETURNING 1`,
              [JSON.stringify(l.before_row)] as never[]);
            ok = r.length > 0;
            break;
          }
          case 'business_operations:UPDATE': {
            const parent = l.before_row?.parent_operation_id == null ? null : Number(l.before_row.parent_operation_id);
            ok = (await sp`UPDATE business_operations SET parent_operation_id = ${parent}
                            WHERE id = ${id} AND account_id = ${l.account_id} AND parent_operation_id IS NULL`).count > 0;
            break;
          }
          case 'asset_additional_infos:UPDATE':
            ok = (await sp`UPDATE asset_additional_infos SET claim_json = ${JSON.stringify(l.before_row?.claim_json ?? {})}::jsonb
                            WHERE asset_id = ${id} AND account_id = ${l.account_id} AND claim_json = '{}'::jsonb`).count > 0;
            break;
          case 'to_process_actions:UPDATE':
            ok = (await sp`UPDATE to_process_actions SET resolved_at = NULL, resolution_reason = NULL,
                                   updated_at = COALESCE(${(l.before_row?.updated_at as string | null) ?? null}::timestamptz, updated_at)
                            WHERE id = ${id} AND account_id = ${l.account_id} AND resolution_reason = 'OBSOLETE'`).count > 0;
            break;
          case 'to_process_action_events:INSERT':
            ok = (await sp`DELETE FROM to_process_action_events WHERE id = ${id} AND account_id = ${l.account_id}`).count > 0;
            break;
          default:
            ok = false;
        }
      }).catch((e: Error) => { out.conflicts.push(`${l.target_table} ${JSON.stringify(l.target_key)} : ${e.message}`); ok = false; });
      if (ok) out.restored++;
      else if (!out.conflicts.some((c) => c.startsWith(`${l.target_table} ${JSON.stringify(l.target_key)}`))) {
        out.conflicts.push(`${l.target_table} ${JSON.stringify(l.target_key)} : état modifié depuis l’application, non restauré`);
      }
      await tx`UPDATE claim_legacy_cleanup_journal SET restored_at = now(), restore_run_id = ${restoreRunId},
                      restore_detail = ${JSON.stringify({ ok })}::jsonb WHERE id = ${l.id}`;
    }
  });
  await finishRun(sql, restoreRunId, { status: 'succeeded', counters: { restored: out.restored, conflicts: out.conflicts.length }, accounts: [...comptes].sort((a, b) => a - b) });
  return out;
}
