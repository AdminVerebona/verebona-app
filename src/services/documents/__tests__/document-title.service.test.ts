/**
 * Lot 33C — service commun du titre (T1 / T3) et page du rattrapage T3.
 * La persistance et la concurrence sont couvertes sur base réelle
 * (`src/test/e2e/scenarios/l33c-titre-metier.e2e.ts`).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  ensure: vi.fn(),
  unsafe: vi.fn(),
  enqueue: vi.fn(),
}));
vi.mock('@/db', () => ({ pgClient: { unsafe: (...a: unknown[]) => m.unsafe(...a) }, db: {} }));
vi.mock('@/services/documents/document-title.service', async (o) => ({
  ...(await o<object>()),
  ensureBusinessTitle: (...a: unknown[]) => m.ensure(...a),
}));

import { buildTitle } from '../document-title.service';
import {
  DOCUMENT_TITLE_SWEEP_KIND, repairTitles, runDocumentTitleSweepPage, TITLE_SWEEP_SQL,
} from '@/services/ai/reconciliation/document-title-sweep';
import { getT3JobKind } from '@/services/ai/reconciliation/t3-job-contract';

const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const guard = { assertActive: vi.fn(async () => {}) } as never;

beforeEach(() => {
  m.ensure.mockReset(); m.unsafe.mockReset(); m.enqueue.mockReset();
  m.enqueue.mockResolvedValue({ decision: 'enqueued', jobId: 1 });
});

describe('buildTitle — règles de nommage EXISTANTES (inchangées)', () => {
  it('titre du modèle conforme : conservé', () => {
    expect(buildTitle({ modelTitle: "Certificat d'immatriculation CUPRA", ctx: {} })).toBe("Certificat d'immatriculation CUPRA");
  });
  it('titre du modèle technique : reconstruit (type / sujet / fournisseur / mois), jamais l’UUID', () => {
    expect(buildTitle({ modelTitle: '5be5a3ca-38cf-47fc-942c-3386ea8e846b.pdf', ctx: { typeCode: 'invoice', supplier: 'EDF' } })).toBe('Facture EDF');
    expect(buildTitle({ modelTitle: '5be5a3ca-38cf-47fc-942c-3386ea8e846b.pdf', ctx: { documentDate: '2024-04-18' } })).toBe('Document avril 2024');
  });
  it('SKIP_INSUFFICIENT_DATA : rien d’exploitable → null (jamais un titre technique)', () => {
    expect(buildTitle({ modelTitle: '5be5a3ca-38cf-47fc-942c-3386ea8e846b.pdf', ctx: {} })).toBeNull();
    expect(buildTitle(null)).toBeNull();
  });
});

describe('TITLE-AC4 — T1 et T3 utilisent la même implémentation', () => {
  it('T1 (fin d’analyse) et T3 (rattrapage) appellent `ensureBusinessTitle` du service commun ; la persistance du run n’écrit plus le titre', () => {
    const pipeline = src('src/services/ai/source-analysis/pipeline.ts');
    expect(pipeline).toContain("import { ensureBusinessTitle } from '@/services/documents/document-title.service'");
    expect(pipeline).toMatch(/ensureBusinessTitle\(\{[\s\S]{0,200}origin: 'T1',\s*mode: 'refresh'/);
    const sweep = src('src/services/ai/reconciliation/document-title-sweep.ts');
    expect(sweep).toMatch(/ensureBusinessTitle\(\{[^}]*origin: 'T3', mode: 'repair'/);
    const repo = src('src/services/ai/source-analysis/persistence/analysis-result.repository.ts');
    expect(repo).not.toMatch(/patch\.retainedTitle|refineDocumentTitle/);
    // Une seule lecture du résultat d'analyse pour le titre (T1 en mémoire, T3 relu du run).
    expect(src('src/services/documents/document-title.service.ts')).toContain('titleInputsFromAnalysis(parsed)');
  });

  it('TITLE-AC3 — le rattrapage ne dépend d’aucun point d’entrée d’analyse (ni OCR, ni T1, ni classement)', () => {
    for (const p of ['src/services/ai/reconciliation/document-title-sweep.ts', 'src/services/documents/document-title.service.ts']) {
      const imports = src(p).split('\n').filter((l) => /^import |import\(/.test(l.trim())).join('\n');
      expect(imports).not.toMatch(/source-analysis\/(entrypoint|pipeline|steps)|ai-gateway|apply-v2-classification|ocr|extraction/i);
      expect(src(p)).not.toMatch(/analyzeFileSources\(|runSourceAnalysis\(/);
    }
  });
});

describe('TITLE-AC7 — sélection indépendante des autres traitements', () => {
  it('aucune condition sur rattachement, classement, agenda ni autre travail T3', () => {
    expect(TITLE_SWEEP_SQL).not.toMatch(/asset_id IS NULL|document_asset_links|rubric_code|classification_state|agenda|ai_job_queue|document_asset_resolutions/);
    expect(TITLE_SWEEP_SQL).toContain("f.title_source = 'SYSTEM'");
    expect(TITLE_SWEEP_SQL).toMatch(/f\.analysis_state IN \('ANALYZED'/);
  });
});

describe('page du rattrapage T3 (contrat 31C)', () => {
  const job = { id: 9, triggerCode: 'schedule_hourly' } as never;
  const page = (n: number) => Array.from({ length: n }, (_, i) => ({ id: 100 + i, account_id: 1 }));

  it('page pleine : chaque document passe par le service (origine T3, mode repair), puis UNE continuation unique', async () => {
    vi.stubEnv('T3_TITLE_SWEEP_PAGE_SIZE', '2');
    m.unsafe.mockResolvedValueOnce(page(2));
    m.ensure.mockResolvedValueOnce({ outcome: 'UPDATED' }).mockResolvedValueOnce({ outcome: 'SKIP_INSUFFICIENT_DATA' });
    const r = await runDocumentTitleSweepPage(job, { kind: DOCUMENT_TITLE_SWEEP_KIND, cycleId: 'c', page: 0, afterFileId: 0, requestedAt: null }, guard, { enqueue: m.enqueue });
    expect(m.ensure).toHaveBeenCalledWith(expect.objectContaining({ fileId: 100, accountId: 1, origin: 'T3', mode: 'repair' }));
    expect(r).toMatchObject({ result: 'APPLIED', detail: expect.objectContaining({ examined: 2, UPDATED: 1, SKIP_INSUFFICIENT_DATA: 1, last: false }) });
    expect(m.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      treatment: 'T3', onlyIfNeverQueued: true,
      scope: { targetType: 'document_title_sweep', targetId: 'c:1' },
      payload: expect.objectContaining({ kind: DOCUMENT_TITLE_SWEEP_KIND, page: 1, afterFileId: 101, payloadVersion: 1 }),
    }));
    vi.unstubAllEnvs();
  });

  it('dernière page : aucune continuation ; TITLE-AC6 — rien à corriger → NO_CHANGE', async () => {
    m.unsafe.mockResolvedValueOnce(page(1));
    m.ensure.mockResolvedValueOnce({ outcome: 'SKIP_VALID_TITLE' });
    const r = await runDocumentTitleSweepPage(job, { kind: DOCUMENT_TITLE_SWEEP_KIND, cycleId: 'c', page: 3, afterFileId: 50, requestedAt: null }, guard, { enqueue: m.enqueue });
    expect(r.result).toBe('NO_CHANGE');
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it('repairTitles compte chaque issue', async () => {
    m.ensure.mockResolvedValueOnce({ outcome: 'FAILED' }).mockResolvedValueOnce({ outcome: 'SKIP_USER_TITLE' });
    expect(await repairTitles([{ fileId: 1, accountId: 1 }, { fileId: 2, accountId: 1 }])).toEqual({
      UPDATED: 0, SKIP_VALID_TITLE: 0, SKIP_USER_TITLE: 1, SKIP_INSUFFICIENT_DATA: 0, FAILED: 1,
    });
  });

  it('contexte versionné : sans cycle ou curseur invalide → échec permanent', () => {
    const spec = getT3JobKind(DOCUMENT_TITLE_SWEEP_KIND)!;
    const shape = { id: 1, accountId: null, targetType: 'document_title_sweep', targetId: 'c:0' };
    expect(spec.account).toBe('forbidden');
    expect(spec.parse({ cycleId: 'c', page: 2, afterFileId: 10 }, shape, 1)).toMatchObject({ cycleId: 'c', page: 2, afterFileId: 10 });
    expect(() => spec.parse({ page: 0 }, shape, 1)).toThrow(/sans cycle/);
    expect(() => spec.parse({ cycleId: 'c', afterFileId: -1 }, shape, 1)).toThrow(/afterFileId/);
  });
});
