/**
 * Lot 114 (carte #776, travail 11 — AC18) — ALERTES DE COMPATIBILITÉ DE
 * SCHÉMA : une alerte de CONDITION par couple refusé, et leur réévaluation.
 *
 *   · UNE alerte non résolue par couple (`raiseConditionAlert`, clé sans
 *     date) : levée quand le couple PASSE en refus ; les appels suivants, qui
 *     partent sans schéma à cause du refus mémorisé, n'en lèvent aucune —
 *     pas de doublon par appel, ni par passage quotidien ;
 *   · résolue automatiquement quand la cause a disparu : le fournisseur a
 *     accepté le schéma lors d'un appel réel (`SCHEMA_ACCEPTED_AGAIN`), ou le
 *     couple n'est plus celui que la passerelle transmet — contrat, schéma
 *     projeté ou adaptateur changés, opération retirée (`SCHEMA_SUPERSEDED`) ;
 *   · une alerte dont le couple est toujours refusé et toujours transmis
 *     reste ACTIVE ; rien n'est supprimé, aucune remise à zéro : les refus
 *     HTTP 400 restent dans les traces d'appels et dans la matrice.
 *
 * Périmètre : compatibilité de SCHÉMA seulement. Les alertes de disponibilité
 * des modèles (#771) et de tarifs (#770) ne sont ni lues ni touchées ici.
 *
 * Lot 115 (carte #784, §E3) — COORDINATION avec les alertes de couverture et de
 * normalisation T1 de la carte #775 : elles vivent dans `admin_anomalies`, avec
 * leur propre passage quotidien. Ce passage-ci les lit en CONSTAT seulement
 * (combien sont ouvertes avant et après) et n'en ferme, n'en ouvre ni n'en
 * modifie AUCUNE : aucun second ordonnanceur, aucun double emploi, et une
 * réussite en mode JSON après un refus de schéma ne masque jamais une
 * couverture T1 incomplète. Le constat est rendu dans le bilan et affiché au BO.
 */
import { pgClient } from '@/db';
import { SCHEMA_COMPAT_STATE_LABELS, type SchemaCoupleState } from './policy';
import type { CoupleRoutingStatus } from './static-matrix';

type Row = Record<string, unknown>;

/** Code de l'alerte « schéma de sortie refusé par le fournisseur ». */
export const SCHEMA_COMPAT_ALERT_CODE = 'ai_schema_incompatibility';

const conditionKeyOf = (keyId: string): string => `ai:schema-compat:${keyId}`;

/** Traitement (T1…T6) d'un code d'opération maître (`t1_analyze_document` → `T1`) ; `null` sinon. */
function treatmentOf(operationCode: string): string | null {
  const m = /^t([1-6])_/.exec(operationCode);
  return m ? `T${m[1]}` : null;
}

/** Texte de l'alerte (à valider par le PO). Aucun contenu : opération, modèle, contrat, empreintes. */
export function schemaIncompatibilityMessage(s: SchemaCoupleState): string {
  const k = s.key;
  const motif = s.reason === 'EXPLICIT_SCHEMA_REJECTION'
    ? 'le fournisseur a refusé le schéma de sortie'
    : 'le fournisseur a refusé la requête portant le schéma de sortie (HTTP 400 sans précision), puis a répondu au même modèle sans schéma';
  const prochain = s.nextRetestAt ? ` Prochain essai avec schéma au plus tôt le ${new Date(s.nextRetestAt).toISOString().slice(0, 16).replace('T', ' ')} UTC.` : '';
  return `${k.operationCode} · ${k.model} : ${motif}. Les appels continuent en mode JSON, validés par le même contrat `
    + `(${k.contractId} v${k.contractVersion}, ${k.schemaHash}) ; le schéma imposé n’est plus transmis à ce couple.${prochain} `
    + 'La cause interne du refus n’est pas indiquée par le fournisseur. Suivi : BO › Exécutions IA › Schémas structurés.';
}

