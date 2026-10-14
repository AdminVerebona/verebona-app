/**
 * Lot 53 (53B) — retour PO D23 : inventaire qualifié et correction contrôlée
 * des relations intercomptes (contrôles purs ; base réelle :
 * `src/test/e2e/scenarios/l53b-d23-intercomptes.e2e.ts`).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { CROSS_ACCOUNT_CHECKS } from '../cross-account/detection';
import { REMEDIATION_FAMILIES, REMEDIATION_SPECS, qualifiedSql, uncoveredChecks } from '../cross-account/remediation';
import { CATEGORY_RISKS, CHANNEL_LABELS } from '../cross-account/risk-catalog';
import { BACKFILL_DEFINITIONS, validateBackfillRequest } from '@/services/admin/ops/backfill/definitions';
import { summarizeBackfill } from '@/services/admin/ops/backfill/report-format';

/** Objets métier : jamais supprimés par la correction (seuls des liens le sont). */
const OBJETS = ['assets', 'asset_files', 'events', 'deadlines', 'suppliers', 'agenda_items', 'equipments', 'substructures', 'rooms', 'accounts', 'users'];

describe('PO-D23-01 — inventaire : chaque catégorie est qualifiée et a son traitement', () => {
  it('PO-D23-01 — mêmes catégories pour le contrôle, la qualification des risques et la correction', () => {
    expect(uncoveredChecks()).toEqual([]);
    const controle = CROSS_ACCOUNT_CHECKS.map((c) => c.code).sort();
    expect(REMEDIATION_SPECS.map((s) => s.code).sort()).toEqual(controle);
    expect(CATEGORY_RISKS.map((r) => r.code).sort()).toEqual(controle);
    for (const s of REMEDIATION_SPECS) {
      expect(CROSS_ACCOUNT_CHECKS.find((c) => c.code === s.code)?.family, s.code).toBe(s.family);
    }
    expect([...new Set(CROSS_ACCOUNT_CHECKS.map((c) => c.family))].sort()).toEqual([...REMEDIATION_FAMILIES].sort());
    // Nouvelles catégories du lot 53 : « À traiter » et journal de l'accueil.
    expect(controle).toEqual(expect.arrayContaining(['TO_PROCESS_TARGET', 'AI_FIELD_UPDATE']));
  });

  it('PO-D23-01 — qualification : canaux d’accès, garde, traitement et preuves renseignés pour chaque catégorie', () => {
    for (const r of CATEGORY_RISKS) {
      expect(r.channels.length, r.code).toBeGreaterThan(0);
      for (const ch of r.channels) {
        expect(CHANNEL_LABELS[ch.channel], `${r.code} ${ch.channel}`).toBeDefined();
        expect(ch.risk.length, r.code).toBeGreaterThan(10);
        expect(ch.guard.length, r.code).toBeGreaterThan(5);
      }
      expect(r.treatment.length, r.code).toBeGreaterThan(5);
      expect(r.proofs.length, r.code).toBeGreaterThan(0);
    }
    // Les canaux demandés par le PO sont couverts quelque part.
    const canaux = new Set(CATEGORY_RISKS.flatMap((r) => r.channels.map((c) => c.channel)));
    for (const c of ['lecture', 'ecriture', 'assistant', 'exports', 'mascotte', 'miniatures', 'agenda', 'a_traiter', 'suppression'] as const) {
      expect(canaux.has(c), c).toBe(true);
    }
  });

  it('PO-D23-01 — la correction DÉTACHE : jamais un objet métier supprimé, jamais un compte modifié', () => {
    for (const s of REMEDIATION_SPECS) {
      for (const p of s.parts) {
        if (p.mode === 'delete') expect(OBJETS, `${s.code} supprime ${p.table}`).not.toContain(p.table);
        if (p.mode === 'status') {
          expect(Object.keys(p.set ?? {}), s.code).not.toContain('account_id');
          expect(p.still, s.code).toBeTruthy();
        }
        expect(p.sql, s.code).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP)\b/);
        expect(p.sql, s.code).toMatch(/row_pk/);
        // Colonnes remises à NULL : rattachements seulement, jamais account_id.
        expect(p.sql, s.code).not.toMatch(/ARRAY\['account_id'\]/);
      }
    }
  });

  it('PO-D23-06 — Duo et comptes inconnus : qualification DUO / UNDECIDABLE dans la même requête que la correction', () => {
    const q = qualifiedSql(REMEDIATION_SPECS[0].parts[0], 42);
    expect(q).toContain('asset_move_requests');
    expect(q).toContain('duo_memberships');
    expect(q).toContain('duo_account_id');
    expect(q).toContain('x.duo_id IS NOT NULL');
    expect(q).toContain("'UNDECIDABLE'");
    expect(q).toContain('c.account_id = 42 OR c.other_account_id = 42');
    // Le partage par compte (account_memberships) n'est jamais un critère : un compte partagé n'a qu'un account_id.
    expect(q).not.toContain('account_memberships');
  });
});

