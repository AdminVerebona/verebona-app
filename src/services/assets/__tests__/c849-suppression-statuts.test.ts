/**
 * Carte #849 — règles PURES : deux statuts, quota des biens actifs, plan et
 * empreinte de suppression, garde de la fenêtre de suppression, CSV du ZIP
 * complet, cession d'un bien transmis.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('@/db', () => ({ db: {}, pgClient: {} }));
vi.mock('@/lib/api-client', () => ({ apiClient: {} }));

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

describe('#849 A1 — deux statuts métier', async () => {
  const st = await import('@/lib/asset-status');
  it('EN_SERVICE et TRANSMIS seulement ; anciennes valeurs lues comme TRANSMIS', () => {
    expect([...st.ASSET_STATUSES]).toEqual(['EN_SERVICE', 'TRANSMIS']);
    for (const v of ['VENDU', 'ARCHIVED', 'DETRUIT', 'vendu']) expect(st.normalizeAssetStatus(v)).toBe('TRANSMIS');
    for (const v of ['EN_PANNE', 'INACTIF', null, '']) expect(st.normalizeAssetStatus(v)).toBe('EN_SERVICE');
    expect(st.isReadOnlyAssetStatus('TRANSMIS')).toBe(true);
    expect(st.isReadOnlyAssetStatus('EN_SERVICE')).toBe(false);
    expect(st.isOutOfPortfolioStatus('TRANSMIS')).toBe(true);
    expect(st.assetStatusLabel('VENDU')).toBe('Transmis');
  });
  it('quota : seuls les biens EN_SERVICE non supprimés ; écriture / ouverture', () => {
    expect(st.QUOTA_COUNTED_ASSET_STATUS).toBe('EN_SERVICE');
    expect(st.quotaCountedAssetSql('a')).toBe("(a.deleted_at IS NULL AND a.status = 'EN_SERVICE')");
    expect(st.assetWritableSql('a')).toContain("a.status IS DISTINCT FROM 'TRANSMIS'");
    expect(st.assetOpenableSql('a')).not.toContain('status');
  });
  it('base, schéma et migration alignés ; aucun bouton Archiver ; aucune fenêtre au passage à Transmis', async () => {
    expect(read('src/db/schema.ts')).toContain("${table.status} IN ('EN_SERVICE', 'TRANSMIS')");
    const m = read('src/db/migrations/2013_c849_statuts_bien_deux_valeurs.sql');
    expect(m).toContain("CHECK (status IN ('EN_SERVICE', 'TRANSMIS')) NOT VALID");
    expect(m).toMatch(/NOT EXISTS \(SELECT 1 FROM canonical_field_writes w/);
    expect(m).toMatch(/UPDATE assets SET status = 'TRANSMIS' WHERE status IN \('VENDU', 'ARCHIVED', 'DETRUIT'\)/);
    const { saleDetailsPrompt, salePriceApplies, isDisposalStatus } = await import('@/lib/assets/sale-fields');
    for (const s of ['VENDU', 'TRANSMIS', 'EN_SERVICE']) expect(saleDetailsPrompt(s)).toBeNull();
    expect(salePriceApplies('TRANSMIS')).toBe(true);
    expect(isDisposalStatus('VENDU')).toBe(false);
  });
});

describe('#849 A1 — cession établie par la fiche d’un bien transmis', async () => {
  const { assetDataFacts } = await import('@/services/business-operations/consolidation/asset-data');
  const ligne = (status: string, kc: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
    ({ id: 1, status, status_changed_at: '2025-04-02T10:00:00Z', key_characteristics: JSON.stringify(kc), ...extra }) as never;
  it('prix de vente saisi → VENTE chiffrée ; sans prix → transmission ; ancien archivé → aucune cession', () => {
    const vente = assetDataFacts(ligne('TRANSMIS', { salePrice: 1500, salePrice__origin: 'USER', saleDate: '2025-03-01', saleDate__origin: 'USER' }));
    expect(vente.DISPOSAL).toMatchObject({ disposalKind: 'SALE', amountMinor: 150000, date: '2025-03-01' });
    expect(assetDataFacts(ligne('TRANSMIS')).DISPOSAL).toMatchObject({ disposalKind: 'TRANSMISSION', amountMinor: null, dateBasis: 'STATUS_CHANGE' });
    expect(assetDataFacts(ligne('TRANSMIS', {}, { c849_legacy_archived: true })).DISPOSAL).toBeNull();
    expect(assetDataFacts(ligne('EN_SERVICE')).DISPOSAL).toBeNull();
  });
});

describe('#849 B — plan, inventaire et empreinte de suppression', async () => {
  const { deletionPlanFingerprint, inventoryOfPlan } = await import('../asset-deletion-plan');
  const plan = {
    assetId: 7, accountId: 3,
    exclusiveFileIds: [11, 12], sharedFiles: [{ id: 13, newAssetId: 8 }], documentFileIds: [11], versionIds: [5], photoIds: [2],
    substructureIds: [1], equipmentIds: [4], exclusiveDeadlineIds: [], sharedDeadlineIds: [9], exclusiveEventIds: [6], sharedEventIds: [],
    exclusiveAgendaItemIds: [21], sharedAgendaItemIds: [22], exclusiveOperationIds: [31], sharedOperationIds: [32],
    expenseComponentIds: [41, 42], sharedOperationExpenseIds: [42], exportIds: [51],
  };
  it('inventaire : supprimé et conservé distingués', () => {
    expect(inventoryOfPlan(plan)).toMatchObject({
      documents: 1, documentVersions: 1, photos: 1, rooms: 1, equipments: 1, events: 1, deadlines: 0, agendaItems: 1,
      operations: 1, expenses: 2, exports: 1,
      shared: { documents: 1, agendaItems: 1, operations: 1, deadlines: 1, events: 0 },
    });
  });
  it('empreinte stable (ordre indifférent), sensible à tout nouveau rattachement ou partage', () => {
    const fp = deletionPlanFingerprint(plan);
    expect(fp).toMatch(/^[0-9a-f]{32}$/);
    expect(deletionPlanFingerprint({ ...plan, exclusiveFileIds: [12, 11] })).toBe(fp);
    expect(deletionPlanFingerprint({ ...plan, exclusiveFileIds: [11, 12, 14] })).not.toBe(fp);
    expect(deletionPlanFingerprint({ ...plan, sharedFiles: [{ id: 13, newAssetId: 9 }] })).not.toBe(fp);
    expect(deletionPlanFingerprint({ ...plan, exclusiveOperationIds: [], sharedOperationIds: [31, 32] })).not.toBe(fp);
  });
});

describe('#849 B1 / C2 — fenêtre de suppression', async () => {
  const { canConfirmDeletion, describeDeletionSummary, describeSharedKept } = await import('@/components/assets/DeleteAssetDialog');
  const base = { inventoryReady: true, fingerprint: 'abc', acknowledged: true, exportState: 'none' as const, isLoading: false };
  it('inventaire absent, illisible ou non confirmé : suppression bloquée (aucune suppression aveugle)', () => {
    expect(canConfirmDeletion(base)).toBe(true);
    expect(canConfirmDeletion({ ...base, inventoryReady: false })).toBe(false);
    expect(canConfirmDeletion({ ...base, fingerprint: null })).toBe(false);
    expect(canConfirmDeletion({ ...base, acknowledged: false })).toBe(false);
    expect(canConfirmDeletion({ ...base, isLoading: true })).toBe(false);
  });
  it('export demandé : suppression après téléchargement vérifié, déclaré, ou abandon explicite seulement', () => {
    for (const e of ['generating', 'downloading', 'unverified', 'failed'] as const) expect(canConfirmDeletion({ ...base, exportState: e }), e).toBe(false);
    for (const e of ['none', 'downloaded', 'confirmed', 'abandoned'] as const) expect(canConfirmDeletion({ ...base, exportState: e }), e).toBe(true);
  });
  it('libellés : supprimés (Opérations, dépenses, versions…) et conservés', () => {
    const inv = { documents: 2, photos: 0, deadlines: 0, events: 1, rooms: 0, equipments: 0, documentVersions: 1, operations: 1, expenses: 3, agendaItems: 0, exports: 0,
      shared: { documents: 1, agendaItems: 0, operations: 2, deadlines: 0, events: 0 } };
    expect(describeDeletionSummary(inv)).toEqual(['2 documents', '1 version de document', '1 événement', '1 Opération', '3 dépenses']);
    expect(describeSharedKept(inv)).toEqual(['1 document', '2 Opérations']);
  });
});

describe('#849 C1 — CSV UTF-8 du ZIP complet', async () => {
  const { toCsv } = await import('@/services/exports/complete-archive');
  it('BOM, séparateur « ; », guillemets échappés, valeurs vides et JSON', () => {
    const csv = toCsv(['a', 'b', 'c'], [{ a: 'Été ; "x"', b: null, c: { k: 1 } }, { a: 2, b: 'ligne\nsuivante', c: undefined }]);
    expect(csv.startsWith('﻿a;b;c\r\n')).toBe(true);
    expect(csv).toContain('"Été ; ""x""";;"{""k"":1}"');
    expect(csv).toContain('2;"ligne\nsuivante";');
  });
});

describe('#849 C2 — plus aucune pièce ignorée en silence', () => {
  it('export-zip : lecture stricte, aucun « if (!buf) continue » sans échec', () => {
    const src = read('src/services/export-zip.service.ts');
    expect(src).not.toContain('downloadFromS3');
    expect(src).toContain('lecteur.assertComplete()');
    expect(src.match(/if \(!buf\) continue;(?! \/\/ manquant consigné)/g)).toBeNull();
  });
});
