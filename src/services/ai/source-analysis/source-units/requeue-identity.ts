/**
 * Lot 115H (Trello #785, § 2 et § 4) — IDENTITÉ PERSISTANTE ET IDEMPOTENTE
 * D'UNE DEMANDE DE REPRISE T1, et réservation durable de son droit.
 * Complété par la carte Trello #837 (points A3, B1, B2) — voir plus bas.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI
 *
 * Le lot 114H lisait l'issue RÉELLE de la file et ne consommait aucune reprise
 * pour un travail déjà vivant ; le § 1 de ce lot a ajouté le contrôle et la
 * réservation du droit AVANT tout enfilement. Deux trous restaient :
 *
 *   § 2 — une demande IDENTIQUE à ce qu'une exécution est déjà en train de
 *   satisfaire posait `coalesce_requested` sur le travail en cours, et un
 *   PASSAGE SUPPLÉMENTAIRE naissait à sa clôture.
 *
 *   § 4 — la création du travail et l'écriture du compteur sont dans deux
 *   transactions distinctes (la file a la sienne). Un arrêt entre les deux
 *   laissait une tentative ACCEPTÉE mais NON comptabilisée.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CARTE #837 — CE QUI CHANGE
 *
 *   A3  IDENTITÉ CANONIQUE. La clé ne contient plus le CANAL (`requestedBy`,
 *       `origin`) : compte + document + ACTION + empreinte des preuves. Une
 *       même demande portée par le BO puis par le planificateur (ou deux
 *       exécutants) retrouve la MÊME ligne et ne réserve qu'UN droit. Le canal
 *       est conservé comme PROVENANCE (colonnes `origin`, `requested_by`,
 *       historique des cycles).
 *       La migration 1805 est OBLIGATOIRE pour la remise en file : son absence
 *       rend la demande INDISPONIBLE de façon visible (fail-closed), au lieu
 *       de poursuivre sans identité.
 *   A3/B2  RÉSERVATION ATOMIQUE SOUS BAIL. Ouverture de la demande, contrôle du
 *       droit, incrément du compteur et passage à `RESERVED` (avec un JETON de
 *       bail) ont lieu dans UNE transaction, ligne de demande et ligne de
 *       couverture verrouillées. Une demande `RESERVED` dont le bail est
 *       vivant n'est jamais lue « à moitié » ni doublée : un second exécutant
 *       reçoit `IN_PROGRESS`. Chaque écriture d'étape est conditionnée par le
 *       jeton et CONFIRMÉE (`RETURNING`) ; un échec d'écriture est rendu,
 *       jamais absorbé.
 *   B1  RESTITUTION ATOMIQUE. `RECOVERED` et la restitution du droit de CETTE
 *       demande sont écrits dans UNE transaction, lignes verrouillées
 *       (`FOR UPDATE SKIP LOCKED` : deux récupérateurs ne rendent jamais deux
 *       fois), restitution conditionnelle (`retry_attempts >= reserved_attempt`)
 *       et confirmée. Une panne entre les deux écritures annule les deux.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash, randomUUID } from 'node:crypto';
import type { RequeueOrigin } from './retry-policy';

type Row = Record<string, unknown>;
type Tx = { unsafe: (q: string, p?: never[]) => Promise<unknown> };

/**
 * États d'une demande de reprise T1 (colonne `state` de `t1_requeue_requests`).
 * Carte #837 : `OPEN` — ligne créée, droit pas encore jugé (n'existe qu'à
 * l'intérieur de la transaction d'ouverture, ou après un refus d'admission).
 */
export const REQUEUE_REQUEST_STATES = ['OPEN', 'RESERVED', 'CONFIRMED', 'OBSERVED', 'RELEASED', 'REFUSED', 'RECOVERED'] as const;
export type RequeueRequestState = (typeof REQUEUE_REQUEST_STATES)[number];

