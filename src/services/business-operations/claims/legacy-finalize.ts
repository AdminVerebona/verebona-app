/**
 * Rattrapage BO « Sinistres : nettoyage de l'ancien modèle » — ÉTAPE FINALE
 * « Finaliser » (lot 84A ; CDC « Opérations v5 » lot O-10 ; arbitrages PO
 * V-Q2, C-Q5, C-Q8 ; contrainte : l'utilisateur n'a aucun accès à la base).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI ICI ET PAS DANS UNE MIGRATION
 *
 * Une migration s'applique dès le déploiement, AVANT que le PO ait pu lancer
 * le nettoyage au BO : un DROP inconditionnel y détruirait des données non
 * encore nettoyées (ni journalisées, ni restaurables). La suppression
 * définitive est donc la DERNIÈRE ÉTAPE du même rattrapage BO (même bloc,
 * même moteur des rattrapages, même journal 0672 / 0680), jamais un second
 * outil.
 *
 * CE QUI EST SUPPRIMÉ (une seule transaction, tout ou rien)
 *
 *   tables   business_operation_claim_actions, business_operation_claim_exchanges,
 *            business_operation_claim_migration_marks (déclencheurs, index et
 *            séquences avec elles ; aucune clé étrangère ne les vise) ;
 *   colonnes business_operations.parent_operation_id (clé étrangère composée
 *            business_operations_parent_fk, contrainte « parent ≠ soi »,
 *            index partiel) ; asset_additional_infos.claim_json (la contrainte
 *            « sous-rubriques = objets JSON » est reposée sans elle).
 *
 * CONDITIONS (vérifiées dans cet ordre ; un refus n'écrit RIEN hors journal)
 *
 *   1. ancien modèle déjà supprimé → rien à faire (idempotent, succès) ;
 *   2. nettoyage appliqué sur TOUS les comptes : plus aucune donnée héritée
 *      (actions, échanges, repères, liens « enfant », ancien formulaire,
 *      questions ouvertes) — sinon REFUS `CLEANUP_INCOMPLETE` avec le détail ;
 *   3. point de restauration de MOINS DE 24 H, restaurable dans le schéma
 *      courant (API du lot 82E, même règle que l'application du nettoyage) —
 *      sinon REFUS `RESTORE_POINT_REQUIRED` ;
 *   4. dans la transaction : verrou exclusif des tables concernées
 *      (attente bornée à 5 s : sinon échec `LOCK_TIMEOUT`, rien de fait, à
 *      relancer), RECOMPTE sous verrou (une écriture concurrente ne peut pas
 *      s'intercaler), suppressions SANS CASCADE (une dépendance inattendue
 *      fait échouer proprement), contrôle final.
 *
 * SIMULER : mêmes contrôles, rapport exact (objets et lignes qui
 * disparaîtraient, motifs de refus éventuels), AUCUNE écriture hors journal
 * d'exécution. JOURNAL D'ADMINISTRATION : le moteur des rattrapages journalise
 * auteur, action, étape et motif ; l'exécution est tracée dans
 * `claim_legacy_cleanup_runs` (mode FINALIZE / FINALIZE_SIMULATE), table
 * conservée lors d'une restauration de point.
 *
 * APRÈS : le code ne lit plus ces objets (schéma Drizzle sans eux) ; le
 * nettoyage rend « ancien modèle supprimé » ; restaurer un nettoyage est
 * REFUSÉ ; un point de restauration ANTÉRIEUR à la finalisation est REFUSÉ
 * proprement par le contrôle de schéma (variante prudente : jamais de
 * restauration partielle sans ces tables — `schema-signature.ts`).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import {
  CATEGORY_LABELS, CLEANUP_CATEGORIES, countLegacyRemaining, listRestorePoints, pickRecentRestorePoint,
  type CategoryCounters, type RestorePointCheck, type RestorePointInfo,
} from './legacy-cleanup';
import {
  ADDITIONAL_INFOS_JSON_CHECK, LEGACY_CLAIM_TABLES, LEGACY_PARENT_OBJECTS, lastLegacyFinalization, legacyClaimModelPresent,
  readLegacyClaimSchema, type LegacyClaimSchema,
} from './legacy-schema';

type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;

/** Attente maximale des verrous exclusifs (application en cours d'écriture) : au-delà, échec sans rien faire. */
const FINALIZE_LOCK_TIMEOUT = '5s';
const VERROU = 'verebona:claims-legacy-finalize';

