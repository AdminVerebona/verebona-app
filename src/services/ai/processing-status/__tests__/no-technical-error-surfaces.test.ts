/**
 * Lot 34C — garde statique : aucune surface de l'application utilisateur ne
 * relaie un message d'erreur technique IA (UXERR-04, UXERR-07).
 *
 * Parcourt le code client (composants, contextes, pages hors BO) et les
 * routes API hors BO : le motif technique d'analyse (`analysisFailReason`)
 * n'y est jamais lu pour être affiché, le flux d'analyse et les routes de
 * document passent par la projection fonctionnelle.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(join(ROOT, dir))) {
    const p = join(dir, n);
    const st = statSync(join(ROOT, p));
    if (st.isDirectory()) {
      if (n === '__tests__' || n === 'node_modules' || n === 'admin') continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(n) && !/\.test\./.test(n)) {
      out.push(relative(ROOT, join(ROOT, p)));
    }
  }
  return out;
}

describe('UXERR-04 — aucune erreur technique IA vers l’application', () => {
  it('le code client ne lit jamais le motif technique d’analyse', () => {
    const fichiers = [...walk('src/components'), ...walk('src/contexts'), ...walk('src/hooks')];
    const fautifs = fichiers.filter((f) => /analysisFailReason|analysis_fail_reason|errorReason/.test(read(f).replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '')));
    expect(fautifs).toEqual([]);
  });

  it('les routes API utilisateur ne renvoient le motif technique que via la projection (`toUserFile`)', () => {
    const routes = walk('src/app/api');
    const fautives = routes.filter((f) => {
      const src = read(f);
      // Lecture explicite du motif pour le renvoyer, ou écriture d'un `message` tiré d'une exception dans un flux d'analyse.
      return /select\(\{\s*reason:\s*assetFiles\.analysisFailReason/.test(src)
        || /message:\s*f\?\.reason/.test(src);
    });
    expect(fautives).toEqual([]);
    for (const r of ['src/app/api/files/[id]/route.ts', 'src/app/api/files/route.ts']) expect(read(r)).toMatch(/toUserFiles\(/);
    expect(read('src/app/api/files/confirm/route.ts')).toMatch(/toUserFile\(/);
    expect(read('src/app/api/events/[eventId]/documents/route.ts')).toMatch(/toUserFile\(d\.file\)/);
    expect(read('src/app/api/documents/[id]/stream/route.ts')).toMatch(/userStreamEvent\(/);
    expect(read('src/app/api/documents/[id]/analyze/route.ts')).toMatch(/userStreamEvent\(/);
    expect(read('src/app/api/documents/[id]/analyze/route.ts')).not.toMatch(/code: 'INTERNAL_ERROR', message/);
    expect(read('src/app/api/documents/[id]/analysis-runs/route.ts')).toMatch(/errorMessage: _technique/);
    expect(read('src/app/api/notifications/route.ts')).toMatch(/sansMotifTechnique/);
  });

  it('le pipeline ne diffuse plus le motif sur le flux ; la cloche n’affiche plus de motif', () => {
    expect(read('src/services/ai/source-analysis/pipeline.ts')).not.toMatch(/broadcast\(id, \{ type: 'error', analysisState: 'ANALYSIS_FAILED', message/);
    expect(read('src/components/NotificationBell.tsx')).not.toMatch(/p\.errorReason/);
  });
});

describe('UXERR-07 — « en cours / en file » seulement sur un traitement réel', () => {
  it('les lectures agrégées (assistant, mascotte, accueil) utilisent l’état effectif', () => {
    for (const f of [
      'src/services/verebona-assistant/core/account-state.ts',
      'src/services/verebona-assistant/core/account-data.repository.ts',
      'src/services/home/mascot/collector.ts',
      'src/services/home/HomeSummaryService.ts',
    ]) expect(read(f), f).toMatch(/effectiveAnalysisStateSql\(/);
  });

  it('état effectif : job RUNNING → ANALYZING, PENDING → UPLOADED, UPLOADED sans job → NULL', async () => {
    const { effectiveAnalysisStateSql } = await import('../effective-state-sql');
    const sql = effectiveAnalysisStateSql('f');
    expect(sql).toMatch(/jq34\.status = 'RUNNING'\) THEN 'ANALYZING'/);
    expect(sql).toMatch(/jq34\.status = 'PENDING'\) THEN 'UPLOADED'/);
    expect(sql).toMatch(/f\.analysis_state IN \('UPLOADED', 'UPLOADING'\) THEN NULL/);
    expect(() => effectiveAnalysisStateSql('f; DROP')).toThrow();
  });
});