/** Frontières franchies par une demande (jamais de contenu de document). */
export interface RequeueSteps {
  reserved?: boolean;
  enqueued?: boolean;
  inspected?: boolean;
  counted?: boolean;
  diagnosed?: boolean;
  recovered?: boolean;
  /** Carte #837 (B1) : le droit réservé a été RENDU (restitution confirmée en base). */
  restituted?: boolean;
  refused?: boolean;
}

/**
 * EMPREINTE DES PREUVES d'un document au moment d'une demande (pure).
 *
 * Carte #837 (C2) : `dependencies` — empreinte versionnée de TOUTES les
 * données confrontées (`evidence-version.ts` : faits, décisions, candidats,
 * tableaux, ancrages, extraction, texte original). Les codes et compteurs
 * restent dans l'empreinte (ils disent l'état), mais ne suffisent plus.
 */
export function requeueEvidenceFingerprint(p: {
  qualityState?: string | null;
  anomalies?: readonly string[] | null;
  verificationReason?: string | null;
  sourceVerification?: string | null;
  pagesMissing?: readonly number[] | null;
  unresolvedUnits?: number | null;
  uncertainUnits?: number | null;
  failedUnits?: number | null;
  /** Empreinte de la dernière re-vérification déterministe (`reverificationFingerprint`). */
  reverificationFingerprint?: string | null;
  /** Empreinte du fichier source réellement lu (`document_raw_extracts.source_sha256`). */
  sourceSha256?: string | null;
  /** Version de la couche A écrite. */
  layerVersion?: number | null;
  /** Carte #837 (C2) : empreinte versionnée des dépendances lues (`loadEvidenceDependencies`). */
  dependencies?: string | null;
}): string {
  const pages = [...(p.pagesMissing ?? [])].map(Number).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  const anomalies = [...(p.anomalies ?? [])].map(String).sort();
  const parts = [
    p.qualityState ?? '', anomalies.join(','), p.verificationReason ?? '', p.sourceVerification ?? '',
    pages.join(','), String(p.unresolvedUnits ?? 0), String(p.uncertainUnits ?? 0), String(p.failedUnits ?? 0),
    p.reverificationFingerprint ?? '', p.sourceSha256 ?? '', String(p.layerVersion ?? 0),
  ];
  // Compatibilité : sans dépendances, l'empreinte reste celle du lot 115H (mêmes entrées, même valeur).
  if (p.dependencies) parts.push(p.dependencies);
  return createHash('sha256').update(parts.join('\u0001')).digest('hex').slice(0, 32);
}

/** Action demandée — partie de l'identité canonique (carte #837, A3). */
export type RequeueAction =
  /** Relecture du fichier pour compléter / vérifier la couverture (reprise, BO, re-vérification). */
  | 'COMPLETENESS_REREAD'
  /** Nouvelle extraction demandée par le contrôle de cohérence (chaîne d'extraction, classement). */
  | 'COHERENCE_REEXTRACT';

/** Action d'une demande, depuis son origine technique (pure). */
export function requeueActionOf(origin: string): RequeueAction {
  return origin === 'coherence-control' ? 'COHERENCE_REEXTRACT' : 'COMPLETENESS_REREAD';
}

/**
 * IDENTITÉ CANONIQUE d'une demande (pure) — carte #837 (A3) : compte et
 * document (colonnes de la ligne), ACTION et EMPREINTE DES PREUVES. Le canal
 * (`requestedBy`, `origin`) n'en fait plus partie : c'est une provenance.
 * `explicit` : identité imposée par l'appelant (action manuelle distincte,
 * justifiée par lui).
 */
export function requeueRequestKey(p: {
  action: RequeueAction; evidenceFingerprint: string; explicit?: string | null;
}): string {
  if (p.explicit && p.explicit.trim() !== '') return p.explicit.trim().slice(0, 180);
  return `${p.action}:${p.evidenceFingerprint}`.slice(0, 180);
}

let tablePresente: { ready: boolean; at: number } | null = null;

/**
 * Migrations 1805 ET 1970 appliquées ? (mémorisé 30 s ; ne lève jamais)
 * Carte #837 (A3) : sans elles, la remise en file est INDISPONIBLE (fail-closed).
 */