type FinalizeRefusalCode = 'CLEANUP_INCOMPLETE' | 'RESTORE_POINT_REQUIRED' | 'LOCK_TIMEOUT';

interface FinalizeObject {
  kind: 'TABLE' | 'COLUMN';
  /** `table` ou `table.colonne`. */
  name: string;
  present: boolean;
  /** Lignes de la table (TABLE) ou lignes non vides de la colonne (COLUMN), si présente. */
  rows: number | null;
  /** Ce qui part avec (contraintes, index). */
  with: string[];
}

export interface FinalizeResult {
  kind: 'FINALIZE';
  runId: string;
  mode: 'SIMULATE' | 'APPLY';
  status: 'succeeded' | 'refused' | 'failed';
  /** Ancien modèle déjà supprimé avant cette exécution. */
  alreadyFinalized: boolean;
  /** Date de la finalisation (celle-ci, ou la précédente si déjà faite). */
  finalizedAt: string | null;
  /** Simulation : la finalisation serait-elle acceptée maintenant ? */
  possible: boolean;
  refusal: { code: FinalizeRefusalCode; message: string } | null;
  /** Toutes les conditions non remplies (la simulation les liste toutes). */
  blockers: Array<{ code: FinalizeRefusalCode; message: string }>;
  remaining: CategoryCounters;
  remainingAccounts: number[];
  restorePoint: { backupId: string | null; finishedAt: string | null } | null;
  objects: FinalizeObject[];
  /** Objets effectivement supprimés (application). */
  dropped: string[];
}

interface FinalizeOptions {
  sql: Sql;
  mode: 'SIMULATE' | 'APPLY';
  reason?: string | null;
  adminUserId?: number | null;
  now?: Date;
  log?: (m: string) => void;
  /** Tests : points de restauration (défaut : stockage réel, API 82E). */
  restorePoints?: () => Promise<RestorePointInfo[]>;
}

class FinalizeRefusedError extends Error {
  constructor(readonly code: FinalizeRefusalCode, message: string) { super(message); this.name = 'FinalizeRefusedError'; }
}

const total = (c: CategoryCounters) => CLEANUP_CATEGORIES.reduce((a, k) => a + c[k], 0);

/** Motif lisible d'un nettoyage incomplet (pur). */
export function cleanupIncompleteMessage(c: CategoryCounters, accounts: readonly number[]): string {
  const detail = CLEANUP_CATEGORIES.filter((k) => c[k] > 0).map((k) => `${CATEGORY_LABELS[k]} : ${c[k]}`).join(' ; ');
  return `Nettoyage incomplet : ${total(c)} élément(s) de l’ancien modèle subsistent sur ${accounts.length} compte(s) (${detail}). `
    + 'Appliquez d’abord l’étape 1 « Nettoyage » SANS limiter à un compte, puis relancez la simulation de la finalisation.';
}

