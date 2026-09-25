/**
 * Sources secondaires regroupées : masquées comme documents autonomes, mais
 * conservées (stockage + base), consultables depuis les preuves, et jamais
 * visées par le cleanup générique tant que le document principal existe.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';

const sets: Array<Record<string, unknown>> = [];
vi.mock('@/db', () => ({
  db: { update: () => ({ set: (v: Record<string, unknown>) => { sets.push(v); return { where: async () => {} }; } }) },
}));
const { markSourcesGrouped } = await import('../grouped-sources');
const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

describe('regroupement', () => {
  it('rattache les secondaires à la principale (état distinct de la suppression)', async () => {
    await markSourcesGrouped(1, [1, 2, 3]);
    expect(sets[0]).toMatchObject({ groupedIntoFileId: 1 });
    expect(sets[0].groupedAt).toBeInstanceOf(Date);
    // Masquage des listes de documents autonomes conservé.
    expect(sets[0].deletedAt).toBeInstanceOf(Date);
  });

  it('les trois chemins de regroupement l’utilisent (plus de simple deletedAt)', () => {
    expect(read('src/services/ai/source-analysis/pipeline.ts')).toContain('await markSourcesGrouped(leadId, ids)');
    expect(read('src/services/document-ai/unified-analysis-pipeline.ts')).toContain('markSourcesGrouped(leadFile.id, secondaryIds)');
    expect(read('src/services/document-ai/commit-engine.ts')).toContain('markSourcesGrouped(g.leadFileId, g.ids)');
  });
});

describe('cleanup et accès', () => {
  it('le cleanup physique exclut les secondaires d’un document existant', () => {
    const job = read('src/lib/cleanup-job.ts');
    expect(job.match(/purgeEligibleCondition\(cutoffDate\)/g)?.length).toBe(2); // job + statistiques
    const helper = read('src/services/documents/grouped-sources.ts');
    const cond = helper.slice(helper.indexOf('export function purgeEligibleCondition'), helper.indexOf('export const viewableFileCondition'));
    expect(cond).toContain('IS NULL');
    expect(cond).toContain('lead.deleted_at IS NULL OR lead.deleted_at >=');
  });

  it('une secondaire reste consultable depuis les preuves du document', () => {
    expect(read('src/app/api/files/[id]/view/route.ts')).toContain('viewableFileCondition');
    expect(read('src/app/api/files/[id]/proxy/route.ts')).toContain('grouped_into_file_id IS NOT NULL');
    expect(read('src/app/api/documents/[id]/knowledge/route.ts')).toContain('groupedSources');
  });

  it('migration : état distinct + rattrapage des regroupements passés', () => {
    const m = read('src/db/migrations/0143_grouped_secondary_sources.sql');
    expect(m).toContain('grouped_into_file_id');
    expect(m).toContain('current_analysis_run_id');
  });
});