export async function requeueRequestsReady(): Promise<boolean> {
  if (tablePresente && Date.now() - tablePresente.at < 30_000) return tablePresente.ready;
  try {
    const { pgClient } = await import('@/db');
    const r = (await pgClient.unsafe(
      `SELECT to_regclass('t1_requeue_requests') IS NOT NULL AS ok,
              EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name = 't1_requeue_requests' AND column_name = 'lease_token') AS bail`,
    )) as unknown as Array<{ ok: boolean; bail?: boolean }>;
    // `bail` absent (double de test ancien) : seule la table est exigée.
    tablePresente = { ready: r[0]?.ok === true && r[0]?.bail !== false, at: Date.now() };
  } catch {
    tablePresente = { ready: false, at: Date.now() };
  }
  return tablePresente.ready;
}

/** Remise à zéro de la mémoire de présence (tests). */
export function resetRequeueRequestsReadyCache(): void {
  tablePresente = null;
}

/** Migration 1805 (ou 1970) absente : la remise en file est refusée, visiblement (carte #837, A3). */
export class RequeueIdentityUnavailableError extends Error {
  constructor() {
    super('identité des demandes de reprise T1 indisponible (migrations 1805 / 1970 non appliquées) — remise en file refusée');
    this.name = 'RequeueIdentityUnavailableError';
  }
}

export interface RequeueRequestRecord {
  id: number;
  state: RequeueRequestState;
  reservedAttempt: number | null;
  attemptConsumed: boolean;
  jobId: number | null;
  reason: string | null;
  steps: RequeueSteps;
  /** La ligne vient d'être créée par cet appel (aucune demande antérieure de cette identité). */
  fresh: boolean;
  /** Bail de réservation vivant (une autre exécution tient la demande). */
  leaseAlive?: boolean;
}

const etapes = (v: unknown): RequeueSteps => {
  const o = (typeof v === 'string' ? JSON.parse(v) : v) as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return {};
  const out: RequeueSteps = {};
  for (const k of ['reserved', 'enqueued', 'inspected', 'counted', 'diagnosed', 'recovered', 'restituted', 'refused'] as const) {
    if (o[k] === true) out[k] = true;
  }
  return out;
};

const enregistrement = (r: Row, fresh: boolean): RequeueRequestRecord => ({
  id: Number(r.id),
  state: String(r.state) as RequeueRequestState,
  reservedAttempt: r.reserved_attempt == null ? null : Number(r.reserved_attempt),
  attemptConsumed: r.attempt_consumed === true,
  jobId: r.job_id == null ? null : Number(r.job_id),
  reason: r.reason == null ? null : String(r.reason),
  steps: etapes(r.steps),
  fresh,
  leaseAlive: r.lease_alive === true,
});

const COLS = `id, state, reserved_attempt, attempt_consumed, job_id, reason, steps,
              (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND lease_expires_at > NOW()) AS lease_alive`;

/** Lecture SANS verrou de la demande d'une identité (null : jamais demandée). Filtrée par le compte. */
export async function readRequeueRequest(p: { accountId: number; fileId: number; requestKey: string }): Promise<RequeueRequestRecord | null> {
  if (!(await requeueRequestsReady())) throw new RequeueIdentityUnavailableError();
  const { pgClient } = await import('@/db');
  const rows = (await pgClient.unsafe(
    `/* c837:req-read */ SELECT ${COLS} FROM t1_requeue_requests WHERE account_id = $1 AND file_id = $2 AND request_key = $3`,
    [p.accountId, p.fileId, p.requestKey] as never[],
  )) as unknown as Row[];
  return rows[0] ? enregistrement(rows[0], false) : null;
}

/** Durée du bail d'une demande RÉSERVÉE (secondes) : enfilement, constat et comptage tiennent largement dedans. */
export const REQUEUE_REQUEST_LEASE_SECONDS = 300;

