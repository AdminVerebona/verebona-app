/**
 * Lancement manuel batch — CDC BO IA WF-11, OPS-016, T1-021, T1-UI-12,
 * T3-UI-08, T4-UI-07, WF-13 (lot IA 2).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUE LE CDC DEMANDE
 *
 * Choisir un compte, plusieurs comptes ou tout le périmètre pertinent ;
 * afficher une estimation ; confirmer ; créer une NOUVELLE exécution même si
 * un job automatique équivalent existe (bypass de la déduplication),
 * identifiable `origin = manual`. Seule précondition : pas d'arrêt d'urgence.
 * Un traitement désactivé ou suspendu ACCEPTE la demande (WF-07 : « continuer
 * d'accepter les nouvelles demandes ») : elle attend en file sa réactivation,
 * et l'écran le dit.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * PÉRIMÈTRE PAR TRAITEMENT
 *
 *   · T1 — un job par fichier non supprimé des comptes choisis (réanalyse).
 *     Non facturé au compte (`billable: false`) : c'est une décision
 *     d'exploitation, elle ne doit ni consommer les crédits d'analyse de
 *     l'utilisateur ni être refusée parce qu'il les a épuisés.
 *   · T3 — un contrôle compte complet par compte (même chemin que la route
 *     `reconciliation/accounts/[accountId]`).
 *   · T4 — un NOUVEAU passage par document dont l'analyse T1 de référence a
 *     produit des échéances candidates (T4-016, T4-UI-07 « force un nouveau
 *     passage », WF-11). Les candidats sont relus dans le résultat T1 COMPLET
 *     persisté (`document_analysis_runs.raw_response_json`, run de
 *     référence) — pas reconstruits depuis les propositions, qui n'ont ni la
 *     récurrence ni le champ d'origine (agenda/index.ts). Aucun appel T1 :
 *     seul T4 repasse.
 *
 * La configuration utilisée est celle de l'environnement au DÉMARRAGE du job
 * (WF-11 étape 67, VER-016) : rien n'est figé à la mise en file.
 */
import type { Treatment } from '../config/treatments';

type ManualTreatment = 'T1' | 'T3' | 'T4';

/** Document portant des échéances candidates T1 (entrée d'un passage T4 manuel). */
export interface T4Source {
  fileId: number;
  accountId: number;
  assetId: number;
  userId: number;
  /** Absent en estimation : seul le nombre compte. */
  candidates?: unknown[];
}

/** Lot 54A : issue d'une demande du lancement (une par objet), motivée. */
interface ManualLaunchRequestOutcome {
  accountId: number;
  decision: 'create' | 'skip' | 'coalesce' | 'refused' | 'lost';
  /** Motif quand aucun job n'est annoncé pour cette demande. */
  reasonCode: string | null;
  jobId: number | null;
}

interface ManualLaunchDetails {
  excludedAccountIds?: number[];
  refused?: number;
  /** Lot 54A : décompte des motifs de non-création (CROSS_ACCOUNT_SCOPE, PERSISTENCE_NOT_CONFIRMED…). */
  reasons?: Record<string, number>;
  /** Lot 54A : issue de chaque demande (bornée à 50). */
  requests?: ManualLaunchRequestOutcome[];
  /** Lot 54A (erreur technique) : étape en échec et jobs créés AVANT l'échec (ils existent). */
  stage?: string;
  createdJobIds?: number[];
}

export class ManualLaunchRefused extends Error {
  constructor(
    readonly code: 'EMERGENCY_STOP' | 'NOT_LAUNCHABLE' | 'EMPTY_SCOPE' | 'SCOPE_TOO_LARGE' | 'NO_JOB_CREATED',
    message: string,
    /** Lot 52A : comptes demandés mais non retenus / demandes refusées (motif explicite). */
    readonly details?: ManualLaunchDetails,
  ) {
    super(message);
    this.name = 'ManualLaunchRefused';
  }
}

/**
 * Lot 54A — erreur TECHNIQUE du lancement (écriture ou relecture en base) :
 * HTTP 5xx, motif exploitable (`INSERT_FAILED`, `PERSISTENCE_NOT_CONFIRMED`),
 * jamais un succès ni un refus fonctionnel. Les jobs créés avant l'échec sont
 * listés (ils existent et seront exécutés).
 */
