/**
 * Lot 39 — O1, socle des Opérations (CDC Opérations V1) : règles pures,
 * alignement code ↔ SQL, bus d'événements, gardes statiques.
 *
 * Identifiants du CDC quand ils existent (F-xxx, PARENT-xxx, INV-xxx), O1-xx
 * sinon. Les contrôles en base réelle sont dans
 * `src/test/e2e/scenarios/l39-o1-socle-operations.e2e.ts`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AUTHORITIES, BUSINESS_OPERATION_STATUSES, BUSINESS_OPERATION_TYPES, BUSINESS_OPERATION_TYPE_CODES,
  CLAIM_FILE_STATUSES, COMPONENT_SIGN, CONTRACT_PERIODICITIES, FINANCIAL_COMPONENT_KINDS, HISTORY_EVENT_TYPES, MATCH_METHODS,
  REFERENCE_KINDS, SOURCE_KINDS, SOURCE_ROLES, checkStatusTransition,
  normalizeBusinessReference, normalizeOperationTypeHint, resolveOperationTypeInput,
} from '../model';
import {
  BUSINESS_OPERATION_EVENT_TYPES, BusinessOperationEventBuffer, businessOperationEventCounters,
  publishBusinessOperationEvents, resetBusinessOperationEventBusForTests, subscribeBusinessOperationEvents,
} from '../events';
import { lockOrder } from '../lock';
import { migrationCriticality, concurrentIndexName } from '@/db/migration-index';

vi.mock('@/db', () => ({ db: {}, pgClient: { unsafe: vi.fn() } }));

const ROOT = process.cwd();
const MIG = join(ROOT, 'src/db/migrations');
const lire = (f: string) => readFileSync(join(MIG, f), 'utf8').replace(/--.*$/gm, '');
const SQL_0316 = lire('0316_business_operations.sql');
const SQL_0317 = lire('0317_business_operation_details.sql');
const SQL_O1 = SQL_0316 + SQL_0317;

const code = (fn: () => unknown): string => {
  try { fn(); } catch (e) { return (e as { code?: string }).code ?? 'ERREUR'; }
  return 'OK';
};

/** Valeurs d'une contrainte CHECK `nom CHECK (... IN ('A', 'B'))`. */
function valeursCheck(sql: string, nom: string): string[] {
  const m = new RegExp(`CONSTRAINT ${nom} CHECK \\(([^\\n]*)\\)`).exec(sql);
  if (!m) throw new Error(`contrainte ${nom} absente`);
  const liste = /IN \(([^)]*)\)/.exec(m[1])![1];
  return [...liste.matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

describe('O1-01 vocabulaire fermé : code = contraintes SQL (C1.1, C20)', () => {
  it.each([
    ['business_operation_types_code_chk', BUSINESS_OPERATION_TYPE_CODES],
    ['business_operations_status_chk', BUSINESS_OPERATION_STATUSES],
    ['business_operation_sources_kind_chk', SOURCE_KINDS],
    ['business_operation_sources_role_chk', SOURCE_ROLES],
    ['business_operation_sources_authority_chk', AUTHORITIES],
    ['business_operation_sources_match_method_chk', MATCH_METHODS],
    ['business_operation_financial_components_kind_chk', FINANCIAL_COMPONENT_KINDS],
    ['business_operation_history_event_type_chk', HISTORY_EVENT_TYPES],
    ['business_operation_references_kind_chk', REFERENCE_KINDS],
    ['business_operation_contract_details_periodicity_chk', CONTRACT_PERIODICITIES],
    ['business_operation_claim_details_status_chk', CLAIM_FILE_STATUSES],
    ['document_operation_candidates_type_hint_chk', BUSINESS_OPERATION_TYPE_CODES],
    ['business_operation_match_decisions_kind_chk', SOURCE_KINDS],
  ] as const)('%s', (nom, attendu) => {
    expect(valeursCheck(SQL_O1, nom)).toEqual([...attendu]);
  });

  it('ACC-006 / C27 : 7 types, seed SQL identique au référentiel du code (libellés, descriptions)', () => {
    expect(BUSINESS_OPERATION_TYPES.map((t) => t.code)).toEqual([...BUSINESS_OPERATION_TYPE_CODES]);
    for (const t of BUSINESS_OPERATION_TYPES) {
      const ligne = SQL_0316.split('\n').find((l) => l.trim().startsWith(`('${t.code}',`));
      expect(ligne, t.code).toBeDefined();
      const textes = [...ligne!.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
      expect(textes.slice(0, 3)).toEqual([t.code, t.label, t.description]);
    }
    expect(SQL_0316).toMatch(/ON CONFLICT \(code\) DO NOTHING/);
  });

  it('C12 : montants positifs, signe porté par le rôle (REDUCTION / REFUND / INDEMNITY / PROCEED négatifs)', () => {
    expect(SQL_0316).toMatch(/CHECK \(amount_minor >= 0\)/);
    expect(Object.entries(COMPONENT_SIGN).filter(([, s]) => s < 0).map(([k]) => k)).toEqual(['REDUCTION', 'REFUND', 'INDEMNITY', 'PROCEED']);
  });
});

describe('O1-02 migrations 0316-0319 : idempotentes, index CONCURRENTLY isolés', () => {
  const fichiers = readdirSync(MIG).filter((f) => /^031[6-9]_/.test(f)).sort();

  it('fichiers principaux : rien hors IF NOT EXISTS / ON CONFLICT / garde DO', () => {
    for (const f of ['0316_business_operations.sql', '0317_business_operation_details.sql']) {
      const s = lire(f);
      expect(s.match(/CREATE TABLE (?!IF NOT EXISTS)/g), f).toBeNull();
      expect(s.match(/CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/g), f).toBeNull();
      expect(s, f).not.toMatch(/CONCURRENTLY/);
      expect(s, f).not.toMatch(/DROP /);
    }
    const s318 = lire('0318_agenda_items_business_operation.sql');
    expect(s318).toMatch(/ADD COLUMN IF NOT EXISTS business_operation_id BIGINT;/);
    expect(s318).toMatch(/NOT VALID/);
    expect(s318).not.toMatch(/origin_type/); // la contrainte historique n'est pas touchée
    expect(lire('0319_agenda_items_business_operation_validate.sql')).toMatch(/VALIDATE CONSTRAINT agenda_items_business_operation_fk/);
  });

  it('chaque `_idx_N` : une instruction CREATE INDEX CONCURRENTLY IF NOT EXISTS, non unique (optionnelle)', () => {
    const idx = fichiers.filter((f) => /_idx_\d+\.sql$/.test(f));
    expect(idx.length).toBe(27);
    for (const f of idx) {
      const s = readFileSync(join(MIG, f), 'utf8');
      expect(concurrentIndexName(s), f).not.toBeNull();
      expect(migrationCriticality(s), f).toBe('optional');
    }
    for (const f of fichiers.filter((x) => !/_idx_/.test(x))) expect(migrationCriticality(readFileSync(join(MIG, f), 'utf8')), f).toBe('critical');
  });
});

describe('INV-FINAL-008 / P18 : OTHER n’est jamais un repli (F-030, F-194)', () => {
  it('type nul admis ; six types principaux admis', () => {
    expect(resolveOperationTypeInput(null)).toBeNull();
    expect(resolveOperationTypeInput(undefined)).toBeNull();
    expect(resolveOperationTypeInput({ code: 'CLAIM' })).toBe('CLAIM');
  });
  it('OTHER sans qualification certaine motivée : refusé', () => {
    expect(code(() => resolveOperationTypeInput({ code: 'OTHER' } as never))).toBe('OTHER_AS_FALLBACK');
    expect(code(() => resolveOperationTypeInput({ code: 'OTHER', qualification: { confidence: 'probable', reason: 'x' } } as never))).toBe('OTHER_AS_FALLBACK');
    expect(code(() => resolveOperationTypeInput({ code: 'OTHER', qualification: { confidence: 'certain', reason: '  ' } }))).toBe('OTHER_AS_FALLBACK');
    expect(resolveOperationTypeInput({ code: 'OTHER', qualification: { confidence: 'certain', reason: 'Bornage' } })).toBe('OTHER');
    expect(code(() => resolveOperationTypeInput({ code: 'AUTRE' } as never))).toBe('UNKNOWN_TYPE');
  });
  it('indice T1 inconnu, vide ou absent → null (jamais OTHER)', () => {
    expect(normalizeOperationTypeHint('REPARATION')).toBeNull();
    expect(normalizeOperationTypeHint('')).toBeNull();
    expect(normalizeOperationTypeHint(null)).toBeNull();
    expect(normalizeOperationTypeHint(' intervention ')).toBe('INTERVENTION');
  });
});

describe('C8 / B7 transitions de statut', () => {
  it.each([
    ['ENVISAGED', 'REALIZED', 'ALLOWED'], ['ENVISAGED', 'CANCELLED', 'ALLOWED'], ['CANCELLED', 'ENVISAGED', 'ALLOWED'],
    ['CANCELLED', 'REALIZED', 'ALLOWED'], ['REALIZED', 'REALIZED', 'NOOP'], ['REALIZED', 'CANCELLED', 'STATUS_TRANSITION_FORBIDDEN'],
    ['REALIZED', 'ENVISAGED', 'STATUS_TRANSITION_FORBIDDEN'],
  ] as const)('%s → %s : %s', (de, vers, attendu) => {
    expect(code(() => checkStatusTransition(de, vers)) === 'OK' ? checkStatusTransition(de, vers) : code(() => checkStatusTransition(de, vers))).toBe(attendu);
  });
  it('F-070 : REALIZED → ENVISAGED seulement après retrait de la preuve de réalisation', () => {
    expect(checkStatusTransition('REALIZED', 'ENVISAGED', 'REALIZATION_PROOF_WITHDRAWN')).toBe('ALLOWED');
  });
});

describe('C8.1 / C13.1 parent / enfant — retiré au lot 83D (CDC v5 §6.4, §18.4, E16, AC39)', () => {
  it('plus de règle de hiérarchie : aucune Opération n’est enfant d’une autre', async () => {
    const m = await import('../model');
    expect('checkParentRelation' in m).toBe(false);
    expect('checkHierarchy' in m).toBe(false);
    expect('ALLOWED_PARENT_TYPES' in m).toBe(false);
  });
});

describe('O1-03 références métier (écart C20 — rapprochement M1)', () => {
  it('normalisation exacte : casse, accents, ponctuation ignorés ; chiffres conservés', () => {
    expect(normalizeBusinessReference('FA-2026/001')).toBe('FA2026001');
    expect(normalizeBusinessReference(' fa 2026 001 ')).toBe('FA2026001');
    expect(normalizeBusinessReference('Sinistre n° É-12')).toBe('SINISTRENE12');
    expect(normalizeBusinessReference('2026-001')).not.toBe(normalizeBusinessReference('2026-0001'));
    expect(normalizeBusinessReference('—')).toBe('');
  });
});

describe('C21.1 bus interne (décision PO Q10)', () => {
  afterEach(() => resetBusinessOperationEventBusForTests());

  it('les 7 événements du CDC, rien d’autre', () => {
    expect([...BUSINESS_OPERATION_EVENT_TYPES]).toEqual([
      'BUSINESS_OPERATION_CREATED', 'BUSINESS_OPERATION_UPDATED', 'BUSINESS_OPERATION_FINANCIAL_CHANGED',
      'BUSINESS_OPERATION_TARGET_CHANGED', 'BUSINESS_OPERATION_INVALIDATED', 'BUSINESS_OPERATION_REACTIVATED',
      'BUSINESS_OPERATION_MERGED',
    ]);
  });

  it('tampon : dédoublonné, CREATED englobe les signaux fins de la même Opération, correlation_id porté', () => {
    const b = new BusinessOperationEventBuffer('corr-1');
    b.push({ type: 'BUSINESS_OPERATION_CREATED', accountId: 1, operationId: 10 });
    b.push({ type: 'BUSINESS_OPERATION_TARGET_CHANGED', accountId: 1, operationId: 10 });
    b.push({ type: 'BUSINESS_OPERATION_UPDATED', accountId: 1, operationId: 11 });
    b.push({ type: 'BUSINESS_OPERATION_UPDATED', accountId: 1, operationId: 11 });
    b.push({ type: 'BUSINESS_OPERATION_INVALIDATED', accountId: 1, operationId: 10 });
    const e = b.drain();
    expect(e.map((x) => `${x.type}:${x.operationId}`)).toEqual([
      'BUSINESS_OPERATION_CREATED:10', 'BUSINESS_OPERATION_UPDATED:11', 'BUSINESS_OPERATION_INVALIDATED:10',
    ]);
    expect(e.every((x) => x.correlationId === 'corr-1' && typeof x.occurredAt === 'string')).toBe(true);
    expect(b.drain()).toEqual([]);
  });

  it('publication : abonnés isolés (un échec n’empêche pas les autres), compteurs, désabonnement', async () => {
    const vus: string[] = [];
    vi.spyOn(console, 'error').mockImplementation(() => {});
    subscribeBusinessOperationEvents('casse', () => { throw new Error('boom'); });
    const off = subscribeBusinessOperationEvents('ok', (e) => { vus.push(e.type); });
    const ev = { type: 'BUSINESS_OPERATION_UPDATED' as const, accountId: 1, operationId: 1, correlationId: 'c', occurredAt: 'now' };
    await expect(publishBusinessOperationEvents([ev])).resolves.toBeUndefined();
    off();
    await publishBusinessOperationEvents([ev]);
    expect(vus).toEqual(['BUSINESS_OPERATION_UPDATED']);
    expect(businessOperationEventCounters().BUSINESS_OPERATION_UPDATED).toBe(2);
  });

  it('bus distinct du catalogue fermé de l’assistant (Q10)', () => {
    const assistant = readFileSync(join(ROOT, 'src/services/verebona-assistant/events/business-events.ts'), 'utf8');
    expect(assistant).not.toMatch(/BUSINESS_OPERATION_/);
  });
});

describe('C24 verrou par compte', () => {
  it('NFR-OP-001 : comptes dédoublonnés, triés (pas d’interblocage entre transferts croisés)', () => {
    expect(lockOrder([7, 3, 7, 0, -1])).toEqual([3, 7]);
    expect(lockOrder([3, 7])).toEqual(lockOrder([7, 3]));
  });
});

// ── Gardes statiques ────────────────────────────────────────────────────────

function fichiers(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) { if (n !== 'node_modules' && n !== '__tests__') fichiers(p, out); }
    else if (/\.(ts|tsx|mjs)$/.test(n) && !/\.test\.|\.e2e\./.test(n)) out.push(p);
  }
  return out;
}