/** Motif d'un refus d'ADMISSION jugé avant la réservation (carte #837, A1). */
export interface AdmissionBlock {
  code: string;
  /** Cause temporaire (budget, compte, traitement suspendu) : la demande reste due. */
  temporary: boolean;
}

export type RequeueClaim =
  /** Droit réservé (ou réservation orpheline reprise) : la demande est tenue sous ce jeton. */
  | { kind: 'RESERVED'; requestId: number; leaseToken: string; reservedAttempt: number | null; resumed: boolean; fresh: boolean; attemptsBefore: number }
  /** Refus du droit ou de l'admission : aucune consommation, aucun travail. */
  | { kind: 'REFUSED'; requestId: number; block: string; temporary: boolean; attemptsBefore: number }
  /** Une AUTRE exécution tient la demande (bail vivant) : rien n'est fait. */
  | { kind: 'IN_PROGRESS'; requestId: number }
  /** La demande a changé d'état entre la lecture et le verrou (confirmée / observée par un autre) : relire. */
  | { kind: 'CHANGED'; requestId: number; state: RequeueRequestState };

/**
 * ══════════════════════════════════════════════════════════════════════════
 * CARTE #837 (A3, B2) — OUVERTURE ET RÉSERVATION ATOMIQUES D'UNE DEMANDE
 *
 * UNE transaction :
 *   1. la ligne de la demande canonique est créée si besoin (`OPEN`), puis
 *      VERROUILLÉE (`FOR UPDATE`) — deux exécutants de la même demande sont
 *      sérialisés ici ;
 *   2. son état décide : bail vivant d'un autre → `IN_PROGRESS` ; réservation
 *      orpheline (bail expiré, étape `reserved` acquise) → REPRISE sans nouvel
 *      incrément ; état confirmé/observé différent de celui que l'appelant a
 *      inspecté → `CHANGED` ;
 *   3. sinon le droit est jugé (refus d'admission transmis par l'appelant,
 *      puis plafond) et, s'il est accordé, le compteur est incrémenté sous
 *      condition ET la demande passe `RESERVED` avec un jeton neuf — dans la
 *      même transaction. Le cycle précédent est versé à l'historique.
 * ══════════════════════════════════════════════════════════════════════════
 */
