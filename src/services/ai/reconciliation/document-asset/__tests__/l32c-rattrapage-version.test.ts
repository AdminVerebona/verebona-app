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
  confirmContext: vi.fn(async () => true),
  getResolution: vi.fn(async () => ({ lastOutcome: 'ABSTAINED', t1Candidates: [], contextFingerprint: 'fp-a', knowledgeRevision: 5 })),
  computeContext: vi.fn(async () => ({ fingerprint: 'fp-a' })),
  revision: vi.fn(async () => 7),
}));
vi.mock('../resolution.repository', () => ({ markPending: m.markPending, confirmContext: m.confirmContext, getResolution: m.getResolution }));
vi.mock('../attachment-state', () => ({ readAttachmentState: async () => ({ exists: true, secondaryAssetIds: [], mentionedAssetIds: [] }) }));
vi.mock('../context', () => ({ computeDocumentAssetContext: m.computeContext }));
vi.mock('../matching-index', () => ({ MatchingIndexCache: class { get = vi.fn(async () => ({ accountId: 3 })); } }));
vi.mock('../../continuous/knowledge-revision', () => ({
  getAccountKnowledgeRevision: m.revision, knowledgeChangedSince: async () => ['ASSET'], compactKnowledgeChanges: async () => {},
  knowledgeChangedSql: (a: string, r: string) => `EXISTS (SELECT 1 FROM account_knowledge_changes kc WHERE kc.account_id = ${a} AND kc.id > COALESCE(${r}, 0))`,
}));
vi.mock('../resolve-document-asset.service', async (orig) => ({
  ...(await orig<typeof import('../resolve-document-asset.service')>()),
  resolveDocumentAsset: vi.fn(),
  evaluationBase: () => ({}),
}));

const { DOCUMENT_ASSET_RESOLUTION_VERSION } = await import('../version');
const { identifiersFingerprint } = await import('../identifiers');
const { SWEEP_SQL, requestStaleResolutions } = await import('../queue');

const deps = { enqueue: m.enqueue as never, isTriggerActive: async () => true };
const maison = { assetId: 42, family: 'IMMOBILIER' as const, values: { address1: '12 rue Exemple', postalCode: '69003' } };