/** Lève (ou met à jour) l'alerte de condition d'un couple refusé. Ne lève jamais d'erreur. */
export async function raiseSchemaIncompatibilityAlert(s: SchemaCoupleState): Promise<boolean> {
  try {
    const { raiseConditionAlert } = await import('../../alerts/alerts.repository');
    const k = s.key;
    const r = await raiseConditionAlert({
      kind: 'anomaly', code: SCHEMA_COMPAT_ALERT_CODE, treatment: treatmentOf(k.operationCode), severity: 'warning',
      message: schemaIncompatibilityMessage(s),
      details: {
        keyId: s.keyId, provider: k.provider, model: k.model, operationCode: k.operationCode, contractId: k.contractId,
        contractVersion: k.contractVersion, schemaHash: k.schemaHash, providerSchemaHash: k.providerSchemaHash, adapterVersion: k.adapterVersion,
        state: s.state, stateLabel: SCHEMA_COMPAT_STATE_LABELS[s.state], reason: s.reason, rejectionCount: s.rejectionCount,
        consecutiveRejections: s.consecutiveRejections, nextRetestAt: s.nextRetestAt ? new Date(s.nextRetestAt).toISOString() : null,
        policyVersion: s.policyVersion,
      },
      drilldownHref: `/admin/ai-executions?vue=technique&tab=schemas&schemaOperation=${encodeURIComponent(k.operationCode)}`,
      conditionKey: conditionKeyOf(s.keyId),
      fallbackDedupeKey: `${conditionKeyOf(s.keyId)}:${new Date(s.lastRejectedAt ?? Date.now()).toISOString().slice(0, 10)}`,
    });
    return r.created;
  } catch {
    return false;
  }
}

export type SchemaAlertResolution = 'SCHEMA_ACCEPTED_AGAIN' | 'SCHEMA_SUPERSEDED';

const RESOLUTION_REASONS: Record<SchemaAlertResolutionAll, string> = {
  SCHEMA_ACCEPTED_AGAIN: 'Le fournisseur a répondu à un appel réel portant ce schéma — résolution automatique.',
  SCHEMA_SUPERSEDED: 'Le contrat, le schéma transmis ou l’adaptateur de ce couple a changé (ou ce type d’appel est retiré) : ce refus ne concerne plus les appels actuels — résolution automatique. Les refus restent dans l’historique des appels.',
  // Lot 115 (carte #784, §E1) — texte nouveau, à valider par le PO.
  SCHEMA_MODEL_WITHDRAWN: 'Ce modèle n’est plus configuré pour ce type d’appel et n’est plus au référentiel des modèles : ce refus ne concerne plus les appels actuels — résolution automatique. Les refus restent dans l’historique des appels.',
};

/** Résout l'alerte non résolue d'un couple. Rend le nombre d'alertes résolues ; ne lève jamais. */
export async function resolveSchemaIncompatibilityAlert(keyId: string, code: SchemaAlertResolutionAll): Promise<number> {
  try {
    const rows = (await pgClient.unsafe(
      `SELECT id FROM ai_alerts WHERE code = $1 AND condition_key = $2 AND resolved_at IS NULL`,
      [SCHEMA_COMPAT_ALERT_CODE, conditionKeyOf(keyId)] as never[],
    )) as unknown as Row[];
    if (rows.length === 0) return 0;
    const { resolveAlerts } = await import('../../alerts/alerts.repository');
    return await resolveAlerts(rows.map((r) => Number(r.id)), { code, reason: RESOLUTION_REASONS[code] });
  } catch {
    return 0;
  }
}

export type SchemaAlertResolutionAll = SchemaAlertResolution | 'SCHEMA_MODEL_WITHDRAWN';

export interface SchemaAlertReevaluation {
  /** Alertes de compatibilité non résolues examinées. */
  examined: number;
  /** Alertes résolues, par motif. */
  resolved: Record<SchemaAlertResolutionAll, number>;
  /** Alertes conservées : le couple est toujours refusé et toujours transmis. */
  keptActive: number;
  /** Alertes conservées faute de pouvoir conclure (couple illisible). */
  keptUndetermined: number;
  /**
   * Lot 115 (carte #784, §E1) — alertes conservées parce que le ROUTAGE RÉEL
   * n'a pas pu être établi, ou que le modèle est hors chaîne mais toujours
   * déclaré : une indisponibilité ponctuelle ou un état inconnu ne ferme
   * JAMAIS une alerte (et ne la rouvre donc pas le lendemain).
   */
  keptRoutingUnknown: number;
  /** Alertes levées pour un couple refusé qui n'en avait pas (alerte non écrite lors du refus). */
  raised: number;
  /**
   * Lot 115 (carte #784, §E1) — alertes qu'on s'est ABSTENU de lever parce que
   * le routage réel du couple n'a pas pu être établi : les lever rouvrirait au
   * passage suivant ce qui vient d'être clos. Le prochain passage, routage
   * lisible, lèvera ce qui doit l'être.
   */
  raiseSkippedRoutingUnknown: number;
  /** Lecture interrompue (migration absente, base illisible) : rien n'a été modifié au-delà de ce compte. */
  unavailable: boolean;
  /**
   * Lot 115 (carte #784, §E2) — RATTRAPAGE REPRENABLE. `done` : l'ensemble a
   * été parcouru en entier. Sinon le budget de ce passage est épuisé et
   * `resumeFromAlertId` dit où reprendre — aucune alerte n'est sautée, aucune
   * n'est traitée deux fois.
   */
  done: boolean;
  resumeFromAlertId: number | null;
  /**
   * Bilan AVANT / APRÈS (carte #784, §E2) : alertes de ce code non résolues au
   * début et à la fin du passage, et couples par état. `null` : non mesurable.
   */
  before: { openAlerts: number | null; couplesByState: Record<string, number> | null };
  after: { openAlerts: number | null };
  /** Couples refusés PARCOURUS pour le rattrapage (parcours exhaustif, jamais borné à 2 000). */
  couplesScanned: number;
  /**
   * Lot 115 (carte #784, §E3) — COORDINATION avec les alertes de couverture et
   * de normalisation T1 de la carte #775. Elles vivent ailleurs
   * (`admin_anomalies`, préfixes de LEUR référentiel), elles ont leur PROPRE
   * passage quotidien, et
   * ce passage-ci ne les lit qu'en CONSTAT : il n'en ferme, n'en ouvre et n'en
   * modifie aucune. C'est ce que dit ce bilan, mesure à l'appui.
   */
  coverageCoordination: CoverageCoordination;
  /**
   * Carte #838 (D1) — POINT DE REPRISE DURABLE (passage avec `checkpoint`) :
   * `null` : passage manuel à curseur explicite (comportement antérieur).
   */
  checkpoint: SchemaAlertCheckpointReport | null;
}

