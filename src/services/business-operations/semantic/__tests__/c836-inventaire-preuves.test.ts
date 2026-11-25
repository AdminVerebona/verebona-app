/**
 * Carte #836 (Trello, écart E02) — INVENTAIRE des preuves : compter n'est pas
 * transmettre.
 *
 * La collecte des documents borne ce qu'elle transmet (coût, performance) ;
 * elle doit maintenant DIRE ce qu'elle a écarté. Ce fichier éprouve la collecte
 * elle-même (fenêtres bornées, documents manquants, références comptées,
 * inventaire des unités impossible) sur un exécuteur SIMULÉ : aucune base
 * n'est ouverte (`@/db` et le compteur d'unités sont remplacés).
 *
 *   C836-U-E02-COLLECTE  fenêtres, manquants, références, unités ;
 *   C836-U-E02-UNITES    le compteur d'unités a le MÊME périmètre que les
 *                        extraits (sinon l'inventaire mentirait).
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type postgres from 'postgres';
import { emptyDocumentInventory, loadDocuments } from '../load';

const unites = { total: 4, kept: 4, echec: false };

vi.mock('@/db', () => ({ db: {} }));
vi.mock('@/services/business-operations/consolidation/m3-context', () => ({
  sourceUnitExcerpts: async (_r: unknown, _a: number, ids: readonly number[]) => {
    if (unites.echec) throw new Error('sonde indisponible');
    return new Map(ids.map((id) => [id, ['Intervention réalisée le 12/03/2026']]));
  },
  sourceUnitCounts: async (_r: unknown, _a: number, ids: readonly number[]) =>
    new Map(ids.map((id) => [id, { total: unites.total, kept: unites.kept }])),
}));

/** Exécuteur simulé : rend les documents demandés, sauf ceux déclarés absents ou en échec de fenêtre. */
function faussesLignes(opts: { absents?: number[]; fenetresEnEchec?: number; refs?: number } = {}) {
  let fenetre = 0;
  const sql = {
    async unsafe(_q: string, params: unknown[]) {
      fenetre++;
      if (opts.fenetresEnEchec && fenetre <= opts.fenetresEnEchec) throw new Error('connexion interrompue');
      const ids = String(params[1] ?? '{}').replace(/[{}]/g, '').split(',').filter(Boolean).map(Number);
      return ids.filter((id) => !(opts.absents ?? []).includes(id)).map((id) => ({
        id, document_type_code: 'INVOICE', title: `Facture ${id}`, date: '2026-03-20', amount_cents: 1000, provider: 'Plomberie Durand',
        refs: Array.from({ length: opts.refs ?? 2 }, (_, i) => ({ kind: 'INVOICE', value: `F-${i + 1}` })),
        op_ids: [8],
      }));
    },
  };
  return sql as unknown as postgres.Sql;
}

describe('C836-U-E02-COLLECTE — la collecte dit ce qu’elle a écarté (E02)', () => {
  it('collecte par FENÊTRES bornées : vingt-cinq documents demandés, deux fenêtres parcourues, rien de perdu', async () => {
    const inv = emptyDocumentInventory();
    const ids = Array.from({ length: 25 }, (_, i) => 100 + i);
    const docs = await loadDocuments(faussesLignes(), 11, ids, inv);
    expect(docs).toHaveLength(25);
    expect(inv.windows).toBe(2);
    expect(inv.failedWindows).toBe(0);
    expect(inv.requested).toHaveLength(25);
    expect(inv.loaded).toHaveLength(25);
    expect(inv.missing).toEqual([]);
  });

  it('CONTRE-EXEMPLE — SOURCE SUPPRIMÉE (document demandé et absent) : comptée comme manquante (avant : silence)', async () => {
    const inv = emptyDocumentInventory();
    const docs = await loadDocuments(faussesLignes({ absents: [102] }), 11, [101, 102, 103], inv);
    expect(docs.map((x) => x.id)).toEqual([101, 103]);
    expect(inv.missing).toEqual([102]);
  });

  it('CONTRE-EXEMPLE — PAGINATION INTERROMPUE : la fenêtre en échec est comptée, la collecte n’est pas réputée complète', async () => {
    const inv = emptyDocumentInventory();
    const ids = Array.from({ length: 25 }, (_, i) => 100 + i);
    const docs = await loadDocuments(faussesLignes({ fenetresEnEchec: 1 }), 11, ids, inv);
    expect(inv.windows).toBe(2);
    expect(inv.failedWindows).toBe(1);
    expect(docs.length).toBeLessThan(25);
    expect(inv.missing.length).toBeGreaterThan(0);
  });

  it('RÉFÉRENCES et UNITÉS : inventoriées AVANT la sélection, et la limite de coût reste la limite de coût', async () => {
    unites.total = 13;
    unites.kept = 12;
    const inv = emptyDocumentInventory();
    const docs = await loadDocuments(faussesLignes({ refs: 12 }), 11, [101], inv);
    // Transmis : la limite inchangée (dix références par document) ; inventorié : la vérité (douze).
    expect(docs[0].references).toHaveLength(10);
    expect(inv.references.get(101)).toEqual({ total: 12, kept: 10 });
    expect(inv.units.get(101)).toEqual({ total: 13, kept: 12 });
    expect(inv.unitsUnknown).toBeUndefined();
    unites.total = 4;
    unites.kept = 4;
  });

  it('INVENTAIRE IMPOSSIBLE (sonde des unités en échec) : déclaré, jamais présumé complet', async () => {
    unites.echec = true;
    const inv = emptyDocumentInventory();
    const docs = await loadDocuments(faussesLignes(), 11, [101], inv);
    expect(inv.unitsUnknown).toBe(true);
    // La collecte se poursuit (les documents restent lus) : c'est la COUVERTURE qui est refusée, pas la lecture.
    expect(docs).toHaveLength(1);
    unites.echec = false;
  });

  it('appelée SANS inventaire (contexte T4, autres appelants) : comportement inchangé', async () => {
    const docs = await loadDocuments(faussesLignes(), 11, [101, 102]);
    expect(docs.map((x) => x.id)).toEqual([101, 102]);
  });
});

describe('C836-U-E02-UNITES — le compteur a le MÊME périmètre que les extraits (E02)', () => {
  it('un seul fragment de condition sert aux deux requêtes (sinon l’inventaire mentirait)', () => {
    const src = readFileSync('src/services/business-operations/consolidation/m3-context.ts', 'utf8');
    expect(src).toMatch(/const UNITES_ELIGIBLES = sql`/);
    // Les deux requêtes — comptage et extraits — partagent la condition, par construction.
    expect(src.match(/AND \$\{UNITES_ELIGIBLES\}/g)).toHaveLength(2);
    expect(src).toMatch(/export async function sourceUnitCounts/);
    expect(src).toMatch(/kept: Math\.min\(total, M3_EXCERPTS_PER_DOCUMENT\)/);
    // La limite de coût ne bouge pas.
    expect(src).toMatch(/const M3_EXCERPTS_PER_DOCUMENT = 12;/);
  });
});
