/**
 * Lot 115H (Trello #785) sur PostgreSQL réel — § 1 : PLAFONDS RÉELLEMENT
 * COMMUNS, Y COMPRIS LA RELANCE COMPLÈTE DU BO.
 *
 * Le droit de remise en file T1 est contrôlé ET réservé par le service commun
 * AVANT tout enfilement, pour toutes les origines. Vérifié sur la base : la
 * file `ai_job_queue` ne reçoit RIEN quand la demande est refusée, et
 * `retry_attempts` ne bouge pas.
 *
 *   L115H-E01  plafond à 0 : toute origine refusée, aucun travail créé ;
 *   L115H-E02  plafond consommé (relance complète du BO) : refusée, motif
 *              explicite, aucune consommation, échéance NON touchée ;
 *   L115H-E03  plafond abaissé APRÈS programmation : refusée ;
 *   L115H-E04  deux demandes simultanées sur la dernière reprise : un seul
 *              travail vivant, UNE seule reprise consommée (ni double
 *              consommation, ni tentative oubliée).
 *
 * Aucun appel à un fournisseur d'IA : la file T1 n'exécute rien ici.
 */
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { useTargetState } from '../chain';
import type { AccountRow } from '../factories';
import type { CoveredSourceUnit, SourceLayer } from '@/services/ai/source-analysis/source-units/types';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Json = Record<string, any>;
const TEXTES = ['Référence dossier : AB-2291', 'Montant restant dû : 132,00 €', 'Échéance du 14/02/2026'];
const unite = (n: number, over: Partial<CoveredSourceUnit> = {}): CoveredSourceUnit => ({
  sourceUnitId: `page:1:block:${n}`, kind: 'TEXT_BLOCK', page: 1, ordinal: n, parentUnitId: null, text: TEXTES[n - 1], payload: {}, location: {},
  origin: 'PASS_1', salient: true, status: 'UNRESOLVED', reason: 'not_extracted', factCount: 0, repairAttempts: 0, repairState: null, ...over,
});
const pdf = (missing: number[] = []) => ({
  status: missing.length ? 'PARTIAL' as const : 'VERIFIED' as const, reason: missing.length ? 'pages_missing' : null,
  pagesExpected: 3, verified: [1, 2, 3].filter((p) => !missing.includes(p)), missing, unverified: [], scanned: [],
});