/** Carte #838 (D1) — bilan du point de reprise d'un passage. */
export interface SchemaAlertCheckpointReport {
  scope: string;
  /**
   * `RAN`                passage exécuté (cycle repris ou commencé) ;
   * `LEASE_HELD`         une autre instance tient le bail : rien fait ici ;
   * `NOTHING_TO_DO`      aucun cycle interrompu et le prochain n'est pas dû ;
   * `UNAVAILABLE`        table de la migration 1980 absente : passage complet
   *                      sans point de reprise (comportement antérieur, signalé) ;
   * `LEASE_LOST`         bail repris par une autre instance en cours de route
   *                      (le présent passage s'est arrêté, rien n'est doublé).
   */
  status: 'RAN' | 'LEASE_HELD' | 'NOTHING_TO_DO' | 'UNAVAILABLE' | 'LEASE_LOST';
  cycle: number | null;
  /** Le passage a REPRIS un cycle interrompu (curseur non nul ou phase avancée). */
  resumed: boolean;
  /** Curseur d'alerte et phase au départ du passage. */
  startedFrom: { phase: string; alertCursor: number; coupleCursor: string | null } | null;
  /** Le périmètre avait changé : point de reprise invalidé (cycle recommencé au début). */
  invalidated: boolean;
  /** Le cycle s'est terminé : curseur remis à zéro. */
  cycleCompleted: boolean;
}

/** Carte #838 (D1) — périmètre du point de reprise (un seul : ce code d'alerte). */
export const SCHEMA_ALERT_CHECKPOINT_SCOPE = 'schema_compat_alerts';
/** Version de l'algorithme de parcours : la changer invalide les points de reprise (curseur non transposable). */
const REEVAL_ALGO_VERSION = 1;
/** Durée du bail du point de reprise (renouvelée à chaque page). */
export const REEVAL_CHECKPOINT_LEASE_MS = 10 * 60_000;
/** Un nouveau cycle complet est dû au plus une fois par jour (le passage quotidien des évaluateurs). */
export const REEVAL_CYCLE_PERIOD_MS = 86_400_000 - 600_000;

function checkpointFingerprint(): string {
  return `${SCHEMA_COMPAT_ALERT_CODE}|algo:${REEVAL_ALGO_VERSION}|page:${PAGE}`;
}

type CheckpointRow = {
  phase: string; alertCursor: number; coupleCursor: string | null; cycle: number; lastCompletedAt: number | null; fingerprint: string;
};

const ckRow = (r: Row): CheckpointRow => ({
  phase: String(r.phase), alertCursor: Number(r.alert_cursor ?? 0), coupleCursor: r.couple_cursor == null ? null : String(r.couple_cursor),
  cycle: Number(r.cycle ?? 0), lastCompletedAt: r.last_completed_at == null ? null : new Date(String(r.last_completed_at)).getTime(),
  fingerprint: String(r.scope_fingerprint),
});

const ckIso = (t: number): string => new Date(t).toISOString();

/**
 * Bail du point de reprise : UNE instance à la fois, bail échu reprenable
 * (instance arrêtée). `undefined` : table absente (migration 1980).
 */
