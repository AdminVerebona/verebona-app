/**
 * Révision de CONNAISSANCE d'un compte (lot 34E — ticket « T3 : rendre la
 * réconciliation globale réellement continue »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * PRINCIPE
 *
 *   revision 154 → Document A évalué → NO_CANDIDATE
 *   nouvelle connaissance (bien créé, fait ajouté, Informations complétées…)
 *   revision 155 → les décisions OUVERTES évaluées sur 154 deviennent
 *                  POTENTIELLEMENT réévaluables.
 *
 * La révision est tenue par la base (migration 0292, journal
 * `account_knowledge_changes` alimenté par déclencheurs sur tous les chemins
 * d'écriture) : révision du compte = plus grand identifiant du journal pour
 * ce compte. Monotone, sans ligne partagée mise à jour, insensible aux
 * écritures cosmétiques (les déclencheurs ne suivent que les colonnes
 * métier, et seulement quand elles CHANGENT : une écriture T3 idempotente
 * n'invalide rien).
 *
 * La révision n'est qu'un SIGNAL : elle ne provoque jamais d'appel IA.
 * L'objet potentiellement obsolète reconstruit son contexte pertinent et
 * compare son empreinte (`documentAssetContextFingerprint`…) : identique →
 * CONFIRMED_NO_CHANGE, sans IA ni écriture métier.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';

/** Natures de connaissance journalisées (déclencheurs 0292). */
export const KNOWLEDGE_CHANGE_KINDS = [
  'ASSET', 'EQUIPMENT', 'ROOM', 'ANALYSIS', 'FACT', 'LINK', 'DOCUMENT_LINK', 'ARBITRATION',
] as const;
export type KnowledgeChangeKind = (typeof KNOWLEDGE_CHANGE_KINDS)[number];

/** Révision de connaissance courante du compte (0 : aucune modification journalisée). */
export async function getAccountKnowledgeRevision(accountId: number): Promise<number> {
  const rows = (await pgClient.unsafe(
    `SELECT COALESCE(max(id), 0)::bigint AS rev FROM account_knowledge_changes WHERE account_id = $1`,
    [accountId] as never[],
  )) as unknown as Array<{ rev: string | number }>;
  return Number(rows[0]?.rev ?? 0);
}

/** Révisions de plusieurs comptes (une requête). */
export async function getAccountKnowledgeRevisions(accountIds: readonly number[]): Promise<Map<number, number>> {
  const ids = [...new Set(accountIds)];
  const out = new Map<number, number>(ids.map((id) => [id, 0]));
  if (ids.length === 0) return out;
  const rows = (await pgClient.unsafe(
    `SELECT account_id, max(id)::bigint AS rev FROM account_knowledge_changes WHERE account_id = ANY($1::int[]) GROUP BY account_id`,
    [ids] as never[],
  )) as unknown as Array<{ account_id: number; rev: string | number }>;
  for (const r of rows) out.set(Number(r.account_id), Number(r.rev));
  return out;
}

/**
 * Natures de connaissance modifiées depuis une révision (monitoring : « quelle
 * connaissance a évolué ? »). Bornée ; vide si rien n'a changé.
 */
export async function knowledgeChangedSince(accountId: number, revision: number | null): Promise<KnowledgeChangeKind[]> {
  const rows = (await pgClient.unsafe(
    `SELECT DISTINCT kind FROM account_knowledge_changes WHERE account_id = $1 AND id > $2::bigint ORDER BY kind LIMIT 20`,
    [accountId, revision ?? 0] as never[],
  )) as unknown as Array<{ kind: KnowledgeChangeKind }>;
  return rows.map((r) => r.kind);
}

/** Condition SQL : la connaissance du compte `accExpr` a évolué depuis la révision `revExpr`. */
export function knowledgeChangedSql(accExpr: string, revExpr: string): string {
  return `EXISTS (SELECT 1 FROM account_knowledge_changes kc WHERE kc.account_id = ${accExpr} AND kc.id > COALESCE(${revExpr}, 0))`;
}

/**
 * Compactage du journal (à l'ouverture de chaque cycle du balayage T3) : seule
 * la ligne la plus récente par compte et par nature est utile (la révision
 * est le maximum ; les natures servent au monitoring). Retire aussi les
 * lignes de l'ancien journal 0274, plus alimenté. Ne lève jamais.
 */
export async function compactKnowledgeChanges(): Promise<void> {
  try {
    await pgClient.unsafe(
      `DELETE FROM account_knowledge_changes c
        WHERE EXISTS (SELECT 1 FROM account_knowledge_changes d
                       WHERE d.account_id = c.account_id AND d.kind = c.kind AND d.id > c.id)`,
    );
    await pgClient.unsafe(`DELETE FROM document_asset_identifier_changes`).catch(() => undefined);
  } catch (e) {
    console.error('[t3-knowledge] compactage du journal de connaissance impossible :', (e as Error).message);
  }
}
