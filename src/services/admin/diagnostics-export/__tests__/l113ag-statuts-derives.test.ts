/**
 * Lot 113AG (#734) — statuts des fichiers DÉRIVÉS et du journal T3 (purs,
 * sans base) : un texte lisible n'est jamais meilleur que son JSON source ;
 * une lecture T3 en échec n'est jamais une liste vide.
 */
import { describe, expect, it, vi } from 'vitest';
import { derivedFileResult, derivedHeader, sqlIncidentView } from '../collect';
import { incidentLabel, type SqlIncident } from '@/services/admin/account-data/session';

vi.mock('@/lib/runtime-identity', () => ({ getBuildIdentity: () => ({ commit: 'abc', commitSource: 'test' }) }));

describe('L113AG — fichiers dérivés', () => {
  it('source COMPLETE → texte COMPLETE ; PARTIAL → PARTIAL ; FAILED → FAILED ; source absente ou texte non produit → FAILED', () => {
    expect(derivedFileResult('ia/t1.json', { status: 'COMPLETE', error: null }, true)).toEqual({ expected: 1, count: 1, batches: 1, error: null });
    expect(derivedFileResult('ia/t1.json', { status: 'PARTIAL', error: '1 lecture' }, true)).toMatchObject({ status: 'PARTIAL', error: expect.stringContaining('ia/t1.json : PARTIAL — 1 lecture') });
    expect(derivedFileResult('ia/t1.json', { status: 'FAILED', error: 'migrations : 25P02' }, true)).toMatchObject({ status: 'FAILED', count: 1 });
    expect(derivedFileResult('ia/t1.json', undefined, true)).toMatchObject({ status: 'FAILED' });
    expect(derivedFileResult('ia/t1.json', { status: 'COMPLETE', error: null }, false)).toMatchObject({ status: 'FAILED', count: 0 });
  });

  it('en-tête de qualification : absent si la source est COMPLETE, explicite sinon', () => {
    expect(derivedHeader('ia/t1.json', { status: 'COMPLETE', error: null })).toBe('');
    expect(derivedHeader('ia/t1.json', { status: 'FAILED', error: 'x' })).toMatch(/^ATTENTION — FICHIER SOURCE ia\/t1\.json : FAILED — x\n.*PAS complet/);
  });

  it('vue d’une erreur SQL : aucun paramètre, libellé avec ordre, code, fichier, horodatage', () => {
    const i: SqlIncident = {
      seq: 3, at: '2026-11-10T15:36:05.000Z', sqlstate: '3B001', message: 'savepoint "vb_sp_2" does not exist', kind: 'RELEASE_FAILED', statement: 'RELEASE SAVEPOINT vb_sp_2',
      phase: 'EXTRACTION', file: 'ia/t3-rattachement-documents.json', generationId: 'g', caller: 'accountDocuments (diagnostic.ts:1:1)', stack: ['a'], savepoint: 'vb_sp_2', recovered: false, consequenceOf: null,
    };
    expect(sqlIncidentView(i)).toEqual({ ...i });
    expect(incidentLabel(i)).toBe('n°3 3B001 « savepoint "vb_sp_2" does not exist » (fichier ia/t3-rattachement-documents.json) [accountDocuments (diagnostic.ts:1:1)] à 2026-11-10T15:36:05.000Z');
  });
});

describe('L113AG — journal T3 : lecture en échec ≠ aucun résultat', () => {
  const ROWS = [{ id: 11, title: 'Facture', document_type_code: 'FACTURE', supplier_name: null, primary_ids: [], user_decided: false, status: null }];
  const fakeQ = (fail: RegExp | null) => async (sql: string): Promise<Array<Record<string, unknown>>> => {
    if (fail && fail.test(sql)) throw Object.assign(new Error('division by zero'), { code: '22012' });
    if (/FROM asset_files f\s+JOIN document_extractions/.test(sql)) return ROWS;
    if (/to_regclass\('document_identity_groups'\)/.test(sql)) return [{ m0995: true, m1060: true }];
    if (/FROM ai_job_queue/.test(sql)) return [{ target_id: '11', id: 5, status: 'done', attempts: 1 }];
    return [];
  };

  it('sans panne : COMPLETE, aucune erreur ; panne d’une lecture : PARTIAL, erreur avec SQLSTATE, document marqué « non lu »', async () => {
    const { t3DocumentAssetDiagnostic, t3DiagnosticText } = await import('@/services/ai/reconciliation/document-asset/diagnostic');
    const ok = await t3DocumentAssetDiagnostic(fakeQ(null), [7], { prompt: null });
    expect(ok.status).toBe('COMPLETE');
    expect(ok.errors).toEqual([]);
    expect(ok.accounts[0].documents![0].unread).toBeUndefined();
    expect(t3DiagnosticText(ok)).toContain('STATUT DES LECTURES : complet');

    const ko = await t3DocumentAssetDiagnostic(fakeQ(/FROM document_identity_groups WHERE account_id/), [7], { prompt: null });
    expect(ko.status).toBe('PARTIAL');
    expect(ko.errors).toEqual([{ read: 'groupes d’identité (document_identity_groups)', accountId: 7, sqlstate: '22012', message: 'division by zero' }]);
    expect(ko.accounts[0].readErrors).toHaveLength(1);
    expect(ko.accounts[0].documents![0]).toMatchObject({ job: { id: 5 }, unread: ['groups'] });
    expect(t3DiagnosticText(ko)).toMatch(/STATUT DES LECTURES : PARTIEL — 1 lecture\(s\) en échec[\s\S]*groupes d’identité \(document_identity_groups\) \(compte 7\) : 22012/);
  });

  it('migrations illisibles : null + erreur (jamais « absentes ») ; session interrompue : arrêt (relancée)', async () => {
    const { t3DocumentAssetDiagnostic } = await import('@/services/ai/reconciliation/document-asset/diagnostic');
    const d = await t3DocumentAssetDiagnostic(fakeQ(/to_regclass\('document_identity_groups'\)/), [7], { prompt: null });
    expect(d.configuration.migrations).toBeNull();
    expect(d.checks.find((c) => c.code === 'MIGRATION_0995')).toMatchObject({ ok: null, actual: 'illisible' });
    expect(d.status).toBe('PARTIAL');
    const broken = async () => { throw Object.assign(new Error('session de lecture interrompue'), { code: 'VB_SESSION_BROKEN' }); };
    await expect(t3DocumentAssetDiagnostic(broken, [7], { prompt: null })).rejects.toMatchObject({ code: 'VB_SESSION_BROKEN' });
  });
});
