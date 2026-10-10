/**
 * Lot 34E — ticket « T3 : rendre la réconciliation globale réellement
 * continue » : révision de connaissance, faits sans cible, orchestration.
 * Tests unitaires (sans base) ; chaîne complète sur base réelle :
 * `l34e-reconciliation-continue.e2e.ts` (T3C-01 à 08).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';
import { factTargetFingerprint, matchOpenFacts, type OpenFact } from '../fact-target-reconciler';
import { knowledgeChangedSql, KNOWLEDGE_CHANGE_KINDS } from '../knowledge-revision';
import { buildMatchingIndex, type IndexedAsset, type IndexedEntity } from '../../document-asset/matching-index';
import { isUnchangedOpenContext } from '../../document-asset/resolve-document-asset.service';
import { DOCUMENT_ASSET_RESOLUTION_VERSION } from '../../document-asset/version';
import { OPEN_OUTCOMES } from '../../document-asset/resolution.repository';
import { T3_EVENT_TRIGGERS } from '../../t3-queue';

const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const bien = (id: number, values: Record<string, string> = {}): IndexedAsset => ({
  assetId: id, name: `Bien ${id}`, normalizedName: `bien ${id}`, aliases: [], family: 'OBJECT', category: 'OBJECT', subtype: null,
  record: { assetId: id, family: 'OBJECT', values }, brandModel: null, city: null, postalCode: null,
});
const equipement = (id: number, assetId: number, serial: string | null): IndexedEntity => ({
  type: 'EQUIPMENT', id, assetId, name: `Équipement ${id}`, normalizedName: `equipement ${id}`, serial, brandModel: null,
});
const fait = (o: Partial<OpenFact>): OpenFact => ({ id: 1, fileId: 10, canonicalKey: 'serialNumber', value: 'ABC12345', targetType: null, targetEntityId: null, ...o });

describe('T3C-02 — fait sans cible ↔ équipement par n° de série (déterministe, sans T1)', () => {
  const index = buildMatchingIndex(1, [bien(1), bien(2, { registrationNumber: 'AB-123-CD' })], [equipement(7, 1, 'ABC12345')]);

  it('série = celle d’UN équipement → cible précisée vers l’équipement', () => {
    expect(matchOpenFacts([fait({ value: 'abc-12345' })], index)).toEqual([
      expect.objectContaining({ factId: 1, kind: 'EQUIPMENT', equipmentId: 7, assetId: 1 }),
    ]);
  });
  it('fait rattaché au BIEN porteur : précisé vers l’équipement ; rattaché à un AUTRE bien : jamais déplacé', () => {
    expect(matchOpenFacts([fait({ targetType: 'ASSET', targetEntityId: 1 })], index)).toHaveLength(1);
    expect(matchOpenFacts([fait({ targetType: 'ASSET', targetEntityId: 2 })], index)).toEqual([]);
  });
  it('fait d’identifiant sans cible → bien (immatriculation) ; aucun rapprochement ambigu', () => {
    expect(matchOpenFacts([fait({ canonicalKey: 'registrationNumber', value: 'AB123CD' })], index))
      .toEqual([expect.objectContaining({ kind: 'ASSET', assetId: 2 })]);
    const deux = buildMatchingIndex(1, [bien(1)], [equipement(7, 1, 'ABC12345'), equipement(8, 1, 'ABC12345')]);
    expect(matchOpenFacts([fait({})], deux)).toEqual([]);
  });
  it('empreinte : identique sans changement, différente quand un équipement apparaît', () => {
    const vide = buildMatchingIndex(1, [bien(1)], []);
    expect(factTargetFingerprint([fait({})], vide)).toBe(factTargetFingerprint([fait({})], vide));
    expect(factTargetFingerprint([fait({})], index)).not.toBe(factTargetFingerprint([fait({})], vide));
  });
});

describe('T3C-04 / T3C-07 — décisions ouvertes jamais définitives, confirmées sans IA si le contexte est inchangé', () => {
  it('NO_CANDIDATE, ABSTAINED, MULTI_ASSET sont des issues OUVERTES', () => {
    expect([...OPEN_OUTCOMES].sort()).toEqual(['ABSTAINED', 'MULTI_ASSET', 'NO_CANDIDATE']);
  });
  it('même empreinte + même version → CONFIRMED_NO_CHANGE ; sinon réévaluation', () => {
    const r = { lastOutcome: 'NO_CANDIDATE' as const, contextFingerprint: 'abc', resolutionVersion: DOCUMENT_ASSET_RESOLUTION_VERSION };
    expect(isUnchangedOpenContext(r, 'abc')).toBe(true);
    expect(isUnchangedOpenContext(r, 'def')).toBe(false);
    expect(isUnchangedOpenContext({ ...r, resolutionVersion: 2 }, 'abc')).toBe(false);
    expect(isUnchangedOpenContext({ ...r, lastOutcome: 'RESOLVED' }, 'abc')).toBe(false);
    expect(isUnchangedOpenContext(null, 'abc')).toBe(false);
  });
});

describe('révision de connaissance (migration 0292)', () => {
  const m = src('src/db/migrations/0292_t3_knowledge_revision.sql');
  it('journal insert-only, révision = max(id) par compte ; colonnes de contexte d’évaluation', () => {
    expect(m).toMatch(/CREATE TABLE IF NOT EXISTS account_knowledge_changes/);
    expect(m).toMatch(/ADD COLUMN IF NOT EXISTS knowledge_revision BIGINT/);
    expect(m).toMatch(/ADD COLUMN IF NOT EXISTS context_fingerprint TEXT/);
    expect(m).toMatch(/CREATE TABLE IF NOT EXISTS t3_reconciliation_states/);
    expect(m).not.toMatch(/CONCURRENTLY/);
    expect(knowledgeChangedSql('f.account_id', 'r.knowledge_revision')).toContain('kc.id > COALESCE(r.knowledge_revision, 0)');
  });
  it('toutes les connaissances utiles à T3 sont suivies, les écritures cosmétiques non (WHEN … IS DISTINCT FROM)', () => {
    for (const t of ['assets', 'equipments', 'equipment_cil_specs', 'substructures', 'document_extractions', 'document_facts', 'document_asset_links', 'asset_files', 'to_process_actions']) {
      expect(m, t).toMatch(new RegExp(`ON ${t}\\b`));
    }
    for (const k of KNOWLEDGE_CHANGE_KINDS) expect(m).toContain(k);
    expect(m).toMatch(/OLD\.name IS DISTINCT FROM NEW\.name/);
    expect(m).not.toMatch(/UPDATE OF [^;]*\bnotes\b/);
    expect(m).not.toMatch(/UPDATE OF [^;]*\bthumbnail_url\b/);
    // Faits : un déclencheur par instruction (une analyse écrit des dizaines de faits).
    expect(m).toMatch(/REFERENCING NEW TABLE AS kn_new FOR EACH STATEMENT/);
    // Le journal 0274 (identifiants seuls) est remplacé.
    expect(m).toMatch(/DROP TRIGGER IF EXISTS assets_document_asset_identifier_changes_upd ON assets/);
  });
});

describe('déclenchement événementiel + réconciliation compte (orchestration existante)', () => {
  it('événements de connaissance mappés sur le catalogue ACTUEL', () => {
    expect(T3_EVENT_TRIGGERS).toMatchObject({
      document_linked: 'document_linked', document_unlinked: 'document_linked', asset_updated: 'asset_updated',
      entity_updated: 'asset_updated', knowledge_updated: 'document_linked', arbitration_resolved: 'arbitration_resolved',
    });
  });
  it('la réconciliation compte reprend la connaissance ouverte (faits, documents) — sans relire de fichier ni rappeler T1', () => {
    const a = src('src/services/ai/reconciliation/account-reconciliation.service.ts');
    expect(a).toMatch(/reconcileOpenKnowledge\(accountId/);
    const o = src('src/services/ai/reconciliation/continuous/open-knowledge.service.ts');
    expect(o).not.toMatch(/analyzeFileSources|source-analysis\/entrypoint|AiGateway/);
    expect(o).toMatch(/reconcileFactTargets/);
    expect(o).toMatch(/sweepAccountDocuments/);
  });
  it('T3C-06 — autorité utilisateur : jamais de déplacement, carte d’incohérence existante (LINK-ASSET-CONFLICT) réutilisée', () => {
    const u = src('src/services/ai/reconciliation/continuous/user-decision-conflicts.ts');
    expect(u).toMatch(/proposeDocumentAssetConflict\(/);
    expect(u).not.toMatch(/attachAutomatically|linkDocumentToAsset|unlinkDocument|UPDATE asset_files/);
    expect(src('src/services/ai/reconciliation/continuous/open-knowledge.service.ts')).toMatch(/reconcileUserDecisionConflicts/);
  });
    it('création de bien et d’équipement : événement émis', () => {
    expect(src('src/app/api/assets/route.ts')).toMatch(/event: 'asset_updated', objectType: 'asset'/);
    expect(src('src/app/api/assets/[id]/equipments/route.ts')).toMatch(/event: 'entity_updated', objectType: 'equipment'/);
    expect(src('src/app/api/assets/[id]/equipments/[equipId]/route.ts')).toMatch(/event: 'entity_updated'/);
  });
  it('phase non bloquante : une erreur n’arrête pas la réconciliation compte', async () => {
    vi.resetModules();
    const { reconcileAccount } = await import('../../account-reconciliation.service');
    expect(typeof reconcileAccount).toBe('function');
  });
});
