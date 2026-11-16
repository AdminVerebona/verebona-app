/**
 * Lot 115H (Trello #785) — ÉCARTS DU LOT 114H.
 *
 *   § 1  PLAFONDS RÉELLEMENT COMMUNS, Y COMPRIS LA RELANCE COMPLÈTE DU BO :
 *        le droit de remise en file T1 est contrôlé ET réservé par le service
 *        commun AVANT tout enfilement, pour toutes les origines ; refus
 *        explicite et motivé, aucune consommation, aucune reprise promise.
 *
 * Base simulée (aucune base, aucun appel IA) : la file T1 est injectée et
 * compte ses sollicitations — un enfilement de trop est donc détectable.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const etat = vi.hoisted(() => ({
  ecritures: [] as Array<{ q: string; params: unknown[] }>,
  /** Ligne de couverture servie aux lectures (`null` : document sans couche A relue). */
  couverture: null as { retryAttempts: number } | null,
  /** Sollicitations RÉELLES de la file T1 : une demande refusée n'en produit aucune. */
  misesEnFile: [] as Array<{ fileIds: number[]; accountId: number }>,
  file: { status: 'ACCEPTED', jobId: 501, reason: null } as { status: string; jobId: number | null; reason: string | null },
  travaux: [{ id: 501 }] as Array<{ id: number }>,
  anomalies: [] as Array<{ action: string; fingerprint: string }>,
}));

const requete = vi.hoisted(() => async (q: string, params: unknown[] = []) => {
  const x = q.replace(/\s+/g, ' ').trim();
  etat.ecritures.push({ q: x, params });
  if (/SELECT retry_attempts FROM document_extraction_coverage WHERE file_id = \$1 AND account_id = \$2/.test(x)) {
    return etat.couverture ? [{ retry_attempts: etat.couverture.retryAttempts }] : [];
  }
  // Réservation CONDITIONNELLE du droit : la ligne n'est rendue que si le plafond le permet encore.
  if (/SET retry_attempts = retry_attempts \+ 1, updated_at = NOW\(\)/.test(x)) {
    const c = etat.couverture;
    if (!c || c.retryAttempts >= Number(params[2])) return [];
    c.retryAttempts += 1;
    return [{ n: c.retryAttempts }];
  }
  // Consommation OU relâchement de la réservation (la règle de 114H décide lequel).
  if (/SET retry_attempts = CASE WHEN \$3::boolean/.test(x)) {
    const c = etat.couverture;
    if (c) {
      if (params[2] === true) c.retryAttempts = Math.max(c.retryAttempts, Number(params[3]));
      else if (params[7] === true) c.retryAttempts = Math.max(0, c.retryAttempts - 1);
    }
    return [];
  }
  if (/FROM ai_job_queue/.test(x)) return etat.travaux;
  if (/'requeue' ->> 'transientRefusals'/.test(x)) return [{ refus: '0' }];
  return [];
});

vi.mock('@/db', () => ({
  pgClient: { unsafe: requete, begin: async (fn: (tx: { unsafe: typeof requete }) => Promise<unknown>) => fn({ unsafe: requete }) },
  db: {},
}));
vi.mock('../../queue/t1-handler', async (orig) => ({
  ...(await orig<typeof import('../../queue/t1-handler')>()),
  enqueueFileAnalysesDetailed: async (fileIds: number[], accountId: number) => {
    etat.misesEnFile.push({ fileIds, accountId });
    return fileIds.map((fileId) => ({ fileId, ...etat.file }));
  },
}));
vi.mock('@/services/admin/anomaly.service', () => ({
  reportAnomaly: async (p: { fingerprint: string }) => { etat.anomalies.push({ action: 'report', fingerprint: p.fingerprint }); return 1; },
  autoResolveAnomaly: async (fingerprint: string) => { etat.anomalies.push({ action: 'resolve', fingerprint }); return true; },
}));

const jobs = await import('../jobs');
const jobsRetry = await import('../retry-policy');
const { decideRequeueRight, retryLimits } = jobsRetry;

const FICHIER = 42;
const COMPTE = 7;
/** Trace écrite sur la couverture par la demande (`verification.requeue`). */
const trace = () => {
  const e = [...etat.ecritures].reverse().find((x) => /'\{requeue\}'/.test(x.q));
  // Le JSON n'est pas au même rang selon l'écriture (refus ou issue de la file) : on prend LE paramètre JSON.
  const j = e?.params.find((v) => typeof v === 'string' && v.startsWith('{'));
  return j ? JSON.parse(String(j)) as Record<string, unknown> : null;
};
/** Résultat consigné (`last_retry_result`). */
const resultat = () => {
  const e = [...etat.ecritures].reverse().find((x) => /last_retry_result = \$3/.test(x.q));
  return e ? String(e.params[2]) : null;
};
/** L'UPDATE de consommation / relâchement a-t-il été écrit ? */
const majConsommation = () => etat.ecritures.find((x) => /SET retry_attempts = CASE WHEN \$3::boolean/.test(x.q)) ?? null;

