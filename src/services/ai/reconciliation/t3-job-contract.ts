/**
 * Contrat versionné des travaux T3 dans la file durable — lot 31C (ticket
 * « T3 — Durcir et formaliser le contrat de la file durable »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * PAYLOAD = QUOI TRAITER ; BASE CANONIQUE = ÉTAT RÉEL À TRAITER
 *
 * Le contexte d'un job (`ai_job_queue.payload`) ne porte que ce qu'il faut
 * pour reprendre le travail : la sorte de travail (`kind`), les identifiants,
 * l'utilisateur à l'origine, la source concernée, la raison de cycle de vie,
 * les événements consolidés, le périmètre (`scope`), et la date de la demande
 * (`requestedAt`, qui sert à reconnaître un travail SUPERSEDED). JAMAIS de
 * valeur métier : T3 relit la base au moment de l'exécution.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * VERSION EXPLICITE
 *
 * Tout nouveau contexte porte `payloadVersion: 1`. Un contexte SANS version
 * (mis en file avant ce lot) reste accepté pendant la transition : il est lu
 * avec le même validateur (version 0 = « historique »), sa sorte étant
 * déduite de la forme du job quand elle manque. Une version inconnue, une
 * sorte inconnue, une cible incompatible ou un identifiant invalide lèvent
 * `PermanentJobError` : le job passe FAILED tout de suite, jamais DONE.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * AJOUTER UNE SORTE DE TRAVAIL (ex. rattachement document → bien, lot 31B)
 *
 *   registerT3JobKind({
 *     kind: 'document_asset',            // valeur de payload.kind
 *     targetTypes: ['asset_file'],       // forme(s) de job acceptée(s)
 *     account: 'required',
 *     versions: [1],                     // versions de contexte reconnues
 *     parse: (raw, job, version) => ({ ... }), // lève PermanentJobError si malformé
 *     run: async ({ job, payload, guard }) => ({ result: 'APPLIED' }),
 *   });
 *
 * puis mettre en file avec `buildT3Payload('document_asset', { ... })` et le
 * déclencheur réel du catalogue. Le boucleur, la déduplication, les
 * tentatives, l'interruption et l'observabilité s'appliquent sans autre code.
 * `run` doit appeler `guard.assertActive()` (ou `assertJobActive()`) avant
 * chaque écriture métier, relire l'état canonique, et rendre un résultat
 * métier (APPLIED, NO_CHANGE, ABSTAIN, SUPERSEDED, TARGET_GONE).
 */
import type { QueuedJob } from '../queue/job-queue.repository';
import type { ExecutionGuard } from '../queue/execution-control';
import { PermanentJobError, type JobBusinessResult } from '../queue/queue-policy';

/** Version courante du contexte des travaux T3. */
export const T3_PAYLOAD_VERSION = 1 as const;
/** Version attribuée à un contexte historique, sans `payloadVersion`. */
export const T3_LEGACY_PAYLOAD_VERSION = 0;

/** Types de cible T3 dans la file. */
export const T3_TARGET_ASSET = 'asset';
/** Équipement / pièce : réconciliation ciblée de leur fiche (CDC 15 T1-04, lot 18). */
export const T3_TARGET_EQUIPMENT = 'equipment';
export const T3_TARGET_ROOM = 'room';
/** Page de continuation d'un balayage planifié (lot 31C). */
export const T3_TARGET_SWEEP_PAGE = 't3_sweep';

/** Forme d'un job, telle que la file la porte (colonnes, hors contexte). */
export type T3JobShape = Pick<QueuedJob, 'id' | 'accountId' | 'targetType' | 'targetId'>;

/** Contexte d'exécution transmis à l'exécutant d'une sorte de travail. */
export interface T3RunContext<P> {
  job: QueuedJob;
  payload: P;
  guard: ExecutionGuard;
}

