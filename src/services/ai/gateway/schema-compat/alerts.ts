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
  } catch (e) {
    // Carte #863 (D1) : échec SIGNALÉ (jamais absorbé en silence) ; la réévaluation reprend la levée manquante.
    console.warn('[schema-compat] alerte non levée (reprise par la réévaluation) :', String((e as Error)?.message ?? e).slice(0, 200));
    return false;
  }
}

/** Carte #863 (D1) — issue EXPLICITE d'un effet sur une alerte (jamais un 0 / false ambigu). */
export type AlertEffectOutcome = 'APPLIED' | 'ALREADY_SATISFIED' | 'KEPT_CAUSE_CHANGED';

/** Contenu d'une alerte de condition pour un couple refusé (levée directe ou transactionnelle). */
function alertInputOf(s: SchemaCoupleState) {
  const k = s.key;
  return {
    kind: 'anomaly' as const, code: SCHEMA_COMPAT_ALERT_CODE, treatment: treatmentOf(k.operationCode), severity: 'warning' as const,
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
  };
}

type SqlRun = { unsafe: (q: string, p?: never[]) => Promise<unknown> };

/**
 * Carte #863 (D1) — LEVÉE dans la transaction de l'appelant, cause REVÉRIFIÉE au moment de l'effet : le couple
 * doit être encore refusé (lecture verrouillée dans la même transaction). Lève en cas d'échec (jamais absorbé).
 */
async function raiseAlertEffect(tx: SqlRun, s: SchemaCoupleState): Promise<AlertEffectOutcome> {
  const etat = ((await tx.unsafe(`SELECT state FROM ai_schema_compatibility WHERE key_id = $1 FOR SHARE`, [s.keyId] as never[])) as Row[])[0];
  if (!etat || (etat.state !== 'REJECTED_CONFIRMED' && etat.state !== 'NEEDS_RECHECK')) return 'KEPT_CAUSE_CHANGED';
  const { raiseConditionAlert } = await import('../../alerts/alerts.repository');
  const r = await raiseConditionAlert(alertInputOf(s), tx);
  return r.created ? 'APPLIED' : 'ALREADY_SATISFIED';
}

/**
 * Carte #863 (D1) — RÉSOLUTION d'UNE alerte dans la transaction de l'appelant, cause revérifiée au moment de
 * l'effet (`SCHEMA_ACCEPTED_AGAIN` : couple toujours qualifié). Déjà résolue (par une autre voie) : prouvé par
 * relecture — `ALREADY_SATISFIED`. Lève en cas d'échec.
 */
async function resolveAlertEffect(tx: SqlRun, alertId: number, keyId: string, code: SchemaAlertResolutionAll): Promise<AlertEffectOutcome> {
  if (code === 'SCHEMA_ACCEPTED_AGAIN') {
    const etat = ((await tx.unsafe(`SELECT state FROM ai_schema_compatibility WHERE key_id = $1 FOR SHARE`, [keyId] as never[])) as Row[])[0];
    if (etat?.state !== 'QUALIFIED') return 'KEPT_CAUSE_CHANGED';
  }
  const { resolveAlerts } = await import('../../alerts/alerts.repository');
  const n = await resolveAlerts([alertId], { code, reason: RESOLUTION_REASONS[code] }, tx);
  if (n > 0) return 'APPLIED';
  const deja = ((await tx.unsafe(`SELECT resolved_at FROM ai_alerts WHERE id = $1`, [alertId] as never[])) as Row[])[0];
  if (deja && deja.resolved_at != null) return 'ALREADY_SATISFIED';
  throw new Error(`résolution de l'alerte ${alertId} sans effet ni preuve de résolution antérieure`);
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
  } catch (e) {
    // Carte #863 (D1) : échec SIGNALÉ ; la réévaluation suivante reprend la résolution (cause revérifiée).
    console.warn('[schema-compat] alerte non résolue (reprise par la réévaluation) :', String((e as Error)?.message ?? e).slice(0, 200));
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
  /**
   * Carte #863 (D1) — issues EXPLICITES des effets de CE passage : déjà
   * satisfaites (prouvé par relecture), conservées parce que la cause a changé
   * au moment de l'effet, échecs de page et reprises (pages rejouées).
   */
  alreadySatisfied: number;
  keptCauseChanged: number;
  failures: number;
  retries: number;
  /**
   * Carte #863 (D1) — compteurs CUMULÉS DURABLES du cycle (tous passages
   * confondus, écrits dans la transaction de chaque page : un rejeu ne compte
   * rien deux fois). `null` : sans point de reprise (ou migration 2000 absente).
   */
  cycleTotals: SchemaAlertCycleCounters | null;
}