scenario('L115H', 'T1 — plafonds communs à toutes les origines de reprise (#785 § 1)', ({ sql, make, replay }) => {
  useTargetState({}, { masters: ['T1'] });

  const fichier = async (compte: AccountRow) => {
    const f = await make.assetFile(compte, { assetId: null });
    await sql`UPDATE asset_files SET s3_bucket = 'e2e-bucket', original_filename = ${`doc-${f.id}.pdf`}, analysis_state = NULL WHERE id = ${f.id}`;
    return f.id;
  };
  /** Écrit une couche A par la VRAIE écriture, état calculé par le vrai rapport. */
  const ecrire = async (compte: AccountRow, fileId: number, units: CoveredSourceUnit[], verification: unknown = pdf()) => {
    const { buildCompletenessReport } = await import('@/services/ai/source-analysis/source-units/coverage');
    const { withResidualPolicies } = await import('@/services/ai/source-analysis/source-units/coverage-reconciliation');
    const { writeSourceLayer } = await import('@/services/ai/source-analysis/source-units/repository');
    const { SOURCE_LAYER_VERSION } = await import('@/services/ai/source-analysis/source-units/types');
    const u = withResidualPolicies(units);
    const layer: SourceLayer = {
      layerVersion: SOURCE_LAYER_VERSION, units: u, unresolvedFacts: [], retryable: true,
      report: buildCompletenessReport(u, {
        factsCount: 1, unresolvedFacts: [], truncatedSectionsCount: 0, batchedSectionsCount: 0, repairPassCount: 1, chunkCount: 0,
        warningCodes: [], retryAllowed: true, verification: verification as never,
      }),
    };
    await sql.begin(async (tx) => { await writeSourceLayer(tx as never, { accountId: compte.id, fileId, extractionId: null, layer }); });
  };
  const poser = (fileId: number, p: { attempts: number; next?: 'due' | 'future' | null }) => sql`
    UPDATE document_extraction_coverage
       SET retry_attempts = ${p.attempts},
           next_retry_at = ${p.next === 'future' ? sql`NOW() + interval '3 days'` : p.next === 'due' ? sql`NOW() - interval '2 hours'` : null}
     WHERE file_id = ${fileId}`;
  const couverture = async (fileId: number) => (await sql<Json[]>`
    SELECT retry_attempts AS attempts, next_retry_at AS next, last_retry_result AS result, last_error AS error, origin, verification
      FROM document_extraction_coverage WHERE file_id = ${fileId}`)[0];
  const travaux = (fileId: number) => sql<Json[]>`
    SELECT id, status FROM ai_job_queue WHERE treatment = 'T1' AND target_type = 'asset_file' AND target_id = ${String(fileId)} ORDER BY id`;

  const demander = async (fileId: number, compte: AccountRow, over: Record<string, unknown> = {}) => {
    const jobs = await import('@/services/ai/source-analysis/source-units/jobs');
    return jobs.requeueDocumentForRereadDetailed({
      fileId, accountId: compte.id, attempt: 1, origin: 't1-completeness-retry', result: 'REQUEUED_T1', ...over,
    });
  };

  it('L115H-E01 — plafond à 0 : toute origine est refusée AVANT tout enfilement, aucun travail créé', async () => {
    const c = await make.account();
    const env = { T1_COMPLETENESS_MAX_RETRIES: '0' };
    for (const requestedBy of ['BO', 'SCHEDULER', 'COHERENCE', 'REVERIFICATION', 'OTHER'] as const) {
      const f = await fichier(c);
      await ecrire(c, f, [unite(1), unite(2)]);
      await poser(f, { attempts: 0, next: null });
      const r = await demander(f, c, { requestedBy, env, scheduled: requestedBy === 'SCHEDULER' });
      expect(r, requestedBy).toMatchObject({
        status: 'NOT_ADMISSIBLE', queued: false, jobId: null, reason: 'RETRIES_DISABLED', attemptConsumed: false,
        result: 'REQUEUE_NOT_ADMISSIBLE:RETRIES_DISABLED',
      });
      // La file T1 n'a RIEN reçu : aucun travail, donc aucun appel possible.
      expect(await travaux(f), requestedBy).toEqual([]);
      const cov = await couverture(f);
      expect(Number(cov.attempts), requestedBy).toBe(0);
      // Aucune promesse de reprise, et le refus est tracé avec son origine.
      expect(cov.next).toBeNull();
      expect(cov.result).toBe('REQUEUE_NOT_ADMISSIBLE:RETRIES_DISABLED');
      expect(cov.verification.requeue).toMatchObject({ status: 'NOT_ADMISSIBLE', reason: 'RETRIES_DISABLED', requestedBy, attemptConsumed: false, maxRetries: 0 });
    }
    expect(replay.calls).toHaveLength(0);
  });

  it('L115H-E02 — plafond CONSOMMÉ : la relance complète du BO est refusée, l’échéance existante n’est pas touchée', async () => {
    const c = await make.account();
    const f = await fichier(c);
    await ecrire(c, f, [unite(1), unite(2)]);
    // Deux reprises consommées, et une échéance encore inscrite : la demande ne doit NI consommer NI effacer.
    await poser(f, { attempts: 2, next: 'future' });
    const avant = await couverture(f);
    const r = await demander(f, c, { requestedBy: 'BO', attempt: 3, env: { T1_COMPLETENESS_MAX_RETRIES: '2' } });
    expect(r).toMatchObject({ status: 'NOT_ADMISSIBLE', queued: false, reason: 'RETRY_CAP_REACHED', attemptConsumed: false });
    expect(await travaux(f)).toEqual([]);
    const apres = await couverture(f);
    expect(Number(apres.attempts)).toBe(2);
    expect(apres.next).toEqual(avant.next);
    expect(apres.error).toContain('plafond de reprises atteint');
    expect(apres.verification.requeue).toMatchObject({ requestedBy: 'BO', retryAttempts: 2, maxRetries: 2 });
    expect(replay.calls).toHaveLength(0);
  });

  it('L115H-E03 — plafond ABAISSÉ après programmation (3 consommées, plafond ramené à 2) : refusée', async () => {
    const c = await make.account();
    const f = await fichier(c);
    await ecrire(c, f, [unite(1), unite(2)]);
    await poser(f, { attempts: 3, next: 'due' });
    const r = await demander(f, c, { requestedBy: 'SCHEDULER', attempt: 4, scheduled: true, env: { T1_COMPLETENESS_MAX_RETRIES: '2' } });
    expect(r).toMatchObject({ status: 'NOT_ADMISSIBLE', reason: 'RETRY_CAP_REACHED', attemptConsumed: false });
    expect(await travaux(f)).toEqual([]);
    expect(Number((await couverture(f)).attempts)).toBe(3);
    expect(replay.calls).toHaveLength(0);
  });

  it('L115H-E04 — deux demandes simultanées sur la DERNIÈRE reprise : un seul travail, UNE seule reprise consommée', async () => {
    const c = await make.account();
    const f = await fichier(c);
    await ecrire(c, f, [unite(1), unite(2)]);
    // Une seule reprise reste (1 consommée sur 2).
    await poser(f, { attempts: 1, next: 'due' });
    const env = { T1_COMPLETENESS_MAX_RETRIES: '2' };
    const [a, b] = await Promise.all([
      demander(f, c, { requestedBy: 'BO', attempt: 2, env }),
      demander(f, c, { requestedBy: 'SCHEDULER', attempt: 2, scheduled: true, env }),
    ]);
    // Une demande obtient le droit ; l'autre est soit refusée faute de droit, soit rattachée au travail vivant —
    // jamais une seconde exécution, et jamais deux reprises consommées.
    expect([a, b].filter((x) => x.attemptConsumed)).toHaveLength(1);
    expect([a, b].filter((x) => x.status === 'ACCEPTED')).toHaveLength(1);
    expect((await travaux(f)).filter((j) => j.status === 'PENDING' || j.status === 'RUNNING')).toHaveLength(1);
    expect(Number((await couverture(f)).attempts)).toBe(2);

    // Troisième demande, plafond désormais atteint : refusée, sans travail supplémentaire.
    const troisieme = await demander(f, c, { requestedBy: 'BO', attempt: 3, env });
    expect(troisieme.status).toBe('NOT_ADMISSIBLE');
    expect((await travaux(f)).filter((j) => j.status === 'PENDING' || j.status === 'RUNNING')).toHaveLength(1);
    expect(Number((await couverture(f)).attempts)).toBe(2);
    expect(replay.calls).toHaveLength(0);
  });

  it('L115H-E05 — § 3 : source momentanément illisible SANS échéance → réarmée ; image non vérifiable → jamais relancée', async () => {
    const { reconcileStoredDocumentCoverage } = await import('@/services/ai/source-analysis/source-units/stored-reconciliation');
    const c = await make.account();

    // (a) Source MOMENTANÉMENT illisible, échéance effacée par un ancien refus, tentatives restantes.
    const illisible = await fichier(c);
    await ecrire(c, illisible, [unite(1)], {
      status: 'PARTIAL' as const, reason: 'source_unreadable', pagesExpected: 3, verified: [], missing: [], unverified: [1, 2, 3], scanned: [],
    });
    await poser(illisible, { attempts: 0, next: null });
    expect((await couverture(illisible)).next).toBeNull();
    const ra = await reconcileStoredDocumentCoverage({ accountId: c.id, fileId: illisible, apply: true, origin: 'e2e/l115h' });
    // Une action REQUEUE_T1 est réellement admissible : l'échéance manquante est REPOSÉE (document repris).
    expect(ra.retry).toMatchObject({ scheduledBefore: false, scheduledAfter: true });
    expect(ra.retry!.actions).toContain('REQUEUE_T1');
    expect((await couverture(illisible)).next).not.toBeNull();

    // (b) Même document, plafond atteint : plus aucune action, donc aucune échéance — aucune boucle.
    await poser(illisible, { attempts: 2, next: null });
    const rb = await reconcileStoredDocumentCoverage({ accountId: c.id, fileId: illisible, apply: true, origin: 'e2e/l115h' });
    expect(rb.retry).toMatchObject({ scheduledAfter: false, blocked: 'RETRY_CAP_REACHED' });
    expect((await couverture(illisible)).next).toBeNull();

    // (c) Image NON vérifiable : l'incertitude est conservée, AUCUNE échéance, aucun travail.
    const img = await fichier(c);
    await ecrire(c, img, [unite(1)], {
      status: 'UNVERIFIABLE' as const, reason: 'image_not_checkable', pagesExpected: 1, verified: [], missing: [], unverified: [1], scanned: [1],
    });
    await poser(img, { attempts: 0, next: null });
    const rc = await reconcileStoredDocumentCoverage({ accountId: c.id, fileId: img, apply: true, origin: 'e2e/l115h' });
    expect(rc.retry).toMatchObject({ scheduledAfter: false });
    expect((await couverture(img)).next).toBeNull();
    expect(await travaux(img)).toEqual([]);
    expect(replay.calls).toHaveLength(0);
  });
});