export async function claimRequeueRequest(p: {
  accountId: number; fileId: number; requestKey: string; origin: string; requestedBy: RequeueOrigin;
  evidenceFingerprint: string; maxRetries: number;
  /** Ligne de couverture présente ? Sinon le droit est jugé sur `callerAttempts` (aucun compteur). */
  hasCoverage: boolean; callerAttempts: number;
  /** Refus d'admission déjà établi (fichier absent, compte non éligible, budget…) : consigné, rien n'est réservé. */
  admissionBlock: AdmissionBlock | null;
  /** État de la demande que l'appelant a inspecté (re-réservation d'une demande CONFIRMED/OBSERVED dont le travail est mort). */
  expectedState?: RequeueRequestState | null;
  campaignRef?: string | null;
}): Promise<RequeueClaim> {
  if (!(await requeueRequestsReady())) throw new RequeueIdentityUnavailableError();
  const { pgClient } = await import('@/db');
  const { decideRequeueRight } = await import('./retry-policy');
  return pgClient.begin(async (tx) => {
    const t = tx as unknown as Tx;
    const inseree = (await t.unsafe(
      `/* c837:req-insert */ INSERT INTO t1_requeue_requests
         (account_id, file_id, request_key, origin, requested_by, evidence_fingerprint, state, steps, campaign_ref)
       VALUES ($1, $2, $3, $4, $5, $6, 'OPEN', '{}'::jsonb, $7)
       ON CONFLICT (account_id, file_id, request_key) DO NOTHING
       RETURNING id`,
      [p.accountId, p.fileId, p.requestKey, p.origin, p.requestedBy, p.evidenceFingerprint, p.campaignRef ?? null] as never[],
    )) as Row[];
    const fresh = inseree.length > 0;
    const [l] = (await t.unsafe(
      `/* c837:req-lock */ SELECT ${COLS}, (lease_expires_at IS NULL OR lease_expires_at <= NOW()) AS lease_expired
         FROM t1_requeue_requests WHERE account_id = $1 AND file_id = $2 AND request_key = $3 FOR UPDATE`,
      [p.accountId, p.fileId, p.requestKey] as never[],
    )) as Row[];
    if (!l) throw new Error(`demande de reprise ${p.requestKey} introuvable après ouverture (document ${p.fileId})`);
    const d = enregistrement(l, fresh);
    if (d.state === 'RESERVED') {
      if (d.leaseAlive) return { kind: 'IN_PROGRESS', requestId: d.id };
      // Réservation ORPHELINE (bail expiré) : reprise sous un jeton neuf, sans nouvel incrément (compteur exact).
      if (d.steps.reserved) {
        const jeton = randomUUID();
        await t.unsafe(
          `/* c837:req-resume */ UPDATE t1_requeue_requests
              SET lease_token = $2::uuid, lease_expires_at = NOW() + make_interval(secs => $3), updated_at = NOW()
            WHERE id = $1 AND state = 'RESERVED'`,
          [d.id, jeton, REQUEUE_REQUEST_LEASE_SECONDS] as never[],
        );
        return { kind: 'RESERVED', requestId: d.id, leaseToken: jeton, reservedAttempt: d.reservedAttempt, resumed: true, fresh, attemptsBefore: Math.max(0, (d.reservedAttempt ?? 1) - 1) };
      }
    }
    if ((d.state === 'CONFIRMED' || d.state === 'OBSERVED') && p.expectedState !== d.state) {
      return { kind: 'CHANGED', requestId: d.id, state: d.state };
    }
    // Tentatives lues SOUS VERROU (ligne de couverture verrouillée jusqu'à la fin de la transaction).
    let tentatives = Math.max(0, p.callerAttempts);
    if (p.hasCoverage) {
      const [c] = (await t.unsafe(
        `/* c837:cov-lock */ SELECT retry_attempts FROM document_extraction_coverage WHERE file_id = $1 AND account_id = $2 FOR UPDATE`,
        [p.fileId, p.accountId] as never[],
      )) as Row[];
      if (c) tentatives = Number(c.retry_attempts ?? 0) || 0;
    }
    const archiver = `history = (CASE WHEN state = 'OPEN' THEN history ELSE history || jsonb_build_array(jsonb_build_object(
         'state', state, 'steps', steps, 'jobId', job_id, 'reason', reason, 'reservedAttempt', reserved_attempt,
         'attemptConsumed', attempt_consumed, 'origin', origin, 'requestedBy', requested_by, 'at', updated_at)) END)`;
    const refuser = async (code: string, temporary: boolean): Promise<RequeueClaim> => {
      await t.unsafe(
        `/* c837:req-refuse */ UPDATE t1_requeue_requests
            SET ${archiver}, state = 'REFUSED', reason = $2, steps = '{"refused":true}'::jsonb, origin = $3, requested_by = $4,
                lease_token = NULL, lease_expires_at = NULL, updated_at = NOW()
          WHERE id = $1`,
        [d.id, code, p.origin, p.requestedBy] as never[],
      );
      return { kind: 'REFUSED', requestId: d.id, block: code, temporary, attemptsBefore: tentatives };
    };
    if (p.admissionBlock) return refuser(p.admissionBlock.code, p.admissionBlock.temporary);
    const droit = decideRequeueRight({ retryAttempts: tentatives }, { maxRetries: p.maxRetries });
    if (!droit.allowed) return refuser(droit.block ?? 'RETRY_CAP_REACHED', false);
    let reserveeA: number | null = null;
    if (p.hasCoverage) {
      // Réservation CONDITIONNELLE (même instruction que le lot 115H) : la ligne n'est modifiée que si le plafond le permet.
      const r = (await t.unsafe(
        `UPDATE document_extraction_coverage
            SET retry_attempts = retry_attempts + 1, updated_at = NOW()
          WHERE file_id = $1 AND account_id = $2 AND retry_attempts < $3::int
          RETURNING retry_attempts AS n`,
        [p.fileId, p.accountId, p.maxRetries] as never[],
      )) as Row[];
      if (r.length === 0) return refuser('RETRY_CAP_REACHED', false);
      reserveeA = Number(r[0].n);
    }
    const jeton = randomUUID();
    const ok = (await t.unsafe(
      `/* c837:req-reserve */ UPDATE t1_requeue_requests
          SET ${archiver}, state = 'RESERVED', reserved_attempt = $2::int, attempt_consumed = FALSE, job_id = NULL, reason = NULL,
              steps = '{"reserved":true}'::jsonb, lease_token = $3::uuid, lease_expires_at = NOW() + make_interval(secs => $4),
              origin = $5, requested_by = $6, evidence_fingerprint = $7, campaign_ref = COALESCE($8, campaign_ref),
              cycles = cycles + 1, updated_at = NOW()
        WHERE id = $1
        RETURNING id`,
      [d.id, reserveeA, jeton, REQUEUE_REQUEST_LEASE_SECONDS, p.origin, p.requestedBy, p.evidenceFingerprint, p.campaignRef ?? null] as never[],
    )) as Row[];
    // Écriture NON confirmée : la transaction est annulée (le compteur n'est pas incrémenté seul).
    if (ok.length === 0) throw new Error(`réservation de la demande ${d.id} non confirmée en base`);
    return { kind: 'RESERVED', requestId: d.id, leaseToken: jeton, reservedAttempt: reserveeA, resumed: false, fresh, attemptsBefore: tentatives };
  }) as Promise<RequeueClaim>;
}