export interface T3JobKindSpec<P = unknown> {
  /** Valeur de `payload.kind`. */
  kind: string;
  /** Types de cible acceptés ; `null` = job sans cible. */
  targetTypes: ReadonlyArray<string | null>;
  /** Le job doit-il porter un compte ? */
  account: 'required' | 'forbidden';
  /** Versions de contexte reconnues (hors 0, toujours accepté si `legacy`). */
  versions: readonly number[];
  /** Contexte historique (sans `payloadVersion`) accepté ? */
  legacy?: boolean;
  /** Valide et normalise le contexte ; lève `PermanentJobError` si inexploitable. */
  parse: (raw: Record<string, unknown>, job: T3JobShape, version: number) => P;
  /**
   * Exécutant. Facultatif pour les sortes historiques (aiguillées par
   * `runT3Job`), obligatoire pour toute sorte ajoutée.
   */
  run?: (ctx: T3RunContext<P>) => Promise<JobBusinessResult>;
}

const registry = new Map<string, T3JobKindSpec>();

/** Enregistre une sorte de travail T3. Une sorte existante est remplacée. */
export function registerT3JobKind<P>(spec: T3JobKindSpec<P>): void {
  registry.set(spec.kind, spec as T3JobKindSpec);
}

export function getT3JobKind(kind: string): T3JobKindSpec | undefined {
  return registry.get(kind);
}

export function listT3JobKinds(): string[] {
  return [...registry.keys()];
}

/** Contexte v1, prêt à mettre en file (date de la demande comprise). */
export function buildT3Payload<T extends Record<string, unknown>>(
  kind: string,
  fields: T,
  now: Date = new Date(),
): T & { payloadVersion: typeof T3_PAYLOAD_VERSION; kind: string; requestedAt: string } {
  return { payloadVersion: T3_PAYLOAD_VERSION, kind, requestedAt: now.toISOString(), ...fields };
}

// ── Validateurs élémentaires ────────────────────────────────────────────────

const invalide = (job: T3JobShape, motif: string): never => {
  throw new PermanentJobError(`T3 job ${job.id} : ${motif}`);
};

/** Entier strictement positif, ou `null` si absent ; lève s'il est présent et invalide. */
function optId(job: T3JobShape, raw: Record<string, unknown>, key: string): number | null {
  const v = raw[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) invalide(job, `${key} invalide`);
  return v as number;
}

