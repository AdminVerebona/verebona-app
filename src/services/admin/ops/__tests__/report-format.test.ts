/**
 * Synthèses lisibles des rattrapages (lot 25, chantier B) : compteurs, cas
 * ambigus, conflits, identifiant d'exécution du script (restauration) ;
 * rapport JSON borné ; nom de fichier sûr (Windows).
 */
import { describe, it, expect } from 'vitest';
import { boundReport, reportFileName, summarizeBackfill, SAMPLE_LIMIT } from '../backfill/report-format';
import { validateBackfillRequest } from '../backfill/definitions';

const RUN = '22222222-2222-4222-8222-222222222222';

describe('summarizeBackfill', () => {
  it('fusion des pièces (application) : décisions, conflits, ambigus, restaurable', () => {
    const s = summarizeBackfill('merge-rooms', 'apply', null, {
      result: {
        runId: RUN, mode: 'apply', counts: { rooms: 3, failed: 0, existing: 1, reenqueued: 1 }, warnings: ['homonymes'],
        changes: [
          { roomId: 1, accountId: 1, assetId: 1, decision: 'CREATED', table: 'substructures', rowId: '9', column: '*', oldValue: null, newValue: {} },
          { roomId: 2, accountId: 1, assetId: 1, decision: 'CONFLICT', table: 'asset_files', rowId: '4', column: 'substructure_id', oldValue: 1, newValue: 2, reason: 'DIFFERENT_SUBSTRUCTURE' },
          { roomId: 3, accountId: 1, assetId: 1, decision: 'SUPERSEDED', table: 'to_process_actions', rowId: '5', column: 'status', oldValue: 'a', newValue: 'b' },
        ],
      },
      scriptSummary: { byDecision: [{ decision: 'CREATED', table: 'substructures', n: 1 }, { decision: 'CONFLICT', table: 'asset_files', n: 1 }] },
      scriptText: 'Exécution …',
    });
    expect(s.scriptRunId).toBe(RUN);
    expect(s.restorable).toBe(true);
    expect(s.headline).toContain('3 pièce(s)');
    expect(s.counters).toEqual(expect.arrayContaining([{ label: 'Pièces parcourues', value: 3 }, { label: 'Décision CREATED', value: 1 }]));
    expect(s.conflicts).toEqual({ count: 1, samples: ['pièce 2 — asset_files#4 substructure_id (DIFFERENT_SUBSTRUCTURE)'] });
    expect(s.ambiguous.count).toBe(1);
    expect(s.warnings).toEqual(['homonymes']);
    expect(s.text).toBe('Exécution …');
  });

  it('simulation : non restaurable ; restauration : conflits listés', () => {
    expect(summarizeBackfill('merge-rooms', 'simulate', null, { result: { runId: RUN, mode: 'dry_run', counts: { rooms: 0, failed: 0 }, changes: [], warnings: [] } }).restorable).toBe(false);
    const r = summarizeBackfill('cdc15', 'restore', null, {
      result: { runId: RUN, restored: 4, conflicts: [{ targetType: 'asset_kc', targetId: 3, name: 'surface' }] },
    });
    expect(r).toMatchObject({ scriptRunId: RUN, restorable: false, conflicts: { count: 1, samples: ['asset_kc#3 — surface'] } });
  });

  it('liens document ↔ bien : cas ambigus échantillonnés (≤ 20), jamais tranchés', () => {
    const ambiguous = Array.from({ length: 30 }, (_, i) => ({ reason: 'TARGET_NOT_FOUND', fileId: i, detail: 'x' }));
    const s = summarizeBackfill('document-asset-links', 'apply', null, {
      result: { filesScanned: 30, proposalsScanned: 2, legacyLinksBefore: 1, legacyLinksAfter: 5, migrationLinksCreated: 3, ambiguous, lastFileId: 29, lastProposalId: 2 },
    });
    expect(s.ambiguous.count).toBe(30);
    expect(s.ambiguous.samples).toHaveLength(SAMPLE_LIMIT);
    expect(s.scriptRunId).toBeNull();
  });

  it('agenda : liens sources puis dédoublonnage (protégés = cas à examiner)', () => {
    const a = summarizeBackfill('agenda', 'simulate', 'source-links', {
      result: { scanned: 5, fileLinksCreated: 2, sourceTracesCreated: 1, orphans: [{ agendaItemId: 1, accountId: 2, originRefId: 3, reason: 'MISSING' }], applied: false, lastItemId: 5 },
    });
    expect(a.headline).toContain('(simulation)');
    expect(a.ambiguous.samples[0]).toContain('MISSING');
    const d = summarizeBackfill('agenda', 'apply', 'dedupe', {
      result: { accountsScanned: 1, itemsScanned: 4, applied: true, lastAccountId: 1, removed: [8],
        groups: [{ accountId: 1, assetId: 2, sourceFileId: 3, originFieldKey: 'k', date: '2026-01-01', keep: [7], remove: [8], protected: [9] }] },
    });
    expect(d.counters).toEqual(expect.arrayContaining([{ label: 'Éléments retirés', value: 1 }]));
    expect(d.ambiguous.count).toBe(1);
  });

  it('CDC 15 : totaux par décision, étapes, ambigus de la synthèse du script', () => {
    const s = summarizeBackfill('cdc15', 'simulate', null, {
      result: {
        runId: RUN, mode: 'dry_run', entries: [], warnings: ['w'],
        results: [
          { step: 'MIG-01', scanned: 3, counts: { APPLIED: 2, SKIPPED_USER: 0, AMBIGUOUS: 1, NO_CHANGE: 0 }, cursor: 3, cards: 0, complete: true },
          { step: 'MIG-05', scanned: 0, counts: { APPLIED: 0, SKIPPED_USER: 0, AMBIGUOUS: 0, NO_CHANGE: 0 }, cursor: 0, cards: 0, complete: true, skipped: 'filtre compte' },
        ],
      },
      scriptSummary: { run: {}, byStep: [], samples: [{ step: 'MIG-01', decision: 'AMBIGUOUS', reason: 'CONFLICT', accountId: 1, assetId: 2, entityType: 'asset', entityId: '2', fieldKey: 'surface', before: 1, after: 2 }] },
    });
    expect(s.headline).toContain('1 ambiguë(s)');
    expect(s.counters).toEqual(expect.arrayContaining([{ label: 'MIG-05', value: 'ignorée (filtre compte)' }, { label: 'Ambigu', value: 1 }]));
    expect(s.ambiguous.samples[0]).toContain('surface — CONFLICT');
    expect(s.restorable).toBe(false);
  });
});