/** Objets de l'ancien modèle et ce qui disparaîtrait (lecture seule). */
async function objetsHerites(q: Sql | Tx, s: LegacyClaimSchema): Promise<FinalizeObject[]> {
  const out: FinalizeObject[] = [];
  for (const t of LEGACY_CLAIM_TABLES) {
    const rows = s.tables[t] ? Number((await q.unsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM ${t}`))[0].n) : null;
    out.push({ kind: 'TABLE', name: t, present: s.tables[t], rows, with: ['index', 'déclencheurs d’isolation', 'séquence'] });
  }
  out.push({
    kind: 'COLUMN', name: 'business_operations.parent_operation_id', present: s.parentColumn,
    rows: s.parentColumn ? Number((await q.unsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM business_operations WHERE parent_operation_id IS NOT NULL`))[0].n) : null,
    with: [LEGACY_PARENT_OBJECTS.foreignKey, LEGACY_PARENT_OBJECTS.check, LEGACY_PARENT_OBJECTS.index],
  });
  out.push({
    kind: 'COLUMN', name: 'asset_additional_infos.claim_json', present: s.claimJsonColumn,
    rows: s.claimJsonColumn ? Number((await q.unsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM asset_additional_infos WHERE claim_json IS DISTINCT FROM '{}'::jsonb`))[0].n) : null,
    with: [`${ADDITIONAL_INFOS_JSON_CHECK.name} (reposée sans claim_json)`],
  });
  return out;
}

async function startRun(sql: Sql, p: { runId: string; mode: string; reason: string | null; adminUserId: number | null }): Promise<void> {
  await sql`
    INSERT INTO claim_legacy_cleanup_runs (id, mode, account_filter, reason, admin_user_id)
    VALUES (${p.runId}, ${p.mode}, NULL, ${p.reason}, ${p.adminUserId})`;
}

async function finishRun(sql: Sql, r: FinalizeResult, error: string | null = null): Promise<void> {
  const counters = {
    possible: r.possible, alreadyFinalized: r.alreadyFinalized, remaining: r.remaining, dropped: r.dropped,
    objects: r.objects.map((o) => ({ name: o.name, present: o.present, rows: o.rows })),
    blockers: r.blockers.map((b) => b.code),
  };
  await sql`
    UPDATE claim_legacy_cleanup_runs
       SET status = ${r.status}, counters = ${JSON.stringify(counters)}::jsonb, accounts = ${r.remainingAccounts}::int[], error = ${error ?? r.refusal?.message ?? null},
           restore_point_id = ${r.restorePoint?.backupId ?? null}, restore_point_at = ${r.restorePoint?.finishedAt ?? null}::timestamptz, finished_at = now()
     WHERE id = ${r.runId}`;
}

/** Suppression définitive, dans UNE transaction (voir l'en-tête). Rend les objets supprimés. */
async function supprimer(sql: Sql, log: (m: string) => void): Promise<string[]> {
  return sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL lock_timeout = '${FINALIZE_LOCK_TIMEOUT}'`);
    await tx`SELECT pg_advisory_xact_lock(hashtext(${VERROU}))`;
    const s = await readLegacyClaimSchema(tx);
    const tables = LEGACY_CLAIM_TABLES.filter((t) => s.tables[t]);
    const verrous = [...tables, ...(s.claimJsonColumn ? ['asset_additional_infos'] : []), ...(s.parentColumn ? ['business_operations'] : [])];
    if (verrous.length) await tx.unsafe(`LOCK TABLE ${verrous.join(', ')} IN ACCESS EXCLUSIVE MODE`);
    // Recompte SOUS VERROU : aucune donnée héritée ne peut réapparaître entre le contrôle et la suppression.
    const reste = await countLegacyRemaining(tx, s);
    if (total(reste.counters) > 0) throw new FinalizeRefusedError('CLEANUP_INCOMPLETE', cleanupIncompleteMessage(reste.counters, reste.accounts));
    const dropped: string[] = [];
    for (const t of tables) {
      await tx.unsafe(`DROP TABLE ${t}`);
      dropped.push(t);
    }
    if (s.parentColumn) {
      await tx.unsafe(`ALTER TABLE business_operations DROP CONSTRAINT IF EXISTS ${LEGACY_PARENT_OBJECTS.foreignKey}`);
      await tx.unsafe(`ALTER TABLE business_operations DROP CONSTRAINT IF EXISTS ${LEGACY_PARENT_OBJECTS.check}`);
      await tx.unsafe(`DROP INDEX IF EXISTS ${LEGACY_PARENT_OBJECTS.index}`);
      await tx.unsafe(`ALTER TABLE business_operations DROP COLUMN parent_operation_id`);
      dropped.push('business_operations.parent_operation_id', LEGACY_PARENT_OBJECTS.foreignKey, LEGACY_PARENT_OBJECTS.check, LEGACY_PARENT_OBJECTS.index);
    }
    if (s.claimJsonColumn) {
      await tx.unsafe(`ALTER TABLE asset_additional_infos DROP CONSTRAINT IF EXISTS ${ADDITIONAL_INFOS_JSON_CHECK.name}`);
      await tx.unsafe(`ALTER TABLE asset_additional_infos DROP COLUMN claim_json`);
      await tx.unsafe(`ALTER TABLE asset_additional_infos ADD CONSTRAINT ${ADDITIONAL_INFOS_JSON_CHECK.name} CHECK (${ADDITIONAL_INFOS_JSON_CHECK.definition})`);
      dropped.push('asset_additional_infos.claim_json');
    }
    // Contrôle final, dans la transaction : plus rien de l'ancien modèle.
    if (legacyClaimModelPresent(await readLegacyClaimSchema(tx))) throw new Error('Contrôle final : un objet de l’ancien modèle subsiste — transaction annulée.');
    log(`supprimé : ${dropped.join(', ')}`);
    return dropped;
  }) as Promise<string[]>;
}