function optString(job: T3JobShape, raw: Record<string, unknown>, key: string): string | null {
  const v = raw[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') invalide(job, `${key} invalide`);
  return v as string;
}

function optDate(job: T3JobShape, raw: Record<string, unknown>, key: string): string | null {
  const v = optString(job, raw, key);
  if (v !== null && Number.isNaN(new Date(v).getTime())) invalide(job, `${key} n'est pas une date`);
  return v;
}

/** Identifiant de cible : chaîne d'entier strictement positif. */
export function parseTargetId(job: T3JobShape): number {
  const t = job.targetId;
  if (t == null || !/^\d+$/.test(t) || Number(t) <= 0 || !Number.isSafeInteger(Number(t))) {
    invalide(job, `identifiant de cible « ${t ?? ''} » invalide`);
  }
  return Number(t);
}

function triggeredBy(job: T3JobShape, raw: Record<string, unknown>): 'document_analyzed' | 'document_linked' {
  const v = raw.triggeredBy;
  if (v === undefined || v === null || v === 'document_analyzed') return 'document_analyzed';
  if (v === 'document_linked') return 'document_linked';
  return invalide(job, 'triggeredBy invalide');
}

// ── Sortes historiques ──────────────────────────────────────────────────────

export interface T3AssetPayload {
  kind: 'asset';
  assetId: number;
  userId: number;
  sourceFileId: number | null;
  triggeredBy: 'document_analyzed' | 'document_linked';
  lifecycleReason: string | null;
  requestedAt: string | null;
}

export interface T3EntityPayload {
  kind: 'entity';
  target: { type: 'EQUIPMENT' | 'ROOM'; id: number };
  userId: number | null;
  sourceFileId: number | null;
  triggeredBy: 'document_analyzed' | 'document_linked';
  lifecycleReason: string | null;
  requestedAt: string | null;
}

export interface T3CoherenceEventEntry {
  event: string;
  objectType?: 'asset' | 'document' | 'equipment' | 'to_process_action';
  objectId?: number;
  correlationId?: string;
  at?: string;
}

export interface T3AccountPayload {
  kind: 'account';
  scope: 'full' | 'incremental' | null;
  events: T3CoherenceEventEntry[];
  requestedByUserId: number | null;
  scheduled: boolean;
  requestedAt: string | null;
}

export interface T3SweepPayload {
  kind: 'sweep';
  /** Cycle logique : identifiant du job racine du balayage. */
  cycleId: string | null;
  /** Début du cycle (racine) : référence de la période planifiée. */
  cycleStartedAt: string | null;
  /** Curseur stable : identifiant de compte après lequel reprendre. */
  afterAccountId: number;
  /** Rang de la page dans le cycle (0 = racine). */
  page: number;
  requestedAt: string | null;
}

const OBJECT_TYPES = new Set(['asset', 'document', 'equipment', 'to_process_action']);

registerT3JobKind<T3AssetPayload>({
  kind: 'asset',
  targetTypes: [T3_TARGET_ASSET],
  account: 'required',
  versions: [1],
  legacy: true,
  parse(raw, job) {
    const assetId = parseTargetId(job);
    const userId = optId(job, raw, 'userId');
    if (userId === null) invalide(job, 'utilisateur à l\'origine absent');
    return {
      kind: 'asset', assetId, userId: userId as number,
      sourceFileId: optId(job, raw, 'sourceFileId'),
      triggeredBy: triggeredBy(job, raw),
      lifecycleReason: optString(job, raw, 'lifecycleReason'),
      requestedAt: optDate(job, raw, 'requestedAt'),
    };
  },
});

registerT3JobKind<T3EntityPayload>({
  kind: 'entity',
  targetTypes: [T3_TARGET_EQUIPMENT, T3_TARGET_ROOM],
  account: 'required',
  versions: [1],
  legacy: true,
  parse(raw, job) {
    const id = parseTargetId(job);
    return {
      kind: 'entity',
      target: { type: job.targetType === T3_TARGET_EQUIPMENT ? 'EQUIPMENT' : 'ROOM', id },
      userId: optId(job, raw, 'userId'),
      sourceFileId: optId(job, raw, 'sourceFileId'),
      triggeredBy: triggeredBy(job, raw),
      lifecycleReason: optString(job, raw, 'lifecycleReason'),
      requestedAt: optDate(job, raw, 'requestedAt'),
    };
  },
});

registerT3JobKind<T3AccountPayload>({
  kind: 'account',
  targetTypes: [null],
  account: 'required',
  versions: [1],
  legacy: true,
  parse(raw, job) {
    const scope = raw.scope;
    if (scope !== undefined && scope !== null && scope !== 'full' && scope !== 'incremental') invalide(job, 'scope invalide');
    const evRaw = raw.events;
    if (evRaw !== undefined && evRaw !== null && !Array.isArray(evRaw)) invalide(job, 'events n\'est pas une liste');
    const events: T3CoherenceEventEntry[] = [];
    for (const e of (evRaw as unknown[] | null | undefined) ?? []) {
      if (typeof e !== 'object' || e === null || typeof (e as { event?: unknown }).event !== 'string') {
        invalide(job, 'événement consolidé malformé');
      }
      const o = e as Record<string, unknown>;
      events.push({
        event: String(o.event),
        ...(typeof o.objectType === 'string' && OBJECT_TYPES.has(o.objectType)
          ? { objectType: o.objectType as T3CoherenceEventEntry['objectType'] } : {}),
        ...(typeof o.objectId === 'number' && Number.isInteger(o.objectId) ? { objectId: o.objectId } : {}),
        ...(typeof o.correlationId === 'string' ? { correlationId: o.correlationId } : {}),
        ...(typeof o.at === 'string' ? { at: o.at } : {}),
      });
    }
    return {
      kind: 'account',
      scope: (scope as 'full' | 'incremental' | undefined) ?? null,
      events,
      requestedByUserId: optId(job, raw, 'requestedByUserId'),
      scheduled: raw.scheduled === true,
      requestedAt: optDate(job, raw, 'requestedAt'),
    };
  },
});

registerT3JobKind<T3SweepPayload>({
  kind: 'sweep',
  targetTypes: [null, T3_TARGET_SWEEP_PAGE],
  account: 'forbidden',
  versions: [1],
  legacy: true,
  parse(raw, job) {
    const after = raw.afterAccountId;
    if (after !== undefined && after !== null && (typeof after !== 'number' || !Number.isInteger(after) || after < 0)) {
      invalide(job, 'curseur de balayage invalide');
    }
    const page = raw.page;
    if (page !== undefined && page !== null && (typeof page !== 'number' || !Number.isInteger(page) || page < 0)) {
      invalide(job, 'rang de page invalide');
    }
    const cycleId = raw.cycleId == null ? null : String(raw.cycleId);
    if (job.targetType === T3_TARGET_SWEEP_PAGE && !cycleId) invalide(job, 'page de balayage sans cycle');
    return {
      kind: 'sweep', cycleId,
      cycleStartedAt: optDate(job, raw, 'cycleStartedAt'),
      afterAccountId: (after as number | undefined) ?? 0,
      page: (page as number | undefined) ?? 0,
      requestedAt: optDate(job, raw, 'requestedAt'),
    };
  },
});

// ── Résolution d'un job ─────────────────────────────────────────────────────

export interface ResolvedT3Job<P = unknown> {
  spec: T3JobKindSpec<P>;
  kind: string;
  /** 0 = contexte historique sans version. */
  payloadVersion: number;
  payload: P;
}

function shapeAccepts(spec: T3JobKindSpec, job: T3JobShape): boolean {
  if (!spec.targetTypes.includes(job.targetType ?? null)) return false;
  return spec.account === 'required' ? job.accountId != null : job.accountId == null;
}

/**
 * Valide le contexte d'un job et désigne sa sorte. Lève `PermanentJobError`
 * (FAILED immédiat) si le travail est inexécutable.
 */
export function resolveT3Job(job: QueuedJob): ResolvedT3Job {
  const raw = job.payload ?? {};
  if (typeof raw !== 'object' || Array.isArray(raw)) invalide(job, 'contexte structurellement incorrect');

  const v = (raw as Record<string, unknown>).payloadVersion;
  let version: number;
  if (v === undefined || v === null) version = T3_LEGACY_PAYLOAD_VERSION;
  else if (typeof v === 'number' && Number.isInteger(v) && v > 0) version = v;
  else return invalide(job, `payloadVersion « ${String(v)} » inconnue`);

  const declared = (raw as Record<string, unknown>).kind;
  let spec: T3JobKindSpec | undefined;
  if (declared !== undefined && declared !== null) {
    if (typeof declared !== 'string') invalide(job, 'kind invalide');
    spec = registry.get(declared as string);
    if (!spec) invalide(job, `sorte de travail « ${String(declared)} » inconnue`);
    if (!shapeAccepts(spec!, job)) {
      invalide(job, `cible « ${job.targetType ?? 'aucune'} »${job.accountId == null ? ' sans compte' : ''} incompatible avec la sorte « ${spec!.kind} »`);
    }
  } else {
    // Contexte sans sorte (historique) : déduite de la forme du job.
    const candidats = [...registry.values()].filter((s) => shapeAccepts(s, job));
    if (candidats.length !== 1) invalide(job, `type de cible « ${job.targetType ?? 'aucun'} » incompatible avec T3`);
    spec = candidats[0];
  }

  const s = spec!;
  if (version === T3_LEGACY_PAYLOAD_VERSION ? !s.legacy : !s.versions.includes(version)) {
    invalide(job, `payloadVersion ${version} inconnue pour la sorte « ${s.kind} »`);
  }
  return { spec: s, kind: s.kind, payloadVersion: version, payload: s.parse(raw as Record<string, unknown>, job, version) };
}
