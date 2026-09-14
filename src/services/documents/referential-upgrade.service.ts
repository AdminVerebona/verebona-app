/**
 * Mise à niveau du parc après évolution du référentiel — CDC V2.0 §11.6, AI-05.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * TOUS LES DOCUMENTS, PAS SEULEMENT LES MAL CLASSÉS
 *
 * Le §11.6 est explicite et contre-intuitif : « Tous les documents sont
 * retraités, pas seulement ceux sans Type ou avec Autre. »
 *
 * La tentation est forte de ne reprendre que les documents « Sans rubrique » :
 * c'est moins coûteux et cela paraît suffire. Cela rate précisément ce que
 * l'évolution du référentiel est censée corriger — un document rangé sous une
 * Rubrique devenue trop large, ou portant un Type qu'une scission a rendu
 * imprécis. Ces documents ont l'air classés ; c'est bien le problème.
 *
 * Le critère de sélection est donc la VERSION, pas l'état de classement.
 *
 * ── CE SERVICE NE CLASSE RIEN ─────────────────────────────────────────────
 *
 * Il sélectionne et délègue. Le §11.6 impose que « le retraitement utilise le
 * mécanisme existant d'optimisation des données, pas un job documentaire
 * séparé ». Un service qui reclasserait lui-même deviendrait ce job séparé, et
 * appliquerait sa propre interprétation des règles — celle qui divergera un
 * jour de l'autre.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '@/db';
import { assetFiles } from '@/db/schema';
import { REFERENTIAL_VERSION } from '@/lib/referential/v2';
import { withJobLock } from '@/lib/job-lock';

export interface UpgradeCandidate {
  fileId: number;
  accountId: number;
  storedVersion: string | null;
  /** Une valeur validée par l'utilisateur ne sera jamais remplacée (§11.6). */
  protectedValue: boolean;
}

export interface UpgradeReport {
  referentialVersion: string;
  /** Documents dont la version stockée diffère de la version courante. */
  outdatedCount: number;
  /** Documents effectivement soumis au traitement d'optimisation. */
  queuedCount: number;
  /** Documents portant une valeur utilisateur : repassés, jamais écrasés. */
  protectedCount: number;
  dryRun: boolean;
  skippedReason?: 'locked';
}

/**
 * Documents à retraiter.
 *
 * `IS DISTINCT FROM` plutôt que `<>` : un document jamais classé porte une
 * version NULL, et `NULL <> '2.0.0'` ne rend pas `true` en SQL. La comparaison
 * naïve écarterait silencieusement les documents les plus concernés.
 */
export async function findUpgradeCandidates(options: {
  accountId?: number;
  limit?: number;
} = {}): Promise<UpgradeCandidate[]> {
  const conditions = [
    isNull(assetFiles.deletedAt),
    sql`${assetFiles.classificationReferentialVersion} IS DISTINCT FROM ${REFERENTIAL_VERSION}`,
  ];
  if (options.accountId) conditions.push(eq(assetFiles.accountId, options.accountId));

  const rows = await db
    .select({
      fileId: assetFiles.id,
      accountId: assetFiles.accountId,
      storedVersion: assetFiles.classificationReferentialVersion,
      rubricUserValidated: assetFiles.rubricUserValidated,
      typeUserValidated: assetFiles.typeUserValidated,
    })
    .from(assetFiles)
    .where(and(...conditions))
    .limit(options.limit ?? 5_000);

  return rows.map((r) => ({
    fileId: r.fileId,
    accountId: r.accountId,
    storedVersion: r.storedVersion,
    protectedValue: r.rubricUserValidated || r.typeUserValidated,
  }));
}

/** Comptes concernés par une mise à niveau, pour un déclenchement par lot. */
export async function findAccountsToUpgrade(limit = 500): Promise<number[]> {
  const rows = await db
    .selectDistinct({ accountId: assetFiles.accountId })
    .from(assetFiles)
    .where(
      and(
        isNull(assetFiles.deletedAt),
        sql`${assetFiles.classificationReferentialVersion} IS DISTINCT FROM ${REFERENTIAL_VERSION}`,
      ),
    )
    .limit(limit);

  return rows.map((r) => r.accountId);
}

export type ReprocessHandler = (candidate: UpgradeCandidate) => Promise<void>;

/**
 * Soumet les documents dépassés au traitement d'optimisation.
 *
 * `reprocess` est injecté plutôt qu'importé : c'est ce qui permet de tester la
 * sélection — la partie où l'erreur coûte cher — sans déclencher d'analyse, et
 * d'appeler le mécanisme existant sans que ce module en dépende (§11.6).
 *
 * Le verrou partagé évite qu'un déploiement sur deux instances lance deux
 * mises à niveau simultanées du même parc : elles se marcheraient dessus et
 * consommeraient deux fois le crédit d'analyse.
 */
export async function upgradeReferential(
  reprocess: ReprocessHandler,
  options: { accountId?: number; limit?: number; dryRun?: boolean } = {},
): Promise<UpgradeReport> {
  const candidates = await findUpgradeCandidates(options);
  const base: UpgradeReport = {
    referentialVersion: REFERENTIAL_VERSION,
    outdatedCount: candidates.length,
    queuedCount: 0,
    protectedCount: candidates.filter((c) => c.protectedValue).length,
    dryRun: options.dryRun === true,
  };

  if (options.dryRun) return base;

  const result = await withJobLock('referential-upgrade', 15 * 60_000, async () => {
    let queued = 0;
    for (const candidate of candidates) {
      try {
        await reprocess(candidate);
        queued += 1;
      } catch (e) {
        console.error(
          `[referential-upgrade] document ${candidate.fileId} non retraité :`,
          (e as Error).message,
        );
      }
    }
    return queued;
  });

  if (result === null) return { ...base, skippedReason: 'locked' };
  return { ...base, queuedCount: result };
}

/** Compteurs de suivi, pour la recette AI-05. */
export async function upgradeCounts(accountId?: number): Promise<{
  total: number;
  upToDate: number;
  outdated: number;
}> {
  const scope = accountId
    ? and(isNull(assetFiles.deletedAt), eq(assetFiles.accountId, accountId))
    : isNull(assetFiles.deletedAt);

  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      upToDate: sql<number>`count(*) FILTER (WHERE ${assetFiles.classificationReferentialVersion} = ${REFERENTIAL_VERSION})::int`,
    })
    .from(assetFiles)
    .where(scope);

  return {
    total: row?.total ?? 0,
    upToDate: row?.upToDate ?? 0,
    outdated: (row?.total ?? 0) - (row?.upToDate ?? 0),
  };
}

/** Réexporté pour les appels de sélection ciblée. */
export { REFERENTIAL_VERSION };
