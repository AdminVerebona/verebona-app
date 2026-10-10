/**
 * Lot 34C — classement fonctionnel des échecs, projection des documents vers
 * l'application, relais du flux d'analyse (UXERR-01, 02, 04, 07).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => ({
  files: new Map<number, { id: number; analysis_state: string | null; analysis_fail_reason: string | null }>(),
  jobs: [] as Array<Record<string, unknown>>,
}));
vi.mock('@/db', () => ({
  pgClient: {
    unsafe: async (sql: string, params: unknown[]) => {
      if (sql.includes('FROM asset_files')) {
        const f = db.files.get(Number(params[0]));
        return f ? [f] : [];
      }
      if (sql.includes('FROM ai_job_queue')) {
        const ids = (params[0] as string[]);
        return db.jobs.filter((j) => ids.includes(String(j.target_id)));
      }
      return [];
    },
  },
}));

const { classifyUserFailure } = await import('../failure-classifier');
const { toUserFile, toUserFiles, userStreamEvent, getFileProcessingView } = await import('../processing-status.service');

/** Motif observé en recette (ticket, « Constat »). */
const MOTIF_TICKET = 'Analyse impossible (prompt maître T1) : Tous les modèles ont échoué. gemini-2.5-pro : Sortie non conforme au schéma. '
  + 'document.title.evidence : Invalid input ; document.description.evidence : Invalid input ; document.documentDate : Invalid input ; '
  + 'document.supplier : Invalid input ; document.amountCents : Invalid input';

const JARGON = /prompt|gemini|sch[eé]ma|Invalid input|document\.\w+|T1\b|INVALID_OUTPUT|mod[eè]les/i;

beforeEach(() => { db.files.clear(); db.jobs = []; });

describe('classifyUserFailure — référentiel fermé', () => {
  it('UXERR-04 — sortie de modèle invalide (motif du ticket) : échec générique, jamais un problème de fichier', () => {
    expect(classifyUserFailure(MOTIF_TICKET)).toBe('ANALYSIS_FAILED_FINAL');
    expect(classifyUserFailure('Tous les modèles ont échoué. gemini : INVALID_OUTPUT document is empty')).toBe('ANALYSIS_FAILED_FINAL');
  });
  it('problèmes de fichier sur lesquels l’utilisateur peut agir', () => {
    expect(classifyUserFailure('Analyse impossible (prompt maître T1) : Tous les modèles ont échoué. gemini-2.5-pro : The document is password protected')).toBe('FILE_PASSWORD_PROTECTED');
    expect(classifyUserFailure('Unable to process input file: corrupted PDF')).toBe('FILE_CORRUPTED');
    expect(classifyUserFailure('Unsupported MIME type: application/x-msdownload')).toBe('FILE_UNSUPPORTED');
    expect(classifyUserFailure('The document has no pages')).toBe('FILE_EMPTY');
    expect(classifyUserFailure("[file-adapter] Aucun fichier ne dispose d'un objet S3 exploitable")).toBe('FILE_UNREADABLE');
    expect(classifyUserFailure('timeout du fournisseur')).toBe('ANALYSIS_FAILED_FINAL');
    expect(classifyUserFailure(null)).toBe('ANALYSIS_FAILED_FINAL');
  });
});

describe('toUserFile / toUserFiles — projection vers l’application', () => {
  it('UXERR-04 — le motif technique ne quitte jamais le serveur ; statut fonctionnel ajouté', async () => {
    db.files.set(7, { id: 7, analysis_state: 'ANALYSIS_FAILED', analysis_fail_reason: MOTIF_TICKET });
    const [f] = await toUserFiles([{ id: 7, analysisState: 'ANALYSIS_FAILED', analysisFailReason: MOTIF_TICKET, originalFilename: 'facture.pdf' }]);
    expect(f).not.toHaveProperty('analysisFailReason');
    expect(f).toMatchObject({ id: 7, processingStatus: 'FAILED_FINAL', userMessageCode: 'ANALYSIS_FAILED_FINAL', retryScheduled: false });
    expect(JSON.stringify(f)).not.toMatch(JARGON);
    expect(toUserFile({ id: 1, analysis_fail_reason: 'x', analysisFailReason: 'y' })).toEqual({ id: 1 });
  });

  it('UXERR-01 — document marqué en échec par la cascade mais job RUNNING : PROCESSING', async () => {
    db.jobs = [{ target_id: '8', status: 'RUNNING', attempts: 1, available_at: null, cost_cap_until: null }];
    const [f] = await toUserFiles([{ id: 8, analysisState: 'ANALYSIS_FAILED', analysisFailReason: MOTIF_TICKET }]);
    expect(f).toMatchObject({ processingStatus: 'PROCESSING', userMessageCode: null });
  });

  it('UXERR-07 — UPLOADED sans job vivant : NOT_PROCESSED, jamais « en file »', async () => {
    const [f] = await toUserFiles([{ id: 9, analysisState: 'UPLOADED', analysisFailReason: null }]);
    expect(f.processingStatus).toBe('NOT_PROCESSED');
  });
});

describe('userStreamEvent — relais du flux d’analyse (SSE)', () => {
  it('UXERR-02 — un « error » du pipeline suivi d’une reprise réellement en file devient un state_update « en file », sans texte', async () => {
    db.files.set(10, { id: 10, analysis_state: 'ANALYSIS_FAILED', analysis_fail_reason: MOTIF_TICKET });
    db.jobs = [{ target_id: '10', status: 'PENDING', attempts: 1, available_at: '2026-10-09T10:01:00Z', cost_cap_until: null }];
    const e = await userStreamEvent(10, 3, { type: 'error', analysisState: 'ANALYSIS_FAILED', message: MOTIF_TICKET });
    expect(e).toMatchObject({ type: 'state_update', analysisState: 'UPLOADED', processingStatus: 'PENDING', retryScheduled: true });
    expect(e).not.toHaveProperty('message');
    expect(JSON.stringify(e)).not.toMatch(JARGON);
  });

  it('UXERR-03 — aucun job vivant : l’erreur reste terminale, code générique, aucun motif', async () => {
    db.files.set(11, { id: 11, analysis_state: 'ANALYSIS_FAILED', analysis_fail_reason: MOTIF_TICKET });
    const e = await userStreamEvent(11, 3, { type: 'error', analysisState: 'ANALYSIS_FAILED', message: MOTIF_TICKET, stack: 'Error: …' });
    expect(e).toEqual({
      type: 'error', analysisState: 'ANALYSIS_FAILED', processingStatus: 'FAILED_FINAL', userMessageCode: 'ANALYSIS_FAILED_FINAL',
      retryScheduled: false, nextAttemptAt: null, processingResumeAt: null,
    });
  });

  it('les événements de progression passent sans lecture ni texte', async () => {
    expect(await userStreamEvent(12, 3, { type: 'progress', stage: 'extraction', error: 'x' })).toEqual({ type: 'progress', stage: 'extraction' });
  });

  it('document d’un autre compte : aucune vue', async () => {
    expect(await getFileProcessingView(404, 3)).toBeNull();
  });
});