describe('T3RV-AC2 — version métier du moteur DOCUMENT_ASSET', () => {
  it('constante entière explicite (≥ 3 depuis le Candidate Builder 34E), jamais un hash de commit', () => {
    expect(Number.isInteger(DOCUMENT_ASSET_RESOLUTION_VERSION)).toBe(true);
    expect(DOCUMENT_ASSET_RESOLUTION_VERSION).toBeGreaterThanOrEqual(3);
  });

  it('la version entre dans l’empreinte du contexte : une décision n’est réutilisable que sur la MÊME version', async () => {
    const { documentAssetContextFingerprint } = await vi.importActual<typeof import('../context')>('../context');
    const base = { documentDigest: 'd', candidates: [], candidateIdentifiers: {}, matches: [] };
    expect(documentAssetContextFingerprint(base)).not.toBe(documentAssetContextFingerprint({
      ...base, versions: { resolution: DOCUMENT_ASSET_RESOLUTION_VERSION - 1, builder: 1, rules: 1 },
    }));
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
  it('décision ouverte exclue seulement si même analyse + version COURANTE + connaissance du compte inchangée ; NULL = ancienne version', () => {
    const sql = SWEEP_SQL.replace(/\s+/g, ' ');
    // Même analyse ET même version ET aucune évolution de la connaissance depuis la révision évaluée (34E).
    expect(sql).toContain("r.status IN ('ABSTAINED', 'NO_CANDIDATE', 'MULTI_ASSET') AND r.extraction_at IS NOT NULL AND r.extraction_at >= date_trunc('milliseconds', e.extracted_at) AND r.resolution_version IS NOT DISTINCT FROM $5::int AND NOT EXISTS (SELECT 1 FROM account_knowledge_changes kc WHERE kc.account_id = f.account_id AND kc.id > COALESCE(r.knowledge_revision, 0))");
    // NULL (ligne historique) : `IS NOT DISTINCT FROM` est FAUX, jamais NULL — sous `NOT (…)`, une
    // comparaison `=` à NULL rendrait la condition NULL et écarterait la ligne au lieu de la reprendre.
    expect(sql).not.toMatch(/r\.resolution_version = /);
    expect(sql).not.toMatch(/COALESCE\(r\.resolution_version/);
  });

  it('T3RV-AC6 — décision utilisateur jamais rejugée : USER_DECIDED exclu quelle que soit la version ; choix / retrait / lien USER filtrés', () => {
    const sql = SWEEP_SQL.replace(/\s+/g, ' ');
    expect(sql).toContain("(r.status = 'USER_DECIDED' AND r.extraction_at IS NOT NULL AND r.extraction_at >= date_trunc('milliseconds', e.extracted_at))");
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

describe('T3RV-AC7 / 34E — évolution de la connaissance : contexte comparé avant toute mise en file', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('empreinte stable (ordre des biens et des clés), sensible à une valeur, sans valeur en clair', () => {
    const autre = { assetId: 7, family: 'VEHICULE' as const, values: { registrationNumber: 'AB-123-CD' } };
    const a = identifiersFingerprint([maison, autre]);
    expect(identifiersFingerprint([autre, { ...maison, values: { postalCode: '69003', address1: '12 rue Exemple' } }])).toBe(a);
    expect(identifiersFingerprint([maison, { ...autre, values: { registrationNumber: 'AB-123-CE' } }])).not.toBe(a);
    expect(a).not.toContain('Exemple');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  const row = (o: Partial<Parameters<typeof requestStaleResolutions>[0][number]>) => ({
    fileId: 1, accountId: 3, userId: 2, contextCheck: true, contextFingerprint: 'fp-a', knowledgeRevision: 5,
    reprocessReason: 'KNOWLEDGE_CHANGED' as const, ...o,
  });

  it('T3C-07 — décision ouverte, connaissance modifiée mais contexte identique → CONFIRMED_NO_CHANGE, AUCUN travail', async () => {
    const r = await requestStaleResolutions([row({ fileId: 1 }), row({ fileId: 2 })], { triggerCode: 'schedule_hourly', deps });
    expect(r).toEqual({ enqueued: [], confirmed: 2 });
    expect(m.enqueue).not.toHaveBeenCalled();
    expect(m.confirmContext).toHaveBeenCalledWith(expect.objectContaining({ fileId: 1, contextFingerprint: 'fp-a', knowledgeRevision: 7 }));
  });

  it('contexte modifié, ancienne version ou nouvelle analyse → remis en file avec le motif', async () => {
    m.computeContext.mockResolvedValueOnce({ fingerprint: 'fp-b' });
    const r = await requestStaleResolutions([
      row({ fileId: 1 }),
      row({ fileId: 2, contextCheck: false, contextFingerprint: null, reprocessReason: 'ENGINE_VERSION' }),
      row({ fileId: 3, userId: null, contextCheck: false, reprocessReason: 'NEW_ANALYSIS' }),
    ], { triggerCode: 'schedule_hourly', deps });
    expect(r).toEqual({ enqueued: [1, 2, 3], confirmed: 0 });
    expect(m.markPending).toHaveBeenCalledTimes(3);
    // Rattrapage : aucun candidat T1 fourni (données T1 persistées conservées, T1 jamais relancé).
    expect(m.markPending).toHaveBeenCalledWith(expect.objectContaining({ fileId: 1, t1Candidates: undefined, triggerCode: 'schedule_hourly' }));
    expect(m.enqueue).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ reprocessReason: 'CONTEXT_CHANGED' }) }));
    expect(m.enqueue).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ reprocessReason: 'ENGINE_VERSION' }) }));
    expect(m.confirmContext).not.toHaveBeenCalled();
  });

  it('garde d’exécution vérifiée avant chaque écriture', async () => {
    const guard = { assertActive: vi.fn(async () => {}) };
    await requestStaleResolutions([row({ fileId: 9, contextCheck: false, contextFingerprint: null })], {
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
