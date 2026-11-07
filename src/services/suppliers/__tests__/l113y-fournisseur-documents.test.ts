/**
 * Lot 113Y (#721) — fiche fournisseur : une seule rubrique « Documents ».
 *
 *   · service : UNE requête de périmètre (lignes ET total) pour les documents
 *     directs ∪ documents des événements de référence pertinents, bornée au
 *     compte, rôles pertinents seulement, aucune pièce d'un autre fournisseur,
 *     aucun LIMIT constant ; ligne directe prioritaire, contexte « Via … » ;
 *   · contexte discret (pure) ;
 *   · écran (web, PWA, mobile : même page) : plus de section séparée ni de
 *     libellé « Documents des événements de référence », carte « Équipements »
 *     masquée quand vide, jamais le mot « Opération » ;
 *   · chargement progressif : fusion sans doublon par identifiant.
 */
import { describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('@/db', () => ({ pgClient: Object.assign(vi.fn(), { unsafe: vi.fn(async () => []) }), db: {}, ensureMigrations: vi.fn(async () => {}) }));

const { listSupplierSection, getSupplierDetail } = await import('../supplier-detail.service');
const { supplierViaEventContext, SUPPLIER_VIA_EVENT_ROLES } = await import('@/lib/suppliers/supplier-fiche-config');
const { mergeById } = await import('@/components/suppliers/useSupplierSection');

const lire = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const sansCommentaires = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*\/\/.*$/gm, '');

/** Exécutant simulé : capture les requêtes et rend des lignes de documents. */
function runner(rows: Array<Record<string, unknown>>) {
  const requetes: Array<{ sql: string; params: unknown[] }> = [];
  const run = async (sql: string, params: unknown[]) => {
    requetes.push({ sql, params });
    const q = sql.replace(/\s+/g, ' ');
    if (q.startsWith('SELECT id FROM suppliers') || q.includes('FROM suppliers WHERE id = $1')) return [{ id: 4, name: 'Notaire', status: 'active', source: 'manual' }];
    if (q.startsWith('SELECT count(*)')) return [{ n: rows.length }];
    if (q.includes('FROM asset_files f LEFT JOIN document_suppliers ds')) {
      const [, , limit, offset] = params as [number, number, number, number];
      return rows.slice(offset, offset + limit);
    }
    return [];
  };
  return { run, requetes };
}

const ROWS = [
  { id: 1, titleRetained: 'Attestation de propriété', documentDate: '2026-03-02', role: null, isConfirmed: true, confidenceScore: '1', isDirect: true, viaEventCount: null, viaEventTitles: null, assetId: 1, assetName: 'Maison', available: true },
  { id: 2, titleRetained: 'Attestation de vente', documentDate: '2026-03-01', role: null, isConfirmed: false, confidenceScore: '0.6', isDirect: true, viaEventCount: null, viaEventTitles: null, assetId: 1, assetName: 'Maison', available: true },
  { id: 3, titleRetained: 'Compromis de vente', documentDate: null, role: null, isConfirmed: false, confidenceScore: null, isDirect: false, viaEventCount: 1, viaEventTitles: ['Achat — Maison'], assetId: 1, assetName: 'Maison', available: true },
];

