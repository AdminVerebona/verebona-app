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

import { creerSimulateurDemandes, type DemandeSimulee } from './fixtures/c837-requeue-sim';

const etat = vi.hoisted(() => ({
  ecritures: [] as Array<{ q: string; params: unknown[] }>,
  /** Ligne de couverture servie aux lectures (`null` : document sans couche A relue). */
  couverture: null as { retryAttempts: number } | null,
  /** Sollicitations RÉELLES de la file T1 : une demande refusée n'en produit aucune. */
  misesEnFile: [] as Array<{ fileIds: number[]; accountId: number; onRunning?: string }>,
  file: { status: 'ACCEPTED', jobId: 501, reason: null } as { status: string; jobId: number | null; reason: string | null },
  travaux: [{ id: 501, status: 'PENDING', business_result: null }] as Array<{ id: number; status: string; business_result: string | null }>,
  anomalies: [] as Array<{ action: string; fingerprint: string }>,
  /**
   * Migrations 1805 / 1970 appliquées ? Carte #837 (A3) : elles sont OBLIGATOIRES pour la remise en file —
   * leur absence est un refus visible (testé à part).
   */
  identiteDisponible: true,
  /** La file simulée crée le travail accepté (carte #837). */
  creerTravail: false,
  /** Preuves servies par la lecture initiale (carte #785, § 2) : les changer rend la demande DISTINCTE. */
  preuves: {} as Record<string, unknown>,
  /** Carte #837 (C2) : empreinte servie pour CHAQUE famille de dépendances (faits, décisions…). */
  deps: 'h0',
  /** Double en mémoire de `t1_requeue_requests` (posé après les imports). */
  sim: null as null | { store: { lignes: DemandeSimulee[]; seq: number }; traiter: (x: string, p: unknown[]) => unknown[] | undefined },
}));

const requete = vi.hoisted(() => async (q: string, params: unknown[] = []) => {
  const x = q.replace(/\s+/g, ' ').trim();
  etat.ecritures.push({ q: x, params });
  // Lot 115H (#785, § 2) : la lecture initiale rend aussi les PREUVES du document (empreinte de la demande).
  if (/SELECT c.retry_attempts, c.quality_state/.test(x)) {
    return etat.couverture
      ? [{
        retry_attempts: etat.couverture.retryAttempts, quality_state: 'VERIFICATION_INCOMPLETE', anomalies: [],
        unresolved_units: 1, uncertain_units: 0, failed_units: 0, layer_version: 1,
        source_verification: 'PARTIAL', verification: { verificationReason: 'source_unreadable' }, source_sha256: 'abc',
        ...etat.preuves,
      }]
      : [];
  }
  // Migration 1805 absente par défaut : aucune identité persistante (le code retombe sur le § 1 seul).
  if (/to_regclass\('t1_requeue_requests'\)/.test(x)) return [{ ok: etat.identiteDisponible }];
  if (/c837:evidence-tables/.test(x)) return [];
  if (/c837:evidence-deps/.test(x)) return [{ h: etat.deps, n: 1 }];
  const simule = etat.sim?.traiter(x, params);
  if (simule !== undefined) return simule;
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
  if (/FROM ai_job_queue/.test(x)) {
    // Même sélection que `inspectCorrelatedJob` : le travail désigné, ou un travail vivant ; vivant d'abord.
    const vise = params[4] == null ? null : Number(params[4]);
    const vivant = (t: { status: string }) => t.status === 'PENDING' || t.status === 'RUNNING';
    return etat.travaux.filter((t) => vise === null || t.id === vise || vivant(t))
      .sort((a, b) => Number(vivant(b)) - Number(vivant(a)) || b.id - a.id).slice(0, 1);
  }
  if (/'requeue' ->> 'transientRefusals'/.test(x)) return [{ refus: '0' }];
  return [];
});

vi.mock('@/db', () => ({
  pgClient: { unsafe: requete, begin: async (fn: (tx: { unsafe: typeof requete }) => Promise<unknown>) => fn({ unsafe: requete }) },
  db: {},
}));
vi.mock('../../queue/t1-handler', async (orig) => ({
  ...(await orig<typeof import('../../queue/t1-handler')>()),
  enqueueFileAnalysesDetailed: async (fileIds: number[], accountId: number, options: { onRunning?: string }) => {
    etat.misesEnFile.push({ fileIds, accountId, onRunning: options?.onRunning });
    // Carte #837 : la file CRÉE réellement le travail accepté (sinon le contrôle final ne le trouve pas).
    if (etat.creerTravail && etat.file.status === 'ACCEPTED' && etat.file.jobId !== null && !etat.travaux.some((t) => t.id === etat.file.jobId)) {
      etat.travaux.push({ id: etat.file.jobId, status: 'PENDING', business_result: null });
    }
    return fileIds.map((fileId) => ({ fileId, ...etat.file }));
  },
}));
vi.mock('@/services/admin/anomaly.service', () => ({
  reportAnomaly: async (p: { fingerprint: string }) => { etat.anomalies.push({ action: 'report', fingerprint: p.fingerprint }); return 1; },
  autoResolveAnomaly: async (fingerprint: string) => { etat.anomalies.push({ action: 'resolve', fingerprint }); return true; },
}));

etat.sim = creerSimulateurDemandes({ couverture: () => etat.couverture });
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