/**
 * Consigne une étape d'une demande RÉSERVÉE, sous son jeton (fencing) et en
 * prolongeant le bail. Rend `true` seulement si l'écriture est CONFIRMÉE en
 * base ; `false` : jeton perdu (bail expiré et demande reprise ou restituée).
 * Les erreurs SQL sont PROPAGÉES (carte #837, B2 : jamais absorbées).
 */
export async function markRequeueStep(p: {
  requestId: number; leaseToken: string; steps: RequeueSteps; jobId?: number | null; reason?: string | null;
}): Promise<boolean> {
  const { pgClient } = await import('@/db');
  const r = (await pgClient.unsafe(
    `/* c837:req-step */ UPDATE t1_requeue_requests
        SET steps = steps || $3::jsonb, job_id = COALESCE($4::bigint, job_id), reason = COALESCE($5, reason),
            lease_expires_at = NOW() + make_interval(secs => $6), updated_at = NOW()
      WHERE id = $1 AND lease_token = $2::uuid AND state = 'RESERVED'
      RETURNING id`,
    [p.requestId, p.leaseToken, JSON.stringify(p.steps), p.jobId ?? null, p.reason ?? null, REQUEUE_REQUEST_LEASE_SECONDS] as never[],
  )) as unknown as Row[];
  return r.length > 0;
}

/**
 * Transition CONDITIONNELLE d'une demande connue (constat d'un travail vivant,
 * demande déjà satisfaite) : écrite seulement si l'état lu est toujours le
 * sien. Rend `true` si confirmée.
 */
export async function noteKnownRequest(p: {
  requestId: number; fromState: RequeueRequestState; toState?: RequeueRequestState; jobId?: number | null; reason: string;
}): Promise<boolean> {
  const { pgClient } = await import('@/db');
  const r = (await pgClient.unsafe(
    `/* c837:req-note */ UPDATE t1_requeue_requests
        SET state = COALESCE($3, state), job_id = COALESCE($4::bigint, job_id), reason = $5,
            steps = steps || '{"inspected":true}'::jsonb, updated_at = NOW()
      WHERE id = $1 AND state = $2
      RETURNING id`,
    [p.requestId, p.fromState, p.toState ?? null, p.jobId ?? null, p.reason] as never[],
  )) as unknown as Row[];
  return r.length > 0;
}

