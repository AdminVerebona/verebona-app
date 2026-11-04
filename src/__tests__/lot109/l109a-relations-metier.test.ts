/**
 * Lot 109A — relations métier autour de l'Opération pivot (ticket P1). Tests
 * unitaires L109A-U-* : règle de preuve Opération ↔ fournisseur (pure), plan
 * d'écriture (décisions de l'utilisateur, idempotence), pagination du
 * contrat de lecture, déclaration du contrôle de cohérence, branchements.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  desiredOperationSuppliers, planIsEmpty, planOperationSuppliers, OPERATION_SUPPLIER_ISSUER_ROLES,
  type ExistingOperationSupplier, type SupplierEvidenceRow,
} from '@/services/relations/operation-suppliers';
import { buildProviderEquivalence } from '@/services/business-operations/consolidation/provider-equivalence';
import { normalizePage, pageOptionsFromSearch, RELATIONS_MAX_PAGE_SIZE } from '@/services/relations/read-contract';
import { COHERENCE_REGISTRY } from '@/services/coherence/registry';
import { COVERAGE_INVENTORY } from '@/services/coherence/registry/coverage';
import { DIAG_TABLE_COVERAGE } from '@/services/admin/diagnostics-export/coverage';

const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

const ev = (o: Partial<SupplierEvidenceRow>): SupplierEvidenceRow => ({
  operationId: 1, fileId: 10, sourceId: 100, sourceRole: 'INVOICE', candidateProvider: 'Télésurveillance Exemple',
  supplierId: 7, supplierName: 'Télésurveillance Exemple SAS', reliable: true, ...o,
});
const lien = (o: Partial<ExistingOperationSupplier>): ExistingOperationSupplier => ({
  id: 1, operationId: 1, supplierId: 7, role: 'PROVIDER', origin: 'T3', status: 'ACTIVE', evidence: {}, reasonCode: null, ...o,
});

describe('L109A-U-PLAN — fournisseurs prouvés d’une Opération (règle pure)', () => {
  const op = { id: 1, provider: 'Télésurveillance Exemple' };

  it('émetteur fiable d’une pièce émise, même désignation : PROVIDER, preuves triées', () => {
    const d = desiredOperationSuppliers(op, [ev({ fileId: 12, sourceId: 102 }), ev({ fileId: 10, sourceId: 100 })], null);
    expect(d).toEqual([{ supplierId: 7, role: 'PROVIDER', evidence: { rule: 'ISSUER_DOCUMENT_RELIABLE_SUPPLIER', version: 1, files: [10, 12], sources: [100, 102] } }]);
  });

  it('jamais : lien incertain, preuve de paiement, pièce sans rôle, autre Opération', () => {
    expect(desiredOperationSuppliers(op, [ev({ reliable: false })], null)).toEqual([]);
    expect(desiredOperationSuppliers(op, [ev({ sourceRole: 'PAYMENT_PROOF' })], null)).toEqual([]);
    expect(desiredOperationSuppliers(op, [ev({ sourceRole: null })], null)).toEqual([]);
    expect(desiredOperationSuppliers(op, [ev({ operationId: 2 })], null)).toEqual([]);
    expect(OPERATION_SUPPLIER_ISSUER_ROLES).not.toContain('PAYMENT_PROOF');
  });

  it('émetteur d’une pièce qui ne désigne pas le prestataire : DOCUMENT_ISSUER (aucun transfert d’identité légale)', () => {
    const d = desiredOperationSuppliers(op, [ev({ supplierId: 9, supplierName: 'Pose Alarmes SARL', candidateProvider: 'Pose Alarmes' })], null);
    expect(d.map((x) => [x.supplierId, x.role])).toEqual([[9, 'DOCUMENT_ISSUER']]);
  });

  it('désignations équivalentes prouvées par le compte (lot 86C) : PROVIDER — sans table codée par marque', () => {
    const eq = buildProviderEquivalence([
      { fileId: 1, supplierId: 7, supplierName: 'EPS Groupe', provider: 'Marque Commerciale', role: 'INVOICE', reliable: true },
      { fileId: 2, supplierId: 7, supplierName: 'EPS Groupe', provider: 'EPS Groupe', role: 'CONTRACT_DOCUMENT', reliable: true },
    ]);
    const d = desiredOperationSuppliers({ id: 1, provider: 'Marque Commerciale' }, [ev({ candidateProvider: 'EPS Groupe', supplierName: 'EPS Groupe' })], eq);
    expect(d[0].role).toBe('PROVIDER');
    expect(desiredOperationSuppliers({ id: 1, provider: 'Marque Commerciale' }, [ev({ candidateProvider: 'EPS Groupe', supplierName: 'EPS Groupe' })], null)[0].role).toBe('DOCUMENT_ISSUER');
  });

  it('AC05 anti-cartésien : 10 documents × 2 fournisseurs → 2 liens Opération ↔ fournisseur, aucun lien document', () => {
    const rows: SupplierEvidenceRow[] = [];
    for (let f = 1; f <= 10; f++) rows.push(ev({ fileId: f, sourceId: 100 + f, supplierId: f % 2 ? 7 : 8, supplierName: f % 2 ? 'Télésurveillance Exemple' : 'Pose Alarmes' }));
    const d = desiredOperationSuppliers(op, rows, null);
    expect(d).toHaveLength(2);
    expect(d.find((x) => x.supplierId === 7)!.evidence.files).toEqual([1, 3, 5, 7, 9]);
  });

  it('plan : ajout, idempotence (AC11), mise à jour du rôle, retrait sans preuve', () => {
    const d = desiredOperationSuppliers(op, [ev({})], null);
    expect(planOperationSuppliers(d, []).add).toHaveLength(1);
    const persiste = lien({ evidence: d[0].evidence });
    expect(planIsEmpty(planOperationSuppliers(d, [persiste]))).toBe(true);
    expect(planOperationSuppliers(d, [lien({ role: 'DOCUMENT_ISSUER', evidence: d[0].evidence })]).update).toHaveLength(1);
    expect(planOperationSuppliers([], [persiste]).remove.map((x) => x.supplierId)).toEqual([7]);
  });

  it('AC08 décisions de l’utilisateur : refus jamais rétabli, lien USER jamais modifié ni retiré ; retrait automatique rétabli', () => {
    const d = desiredOperationSuppliers(op, [ev({})], null);
    const refus = planOperationSuppliers(d, [lien({ status: 'REJECTED', origin: 'USER' })]);
    expect(planIsEmpty(refus)).toBe(true);
    expect(refus.suppressed).toEqual([7]);
    expect(planIsEmpty(planOperationSuppliers([], [lien({ origin: 'USER', role: 'INTERVENER' })]))).toBe(true);
    expect(planIsEmpty(planOperationSuppliers(d, [lien({ origin: 'USER', role: 'INTERVENER' })]))).toBe(true);
    expect(planOperationSuppliers(d, [lien({ status: 'REMOVED' })]).restore).toHaveLength(1);
    // Un lien T3 refusé (REJECTED) n'est pas non plus rétabli.
    expect(planOperationSuppliers(d, [lien({ status: 'REJECTED' })]).suppressed).toEqual([7]);
  });
});

describe('L109A-U-PAGE — pagination du contrat de lecture (aucun plafond silencieux)', () => {
  it('normalisation : page ≥ 1, taille bornée et RENVOYÉE, filtre de provenance', () => {
    expect(normalizePage()).toEqual({ page: 1, pageSize: 50, provenance: 'ALL' });
    expect(normalizePage({ page: 3, pageSize: 10_000, provenance: 'VIA_OPERATION_ONLY' })).toEqual({ page: 3, pageSize: RELATIONS_MAX_PAGE_SIZE, provenance: 'VIA_OPERATION_ONLY' });
    expect(normalizePage({ page: 0, pageSize: -1, provenance: 'X' as never })).toEqual({ page: 1, pageSize: 50, provenance: 'ALL' });
    expect(pageOptionsFromSearch(new URLSearchParams('page=2&pageSize=20&provenance=DIRECT'))).toEqual({ page: 2, pageSize: 20, provenance: 'DIRECT' });
    expect(pageOptionsFromSearch(new URLSearchParams('page=abc'))).toEqual({ page: undefined, pageSize: undefined, provenance: 'ALL' });
  });
});

describe('L109A-U-COH — contrôle de cohérence et couverture', () => {
  it('COH-OPERATION-RELATIONS en FIN de registre, réparations interdites déclarées, domaines couverts', () => {
    const ids = COHERENCE_REGISTRY.map((c) => c.id);
    expect(ids.filter((x) => x === 'COH-OPERATION-RELATIONS')).toHaveLength(1);
    expect(ids.indexOf('COH-OPERATION-RELATIONS')).toBeGreaterThan(ids.indexOf('COH-DOC-DATE-FALLBACK'));
    const c = COHERENCE_REGISTRY.find((x) => x.id === 'COH-OPERATION-RELATIONS')!;
    expect(c).toMatchObject({ status: 'ACTIVE', version: 1, objectType: 'business_operation' });
    expect(c.forbiddenRepairs.join(' ')).toMatch(/refusé.*utilisateur/);
    expect(c.forbiddenRepairs.join(' ')).toMatch(/lien direct/);
    expect(c.immediateSupervision).toContain('CROSS_ACCOUNT_LINK');
    expect(COVERAGE_INVENTORY.find((d) => d.domain === 'operations')!.checks).toContain('COH-OPERATION-RELATIONS');
    expect(DIAG_TABLE_COVERAGE.business_operation_suppliers?.section).toBe('relations');
    expect(DIAG_TABLE_COVERAGE.business_operation_supplier_history?.section).toBe('relations');
  });
});

describe('L109A-U-WIRING — branchements (une seule source de lecture, écritures par le moteur existant)', () => {
  it('API équipement (documents, Agenda) lisent le contrat ; plus de requête propre aux liens', () => {
    const docs = src('src/app/api/equipments/[id]/documents/route.ts');
    expect(docs).toMatch(/listEntityDocuments/);
    expect(docs).not.toMatch(/FROM document_asset_links|db\s*\.select/);
    expect(src('src/app/api/equipments/[id]/agenda/route.ts')).toMatch(/listEntityAgendaItems/);
    expect(src('src/app/api/documents/[id]/relations/route.ts')).toMatch(/getDocumentRelations/);
  });

  it('T3 (reconsolidation), fusion et transfert Duo passent par le service unique ; aucun appel IA', () => {
    expect(src('src/services/business-operations/consolidation/consolidator.ts')).toMatch(/syncOperationSuppliers\(drizzleRunner\(tx\)/);
    expect(src('src/services/business-operations/grouping/merge.ts')).toMatch(/reassignOperationSuppliersOnMerge/);
    expect(src('src/services/business-operations/grouping/service.ts')).toMatch(/detachCrossAccountOperationSuppliers/);
    const svc = src('src/services/relations/operation-suppliers.ts');
    expect(svc).not.toMatch(/gateway|callModel|ai\/queue\/job-queue/);
    expect(src('src/services/relations/read-contract.ts')).not.toMatch(/INSERT|UPDATE |DELETE /);
  });

  it('libellé visible : jamais « Opération » dans la fiche équipement', () => {
    const ui = src('src/components/assets/EquipmentDrawer.tsx');
    expect(ui).toMatch(/Par un événement de référence/);
    expect(ui.match(/'[^']*Opération[^']*'/g) ?? []).toEqual([]);
  });
});