export class ManualLaunchFailed extends Error {
  constructor(
    readonly code: 'INSERT_FAILED' | 'PERSISTENCE_NOT_CONFIRMED',
    message: string,
    readonly details: ManualLaunchDetails,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ManualLaunchFailed';
  }
}

/** Plafond d'un lancement : au-delà, découper (la file et le fournisseur suivent). */
export const MANUAL_LAUNCH_MAX_JOBS = 5_000;

interface ManualScope {
  /** Comptes ciblés ; ignoré si `all`. */
  accountIds?: number[];
  /** Tout le périmètre pertinent du traitement. */
  all?: boolean;
}

export interface ManualLaunchDeps {
  emergencyStopActive(): Promise<boolean>;
  canStart(t: Treatment): Promise<boolean>;
  /** T1 : fichiers à réanalyser (id, compte). */
  listFiles(accountIds: number[] | null, limit: number): Promise<Array<{ id: number; accountId: number }>>;
  /**
   * T3 : comptes pertinents — au moins un bien actif OU une ligne « À
   * traiter » ouverte (lot 52A, NR-09 : même périmètre que le balayage).
   */
  listAccounts(accountIds: number[] | null, limit: number): Promise<number[]>;
  /** T4 : documents dont l'analyse de référence porte des échéances candidates. */
  listT4Sources(accountIds: number[] | null, limit: number, withCandidates: boolean): Promise<T4Source[]>;
  enqueue: typeof import('./job-queue.repository').enqueue;
  /**
   * Lot 52A (COR-02) : relit les jobs créés — seuls les identifiants
   * RÉELLEMENT persistés sont annoncés. Absente : identifiants rendus par
   * `enqueue` (déjà relus par son `RETURNING`).
   */
  confirmPersisted?(ids: number[]): Promise<number[]>;
  /** Lot 52A (COR-02) : réveille le boucleur de ce processus (sans attendre le tour suivant). */
  nudge?(): void;
  /** Lot 54A : trace `[t3-enqueue]` (défaut : journal + `ai_t3_enqueue_events`). */
  trace?: (t: import('./t3-enqueue-trace').T3EnqueueTrace) => Promise<void>;
}

interface ManualLaunchResult {
  treatment: ManualTreatment;
  dryRun: boolean;
  /** Estimation (dryRun) ou nombre de jobs créés. */
  objects: number;
  accounts: number;
  jobIds: number[];
  /** Lot 52A : jobs créés, avec leur compte (affichage immédiat dans la File IA). */
  jobs?: Array<{ id: number; accountId: number }>;
  /** Lot 52A : demandes non mises en file (contrôle de périmètre, refus journalisé). */
  refused?: number;
  /** Lot 52A : comptes demandés hors du périmètre pertinent du traitement. */
  excludedAccountIds?: number[];
  /** Lot 54A : motifs des demandes qui n'ont pas créé de job (absent : aucune). */
  reasons?: Record<string, number>;
  /** Traitement coupé (hors arrêt d'urgence) : les jobs attendront la réactivation. */
  waitsForReactivation: boolean;
}

function assertLaunchable(treatment: string): asserts treatment is ManualTreatment {
  if (treatment !== 'T1' && treatment !== 'T3' && treatment !== 'T4') {
    throw new ManualLaunchRefused('NOT_LAUNCHABLE', `${treatment} n'est pas un traitement batch lançable.`);
  }
}

/** Normalise le périmètre : identifiants entiers positifs, dédoublonnés. */
function normalizeScope(scope: ManualScope): number[] | null {
  if (scope.all) return null;
  const ids = [...new Set((scope.accountIds ?? []).filter((n) => Number.isInteger(n) && n > 0))];
  if (ids.length === 0) {
    throw new ManualLaunchRefused('EMPTY_SCOPE', 'Choisissez au moins un compte, ou tout le périmètre.');
  }
  return ids;
}