async function claimCheckpoint(scope: string, token: string, now: number, leaseMs: number): Promise<CheckpointRow | null | undefined> {
  try {
    const rows = (await pgClient.unsafe(
      `INSERT INTO ai_schema_compat_reeval_checkpoints AS c (scope, scope_fingerprint, phase, lease_token, lease_expires_at, updated_at)
       VALUES ($1, $2, 'IDLE', $3, $4::timestamptz + ($5::bigint * interval '1 millisecond'), $4::timestamptz)
       ON CONFLICT (scope) DO UPDATE SET lease_token = EXCLUDED.lease_token, lease_expires_at = EXCLUDED.lease_expires_at,
         updated_at = EXCLUDED.updated_at, resumes = c.resumes + CASE WHEN c.phase IN ('ALERTS', 'COUPLES') THEN 1 ELSE 0 END
        WHERE c.lease_expires_at IS NULL OR c.lease_expires_at <= $4::timestamptz
       RETURNING phase, alert_cursor, couple_cursor, cycle, last_completed_at, scope_fingerprint`,
      [scope, checkpointFingerprint(), token, ckIso(now), leaseMs] as never[],
    )) as unknown as Row[];
    return rows[0] ? ckRow(rows[0]) : null;
  } catch (e) {
    const code = (e as { code?: string } | null)?.code;
    if (code === '42P01' || code === '42703') return undefined;
    throw e;
  }
}

/** Écriture FENCÉE du point de reprise (seul le détenteur du bail écrit). `false` : bail perdu. */
async function writeCheckpoint(scope: string, token: string, now: number, leaseMs: number, set: {
  phase?: string; alertCursor?: number; coupleCursor?: string | null; examined?: number; newCycle?: boolean; invalidate?: boolean;
  complete?: boolean; release?: boolean; report?: unknown;
}): Promise<boolean> {
  const rows = (await pgClient.unsafe(
    `UPDATE ai_schema_compat_reeval_checkpoints SET
        phase = COALESCE($4::text, phase),
        alert_cursor = COALESCE($5::bigint, alert_cursor),
        couple_cursor = CASE WHEN $6::boolean THEN $7::text ELSE couple_cursor END,
        examined_in_cycle = CASE WHEN $8::boolean THEN 0 ELSE examined_in_cycle END + COALESCE($9::bigint, 0),
        cycle = cycle + CASE WHEN $8::boolean THEN 1 ELSE 0 END,
        cycle_started_at = CASE WHEN $8::boolean THEN $3::timestamptz ELSE cycle_started_at END,
        invalidations = invalidations + CASE WHEN $10::boolean THEN 1 ELSE 0 END,
        scope_fingerprint = $11,
        last_completed_at = CASE WHEN $12::boolean THEN $3::timestamptz ELSE last_completed_at END,
        last_report = COALESCE($13::jsonb, last_report),
        lease_token = CASE WHEN $14::boolean THEN NULL ELSE lease_token END,
        lease_expires_at = CASE WHEN $14::boolean THEN NULL ELSE $3::timestamptz + ($15::bigint * interval '1 millisecond') END,
        updated_at = $3::timestamptz
      WHERE scope = $1 AND lease_token = $2
      RETURNING scope`,
    [
      scope, token, ckIso(now), set.phase ?? null, set.alertCursor ?? null, set.coupleCursor !== undefined, set.coupleCursor ?? null,
      set.newCycle === true || set.invalidate === true, set.examined ?? null, set.invalidate === true, checkpointFingerprint(),
      set.complete === true, set.report === undefined ? null : JSON.stringify(set.report), set.release === true, leaseMs,
    ] as never[],
  )) as unknown as Row[];
  return rows.length > 0;
}