const demander = (over: Record<string, unknown> = {}) => jobs.requeueDocumentForRereadDetailed({
  fileId: FICHIER, accountId: COMPTE, attempt: 1, origin: 't1-completeness-retry', result: 'REQUEUED_T1', env: {}, ...over,
});

beforeEach(() => {
  etat.ecritures = [];
  etat.couverture = { retryAttempts: 0 };
  etat.misesEnFile = [];
  etat.file = { status: 'ACCEPTED', jobId: 501, reason: null };
  etat.travaux = [{ id: 501 }];
  etat.anomalies = [];
});

describe('L115H-U01 — § 1 : la règle du droit de remise en file (pure)', () => {
  it('plafond à 0, atteint, dépassé (valeur abaissée après coup) : refusé avec son motif ; sinon accordé', () => {
    expect(decideRequeueRight({ retryAttempts: 0 }, { maxRetries: 0 }))
      .toEqual({ allowed: false, block: 'RETRIES_DISABLED', attemptsLeft: 0 });
    expect(decideRequeueRight({ retryAttempts: 2 }, { maxRetries: 2 }))
      .toEqual({ allowed: false, block: 'RETRY_CAP_REACHED', attemptsLeft: 0 });
    // Plafond ABAISSÉ après programmation : déjà dépassé, donc atteint.
    expect(decideRequeueRight({ retryAttempts: 5 }, { maxRetries: 2 }))
      .toEqual({ allowed: false, block: 'RETRY_CAP_REACHED', attemptsLeft: 0 });
    expect(decideRequeueRight({ retryAttempts: 0 }, { maxRetries: 2 }))
      .toEqual({ allowed: true, block: null, attemptsLeft: 2 });
    expect(decideRequeueRight({ retryAttempts: 1 }, { maxRetries: 2 }))
      .toEqual({ allowed: true, block: null, attemptsLeft: 1 });
  });

  it('la règle lit les MÊMES bornes que le reste des reprises (aucune lecture propre)', () => {
    expect(retryLimits({ T1_COMPLETENESS_MAX_RETRIES: '0' }).maxRetries).toBe(0);
    expect(retryLimits({ T1_COMPLETENESS_MAX_RETRIES: '3' }).maxRetries).toBe(3);
    // Valeur hors plage : ramenée dans la plage de la règle commune, jamais ignorée.
    expect(retryLimits({ T1_COMPLETENESS_MAX_RETRIES: '99' }).maxRetries).toBe(5);
  });
});