describe('gardes d’architecture', () => {
  const sources = fichiers(join(ROOT, 'src'));

  it('F-196 / INV-034 / Q8 : aucun interrupteur fonctionnel OPERATIONS_ENABLED ni équivalent', () => {
    const hits = sources.filter((f) => /OPERATIONS?_ENABLED|BUSINESS_OPERATIONS?_(ENABLED|DISABLED|SHADOW)|OPERATION_SHADOW_MODE/.test(readFileSync(f, 'utf8')));
    expect(hits.map((f) => relative(ROOT, f))).toEqual([]);
  });

  it('F-198 : `ai_operations` jamais utilisée par le domaine Opération', () => {
    const domaine = sources.filter((f) => f.includes(join('services', 'business-operations')));
    expect(domaine.length).toBeGreaterThan(4);
    for (const f of domaine) expect(readFileSync(f, 'utf8'), f).not.toMatch(/\bai_operations?\b|aiOperations?\b/);
  });

  it('ACC-018 / P09 : aucune API ni page utilisateur n’écrit les Opérations (écritures : services seulement)', () => {
    const app = sources.filter((f) => f.includes(join('src', 'app')));
    const ecrivains = app.filter((f) => /business-operations\/(write|repository)/.test(readFileSync(f, 'utf8')));
    expect(ecrivains.map((f) => relative(ROOT, f))).toEqual([]);
  });

  it('écritures branchées : Duo (déplacement accepté, départ) et suppression de bien, événements après commit', () => {
    const duo = readFileSync(join(ROOT, 'src/services/duo.service.ts'), 'utf8');
    // Lot 40 : `transferAsset` = Opérations (lot 39) + bien + données (volet B).
    expect(duo.match(/await transferAsset\(tx,/g)?.length).toBe(2);
    expect(duo).toMatch(/transferAssetOperationsInTx\([\s\S]*transferAssetDataInTx\(tx,/);
    expect(duo.match(/await publishBusinessOperationEvents\(operationEvents\);/g)?.length).toBe(2);
    const del = readFileSync(join(ROOT, 'src/services/assets/asset-deletion.service.ts'), 'utf8');
    expect(del).toMatch(/retireDeletedAssetFromOperationsInTx\(tx,/);
    expect(del.indexOf('retireDeletedAssetFromOperationsInTx(tx,')).toBeLessThan(del.indexOf('await tx.delete(assets)'));
    expect(del).toMatch(/await publishBusinessOperationEvents\(operationEvents\);\n {2}return outcome;/);
  });
});

describe('F-182 / F-183 BO Référentiels — onglet Types d’Opération (lecture seule, bureau et mobile)', async () => {
  const { buildOperationTypeReferentials } = await import('@/app/api/admin/referentials/referentials-data');

  it('7 types triés par libellé, utilisations, familles ; repli sur le code si la table manque', () => {
    const rows = buildOperationTypeReferentials(null, new Map([['CLAIM', 3]]));
    expect(rows.map((r) => r.label)).toEqual([...rows.map((r) => r.label)].sort((a, b) => a.localeCompare(b, 'fr')));
    expect(rows.length).toBe(7);
    expect(rows.find((r) => r.code === 'CLAIM')).toMatchObject({ label: 'Sinistre', usage: 3, active: true });
    expect(rows.find((r) => r.code === 'OTHER')?.details).toMatch(/Toutes les familles/);
    const base = buildOperationTypeReferentials([{ code: 'CLAIM', label: 'Sinistre', description: 'd', applicable_asset_families: ['IMMOBILIER'], active: false }], new Map());
    expect(base).toEqual([{ code: 'CLAIM', label: 'Sinistre', active: false, usage: 0, details: 'd — Familles : Immobilier' }]);
  });

  it('page : onglet présent, même tableau responsive que les autres onglets, aucune action d’édition', () => {
    const page = readFileSync(join(ROOT, 'src/app/admin/referentials/page.tsx'), 'utf8');
    expect(page).toMatch(/key: 'operation-types', label: 'Types d’Opération'/);
    expect(page).toMatch(/case 'operation-types': return <RowsTable rows=\{data\.operationTypes \?\? \[\]\} withStatus wrapDetails/);
    expect(page).toMatch(/overflow-x-auto/);
    expect(page).toMatch(/flex flex-wrap gap-1 border-b/);
    expect(page).not.toMatch(/method: '(POST|PUT|PATCH|DELETE)'/);
  });
});