/** Carte #838 (D1) — état du point de reprise (BO, recette). `null` : absent ou illisible. */
export async function readSchemaAlertCheckpoint(scope = SCHEMA_ALERT_CHECKPOINT_SCOPE): Promise<Record<string, unknown> | null> {
  try {
    const rows = (await pgClient.unsafe(
      `SELECT scope, scope_fingerprint, phase, alert_cursor, couple_cursor, cycle, cycle_started_at, last_completed_at,
              examined_in_cycle, lease_expires_at, resumes, invalidations, updated_at
         FROM ai_schema_compat_reeval_checkpoints WHERE scope = $1`,
      [scope] as never[],
    )) as unknown as Row[];
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

/** Constat de coordination avec les alertes de couverture T1 (#775) — lecture seule. */
export interface CoverageCoordination {
  /** Anomalies de couverture / normalisation T1 OUVERTES au moment du passage ; `null` : non mesurable. */
  openCoverageAnomalies: number | null;
  /** Même décompte APRÈS le passage : il doit être identique (`unchanged`). */
  openCoverageAnomaliesAfter: number | null;
  /** Le passage n'a touché AUCUNE de ces anomalies (toujours vrai : il n'écrit que sur son propre code). */
  unchanged: boolean;
  /** Passage réservé en base qui porte CETTE famille d'alertes (celui de #775 est distinct). */
  evaluator: 'schema_compat_alerts';
  /** Famille d'alertes de #775, pour la recette (aucun secret, aucun contenu). */
  coverageFamily: readonly string[];
}

const PAGE = 100;

/**
 * Budget d'UN passage, en nombre d'alertes examinées. Il ne tronque RIEN en
 * silence : `done: false` et `resumeFromAlertId` disent qu'il reste à faire.
 * La valeur par défaut couvre très largement les volumétries citées par la
 * carte (> 5 000 alertes) ; le passage quotidien et le BO peuvent la réduire.
 */
export const REEVAL_DEFAULT_MAX_ALERTS = 100_000;

/**
 * Lot 115 (carte #784, §E3) — préfixes des anomalies de couverture T1 (#775),
 * lus dans LEUR référentiel (aucune énumération locale) ; repli silencieux si
 * ce module évolue : la coordination devient alors « non mesurable », jamais
 * fausse.
 */
async function coverageFamily(): Promise<readonly string[]> {
  try {
    const M = await import('../../source-analysis/source-units/monitoring');
    return M.T1_COVERAGE_ALERT_PREFIXES;
  } catch {
    return [];
  }
}

/**
 * Anomalies de couverture / normalisation T1 (#775) OUVERTES — LECTURE SEULE.
 * Ce module ne leur écrit jamais : elles ont leur propre passage quotidien, et
 * une réussite en mode JSON ne ferme aucune lacune de couverture.
 * `null` : non mesurable (table ou module absents).
 */
async function countOpenCoverageAnomalies(prefixes: readonly string[]): Promise<number | null> {
  if (prefixes.length === 0) return null;
  try {
    const rows = (await pgClient.unsafe(
      `SELECT COUNT(*)::int AS n FROM admin_anomalies
        WHERE status = 'open' AND (${prefixes.map((_, i) => `fingerprint LIKE $${i + 1}`).join(' OR ')})`,
      prefixes.map((p) => `${p}%`) as never[],
    )) as unknown as Row[];
    return rows[0] ? Number(rows[0].n) : null;
  } catch {
    return null;
  }
}

/** Alertes de ce code non résolues (bilan). `null` : non mesurable. */
async function countOpenAlerts(): Promise<number | null> {
  try {
    const rows = (await pgClient.unsafe(
      `SELECT COUNT(*)::int AS n FROM ai_alerts WHERE code = $1 AND resolved_at IS NULL`,
      [SCHEMA_COMPAT_ALERT_CODE] as never[],
    )) as unknown as Row[];
    return rows[0] ? Number(rows[0].n) : null;
  } catch {
    return null;
  }
}

/**
 * RÉÉVALUATION des alertes de compatibilité — automatique (passage quotidien
 * des évaluateurs de la file, réservé en base : une seule instance) ou à la
 * demande (BO). CIBLÉE (ce seul code d'alerte), PAGINÉE (par identifiant),
 * IDEMPOTENTE (une alerte résolue n'est plus relue ; un second passage ne
 * change rien). Aucun appel fournisseur, aucune réanalyse de document.
 */
export async function reevaluateSchemaCompatAlerts(
  opts: {
    maxPages?: number; maxAlerts?: number; fromAlertId?: number;
    /**
     * Lot 115 (carte #784, §E1) — lecture de la chaîne de modèles réellement
     * configurée pour une opération (injectable : scénarios de bout en bout et
     * tests). Par défaut, la configuration résolue de l'opération.
     */
    readChain?: (operationCode: string) => Promise<readonly string[]>;
    /**
     * Carte #838 (D1) — POINT DE REPRISE DURABLE : le passage reprend AU
     * DERNIER CURSEUR SÛR enregistré (aucun paramètre manuel), sous bail (une
     * instance à la fois), et remet le curseur à zéro en fin de cycle. Un
     * nouveau cycle ne commence que s'il est dû (`cyclePeriodMs` depuis la fin
     * du précédent ; 0 : dès qu'aucun n'est en cours). Ignoré si `fromAlertId`
     * est fourni (curseur explicite : comportement antérieur).
     */
    checkpoint?: { scope?: string; cyclePeriodMs?: number; leaseMs?: number; token?: string };
    /**
     * Carte #838 (D1) — observateur de progression, appelé après CHAQUE page
     * enregistrée (supervision, recette : un arrêt brutal y est simulé). Une
     * erreur levée ici interrompt le passage comme un arrêt du processus : le
     * bail reste posé jusqu'à son échéance, le curseur sûr est conservé.
     */
    onProgress?: (p: { phase: 'ALERTS' | 'COUPLES'; alertCursor: number; examined: number }) => void | Promise<void>;
  } = {},
): Promise<SchemaAlertReevaluation> {
  const out: SchemaAlertReevaluation = {
    examined: 0, resolved: { SCHEMA_ACCEPTED_AGAIN: 0, SCHEMA_SUPERSEDED: 0, SCHEMA_MODEL_WITHDRAWN: 0 },
    keptActive: 0, keptUndetermined: 0, keptRoutingUnknown: 0, raised: 0, raiseSkippedRoutingUnknown: 0, unavailable: false,
    done: false, resumeFromAlertId: null,
    before: { openAlerts: null, couplesByState: null }, after: { openAlerts: null }, couplesScanned: 0,
    coverageCoordination: {
      openCoverageAnomalies: null, openCoverageAnomaliesAfter: null, unchanged: true,
      evaluator: 'schema_compat_alerts', coverageFamily: [],
    },
    checkpoint: null,
  };
  // ── Carte #838 (D1) : bail et point de reprise durable ─────────────────────
  const ck = opts.checkpoint && opts.fromAlertId === undefined ? opts.checkpoint : null;
  const scope = ck?.scope ?? SCHEMA_ALERT_CHECKPOINT_SCOPE;
  const leaseMs = ck?.leaseMs ?? REEVAL_CHECKPOINT_LEASE_MS;
  const jeton = ck ? (ck.token ?? (await import('crypto')).randomUUID()) : '';
  let tenu = false;
  let depart: CheckpointRow | null = null;
  if (ck) {
    const now = Date.now();
    const row = await claimCheckpoint(scope, jeton, now, leaseMs);
    out.checkpoint = { scope, status: 'RAN', cycle: null, resumed: false, startedFrom: null, invalidated: false, cycleCompleted: false };
    if (row === undefined) {
      // Retour arrière (migration 1980 absente) : passage complet, sans reprise — signalé, jamais silencieux. Le
      // rythme d'un cycle reste borné par la réservation des évaluateurs (un cycle par période, comme avant #838).
      out.checkpoint.status = 'UNAVAILABLE';
      const periode = ck.cyclePeriodMs ?? 0;
      if (periode > 0) {
        const { claimEvaluatorRun } = await import('../../alerts/alerts.repository');
        if (!(await claimEvaluatorRun(`${scope}:cycle-sans-reprise`, Math.round(periode / 1000)).catch(() => false))) {
          out.checkpoint.status = 'NOTHING_TO_DO';
          return out;
        }
      }
    } else if (row === null) {
      out.checkpoint.status = 'LEASE_HELD';
      return out;
    } else {
      tenu = true;
      depart = row;
      if (row.fingerprint !== checkpointFingerprint() && (row.phase === 'ALERTS' || row.phase === 'COUPLES')) {
        // Périmètre modifié : le curseur n'est plus transposable — invalidation CONTRÔLÉE (cycle recommencé).
        await writeCheckpoint(scope, jeton, now, leaseMs, { phase: 'ALERTS', alertCursor: 0, coupleCursor: null, invalidate: true });
        out.checkpoint.invalidated = true;
        depart = { ...row, phase: 'ALERTS', alertCursor: 0, coupleCursor: null, cycle: row.cycle + 1 };
      } else if (row.phase !== 'ALERTS' && row.phase !== 'COUPLES') {
        const periode = ck.cyclePeriodMs ?? 0;
        if (row.lastCompletedAt !== null && row.lastCompletedAt > now - periode) {
          await writeCheckpoint(scope, jeton, now, leaseMs, { release: true });
          out.checkpoint.status = 'NOTHING_TO_DO';
          out.checkpoint.cycle = row.cycle;
          out.done = true;
          return out;
        }
        await writeCheckpoint(scope, jeton, now, leaseMs, { phase: 'ALERTS', alertCursor: 0, coupleCursor: null, newCycle: true });
        depart = { ...row, phase: 'ALERTS', alertCursor: 0, coupleCursor: null, cycle: row.cycle + 1 };
      } else {
        out.checkpoint.resumed = row.alertCursor > 0 || row.phase === 'COUPLES' || row.coupleCursor !== null;
      }
      out.checkpoint.cycle = depart.cycle;
      out.checkpoint.startedFrom = { phase: depart.phase, alertCursor: depart.alertCursor, coupleCursor: depart.coupleCursor };
    }
  }
  /** Progression FENCÉE : bail perdu → arrêt immédiat, sans rien doubler. */
  const progression = async (set: Parameters<typeof writeCheckpoint>[4]): Promise<boolean> => {
    if (!tenu) return true;
    const ok = await writeCheckpoint(scope, jeton, Date.now(), leaseMs, set);
    if (!ok) { tenu = false; if (out.checkpoint) out.checkpoint.status = 'LEASE_LOST'; }
    return ok;
  };
  const [S, M] = await Promise.all([import('./store'), import('./static-matrix')]);
  // Bilan AVANT (carte #784, §E2) : jamais une remise à zéro, un constat.
  out.before.openAlerts = await countOpenAlerts();
  // Coordination avec #775 (§E3) : CONSTAT avant / après, lecture seule, aucun second passage.
  const familleCouverture = await coverageFamily();
  out.coverageCoordination.coverageFamily = familleCouverture;
  out.coverageCoordination.openCoverageAnomalies = await countOpenCoverageAnomalies(familleCouverture);
  out.before.couplesByState = await S.countCouples().catch(() => null);
  // Budget d'un passage : le `maxPages` historique reste honoré s'il est fourni.
  const budget = opts.maxAlerts ?? (opts.maxPages !== undefined ? opts.maxPages * PAGE : REEVAL_DEFAULT_MAX_ALERTS);
  const ouvertes = new Set<string>();
  /**
   * Statut de routage par (opération, modèle), calculé UNE fois par passage :
   * la configuration ne change pas sous nos pieds au milieu d'un rattrapage, et
   * un couple fréquent ne relit pas la configuration à chaque alerte.
   */
  const routage = new Map<string, CoupleRoutingStatus>();
  const statutRoutage = async (operationCode: string, model: string): Promise<CoupleRoutingStatus> => {
    const k = `${operationCode}\u0000${model}`;
    const vu = routage.get(k);
    if (vu) return vu;
    const s = await M.coupleRoutingStatus({ operationCode, model }, opts.readChain);
    routage.set(k, s);
    return s;
  };
  let cursor = Math.max(0, Math.floor(opts.fromAlertId ?? depart?.alertCursor ?? 0));
  const phaseAlertes = depart === null || depart.phase === 'ALERTS';
  try {
    // Parcours PAGINÉ et EXHAUSTIF des alertes non résolues, par identifiant
    // croissant (ordre stable : une résolution ne déplace pas une ligne). Le
    // curseur est la DONNÉE elle-même — une interruption ne perd aucun travail
    // et n'en refait aucun : les alertes déjà résolues ne sont plus relues.
    for (;;) {
      if (!phaseAlertes) break;
      if (out.examined >= budget) {
        out.resumeFromAlertId = cursor;
        // Carte #838 (D1) : budget épuisé — curseur sûr enregistré et bail rendu : le passage suivant reprend
        // ICI, sans paramètre manuel. Sans point de reprise : comportement antérieur (levées puis bilan).
        if (tenu) { await progression({ alertCursor: cursor, release: true }); return finish(); }
        break;
      }
      const rows = (await pgClient.unsafe(
        `SELECT id, details FROM ai_alerts WHERE code = $1 AND resolved_at IS NULL AND id > $2 ORDER BY id LIMIT $3`,
        [SCHEMA_COMPAT_ALERT_CODE, cursor, Math.min(PAGE, budget - out.examined)] as never[],
      )) as unknown as Row[];
      if (rows.length === 0) { out.done = true; break; }
      const avantPage = out.examined;
      for (const r of rows) {
        cursor = Number(r.id);
        out.examined++;
        const keyId = String((r.details as { keyId?: unknown } | null)?.keyId ?? '');
        const couple = keyId ? await S.getCouple(keyId) : null;
        // Couple illisible : l'alerte est CONSERVÉE (on ne ferme jamais sur une absence de preuve).
        if (!couple) { out.keptUndetermined++; if (keyId) ouvertes.add(keyId); continue; }
        if (couple.state === 'QUALIFIED') {
          out.resolved.SCHEMA_ACCEPTED_AGAIN += await resolveSchemaIncompatibilityAlert(keyId, 'SCHEMA_ACCEPTED_AGAIN');
          continue;
        }
        if (!M.isCurrentCouple(couple.key)) {
          out.resolved.SCHEMA_SUPERSEDED += await resolveSchemaIncompatibilityAlert(keyId, 'SCHEMA_SUPERSEDED');
          continue;
        }
        // Lot 115 (carte #784, §E1) : le couple est bien celui que la passerelle projette — mais le
        // MODÈLE est-il encore routé ? Preuve de retrait : on clôt avec ce motif. État inconnu ou
        // indisponibilité : on CONSERVE (et le lendemain, même constat : aucune réouverture).
        const routeStatus = await statutRoutage(couple.key.operationCode, couple.key.model);
        if (routeStatus === 'WITHDRAWN') {
          out.resolved.SCHEMA_MODEL_WITHDRAWN += await resolveSchemaIncompatibilityAlert(keyId, 'SCHEMA_MODEL_WITHDRAWN');
          continue;
        }
        if (routeStatus === 'UNKNOWN') { out.keptRoutingUnknown++; ouvertes.add(keyId); continue; }
        out.keptActive++;
        ouvertes.add(keyId);
      }
      // Carte #838 (D1) : page ENTIÈREMENT traitée → curseur sûr durable (les résolutions sont idempotentes :
      // un arrêt avant cette écriture ne fait que rejouer la page, sans doublon ni perte).
      if (!(await progression({ alertCursor: cursor, examined: out.examined - avantPage }))) return finish();
      await opts.onProgress?.({ phase: 'ALERTS', alertCursor: cursor, examined: out.examined });
    }
    if (!phaseAlertes) out.done = true;
    if (tenu && phaseAlertes && !(await progression({ phase: 'COUPLES', coupleCursor: null }))) return finish();
    // Couple refusé, toujours transmis, sans alerte ouverte : alerte levée (une fois).
    // Lot 115 (carte #784, §B1 et §E2) : PARCOURS EXHAUSTIF de la mémoire, page par page et par
    // `key_id` — la lecture bornée aux 2 000 refus les plus récents omettait les refus anciens, qui
    // restaient donc sans alerte. Un refus ancien est désormais traité comme un refus récent.
    let apres: string | null = depart?.phase === 'COUPLES' ? depart.coupleCursor : null;
    for (;;) {
      const page = await S.scanCouples({ states: ['REJECTED_CONFIRMED', 'NEEDS_RECHECK'], afterKeyId: apres });
      if (page === null) { out.unavailable = true; if (tenu) await progression({ release: true }); return out; }
      if (page.length === 0) break;
      for (const c of page) {
        out.couplesScanned++;
        apres = c.keyId;
        if (ouvertes.has(c.keyId) || !M.isCurrentCouple(c.key)) continue;
        // Lot 115 (carte #784, §E1) : une alerte n'est levée que si le modèle est RÉELLEMENT routé.
        //   · WITHDRAWN : le couple ne sert plus — aucune alerte à lever ;
        //   · UNKNOWN   : on ne sait pas. Lever ici ROUVRIRAIT, dès le passage suivant, une alerte
        //     que l'on vient de clore faute de routage lisible — ce que la carte interdit
        //     explicitement (« ne pas rouvrir le lendemain une alerte à cause disparue »). On
        //     s'abstient et on le COMPTE : le prochain passage, routage lisible, lèvera ce qui doit l'être.
        const statut = await statutRoutage(c.key.operationCode, c.key.model);
        if (statut !== 'ACTIVE') { if (statut === 'UNKNOWN') out.raiseSkippedRoutingUnknown++; continue; }
        if (await raiseSchemaIncompatibilityAlert(c)) out.raised++;
      }
      if (!(await progression({ coupleCursor: apres }))) { out.done = false; return finish(); }
    }
  } catch (e) {
    const code = (e as { code?: string } | null)?.code;
    if (code !== '42P01' && code !== '42703') throw e;
    out.unavailable = true;
    // Rien de conclu : bail rendu, curseur sûr conservé (reprise au même point).
    if (tenu) await progression({ release: true }).catch(() => false);
    tenu = false;
  }
  return finish();

  async function finish(): Promise<SchemaAlertReevaluation> {
    out.after.openAlerts = await countOpenAlerts();
    // §E3 : les lacunes de couverture T1 réellement actives sont INTACTES — une réussite en mode JSON après un
    // refus de schéma ne doit jamais en masquer une seule, et ce passage ne les touche pas.
    out.coverageCoordination.openCoverageAnomaliesAfter = await countOpenCoverageAnomalies(familleCouverture);
    out.coverageCoordination.unchanged = out.coverageCoordination.openCoverageAnomalies === null
      || out.coverageCoordination.openCoverageAnomalies === out.coverageCoordination.openCoverageAnomaliesAfter;
    if (!out.coverageCoordination.unchanged) {
      console.warn('[schema-compat] coordination #775 : le nombre d’anomalies de couverture T1 ouvertes a changé '
        + 'pendant ce passage (il ne les touche pas — un passage de #775 a pu tourner en parallèle).');
    }
    // Carte #838 (D1) : fin de cycle → curseur remis à zéro, bilan conservé, bail rendu.
    if (tenu && out.done && out.checkpoint) {
      const bilan = { examined: out.examined, resolved: out.resolved, keptActive: out.keptActive, raised: out.raised, couplesScanned: out.couplesScanned };
      if (await progression({ phase: 'DONE', alertCursor: 0, coupleCursor: null, complete: true, release: true, report: bilan })) {
        out.checkpoint.cycleCompleted = true;
      }
    }
    return out;
  }
}