export async function launchManual(
  treatment: string,
  scope: ManualScope,
  adminUserId: number,
  options: { dryRun?: boolean; forceAiReview?: boolean },
  deps: ManualLaunchDeps,
): Promise<ManualLaunchResult> {
  assertLaunchable(treatment);
  const accountIds = normalizeScope(scope);

  // Précondition WF-11 : « traitement non bloqué par Emergency Stop ».
  if (await deps.emergencyStopActive()) {
    if (!options.dryRun) await tracer(treatment, deps, { decision: 'refused', reason: 'EMERGENCY_STOP', steps: { requested: true } });
    throw new ManualLaunchRefused('EMERGENCY_STOP', 'L’arrêt d’urgence est engagé : aucun lancement n’est accepté.');
  }
  const waitsForReactivation = !(await deps.canStart(treatment));

  // Un de plus que le plafond : savoir qu'on le dépasse sans tout charger.
  const probeLimit = MANUAL_LAUNCH_MAX_JOBS + 1;
  const objets: Array<{ accountId: number; fileId?: number; t4?: T4Source }> = treatment === 'T1'
    ? (await deps.listFiles(accountIds, probeLimit)).map((f) => ({ accountId: f.accountId, fileId: f.id }))
    : treatment === 'T4'
      ? (await deps.listT4Sources(accountIds, probeLimit, !options.dryRun))
        .map((t4) => ({ accountId: t4.accountId, fileId: t4.fileId, t4 }))
      : (await deps.listAccounts(accountIds, probeLimit)).map((a) => ({ accountId: a }));

  if (objets.length > MANUAL_LAUNCH_MAX_JOBS) {
    throw new ManualLaunchRefused(
      'SCOPE_TOO_LARGE',
      `Plus de ${MANUAL_LAUNCH_MAX_JOBS} objets : découpez le lancement par comptes.`,
    );
  }
  const retenus = new Set(objets.map((o) => o.accountId));
  const accounts = retenus.size;
  // Lot 52A : comptes demandés explicitement mais hors périmètre — dits, jamais tus.
  const excludedAccountIds = accountIds ? accountIds.filter((a) => !retenus.has(a)) : [];
  if (options.dryRun) {
    return { treatment, dryRun: true, objects: objets.length, accounts, jobIds: [], excludedAccountIds, waitsForReactivation };
  }
  // Lot 54A : chaque compte demandé mais non retenu est tracé (motif explicite).
  for (const a of excludedAccountIds) {
    await tracer(treatment, deps, { accountId: a, decision: 'refused', reason: 'NO_ELIGIBLE_ACCOUNT', steps: { requested: true, scopeEligible: false } });
  }
  if (objets.length === 0) {
    throw new ManualLaunchRefused(
      'EMPTY_SCOPE',
      treatment === 'T3'
        ? 'Aucun compte à traiter : les comptes choisis n’ont ni bien actif ni élément « À traiter » ouvert (ou n’existent pas).'
        : 'Aucun objet à traiter dans ce périmètre.',
      { excludedAccountIds, reasons: excludedAccountIds.length ? { NO_ELIGIBLE_ACCOUNT: excludedAccountIds.length } : {} },
    );
  }

  const jobIds: number[] = [];
  const jobs: Array<{ id: number; accountId: number }> = [];
  const requests: ManualLaunchRequestOutcome[] = [];
  let refused = 0;
  const motifs: Record<string, number> = {};
  const compter = (m: string | null | undefined) => { if (m) motifs[m] = (motifs[m] ?? 0) + 1; };
  // Lot 54A : la trace de chaque demande T3 est écrite ICI (après relecture),
  // pas par `enqueue` — une seule ligne par demande, avec ses étapes.
  const traceParAppelant = treatment === 'T3' ? { t3Trace: 'caller' as const } : {};
  const mettreEnFile = async (o: { accountId: number }, input: Parameters<ManualLaunchDeps['enqueue']>[0]) => {
    try {
      return await deps.enqueue({ ...input, ...traceParAppelant });
    } catch (e) {
      // Erreur TECHNIQUE (écriture refusée, base indisponible) : 5xx, jamais
      // un succès ni un refus fonctionnel. Les jobs déjà créés sont dits.
      const message = (e as Error)?.message ?? String(e);
      await tracer(treatment, deps, {
        accountId: o.accountId, decision: 'error', reason: 'INSERT_FAILED', error: message,
        steps: { requested: true, scopeEligible: true },
      });
      console.error(`[manual-launch] ${treatment} : mise en file impossible pour le compte ${o.accountId} — ${message}`);
      throw new ManualLaunchFailed(
        'INSERT_FAILED',
        `Lancement ${treatment} interrompu : écriture du job impossible pour le compte ${o.accountId} (${message.slice(0, 200)}).`
          + (jobIds.length ? ` ${jobIds.length} job(s) déjà créé(s) : ${jobIds.map((i) => `#${i}`).join(', ')}.` : ' Aucun job créé.'),
        { stage: 'enqueue', createdJobIds: [...jobIds], excludedAccountIds, reasons: { ...motifs, INSERT_FAILED: 1 } },
        e,
      );
    }
  };
  const noter = (accountId: number, r: { decision: string; jobId: number | null; reasonCode?: string | null }) => {
    // Manuel : `create` attendu (WF-11, hors déduplication). Tout autre issue
    // n'annonce AUCUN job, avec son motif.
    if (r.decision === 'create' && r.jobId !== null) {
      jobIds.push(r.jobId);
      jobs.push({ id: r.jobId, accountId });
      requests.push({ accountId, decision: 'create', reasonCode: null, jobId: r.jobId });
      return;
    }
    refused++;
    const motif = r.reasonCode ?? (r.jobId === null ? 'CROSS_ACCOUNT_SCOPE' : r.decision === 'coalesce' ? 'DUPLICATE_RUNNING' : 'DUPLICATE_PENDING');
    compter(motif);
    requests.push({ accountId, decision: motif === 'CROSS_ACCOUNT_SCOPE' ? 'refused' : (r.decision as 'skip' | 'coalesce'), reasonCode: motif, jobId: r.jobId });
  };
  for (const o of objets) {
    // `origin: 'manual'` : hors de l'index de déduplication (queue-policy) —
    // une nouvelle exécution même si un job automatique équivalent attend
    // (OPS-016 : « deux manuels possibles sur même périmètre »).
    if (treatment === 'T4') {
      const t4 = o.t4!;
      if (!Array.isArray(t4.candidates) || t4.candidates.length === 0) continue;
      // Même forme que le déclencheur `source_analyzed` (agenda/index.ts,
      // T4Payload), mais origine manuelle : hors déduplication.
      noter(t4.accountId, await mettreEnFile(o, {
        treatment: 'T4',
        scope: { accountId: t4.accountId, targetType: 'asset_file', targetId: t4.fileId },
        origin: 'manual',
        triggerCode: 'manual',
        payload: {
          assetId: t4.assetId, userId: t4.userId, leadSourceId: t4.fileId,
          candidates: t4.candidates, requestedByUserId: adminUserId,
        },
      }));
      continue;
    }
    noter(o.accountId, treatment === 'T1'
      ? await mettreEnFile(o, {
        treatment: 'T1',
        scope: { accountId: o.accountId, targetType: 'asset_file', targetId: o.fileId! },
        origin: 'manual',
        triggerCode: 'manual',
        // Lot 50 : réanalyse lancée depuis le BO = traitement technique (jamais un sujet de la mascotte).
        payload: { fileId: o.fileId, userId: null, origin: 'admin/manual', billable: false, processingVisibility: 'TECHNICAL', requestedByUserId: adminUserId },
      })
      : await mettreEnFile(o, {
        treatment: 'T3',
        scope: { accountId: o.accountId },
        origin: 'manual',
        triggerCode: 'manual',
        payload: {
          kind: 'account', scope: 'full', requestedByUserId: adminUserId,
          // Lot 99A : « Réévaluer avec l'IA » — relance forcée tracée (sinon les décisions mémorisées sont réutilisées).
          ...(options.forceAiReview ? { forceAiReview: `relance forcée par l’administrateur #${adminUserId} (lancement manuel)` } : {}),
        },
      }));
  }

  // COR-02 : seuls les jobs RÉELLEMENT persistés sont annoncés — relus par une
  // AUTRE requête que l'insertion (même base, même pool que la File IA).
  let persistes: Set<number>;
  try {
    persistes = deps.confirmPersisted ? new Set(await deps.confirmPersisted(jobIds)) : new Set(jobIds);
  } catch (e) {
    const message = (e as Error)?.message ?? String(e);
    for (const j of jobs) {
      await tracer(treatment, deps, {
        accountId: j.accountId, decision: 'error', reason: 'PERSISTENCE_NOT_CONFIRMED', jobId: j.id, persisted: null, error: message,
        steps: { requested: true, scopeEligible: true, scopeAllowed: true },
      });
    }
    throw new ManualLaunchFailed(
      'PERSISTENCE_NOT_CONFIRMED',
      `Lancement ${treatment} : relecture des jobs créés impossible (${message.slice(0, 200)}) — vérifiez la File IA (jobs ${jobIds.map((i) => `#${i}`).join(', ')}).`,
      { stage: 'confirmPersisted', createdJobIds: [...jobIds], excludedAccountIds, reasons: { ...motifs } },
      e,
    );
  }
  const confirmes = jobs.filter((j) => persistes.has(j.id));
  const perdus = jobs.filter((j) => !persistes.has(j.id));
  for (const j of perdus) {
    compter('PERSISTENCE_NOT_CONFIRMED');
    const req = requests.find((r) => r.jobId === j.id && r.decision === 'create');
    if (req) { req.decision = 'lost'; req.reasonCode = 'PERSISTENCE_NOT_CONFIRMED'; }
  }
  // Lot 54A : une trace par demande (manuel T3), après relecture.
  if (treatment === 'T3') {
    for (const r of requests) {
      await tracer(treatment, deps, {
        accountId: r.accountId,
        decision: r.decision === 'lost' ? 'error' : r.decision,
        reason: (r.reasonCode as never) ?? null, jobId: r.jobId,
        persisted: r.decision === 'create' ? true : r.decision === 'lost' ? false : null,
        steps: { requested: true, scopeEligible: true, scopeAllowed: r.reasonCode !== 'CROSS_ACCOUNT_SCOPE' },
      });
    }
  }
  if (confirmes.length === 0) {
    // Aucun message de réussite trompeur : motif explicite.
    const libelles = [
      refused > 0 ? `${refused} demande(s) sans job : ${Object.entries(motifs).filter(([k]) => k !== 'PERSISTENCE_NOT_CONFIRMED').map(([k, n]) => `${k} ×${n}`).join(', ')}`
        + (motifs.CROSS_ACCOUNT_SCOPE ? ' (contrôle de périmètre du compte : références d’un autre compte, journalisé)' : '') : null,
      perdus.length > 0 ? `${perdus.length} job(s) introuvable(s) après création (PERSISTENCE_NOT_CONFIRMED)` : null,
      treatment === 'T4' && refused === 0 && perdus.length === 0 ? 'aucune échéance candidate dans les analyses de référence' : null,
    ].filter(Boolean);
    throw new ManualLaunchRefused(
      'NO_JOB_CREATED',
      `Aucun job ${treatment} n’a été créé${libelles.length ? ` : ${libelles.join(' ; ')}` : ''}.`,
      { excludedAccountIds, refused, reasons: motifs, requests: requests.slice(0, 50) },
    );
  }
  // COR-02 : réveil immédiat du boucleur (ce processus) ; les autres instances
  // prennent les jobs à leur tour suivant (15 s).
  try { deps.nudge?.(); } catch { /* jamais bloquant */ }
  console.info(
    `[manual-launch] ${treatment} : ${confirmes.length} job(s) manuel(s) [${confirmes.map((j) => j.id).join(', ')}] sur ${accounts} compte(s) par l'administrateur ${adminUserId}`
    + `${refused ? ` — ${refused} demande(s) sans job (${Object.entries(motifs).map(([k, n]) => `${k} ×${n}`).join(', ')})` : ''}.`,
  );
  return {
    treatment, dryRun: false, objects: confirmes.length, accounts: new Set(confirmes.map((j) => j.accountId)).size,
    jobIds: confirmes.map((j) => j.id), jobs: confirmes, refused, excludedAccountIds, waitsForReactivation,
    ...(Object.keys(motifs).length ? { reasons: motifs } : {}),
  };
}

/** Trace `[t3-enqueue]` d'une demande manuelle T3 (autres traitements : rien). Jamais bloquante. */
async function tracer(
  treatment: ManualTreatment, deps: ManualLaunchDeps,
  t: Omit<import('./t3-enqueue-trace').T3EnqueueTrace, 'origin' | 'triggerCode'>,
): Promise<void> {
  if (treatment !== 'T3') return;
  try {
    const trace = deps.trace ?? (await import('./t3-enqueue-trace')).traceT3Enqueue;
    await trace({ origin: 'manual', triggerCode: 'manual', ...t });
  } catch { /* la trace ne bloque jamais le lancement */ }
}

/** Dépendances branchées sur la base. */
export async function defaultManualLaunchDeps(): Promise<ManualLaunchDeps> {
  const [{ pgClient }, repo] = await Promise.all([import('@/db'), import('./job-queue.repository')]);
  return {
    emergencyStopActive: async () => (await repo.getEmergencyStop()).active,
    canStart: repo.canStart,
    enqueue: repo.enqueue,
    async confirmPersisted(ids) {
      if (ids.length === 0) return [];
      const rows = (await pgClient.unsafe(
        `SELECT id FROM ai_job_queue WHERE id = ANY($1::int[])`, [ids] as never[],
      )) as unknown as Array<{ id: number }>;
      return rows.map((r) => Number(r.id));
    },
    nudge() {
      void import('./queue-worker').then((w) => w.nudgeQueueWorker()).catch(() => undefined);
    },
    async listFiles(accountIds, limit) {
      const rows = (await pgClient.unsafe(
        `SELECT id, account_id FROM asset_files
          WHERE deleted_at IS NULL AND account_id IS NOT NULL
            AND ($1::int[] IS NULL OR account_id = ANY($1::int[]))
          ORDER BY account_id, id LIMIT $2`,
        [accountIds, limit] as never[],
      )) as unknown as Array<{ id: number; account_id: number }>;
      return rows.map((r) => ({ id: Number(r.id), accountId: Number(r.account_id) }));
    },
    async listAccounts(accountIds, limit) {
      const rows = (await pgClient.unsafe(
        `SELECT a.id FROM accounts a
          WHERE ($1::int[] IS NULL OR a.id = ANY($1::int[]))
            AND (EXISTS (SELECT 1 FROM assets s WHERE s.account_id = a.id AND s.deleted_at IS NULL)
                 -- Lot 52A (NR-09) : une ligne « À traiter » ouverte suffit (même périmètre que le balayage, 49B).
                 OR EXISTS (SELECT 1 FROM to_process_actions t WHERE t.account_id = a.id AND t.resolved_at IS NULL))
          ORDER BY a.id LIMIT $2`,
        [accountIds, limit] as never[],
      )) as unknown as Array<{ id: number }>;
      return rows.map((r) => Number(r.id));
    },
    async listT4Sources(accountIds, limit, withCandidates) {
      // Filtre textuel AVANT toute conversion : seules les lignes au format
      // du pipeline actuel (JSON.stringify du résultat T1) avec au moins un
      // candidat sont converties en jsonb — la liste de sélection n'est
      // évaluée que pour les lignes retenues.
      const rows = (await pgClient.unsafe(
        `SELECT f.id, f.account_id, COALESCE(f.asset_id, f.linked_asset_id) AS asset_id, f.user_id
                ${withCandidates ? `, (r.raw_response_json::jsonb) -> 'agendaCandidates' AS candidates` : ''}
           FROM asset_files f
           JOIN document_analysis_runs r
             ON r.asset_file_id = f.id AND r.is_current_reference AND r.status = 'completed'
          WHERE f.deleted_at IS NULL
            AND COALESCE(f.asset_id, f.linked_asset_id) IS NOT NULL
            AND r.raw_response_json LIKE '%"agendaCandidates":[{%'
            AND ($1::int[] IS NULL OR f.account_id = ANY($1::int[]))
          ORDER BY f.account_id, f.id LIMIT $2`,
        [accountIds, limit] as never[],
      )) as unknown as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        fileId: Number(r.id),
        accountId: Number(r.account_id),
        assetId: Number(r.asset_id),
        userId: Number(r.user_id),
        ...(withCandidates ? { candidates: Array.isArray(r.candidates) ? r.candidates as unknown[] : [] } : {}),
      }));
    },
  };
}
