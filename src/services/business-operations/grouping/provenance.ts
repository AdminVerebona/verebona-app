/**
 * Liens Document ↔ Agenda et leurs PROVENANCES (lot 82D, CDC v5 §7.4, E07).
 *
 * Seul module qui écrit `agenda_file_links.provenances` : un lien physique
 * peut cumuler MANUAL_DIRECT, AI_DIRECT et OPERATION_PRINCIPAL ; retirer une
 * provenance ne supprime la ligne que lorsqu'aucune autre ne la justifie.
 * Utilisé par la primitive Agenda (`write-agenda-item.ts`, liens de
 * l'élément), la persistance des sources T4 (`agenda-source-links.ts`), la
 * fin de preuve d'un document (`document-evidence-lifecycle.ts`), la
 * consolidation 76H et le service de regroupement (propagation vers le
 * principal).
 *
 * Lot 86D : un lien que l'utilisateur a DÉTACHÉ (décision AGENDA_FILE_LINK
 * REJECTED, mémoire unifiée 82D) ne reçoit plus aucune provenance
 * AUTOMATIQUE (AI_DIRECT, OPERATION_PRINCIPAL) — garde unique ici, pour tous
 * les écrivains (T4, propagation, consolidation, reprise) ; seule une
 * provenance MANUAL_DIRECT (geste de l'utilisateur) peut le recréer.
 */
import { rejectedLinkFileIds } from './decisions';
import { intArray, type GroupingRunner } from './runner';
import type { LinkProvenance } from './model';

/**
 * Ajoute une provenance (crée le lien au besoin). Rend le nombre de liens
 * créés ou complétés. `onlyNew` : seuls les liens ABSENTS sont créés — un
 * lien existant garde ses justifications (geste utilisateur qui renvoie
 * l'état complet de l'élément : il ne s'approprie pas un lien propagé).
 */
export async function addFileLinkProvenance(
  r: GroupingRunner, itemId: number, fileIds: readonly number[], provenance: LinkProvenance, opts: { onlyNew?: boolean } = {},
): Promise<number> {
  let ids = [...new Set(fileIds)].filter((x) => Number.isSafeInteger(x) && x > 0);
  if (!ids.length) return 0;
  if (provenance !== 'MANUAL_DIRECT') {
    const refuses = new Set(await rejectedLinkFileIds(r, itemId, ids));
    ids = ids.filter((f) => !refuses.has(f));
    if (!ids.length) return 0;
  }
  if (opts.onlyNew) {
    return (await r.q(
      `INSERT INTO agenda_file_links (agenda_item_id, asset_file_id, provenances)
       SELECT $1, f, ARRAY[$3::text] FROM unnest($2::int[]) AS f
       ON CONFLICT (agenda_item_id, asset_file_id) DO NOTHING RETURNING id`,
      [itemId, intArray(ids), provenance],
    )).length;
  }
  const x = await r.q(
    `INSERT INTO agenda_file_links (agenda_item_id, asset_file_id, provenances)
     SELECT $1, f, ARRAY[$3::text] FROM unnest($2::int[]) AS f
     ON CONFLICT (agenda_item_id, asset_file_id) DO UPDATE
        SET provenances = (SELECT array_agg(DISTINCT p ORDER BY p) FROM unnest(agenda_file_links.provenances || ARRAY[$3::text]) AS p)
      WHERE NOT ($3::text = ANY(agenda_file_links.provenances))
     RETURNING id`,
    [itemId, intArray(ids), provenance],
  );
  return x.length;
}

/**
 * Retire une provenance (ou toutes : `ALL`) des liens visés ; supprime les
 * liens qui n'ont plus aucune justification. `fileIds` null : tous les liens
 * de l'élément. Rend le nombre de lignes modifiées ou supprimées.
 */
export async function removeFileLinkProvenance(
  r: GroupingRunner, itemIds: readonly number[], fileIds: readonly number[] | null, provenance: LinkProvenance | 'ALL',
): Promise<number> {
  const items = [...new Set(itemIds)].filter((x) => Number.isSafeInteger(x) && x > 0);
  if (!items.length || (fileIds !== null && !fileIds.length)) return 0;
  const files = fileIds === null ? null : intArray(fileIds);
  if (provenance === 'ALL') {
    return (await r.q(
      `DELETE FROM agenda_file_links WHERE agenda_item_id = ANY($1::int[]) AND ($2::int[] IS NULL OR asset_file_id = ANY($2::int[])) RETURNING id`,
      [intArray(items), files],
    )).length;
  }
  const maj = await r.q(
    `UPDATE agenda_file_links SET provenances = array_remove(provenances, $3::text)
      WHERE agenda_item_id = ANY($1::int[]) AND ($2::int[] IS NULL OR asset_file_id = ANY($2::int[]))
        AND $3::text = ANY(provenances) AND cardinality(provenances) > 1
     RETURNING id`,
    [intArray(items), files, provenance],
  );
  const sup = await r.q(
    `DELETE FROM agenda_file_links
      WHERE agenda_item_id = ANY($1::int[]) AND ($2::int[] IS NULL OR asset_file_id = ANY($2::int[]))
        AND provenances = ARRAY[$3::text]
     RETURNING id`,
    [intArray(items), files, provenance],
  );
  return maj.length + sup.length;
}

/**
 * Remplacement des liens DIRECTS d'un élément pour une provenance (agenda
 * manuel : état complet saisi ; T4 : `add` seulement). Les liens absents de
 * `fileIds` perdent cette provenance — et, pour un geste utilisateur
 * (`userRemovesAll`), TOUTES leurs provenances : l'utilisateur qui retire un
 * document de l'élément retire le lien, propagation comprise (le refus est
 * mémorisé par l'appelant). `scopeFileIds` : documents du compte (un lien
 * historique vers un autre compte n'est jamais touché, lot 49).
 * Rend les documents dont un lien OPERATION_PRINCIPAL a été retiré.
 */
export async function replaceDirectFileLinks(
  r: GroupingRunner, itemId: number, fileIds: readonly number[], provenance: LinkProvenance, accountId: number,
  opts: { userRemovesAll?: boolean } = {},
): Promise<{ removedPrincipalFileIds: number[]; removedFileIds: number[] }> {
  const garder = intArray(fileIds);
  const retires = await r.q<{ asset_file_id: number; provenances: string[] }>(
    `SELECT l.asset_file_id, l.provenances FROM agenda_file_links l JOIN asset_files f ON f.id = l.asset_file_id AND f.account_id = $3
      WHERE l.agenda_item_id = $1 AND NOT (l.asset_file_id = ANY($2::int[]))`,
    [itemId, garder, accountId],
  );
  const cibles = retires.filter((x) => opts.userRemovesAll || (x.provenances ?? []).includes(provenance)).map((x) => Number(x.asset_file_id));
  if (cibles.length) await removeFileLinkProvenance(r, [itemId], cibles, opts.userRemovesAll ? 'ALL' : provenance);
  await addFileLinkProvenance(r, itemId, fileIds, provenance, { onlyNew: opts.userRemovesAll });
  return {
    removedFileIds: [...cibles].sort((a, b) => a - b),
    removedPrincipalFileIds: opts.userRemovesAll
      ? retires.filter((x) => (x.provenances ?? []).includes('OPERATION_PRINCIPAL')).map((x) => Number(x.asset_file_id)).sort((a, b) => a - b)
      : [],
  };
}