/** Carte #863 (D1) — compteurs cumulés d'un cycle de réévaluation. */
export interface SchemaAlertCycleCounters {
  examined: number;
  resolved: Record<SchemaAlertResolutionAll, number>;
  keptActive: number; keptUndetermined: number; keptRoutingUnknown: number; keptCauseChanged: number; alreadySatisfied: number;
  raised: number; raiseAlreadySatisfied: number; raiseSkippedRoutingUnknown: number;
  couplesScanned: number; pages: number; failures: number; retries: number;
}

function emptyCounters(): SchemaAlertCycleCounters {
  return {
    examined: 0, resolved: { SCHEMA_ACCEPTED_AGAIN: 0, SCHEMA_SUPERSEDED: 0, SCHEMA_MODEL_WITHDRAWN: 0 },
    keptActive: 0, keptUndetermined: 0, keptRoutingUnknown: 0, keptCauseChanged: 0, alreadySatisfied: 0,
    raised: 0, raiseAlreadySatisfied: 0, raiseSkippedRoutingUnknown: 0, couplesScanned: 0, pages: 0, failures: 0, retries: 0,
  };
}

function addCounters(a: SchemaAlertCycleCounters, b: SchemaAlertCycleCounters): SchemaAlertCycleCounters {
  const r = emptyCounters();
  for (const k of Object.keys(r) as Array<keyof SchemaAlertCycleCounters>) {
    if (k === 'resolved') continue;
    (r[k] as number) = Number(a[k] ?? 0) + Number(b[k] ?? 0);
  }
  for (const m of Object.keys(r.resolved) as SchemaAlertResolutionAll[]) r.resolved[m] = (a.resolved?.[m] ?? 0) + (b.resolved?.[m] ?? 0);
  return r;
}