describe('PO-D23-05 — correction contrôlée depuis le BO (Rattrapages)', () => {
  it('PO-D23-05 — bloc « Relations intercomptes » : une étape par famille, simuler / appliquer / restaurer, filtre compte', () => {
    const def = BACKFILL_DEFINITIONS.find((d) => d.script === 'cross-account')!;
    expect(def.actions).toEqual(['simulate', 'apply', 'restore']);
    expect(def.steps!.map((s) => s.code)).toEqual([...REMEDIATION_FAMILIES]);
    expect(def.accountFilter).toBe(true);
    expect(def.command).toMatch(/BO uniquement/);
    expect(validateBackfillRequest({ script: 'cross-account', action: 'simulate', step: 'agenda' })).toMatchObject({ ok: true });
    expect(validateBackfillRequest({ script: 'cross-account', action: 'apply', step: 'agenda' })).toMatchObject({ ok: false, code: 'REASON_REQUIRED' });
    expect(validateBackfillRequest({ script: 'cross-account', action: 'apply', step: 'agenda', reason: 'Correction D23', accountId: 12 })).toMatchObject({ ok: true, value: { accountId: 12 } });
    expect(validateBackfillRequest({ script: 'cross-account', action: 'apply', step: 'inconnue', reason: 'Correction D23' })).toMatchObject({ ok: false, code: 'INVALID_STEP' });
    // Restauration : une exécution, pas une étape.
    expect(validateBackfillRequest({ script: 'cross-account', action: 'restore', runId: '0b8e7c1e-1111-4222-8333-944455556666', reason: 'Retour arrière' }))
      .toMatchObject({ ok: true, value: { step: null } });
  });

  it('PO-D23-05 — synthèse : application restaurable, Duo et indécidables signalés en avertissement', () => {
    const base = { runId: 'r-1', family: 'documents' as const, accountId: null, more: false };
    const cat = { code: 'DOC_ASSET', candidates: 5, corrected: 3, duo: 1, undecidable: 1, failed: 0, samples: [], duoSamples: ['asset_files(id=9) [compte 1 / 2]'], failures: [] };
    const apply = summarizeBackfill('cross-account', 'apply', 'documents', { result: { ...base, mode: 'apply', corrected: 3, duo: 1, undecidable: 1, failed: 0, categories: [cat] } });
    expect(apply.headline).toMatch(/^Application \(documents\) : 3 relation\(s\) corrigée\(s\), 1 relevant du Duo/);
    expect(apply).toMatchObject({ scriptRunId: 'r-1', restorable: true });
    expect(apply.warnings.join(' ')).toMatch(/Duo \(D3 ouvert/);
    expect(apply.ambiguous.samples[0]).toContain('DOC_ASSET');
    const simu = summarizeBackfill('cross-account', 'simulate', 'documents', { result: { ...base, mode: 'simulate', corrected: 3, duo: 0, undecidable: 0, failed: 0, categories: [{ ...cat, duo: 0, undecidable: 0, duoSamples: [] }] } });
    expect(simu).toMatchObject({ scriptRunId: null, restorable: false });
    expect(simu.headline).toMatch(/à corriger/);
    const resto = summarizeBackfill('cross-account', 'restore', null, { result: { runId: 'r-1', restoreRunId: 'r-2', restored: 2, conflicts: [{ ref: 'x', reason: 'modifiée' }] } });
    expect(resto.headline).toMatch(/Restauration de r-1 : 2 ligne\(s\)/);
    expect(resto.conflicts.count).toBe(1);
  });

  it('PO-D23-05 — journal et garde : migration 0345 (journal, exception de restauration en transaction seule), 0346 (suppression)', () => {
    const m45 = readFileSync(join(process.cwd(), 'src/db/migrations/0345_cross_account_remediation.sql'), 'utf8');
    expect(m45).toMatch(/CREATE TABLE IF NOT EXISTS cross_account_remediations/);
    expect(m45).toMatch(/current_setting\('verebona\.cross_account_restore', true\) = 'on'/);
    expect(m45).not.toMatch(/CREATE INDEX(?! CONCURRENTLY)/);
    const idx = readFileSync(join(process.cwd(), 'src/db/migrations/0345_cross_account_remediation_idx_1.sql'), 'utf8');
    expect(idx).toMatch(/CREATE INDEX CONCURRENTLY IF NOT EXISTS cross_account_remediations_run_idx/);
    const rem = readFileSync(join(process.cwd(), 'src/services/security/cross-account/remediation.ts'), 'utf8');
    // L'exception n'est posée QUE par la restauration, en SET LOCAL.
    expect(rem.match(/cross_account_restore/g)?.length).toBeGreaterThanOrEqual(1);
    expect(rem).toMatch(/SET LOCAL verebona\.cross_account_restore = 'on'/);
    expect(rem).not.toMatch(/SET verebona\.cross_account_restore/);
    const m46 = readFileSync(join(process.cwd(), 'src/db/migrations/0346_assets_detach_foreign_refs.sql'), 'utf8');
    expect(m46).toMatch(/BEFORE DELETE ON assets/);
    expect(m46).toMatch(/DROP TRIGGER IF EXISTS assets_detach_foreign_refs ON assets/);
  });
});

describe('PO-D23-03 — lectures bornées au compte (jointures corrigées)', () => {
  it('PO-D23-03 — aucune jointure document → bien sans condition de compte dans les listes utilisateur', () => {
    for (const f of ['src/app/api/documents/route.ts', 'src/services/home/HomeSummaryService.ts', 'src/services/to-process/to-process-query.service.ts', 'src/services/documents/rubric-query.service.ts']) {
      const src = readFileSync(join(process.cwd(), f), 'utf8');
      expect(src, f).not.toContain('.leftJoin(assets, eq(assetFiles.assetId, assets.id))');
    }
    const ov = readFileSync(join(process.cwd(), 'src/app/api/assets/[id]/overview/route.ts'), 'utf8');
    expect(ov.match(/account_id = \$\{accountId\}/g)?.length).toBeGreaterThanOrEqual(4);
    const kn = readFileSync(join(process.cwd(), 'src/services/ai/knowledge/document-knowledge.service.ts'), 'utf8');
    expect(kn).toContain('af.account_id = f.account_id');
    expect(kn).toContain('af.account_id = e.account_id');
  });
});