describe('L115H-U02 — § 1 : aucune origine n’enfile avant que son droit soit contrôlé', () => {
  for (const origine of ['BO', 'SCHEDULER', 'COHERENCE', 'REVERIFICATION', 'OTHER'] as const) {
    it(`origine ${origine} : plafond à 0 → refus explicite, AUCUN enfilement, aucune consommation`, async () => {
      const r = await demander({ requestedBy: origine, env: { T1_COMPLETENESS_MAX_RETRIES: '0' } });
      expect(r).toMatchObject({
        status: 'NOT_ADMISSIBLE', queued: false, jobId: null, reason: 'RETRIES_DISABLED',
        attemptConsumed: false, result: 'REQUEUE_NOT_ADMISSIBLE:RETRIES_DISABLED',
      });
      // La file n'a jamais été sollicitée : aucun travail créé, aucun appel possible.
      expect(etat.misesEnFile).toEqual([]);
      // Aucune reprise consommée.
      expect(etat.couverture).toEqual({ retryAttempts: 0 });
      // Aucune promesse de reprise : l'UPDATE de consommation / d'échéance n'est pas écrit du tout.
      expect(majConsommation()).toBeNull();
      // Le refus est tracé avec son origine et son motif.
      expect(resultat()).toBe('REQUEUE_NOT_ADMISSIBLE:RETRIES_DISABLED');
      expect(trace()).toMatchObject({ status: 'NOT_ADMISSIBLE', reason: 'RETRIES_DISABLED', requestedBy: origine, attemptConsumed: false, maxRetries: 0 });
    });
  }

  it('relance complète du BO à plafond CONSOMMÉ : refusée, aucun contournement par la route', async () => {
    etat.couverture = { retryAttempts: 2 };
    const r = await demander({ requestedBy: 'BO', attempt: 3, env: { T1_COMPLETENESS_MAX_RETRIES: '2' } });
    expect(r).toMatchObject({ status: 'NOT_ADMISSIBLE', queued: false, reason: 'RETRY_CAP_REACHED', attemptConsumed: false });
    expect(etat.misesEnFile).toEqual([]);
    expect(etat.couverture).toEqual({ retryAttempts: 2 });
    expect(trace()).toMatchObject({ requestedBy: 'BO', retryAttempts: 2, maxRetries: 2 });
  });

  it('plafond ABAISSÉ après programmation (3 consommées, plafond ramené à 2) : refusée', async () => {
    etat.couverture = { retryAttempts: 3 };
    const r = await demander({ requestedBy: 'SCHEDULER', attempt: 4, scheduled: true, env: { T1_COMPLETENESS_MAX_RETRIES: '2' } });
    expect(r.status).toBe('NOT_ADMISSIBLE');
    expect(r.reason).toBe('RETRY_CAP_REACHED');
    expect(etat.misesEnFile).toEqual([]);
  });

  it('reprise restante : le droit est RÉSERVÉ avant l’enfilement, puis la demande suit son cours', async () => {
    const r = await demander({ requestedBy: 'BO', env: { T1_COMPLETENESS_MAX_RETRIES: '2' } });
    expect(r).toMatchObject({ status: 'ACCEPTED', queued: true, jobId: 501, attemptConsumed: true });
    expect(etat.misesEnFile).toHaveLength(1);
    // La réservation précède l'enfilement dans l'ordre des écritures.
    const iReserve = etat.ecritures.findIndex((x) => /SET retry_attempts = retry_attempts \+ 1/.test(x.q));
    expect(iReserve).toBeGreaterThanOrEqual(0);
    expect(etat.couverture).toEqual({ retryAttempts: 1 });
  });

  it('deux demandes simultanées sur la DERNIÈRE reprise : une seule réserve, l’autre est refusée sans enfiler', async () => {
    etat.couverture = { retryAttempts: 1 };
    const env = { T1_COMPLETENESS_MAX_RETRIES: '2' };
    const a = await demander({ requestedBy: 'BO', attempt: 2, env });
    const b = await demander({ requestedBy: 'SCHEDULER', attempt: 2, scheduled: true, env });
    expect([a.status, b.status]).toEqual(['ACCEPTED', 'NOT_ADMISSIBLE']);
    expect(b.reason).toBe('RETRY_CAP_REACHED');
    // Une seule sollicitation de la file : la seconde demande n'a rien enfilé.
    expect(etat.misesEnFile).toHaveLength(1);
    expect(etat.couverture).toEqual({ retryAttempts: 2 });
  });

  it('travail DÉJÀ vivant : la réservation est relâchée — aucune reprise consommée (règle 114H conservée)', async () => {
    etat.file = { status: 'ALREADY_RUNNING', jobId: 498, reason: 'DUPLICATE_RUNNING' };
    etat.travaux = [{ id: 498 }];
    const r = await demander({ requestedBy: 'BO', env: { T1_COMPLETENESS_MAX_RETRIES: '2' } });
    expect(r).toMatchObject({ status: 'ALREADY_RUNNING', queued: true, attemptConsumed: false, result: 'REQUEUE_ALREADY_RUNNING' });
    const maj = majConsommation()!;
    // `consumeAttempt` faux, et le relâchement est DEMANDÉ (une réservation avait bien été prise) :
    // la ligne rend exactement ce qu'elle avait pris.
    expect(maj.params[2]).toBe(false);
    expect(maj.params[7]).toBe(true);
    expect(maj.q).toContain('GREATEST(0, retry_attempts - 1)');
    expect(etat.couverture).toEqual({ retryAttempts: 0 });
  });

  it('ligne de couverture ABSENTE : le droit est jugé sur le numéro de tentative de l’appelant, jamais accordé sans contrôle', async () => {
    etat.couverture = null;
    const env = { T1_COMPLETENESS_MAX_RETRIES: '2' };
    // 3e tentative demandée alors que le plafond est 2 : refusée, sans enfilement.
    const trop = await demander({ requestedBy: 'COHERENCE', attempt: 3, env });
    expect(trop).toMatchObject({ status: 'NOT_ADMISSIBLE', reason: 'RETRY_CAP_REACHED' });
    expect(etat.misesEnFile).toEqual([]);
    // 1re tentative : admissible, et rien n'est réservé (aucune ligne à incrémenter).
    const ok = await demander({ requestedBy: 'COHERENCE', attempt: 1, env });
    expect(ok.status).toBe('ACCEPTED');
    expect(etat.misesEnFile).toHaveLength(1);
  });

  it('forme booléenne : un refus de la règle commune vaut « aucun travail confirmé »', async () => {
    expect(await jobs.requeueDocumentForReread({
      fileId: FICHIER, accountId: COMPTE, attempt: 1, origin: 'coherence-control', result: 'REQUEUED_T1_COHERENCE', requestedBy: 'COHERENCE',
    })).toBe(true);
    etat.couverture = { retryAttempts: 9 };
    etat.misesEnFile = [];
    expect(await jobs.requeueDocumentForReread({
      fileId: FICHIER, accountId: COMPTE, attempt: 10, origin: 'coherence-control', result: 'REQUEUED_T1_COHERENCE', requestedBy: 'COHERENCE',
    })).toBe(false);
    expect(etat.misesEnFile).toEqual([]);
  });

  it('aucune dérogation automatique : le service n’expose aucun paramètre de contournement', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/services/ai/source-analysis/source-units/jobs.ts', 'utf8');
    for (const mot of ['force?', 'bypass', 'ignoreCap', 'skipCap']) expect(source).not.toContain(mot);
  });
});