/** Délai au-delà duquel une réservation SANS bail (lignes antérieures à la migration 1970) est orpheline (minutes). */
export const REQUEUE_RESERVATION_STALE_MINUTES = 30;

export interface RequeueRecoveryResult {
  /** Réservations examinées. */
  examined: number;
  /** Réservations dont un travail vivant a été constaté : la consommation est TENUE. */
  confirmed: number;
  /** Réservations rendues (aucun travail vivant) : la tentative n'est pas perdue, elle n'est pas consommée. */
  released: number;
  /** Carte #837 (B1) : restitutions du compteur CONFIRMÉES en base (≤ released). */
  restituted: number;
  /** Réservations prises par un autre récupérateur entre la lecture et le verrou (rien fait). */
  skipped: number;
  /** Erreurs (la demande reste RESERVED : reprise au passage suivant, rien n'est perdu). */
  errors: number;
  /** Migration 1805 / 1970 absente. */
  disabled?: string;
}

/**
 * ══════════════════════════════════════════════════════════════════════════
 * REPRISE APRÈS PANNE ENTRE DEUX ÉCRITURES (lot 115H § 4, carte #837 B1)
 *
 * Une demande `RESERVED` dont le BAIL a expiré a réservé une reprise sans que
 * la suite ait abouti. Deux cas, tranchés sur l'ÉTAT RÉEL du travail en base :
 *
 *   · un travail vivant du document existe → la réservation est TENUE
 *     (`CONFIRMED`, consommation acquise) ;
 *   · aucun travail vivant → la réservation est RENDUE.
 *
 * Carte #837 (B1) — règle remplacée : l'état passait à `RECOVERED` dans une
 * instruction, puis le compteur était décrémenté dans une AUTRE — un arrêt
 * entre les deux laissait la demande définitivement « récupérée » et le droit
 * consommé. Désormais les deux écritures sont dans UNE transaction, la ligne
 * de la demande verrouillée `FOR UPDATE SKIP LOCKED` (deux récupérateurs ne
 * rendent jamais deux fois), la restitution conditionnée par
 * `retry_attempts >= reserved_attempt` (le compteur porte encore CETTE
 * réservation) et confirmée par `RETURNING`. `beforeRestitution` : point
 * d'injection de panne (tests de recette) — une erreur levée là annule TOUT.
 *
 * Aucune suppression, aucun appel IA, aucune notification. Ne lève jamais.
 * ══════════════════════════════════════════════════════════════════════════
 */
