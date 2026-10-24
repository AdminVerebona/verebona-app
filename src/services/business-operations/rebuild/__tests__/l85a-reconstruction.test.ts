/**
 * Lot 85A — CDC « Opérations, Agenda, Timeline, Sinistres v5 », lots O-2
 * (purge et reconstruction en préproduction, §20, AC41–AC43, E20) et O-9
 * (TCO sur le nouveau modèle, §19, AC40, AC51, E19, E30). Règles PURES.
 *
 *   L85A-U01  conservation : motifs propres (gestes, sources, décisions de
 *             l'utilisateur…) et fermeture (fusion, contrat d'assurance,
 *             ancien lien parent, décision TCO sans identité stable)
 *   L85A-U02  O-9 : clé `o:` d'une décision TCO → clé stable `s:`
 *   L85A-U03  O-9 : clé de ligne `s:` (source reproductible), `o:` et prix de
 *             la fiche en clés secondaires ; une décision SUIT le fait quand
 *             il change de ligne ; décision antérieure (`o:`) toujours appliquée
 *   L85A-U04  gardes d'un compte (non éligible, à jour, occupé) dans l'ordre
 *   L85A-U05  AC43 : signature métier sans identifiant, indépendante de l'ordre
 *   L85A-U06  données de l'utilisateur : toute baisse est signalée
 *   L85A-U07  moteur des rattrapages : bloc 14 (Simuler / Appliquer /
 *             Restaurer, un compte ou tous, motif, préproduction)
 *   L85A-U08  rapport lisible (simulation, application, restauration)
 *   L85A-U09  périmètre de l'image avant (ordre des clés étrangères), tables
 *             du journal classées (recette 82E, restauration de la base),
 *             migration 0700 idempotente, sans colonne bien / document
 *   L85A-U10  empreintes : tables modifiées, empreinte globale stable
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  REBUILD_SCOPE, canonicalBusinessSignature, computeKeepSet, deletionOrder, ownKeepReasons, parseLegacyOperationKey, preflightStatus,
  stableDecisionKey, userDataLosses, type OperationFlags, type SignatureOperation, type UserDataCounts,
} from '../model';
import { changedTables, combineHashes } from '../snapshot';
import { applyTcoUserDecisions, tcoLineKeys, tcoSourceIdentity, type TcoUserDecision } from '../../tco/user-decisions';
import type { TcoEconomicLine } from '../../tco/model';

const ROOT = process.cwd();
const lire = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const op = (id: number, over: Partial<OperationFlags> = {}): OperationFlags => ({
  id, invalidated: false, mergedInto: null, userHistory: false, userSource: false, userDecision: false, exclusion: false, suppression: false,
  userAgendaRole: false, userDocument: false, claimDamages: false, legacyClaim: false, insuranceContract: null, legacyParent: null, ...over,
});

describe('L85A-U01 — Opérations conservées : tout ce que l’utilisateur a touché, et leurs dépendances', () => {
  it('motifs propres : gestes, sources, décisions, exclusions, suppressions, rôle d’agenda, document, dommages, ancien modèle', () => {
    expect(ownKeepReasons(op(1))).toEqual([]);
    expect(ownKeepReasons(op(1, { userHistory: true, userSource: true, userDecision: true, exclusion: true, suppression: true, userAgendaRole: true, userDocument: true, claimDamages: true, legacyClaim: true })))
      .toEqual(['USER_GESTURE', 'USER_SOURCE', 'USER_DECISION', 'ASSET_EXCLUSION', 'PROJECTION_SUPPRESSED', 'USER_AGENDA_ROLE', 'USER_DOCUMENT', 'CLAIM_DATA', 'LEGACY_CLAIM']);
  });
  it('purgeable seulement si rien n’est de l’utilisateur ; une Opération invalidée ou fusionnée dérivée est purgée', () => {
    const k = computeKeepSet([op(1), op(2, { invalidated: true }), op(3, { invalidated: true, mergedInto: 4 }), op(4)]);
    expect([...k.keys()]).toEqual([]);
  });
  it('fermeture : la cible de fusion et le contrat d’assurance d’une Opération conservée sont conservés (aucune clé étrangère orpheline)', () => {
    const k = computeKeepSet([
      op(1, { userDecision: true, invalidated: true, mergedInto: 2 }), op(2, { mergedInto: null }),
      op(3, { userSource: true, insuranceContract: 5 }), op(5, { invalidated: true, mergedInto: 6 }), op(6), op(7),
    ]);
    expect([...k.keys()].sort()).toEqual([1, 2, 3, 5, 6]);
    expect(k.get(2)).toEqual(['LINKED']);
    expect(k.get(6)).toEqual(['LINKED']);
    expect(k.has(7)).toBe(false);
  });
  it('ancien lien parent / enfant (avant 84A) : les deux bouts conservés ; décision TCO sans identité stable : Opération conservée', () => {
    const k = computeKeepSet([op(1, { legacyParent: 2 }), op(2), op(3)], new Map([[3, 'TCO_DECISION' as const]]));
    expect(k.get(1)).toEqual(['LEGACY_CLAIM']);
    expect(k.get(2)).toEqual(['LEGACY_CLAIM']);
    expect(k.get(3)).toEqual(['TCO_DECISION']);
  });
});

describe('L85A-U02 — O-9 : décision TCO à clé `o:` d’une Opération purgée → clé stable', () => {
  it('lecture de la clé et nouvelle clé `s:` (même forme que la ligne)', () => {
    expect(parseLegacyOperationKey('o:42:REALIZED_COST:1450000:EUR')).toEqual({ operationId: 42, fact: 'REALIZED_COST:1450000:EUR', kind: 'REALIZED_COST', amountMinor: 1450000, currency: 'EUR' });
    expect(parseLegacyOperationKey('f:12:REALIZED_COST:5:EUR')).toBeNull();
    expect(parseLegacyOperationKey('o:x:REALIZED_COST:5:EUR')).toBeNull();
    expect(stableDecisionKey(['AGENDA:9', 'ASSET_DATA:3:ACQUISITION'], 'REALIZED_COST:1450000:EUR')).toBe('s:AGENDA:9:REALIZED_COST:1450000:EUR');
    expect(stableDecisionKey([], 'REALIZED_COST:1:EUR')).toBeNull();
  });
  it('identité de source : seulement les sources reproductibles (fiche, équipement, agenda)', () => {
    expect(tcoSourceIdentity('ASSET_DATA', '3', 'ACQUISITION')).toBe('ASSET_DATA:3:ACQUISITION');
    expect(tcoSourceIdentity('AGENDA', '9', null)).toBe('AGENDA:9');
    expect(tcoSourceIdentity('CLAIM_FORM', '3', null)).toBeNull();
    expect(tcoSourceIdentity('DOCUMENT', '3', null)).toBeNull();
  });
});

const ligne = (over: Partial<TcoEconomicLine>): TcoEconomicLine => ({
  id: 'c:1', source: 'OPERATION', provenance: 'T3', label: 'x', kind: 'REALIZED_COST', amountMinor: 1450000, currency: 'EUR', eurCents: 1450000,
  includedCents: 1450000, category: 'ACQUISITION', date: '2012-09-01', fileId: null, operationId: 7, operationLabel: 'Acquisition',
  status: 'RETAINED_CONSOLIDATED', reason: null, note: null, relatedFileId: null, ...over,
} as TcoEconomicLine);

describe('L85A-U03 — O-9 : clés stables qui survivent à la reconstruction, décisions jamais perdues', () => {
  it('composante sans justificatif portée par la fiche : clé `s:` principale ; `o:` (décisions antérieures) et prix de la fiche secondaires', () => {
    const k = tcoLineKeys(ligne({ sourceIdentities: ['ASSET_DATA:3:ACQUISITION'] }));
    expect(k.primary).toBe('s:ASSET_DATA:3:ACQUISITION:REALIZED_COST:1450000:EUR');
    expect(k.secondary).toEqual(['o:7:REALIZED_COST:1450000:EUR', 'asset:3:acquisitionPrice']);
    // Inchangé : composante sans source reproductible (sinistre saisi…) → `o:` ; justificatif → `f:`.
    expect(tcoLineKeys(ligne({ kind: 'INDEMNITY' }))).toEqual({ primary: 'o:7:INDEMNITY:1450000:EUR', secondary: [] });
    expect(tcoLineKeys(ligne({ sourceFileIds: [12], fileId: 12 })).primary).toBe('f:12:REALIZED_COST:1450000:EUR');
    // Même fait après reconstruction (autre Opération) : même clé principale.
    expect(tcoLineKeys(ligne({ operationId: 99, id: 'c:55', sourceIdentities: ['ASSET_DATA:3:ACQUISITION'] })).primary).toBe(k.primary);
  });
  const decision = (key: string, d: 'INCLUDE' | 'EXCLUDE' = 'EXCLUDE'): TcoUserDecision => ({ key, decision: d, decidedAt: '2026-10-01T10:00:00Z', decidedByUserId: 1 });
  const appliquer = (lines: TcoEconomicLine[], decisions: TcoUserDecision[]) => {
    const entries = lines.map((l) => ({ componentId: 0, operationId: 0, kind: l.kind!, effect: 'COST' as const, amountMinor: l.amountMinor, currency: l.currency, eurMinor: l.eurCents, includedEurMinor: l.includedCents, included: l.includedCents > 0, exclusion: null, attribution: 'IN' as const, date: l.date, prorata: null, category: l.category, lineId: l.id }));
    return applyTcoUserDecisions({ lines, entries: entries as never, decisions, operationCategory: new Map(), warnings: new Set() });
  };
  it('décision antérieure sur la clé `o:` : toujours appliquée (clé secondaire)', () => {
    const l = ligne({ sourceIdentities: ['ASSET_DATA:3:ACQUISITION'] });
    const r = appliquer([l], [decision('o:7:REALIZED_COST:1450000:EUR')]);
    expect(r.applied).toBe(1);
    expect(l.status).toBe('EXCLUDED');
  });
  it('le fait change de ligne (prix de la fiche repris par une Opération) : la décision de la fiche SUIT le fait', () => {
    const fiche = ligne({ id: 'asset:3:acquisitionPrice', source: 'ASSET_DATA', operationId: null, status: 'CONSOLIDATED_ELSEWHERE', reason: 'ASSET_PRICE_CONSOLIDATED', includedCents: 0 });
    const opLigne = ligne({ sourceIdentities: ['ASSET_DATA:3:ACQUISITION'] });
    const r = appliquer([fiche, opLigne], [decision('asset:3:acquisitionPrice')]);
    expect(r.applied).toBe(1);
    expect(opLigne.status).toBe('EXCLUDED');
    expect(opLigne.userDecision?.key).toBe('asset:3:acquisitionPrice');
    expect(r.orphans).toEqual([]);
    // Ligne principale encore retenue : comportement inchangé (la décision ne vise qu'elle).
    const f2 = ligne({ id: 'asset:3:acquisitionPrice', source: 'ASSET_DATA', operationId: null });
    const o2 = ligne({ sourceIdentities: ['ASSET_DATA:3:ACQUISITION'], status: 'CONSOLIDATED_ELSEWHERE', includedCents: 0 });
    appliquer([f2, o2], [decision('asset:3:acquisitionPrice')]);
    expect(f2.status).toBe('EXCLUDED');
    expect(o2.userDecision).toBeUndefined();
  });
});

describe('L85A-U04 — gardes d’un compte, dans l’ordre', () => {
  it('non éligible > à jour > occupé (application seulement) > à reconstruire', () => {
    expect(preflightStatus({ eligible: false, busy: true, upToDate: true, mode: 'APPLY' })).toBe('INELIGIBLE');
    expect(preflightStatus({ eligible: true, busy: true, upToDate: true, mode: 'APPLY' })).toBe('UP_TO_DATE');
    expect(preflightStatus({ eligible: true, busy: true, upToDate: false, mode: 'APPLY' })).toBe('BUSY');
    expect(preflightStatus({ eligible: true, busy: true, upToDate: false, mode: 'SIMULATE' })).toBeNull();
    expect(preflightStatus({ eligible: true, busy: false, upToDate: false, mode: 'APPLY' })).toBeNull();
  });
});

describe('L85A-U05 — AC43 : signature métier sans identifiant technique', () => {
  const o = (over: Partial<SignatureOperation> = {}): SignatureOperation => ({
    type: 'INTERVENTION', status: 'REALIZED', realizedDate: '2026-03-12', plannedDate: null, startDate: null, endDate: null, provider: 'Chauffage Plus',
    documents: [3, 1], assets: [2], equipments: [], rooms: [], components: [{ kind: 'REALIZED_COST', amountMinor: 120000, currency: 'EUR', date: null, periodStart: null, periodEnd: null }],
    agenda: [{ title: 'Intervention', date: '2026-03-12', role: 'PRINCIPAL', automatic: true }], ...over,
  });
  it('indépendante de l’ordre des Opérations, des documents et des composantes ; sensible au regroupement', () => {
    const a = canonicalBusinessSignature([o(), o({ type: 'CONTRACT', documents: [9] })]);
    const b = canonicalBusinessSignature([o({ type: 'CONTRACT', documents: [9] }), o({ documents: [1, 3] })]);
    expect(a).toBe(b);
    expect(canonicalBusinessSignature([o({ documents: [1] }), o({ documents: [3] })])).not.toBe(canonicalBusinessSignature([o({ documents: [1, 3] })]));
  });
});

describe('L85A-U06 — données de l’utilisateur : aucune perte tolérée', () => {
  const z: UserDataCounts = { agendaUserItems: 2, agendaModifiedItems: 1, manualDocumentLinks: 1, decisions: 3, exclusions: 0, suppressions: 1, userDates: 1, tcoDecisions: 2 };
  it('toute baisse est une perte signalée ; une hausse n’en est pas une', () => {
    expect(userDataLosses(z, { ...z, decisions: 4 })).toEqual([]);
    expect(userDataLosses(z, { ...z, manualDocumentLinks: 0, tcoDecisions: 1 })).toEqual(['Liens manuels document ↔ agenda : 1 → 0', 'Décisions TCO : 2 → 1']);
  });
});

describe('L85A-U07 — BO › Exploitation › Rattrapages : bloc « Opérations v5 : purge et reconstruction »', () => {
  it('moteur existant : Simuler / Appliquer / Restaurer, un compte ou tous, motif obligatoire pour écrire', async () => {
    const { BACKFILL_DEFINITIONS, validateBackfillRequest } = await import('@/services/admin/ops/backfill/definitions');
    const def = BACKFILL_DEFINITIONS.find((x) => x.script === 'operations-v5-rebuild')!;
    expect(def).toMatchObject({ order: 14, actions: ['simulate', 'apply', 'restore'], accountFilter: true });
    expect(def.label).toMatch(/préproduction/);
    expect(def.description).toMatch(/aucune nouvelle analyse/i);
    expect(def.description).toMatch(/REFUSÉ sans point de restauration de moins de 24 h/);
    expect(def.warning).toMatch(/point de restauration/);
    expect(new Set(BACKFILL_DEFINITIONS.map((d) => d.order)).size).toBe(BACKFILL_DEFINITIONS.length);
    expect(validateBackfillRequest({ script: 'operations-v5-rebuild', action: 'simulate', accountId: 12 })).toMatchObject({ ok: true, value: { accountId: 12, reason: null } });
    expect(validateBackfillRequest({ script: 'operations-v5-rebuild', action: 'apply' })).toMatchObject({ ok: false, code: 'REASON_REQUIRED' });
    expect(validateBackfillRequest({ script: 'operations-v5-rebuild', action: 'restore', reason: 'retour arrière' })).toMatchObject({ ok: false, code: 'INVALID_RUN_ID' });
    expect(validateBackfillRequest({ script: 'operations-v5-rebuild', action: 'restore', reason: 'retour arrière', runId: '6f1d2c3b-1a2b-4c3d-8e9f-0a1b2c3d4e5f', accountId: 3 }))
      .toMatchObject({ ok: false, code: 'ACCOUNT_FILTER_NOT_SUPPORTED' });
    // Exécutant : même service pour simuler, appliquer et restaurer ; refus sans écriture (code RESTORE_POINT_REQUIRED).
    const ex = lire('src/services/admin/ops/backfill/executors.ts');
    expect(ex).toMatch(/case 'operations-v5-rebuild'[\s\S]*restoreOperationsRebuild[\s\S]*runOperationsRebuild[\s\S]*RESTORE_POINT_REQUIRED/);
  });
});

describe('L85A-U08 — rapport lisible', () => {
  it('simulation, application, restauration', async () => {
    const { summarizeBackfill } = await import('@/services/admin/ops/backfill/report-format');
    const plan = {
      operations: { total: 5, active: 4, invalidated: 1, merged: 0 }, purged: [1, 2, 3], kept: [{ id: 4, reasons: ['USER_DECISION'] }], keptByReason: { USER_DECISION: 1 },
      projectionsRemoved: [10], itemsDetached: 1, principalProvenancesRemoved: 1, principalLinksDeleted: 0, cardsClosed: [], candidatesRequeued: 6, documents: 5,
      agendaSourceItems: [], tcoDecisionsRekeyed: [], tcoDecisionsMerged: 0,
      userData: { agendaUserItems: 1, agendaModifiedItems: 0, manualDocumentLinks: 0, decisions: 1, exclusions: 0, suppressions: 0, userDates: 0, tcoDecisions: 0 },
    };
    const base = { runId: 'r1', restorePoint: null, version: 'l85a-v1', excluded: [{ accountId: 9, reason: 'TRIAL_EXPIRED' }], coherence: { requested: false, campaignId: null, accounts: [] }, refusal: null };
    const sim = summarizeBackfill('operations-v5-rebuild', 'simulate', null, { result: {
      ...base, mode: 'SIMULATE', status: 'succeeded', accounts: [{ accountId: 3, status: 'PLANNED', plan, warnings: [], durationMs: 1 }],
      counters: { accounts: 1, excluded: 1, status_PLANNED: 1, operationsPurged: 3, operationsKept: 1, projectionsRemoved: 1, candidatesRequeued: 6 },
    } });
    expect(sim.headline).toBe('Simulation : 1 compte(s) examiné(s), 1 exclu(s) (non actifs) — 3 Opération(s) à purger, 1 conservée(s) (gestes de l’utilisateur).');
    expect(sim.restorable).toBe(false);
    expect(sim.counters).toEqual(expect.arrayContaining([{ label: '  dont : décision de l’utilisateur (rattaché, refusé, dissocié, événement de référence)', value: 1 }]));
    expect(sim.warnings).toEqual(expect.arrayContaining(['Compte 9 exclu : TRIAL_EXPIRED']));
    const app = summarizeBackfill('operations-v5-rebuild', 'apply', null, { result: {
      ...base, mode: 'APPLY', status: 'succeeded', restorePoint: { backupId: 'bk', finishedAt: null }, coherence: { requested: true, campaignId: 7, accounts: [3] },
      accounts: [{ accountId: 3, status: 'REBUILT', plan, warnings: [], durationMs: 1, operations: { before: 4, after: 4 }, tco: { before: { assets: [] }, after: { assets: [] }, differences: [] }, signature: { before: 'a', after: 'a', identical: true } }],
      counters: { accounts: 1, excluded: 1, status_REBUILT: 1, operationsPurged: 3, operationsKept: 1, m3Calls: 2, t1Calls: 0 },
    } });
    expect(app.restorable).toBe(true);
    expect(app.scriptRunId).toBe('r1');
    expect(app.headline).toMatch(/1 compte\(s\) reconstruit\(s\).*restaurable par r1/);
    expect(app.warnings[0]).toMatch(/Compte 3 — reconstruit : 4 Opération\(s\) active\(s\) avant, 4 après.*TCO identique ; résultat métier inchangé/);
    const res = summarizeBackfill('operations-v5-rebuild', 'restore', null, { result: { runId: 'r1', restoreRunId: 'r2', restored: [{ accountId: 3, writes: 12 }], refused: [], conflicts: [] } });
    expect(res).toMatchObject({ scriptRunId: 'r2', restorable: false });
    expect(res.headline).toBe('Restauration de r1 : 1 compte(s) remis exactement à leur état d’avant, 0 refusé(s).');
  });
});

describe('L85A-U09 — périmètre de l’image avant, journal classé, migration', () => {
  it('ordre des clés étrangères : parents avant enfants ; suppression dans l’ordre inverse ; aucune table de journal', () => {
    const t = REBUILD_SCOPE.map((s) => s.table);
    const avant = (a: string, b: string) => expect(t.indexOf(a), `${a} avant ${b}`).toBeLessThan(t.indexOf(b));
    avant('business_operations', 'business_operation_sources');
    avant('business_operation_financial_components', 'business_operation_financial_component_sources');
    avant('business_operation_sources', 'business_operation_financial_component_sources');
    avant('business_operation_claim_damages', 'business_operation_claim_damage_photos');
    avant('business_operations', 'agenda_items');
    avant('agenda_items', 'agenda_file_links');
    avant('to_process_actions', 'to_process_action_events');
    expect(deletionOrder(REBUILD_SCOPE)[0].table).toBe(t[t.length - 1]);
    expect(t.filter((x) => /targeted_runs|reprise_runs|cleanup|operations_rebuild|coherence|^ai_|ops_backfill/.test(x))).toEqual([]);
    expect(new Set(t).size).toBe(t.length);
    for (const s of REBUILD_SCOPE) expect(s.filter, s.table).toMatch(/\$1/);
  });
  it('tables du journal : classées pour l’export de recette (82E), conservées par une restauration de la base', async () => {
    const { RECETTE_TABLES } = await import('@/services/admin/diagnostics-export/recette-catalog');
    const { RESTORE_KEEP_CURRENT_TABLES } = await import('@/services/backup/schema-signature');
    for (const x of ['operations_rebuild_runs', 'operations_rebuild_accounts', 'operations_rebuild_snapshots']) {
      expect(RECETTE_TABLES[x]?.domain).toBe('operations');
      expect(RESTORE_KEEP_CURRENT_TABLES).toContain(x);
    }
  });
  it('migration 0700 (numéros réservés 0700-0703) : idempotente, journal seulement, sans colonne bien / document (transfert Duo sans objet)', () => {
    const fichiers = readdirSync(join(ROOT, 'src/db/migrations')).filter((f) => /^070[0-3]_/.test(f));
    expect(fichiers.sort()).toEqual(['0700_l85a_operations_reconstruction.sql', '0700_l85a_operations_reconstruction_idx_1.sql']);
    const m = lire('src/db/migrations/0700_l85a_operations_reconstruction.sql');
    const code = m.replace(/^--.*$/gm, '');
    expect(code.match(/CREATE TABLE IF NOT EXISTS (\w+)/g)).toEqual([
      'CREATE TABLE IF NOT EXISTS operations_rebuild_runs', 'CREATE TABLE IF NOT EXISTS operations_rebuild_accounts', 'CREATE TABLE IF NOT EXISTS operations_rebuild_snapshots']);
    expect(code).not.toMatch(/\b(DROP|TRUNCATE|ALTER TABLE|UPDATE)\b|DELETE FROM/);
    expect(code).not.toMatch(/\b(asset_id|file_id|asset_file_id|document_id|source_file_id)\b/);
    expect(lire('src/db/migrations/0700_l85a_operations_reconstruction_idx_1.sql')).toMatch(/CREATE INDEX CONCURRENTLY IF NOT EXISTS/);
  });
});

describe('L85A-U10 — empreintes', () => {
  it('tables modifiées et empreinte globale indépendante de l’ordre des tables', () => {
    const a = { t1: { rows: 1, hash: 'x' }, t2: { rows: 2, hash: 'y' } };
    expect(combineHashes(a)).toBe(combineHashes({ t2: a.t2, t1: a.t1 }));
    expect(combineHashes(a)).not.toBe(combineHashes({ ...a, t2: { rows: 3, hash: 'y' } }));
    expect(changedTables(a, { t1: a.t1, t2: { rows: 2, hash: 'z' }, t3: { rows: 0, hash: '' } })).toEqual(['t2', 't3']);
  });
});