describe('service : une seule section « Documents » (lignes et total sur le même périmètre)', () => {
  it('union directe ∪ événements, chemin et contexte par ligne, total exact, pagination', async () => {
    const { run, requetes } = runner(ROWS);
    const p = (await listSupplierSection(10, 4, 'documents', { offset: 0, limit: 2 }, run))!;
    expect(p).toMatchObject({ total: 3, offset: 0, limit: 2, nextOffset: 2 });
    expect(p.items.map((d) => [d.id, (d as { provenance: string }).provenance])).toEqual([[1, 'DIRECT'], [2, 'DIRECT']]);
    const p2 = (await listSupplierSection(10, 4, 'documents', { offset: 2, limit: 2 }, run))!;
    expect(p2.nextOffset).toBeNull();
    expect(p2.items[0]).toMatchObject({ id: 3, provenance: 'VIA_EVENT', viaContext: 'Via Achat — Maison', isConfirmed: false, confidenceScore: null, documentDate: null });
    // Lien direct incertain : reste incertain, sans contexte.
    expect(p.items[1]).toMatchObject({ isConfirmed: false, confidenceScore: 0.6, viaContext: null });
    const docs = requetes.filter((r) => /asset_files f/.test(r.sql));
    const [lignes, total] = [docs.find((r) => /LIMIT \$3 OFFSET \$4/.test(r.sql))!, docs.find((r) => /^SELECT count/.test(r.sql))!];
    // Même périmètre pour les lignes et le total.
    expect(lignes.sql.split(/\bFROM asset_files f\b/)[1].split('ORDER BY')[0].trim()).toBe(total.sql.split(/\bFROM asset_files f\b/)[1].trim());
  });

  it('périmètre : compte de la session partout, rôles pertinents, pièce d’un autre fournisseur exclue, aucun plafond', async () => {
    const { run, requetes } = runner(ROWS);
    await getSupplierDetail(10, 4, run);
    const q = requetes.map((r) => r.sql.replace(/\s+/g, ' ')).find((s) => s.includes('FROM asset_files f LEFT JOIN document_suppliers ds'))!;
    expect(q).toContain('f.account_id = $2 AND f.deleted_at IS NULL');
    expect(q).toContain('o.account_id = $2 AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL');
    expect(q).toContain('d.account_id = $2 AND d.active');
    expect(q).toContain("l.supplier_id = $1 AND l.account_id = $2 AND l.status = 'ACTIVE'");
    expect(q).toContain("l.role IN ('PROVIDER', 'INTERVENER')");
    expect(q).toMatch(/NOT EXISTS \( SELECT 1 FROM document_suppliers xo JOIN suppliers xs ON xs.id = xo.supplier_id AND xs.account_id = \$2 AND xs.status <> 'deleted' WHERE xo.document_id = d.file_id AND xo.supplier_id <> \$1\)/);
    expect(q).toContain("i.account_id = $2 AND i.operation_role = 'PRINCIPAL'");
    expect(q).toMatch(/\(f.upload_status = 'COMPLETED' OR f.upload_status IS NULL\)/);
    expect(q).not.toMatch(/LIMIT \d/);
    // Plus de lecture séparée « via événement » : une seule logique de récupération / pagination.
    expect(requetes.filter((r) => /business_operation_suppliers/.test(r.sql)).every((r) => /FROM asset_files f/.test(r.sql))).toBe(true);
    expect(SUPPLIER_VIA_EVENT_ROLES).toEqual(['PROVIDER', 'INTERVENER']);
  });

  it('fiche : plus de propriété documentsViaOperation ; module de la section séparée supprimé', async () => {
    const { run } = runner(ROWS);
    const d = (await getSupplierDetail(10, 4, run))!;
    expect(d).not.toHaveProperty('documentsViaOperation');
    expect(d.documents.total).toBe(3);
    expect(existsSync(join(process.cwd(), 'src/services/suppliers/supplier-operation-documents.ts'))).toBe(false);
  });
});

describe('contexte discret « Via <événement> » (pure)', () => {
  it('un, plusieurs, aucun titre — jamais inventé', () => {
    expect(supplierViaEventContext(['Achat — Maison'], 1)).toBe('Via Achat — Maison');
    expect(supplierViaEventContext(['Frais — Maison', 'Achat — Maison'], 2)).toBe('Via Achat — Maison et 1 autre événement');
    expect(supplierViaEventContext(['Achat — Maison'], 3)).toBe('Via Achat — Maison et 2 autres événements');
    expect(supplierViaEventContext(['Achat — Maison', ' Achat — Maison '], 1)).toBe('Via Achat — Maison');
    expect(supplierViaEventContext([], 2)).toBeNull();
    expect(supplierViaEventContext(null, null)).toBeNull();
    expect(supplierViaEventContext(['  '], 1)).toBeNull();
  });
});

describe('écran (web, PWA, mobile : même page)', () => {
  const page = lire('src/app/(dashboard)/fournisseurs/[id]/page.tsx');
  const code = sansCommentaires(page);
  it('plus aucune section ni libellé « Documents des événements de référence »', () => {
    expect(code).not.toMatch(/Documents des événements de référence/);
    expect(code).not.toMatch(/supplier-documents-via|documentsViaOperation/);
    expect(code.match(/title="Documents"/g)).toHaveLength(1);
  });
  it('contexte discret dans le sous-titre de la ligne ; même liste et même ouverture du document', () => {
    expect(code).toMatch(/d\.viaContext\]\.filter\(Boolean\)\.join\(' · '\)/);
    expect(code).toContain("openDrawer({ kind: 'document', id: d.id })");
  });
  it('« Équipements » masqué quand vide (sauf échec de chargement) ; Biens et Événements associés conservés', () => {
    expect(code).toMatch(/\{\(equipments\.total > 0 \|\| equipments\.failed\) && \(\s*<Section\s+icon=\{Wrench\}/);
    expect(code).toMatch(/title="Biens"/);
    expect(code).toMatch(/<SupplierAgendaSection /);
  });
  it('jamais le mot « Opération » affiché ; aucune couleur brute', () => {
    expect(code).not.toMatch(/>[^<]*Opération/);
    expect(code).not.toMatch(/#[0-9a-fA-F]{3,6}\b|rgb\(/);
  });
});

describe('chargement progressif', () => {
  it('fusion sans doublon par identifiant (page relue)', () => {
    expect(mergeById([{ id: 1 }, { id: 3 }], [{ id: 3 }, { id: 2 }]).map((x) => x.id)).toEqual([1, 3, 2]);
  });
});
