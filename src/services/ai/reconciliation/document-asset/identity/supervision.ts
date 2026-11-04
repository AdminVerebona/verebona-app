/**
 * Supervision de la phase « identités documentaires » (lot 108E, ticket
 * « T3 DOCUMENT_ASSET — correctif #626 bis », A5).
 *
 * Une panne du graphe (lecture en échec, migration absente) n'est JAMAIS un
 * passage « terminé » : anomalie Supervision (domaine IA) PAR COMPTE et par
 * cause, avec le nombre de documents sans bien non traités par la phase, la
 * reprise prévue et l'état des migrations ; résolue AUTOMATIQUEMENT dès qu'un
 * passage relit le graphe (contrôle après correction). Ne lève jamais.
 */
import { pgClient } from '@/db';

const FP = 't3-identity-graph';

/** Documents visibles, analysés, sans bien principal ni décision de l'utilisateur. */
export async function countOrphanDocuments(accountId: number): Promise<number> {
  const [r] = (await pgClient.unsafe(
    `SELECT count(*)::int AS n FROM asset_files f
       JOIN document_extractions e ON e.file_id = f.id AND e.account_id = f.account_id
      WHERE f.account_id = $1 AND f.deleted_at IS NULL AND f.grouped_into_file_id IS NULL
        AND COALESCE(f.is_draft, false) = false AND COALESCE(f.is_ignored, false) = false
        AND f.asset_id IS NULL AND f.linked_asset_id IS NULL
        AND COALESCE((f.user_edited_fields ->> 'assetId')::boolean, false) = false
        AND NOT EXISTS (SELECT 1 FROM document_asset_links l WHERE l.file_id = f.id AND l.status = 'ACTIVE' AND l.asset_id IS NOT NULL
                          AND (l.link_role = 'PRIMARY' OR l.origin = 'USER'))`,
    [accountId] as never[],
  )) as unknown as Array<{ n: number }>;
  return Number(r?.n ?? 0);
}

const TITRES: Record<string, string> = {
  GRAPH_UNAVAILABLE: 'T3 — identités documentaires : graphe illisible, rattachement des documents sans bien suspendu',
  MIGRATION_MISSING: 'T3 — identités documentaires : migration 0995 absente, phase non exécutée',
  MIGRATION_1060_MISSING: 'T3 — identités documentaires : migration 1060 absente, groupes d’appareils non journalisés',
};

export async function reportIdentityPhaseFailure(p: {
  accountId: number; reason: string; error: string | null; untreatedDocuments: number;
  migrations: { m0995: boolean; m1060: boolean } | null;
}): Promise<void> {
  try {
    const { reportAnomaly, buildFingerprint } = await import('@/services/admin/anomaly.service');
    await reportAnomaly({
      domain: 'ai', fingerprint: buildFingerprint('ai', FP, p.reason, p.accountId), accountId: p.accountId,
      title: TITRES[p.reason] ?? `T3 — identités documentaires : ${p.reason}`,
      detail: {
        code: p.reason, cause: p.error, untreatedDocuments: p.untreatedDocuments, migrations: p.migrations,
        resume: 'reprise automatique au prochain passage T3 du compte ; anomalie résolue automatiquement quand la phase relit le graphe',
        control: 'BO › Diagnostic du compte › ia/t3-rattachement-documents.json (phase « identités documentaires »)',
      },
    });
  } catch (e) {
    console.error(`[t3-identity] supervision non alimentée (compte ${p.accountId}) :`, (e as Error).message);
  }
}

/** Contrôle après correction : la phase a relu le graphe → incidents du compte résolus. */
export async function resolveIdentityPhaseFailure(accountId: number, keep: readonly string[] = []): Promise<void> {
  try {
    const { autoResolveAnomaly, buildFingerprint } = await import('@/services/admin/anomaly.service');
    for (const reason of ['GRAPH_UNAVAILABLE', 'MIGRATION_MISSING', 'MIGRATION_1060_MISSING'].filter((r) => !keep.includes(r))) {
      await autoResolveAnomaly(buildFingerprint('ai', FP, reason, accountId), { origin: 't3_identity_phase', cause: 'graphe d’identité relu par le passage T3' });
    }
  } catch { /* jamais bloquant */ }
}