beforeEach(async () => {
  etat.ecritures = [];
  etat.couverture = { retryAttempts: 0 };
  etat.misesEnFile = [];
  etat.file = { status: 'ACCEPTED', jobId: 501, reason: null };
  etat.travaux = [{ id: 501, status: 'PENDING', business_result: null }];
  etat.anomalies = [];
  etat.identiteDisponible = true;
  etat.creerTravail = false;
  etat.preuves = {};
  etat.deps = 'h0';
  etat.sim!.store.lignes = [];
  etat.sim!.store.seq = 0;
  (await import('../requeue-identity')).resetRequeueRequestsReadyCache();
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

  // Carte #837 (A3) : la MÊME demande métier portée par le BO puis par le planificateur a désormais UNE identité —
  // la seconde CONSTATE le travail vivant (aucune consommation). Le cas « plafond » est donc prouvé avec deux
  // demandes réellement DISTINCTES (preuves différentes) sur la dernière reprise.
  it('deux demandes DISTINCTES sur la DERNIÈRE reprise : une seule réserve, l’autre est refusée sans enfiler', async () => {
    etat.couverture = { retryAttempts: 1 };
    const env = { T1_COMPLETENESS_MAX_RETRIES: '2' };
    const a = await demander({ requestedBy: 'BO', attempt: 2, env });
    etat.preuves = { unresolved_units: 7 };
    const b = await demander({ requestedBy: 'SCHEDULER', attempt: 2, scheduled: true, env });
    expect([a.status, b.status]).toEqual(['ACCEPTED', 'NOT_ADMISSIBLE']);
    expect(b.reason).toBe('RETRY_CAP_REACHED');
    // Une seule sollicitation de la file : la seconde demande n'a rien enfilé.
    expect(etat.misesEnFile).toHaveLength(1);
    expect(etat.couverture).toEqual({ retryAttempts: 2 });
  });

  it('travail DÉJÀ vivant : la réservation est relâchée — aucune reprise consommée (règle 114H conservée)', async () => {
    etat.file = { status: 'ALREADY_RUNNING', jobId: 498, reason: 'DUPLICATE_RUNNING' };
    etat.travaux = [{ id: 498, status: 'RUNNING', business_result: null }];
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
    // Preuve différente : demande distincte (sinon la même demande constaterait le travail vivant — carte #837, A3).
    etat.preuves = { unresolved_units: 5 };
    etat.misesEnFile = [];
    expect(await jobs.requeueDocumentForReread({
      fileId: FICHIER, accountId: COMPTE, attempt: 10, origin: 'coherence-control', result: 'REQUEUED_T1_COHERENCE', requestedBy: 'COHERENCE',
    })).toBe(false);
    expect(etat.misesEnFile).toEqual([]);
  });

  it('carte #837 (A3) : migrations 1805 / 1970 ABSENTES — refus VISIBLE (fail-closed), aucun enfilement, aucune consommation', async () => {
    etat.identiteDisponible = false;
    const r = await demander({ requestedBy: 'BO', env: { T1_COMPLETENESS_MAX_RETRIES: '2' } });
    expect(r).toMatchObject({ status: 'NOT_ADMISSIBLE', queued: false, reason: 'IDENTITY_UNAVAILABLE', attemptConsumed: false });
    expect(etat.misesEnFile).toEqual([]);
    expect(etat.couverture).toEqual({ retryAttempts: 0 });
    expect(resultat()).toBe('REQUEUE_NOT_ADMISSIBLE:IDENTITY_UNAVAILABLE');
    // Visible en Supervision.
    expect(etat.anomalies).toContainEqual({ action: 'report', fingerprint: 'ai:t1-requeue-identity-unavailable' });
  });

  it('carte #837 (A1) : refus d’admission (compte non éligible) AVANT tout enfilement — aucune réservation, demande tracée', async () => {
    etat.preuves = { account_eligible: false, file_present: true, file_alive: true };
    const r = await demander({ requestedBy: 'SCHEDULER', scheduled: true, env: { T1_COMPLETENESS_MAX_RETRIES: '2' } });
    expect(r).toMatchObject({ status: 'NOT_ADMISSIBLE', reason: 'ACCOUNT_NOT_ELIGIBLE', attemptConsumed: false });
    expect(etat.misesEnFile).toEqual([]);
    expect(etat.couverture).toEqual({ retryAttempts: 0 });
    expect(etat.sim!.store.lignes[0]).toMatchObject({ state: 'REFUSED', reason: 'ACCOUNT_NOT_ELIGIBLE' });
    // Cause TEMPORAIRE d'une demande planifiée : elle reste due (échéance reposée), jamais une promesse fictive.
    expect(trace()).toMatchObject({ status: 'NOT_ADMISSIBLE', reason: 'ACCOUNT_NOT_ELIGIBLE', temporary: true });
    etat.preuves = { file_present: true, file_alive: false };
    const supprime = await demander({ requestedBy: 'BO', env: { T1_COMPLETENESS_MAX_RETRIES: '2' } });
    expect(supprime).toMatchObject({ status: 'NOT_ADMISSIBLE', reason: 'SOURCE_NOT_AVAILABLE' });
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

// ════════════════════════════════════════════════════════════════════════════
// § 2 — UNE DEMANDE IDENTIQUE NE CRÉE PAS DE PASSAGE SUPPLÉMENTAIRE
// ════════════════════════════════════════════════════════════════════════════
describe('L115H-U04 — § 2 : la file ne reçoit plus de passage supplémentaire pour une demande identique', () => {
  it('règle de file (pure) : un travail EN COURS est coalescé par défaut, seulement CONSTATÉ en « OBSERVE_ONLY »', async () => {
    const { decideQueueing } = await import('../../../queue/queue-policy');
    // Coalescence légitime des autres traitements : conservée telle quelle (défaut).
    expect(decideQueueing({ status: 'RUNNING' }, 'automatic')).toBe('coalesce');
    expect(decideQueueing({ status: 'RUNNING' }, 'automatic', 'EXTRA_PASS')).toBe('coalesce');
    // Demande identique à ce que l'exécution satisfait déjà : constat, aucun passage supplémentaire.
    expect(decideQueueing({ status: 'RUNNING' }, 'automatic', 'OBSERVE_ONLY')).toBe('skip');
    // Le reste du WF-10 est inchangé.
    expect(decideQueueing({ status: 'PENDING' }, 'automatic', 'OBSERVE_ONLY')).toBe('skip');
    expect(decideQueueing(null, 'automatic', 'OBSERVE_ONLY')).toBe('create');
    expect(decideQueueing({ status: 'RUNNING' }, 'manual', 'OBSERVE_ONLY')).toBe('create');
    expect(decideQueueing({ status: 'DONE' }, 'automatic', 'OBSERVE_ONLY')).toBe('create');
  });

  it('la reprise T1 demande « OBSERVE_ONLY » à la file (sinon une seconde analyse naîtrait à la clôture)', async () => {
    await demander({ requestedBy: 'BO', env: { T1_COMPLETENESS_MAX_RETRIES: '2' } });
    expect(etat.misesEnFile).toHaveLength(1);
    expect(etat.misesEnFile[0].onRunning).toBe('OBSERVE_ONLY');
  });

  it('`OBSERVED_RUNNING` est traduit en « travail vivant constaté », jamais en refus', async () => {
    const { t1EnqueueOutcomeOf, t1EnqueueConfirmed } = await import('../../queue/t1-handler');
    const o = t1EnqueueOutcomeOf(42, { decision: 'skip', jobId: 77, reasonCode: 'OBSERVED_RUNNING' });
    expect(o).toEqual({ fileId: 42, status: 'ALREADY_RUNNING', jobId: 77, reason: 'OBSERVED_RUNNING' });
    expect(t1EnqueueConfirmed(o)).toBe(true);
  });

  it('empreinte des preuves : identique sur des preuves identiques, DIFFÉRENTE dès qu’une preuve change', async () => {
    const { requeueEvidenceFingerprint, requeueRequestKey } = await import('../requeue-identity');
    const base = {
      qualityState: 'VERIFICATION_INCOMPLETE', anomalies: ['COVERAGE_UNVERIFIED'], verificationReason: 'source_unreadable',
      sourceVerification: 'PARTIAL', pagesMissing: [2, 1], unresolvedUnits: 3, uncertainUnits: 0, failedUnits: 0,
      reverificationFingerprint: 'aa', sourceSha256: 'bb', layerVersion: 4,
    };
    const a = requeueEvidenceFingerprint(base);
    // Idempotence, y compris sur l'ordre des pages et des anomalies.
    expect(requeueEvidenceFingerprint({ ...base, pagesMissing: [1, 2] })).toBe(a);
    // Chaque preuve qui change donne une demande DISTINCTE.
    for (const diff of [
      { sourceSha256: 'cc' }, { reverificationFingerprint: 'zz' }, { pagesMissing: [1, 2, 3] },
      { unresolvedUnits: 4 }, { qualityState: 'INCOMPLETE_FINAL' }, { layerVersion: 5 },
    ]) expect(requeueEvidenceFingerprint({ ...base, ...diff })).not.toBe(a);
    // Carte #837 (A3) : l'identité est CANONIQUE — action + empreinte ; le canal n'en fait plus partie.
    expect(requeueRequestKey({ action: 'COMPLETENESS_REREAD', evidenceFingerprint: a }))
      .toBe(`COMPLETENESS_REREAD:${a}`);
    expect(requeueRequestKey({ action: 'COMPLETENESS_REREAD', evidenceFingerprint: a }))
      .not.toBe(requeueRequestKey({ action: 'COHERENCE_REEXTRACT', evidenceFingerprint: a }));
    expect(requeueRequestKey({ action: 'COMPLETENESS_REREAD', evidenceFingerprint: a, explicit: ' choisie ' })).toBe('choisie');
  });

  it('demande IDENTIQUE déjà servie par un travail VIVANT : constatée, aucun enfilement, aucune consommation', async () => {
    etat.identiteDisponible = true;
    etat.travaux = [{ id: 501, status: 'RUNNING', business_result: null }];
    const env = { T1_COMPLETENESS_MAX_RETRIES: '2' };
    // 1er clic : accepté, une reprise réservée puis consommée.
    const un = await demander({ requestedBy: 'BO', env });
    expect(un.status).toBe('ACCEPTED');
    expect(etat.misesEnFile).toHaveLength(1);
    expect(etat.couverture).toEqual({ retryAttempts: 1 });
    // 2e et 3e clics, preuves inchangées : la MÊME demande est retrouvée et seulement constatée.
    for (const n of [2, 3]) {
      const bis = await demander({ requestedBy: 'BO', env });
      expect(bis, `clic ${n}`).toMatchObject({
        status: 'IDENTICAL_REQUEST_ALIVE', queued: true, jobId: 501, attemptConsumed: false, result: 'REQUEUE_IDENTICAL_ALIVE',
      });
    }
    // Aucun enfilement supplémentaire : donc aucun passage supplémentaire, aucun appel masqué.
    expect(etat.misesEnFile).toHaveLength(1);
    expect(etat.couverture).toEqual({ retryAttempts: 1 });
    expect(etat.sim!.store.lignes).toHaveLength(1);
    expect(etat.sim!.store.lignes[0]).toMatchObject({ state: 'OBSERVED', job_id: 501, attempt_consumed: true });
  });

  it('demande identique déjà servie par un travail TERMINÉ : non rejouée (preuves inchangées), rien de consommé', async () => {
    etat.identiteDisponible = true;
    const env = { T1_COMPLETENESS_MAX_RETRIES: '2' };
    await demander({ requestedBy: 'SCHEDULER', scheduled: true, env });
    // Carte #837 (A2) : « acquis » exige un résultat MÉTIER réussi.
    etat.travaux = [{ id: 501, status: 'DONE', business_result: 'APPLIED' }];
    const bis = await demander({ requestedBy: 'SCHEDULER', scheduled: true, env });
    expect(bis).toMatchObject({ status: 'ALREADY_SATISFIED', queued: false, attemptConsumed: false, result: 'REQUEUE_ALREADY_SATISFIED' });
    expect(etat.misesEnFile).toHaveLength(1);
    expect(etat.couverture).toEqual({ retryAttempts: 1 });
  });

  it('carte #837 (A2) : travail TERMINÉ en ÉCHEC MÉTIER — jamais « acquis » : nouvelle tentative explicite, dans ses bornes', async () => {
    const env = { T1_COMPLETENESS_MAX_RETRIES: '2' };
    await demander({ requestedBy: 'SCHEDULER', scheduled: true, env });
    etat.travaux = [{ id: 501, status: 'DONE', business_result: 'FAILED' }];
    etat.file = { status: 'ACCEPTED', jobId: 502, reason: null };
    etat.creerTravail = true;
    const bis = await demander({ requestedBy: 'BO', env });
    expect(bis).toMatchObject({ status: 'ACCEPTED', queued: true, attemptConsumed: true });
    expect(etat.misesEnFile).toHaveLength(2);
    expect(etat.couverture).toEqual({ retryAttempts: 2 });
    // Même demande canonique, DEUX cycles : le premier est conservé dans l'historique.
    expect(etat.sim!.store.lignes).toHaveLength(1);
    expect(etat.sim!.store.lignes[0]).toMatchObject({ cycles: 2, state: 'CONFIRMED' });
    expect(etat.sim!.store.lignes[0].history).toHaveLength(1);
  });

  it('travail ÉCHOUÉ entre deux contrôles : la demande n’est PAS confirmée (jamais « remise en file réussie »)', async () => {
    etat.travaux = [{ id: 501, status: 'FAILED', business_result: null }];
    const r = await demander({ requestedBy: 'BO', env: { T1_COMPLETENESS_MAX_RETRIES: '2' } });
    expect(r.queued).toBe(false);
    expect(r.reason).toBe('JOB_FAILED_AFTER_ENQUEUE');
  });

  it('aucun travail du document après l’enfilement : refus transitoire explicite, jamais un succès', async () => {
    etat.travaux = [];
    const r = await demander({ requestedBy: 'BO', env: { T1_COMPLETENESS_MAX_RETRIES: '2' } });
    expect(r).toMatchObject({ status: 'REJECTED_TRANSIENT', queued: false, reason: 'JOB_NOT_FOUND_AFTER_ENQUEUE' });
  });

  it('preuve NOUVELLE : la demande est DISTINCTE — droit réservé et consommation exacte, pas un simple doublon', async () => {
    etat.identiteDisponible = true;
    etat.travaux = [{ id: 501, status: 'RUNNING', business_result: null }];
    const env = { T1_COMPLETENESS_MAX_RETRIES: '2' };
    await demander({ requestedBy: 'BO', env });
    expect(etat.couverture).toEqual({ retryAttempts: 1 });
    // La couverture change de preuve (le document a été relu) : identité différente.
    etat.preuves = { quality_state: 'INCOMPLETE_FINAL', verification: { verificationReason: 'pages_missing', pagesMissing: [3] } };
    const autre = await demander({ requestedBy: 'BO', env });
    expect(autre.status).toBe('ACCEPTED');
    expect(autre.attemptConsumed).toBe(true);
    expect(etat.misesEnFile).toHaveLength(2);
    expect(etat.couverture).toEqual({ retryAttempts: 2 });
    expect(etat.sim!.store.lignes).toHaveLength(2);
  });

  it('réservation ACQUISE avant un arrêt : elle est REPRISE, jamais doublée (compteur exact)', async () => {
    etat.identiteDisponible = true;
    // Une demande a réservé la reprise 1 puis le processus s'est arrêté (aucune étape au-delà).
    etat.sim!.store.lignes.push({
      id: 1, account_id: COMPTE, file_id: FICHIER, request_key: 'BO:t1-completeness-retry:peu-importe',
      state: 'RESERVED', reserved_attempt: 1, attempt_consumed: false, job_id: null, reason: null, steps: { reserved: true },
      // Carte #837 : ligne antérieure à la migration 1970 (aucun bail) — considérée à bail expiré, donc reprise.
      origin: 't1-completeness-retry', requested_by: 'BO', evidence_fingerprint: null, lease_token: null, lease_expires_at: null,
      cycles: 1, history: [], campaign_ref: null, updated_at: Date.now(),
    });
    etat.sim!.store.seq = 1;
    etat.couverture = { retryAttempts: 1 };
    const r = await demander({ requestedBy: 'BO', requestKey: 'BO:t1-completeness-retry:peu-importe', env: { T1_COMPLETENESS_MAX_RETRIES: '2' } });
    expect(r.status).toBe('ACCEPTED');
    // La réservation n'est PAS reprise une seconde fois : le compteur reste à 1 (consommation de celle déjà prise).
    expect(etat.couverture).toEqual({ retryAttempts: 1 });
    expect(etat.sim!.store.lignes[0]).toMatchObject({ state: 'CONFIRMED', attempt_consumed: true });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// § 3 (reste) — « ACHEVÉ » EXIGE UNE ACTION PERSISTÉE ET CONFIRMÉE
// ════════════════════════════════════════════════════════════════════════════
describe('L115H-U05 — § 3 : un traitement n’est journalisé achevé qu’avec une action confirmée', () => {
  const base = {
    reconciliation: 'APPLIED' as const, scheduledDecided: true, scheduledPersisted: true,
    qualityDecided: 'INCOMPLETE_RETRYABLE', qualityPersisted: 'INCOMPLETE_RETRYABLE',
    explicitRefusal: null, noActionReason: null,
  };

  it('action décidée RETROUVÉE en base : achevé', async () => {
    const { reassessmentCompletionOf } = await import('../historical-reassessment');
    expect(reassessmentCompletionOf(base).complete).toBe(true);
  });

  it('échéance décidée mais ABSENTE en base : NON achevé (défaut reproduit)', async () => {
    const { reassessmentCompletionOf } = await import('../historical-reassessment');
    const r = reassessmentCompletionOf({ ...base, scheduledPersisted: false });
    expect(r.complete).toBe(false);
    expect(r.reason).toContain('aucune échéance persistée');
  });

  it('état décidé absent en base, ou état non relisible : NON achevé', async () => {
    const { reassessmentCompletionOf } = await import('../historical-reassessment');
    expect(reassessmentCompletionOf({ ...base, qualityPersisted: 'COMPLETE_WITH_UNRESOLVED' }).complete).toBe(false);
    expect(reassessmentCompletionOf({ ...base, qualityPersisted: null }).complete).toBe(false);
  });

  it('REFUS EXPLICITE reprenable : achevé, avec sa cause nommée', async () => {
    const { reassessmentCompletionOf, refusExplicite } = await import('../historical-reassessment');
    expect(refusExplicite('REQUEUE_NOT_ADMISSIBLE:RETRY_CAP_REACHED')).toBe('REQUEUE_NOT_ADMISSIBLE:RETRY_CAP_REACHED');
    expect(refusExplicite('REQUEUE_ACCOUNT_NOT_ELIGIBLE')).toBe('REQUEUE_ACCOUNT_NOT_ELIGIBLE');
    expect(refusExplicite('REQUEUED_T1')).toBeNull();
    expect(refusExplicite(null)).toBeNull();
    const r = reassessmentCompletionOf({ ...base, scheduledPersisted: false, explicitRefusal: 'REQUEUE_REJECTED_TRANSIENT' });
    expect(r).toMatchObject({ complete: true });
    expect(r.reason).toContain('refus explicite reprenable');
  });

  it('ABSENCE d’action JUSTIFIÉE : achevé ; conflit d’écriture : NON achevé, rien n’est écrit', async () => {
    const { reassessmentCompletionOf } = await import('../historical-reassessment');
    const sans = reassessmentCompletionOf({ ...base, scheduledDecided: false, scheduledPersisted: false, noActionReason: 'RETRY_CAP_REACHED' });
    expect(sans).toMatchObject({ complete: true });
    expect(sans.reason).toContain('absence d’action justifiée');
    expect(reassessmentCompletionOf({ ...base, reconciliation: 'CONFLICT_DEFERRED' }).complete).toBe(false);
    // Aucune couche A : l'absence d'action est justifiée par construction.
    expect(reassessmentCompletionOf({ ...base, reconciliation: 'NO_LAYER' }).complete).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// § 4 — CONTRÔLE DE VERSION, SÉRIALISATION, REPRISE APRÈS PANNE
// ════════════════════════════════════════════════════════════════════════════
describe('L115H-U06 — § 4 : la réconciliation enregistrée ne peut pas écraser une couche plus récente', () => {
  it('la version lue est portée jusqu’à l’écriture, qui verrouille la ligne et la compare', async () => {
    const { readFileSync } = await import('node:fs');
    const recon = readFileSync('src/services/ai/source-analysis/source-units/stored-reconciliation.ts', 'utf8');
    const repo = readFileSync('src/services/ai/source-analysis/source-units/repository.ts', 'utf8');
    expect(recon).toContain('expectUpdatedAt: cov.updatedAt ?? null');
    expect(recon).toContain("outcome: 'CONFLICT_DEFERRED'");
    expect(repo).toContain('FOR UPDATE');
    expect(repo).toContain('CoverageVersionConflictError');
    // Le refus PRÉCÈDE toute écriture : la garde est appelée en première instruction de l'écriture de couche.
    expect(repo).toContain('if (p.expectUpdatedAt !== undefined) await assertCoverageVersion(tx, p);');
  });

  it('la campagne réserve le document, consigne l’avant initial et ses étapes avant toute écriture', async () => {
    const { readFileSync } = await import('node:fs');
    const camp = readFileSync('src/services/ai/source-analysis/source-units/historical-reassessment.ts', 'utf8');
    expect(camp).toContain('lease_owner = EXCLUDED.lease_owner');
    // Carte #837 (B3/B4) : chaque étape est consignée SOUS LE JETON du titulaire, avec son résultat.
    expect(camp).toContain('etape({ reverified: true');
    expect(camp).toContain('etape({ reconciled: true, reconciliation: rec })');
    expect(camp).toContain('etape({ alerted: true, alerts })');
    expect(camp).toContain('lease_owner = $5 AND lease_expires_at > NOW()');
    // Une étape acquise n'est pas refaite.
    expect(camp).toContain('if (!steps.reverified && reverificationDue(');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// § 5 — RATTRAPAGE PERMANENT
// ════════════════════════════════════════════════════════════════════════════
describe('L115H-U07 — § 5 : rattrapage permanent de tout le stock', () => {
  it('une PREUVE NOUVELLE suffit à redéclencher la re-vérification, à version de vérificateur constante', async () => {
    const { reverificationDue } = await import('../stored-reverification');
    const { SOURCE_VERIFIER_VERSION } = await import('../source-verification');
    const d = (over: Record<string, unknown> = {}) => ({
      sourceVerification: 'PARTIAL', verificationReason: 'pages_unverified', verifierVersion: SOURCE_VERIFIER_VERSION, ...over,
    });
    // Règle du lot 109K conservée : une ancienne version du vérificateur déclenche toujours.
    expect(reverificationDue({ qualityState: 'VERIFICATION_INCOMPLETE', verification: d({ verifierVersion: 1 }) })).toBe(true);
    // DÉFAUT REPRODUIT : à version courante et sans empreinte fournie, l'ancienne règle ne déclenchait plus jamais.
    expect(reverificationDue({ qualityState: 'VERIFICATION_INCOMPLETE', verification: d() })).toBe(false);
    // Corrigé : la source lue n'est plus celle confrontée → la preuve est nouvelle, la confrontation est due.
    expect(reverificationDue({
      qualityState: 'VERIFICATION_INCOMPLETE', verification: d({ reverification: { fingerprint: 'x', sourceSha: 'ancienne' } }), sourceSha256: 'nouvelle',
    })).toBe(true);
    // Preuve IDENTIQUE : jamais rejouée (aucune boucle).
    expect(reverificationDue({
      qualityState: 'VERIFICATION_INCOMPLETE', verification: d({ reverification: { fingerprint: 'x', sourceSha: 'meme' } }), sourceSha256: 'meme',
    })).toBe(false);
    // Les autres conditions restent nécessaires (un document complet n'est jamais reconfronté).
    expect(reverificationDue({ qualityState: 'COMPLETE', verification: d({ reverification: { sourceSha: 'a' } }), sourceSha256: 'b' })).toBe(false);
  });

  it('tout changement de condition d’alerte T1 impose une nouvelle version des règles (donc le rattrapage)', async () => {
    const { t1AlertConditionsSignature, T1_RULES_VERSION_SIGNATURES, T1_COVERAGE_RULES_VERSION } = await import('../historical-reassessment');
    // Le mécanisme exigé par la carte : la signature des conditions EN VIGUEUR doit être celle enregistrée pour la
    // version courante. Modifier une famille ou ce qu'elle couvre fait échouer ce test tant que la version n'a pas
    // été incrémentée ET enregistrée — et incrémenter la version fait reprendre tout le stock.
    expect(T1_RULES_VERSION_SIGNATURES[T1_COVERAGE_RULES_VERSION]).toBe(t1AlertConditionsSignature());
    // Les versions antérieures restent enregistrées (l'historique ne se réécrit pas).
    // Carte #853 : version 4 ajoutée (couverture par occurrence) — les versions antérieures restent enregistrées.
    expect(Object.keys(T1_RULES_VERSION_SIGNATURES).map(Number).sort()).toEqual([1, 2, 3, 4]);
    expect(T1_COVERAGE_RULES_VERSION).toBeGreaterThan(1);
  });

  it('les exclusions temporaires sont du travail DIFFÉRÉ identifiable, et les issues non terminales sont reprises', async () => {
    const { NON_TERMINAL_OUTCOMES } = await import('../historical-reassessment');
    expect([...NON_TERMINAL_OUTCOMES]).toEqual(['ERROR', 'UNCONFIRMED', 'DEFERRED']);
    const { readFileSync } = await import('node:fs');
    const camp = readFileSync('src/services/ai/source-analysis/source-units/historical-reassessment.ts', 'utf8');
    // Les trois causes de report sont nommées et journalisées.
    for (const cause of ['ACCOUNT_INELIGIBLE', 'ANALYSIS_RUNNING', 'RETRY_ACTIVE', 'WRITE_CONFLICT', 'LEASE_HELD']) {
      expect(camp, cause).toContain(`'${cause}'`);
    }
    // Curseurs durables des deux parcours : aucune famine en fin de stock.
    expect(camp).toContain("lireCurseur('documents')");
    expect(camp).toContain("lireCurseur('alerts')");
    expect(camp).toContain("ecrireCurseur('documents', 0, true)");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// § 6 — ALERTES, ÉTAT ACTUEL ET BILAN EXHAUSTIF
// ════════════════════════════════════════════════════════════════════════════
describe('L115H-U08 — § 6 : familles d’alertes, séparation des vues, bilan sans plafond', () => {
  it('l’inventaire des familles couvre TOUTES les empreintes d’alerte T1 réellement écrites par le code', async () => {
    const { T1_ALERT_FAMILIES, T1_ALERT_FAMILIES_OUT_OF_SCOPE } = await import('../historical-reassessment');
    const { readFileSync } = await import('node:fs');
    const sources = ['monitoring.ts', 'jobs.ts'].map((f) => readFileSync(`src/services/ai/source-analysis/source-units/${f}`, 'utf8')).join('\n');
    // Toute empreinte `ai:t1-…:<document>` écrite par ces modules doit appartenir à l'inventaire.
    const ecrites = new Set([...sources.matchAll(/`(ai:t1-[a-z-]+:)\$\{fileId\}`/g)].map((m) => m[1]));
    expect(ecrites.size).toBeGreaterThanOrEqual(3);
    for (const prefixe of ecrites) {
      expect(T1_ALERT_FAMILIES.some((f) => f.prefix === prefixe), prefixe).toBe(true);
    }
    // Les familles d'un autre propriétaire sont déclarées comme telles, jamais « oubliées ».
    expect(T1_ALERT_FAMILIES_OUT_OF_SCOPE.length).toBeGreaterThan(0);
    for (const f of T1_ALERT_FAMILIES_OUT_OF_SCOPE) expect(f.owner.length).toBeGreaterThan(0);
  });

  it('refus de remise en file : l’alerte n’est close que sur un refus LEVÉ, jamais sur une réparation programmée', async () => {
    const { alertDecisionOf, T1_COVERAGE_RULES_VERSION } = await import('../historical-reassessment');
    const refus = (lastRetryResult: string | null, retryScheduled = false) => alertDecisionOf({
      kind: 'REQUEUE_REFUSAL', open: true, deleted: false, qualityState: 'VERIFICATION_INCOMPLETE',
      normalisationLosses: 0, rulesVersion: T1_COVERAGE_RULES_VERSION, lastRetryResult, retryScheduled,
    });
    expect(refus('REQUEUE_REJECTED_FINAL')?.action).toBe('MAINTAINED');
    expect(refus('REQUEUE_REJECTED_TRANSIENT')?.action).toBe('MAINTAINED');
    expect(refus('REQUEUE_ACCOUNT_NOT_ELIGIBLE')?.action).toBe('MAINTAINED');
    expect(refus('REQUEUE_NOT_ADMISSIBLE:RETRY_CAP_REACHED')?.action).toBe('MAINTAINED');
    // Une réparation PROGRAMMÉE n'est pas une réparation accomplie : elle ne clôt pas le refus.
    expect(refus('REQUEUE_REJECTED_FINAL', true)?.action).toBe('MAINTAINED');
    // Refus levé : close, avec sa cause.
    expect(refus('REQUEUED_T1')?.action).toBe('CLOSED');
    // Couverture illisible : conservée (cause non vérifiable), jamais de nettoyage aveugle.
    expect(alertDecisionOf({
      kind: 'REQUEUE_REFUSAL', open: true, deleted: false, qualityState: null, normalisationLosses: null,
      rulesVersion: T1_COVERAGE_RULES_VERSION, lastRetryResult: null,
    })?.action).toBe('MAINTAINED');
    // Aucune alerte ouverte : rien à faire (la campagne n'en ouvre pas de cette famille).
    expect(alertDecisionOf({
      kind: 'REQUEUE_REFUSAL', open: false, deleted: false, qualityState: 'COMPLETE', normalisationLosses: 0,
      rulesVersion: T1_COVERAGE_RULES_VERSION, lastRetryResult: 'REQUEUE_REJECTED_FINAL',
    })).toBeNull();
  });

  it('rapport historique immuable et état actuel sont LUS séparément, sans statut contradictoire', async () => {
    const { splitHistoricalAndCurrent } = await import('../coverage-issue');
    // Carte #837 (D4) : la face historique vient du RAPPORT D'EXÉCUTION d'origine, plus des champs de couverture.
    const r = splitHistoricalAndCurrent({
      qualityState: 'INCOMPLETE_RETRYABLE', anomalies: ['COVERAGE_INCOMPLETE'], retryAttempts: 2, maxRetries: 2,
      nextRetryAt: null, lastRetryResult: 'REQUEUE_NOT_ADMISSIBLE:RETRY_CAP_REACHED',
      analysisReport: { reportId: 7206, createdAt: '2026-11-10T08:00:00.000Z', qualityState: 'INCOMPLETE_RETRYABLE', anomalies: ['COVERAGE_INCOMPLETE'] },
      verification: { pagesMissing: [4] },
    });
    expect(r.historical).toEqual({
      source: 'ANALYSIS_REPORT', reportId: 7206, qualityState: 'INCOMPLETE_RETRYABLE', anomalies: ['COVERAGE_INCOMPLETE'], reportedAt: '2026-11-10T08:00:00.000Z',
    });
    // L'état actuel dit la vérité d'aujourd'hui : plus aucune reprise, donc pas « reprise programmée ».
    expect(r.current).toMatchObject({ issue: 'CAP_REACHED', retryScheduled: false, lastRetryResult: 'REQUEUE_NOT_ADMISSIBLE:RETRY_CAP_REACHED' });
    expect(r.current.reason).toContain('plafond de reprises atteint');
  });

  it('les compteurs par issue du BO n’ont plus de plafond de 5 000 (balayage paginé par clé)', async () => {
    const { readFileSync } = await import('node:fs');
    const mon = readFileSync('src/services/ai/source-analysis/source-units/monitoring.ts', 'utf8');
    expect(mon).not.toContain('ISSUE_SCAN_CAP');
    // Carte #837 (D3) : plus de plafond SILENCIEUX de pages ; un classement tronqué est déclaré INCOMPLETE.
    expect(mon).not.toContain('ISSUE_SCAN_MAX_PAGES');
    expect(mon).toContain('ISSUE_SCAN_PAGE');
    // Pagination par CLÉ (pas par OFFSET) : aucun document lu deux fois, aucun sauté.
    expect(mon).toContain('(c.updated_at, c.file_id) < ($2::timestamptz, $3::int)');
    expect(mon).toContain('out.byIssueTruncated = classement.incomplete !== null;');
    // Le libellé du BO reste tolérant à une lecture antérieure qui annoncerait encore une troncature.
    const panneau = readFileSync('src/app/admin/ai-executions/_components/T1CompletenessPanel.tsx', 'utf8');
    expect(panneau).toContain('byIssueScanned');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// § 7 — IMAGES, SCANS ET PREUVES : AUCUNE VOIE INVENTÉE
// ════════════════════════════════════════════════════════════════════════════
describe('L115H-U09 — § 7 : classement des vérifications incomplètes, sans inventer de preuve', () => {
  const cas = async (over: Record<string, unknown>) => {
    const { classifyVerificationGap } = await import('../verification-evidence');
    return classifyVerificationGap({
      fileId: 389, qualityState: 'VERIFICATION_INCOMPLETE', textLayerAvailable: false, unitCount: 3,
      sourceVerification: 'UNVERIFIABLE', verification: {}, ...over,
    } as never);
  };

  it('image ou scan sans texte original : AUCUNE voie de preuve — ce qu’il faudrait est nommé, rien n’est promis', async () => {
    const v = await cas({ verification: { verificationReason: 'image_not_checkable', pagesExpected: 1, pagesUnverified: [1] } });
    expect(v).toMatchObject({ kind: 'NO_INDEPENDENT_EVIDENCE', probativePath: 'NONE', actionable: false });
    expect(v.whatWouldBeNeeded).toContain('capacité absente de l’application');
    // Pas d'alerte de réparation non actionnable, donc pas de relance périodique identique.
    expect(v.actionable).toBe(false);
  });

  it('source illisible : incident de fichier, pas une limite de contrôle — une action d’administrateur est possible', async () => {
    for (const motif of ['source_unreadable', 'pdf_unreadable', 'source_too_large']) {
      const v = await cas({ verification: { verificationReason: motif } });
      expect(v, motif).toMatchObject({ kind: 'SOURCE_UNREADABLE', probativePath: 'NONE', actionable: true });
      expect(v.whatWouldBeNeeded, motif).toContain('nouveau dépôt');
    }
  });

  it('omission PROUVÉE : la confrontation déterministe EXISTANTE tranche (aucune voie nouvelle)', async () => {
    const v = await cas({ textLayerAvailable: true, verification: { verificationReason: 'pages_missing', pagesExpected: 3, pagesVerified: 2, pagesMissing: [3] } });
    expect(v).toMatchObject({ kind: 'OMISSION_PROVEN', probativePath: 'DETERMINISTIC_REVERIFICATION', whatWouldBeNeeded: null, actionable: true });
    expect(v.pages).toMatchObject({ expected: 3, verified: 2, missing: [3] });
  });

  it('contrôle AMÉLIORABLE : texte original en base, confronté par une version antérieure', async () => {
    const v = await cas({ textLayerAvailable: true, sourceVerification: 'PARTIAL', verification: { verificationReason: 'pages_unverified', verifierVersion: 1 } });
    expect(v).toMatchObject({ kind: 'CHECK_IMPROVABLE', probativePath: 'DETERMINISTIC_REVERIFICATION' });
  });

  it('couverture RECONSTRUITE : confrontable si un texte original existe, sinon ce qu’il faudrait est dit', async () => {
    const avec = await cas({ textLayerAvailable: true, sourceVerification: 'RECONSTRUCTED', verification: { verificationReason: 'backfill' } });
    expect(avec).toMatchObject({ kind: 'BACKFILL', probativePath: 'DETERMINISTIC_REVERIFICATION' });
    const sans = await cas({ textLayerAvailable: false, sourceVerification: 'RECONSTRUCTED', verification: { verificationReason: 'backfill' } });
    expect(sans).toMatchObject({ kind: 'BACKFILL', probativePath: 'NONE', actionable: false });
    expect(sans.whatWouldBeNeeded).toContain('extraction du texte original');
  });

  it('les cinq situations de la carte sont toutes classables, et aucune ne promet une voie qui n’existe pas', async () => {
    const { VERIFICATION_GAP_KINDS, VERIFICATION_GAP_LABEL } = await import('../verification-evidence');
    expect([...VERIFICATION_GAP_KINDS]).toEqual(['SOURCE_UNREADABLE', 'OMISSION_PROVEN', 'CHECK_IMPROVABLE', 'NO_INDEPENDENT_EVIDENCE', 'BACKFILL']);
    for (const k of VERIFICATION_GAP_KINDS) expect(VERIFICATION_GAP_LABEL[k].length).toBeGreaterThan(0);
    // Le mot « Opération » n'est employé dans aucun libellé (vocabulaire : événement de référence).
    for (const k of VERIFICATION_GAP_KINDS) expect(VERIFICATION_GAP_LABEL[k]).not.toContain('Opération');
  });
});
