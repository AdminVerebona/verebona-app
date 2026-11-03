/**
 * Lot 107G — diagnostics BO durables : règles PURES (codes, reprise, phases,
 * assainissement, progression, garde mémoire), manifeste PAR TABLE, mapping
 * table → section → fichier pour CHAQUE table du schéma Drizzle (CI), et
 * contrôles statiques : aucune génération dans une requête HTTP, liste sans
 * colonne lourde, migration additive.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import * as schema from '@/db/schema';
import {
  DIAG_JOB_ERROR_LABELS, DiagJobError, classifyDiagJobError, diagJobSettings, isTransientError, memoryGuardMb, parseIdempotencyKey, phaseOfPath,
  progressPercent, requestKey, retryDelaySeconds, sanitizeErrorMessage,
} from '../state';
import { tableManifest } from '@/services/admin/diagnostics-export/collect';
import { DIAG_TABLE_COVERAGE, DIAG_TABLE_EXCLUSIONS } from '@/services/admin/diagnostics-export/coverage';
import type { DiagFileInfo } from '@/services/admin/diagnostics-export/model';

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('L107G-U01 codes stables et reprise', () => {
  it('classe les erreurs : délai SQL, connexion, stockage, cible, code porté, inattendu', () => {
    expect(classifyDiagJobError(Object.assign(new Error('canceling statement'), { code: '57014' }))).toBe('READ_TIMEOUT');
    expect(classifyDiagJobError(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe('DB_CONNECTION_LOST');
    expect(classifyDiagJobError(Object.assign(new Error('x'), { code: '08006' }))).toBe('DB_CONNECTION_LOST');
    expect(classifyDiagJobError(new Error('x'), 'upload')).toBe('STORAGE_UPLOAD_FAILED');
    expect(classifyDiagJobError(Object.assign(new Error('x'), { $metadata: { httpStatusCode: 503 } }))).toBe('STORAGE_UPLOAD_FAILED');
    expect(classifyDiagJobError(new Error('x'), 'snapshot')).toBe('SNAPSHOT_FAILED');
    expect(classifyDiagJobError(Object.assign(new Error('Compte introuvable.'), { name: 'DiagTargetNotFoundError' }))).toBe('TARGET_NOT_FOUND');
    expect(classifyDiagJobError(new DiagJobError('MEMORY_GUARD', 'x'))).toBe('MEMORY_GUARD');
    expect(classifyDiagJobError(new Error('x'))).toBe('GENERATION_FAILED');
    for (const code of Object.keys(DIAG_JOB_ERROR_LABELS)) expect(DIAG_JOB_ERROR_LABELS[code as keyof typeof DIAG_JOB_ERROR_LABELS].length).toBeGreaterThan(20);
  });
  it('transitoire → nouvelle tentative ; mémoire, délai global, validation, cible, annulation : jamais rejoués automatiquement', () => {
    for (const c of ['WORKER_LOST', 'STORAGE_UPLOAD_FAILED', 'READ_TIMEOUT', 'DB_CONNECTION_LOST', 'SNAPSHOT_FAILED'] as const) expect(isTransientError(c), c).toBe(true);
    // Un diagnostic qui dépasse la mémoire ne doit pas faire tomber le processus en boucle.
    for (const c of ['MEMORY_GUARD', 'JOB_TIMEOUT', 'VALIDATION_FAILED', 'TARGET_NOT_FOUND', 'CANCELLED', 'GENERATION_FAILED', 'WORKER_LOST_MAX_ATTEMPTS', 'STORAGE_UNAVAILABLE'] as const) expect(isTransientError(c), c).toBe(false);
    expect([1, 2, 3, 9].map(retryDelaySeconds)).toEqual([60, 300, 900, 900]);
  });
  it('réglages : défauts prudents, variables Scalingo lues, valeurs invalides ignorées', () => {
    const d = diagJobSettings({});
    expect(d).toMatchObject({ maxAttempts: 3, leaseSeconds: 120, globalConcurrency: 1, retentionDays: 30, maxRssMb: 0, disabled: false });
    expect(d.timeoutMs).toBe(4 * 60 * 60_000);
    expect(diagJobSettings({ DIAG_JOB_MAX_ATTEMPTS: '5', DIAG_JOB_LEASE_SECONDS: '10', DIAG_JOB_MAX_RSS_MB: '1500', DIAG_JOB_WORKER_DISABLED: 'true' }))
      .toMatchObject({ maxAttempts: 5, leaseSeconds: 120, maxRssMb: 1500, disabled: true });
    expect(diagJobSettings({ DIAG_JOB_MAX_ATTEMPTS: 'abc' }).maxAttempts).toBe(3);
  });
  it('garde mémoire : variable explicite, sinon 85 % de la limite du conteneur, sinon mesure seule', () => {
    expect(memoryGuardMb(1500, 2048)).toBe(1500);
    expect(memoryGuardMb(0, 2048)).toBe(1740);
    expect(memoryGuardMb(0, null)).toBeNull();
    expect(memoryGuardMb(0, 9_999_999_999)).toBeNull();
  });
});

describe('L107G-U02 étapes, progression, idempotence', () => {
  it('étape de chaque fichier du plan', () => {
    expect(phaseOfPath('donnees/etat-metier/assets.json')).toBe('EXTRACTION');
    expect(phaseOfPath('donnees/fermeture/assets.json')).toBe('RELATIONS');
    expect(phaseOfPath('controle/references.json')).toBe('CONTROLES');
    expect(phaseOfPath('couverture/tables.json')).toBe('CONTROLES');
    expect(phaseOfPath('tracabilite/montants.json')).toBe('TRACABILITE');
    expect(phaseOfPath('manifeste.json')).toBe('MANIFESTE');
  });
  it('progression réelle : fichiers produits / prévus, jamais 100 % avant la publication', () => {
    expect(progressPercent(null, 'QUEUED')).toBeNull();
    expect(progressPercent({ filesPlanned: 200, filesDone: 50 }, 'RUNNING')).toBe(25);
    expect(progressPercent({ filesPlanned: 200, filesDone: 200 }, 'RUNNING')).toBe(99);
    expect(progressPercent({ filesPlanned: 200, filesDone: 3 }, 'COMPLETE')).toBe(100);
  });
  it('double clic : même clé pour la même demande ; clé client validée', () => {
    expect(requestKey({ scope: 'account', id: 13, reinforced: false })).toBe(requestKey({ scope: 'account', id: 13, reinforced: false }));
    expect(requestKey({ scope: 'account', id: 13, reinforced: true })).not.toBe(requestKey({ scope: 'account', id: 13, reinforced: false }));
    expect(parseIdempotencyKey('0b1c7d2e-1111-4222-8333-944455556666')).toBe('0b1c7d2e-1111-4222-8333-944455556666');
    expect(parseIdempotencyKey('court')).toBeNull();
    expect(parseIdempotencyKey('a b c d e f g h')).toBeNull();
    expect(parseIdempotencyKey(null)).toBeNull();
  });
});

describe('L107G-U03 traces affichées sans secret ni donnée personnelle', () => {
  it('e-mails, jetons, signatures d’URL, URL avec identifiants, valeurs littérales PostgreSQL masqués ; 500 caractères', () => {
    const m = sanitizeErrorMessage(new Error(
      'échec pour jean.dupont@example.fr Bearer abcdefghijklmnopqrstuvwxyz https://u:mdp@s3.example/x?X-Amz-Signature=deadbeef token=sk-123456789012345678 invalid input syntax for type integer: "12 rue des Lilas"',
    ));
    expect(m).not.toMatch(/jean\.dupont|abcdefghijklmnop|mdp@|deadbeef|sk-1234|rue des Lilas/);
    expect(m).toContain('[e-mail masqué]');
    expect(m).toContain('"…"');
    expect(sanitizeErrorMessage('x'.repeat(2000))).toHaveLength(500);
  });
});

describe('L107G-U04 manifeste PAR TABLE', () => {
  const f = (path: string, o: Partial<DiagFileInfo>): DiagFileInfo => ({ path, description: '', complete: true, status: 'COMPLETE', sha256: `sha-${path}`, ...o });
  it('attendu / exporté / écart / statut / empreintes, parties additionnées, fermeture rattachée, exclusions et hors filtre motivés', () => {
    const t = tableManifest([
      f('donnees/candidats/reconciliation_decisions.part-0001.json', { expected: 500, count: 500 }),
      f('donnees/candidats/reconciliation_decisions.part-0002.json', { expected: 300, count: 300 }),
      f('donnees/etat-metier/assets.json', { expected: 10, count: 9, status: 'PARTIAL' }),
      f('donnees/fermeture/assets.json', { expected: 2, count: 2, section: 'etat-metier' }),
      f('donnees/technique/ai_job_queue.json', { expected: null, count: 0, status: 'FAILED', error: 'attendu non calculé : 57014' }),
      f('donnees/etat-metier/agenda_items.json', { expected: 4, count: 4 }),
      f('tracabilite/montants.json', { expected: 3, count: 3 }),
    ], [{ table: 'admin_audit_log', motif: 'table transversale' }], [{ table: 'user_sessions', categorie: 'SECURITE', motif: 'jetons de session' }]);
    const by = Object.fromEntries(t.map((x) => [x.table, x]));
    expect(by.reconciliation_decisions).toMatchObject({ role: 'EXPORTED', attendu: 800, exporte: 800, ecart: 0, statut: 'COMPLETE', section: 'candidats' });
    expect(by.reconciliation_decisions.sha256).toHaveLength(2);
    expect(by.assets).toMatchObject({ attendu: 12, exporte: 11, ecart: 1, statut: 'PARTIAL', section: 'etat-metier' });
    expect(by.assets.fermeture).toEqual(['donnees/fermeture/assets.json']);
    expect(by.ai_job_queue).toMatchObject({ attendu: null, ecart: null, statut: 'FAILED' });
    expect(by.agenda_items.statut).toBe('COMPLETE');
    expect(by.admin_audit_log).toMatchObject({ role: 'NOT_APPLICABLE', statut: 'NOT_APPLICABLE', motif: 'table transversale' });
    expect(by.user_sessions).toMatchObject({ role: 'EXCLUDED', statut: 'EXCLUDED' });
    expect(by.user_sessions.motif).toMatch(/SECURITE — jetons/);
    expect(t.some((x) => x.table === 'montants')).toBe(false);
  });
  it('jamais « n sur ? » : un attendu non calculé n’est jamais COMPLETE', () => {
    const [x] = tableManifest([f('donnees/technique/t.json', { expected: null, count: 5 })], [], []);
    expect(x.statut).toBe('PARTIAL');
    expect(x.erreurs).toContain('attendu non calculé');
  });
});

describe('L107G-U05 inventaire : chaque table du schéma → section et fichier de l’archive, ou exclusion motivée (CI)', () => {
  const tables = Object.values(schema).filter((v) => is(v, PgTable)).map((t) => getTableName(t as PgTable));
  it('aucune table du schéma sans destination dans le ZIP global', () => {
    expect(tables.length).toBeGreaterThan(100);
    const orphelines: string[] = [];
    for (const t of tables) {
      const c = DIAG_TABLE_COVERAGE[t];
      const x = DIAG_TABLE_EXCLUSIONS[t];
      if (c) expect(`donnees/${c.section}/${t}.json`).toMatch(/^donnees\/[a-z-]+\/[a-z0-9_]+\.json$/);
      else if (x) expect(x.motif.trim().length, t).toBeGreaterThan(5);
      else orphelines.push(t);
    }
    expect(orphelines, 'tables à déclarer dans src/services/admin/diagnostics-export/coverage.ts (section) ou à exclure avec motif').toEqual([]);
  });
  it('le suivi des générations (file durable) est exporté au global (section technique)', () => {
    expect(DIAG_TABLE_COVERAGE.admin_export_generations?.section).toBe('technique');
  });
});

describe('L107G-S01 aucune génération dans une requête HTTP ; liste légère ; migration additive', () => {
  it('la page BO demande un travail durable (POST, clé d’idempotence) et ne génère plus rien dans une requête', () => {
    const page = read('src/app/admin/diagnostics/page.tsx');
    expect(page).toContain("fetch('/api/admin/diagnostics/jobs'");
    expect(page).toContain("'Idempotency-Key'");
    expect(page).not.toMatch(/fetch\(`\/api\/admin\/diagnostics\?/);
    expect(page).not.toMatch(/\/api\/admin\/diagnostics\?\$\{[^}]*\}&format=zip/);
    expect(page).toContain('/api/admin/diagnostics/jobs/health');
  });
  it('la route de demande ne charge ni le moteur ni l’archive ; la route historique est retirée par défaut', () => {
    const post = read('src/app/api/admin/diagnostics/jobs/route.ts');
    expect(post).not.toMatch(/diagnostics-export\/(collect|zip|engine)/);
    expect(post).toContain('enqueueDiagnosticJob');
    const legacy = read('src/app/api/admin/diagnostics/route.ts');
    expect(legacy).toMatch(/process\.env\.DIAG_SYNC_HTTP !== 'on'/);
    expect(legacy).toContain('SYNC_GENERATION_DISABLED');
    expect(legacy.indexOf('SYNC_GENERATION_DISABLED')).toBeLessThan(legacy.indexOf('withDiagnosticPlan'));
  });
  it('liste des générations : colonnes scalaires seulement (jamais sections / resume_state / attempts_log hors détail)', () => {
    const src = read('src/services/admin/export-generations.ts');
    const light = /const LIGHT_COLUMNS = `([^`]+)`/.exec(src)![1] + /const JOB_COLUMNS = `([^`]+)`/.exec(src)![1];
    expect(light).not.toMatch(/\bsections\b|resume_state|attempts_log/);
    expect(src).toMatch(/\$\{detail \? `, sections/);
  });
  it('migration 1035 : additive et idempotente, aucune destruction ; index optionnel séparé', () => {
    const dir = 'src/db/migrations';
    const files = readdirSync(join(root, dir)).filter((f) => f.startsWith('1035_'));
    expect(files.sort()).toEqual(['1035_l107g_diagnostics_jobs_durables.sql', '1035_l107g_diagnostics_jobs_durables_idx_1.sql']);
    const m = read(`${dir}/1035_l107g_diagnostics_jobs_durables.sql`).split('\n').filter((l) => !l.startsWith('--')).join('\n');
    expect(m).not.toMatch(/DROP\s+(TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM|ALTER\s+COLUMN/i);
    for (const l of m.split(';').map((x) => x.trim()).filter((x) => /^ALTER TABLE .* ADD COLUMN/.test(x))) expect(l).toMatch(/ADD COLUMN IF NOT EXISTS/);
    expect(m).toMatch(/DROP CONSTRAINT IF EXISTS admin_export_generations_status_chk/);
    const idx = read(`${dir}/1035_l107g_diagnostics_jobs_durables_idx_1.sql`);
    expect(idx).toContain('-- verebona:optional-index');
    expect(idx).toMatch(/CREATE INDEX CONCURRENTLY IF NOT EXISTS/);
  });
  it('le worker démarre au boot ; le moteur reste en lecture seule (écritures du suivi hors du module du diagnostic)', () => {
    expect(read('src/instrumentation-node.ts')).toContain('startDiagnosticWorker()');
    for (const f of readdirSync(join(root, 'src/services/admin/diagnostics-export')).filter((x) => x.endsWith('.ts'))) {
      expect(read(`src/services/admin/diagnostics-export/${f}`), f).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i);
    }
  });
});