describe('rapport JSON et nom de fichier', () => {
  it('tableaux bornés et signalés, dates en ISO', () => {
    const b = boundReport({ xs: [1, 2, 3, 4], d: new Date('2026-10-05T10:00:00Z') }, 2) as { xs: unknown[]; d: string };
    expect(b.xs).toEqual([1, 2, expect.stringContaining('tronqué : 2')]);
    expect(b.d).toBe('2026-10-05T10:00:00.000Z');
  });

  it('nom sans « : » ni espace (Windows)', () => {
    const n = reportFileName('agenda', 'simulate', 'source-links', '2026-10-05T10:11:12Z', RUN);
    expect(n).toBe('rattrapage_agenda_source-links_simulate_2026-10-05-10-11-12_22222222.json');
    expect(n).not.toMatch(/[:\s\\/]/);
  });
});

describe('validateBackfillRequest', () => {
  it('motif obligatoire pour appliquer / restaurer, pas pour simuler ; restauration : runId UUID', () => {
    expect(validateBackfillRequest({ script: 'cdc15', action: 'simulate' })).toMatchObject({ ok: true });
    expect(validateBackfillRequest({ script: 'cdc15', action: 'apply', reason: 'abc' })).toMatchObject({ ok: false, code: 'REASON_REQUIRED' });
    expect(validateBackfillRequest({ script: 'cdc15', action: 'restore', reason: 'retour arrière', runId: 'x' })).toMatchObject({ ok: false, code: 'INVALID_RUN_ID' });
    expect(validateBackfillRequest({ script: 'cdc15', action: 'restore', reason: 'retour arrière', runId: RUN })).toMatchObject({ ok: true, value: { runId: RUN } });
    expect(validateBackfillRequest({ script: 'agenda', action: 'apply', reason: 'motif ok', step: 'autre' })).toMatchObject({ ok: false, code: 'INVALID_STEP' });
    expect(validateBackfillRequest({ script: 'agenda', action: 'apply', reason: 'motif ok', step: 'dedupe', accountId: 3 })).toMatchObject({ ok: false, code: 'ACCOUNT_FILTER_NOT_SUPPORTED' });
    expect(validateBackfillRequest({ script: 'merge-rooms', action: 'simulate', accountId: '12' })).toMatchObject({ ok: true, value: { accountId: 12 } });
  });
});
