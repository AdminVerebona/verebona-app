/**
 * Carte #744, point G (« exports ») — CHRONOLOGIE d'un sinistre lue dans le
 * GRAPHE canonique (`../agenda-chronology`). Aucune base, aucune date du jour.
 *
 *   L114OG-U01  mapping d'une ligne lue : types stricts, élément sans date conservé, drapeau principal
 *   L114OG-U02  aucun identifiant exploitable : aucune requête n'est faite (lecture seule, jamais de requête vide)
 *   L114OG-U03  les DEUX supports sont lus (colonne historique ∪ liens actifs) et dédoublonnés par élément
 *   L114OG-U04  toute lecture est bornée au compte ; seuls les liens ACTIFS comptent ; aucune écriture
 *   L114OG-U05  la lecture des sinistres n'interroge plus la colonne historique seule (règle remplacée, carte #744)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadClaimChronology, type ClaimChronologyExecutor } from '../agenda-chronology';

const src = (rel: string) => readFileSync(join(process.cwd(), 'src', rel), 'utf8');
const MODULE = src('services/business-operations/claims/agenda-chronology.ts');
const LECTURE = src('services/business-operations/claims/read.ts');
/** Code sans ses commentaires (un commentaire ne prouve rien). */
const sansCommentaires = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/--.*$/gm, '');

/** Exécuteur de test : mémorise la requête et rend les lignes fournies. */
function faux(rows: Array<Record<string, unknown>>): ClaimChronologyExecutor & { appels: number } {
  const x = { appels: 0, execute: async () => { x.appels += 1; return rows; } };
  return x;
}

describe('#744 point G — chronologie d’un sinistre lue dans le graphe', () => {
  it('L114OG-U01 — mapping d’une ligne lue : types stricts, élément sans date conservé, drapeau principal', async () => {
    const x = faux([
      { operation_id: '7', id: '41', title: 'Passage de l’expert', date: '2025-02-20', principal: false },
      { operation_id: '7', id: '42', title: 'Devis à demander', date: null, principal: true },
    ]);
    expect(await loadClaimChronology(x, 3, [7])).toEqual([
      { operationId: 7, id: 41, title: 'Passage de l’expert', date: '2025-02-20', principal: false },
      { operationId: 7, id: 42, title: 'Devis à demander', date: null, principal: true },
    ]);
    expect(x.appels).toBe(1);
  });

  it('L114OG-U02 — aucun identifiant exploitable : aucune requête n’est faite', async () => {
    for (const ids of [[], [0], [-1], [1.5], [Number.NaN]]) {
      const x = faux([{ operation_id: '1', id: '1', title: 'x', date: null, principal: false }]);
      expect(await loadClaimChronology(x, 3, ids), `identifiants ${JSON.stringify(ids)}`).toEqual([]);
      expect(x.appels, `identifiants ${JSON.stringify(ids)}`).toBe(0);
    }
  });

  it('L114OG-U03 — les deux supports sont lus et dédoublonnés par élément', () => {
    const sql = sansCommentaires(MODULE);
    // Support historique (colonne) ET support cible (liens N↔N du graphe).
    expect(sql).toContain('ai.business_operation_id = ANY(');
    expect(sql).toContain('business_operation_agenda_links');
    expect(sql).toContain('UNION ALL');
    // Une entrée par (événement de référence, élément) : un élément porté par les deux supports n'apparaît qu'une fois.
    expect(sql).toContain('GROUP BY s.operation_id, s.id');
    expect(sql).toMatch(/bool_or\(s\.principal\)/);
  });

  it('L114OG-U04 — lecture bornée au compte, liens ACTIFS seulement, aucune écriture', () => {
    const sql = sansCommentaires(MODULE);
    // Les trois lectures (colonne, liens, titres) sont filtrées par le compte.
    expect(sql.match(/account_id = \$\{accountId\}/g) ?? []).toHaveLength(3);
    expect(sql).toContain("l.state = 'ACTIVE'");
    for (const interdit of ['INSERT', 'UPDATE ', 'DELETE']) expect(sql, interdit).not.toContain(interdit);
  });

  it('L114OG-U05 — règle remplacée (carte #744) : la lecture des sinistres n’interroge plus la colonne historique seule', () => {
    const code = sansCommentaires(LECTURE);
    // Avant : une requête `FROM agenda_items ai WHERE ai.business_operation_id = ANY(...)` dans `read.ts`.
    // Après : la chronologie vient du module de graphe, qui réunit les deux supports.
    expect(code).not.toContain('FROM agenda_items ai');
    expect(code).toContain('loadClaimChronology(x, accountId, ops.map((o) => Number(o.id)))');
  });
});
