/**
 * Lot 32C — T3 DOCUMENT_ASSET : rattrapage des anciennes abstentions
 * (ticket « Rattrapage des documents déjà ABSTAINED / NO_CANDIDATE »).
 * Tests unitaires (sans base) ; la chaîne complète est couverte par
 * `l32c-rattrapage-rattachement.e2e.ts` (T3RV-01 à 07).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  enqueue: vi.fn(async () => ({ decision: 'create', jobId: 1 })),
  markPending: vi.fn(async () => {}),
  confirmEvaluation: vi.fn(async (ids: number[]) => ids.length),
  loadAssetIdentifiers: vi.fn(async () => [] as unknown[]),
}));
vi.mock('../resolution.repository', () => ({ markPending: m.markPending, confirmEvaluation: m.confirmEvaluation }));
vi.mock('../asset-identifiers.repository', () => ({ loadAssetIdentifiers: m.loadAssetIdentifiers }));
vi.mock('../resolve-document-asset.service', async (orig) => ({
  ...(await orig<typeof import('../resolve-document-asset.service')>()),
  resolveDocumentAsset: vi.fn(),
}));

const { DOCUMENT_ASSET_RESOLUTION_VERSION } = await import('../version');
const { identifiersFingerprint } = await import('../identifiers');
const { inputFingerprint } = await import('../resolve-document-asset.service');
const { SWEEP_SQL, requestStaleResolutions } = await import('../queue');

const deps = { enqueue: m.enqueue as never, isTriggerActive: async () => true };
const maison = { assetId: 42, family: 'IMMOBILIER' as const, values: { address1: '12 rue Exemple', postalCode: '69003' } };

describe('T3RV-AC2 — version métier du moteur DOCUMENT_ASSET', () => {
  it('constante entière explicite (≥ 2), jamais un hash de commit', () => {
    expect(Number.isInteger(DOCUMENT_ASSET_RESOLUTION_VERSION)).toBe(true);
    expect(DOCUMENT_ASSET_RESOLUTION_VERSION).toBeGreaterThanOrEqual(2);
  });

  it('la version entre dans l’empreinte des entrées : une décision n’est réutilisable que sur la MÊME version', () => {
    const base = { extractionAt: '2026-10-01T10:00:00.000Z', candidates: [], matches: [] };
    expect(inputFingerprint(base)).toBe(inputFingerprint({ ...base, version: DOCUMENT_ASSET_RESOLUTION_VERSION }));
    expect(inputFingerprint({ ...base, version: DOCUMENT_ASSET_RESOLUTION_VERSION - 1 })).not.toBe(inputFingerprint(base));
  });

  it('la version est persistée à CHAQUE issue (recordOutcome) et à chaque confirmation (restoreLastOutcome)', () => {
    const repo = readFileSync(join(__dirname, '..', 'resolution.repository.ts'), 'utf8');
    const record = repo.slice(repo.indexOf('export async function recordOutcome'), repo.indexOf('/** Statuts après lesquels'));
    expect(record).toMatch(/resolution_version = \$10::int, evaluated_at = now\(\)/);
    expect(record).toMatch(/p\.resolutionVersion \?\? DOCUMENT_ASSET_RESOLUTION_VERSION/);
    const restore = repo.slice(repo.indexOf('export async function restoreLastOutcome'));
    expect(restore).toMatch(/evaluated_at = now\(\), resolution_version = \$2::int/);
  });
});

describe('T3RV-AC3 / AC7 / AC9 — sélection du balayage', () => {
  it('abstention exclue seulement si même analyse + version COURANTE + aucun identifiant modifié ; NULL = ancienne version', () => {
    const sql = SWEEP_SQL.replace(/\s+/g, ' ');
    // Même analyse ET même version ET pas de modification d'identifiant depuis l'évaluation.
    expect(sql).toContain("r.status IN ('ABSTAINED', 'NO_CANDIDATE') AND r.extraction_at IS NOT NULL AND r.extraction_at >= date_trunc('milliseconds', e.extracted_at) AND r.resolution_version IS NOT DISTINCT FROM $5::int AND NOT EXISTS ( SELECT 1 FROM document_asset_identifier_changes c");
    // NULL (ligne historique) : `IS NOT DISTINCT FROM` est FAUX, jamais NULL — sous `NOT (…)`, une
    // comparaison `=` à NULL rendrait la condition NULL et écarterait la ligne au lieu de la reprendre.
    expect(sql).not.toMatch(/r\.resolution_version = /);
    expect(sql).not.toMatch(/COALESCE\(r\.resolution_version/);
  });

  it('T3RV-AC6 — décision utilisateur jamais rejugée : USER_DECIDED exclu quelle que soit la version ; choix / retrait / lien USER filtrés', () => {
    const sql = SWEEP_SQL.replace(/\s+/g, ' ');
    expect(sql).toContain("(r.status IN ('MULTI_ASSET', 'USER_DECIDED') AND r.extraction_at IS NOT NULL AND r.extraction_at >= date_trunc('milliseconds', e.extracted_at))");
    expect(sql).toContain("COALESCE((f.user_edited_fields ->> 'assetId')::boolean, false) = false");
    expect(sql).toContain("(l.link_role = 'PRIMARY' OR l.origin = 'USER')");
  });

  it('T3RV-AC8 — paginé (curseur, LIMIT) et compatible file durable (aucun travail vivant en double)', () => {
    expect(SWEEP_SQL).toContain('f.id > $4::int');
    expect(SWEEP_SQL).toMatch(/LIMIT \$2/);
    expect(SWEEP_SQL).toContain("q.status IN ('PENDING', 'RUNNING')");
  });

  it('T3RV-AC4 — le rattrapage ne relance jamais T1 (aucune référence à l’analyse source)', () => {
    const queue = readFileSync(join(__dirname, '..', 'queue.ts'), 'utf8');
    expect(queue).not.toMatch(/analyzeFileSources|source-analysis\/entrypoint|runSourceAnalysis/);
  });
});

describe('T3RV-AC7 — identifiants des biens modifiés : empreinte comparée avant toute mise en file', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('empreinte stable (ordre des biens et des clés), sensible à une valeur, sans valeur en clair', () => {
    const autre = { assetId: 7, family: 'VEHICULE' as const, values: { registrationNumber: 'AB-123-CD' } };
    const a = identifiersFingerprint([maison, autre]);
    expect(identifiersFingerprint([autre, { ...maison, values: { postalCode: '69003', address1: '12 rue Exemple' } }])).toBe(a);
    expect(identifiersFingerprint([maison, { ...autre, values: { registrationNumber: 'AB-123-CE' } }])).not.toBe(a);
    expect(a).not.toContain('Exemple');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('abstention courante, empreinte inchangée → évaluation confirmée, AUCUN travail (pas de boucle horaire)', async () => {
    m.loadAssetIdentifiers.mockResolvedValue([maison]);
    const fp = identifiersFingerprint([maison]);
    const r = await requestStaleResolutions([
      { fileId: 1, accountId: 3, userId: 2, identifiersOnly: true, identifiersFingerprint: fp },
      { fileId: 2, accountId: 3, userId: 2, identifiersOnly: true, identifiersFingerprint: fp },
    ], { triggerCode: 'schedule_hourly', deps });
    expect(r).toEqual({ enqueued: [], confirmed: 2 });
    expect(m.enqueue).not.toHaveBeenCalled();
    expect(m.confirmEvaluation).toHaveBeenCalledWith([1, 2], fp);
    // Empreinte calculée UNE fois par compte et par page.
    expect(m.loadAssetIdentifiers).toHaveBeenCalledTimes(1);
  });

  it('identifiant réellement modifié, ancienne version ou nouvelle analyse → remis en file', async () => {
    m.loadAssetIdentifiers.mockResolvedValue([{ ...maison, values: { address1: '14 rue Exemple' } }]);
    const r = await requestStaleResolutions([
      { fileId: 1, accountId: 3, userId: 2, identifiersOnly: true, identifiersFingerprint: identifiersFingerprint([maison]) },
      { fileId: 2, accountId: 3, userId: 2, identifiersOnly: false, identifiersFingerprint: null },
      { fileId: 3, accountId: 3, userId: null, identifiersOnly: true, identifiersFingerprint: null },
    ], { triggerCode: 'schedule_hourly', deps });
    expect(r).toEqual({ enqueued: [1, 2, 3], confirmed: 0 });
    expect(m.markPending).toHaveBeenCalledTimes(3);
    // Rattrapage : aucun candidat T1 fourni (données T1 persistées conservées, T1 jamais relancé).
    expect(m.markPending).toHaveBeenCalledWith(expect.objectContaining({ fileId: 1, t1Candidates: undefined, triggerCode: 'schedule_hourly' }));
    expect(m.enqueue).toHaveBeenCalledTimes(3);
    expect(m.confirmEvaluation).not.toHaveBeenCalled();
  });

  it('garde d’exécution vérifiée avant chaque écriture', async () => {
    const guard = { assertActive: vi.fn(async () => {}) };
    await requestStaleResolutions([{ fileId: 9, accountId: 3, userId: 2, identifiersOnly: false, identifiersFingerprint: null }], {
      triggerCode: 'schedule_hourly', deps, guard: guard as never,
    });
    expect(guard.assertActive).toHaveBeenCalled();
  });
});

describe('migration 0274 — colonne, journal et déclencheur', () => {
  const sql = readFileSync(join(process.cwd(), 'src/db/migrations/0274_document_asset_resolution_version.sql'), 'utf8');
  it('idempotente : colonnes et table IF NOT EXISTS, déclencheurs recréés', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS resolution_version INTEGER/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS evaluated_at TIMESTAMPTZ/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS identifiers_fingerprint TEXT/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS document_asset_identifier_changes/);
    expect(sql).toMatch(/DROP TRIGGER IF EXISTS assets_document_asset_identifier_changes_upd ON assets/);
    // Pas de CONCURRENTLY dans le fichier principal (transaction).
    expect(sql).not.toMatch(/INDEX CONCURRENTLY/);
  });
  it('le déclencheur ne vise que les sources d’identifiant (adresse, immatriculation, caractéristiques…)', () => {
    expect(sql).toMatch(/AFTER UPDATE OF address, postal_code, city, registration_number, key_characteristics, category, deleted_at, account_id ON assets/);
    expect(sql).not.toMatch(/EXCEPTION\s+WHEN/);
  });
});
