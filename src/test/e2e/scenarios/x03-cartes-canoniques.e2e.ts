/**
 * CDC 15 X-03 (lot 13) — migration 0222 et fermeture par alias, sur base réelle.
 *
 *  · une carte ouverte `purchasePriceCents` est renommée `acquisitionPrice` ;
 *  · si une carte ouverte `acquisitionPrice` existe déjà pour le bien,
 *    l'ancienne est fermée (OBSOLETE) — index d'unicité 0147 respecté ;
 *  · rejouer la migration ne change plus rien (idempotente) ;
 *  · `resolveActionsForData('acquisitionPrice')` ferme aussi une carte alias.
 */
import { it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scenario } from '../scenario';

scenario('X-03', 'Cartes « À traiter » sur les clés canoniques', ({ sql, make }) => {
  it('0222 : renommage, fermeture du doublon, idempotence ; fermeture par alias', async () => {
    const compte = await make.account();
    const b1 = await make.asset(compte);
    const b2 = await make.asset(compte);
    const b3 = await make.asset(compte);
    const carte = async (assetId: number, key: string) => {
      const [r] = await sql<{ id: number }[]>`
        INSERT INTO to_process_actions (account_id, target_type, target_id, field_key, action_kind, rule_code, question)
        VALUES (${compte.id}, 'ASSET', ${assetId}, ${key}, 'ARBITRATE', 'DATA-ACQUISITION-PRICE', 'Prix ?') RETURNING id`;
      return r.id;
    };
    const seule = await carte(b1.id, 'purchasePriceCents');
    const doublon = await carte(b2.id, 'purchasePriceCents');
    const canonique = await carte(b2.id, 'acquisitionPrice');

    const texte = await readFile(join(process.cwd(), 'src/db/migrations/0222_to_process_canonical_keys.sql'), 'utf-8');
    await sql.unsafe(texte);
    await sql.unsafe(texte);

    const etat = await sql<{ id: number; field_key: string; resolved: boolean; reason: string | null }[]>`
      SELECT id, field_key, resolved_at IS NOT NULL AS resolved, resolution_reason AS reason
        FROM to_process_actions WHERE id IN (${seule}, ${doublon}, ${canonique}) ORDER BY id`;
    expect(etat).toEqual([
      { id: seule, field_key: 'acquisitionPrice', resolved: false, reason: null },
      { id: doublon, field_key: 'purchasePriceCents', resolved: true, reason: 'OBSOLETE' },
      { id: canonique, field_key: 'acquisitionPrice', resolved: false, reason: null },
    ]);

    // Carte alias restante (créée après coup) : fermée par la clé canonique.
    const alias = await carte(b3.id, 'purchasePriceCents');
    const { resolveActionsForData } = await import('@/services/to-process/to-process-action.service');
    expect(await resolveActionsForData(compte.id, 'ASSET', b3.id, 'acquisitionPrice', 'OBSOLETE')).toBe(1);
    const [{ resolved }] = await sql<{ resolved: boolean }[]>`SELECT resolved_at IS NOT NULL AS resolved FROM to_process_actions WHERE id = ${alias}`;
    expect(resolved).toBe(true);
  });
});