/** Simuler ou appliquer la finalisation (voir l'en-tête). */
export async function runClaimLegacyFinalization(opts: FinalizeOptions): Promise<FinalizeResult> {
  const { sql } = opts;
  const now = opts.now ?? new Date();
  const log = opts.log ?? (() => undefined);
  const runId = randomUUID();
  await startRun(sql, { runId, mode: opts.mode === 'APPLY' ? 'FINALIZE' : 'FINALIZE_SIMULATE', reason: opts.reason ?? null, adminUserId: opts.adminUserId ?? null });
  const schema = await readLegacyClaimSchema(sql);
  const r: FinalizeResult = {
    kind: 'FINALIZE', runId, mode: opts.mode, status: 'succeeded', alreadyFinalized: !legacyClaimModelPresent(schema), finalizedAt: null,
    possible: false, refusal: null, blockers: [], remaining: Object.fromEntries(CLEANUP_CATEGORIES.map((c) => [c, 0])) as CategoryCounters,
    remainingAccounts: [], restorePoint: null, objects: [], dropped: [],
  };
  try {
    r.objects = await objetsHerites(sql, schema);
    if (r.alreadyFinalized) {
      r.finalizedAt = (await lastLegacyFinalization(sql))?.at ?? null;
      log(`ancien modèle déjà supprimé${r.finalizedAt ? ` (finalisation du ${r.finalizedAt})` : ''} : rien à faire`);
      await finishRun(sql, r);
      return r;
    }
    // 2. Nettoyage complet sur TOUS les comptes ?
    const reste = await countLegacyRemaining(sql, schema);
    r.remaining = reste.counters;
    r.remainingAccounts = reste.accounts;
    if (total(reste.counters) > 0) r.blockers.push({ code: 'CLEANUP_INCOMPLETE', message: cleanupIncompleteMessage(reste.counters, reste.accounts) });
    // 3. Point de restauration de moins de 24 h (même règle que l'application du nettoyage).
    let point: RestorePointCheck;
    try {
      point = pickRecentRestorePoint(await (opts.restorePoints ?? (() => listRestorePoints(sql)))(), now);
    } catch (e) {
      point = { ok: false, backupId: null, finishedAt: null, reason: `Points de restauration illisibles (${(e as Error).message}) : finalisation refusée.` };
    }
    if (point.ok) r.restorePoint = { backupId: point.backupId, finishedAt: point.finishedAt };
    else r.blockers.push({ code: 'RESTORE_POINT_REQUIRED', message: point.reason ?? 'Point de restauration requis.' });
    r.possible = r.blockers.length === 0;

    if (opts.mode === 'SIMULATE') {
      log(r.possible ? 'finalisation possible' : `finalisation refusée : ${r.blockers.map((b) => b.code).join(', ')}`);
      await finishRun(sql, r);
      return r;
    }
    if (!r.possible) {
      r.status = 'refused';
      r.refusal = r.blockers[0];
      log(`refusé : ${r.refusal.message}`);
      await finishRun(sql, r);
      return r;
    }
    log(`point de restauration ${r.restorePoint!.backupId} (${r.restorePoint!.finishedAt})`);
    try {
      r.dropped = await supprimer(sql, log);
    } catch (e) {
      if (e instanceof FinalizeRefusedError) {
        r.status = 'refused';
        r.refusal = { code: e.code, message: e.message };
        r.blockers = [r.refusal];
        r.possible = false;
        await finishRun(sql, r);
        return r;
      }
      if ((e as { code?: string }).code === '55P03') {
        r.status = 'failed';
        r.refusal = { code: 'LOCK_TIMEOUT', message: `Tables occupées par l’application (attente > ${FINALIZE_LOCK_TIMEOUT}) : rien n’a été supprimé. Relancez « Finaliser » dans quelques minutes.` };
        await finishRun(sql, r);
        return r;
      }
      throw e;
    }
    r.finalizedAt = now.toISOString();
    r.objects = r.objects.map((o) => ({ ...o, present: false }));
    await finishRun(sql, r);
    return r;
  } catch (e) {
    r.status = 'failed';
    await finishRun(sql, r, (e as Error).message).catch(() => undefined);
    throw e;
  }
}