function countersOf(v: unknown): SchemaAlertCycleCounters {
  if (!v || typeof v !== 'object') return emptyCounters();
  return addCounters(emptyCounters(), v as SchemaAlertCycleCounters);
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
   *                      (le présent passage s'est arrêté, rien n'est doublé) ;
   * `INTERRUPTED`        (carte #863) page en échec après reprise bornée
   *                      (lecture, effet ou point de reprise) : passage arrêté
   *                      au DERNIER point sûr, rien n'est perdu, cycle NON
   *                      terminé — le passage suivant reprend la même page.
   */
  status: 'RAN' | 'LEASE_HELD' | 'NOTHING_TO_DO' | 'UNAVAILABLE' | 'LEASE_LOST' | 'INTERRUPTED';
  cycle: number | null;
  /** Le passage a REPRIS un cycle interrompu (curseur non nul ou phase avancée). */
  resumed: boolean;
  /** Curseur d'alerte et phase au départ du passage. */
  startedFrom: { phase: string; alertCursor: number; coupleCursor: string | null } | null;
  /** Le périmètre avait changé : point de reprise invalidé (cycle recommencé au début). */
  invalidated: boolean;
  /** Le cycle s'est terminé : curseur remis à zéro. */
  cycleCompleted: boolean;
  /** Carte #863 (D1) : dernière erreur d'une page (statut `INTERRUPTED`), sans contenu. */
  lastError?: string | null;
}

/** Carte #838 (D1) — périmètre du point de reprise (un seul : ce code d'alerte). */
export const SCHEMA_ALERT_CHECKPOINT_SCOPE = 'schema_compat_alerts';
/**
 * Version de l'algorithme de parcours : la changer invalide les points de reprise (curseur non transposable).
 * Carte #863 (D1) : 2 — effets par page en transaction fencée, compteurs cumulés par cycle (un cycle commencé
 * sous la version 1 est recommencé, de façon contrôlée, pour que son bilan porte sur le cycle ENTIER).
 */
const REEVAL_ALGO_VERSION = 2;
/** Durée du bail du point de reprise (renouvelée à chaque page). */
export const REEVAL_CHECKPOINT_LEASE_MS = 10 * 60_000;
/** Un nouveau cycle complet est dû au plus une fois par jour (le passage quotidien des évaluateurs). */
export const REEVAL_CYCLE_PERIOD_MS = 86_400_000 - 600_000;
/** Carte #863 (D1) : tentatives d'une page (lecture + effets + point de reprise) avant interruption au point sûr. */
export const REEVAL_PAGE_ATTEMPTS = 3;

function checkpointFingerprint(): string {
  return `${SCHEMA_COMPAT_ALERT_CODE}|algo:${REEVAL_ALGO_VERSION}|page:${PAGE}`;
}

type CheckpointRow = {
  phase: string; alertCursor: number; coupleCursor: string | null; cycle: number; lastCompletedAt: number | null; fingerprint: string;
  counters: SchemaAlertCycleCounters | null;
};

const ckRow = (r: Row): CheckpointRow => ({
  phase: String(r.phase), alertCursor: Number(r.alert_cursor ?? 0), coupleCursor: r.couple_cursor == null ? null : String(r.couple_cursor),
  cycle: Number(r.cycle ?? 0), lastCompletedAt: r.last_completed_at == null ? null : new Date(String(r.last_completed_at)).getTime(),
  fingerprint: String(r.scope_fingerprint),
  counters: 'cycle_counters' in r ? countersOf(r.cycle_counters) : null,
});

const ckIso = (t: number): string => new Date(t).toISOString();

/** Carte #863 (D1) : colonnes de la migration 2000 (compteurs cumulés, statut, erreur) — sondées, repli signalé. */
let cycleColumns: boolean | null = null;
/** Réservé aux tests : oublie la sonde des colonnes de cycle. */
export function __resetReevalProbesForTests(): void { cycleColumns = null; }

/**
 * Bail du point de reprise : UNE instance à la fois, bail échu reprenable
 * (instance arrêtée). `undefined` : table absente (migration 1980).
 */
async function claimCheckpoint(scope: string, token: string, now: number, leaseMs: number): Promise<CheckpointRow | null | undefined> {
  const sql = (avec: boolean) => `INSERT INTO ai_schema_compat_reeval_checkpoints AS c (scope, scope_fingerprint, phase, lease_token, lease_expires_at, updated_at)
       VALUES ($1, $2, 'IDLE', $3, $4::timestamptz + ($5::bigint * interval '1 millisecond'), $4::timestamptz)
       ON CONFLICT (scope) DO UPDATE SET lease_token = EXCLUDED.lease_token, lease_expires_at = EXCLUDED.lease_expires_at,
         updated_at = EXCLUDED.updated_at, resumes = c.resumes + CASE WHEN c.phase IN ('ALERTS', 'COUPLES') THEN 1 ELSE 0 END
        WHERE c.lease_expires_at IS NULL OR c.lease_expires_at <= $4::timestamptz
       RETURNING phase, alert_cursor, couple_cursor, cycle, last_completed_at, scope_fingerprint${avec ? ', cycle_counters' : ''}`;
  try {
    let rows: Row[];
    try {
      rows = (await pgClient.unsafe(sql(cycleColumns !== false), [scope, checkpointFingerprint(), token, ckIso(now), leaseMs] as never[])) as unknown as Row[];
      if (cycleColumns === null) cycleColumns = true;
    } catch (e) {
      if (cycleColumns === false || (e as { code?: string } | null)?.code !== '42703') throw e;
      cycleColumns = false;
      console.warn('[schema-compat] migration 2000 absente : compteurs cumulés du cycle non disponibles (bilan du passage seulement).');
      rows = (await pgClient.unsafe(sql(false), [scope, checkpointFingerprint(), token, ckIso(now), leaseMs] as never[])) as unknown as Row[];
    }
    return rows[0] ? ckRow(rows[0]) : null;
  } catch (e) {
    const code = (e as { code?: string } | null)?.code;
    if (code === '42P01' || code === '42703') return undefined;
    throw e;
  }
}

/** Écriture FENCÉE du point de reprise (seul le détenteur VALIDE du bail écrit). `false` : bail perdu. */
async function writeCheckpoint(run: SqlRun, scope: string, token: string, now: number, leaseMs: number, set: {
  phase?: string; alertCursor?: number; coupleCursor?: string | null; examined?: number; newCycle?: boolean; invalidate?: boolean;
  complete?: boolean; release?: boolean; report?: unknown; counters?: SchemaAlertCycleCounters | null; status?: string; error?: string | null;
}): Promise<boolean> {
  const avec = cycleColumns === true;
  const rows = (await run.unsafe(
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
        ${avec ? `, cycle_counters = CASE WHEN $8::boolean THEN COALESCE($16::jsonb, '{}'::jsonb) ELSE COALESCE($16::jsonb, cycle_counters) END,
        last_status = COALESCE($17::text, last_status), last_error = CASE WHEN $17::text IS NULL THEN last_error ELSE $18::text END` : ''}
      WHERE scope = $1 AND lease_token = $2 AND lease_expires_at > $3::timestamptz
      RETURNING scope`,
    [
      scope, token, ckIso(now), set.phase ?? null, set.alertCursor ?? null, set.coupleCursor !== undefined, set.coupleCursor ?? null,
      set.newCycle === true || set.invalidate === true, set.examined ?? null, set.invalidate === true, checkpointFingerprint(),
      set.complete === true, set.report === undefined ? null : JSON.stringify(set.report), set.release === true, leaseMs,
      ...(avec ? [set.counters ? JSON.stringify(set.counters) : null, set.status ?? null, set.error ?? null] : []),
    ] as never[],
  )) as unknown as Row[];
  return rows.length > 0;
}

/**
 * Carte #863 (D1) — VERROU du bail dans la transaction d'une page : la ligne du point de reprise est verrouillée
 * et le jeton revérifié (bail VALIDE) AVANT tout effet. Un ancien détenteur (bail échu, repris) ne crée ni ne
 * résout plus aucune alerte : sa transaction s'arrête ici, sans rien écrire.
 */
async function lockLease(tx: SqlRun, scope: string, token: string, now: number): Promise<boolean> {
  const rows = (await tx.unsafe(
    `SELECT scope FROM ai_schema_compat_reeval_checkpoints WHERE scope = $1 AND lease_token = $2 AND lease_expires_at > $3::timestamptz FOR UPDATE`,
    [scope, token, ckIso(now)] as never[],
  )) as unknown as Row[];
  return rows.length > 0;
}

/** Carte #838 (D1) — état du point de reprise (BO, recette). `null` : absent ou illisible. */
export async function readSchemaAlertCheckpoint(scope = SCHEMA_ALERT_CHECKPOINT_SCOPE): Promise<Record<string, unknown> | null> {
  try {
    const rows = (await pgClient.unsafe(
      `SELECT * FROM ai_schema_compat_reeval_checkpoints WHERE scope = $1`,
      [scope] as never[],
    )) as unknown as Row[];
    if (!rows[0]) return null;
    // Le jeton du bail n'est jamais exposé.
    const { lease_token: _jeton, ...reste } = rows[0];
    return reste;
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

/** Carte #863 (D1) : arrêt BRUTAL simulé (recette) — jamais rattrapé par la reprise bornée d'une page. */
export class ReevaluationCrashSimulated extends Error {
  constructor(m = 'arrêt brutal du processus (simulé)') { super(m); this.name = 'ReevaluationCrashSimulated'; }
}

/** Carte #863 (D1) : le bail a été perdu pendant une page (aucune écriture faite par ce passage dans cette page). */
class LeaseLost extends Error { constructor() { super('bail perdu'); this.name = 'LeaseLost'; } }

/** Décision prise pour UNE alerte (lecture), appliquée ensuite dans la transaction de la page. */
type AlertDecision =
  | { id: number; keyId: string; kind: 'RESOLVE'; code: SchemaAlertResolutionAll }
  | { id: number; keyId: string; kind: 'KEEP_ACTIVE' | 'KEEP_UNDETERMINED' | 'KEEP_ROUTING' };

/**
 * RÉÉVALUATION des alertes de compatibilité — automatique (passage quotidien
 * des évaluateurs de la file, réservé en base : une seule instance) ou à la
 * demande (BO). CIBLÉE (ce seul code d'alerte), PAGINÉE (par identifiant),
 * IDEMPOTENTE (une alerte résolue n'est plus relue ; un second passage ne
 * change rien). Aucun appel fournisseur, aucune réanalyse de document.
 *
 * Carte #863 (D1) — EFFETS DURABLES ET FENCÉS :
 *   · chaque page (alertes, puis couples) est lue, décidée, puis appliquée
 *     dans UNE transaction qui verrouille le point de reprise et revérifie le
 *     bail AVANT tout effet, revérifie la cause de chaque effet, écrit les
 *     effets, le curseur et les compteurs cumulés du cycle — tout ou rien :
 *     un arrêt avant la validation ne laisse ni effet ni curseur (la page est
 *     rejouée), un arrêt après laisse les deux ; jamais un curseur en avance
 *     sur ses effets, jamais un compteur doublé au rejeu ;
 *   · issues explicites : appliquée, déjà satisfaite (prouvée), conservée
 *     (motif), échec — une page en échec est reprise (bornée), puis le passage
 *     s'arrête `INTERRUPTED` au dernier point sûr : un cycle ne se termine
 *     JAMAIS avec du travail perdu ;
 *   · un ancien détenteur (bail échu, repris par une autre instance) ne peut
 *     plus créer ni résoudre une alerte : sa transaction échoue au verrou ;
 *   · bilan final = compteurs CUMULÉS du cycle entier, reset seulement après
 *     une fin prouvée.
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
    /**
     * Carte #863 (D1) — INJECTION DE PANNES (recette) : `beforeEffects` avant la transaction d'une page (lecture
     * faite), `inEffect` à chaque effet DANS la transaction (avant l'écriture), `beforeCommit` après les effets et le
     * curseur, avant la validation. Une `ReevaluationCrashSimulated` simule un arrêt brutal (non rattrapé) ; toute
     * autre erreur est une panne reprise selon la règle de la page.
     */
    faults?: {
      beforeEffects?: (p: { phase: 'ALERTS' | 'COUPLES'; ids: readonly (number | string)[] }) => void | Promise<void>;
      inEffect?: (p: { phase: 'ALERTS' | 'COUPLES'; kind: 'RESOLVE' | 'RAISE'; id: number | string }) => void | Promise<void>;
      beforeCommit?: (p: { phase: 'ALERTS' | 'COUPLES'; cursor: number | string | null }) => void | Promise<void>;
      readCouple?: (keyId: string) => void | Promise<void>;
    };
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
    alreadySatisfied: 0, keptCauseChanged: 0, failures: 0, retries: 0, cycleTotals: null,
  };
  // ── Carte #838 (D1) : bail et point de reprise durable ─────────────────────
  const ck = opts.checkpoint && opts.fromAlertId === undefined ? opts.checkpoint : null;
  const scope = ck?.scope ?? SCHEMA_ALERT_CHECKPOINT_SCOPE;
  const leaseMs = ck?.leaseMs ?? REEVAL_CHECKPOINT_LEASE_MS;
  const jeton = ck ? (ck.token ?? (await import('crypto')).randomUUID()) : '';
  let tenu = false;
  let depart: CheckpointRow | null = null;
  /** Carte #863 (D1) : compteurs cumulés du cycle tels qu'écrits en base (`null` : non suivis). */
  let cumul: SchemaAlertCycleCounters | null = null;
  if (ck) {
    const now = Date.now();
    const row = await claimCheckpoint(scope, jeton, now, leaseMs);
    out.checkpoint = { scope, status: 'RAN', cycle: null, resumed: false, startedFrom: null, invalidated: false, cycleCompleted: false, lastError: null };
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
      cumul = cycleColumns === true ? row.counters ?? emptyCounters() : null;
      if (row.fingerprint !== checkpointFingerprint() && (row.phase === 'ALERTS' || row.phase === 'COUPLES')) {
        // Périmètre modifié : le curseur n'est plus transposable — invalidation CONTRÔLÉE (cycle recommencé).
        cumul = cycleColumns === true ? emptyCounters() : null;
        await writeCheckpoint(pgClient as unknown as SqlRun, scope, jeton, now, leaseMs, { phase: 'ALERTS', alertCursor: 0, coupleCursor: null, invalidate: true, counters: cumul, status: 'RAN' });
        out.checkpoint.invalidated = true;
        depart = { ...row, phase: 'ALERTS', alertCursor: 0, coupleCursor: null, cycle: row.cycle + 1 };
      } else if (row.phase !== 'ALERTS' && row.phase !== 'COUPLES') {
        const periode = ck.cyclePeriodMs ?? 0;
        if (row.lastCompletedAt !== null && row.lastCompletedAt > now - periode) {
          await writeCheckpoint(pgClient as unknown as SqlRun, scope, jeton, now, leaseMs, { release: true });
          out.checkpoint.status = 'NOTHING_TO_DO';
          out.checkpoint.cycle = row.cycle;
          out.done = true;
          return out;
        }
        cumul = cycleColumns === true ? emptyCounters() : null;
        await writeCheckpoint(pgClient as unknown as SqlRun, scope, jeton, now, leaseMs, { phase: 'ALERTS', alertCursor: 0, coupleCursor: null, newCycle: true, counters: cumul, status: 'RAN' });
        depart = { ...row, phase: 'ALERTS', alertCursor: 0, coupleCursor: null, cycle: row.cycle + 1 };
      } else {
        out.checkpoint.resumed = row.alertCursor > 0 || row.phase === 'COUPLES' || row.coupleCursor !== null;
      }
      out.checkpoint.cycle = depart.cycle;
      out.checkpoint.startedFrom = { phase: depart.phase, alertCursor: depart.alertCursor, coupleCursor: depart.coupleCursor };
    }
  }
  const perdu = (): SchemaAlertReevaluation => {
    tenu = false;
    if (out.checkpoint) out.checkpoint.status = 'LEASE_LOST';
    out.done = false;
    return out;
  };
  /** Carte #863 (D1) : renouvellement du bail AVANT une page (jamais une page commencée sous un bail presque échu). */
  const renouveler = async (): Promise<boolean> => {
    if (!tenu) return true;
    return writeCheckpoint(pgClient as unknown as SqlRun, scope, jeton, Date.now(), leaseMs, {});
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
    const st = await M.coupleRoutingStatus({ operationCode, model }, opts.readChain);
    routage.set(k, st);
    return st;
  };

  /**
   * Carte #863 (D1) — exécute UNE page : lecture + décisions (`prepare`), puis effets, curseur et compteurs dans
   * une transaction fencée (`apply`). Reprise bornée : une panne rejoue la page (aucun effet partiel validé). Rend
   * `null` si la page est validée, sinon la cause de l'arrêt.
   */
  const page = async <P>(phase: 'ALERTS' | 'COUPLES', prepare: () => Promise<P>, apply: (tx: SqlRun, p: P, delta: SchemaAlertCycleCounters) => Promise<void>,
    after: (p: P, delta: SchemaAlertCycleCounters) => void): Promise<'OK' | 'LEASE_LOST' | 'INTERRUPTED'> => {
    let derniere: unknown = null;
    for (let essai = 1; essai <= REEVAL_PAGE_ATTEMPTS; essai++) {
      if (essai > 1) { out.retries++; }
      try {
        // Bail renouvelé AVANT la page ; refusé (échu, repris) : arrêt sans rien écrire. Panne : page reprise.
        if (!(await renouveler())) return 'LEASE_LOST';
        const p = await prepare();
        const delta = emptyCounters();
        delta.pages = 1;
        if (essai > 1) { delta.retries = essai - 1; delta.failures = essai - 1; }
        await pgClient.begin(async (tx) => {
          const t = tx as unknown as SqlRun;
          if (tenu && !(await lockLease(t, scope, jeton, Date.now()))) throw new LeaseLost();
          await apply(t, p, delta);
        });
        after(p, delta);
        return 'OK';
      } catch (e) {
        if (e instanceof ReevaluationCrashSimulated) throw e;
        if (e instanceof LeaseLost) return 'LEASE_LOST';
        const code = (e as { code?: string } | null)?.code;
        if (code === '42P01' || code === '42703') throw e;
        derniere = e;
        out.failures++;
        console.warn(`[schema-compat] réévaluation : page ${phase} en échec (essai ${essai}/${REEVAL_PAGE_ATTEMPTS}) :`, String((e as Error)?.message ?? e).slice(0, 200));
      }
    }
    const message = String((derniere as Error)?.message ?? derniere).slice(0, 300);
    if (out.checkpoint) { out.checkpoint.status = 'INTERRUPTED'; out.checkpoint.lastError = message; }
    // Point sûr conservé (curseur, compteurs) ; échec et statut PERSISTÉS ; bail rendu : le passage suivant reprend ici.
    if (tenu) {
      const echecs = cumul ? addCounters(cumul, { ...emptyCounters(), failures: REEVAL_PAGE_ATTEMPTS, retries: REEVAL_PAGE_ATTEMPTS - 1 }) : null;
      await writeCheckpoint(pgClient as unknown as SqlRun, scope, jeton, Date.now(), leaseMs, { release: true, counters: echecs, status: 'INTERRUPTED', error: message }).catch(() => false);
      if (echecs) cumul = echecs;
      tenu = false;
    }
    return 'INTERRUPTED';
  };
  /** Écriture du curseur et des compteurs cumulés DANS la transaction de la page (fencée par le verrou). */
  const avancer = async (tx: SqlRun, delta: SchemaAlertCycleCounters, set: Parameters<typeof writeCheckpoint>[5]) => {
    if (!tenu) return;
    const nouveau = cumul ? addCounters(cumul, delta) : null;
    if (!(await writeCheckpoint(tx, scope, jeton, Date.now(), leaseMs, { ...set, counters: nouveau, status: 'RAN' }))) throw new LeaseLost();
  };
  const reporter = (delta: SchemaAlertCycleCounters) => {
    if (cumul) cumul = addCounters(cumul, delta);
    out.examined += delta.examined;
    for (const m of Object.keys(out.resolved) as SchemaAlertResolutionAll[]) out.resolved[m] += delta.resolved[m];
    out.keptActive += delta.keptActive; out.keptUndetermined += delta.keptUndetermined; out.keptRoutingUnknown += delta.keptRoutingUnknown;
    out.keptCauseChanged += delta.keptCauseChanged; out.alreadySatisfied += delta.alreadySatisfied + delta.raiseAlreadySatisfied;
    out.raised += delta.raised; out.raiseSkippedRoutingUnknown += delta.raiseSkippedRoutingUnknown; out.couplesScanned += delta.couplesScanned;
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
        if (tenu) {
          if (!(await writeCheckpoint(pgClient as unknown as SqlRun, scope, jeton, Date.now(), leaseMs, { alertCursor: cursor, release: true, status: 'RAN' }))) return finish(perdu());
          tenu = false;
          return finish();
        }
        break;
      }
      const limite = Math.min(PAGE, budget - out.examined);
      let fin = false;
      const issue = await page<AlertDecision[]>('ALERTS', async () => {
        const rows = (await pgClient.unsafe(
          `SELECT id, details FROM ai_alerts WHERE code = $1 AND resolved_at IS NULL AND id > $2 ORDER BY id LIMIT $3`,
          [SCHEMA_COMPAT_ALERT_CODE, cursor, limite] as never[],
        )) as unknown as Row[];
        const decisions: AlertDecision[] = [];
        for (const r of rows) {
          const id = Number(r.id);
          const keyId = String((r.details as { keyId?: unknown } | null)?.keyId ?? '');
          if (keyId) await opts.faults?.readCouple?.(keyId);
          // Lecture en ÉCHEC : lève (page reprise) — jamais confondue avec un couple absent.
          const couple = keyId ? await S.getCouple(keyId) : null;
          // Couple illisible : l'alerte est CONSERVÉE (on ne ferme jamais sur une absence de preuve).
          if (!couple) { decisions.push({ id, keyId, kind: 'KEEP_UNDETERMINED' }); continue; }
          if (couple.state === 'QUALIFIED') { decisions.push({ id, keyId, kind: 'RESOLVE', code: 'SCHEMA_ACCEPTED_AGAIN' }); continue; }
          if (!M.isCurrentCouple(couple.key)) { decisions.push({ id, keyId, kind: 'RESOLVE', code: 'SCHEMA_SUPERSEDED' }); continue; }
          // Lot 115 (carte #784, §E1) : le couple est bien celui que la passerelle projette — mais le
          // MODÈLE est-il encore routé ? Preuve de retrait : on clôt avec ce motif. État inconnu ou
          // indisponibilité : on CONSERVE (et le lendemain, même constat : aucune réouverture).
          const routeStatus = await statutRoutage(couple.key.operationCode, couple.key.model);
          if (routeStatus === 'WITHDRAWN') { decisions.push({ id, keyId, kind: 'RESOLVE', code: 'SCHEMA_MODEL_WITHDRAWN' }); continue; }
          decisions.push({ id, keyId, kind: routeStatus === 'UNKNOWN' ? 'KEEP_ROUTING' : 'KEEP_ACTIVE' });
        }
        await opts.faults?.beforeEffects?.({ phase: 'ALERTS', ids: decisions.map((d) => d.id) });
        return decisions;
      }, async (tx, decisions, delta) => {
        for (const d of decisions) {
          delta.examined++;
          if (d.kind === 'RESOLVE') {
            await opts.faults?.inEffect?.({ phase: 'ALERTS', kind: 'RESOLVE', id: d.id });
            const r = await resolveAlertEffect(tx, d.id, d.keyId, d.code);
            if (r === 'APPLIED') delta.resolved[d.code]++;
            else if (r === 'ALREADY_SATISFIED') delta.alreadySatisfied++;
            else delta.keptCauseChanged++;
          } else if (d.kind === 'KEEP_UNDETERMINED') delta.keptUndetermined++;
          else if (d.kind === 'KEEP_ROUTING') delta.keptRoutingUnknown++;
          else delta.keptActive++;
        }
        const dernier = decisions.length ? decisions[decisions.length - 1].id : cursor;
        await avancer(tx, delta, { alertCursor: dernier, examined: decisions.length });
        await opts.faults?.beforeCommit?.({ phase: 'ALERTS', cursor: dernier });
      }, (decisions, delta) => {
        if (decisions.length === 0) { fin = true; return; }
        cursor = decisions[decisions.length - 1].id;
        for (const d of decisions) if (d.kind !== 'RESOLVE' && d.keyId) ouvertes.add(d.keyId);
        reporter(delta);
      });
      if (issue === 'LEASE_LOST') return finish(perdu());
      if (issue === 'INTERRUPTED') { out.done = false; return finish(); }
      if (fin) { out.done = true; break; }
      await opts.onProgress?.({ phase: 'ALERTS', alertCursor: cursor, examined: out.examined });
    }
    if (!phaseAlertes) out.done = true;
    if (tenu && phaseAlertes) {
      if (!(await writeCheckpoint(pgClient as unknown as SqlRun, scope, jeton, Date.now(), leaseMs, { phase: 'COUPLES', coupleCursor: null }))) return finish(perdu());
    }
    // Couple refusé, toujours transmis, sans alerte ouverte : alerte levée (une fois).
    // Lot 115 (carte #784, §B1 et §E2) : PARCOURS EXHAUSTIF de la mémoire, page par page et par
    // `key_id` — la lecture bornée aux 2 000 refus les plus récents omettait les refus anciens, qui
    // restaient donc sans alerte. Un refus ancien est désormais traité comme un refus récent.
    let apres: string | null = depart?.phase === 'COUPLES' ? depart.coupleCursor : null;
    for (;;) {
      let fin = false;
      let indisponible = false;
      type Lot = { page: Awaited<ReturnType<typeof S.scanCouples>>; aLever: SchemaCoupleState[]; sautes: number };
      const issue = await page<Lot>('COUPLES', async () => {
        // Lecture en ÉCHEC : lève (page reprise) ; table absente : `null` (indisponible, signalé).
        const pg = await S.scanCouples({ states: ['REJECTED_CONFIRMED', 'NEEDS_RECHECK'], afterKeyId: apres });
        const aLever: SchemaCoupleState[] = [];
        let sautes = 0;
        for (const c of pg ?? []) {
          if (ouvertes.has(c.keyId) || !M.isCurrentCouple(c.key)) continue;
          // Lot 115 (carte #784, §E1) : une alerte n'est levée que si le modèle est RÉELLEMENT routé.
          //   · WITHDRAWN : le couple ne sert plus — aucune alerte à lever ;
          //   · UNKNOWN   : on ne sait pas. Lever ici ROUVRIRAIT, dès le passage suivant, une alerte
          //     que l'on vient de clore faute de routage lisible — ce que la carte interdit
          //     explicitement (« ne pas rouvrir le lendemain une alerte à cause disparue »). On
          //     s'abstient et on le COMPTE : le prochain passage, routage lisible, lèvera ce qui doit l'être.
          const statut = await statutRoutage(c.key.operationCode, c.key.model);
          if (statut !== 'ACTIVE') { if (statut === 'UNKNOWN') sautes++; continue; }
          aLever.push(c);
        }
        await opts.faults?.beforeEffects?.({ phase: 'COUPLES', ids: aLever.map((c) => c.keyId) });
        return { page: pg, aLever, sautes };
      }, async (tx, lot, delta) => {
        if (lot.page === null || lot.page.length === 0) return;
        delta.couplesScanned = lot.page.length;
        delta.raiseSkippedRoutingUnknown = lot.sautes;
        for (const c of lot.aLever) {
          await opts.faults?.inEffect?.({ phase: 'COUPLES', kind: 'RAISE', id: c.keyId });
          const r = await raiseAlertEffect(tx, c);
          if (r === 'APPLIED') delta.raised++;
          else if (r === 'ALREADY_SATISFIED') delta.raiseAlreadySatisfied++;
          else delta.keptCauseChanged++;
        }
        const dernier = lot.page[lot.page.length - 1].keyId;
        await avancer(tx, delta, { coupleCursor: dernier });
        await opts.faults?.beforeCommit?.({ phase: 'COUPLES', cursor: dernier });
      }, (lot, delta) => {
        if (lot.page === null) { indisponible = true; return; }
        if (lot.page.length === 0) { fin = true; return; }
        apres = lot.page[lot.page.length - 1].keyId;
        reporter(delta);
      });
      if (issue === 'LEASE_LOST') return finish(perdu());
      if (issue === 'INTERRUPTED') { out.done = false; return finish(); }
      if (indisponible) {
        out.unavailable = true; out.done = false;
        if (tenu) { await writeCheckpoint(pgClient as unknown as SqlRun, scope, jeton, Date.now(), leaseMs, { release: true }).catch(() => false); tenu = false; }
        return finish();
      }
      if (fin) break;
      await opts.onProgress?.({ phase: 'COUPLES', alertCursor: cursor, examined: out.examined });
    }
  } catch (e) {
    const code = (e as { code?: string } | null)?.code;
    if (code !== '42P01' && code !== '42703') throw e;
    out.unavailable = true;
    out.done = false;
    // Rien de conclu : bail rendu, curseur sûr conservé (reprise au même point).
    if (tenu) await writeCheckpoint(pgClient as unknown as SqlRun, scope, jeton, Date.now(), leaseMs, { release: true }).catch(() => false);
    tenu = false;
  }
  return finish();

  async function finish(r: SchemaAlertReevaluation = out): Promise<SchemaAlertReevaluation> {
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
    out.cycleTotals = cumul;
    // Carte #838 (D1) : fin de cycle → curseur remis à zéro, bilan conservé, bail rendu.
    // Carte #863 (D1) : bilan = compteurs CUMULÉS du cycle entier (repli : ceux du passage) ; reset après fin PROUVÉE.
    if (tenu && out.done && out.checkpoint) {
      const bilan = cumul ?? {
        examined: out.examined, resolved: out.resolved, keptActive: out.keptActive, raised: out.raised, couplesScanned: out.couplesScanned,
      };
      if (await writeCheckpoint(pgClient as unknown as SqlRun, scope, jeton, Date.now(), leaseMs, {
        phase: 'DONE', alertCursor: 0, coupleCursor: null, complete: true, release: true, report: bilan, counters: cumul, status: 'DONE',
      })) {
        out.checkpoint.cycleCompleted = true;
      } else {
        perdu();
      }
      tenu = false;
    }
    return r;
  }
}