export async function recoverRequeueReservations(opts: {
  staleMinutes?: number; limit?: number; accountId?: number;
  /** Recette (carte #837, B1) : appelé entre le passage à RECOVERED et la restitution, DANS la transaction. */
  beforeRestitution?: (p: { requestId: number; fileId: number }) => Promise<void> | void;
} = {}): Promise<RequeueRecoveryResult> {
  const res: RequeueRecoveryResult = { examined: 0, confirmed: 0, released: 0, restituted: 0, skipped: 0, errors: 0 };
  if (!(await requeueRequestsReady())) return { ...res, disabled: 'MIGRATION_1805_OR_1970_MISSING' };
  const { pgClient } = await import('@/db');
  const minutes = Math.max(1, Math.trunc(opts.staleMinutes ?? REQUEUE_RESERVATION_STALE_MINUTES));
  const limite = Math.min(500, Math.max(1, Math.trunc(opts.limit ?? 100)));
  const orpheline = `state = 'RESERVED' AND ((lease_expires_at IS NOT NULL AND lease_expires_at <= NOW())
                       OR (lease_expires_at IS NULL AND updated_at < NOW() - make_interval(mins => $1)))`;
  let lignes: Row[];
  try {
    lignes = (await pgClient.unsafe(
      `/* c837:rec-scan */ SELECT id, account_id, file_id, reserved_attempt, job_id FROM t1_requeue_requests
        WHERE ${orpheline} AND ($3::int IS NULL OR account_id = $3)
        ORDER BY updated_at
        LIMIT $2`,
      [minutes, limite, opts.accountId ?? null] as never[],
    )) as unknown as Row[];
  } catch (e) {
    console.error('[t1-requeue] récupération des réservations impossible :', (e as Error).message);
    return { ...res, errors: 1 };
  }
  const { inspectCorrelatedJob } = await import('../../queue/job-queue.repository');
  for (const l of lignes) {
    res.examined++;
    const id = Number(l.id);
    const accountId = Number(l.account_id);
    const fileId = Number(l.file_id);
    try {
      const travail = await inspectCorrelatedJob({
        treatment: 'T1', accountId, targetType: 'asset_file', targetId: fileId,
        jobId: l.job_id == null ? null : Number(l.job_id),
      });
      const issue = await pgClient.begin(async (tx) => {
        const t = tx as unknown as Tx;
        const [verrou] = (await t.unsafe(
          `/* c837:rec-lock */ SELECT id, reserved_attempt FROM t1_requeue_requests
            WHERE id = $2 AND ${orpheline}
            FOR UPDATE SKIP LOCKED`,
          [minutes, id] as never[],
        )) as Row[];
        if (!verrou) return 'SKIPPED' as const;
        if (travail.state === 'ALIVE') {
          await t.unsafe(
            `/* c837:rec-confirm */ UPDATE t1_requeue_requests
                SET state = 'CONFIRMED', attempt_consumed = TRUE, job_id = COALESCE($2::bigint, job_id), lease_token = NULL, lease_expires_at = NULL,
                    steps = steps || '{"recovered":true,"inspected":true,"counted":true}'::jsonb, updated_at = NOW()
              WHERE id = $1 AND state = 'RESERVED'`,
            [id, travail.jobId] as never[],
          );
          return 'CONFIRMED' as const;
        }
        const reservee = verrou.reserved_attempt == null ? null : Number(verrou.reserved_attempt);
        await t.unsafe(
          `/* c837:rec-release */ UPDATE t1_requeue_requests
              SET state = 'RECOVERED', attempt_consumed = FALSE, reason = $2, lease_token = NULL, lease_expires_at = NULL,
                  steps = steps || '{"recovered":true,"inspected":true}'::jsonb, updated_at = NOW()
            WHERE id = $1 AND state = 'RESERVED'`,
          [id, `réservation rendue : aucun travail T1 vivant (${travail.state})`] as never[],
        );
        if (opts.beforeRestitution) await opts.beforeRestitution({ requestId: id, fileId });
        let rendue = false;
        if (reservee !== null) {
          const r = (await t.unsafe(
            `/* c837:rec-restitute */ UPDATE document_extraction_coverage
                SET retry_attempts = GREATEST(0, retry_attempts - 1), updated_at = NOW()
              WHERE file_id = $1 AND account_id = $2 AND retry_attempts >= $3::int
              RETURNING retry_attempts`,
            [fileId, accountId, reservee] as never[],
          )) as Row[];
          rendue = r.length > 0;
          await t.unsafe(
            `/* c837:rec-mark */ UPDATE t1_requeue_requests SET steps = steps || $2::jsonb WHERE id = $1`,
            [id, JSON.stringify({ restituted: rendue })] as never[],
          );
        }
        return rendue ? 'RESTITUTED' as const : 'RELEASED' as const;
      });
      if (issue === 'SKIPPED') { res.skipped++; continue; }
      if (issue === 'CONFIRMED') { res.confirmed++; continue; }
      res.released++;
      if (issue === 'RESTITUTED') res.restituted++;
      console.info(`[t1-requeue] document ${fileId} : réservation orpheline rendue (aucun travail vivant, ${travail.state})`
        + `${issue === 'RESTITUTED' ? ', droit restitué' : ', aucun compteur à restituer'}.`);
    } catch (e) {
      res.errors++;
      console.error(`[t1-requeue] réservation ${id} non récupérée (reste RESERVED, reprise au passage suivant) :`, (e as Error).message);
    }
  }
  return res;
}