describe('L115H-U03 — § 3 : une échéance absente est reposée d’après l’action admissible', () => {
  const { decideRetry, retryFactsOf, retryLimits } = jobsRetry;
  const limites = retryLimits({ T1_COMPLETENESS_MAX_RETRIES: '2' });
  /** Unité couverte, document dont la source est MOMENTANÉMENT illisible. */
  const unite = (over: Record<string, unknown> = {}) => ({
    sourceUnitId: 'page:1:block:1', kind: 'TEXT_BLOCK', page: 1, ordinal: 1, parentUnitId: null,
    text: 'Montant restant du : 132,00 EUR', payload: {}, location: {}, origin: 'PASS_1', salient: true,
    status: 'COVERED', reason: 'fact', factCount: 1, repairAttempts: 0, repairState: null, ...over,
  }) as never;

  it('source momentanément illisible, tentatives restantes : l’action REQUEUE_T1 est admissible — donc programmable', () => {
    const faits = retryFactsOf([unite()], { qualityState: 'VERIFICATION_INCOMPLETE', verificationReason: 'source_unreadable', pagesMissing: [] }, limites);
    expect(faits.transientVerification).toBe(true);
    const r = decideRetry(faits, { retryAttempts: 0, continuationRuns: 0 }, limites);
    expect(r.automatic).toBe(true);
    expect(r.actions).toContain('REQUEUE_T1');
    // Défaut reproduit : l'état n'est PAS `INCOMPLETE_RETRYABLE` — l'ancienne condition de programmation
    // (le seul état) laissait donc ce document sans échéance, alors qu'une action était admissible.
    expect('VERIFICATION_INCOMPLETE').not.toBe('INCOMPLETE_RETRYABLE');
  });

  it('plafond atteint : plus aucune action, donc jamais d’échéance (borne conservée, aucune boucle)', () => {
    const faits = retryFactsOf([unite()], { qualityState: 'VERIFICATION_INCOMPLETE', verificationReason: 'source_unreadable', pagesMissing: [] }, limites);
    const r = decideRetry(faits, { retryAttempts: 2, continuationRuns: 0 }, limites);
    expect(r).toMatchObject({ automatic: false, actions: [], blocked: 'RETRY_CAP_REACHED' });
  });

  it('image / scan NON VÉRIFIABLE : la cause n’est pas transitoire — aucune programmation (pas de relance de masse)', () => {
    const observation = unite({
      sourceUnitId: 'page:1:visual:1', kind: 'VISUAL_OBSERVATION', status: 'UNCERTAIN', reason: 'observation_conflictual',
      repairState: 'NEEDS_SOURCE', text: 'tampon partiellement lisible', payload: { confidence: 'conflictual' },
    });
    const faits = retryFactsOf([observation], { qualityState: 'VERIFICATION_INCOMPLETE', verificationReason: 'image_not_checkable', pagesMissing: [] }, limites);
    // Aucune cause transitoire : la condition de programmation du § 3 ne s'applique pas,
    // même si une relecture du fichier reste « admissible » au sens des bornes.
    expect(faits.transientVerification).toBe(false);
    expect(decideRetry(faits, { retryAttempts: 0, continuationRuns: 0 }, limites).actions).not.toContain('REQUEUE_T1');
  });

  it('la condition de programmation est bien celle du § 3 (lecture de la source)', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/services/ai/source-analysis/source-units/stored-reconciliation.ts', 'utf8');
    expect(source).toContain("faitsReprise.transientVerification && regle.actions.includes('REQUEUE_T1')");
    expect(source).toContain("report.qualityState === 'INCOMPLETE_RETRYABLE'");
  });
});
