/**
 * Lot 113E (#700) — BO › Compte › « Données du compte » : septième onglet
 * « Fournisseurs (N) », lecture seule stricte. Tests unitaires (sans base) :
 * vocabulaire, listes blanches, masquage bancaire, requêtes de la liste
 * (périmètre compte, « Tous » hors supprimés, aucune colonne bancaire),
 * garde-fous statiques (aucun service d'écriture fournisseur importé, aucune
 * relation déduite d'un nom).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CATEGORIES, CATEGORY_LABELS, CATEGORY_TYPES, ENTITY_LABELS, ENTITY_TABLES, entityRef, maskRow, parseEntityRef,
} from '../model';
import { LIST_FILTERS, LIST_SORTS, listAccountData, parseListQuery } from '../lists';
import type { DiagExecutor, DiagQuery } from '@/services/business-operations/diagnostics/service';
import { SUPPLIER_RELATION_PERIMETERS } from '@/services/relations/read-contract';

const ROOT = join(__dirname, '..', '..', '..', '..', '..');
const src = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('L113E — vocabulaire et listes blanches', () => {
  it('septième catégorie « Fournisseurs », après « Opérations » ; type supplier → table suppliers', () => {
    expect(CATEGORIES.indexOf('fournisseurs')).toBe(CATEGORIES.indexOf('operations') + 1);
    expect(CATEGORIES).toHaveLength(7);
    expect(CATEGORY_LABELS.fournisseurs).toBe('Fournisseurs');
    expect(CATEGORY_TYPES.fournisseurs).toEqual(['supplier']);
    expect(ENTITY_LABELS.supplier).toBe('Fournisseur');
    expect(ENTITY_TABLES.supplier).toBe('suppliers');
    expect(parseEntityRef(entityRef('supplier', 42))).toEqual({ type: 'supplier', id: 42 });
    expect(parseEntityRef('suppliers-42')).toBeNull();
  });

  it('filtres et tris : liste blanche, défaut « Tous (actifs et archivés) »', () => {
    expect(LIST_FILTERS.fournisseurs.map((f) => f.value)).toEqual(['all', 'active', 'archived', 'deleted']);
    expect(LIST_SORTS.fournisseurs).toEqual(['created', 'id', 'name', 'updated']);
    const p = (o: Record<string, string>) => ({ get: (k: string) => o[k] ?? null });
    expect(parseListQuery('fournisseurs', p({}))).toMatchObject({ state: 'all', sort: 'created', dir: 'desc', page: 1, pageSize: 25, q: '' });
    expect(parseListQuery('fournisseurs', p({ state: 'iban', sort: 'iban; drop', pageSize: '100000' }))).toMatchObject({ state: 'all', sort: 'created', pageSize: 100 });
    expect(parseListQuery('fournisseurs', p({ state: 'archived', sort: 'name', dir: 'asc', q: '  Plomberie  ' }))).toMatchObject({ state: 'archived', sort: 'name', dir: 'asc', q: 'Plomberie' });
  });
});

describe('L113E — masquage des coordonnées bancaires (liste, tiroir, exports)', () => {
  it('IBAN, titulaire, IBAN relevé : présents en base mais jamais rendus', () => {
    const r = maskRow({
      id: 1, name: 'Plomberie Martin', iban: 'FR7630006000011234567890189', iban_holder_name: 'M. Martin',
      observed_iban: 'fr7630006000011234567890189', observed_iban_holder_name: 'Martin', email: 'contact@martin.fr',
      field_provenance: { iban: { documentId: 3 }, email: { documentId: 3 } }, evidence: { observedIban: 'x', ibanHolderName: 'y' },
    });
    for (const k of ['iban', 'iban_holder_name', 'observed_iban', 'observed_iban_holder_name']) expect(r[k]).toMatchObject({ $etat: 'masque', motif: 'coordonnées bancaires' });
    expect(r.email).toBe('contact@martin.fr');
    expect((r.field_provenance as Record<string, unknown>).iban).toMatchObject({ $etat: 'masque' });
    expect((r.field_provenance as Record<string, unknown>).email).toEqual({ documentId: 3 });
    expect((r.evidence as Record<string, unknown>).observedIban).toMatchObject({ $etat: 'masque' });
    expect((r.evidence as Record<string, unknown>).ibanHolderName).toMatchObject({ $etat: 'masque' });
    expect(JSON.stringify(r)).not.toMatch(/30006000011234567890189/i);
  });

  it('revue de conflit sur un champ bancaire : valeurs en place et relevée masquées ; autre champ rendu', () => {
    const bank = maskRow({ id: 9, conflicting_field: 'iban', current_value: 'fr76 3000 6000 0112', detected_value: 'FR76 1111 2222 3333' });
    expect(bank.current_value).toMatchObject({ $etat: 'masque' });
    expect(bank.detected_value).toMatchObject({ $etat: 'masque' });
    const holder = maskRow({ id: 10, conflicting_field: 'ibanHolderName', current_value: 'A', detected_value: 'B' });
    expect(holder.detected_value).toMatchObject({ $etat: 'masque' });
    const mail = maskRow({ id: 11, conflicting_field: 'email', current_value: 'a@x.fr', detected_value: 'b@x.fr' });
    expect(mail).toMatchObject({ current_value: 'a@x.fr', detected_value: 'b@x.fr' });
  });
});

describe('L113E — liste paginée (requêtes, compteurs)', () => {
  function fakeExec(log: string[], rows: Record<string, unknown>[]): DiagExecutor {
    const q: DiagQuery = async (sql: string, params: unknown[] = []) => {
      log.push(`${sql} -- ${JSON.stringify(params)}`);
      if (/GROUP BY 1/.test(sql)) return [{ etat: 'active', n: 3 }, { etat: 'archived', n: 2 }, { etat: 'deleted', n: 4 }];
      if (/^SELECT count\(\*\)/.test(sql.trim())) return [{ n: rows.length }];
      return rows;
    };
    return (<T>(fn: (qq: DiagQuery) => Promise<T>) => fn(q)) as DiagExecutor;
  }
  const row = {
    id: 7, public_id: '7b0f0c2e-0000-4000-8000-000000000007', name: 'Plomberie Martin', scope: 'personal', source: 'document', status: 'archived',
    email: 'contact@martin.fr', phone: '0102030405', website: null, postal_code: '75011', city: 'Paris', siren: null, siret: '12345678900011',
    vat_number: 'FR12123456789', created_at: '2026-10-01T10:00:00.000Z', updated_at: '2026-10-02T10:00:00.000Z', docs_direct: 2, ops_active: 1, etat: 'archived',
  };

  it('« Tous » : compte $1, supprimés exclus (lignes ET compteur), aucune colonne bancaire lue, aucune écriture', async () => {
    const log: string[] = [];
    const lq = parseListQuery('fournisseurs', { get: () => null });
    const res = await listAccountData(12, 'fournisseurs', lq, fakeExec(log, [row]));
    expect(res.counters).toEqual([
      { value: 'all', label: 'Tous (actifs et archivés)', count: 5 }, { value: 'active', label: 'Actifs', count: 3 },
      { value: 'archived', label: 'Archivés', count: 2 }, { value: 'deleted', label: 'Supprimés (hors total)', count: 4 },
    ]);
    const all = log.join('\n');
    expect(all).toMatch(/FROM suppliers x WHERE x\.account_id = \$1/);
    expect(log.filter((l) => /^SELECT count|^\s*SELECT x\.id/.test(l.trim()) || /LIMIT/.test(l)).every((l) => /NOT IN \('deleted'\)/.test(l))).toBe(true);
    expect(log.every((l) => l.includes('-- [12'))).toBe(true);
    expect(all).not.toMatch(/\biban\b|iban_holder/i);
    expect(all).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE)\b/i);
    const item = res.items[0];
    expect(item).toMatchObject({ type: 'supplier', id: 7, name: 'Plomberie Martin', status: 'archived', statusLabel: 'Archivé', state: 'archived', parent: null });
    expect(item.kind).toBe('SIRET 12345678900011 · TVA FR12123456789');
    expect(item.details).toEqual(expect.arrayContaining([
      { label: 'E-mail', value: 'contact@martin.fr' }, { label: 'Ville', value: '75011 Paris' },
      { label: 'Liens', value: '2 document(s) direct(s) · 1 Opération(s) active(s)' },
    ]));
    expect(JSON.stringify(res)).not.toMatch(/iban/i);
  });

  it('filtre « Supprimés » : état demandé en paramètre, sans exclusion ; recherche : nom, SIREN/SIRET, identifiant', async () => {
    const log: string[] = [];
    const p = (o: Record<string, string>) => ({ get: (k: string) => o[k] ?? null });
    await listAccountData(12, 'fournisseurs', parseListQuery('fournisseurs', p({ state: 'deleted', q: '123 456' })), fakeExec(log, []));
    const page = log.find((l) => /LIMIT/.test(l))!;
    expect(page).not.toMatch(/NOT IN/);
    expect(page).toMatch(/= \$4::text/);
    expect(page).toMatch(/x\.name ILIKE \$2/);
    expect(page).toMatch(/replace\(x\.siret, ' ', ''\) ILIKE replace\(\$2, ' ', ''\)/);
    expect(page).toContain('"deleted"');
    const byId: string[] = [];
    await listAccountData(12, 'fournisseurs', parseListQuery('fournisseurs', p({ q: '77' })), fakeExec(byId, []));
    expect(byId.find((l) => /LIMIT/.test(l))).toContain('[12,"%77%",77,null]');
  });
});

describe('L113E — garde-fous statiques', () => {
  const dossier = src('src/services/admin/account-data/dossier.ts');
  const lists = src('src/services/admin/account-data/lists.ts');
  const supplierPart = dossier.slice(dossier.indexOf('async function supplierDossier'), dossier.indexOf('// ── Plan, consultation paginée'));

  it('aucun service d’écriture fournisseur, aucune IA, aucun dédoublonnage importé par la vue', () => {
    for (const s of [dossier, lists]) {
      expect(s).not.toMatch(/supplier-service|supplier-from-analysis|operation-suppliers|supplier-validation|to-process\/producers|\/ai\//);
    }
    expect(supplierPart).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
  });

  it('relations : périmètres du contrat 109A, DIRECT et VIA Opération en sections distinctes, jamais par similarité de nom', () => {
    expect(SUPPLIER_RELATION_PERIMETERS.documents).toMatch(/document_suppliers/);
    expect(SUPPLIER_RELATION_PERIMETERS.documents).toMatch(/business_operation_suppliers[\s\S]*status = 'ACTIVE'/);
    expect(SUPPLIER_RELATION_PERIMETERS.agendaItems).toMatch(/agenda_item_suppliers/);
    expect(SUPPLIER_RELATION_PERIMETERS.equipments).toMatch(/equipment_suppliers/);
    for (const id of ['rel-documents-direct', 'rel-documents-via', 'rel-biens-direct', 'rel-biens-via', 'rel-equipements-direct', 'rel-equipements-via', 'rel-operations', 'rel-echeances-direct', 'rel-echeances-via']) {
      expect(supplierPart).toContain(`'${id}'`);
    }
    expect(supplierPart).not.toMatch(/f\.supplier\b|asset_files\.supplier\b|similarity|ILIKE/);
    expect(supplierPart).toMatch(/FROM suppliers WHERE id = \$1 AND account_id = \$2/);
  });

  it('écran : septième onglet par la liste CATEGORIES (aucun écran parallèle), état vide explicite', () => {
    const ui = src('src/app/admin/accounts/[id]/_components/account-data/AccountDataSection.tsx');
    expect(ui).toContain('Aucun fournisseur enregistré sur ce compte.');
    expect(ui).toMatch(/CATEGORIES\.map\(\(c\) => \(\s*<TabsTrigger/);
    expect(ui).toContain("fournisseurs: 'created'");
  });
});
