/**
 * Lot 114 (Trello #750, issue B) — ARBITRAGE T3 par l'IA d'une contradiction
 * RÉELLE d'attribut d'un événement de référence : mémoire, demandes, et PHASE
 * du passage T3 du compte (file durable de consolidation). Même forme que le
 * réexamen des périodes (lot 113AD, `relation-review.ts`).
 *
 * ══════════════════════════════════════════════════════════════════════════
 *   lecture  `loadAttributeReviews` — arbitrages et examens de l'événement,
 *            relus par la consolidation (`reconsolidateOperation`) AVANT la
 *            qualification : valeur retenue (RESOLVED certain), faits
 *            distincts, indécidable, document étranger, examen attendu ;
 *   demande  `requestAttributeReviews` — posée par la consolidation, SANS
 *            appel IA, seulement si le prompt T3 effectif porte la branche ET
 *            le marqueur : une ligne PENDING par constat jamais examiné. La
 *            carte « À traiter » est alors DIFFÉRÉE (au plus
 *            `ATTRIBUTE_ARBITRATION_MAX_WAIT_HOURS`) ;
 *   phase    `runAttributeArbitrationPhase` — passage T3 du compte (hors
 *            verrou, jamais à la consultation) : capacité → ligne encore
 *            présente ? → budget (plafonds EXISTANTS du rapprochement
 *            sémantique) → appel T3 → VALIDATION stricte (toute sortie
 *            invalide = abstention) → mémoire → reconsolidation de
 *            l'événement (valeur retenue écrite sous les protections,
 *            carte posée ou fermée) → valeur avant / après tracée.
 * Un constat déjà examiné n'est JAMAIS renvoyé à l'IA (une ligne par
 * empreinte et par compte). La décision de l'utilisateur prime toujours.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import {
  attributeChoiceKey, attributeSubjectKey, type AttributeChoice, type AttributeReview, type ConflictField, type QualifiedAttributeConflict,
} from '../attribute-conflicts';
import { ATTRIBUTE_ARBITRATION_CONTRACT_VERSION } from './contract';

type Row = Record<string, unknown>;
/** Transaction de consolidation ou client global (Drizzle). */
interface Exec { execute(q: SQL): Promise<unknown> }
const rows = async <T = Row>(x: Exec, q: SQL): Promise<T[]> => (await x.execute(q)) as unknown as T[];

/** Délai pendant lequel la carte « À traiter » attend l'arbitrage T3 demandé (heures). Paramètre centralisé, à valider par le PO. */
export const ATTRIBUTE_ARBITRATION_MAX_WAIT_HOURS = 24;
const RETRY_AFTER_HOURS = 6;
export const ATTRIBUTE_ARBITRATION_MAX_ATTEMPTS = 3;
const REQUESTS_PER_PASS = 20;

const COLONNE: Record<ConflictField, string> = {
  plannedDate: 'planned_date', startDate: 'start_date', realizedDate: 'realized_date', endDate: 'end_date', provider: 'provider',
};
const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
const intArray = (v: readonly number[]): string => `{${v.filter((x) => Number.isSafeInteger(x)).join(',')}}`;

/** Empreinte STABLE d'un constat : événement, attribut, rôle, valeurs normalisées (triées). */
export function arbitrationFingerprint(operationId: number, field: string, role: string, normalized: readonly string[]): string {
  const cle = `${operationId}|${field}|${role}|${[...new Set(normalized)].sort().join('\u0001')}`;
  return createHash('sha256').update(cle).digest('hex').slice(0, 40);
}

const lineFingerprint = (operationId: number, c: Pick<QualifiedAttributeConflict, 'field' | 'role' | 'values'>) =>
  arbitrationFingerprint(operationId, c.field, c.role, c.values.map((v) => v.normalized));

let tablePrete: boolean | null = null;
/** La table 1690 existe-t-elle ? (sonde sans erreur : jamais une transaction de consolidation annulée) */
async function arbitrationTableReady(x: Exec): Promise<boolean> {
  if (tablePrete) return true;
  const [r] = await rows<{ ok: boolean }>(x, sql`SELECT to_regclass('business_operation_attribute_arbitrations') IS NOT NULL AS ok`);
  tablePrete = !!r?.ok;
  return tablePrete;
}
let colonnes1785: boolean | null = null;
/**
 * Les colonnes de la migration 1785 (lot 115, #791) existent-elles ? Le code
 * est TOLÉRANT à son absence : sans elles, la couverture des preuves est
 * contrôlée en mémoire (aucun verdict sur contexte partiel) et l'application
 * n'est simplement pas tracée état par état — rien n'échoue.
 */
async function arbitrationStateColumnsReady(x: Exec): Promise<boolean> {
  if (colonnes1785 !== null) return colonnes1785;
  const [r] = await rows<{ ok: boolean }>(x, sql`
    SELECT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'business_operation_attribute_arbitrations' AND column_name = 'application_state') AS ok`);
  colonnes1785 = !!r?.ok;
  return colonnes1785;
}

/** Réservé aux tests. */
export function __resetArbitrationTableProbeForTests(): void { tablePrete = null; colonnes1785 = null; }

/**
 * Lot 115 (#791, E07) — mémoire d'un constat déjà soumis : son périmètre
 * MATÉRIEL de preuves (null : examen antérieur au lot 115, toléré) et le fait
 * qu'il ait RETENU une valeur. Une valeur retenue n'est jamais remise en
 * examen par une pièce de plus : la rouvrir reviendrait à défaire l'écriture
 * en attendant un nouveau verdict (choix par défaut n° 4, à valider).
 */
interface ExaminedLine {
  evidenceKey: string | null;
  resolved: boolean;
  /**
   * Carte #836 (écart E09) : une décision a retenu une valeur dont l'effet
   * n'est pas encore constaté (reçue, en cours, échec repris, escaladée). La
   * ligne n'est alors PAS renvoyée à l'IA : ce qui manque est l'application,
   * pas un verdict (et un nouveau verdict effacerait la décision en attente).
   */
  applicationPending: boolean;
}

export interface LoadedAttributeReviews {
  /** Valeurs retenues par T3 (RESOLVED certain), à appliquer sous les protections. */
  choices: AttributeChoice[];
  /** Dernier examen par sujet (attribut, rôle) qui n'a pas retenu de valeur. */
  reviews: Map<string, AttributeReview>;
  /** Empreintes déjà demandées ou examinées, et le périmètre de preuves de chacune. */
  fingerprints: Map<string, ExaminedLine>;
  ready: boolean;
  /**
   * Carte #836 (écart E07) : empreintes dont le périmètre matériel n'a JAMAIS
   * été mémorisé (`evidence_key IS NULL`, examens antérieurs au lot 115). Elles
   * étaient tolérées — donc jamais réexaminées, quelle que soit la preuve
   * nouvelle. Elles sont régularisées : UN réexamen, puis le périmètre est
   * écrit et vingt scans identiques ne relancent plus rien.
   */
  unkeyed: Set<string>;
}

/** Arbitrages et examens T3 de l'événement (table absente : aucun — la contradiction réelle va à la carte). */
export async function loadAttributeReviews(x: Exec, accountId: number, operationId: number): Promise<LoadedAttributeReviews> {
  const out: LoadedAttributeReviews = { choices: [], reviews: new Map(), fingerprints: new Map(), ready: false, unkeyed: new Set() };
  if (!(await arbitrationTableReady(x))) return out;
  out.ready = true;
  await arbitrationStateColumnsReady(x);
  const r = await rows(x, sql`
    SELECT id, field, role, fingerprint, presented_values, status, outcome, retained_normalized, confidence, attempts, foreign_file_id,
           to_jsonb(business_operation_attribute_arbitrations) ->> 'evidence_key' AS evidence_key,
           -- Carte #836 (E09) : état DURABLE de l'application (colonnes 1785 / 1960 ; absentes : état inconnu).
           to_jsonb(business_operation_attribute_arbitrations) ->> 'application_state' AS application_state,
           applied_at IS NOT NULL AS applied,
           (requested_at > now() - make_interval(hours => ${ATTRIBUTE_ARBITRATION_MAX_WAIT_HOURS})) AS fresh
      FROM business_operation_attribute_arbitrations
     WHERE account_id = ${accountId} AND operation_id = ${operationId} AND status NOT IN ('OBSOLETE', 'UNAVAILABLE')
     ORDER BY id`);
  for (const l of r) {
    const field = String(l.field) as ConflictField;
    const role = String(l.role);
    const known = (Array.isArray(l.presented_values) ? l.presented_values as Array<{ normalized?: unknown }> : [])
      .map((v) => v?.normalized).filter((v): v is string => typeof v === 'string');
    const cle = attributeChoiceKey(field, role);
    const reviewId = Number(l.id);
    const status = String(l.status);
    const certain = status === 'DECIDED' && l.confidence === 'certain';
    // Lot 115 (#791, E07) : périmètre matériel soumis (colonne 1785 ; absente ou nulle : inconnu, toléré).
    const evidenceKey = typeof l.evidence_key === 'string' && l.evidence_key ? l.evidence_key : null;
    const resolved = certain && l.outcome === 'RESOLVED' && typeof l.retained_normalized === 'string';
    // Carte #836 (E09) : état durable d'application — `UNTRACKED` quand la migration 1785 n'est pas passée
    // ou que la ligne lui est antérieure (seul le contrôle en base décide alors).
    const applicationState = ((): AttributeChoice['application'] => {
      const s = typeof l.application_state === 'string' ? l.application_state : null;
      if (s === 'APPLIED') return 'APPLIED';
      if (s === 'APPLY_FAILED') return 'FAILED';
      if (s === 'ESCALATED') return 'ESCALATED';
      if (s === 'RECEIVED' || s === 'APPLYING') return 'PENDING';
      return l.applied === true ? 'APPLIED' : 'UNTRACKED';
    })();
    const applicationPending = resolved && applicationState !== 'APPLIED' && applicationState !== 'UNTRACKED';
    out.fingerprints.set(String(l.fingerprint), { evidenceKey, resolved, applicationPending });
    // Empreinte historique jamais mémorisée : à régulariser (seulement si la colonne existe, et jamais
    // pour une demande encore en attente — celle-là n'a rien examiné).
    if (evidenceKey === null && status !== 'PENDING' && colonnes1785 === true) out.unkeyed.add(String(l.fingerprint));
    // Le constat le plus récent d'un sujet remplace le précédent (valeurs différentes : autre empreinte).
    out.choices = out.choices.filter((c) => attributeChoiceKey(c.field, c.role) !== cle);
    out.reviews.delete(cle);
    const etranger = l.foreign_file_id == null ? undefined : Number(l.foreign_file_id);
    const examen = (outcome: AttributeReview['outcome']): AttributeReview => ({
      field, role, known, reviewId, outcome, ...(evidenceKey ? { evidenceKey } : {}),
      // Carte #836 (écart E08) : document déclaré étranger — porté jusqu'au producteur de cartes.
      ...(outcome === 'LINK_ERROR' && etranger !== undefined ? { foreignFileId: etranger } : {}),
    });
    if (resolved) {
      // Carte #836 (E09) : la valeur retenue est TOUJOURS proposée à l'écriture (reprise idempotente), mais
      // son état d'application voyage avec elle : la qualification ne fermera la contradiction qu'après le
      // contrôle en base (`choiceApplication`).
      out.choices.push({ field, role, normalized: String(l.retained_normalized), known, by: 'T3', reviewId, application: applicationState });
    } else if (certain && (l.outcome === 'DISTINCT_FACTS' || l.outcome === 'UNDECIDABLE' || l.outcome === 'LINK_ERROR')) {
      out.reviews.set(cle, examen(l.outcome === 'DISTINCT_FACTS' ? 'LEGITIMATE_DIFFERENCE' : l.outcome));
    } else if ((status === 'PENDING' || (status === 'AI_FAILED' && Number(l.attempts ?? 0) < ATTRIBUTE_ARBITRATION_MAX_ATTEMPTS)) && l.fresh === true) {
      out.reviews.set(cle, examen('PENDING'));
    } else {
      out.reviews.set(cle, examen(status === 'AI_FAILED' || status === 'PENDING' ? 'FAILED' : 'ABSTAINED'));
    }
  }
  return out;
}

/**
 * La ligne relève-t-elle de l'arbitrage T3 ? Contradiction du même attribut et du même rôle, non
 * tranchée, sans valeur protégée par l'utilisateur (celle-là va directement à la carte), avec au
 * moins deux valeurs réellement différentes.
 */
export function eligibleForArbitration(c: QualifiedAttributeConflict): boolean {
  const reelle = c.qualification === 'REAL_CONFLICT_UNRESOLVED' && c.reasonCode !== 'USER_VALUE_NOT_RETAINED';
  const identiteNonEtablie = c.qualification === 'INSUFFICIENT_EVIDENCE' && c.reasonCode === 'FACT_IDENTITY_NOT_ESTABLISHED';
  return (reelle || identiteNonEtablie) && c.role !== 'MIXED' && c.protection !== 'USER'
    && new Set(c.values.map((v) => v.normalized)).size >= 2;
}

/**
 * Demandes d'arbitrage des constats JAMAIS examinés (aucun appel IA), si le prompt T3 effectif porte
 * la branche. Rend les sujets (attribut, rôle) dont l'examen vient d'être demandé.
 */
export async function requestAttributeReviews(
  x: Exec, accountId: number, operationId: number, open: readonly QualifiedAttributeConflict[], loaded: LoadedAttributeReviews,
  fileOfSource: ReadonlyMap<number, number> = new Map(),
): Promise<Set<string>> {
  const out = new Set<string>();
  if (!loaded.ready) return out;
  /**
   * Lot 115 (#791, E07) : un constat déjà examiné n'est REPRIS que si le
   * périmètre MATÉRIEL de ses preuves a changé (pièce plus autoritaire,
   * révision déclarée, identité ou date d'effet nouvelle) — jamais sur vingt
   * scans ni sur une pièce équivalente. Une valeur déjà RETENUE n'est jamais
   * remise en examen (elle serait défaite en attendant un nouveau verdict).
   */
  /**
   * Carte #836 (écart E07) — **règle remplacée** : une valeur déjà RETENUE
   * n'était plus jamais réexaminée (`deja.resolved`), et une empreinte
   * historique `evidence_key = NULL` était tolérée sans fin — une facture
   * rectificative pouvait donc rester sans effet pour toujours. Désormais :
   *   · une ÉVOLUTION MATÉRIELLE du périmètre (autorité, référence, période,
   *     révision, identité, contradiction) rouvre l'examen, même à valeur
   *     textuelle égale, et même si une valeur avait été retenue ;
   *   · une empreinte historique NULL donne droit à UN réexamen, après quoi le
   *     périmètre est mémorisé : vingt scans identiques ne relancent rien ;
   *   · une décision dont l'APPLICATION est encore en cours ou escaladée n'est
   *     jamais renvoyée à l'IA (c'est l'application qui manque, pas l'avis) ;
   *   · sans empreinte calculable, aucun rejeu.
   */
  const aExaminer = (c: QualifiedAttributeConflict): boolean => {
    const deja = loaded.fingerprints.get(lineFingerprint(operationId, c));
    if (deja === undefined) return true;
    if (deja.applicationPending || c.evidenceKey === undefined) return false;
    if (deja.evidenceKey === null) return loaded.unkeyed.has(lineFingerprint(operationId, c));
    return deja.evidenceKey !== c.evidenceKey;
  };
  const candidates = open.filter((c) => eligibleForArbitration(c) && aExaminer(c));
  if (!candidates.length) return out;
  const { arbitrationDecider } = await import('./decider');
  const cap = await arbitrationDecider().capability();
  if (!cap.available) return out;
  const traceEtat = await arbitrationStateColumnsReady(x);
  for (const c of candidates) {
    const presentees = c.values.map((v) => ({
      value: v.value, normalized: v.normalized, sourceIds: v.sourceIds,
      fileIds: [...new Set(v.sourceIds.map((id) => fileOfSource.get(id)).filter((f): f is number => f !== undefined))],
      userProtected: v.sources.some((s) => s.role === 'USER_ENTRY' || s.authority === 'USER'),
    }));
    const fichiers = [...new Set(presentees.flatMap((v) => v.fileIds))].sort((a, b) => a - b);
    // Sans document à citer, T3 n'a aucune preuve à examiner : la ligne suit son cours.
    if (!fichiers.length) continue;
    const cle = c.evidenceKey ?? null;
    const r = traceEtat
      ? await rows(x, sql`
        INSERT INTO business_operation_attribute_arbitrations (account_id, operation_id, field, role, fingerprint, presented_values, file_ids, status, contract_version, evidence_key)
        VALUES (${accountId}, ${operationId}, ${c.field}, ${c.role}, ${lineFingerprint(operationId, c)}, ${JSON.stringify(presentees)}::jsonb,
                ${intArray(fichiers)}::int[], 'PENDING', ${ATTRIBUTE_ARBITRATION_CONTRACT_VERSION}, ${cle})
        ON CONFLICT (account_id, fingerprint) DO UPDATE
           SET status = 'PENDING', presented_values = EXCLUDED.presented_values, file_ids = EXCLUDED.file_ids, evidence_key = EXCLUDED.evidence_key,
               requested_at = now(), updated_at = now(), attempts = 0, retry_at = NULL, error = NULL
        -- Carte #836 (E07) : une ÉVOLUTION MATÉRIELLE du périmètre rouvre l'examen, y compris celui qui avait
        -- retenu une valeur (règle remplacée : il était figé). Jamais sur un périmètre identique, jamais sur une
        -- demande déjà en attente, et jamais tant que l'APPLICATION d'une décision reste à faire (E09).
         WHERE business_operation_attribute_arbitrations.status IN ('OBSOLETE', 'UNAVAILABLE')
            OR (business_operation_attribute_arbitrations.evidence_key IS DISTINCT FROM EXCLUDED.evidence_key
                AND business_operation_attribute_arbitrations.status NOT IN ('PENDING')
                AND NOT (business_operation_attribute_arbitrations.status = 'DECIDED'
                         AND business_operation_attribute_arbitrations.outcome = 'RESOLVED'
                         AND business_operation_attribute_arbitrations.applied_at IS NULL
                         AND COALESCE(business_operation_attribute_arbitrations.application_state, 'APPLIED') <> 'APPLIED'))
        RETURNING id`)
      : await rows(x, sql`
        INSERT INTO business_operation_attribute_arbitrations (account_id, operation_id, field, role, fingerprint, presented_values, file_ids, status, contract_version)
        VALUES (${accountId}, ${operationId}, ${c.field}, ${c.role}, ${lineFingerprint(operationId, c)}, ${JSON.stringify(presentees)}::jsonb,
                ${intArray(fichiers)}::int[], 'PENDING', ${ATTRIBUTE_ARBITRATION_CONTRACT_VERSION})
        ON CONFLICT (account_id, fingerprint) DO UPDATE
           SET status = 'PENDING', presented_values = EXCLUDED.presented_values, file_ids = EXCLUDED.file_ids,
               requested_at = now(), updated_at = now(), attempts = 0, retry_at = NULL, error = NULL
         WHERE business_operation_attribute_arbitrations.status IN ('OBSOLETE', 'UNAVAILABLE')
        RETURNING id`);
    if (r.length) out.add(attributeSubjectKey(c));
  }
  return out;
}

/**
 * Carte #836 (écart E07) — RÉGULARISATION des empreintes historiques.
 *
 * Les examens antérieurs au lot 115 n'ont pas mémorisé le périmètre matériel
 * de leurs preuves (`evidence_key IS NULL`). `reviewCovers` les tolérait : leur
 * verdict couvrait la ligne POUR TOUJOURS, quelle que soit la preuve nouvelle.
 * Cette écriture leur donne pour référence le périmètre CONSTATÉ aujourd'hui :
 * rien n'est rouvert maintenant (le verdict rendu portait sur ces preuves-là,
 * c'est la seule information dont on dispose), mais toute évolution matérielle
 * ULTÉRIEURE est désormais détectée. Idempotente (`evidence_key IS NULL`),
 * bornée à l'événement, sans aucun appel à l'IA. Les lignes encore ouvertes et
 * éligibles sont, elles, réellement réexaminées (`aExaminer`).
 */
export async function regularizeEvidenceKeys(
  x: Exec, accountId: number, operationId: number, lines: readonly QualifiedAttributeConflict[], loaded: LoadedAttributeReviews,
): Promise<number> {
  if (!loaded.ready || !loaded.unkeyed.size) return 0;
  let n = 0;
  for (const c of lines) {
    if (c.evidenceKey === undefined) continue;
    const fp = lineFingerprint(operationId, c);
    if (!loaded.unkeyed.has(fp)) continue;
    await x.execute(sql`
      UPDATE business_operation_attribute_arbitrations
         SET evidence_key = ${c.evidenceKey}, updated_at = now()
       WHERE account_id = ${accountId} AND operation_id = ${operationId} AND fingerprint = ${fp} AND evidence_key IS NULL`);
    loaded.unkeyed.delete(fp);
    n++;
  }
  return n;
}

/** Prédicat SQL « le compte a une demande d'arbitrage à traiter » (balayage horaire du passage T3). */
export const ATTRIBUTE_ARBITRATION_PENDING_SQL = (alias: string) => `
  (${alias}.status = 'PENDING' OR (${alias}.status = 'AI_FAILED' AND ${alias}.retry_at <= now() AND ${alias}.attempts < ${ATTRIBUTE_ARBITRATION_MAX_ATTEMPTS}))`;

interface Presented { value: string; normalized: string; sourceIds: number[]; fileIds: number[]; userProtected: boolean }
interface Pending { id: number; operationId: number; field: ConflictField; role: string; fingerprint: string; values: Presented[]; attempts: number }

async function pendingRequests(x: Exec, accountId: number, limit: number): Promise<Pending[]> {
  const r = await rows(x, sql`
    SELECT r.id, r.operation_id, r.field, r.role, r.fingerprint, r.presented_values, r.attempts
      FROM business_operation_attribute_arbitrations r
     WHERE r.account_id = ${accountId} AND ${sql.raw(ATTRIBUTE_ARBITRATION_PENDING_SQL('r'))} ORDER BY r.id LIMIT ${limit}`);
  return r.map((l) => ({
    id: Number(l.id), operationId: Number(l.operation_id), field: String(l.field) as ConflictField, role: String(l.role),
    fingerprint: String(l.fingerprint), values: (Array.isArray(l.presented_values) ? l.presented_values : []) as Presented[], attempts: Number(l.attempts ?? 0),
  }));
}

async function callsLastDay(x: Exec, accountId: number): Promise<number> {
  const [r] = await rows<{ n: number }>(x, sql`
    SELECT COALESCE(sum(ai_calls), 0)::int AS n FROM business_operation_attribute_arbitrations
     WHERE account_id = ${accountId} AND last_call_at > now() - interval '24 hours'`);
  return Number(r?.n ?? 0);
}

async function complete(x: Exec, id: number, r: {
  status: string; outcome?: string | null; retainedValue?: string | null; retainedNormalized?: string | null; foreignFileId?: number | null;
  confidence?: string | null; evidence?: unknown; reason?: string | null; aiOutput?: unknown; validation?: Record<string, unknown>;
  deciderVersion?: string | null; traceId?: string | null; called?: boolean; error?: string | null; retry?: boolean;
  /** Lot 115 (#791, E09) : état d'APPLICATION de la décision (colonne 1785 ; ignoré si la migration n'est pas passée). */
  applicationState?: 'RECEIVED' | 'APPLYING' | 'APPLIED' | 'APPLY_FAILED';
}): Promise<void> {
  const appele = r.called === true;
  // Carte #836 (écart E09) : l'état d'application est écrit dans LA MÊME instruction que la décision —
  // **règle remplacée** (deux UPDATE successifs laissaient, en cas de panne entre les deux, une décision
  // sans état). Une décision REÇUE rouvre le budget de reprises de son application.
  const etat = r.applicationState && await arbitrationStateColumnsReady(x)
    ? sql`application_state = ${r.applicationState},
          application_attempts = CASE WHEN ${r.applicationState === 'RECEIVED'} THEN 0 ELSE application_attempts END,
          application_error = CASE WHEN ${r.applicationState === 'RECEIVED'} THEN NULL ELSE application_error END,
          applied_at = CASE WHEN ${r.applicationState === 'RECEIVED'} THEN NULL ELSE applied_at END,`
    : sql``;
  await x.execute(sql`
    UPDATE business_operation_attribute_arbitrations
       SET ${etat} status = ${r.status}, outcome = COALESCE(${r.outcome ?? null}, outcome),
           retained_value = ${r.retainedValue ?? null}, retained_normalized = ${r.retainedNormalized ?? null}, foreign_file_id = ${r.foreignFileId ?? null},
           confidence = COALESCE(${r.confidence ?? null}, confidence), evidence = COALESCE(${json(r.evidence)}::jsonb, evidence),
           reason = COALESCE(${r.reason ? r.reason.slice(0, 300) : null}, reason), ai_output = COALESCE(${json(r.aiOutput)}::jsonb, ai_output),
           validation = COALESCE(${json(r.validation)}::jsonb, validation), decider_version = COALESCE(${r.deciderVersion ?? null}, decider_version),
           ai_trace_id = COALESCE(${r.traceId ?? null}, ai_trace_id),
           ai_calls = ai_calls + ${appele ? 1 : 0}, attempts = attempts + ${appele ? 1 : 0},
           last_call_at = CASE WHEN ${appele} THEN now() ELSE last_call_at END, error = ${r.error ? r.error.slice(0, 500) : null},
           retry_at = CASE WHEN ${r.retry === true} THEN now() + make_interval(hours => ${RETRY_AFTER_HOURS}) ELSE NULL END,
           decided_at = CASE WHEN ${r.status} IN ('PENDING', 'AI_FAILED') THEN decided_at ELSE now() END, updated_at = now()
     WHERE id = ${id}`);
}

/** La ligne existe-t-elle encore sur l'événement (mêmes valeurs, toujours une contradiction active) ? */
async function currentLine(x: Exec, accountId: number, d: Pending): Promise<{ line: QualifiedAttributeConflict; type: string | null; label: string | null; current: string | null } | null> {
  const [o] = await rows(x, sql`
    SELECT type_code, technical_label, ${sql.raw(COLONNE[d.field])}::text AS courant, to_jsonb(o)->'attribute_provenance'->'conflicts' AS conflicts
      FROM business_operations o
     WHERE o.id = ${d.operationId} AND o.account_id = ${accountId} AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL`);
  if (!o) return null;
  const lignes = (Array.isArray(o.conflicts) ? o.conflicts : []) as QualifiedAttributeConflict[];
  const line = lignes.find((c) => c && c.field === d.field && c.role === d.role && Array.isArray(c.values)
    && lineFingerprint(d.operationId, c) === d.fingerprint && eligibleForArbitration(c));
  return line ? { line, type: (o.type_code as string | null) ?? null, label: (o.technical_label as string | null) ?? null, current: (o.courant as string | null) ?? null } : null;
}

const valueOf = async (x: Exec, accountId: number, operationId: number, field: ConflictField): Promise<string | null> => {
  const [o] = await rows(x, sql`SELECT ${sql.raw(COLONNE[field])}::text AS v FROM business_operations WHERE id = ${operationId} AND account_id = ${accountId}`);
  return (o?.v as string | null) ?? null;
};

/** Carte #836 (écart E09) : motif précis d'une application non constatée (trace, BO, journal). */
export type ApplicationCheckReason =
  | 'OPERATION_GONE' | 'VALUE_NOT_WRITTEN' | 'PROVENANCE_MISMATCH' | 'CONFLICT_STILL_OPEN'
  | 'PROTECTED_OR_UNMANAGED_VALUE';

/**
 * Carte #836 (écart E09) — POURQUOI la valeur décidée n'a pas été écrite : la
 * cause SPÉCIFIQUE, quand il y en a une (lecture seule, sans IA).
 *
 * **Règle remplacée (carte #836, E09)** : le contrôle en base rendait
 * `VALUE_NOT_WRITTEN` dès que la valeur lue différait de la valeur attendue — y
 * compris lorsqu'elle en différait PARCE QU'ELLE EST PROTÉGÉE (saisie de
 * l'utilisateur, rétablissement BO, import) ou parce que l'événement porte une
 * source que T3 ne gère pas (formulaire, migration : la consolidation n'y
 * applique jamais un arbitrage T3). Le constat générique masquait donc le motif
 * précis et actionnable, `PROTECTED_OR_UNMANAGED_VALUE`, qui est celui que la
 * trace, le BO et le journal doivent porter. `VALUE_NOT_WRITTEN` ne couvre plus
 * que l'échec d'écriture INEXPLIQUÉ.
 *
 * Trois preuves, de la plus précise à la plus générale :
 *   1. la ligne de contradiction du MÊME champ et du MÊME rôle porte une
 *      protection (`protection: USER | ADMIN | IMPORT`) ;
 *   2. une source ACTIVE de l'événement porte une autorité protégée ;
 *   3. une source ACTIVE n'est pas gérée par T3 (hors décision d'arbitrage) —
 *      l'événement n'est pas « entièrement géré », et aucun arbitrage T3 n'y est
 *      écrit.
 */
async function nonEcriturePrecisee(
  x: Exec, accountId: number, d: { operationId: number; field: ConflictField; role: string },
  conflicts: readonly QualifiedAttributeConflict[],
): Promise<'VALUE_NOT_WRITTEN' | 'PROTECTED_OR_UNMANAGED_VALUE'> {
  if (conflicts.some((c) => c && c.field === d.field && c.role === d.role && !!c.protection)) {
    return 'PROTECTED_OR_UNMANAGED_VALUE';
  }
  const [s] = await rows(x, sql`
    SELECT bool_or(s.authority IN ('USER', 'ADMIN', 'IMPORT')) AS protegee,
           bool_or(NOT ((s.source_kind = 'DOCUMENT' AND s.locator ? 'candidateKey')
                     OR (s.source_kind = 'ASSET_DATA' AND s.locator ? 'nature')
                     OR (s.source_kind = 'AGENDA' AND s.locator ? 'agenda'))
                   AND NOT (s.source_kind = 'USER_ARBITRATION' AND s.locator ? 'decision')) AS hors_gestion
      FROM business_operation_sources s
     WHERE s.operation_id = ${d.operationId} AND s.account_id = ${accountId} AND s.active`);
  return s?.protegee === true || s?.hors_gestion === true ? 'PROTECTED_OR_UNMANAGED_VALUE' : 'VALUE_NOT_WRITTEN';
}

/**
 * Carte #836 (écart E09) — CONTRÔLE EN BASE d'une application, avant tout
 * « appliqué ». **Règle remplacée** : l'effet était jugé sur la seule colonne
 * de l'attribut (`valueOf`). Le contrôle porte maintenant sur :
 *   · le COMPTE et l'événement (actif, non fusionné, non invalidé) ;
 *   · le CHAMP et la VALEUR réellement persistés ;
 *   · la PROVENANCE écrite pour ce champ (78A) ;
 *   · le BON FAIT et la BONNE PÉRIODE : la ligne de provenance de la même
 *     empreinte (attribut, rôle, valeurs) ne doit plus être une contradiction
 *     ouverte. Ligne disparue : l'écriture a bien eu lieu, plus rien à trancher.
 * Lecture seule, sans IA, rejouable à l'identique.
 *
 * Exportée pour son test unitaire : c'est ELLE qui nomme le motif écrit dans la
 * trace, le BO et le journal, et ce motif doit être éprouvé sans base.
 */
export async function verifyApplication(
  x: Exec, accountId: number, d: { id: number; operationId: number; field: ConflictField; role: string; fingerprint: string },
  expected: string,
): Promise<{ applied: boolean; value: string | null; reason?: ApplicationCheckReason }> {
  const [o] = await rows(x, sql`
    SELECT (o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL) AS active,
           ${sql.raw(COLONNE[d.field])}::text AS courant,
           to_jsonb(o) -> 'attribute_provenance' -> 'fields' -> ${d.field} ->> 'value' AS provenance,
           to_jsonb(o) -> 'attribute_provenance' -> 'conflicts' AS conflicts
      FROM business_operations o WHERE o.id = ${d.operationId} AND o.account_id = ${accountId}`);
  if (!o) return { applied: false, value: null, reason: 'OPERATION_GONE' };
  const value = (o.courant as string | null) ?? null;
  const lignes = (Array.isArray(o.conflicts) ? o.conflicts : []) as QualifiedAttributeConflict[];
  if (o.active !== true) return { applied: false, value, reason: 'OPERATION_GONE' };
  // La cause SPÉCIFIQUE (protection, source hors gestion) est prioritaire sur le constat générique.
  if (value !== expected) return { applied: false, value, reason: await nonEcriturePrecisee(x, accountId, d, lignes) };
  const prov = (o.provenance as string | null) ?? null;
  if (prov !== null && prov !== expected) return { applied: false, value, reason: 'PROVENANCE_MISMATCH' };
  const ouvertes = lignes;
  const encore = ouvertes.some((c) => c && c.field === d.field && c.role === d.role && Array.isArray(c.values)
    && lineFingerprint(d.operationId, c) === d.fingerprint);
  return encore ? { applied: false, value, reason: 'CONFLICT_STILL_OPEN' } : { applied: true, value };
}

export interface AttributeArbitrationPhaseResult {
  processed: number;
  aiCalls: number;
  /** Événements de référence reconsolidés (valeur appliquée, carte posée ou fermée). */
  operations: number[];
  outcomes: Record<string, number>;
  /** Valeurs réellement écrites sur un événement de référence (application VÉRIFIÉE). */
  applied: number;
  /** Lot 115 (#791, E09) : applications reprises (décision reçue, effet jamais vérifié). */
  resumed?: number;
  /** Lot 115 (#791, E09) : décisions dont l'application a été vérifiée SANS effet (valeur protégée, saisie non gérée). */
  applyFailed?: number;
  /**
   * Carte #836 (écart E09) : applications dont le plafond de reprises est
   * ÉPUISÉ — escalade explicite (la contradiction reste visible et actionnable,
   * jamais un blocage silencieux).
   */
  escalated?: number;
  /** Carte #836 (écart E07) : empreintes historiques régularisées (aucun appel IA). */
  regularized?: number;
  /**
   * Lot 115 (#791, E08) : verdicts « document étranger » dont la séparation a
   * EU LIEU et dont les valeurs dérivées viennent d'être réparées (une seule
   * fois par ligne). Jamais un détachement décidé par un traitement.
   */
  linkRepairs?: number;
  /** Capacité absente (bloc 38 non collé, coupure) : aucune demande traitée par l'IA. */
  unavailable?: string;
}

/**
 * Lot 115 (#791, E09) — décisions REÇUES dont l'effet métier n'a jamais été
 * vérifié (panne entre la décision et la reconsolidation, échec SQL, rejeu
 * concurrent). Reprises au passage suivant, sans aucun appel à l'IA : la
 * valeur retenue est relue par la consolidation (idempotente), puis l'effet
 * est VÉRIFIÉ sur l'événement.
 */
interface PendingApplication { id: number; operationId: number; field: ConflictField; role: string; fingerprint: string; value: string }

async function pendingApplications(x: Exec, accountId: number, limit: number): Promise<PendingApplication[]> {
  if (!(await arbitrationStateColumnsReady(x))) return [];
  // Carte #836 (écart E09) — **règle remplacée** : la reprise était un simple SELECT, et la tentative n'était
  // comptée qu'au moment de l'écriture groupée. Deux passages concurrents (deux workers) pouvaient donc
  // réserver la MÊME ligne. La reprise RÉSERVE maintenant ses lignes en une seule instruction atomique
  // (`FOR UPDATE SKIP LOCKED`) qui porte l'état durable APPLYING et incrémente la tentative : un arrêt
  // brutal laisse une trace reprise au passage suivant, jamais un « appliqué » faux ni un doublon de travail.
  const r = await rows(x, sql`
    UPDATE business_operation_attribute_arbitrations a
       SET application_state = 'APPLYING', application_attempts = a.application_attempts + 1, updated_at = now()
     WHERE a.id IN (
       SELECT s.id FROM business_operation_attribute_arbitrations s
        WHERE s.account_id = ${accountId} AND s.status = 'DECIDED' AND s.outcome = 'RESOLVED' AND s.retained_value IS NOT NULL
          AND s.application_state IN ('RECEIVED', 'APPLYING', 'APPLY_FAILED') AND s.applied_at IS NULL
          AND s.application_attempts < ${ATTRIBUTE_ARBITRATION_MAX_ATTEMPTS}
        ORDER BY s.id LIMIT ${limit} FOR UPDATE SKIP LOCKED)
    RETURNING a.id, a.operation_id, a.field, a.role, a.fingerprint, a.retained_value`);
  return r.map((l) => ({
    id: Number(l.id), operationId: Number(l.operation_id), field: String(l.field) as ConflictField, role: String(l.role),
    fingerprint: String(l.fingerprint), value: String(l.retained_value),
  }));
}

/**
 * Carte #836 (écart E09) — ESCALADE EXPLICITE des applications épuisées.
 *
 * Le plafond de reprises existait sans gestion de son épuisement : passé trois
 * tentatives, la ligne sortait silencieusement de la file de reprise et
 * personne n'était averti — un faux « résolu » était remplacé par un blocage
 * muet. Ces lignes passent désormais à l'état durable `ESCALATED` : la
 * contradiction reste visible et actionnable (carte « À traiter », motif
 * `T3_APPLICATION_ESCALATED`), l'opération est reconsolidée, et le journal
 * porte le constat (aucune donnée du client : identifiants seulement).
 * Idempotente : une ligne déjà escaladée n'est plus reprise.
 */
async function escalateExhaustedApplications(x: Exec, accountId: number, limit: number): Promise<Array<{ id: number; operationId: number; field: ConflictField }>> {
  if (!(await arbitrationStateColumnsReady(x))) return [];
  const r = await rows(x, sql`
    UPDATE business_operation_attribute_arbitrations a
       SET application_state = 'ESCALATED',
           application_error = COALESCE(a.application_error, 'APPLICATION_ATTEMPTS_EXHAUSTED'),
           validation = COALESCE(a.validation, '{}'::jsonb) || jsonb_build_object('applicationEscalated', jsonb_build_object(
             'attempts', a.application_attempts, 'at', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSOF'))),
           updated_at = now()
     WHERE a.id IN (
       SELECT s.id FROM business_operation_attribute_arbitrations s
        WHERE s.account_id = ${accountId} AND s.status = 'DECIDED' AND s.outcome = 'RESOLVED' AND s.retained_value IS NOT NULL
          AND s.application_state IN ('RECEIVED', 'APPLYING', 'APPLY_FAILED') AND s.applied_at IS NULL
          AND s.application_attempts >= ${ATTRIBUTE_ARBITRATION_MAX_ATTEMPTS}
        ORDER BY s.id LIMIT ${limit} FOR UPDATE SKIP LOCKED)
    RETURNING a.id, a.operation_id, a.field`);
  return r.map((l) => ({ id: Number(l.id), operationId: Number(l.operation_id), field: String(l.field) as ConflictField }));
}

/**
 * Lot 115 (#791, E08 — part FAISABLE sans décision nouvelle) — RÉPARATION DES
 * VALEURS DÉRIVÉES après un verdict « document étranger ».
 *
 * Le verdict `LINK_ERROR` ouvre un doute de rattachement et rend le candidat
 * au réexamen d'identité EXISTANT (lot 78A), qui ne sépare que sur
 * contradiction CERTAINE. Jusqu'ici, quand cette séparation avait LIEU — par
 * le réexamen, par le rétablissement BO, ou parce que le justificatif a été
 * retiré ou supprimé — rien ne refermait la boucle du côté de l'arbitrage :
 * l'événement de référence gardait des valeurs (dates, prestataire,
 * composantes, provenance, libellé) encore justifiées par la source partie.
 *
 * Cette lecture rend les lignes `LINK_ERROR` dont le document désigné N'EST
 * PLUS une source ACTIVE de l'événement : elles entrent dans la
 * reconsolidation CIBLÉE du passage (chaîne existante
 * `reconsolidateOperations` : valeurs recalculées depuis les sources actives,
 * provenance refaite, carte posée ou fermée, événements publiés après commit
 * qui mettent à jour l'Agenda, le coût de possession et les exports). Une
 * fois réparée, la ligne porte sa trace (`validation.linkRepair`) et n'est
 * plus reprise : idempotent, borné, sans aucun appel à l'IA.
 *
 * CE QUI N'EST PAS FAIT, ET POURQUOI — aucun DÉTACHEMENT, aucune FUSION,
 * aucune SCISSION n'est décidé ici : c'est une décision du PO qui manque
 * (« faut-il détacher automatiquement un justificatif que T3 déclare
 * étranger, à quel niveau de preuve, et que devient alors l'événement
 * d'arrivée ? »). Tant qu'elle n'est pas prise, un document encore ACTIF et
 * déclaré étranger garde son doute ouvert et sa source en place : rien n'est
 * réparé de force.
 */
async function pendingLinkRepairs(x: Exec, accountId: number, limit: number): Promise<Array<{ id: number; operationId: number; fileId: number }>> {
  const r = await rows(x, sql`
    SELECT a.id, a.operation_id, a.foreign_file_id
      FROM business_operation_attribute_arbitrations a
      JOIN business_operations o ON o.id = a.operation_id AND o.account_id = a.account_id
       AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
     WHERE a.account_id = ${accountId} AND a.status = 'DECIDED' AND a.outcome = 'LINK_ERROR'
       AND a.foreign_file_id IS NOT NULL
       AND NOT (COALESCE(a.validation, '{}'::jsonb) ? 'linkRepair')
       AND NOT EXISTS (SELECT 1 FROM business_operation_sources s
                        WHERE s.account_id = a.account_id AND s.operation_id = a.operation_id AND s.active
                          AND s.source_kind = 'DOCUMENT' AND s.source_entity_key = a.foreign_file_id::text)
     ORDER BY a.id LIMIT ${limit}`);
  return r.map((l) => ({ id: Number(l.id), operationId: Number(l.operation_id), fileId: Number(l.foreign_file_id) }));
}

const todayParis = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(d);

/**
 * Phase du passage T3 du compte (file de consolidation) : traite les demandes d'arbitrage en attente,
 * par lot borné. Ne lève que l'annulation coopérative ; tout autre échec est tracé sur la demande.
 */
export async function runAttributeArbitrationPhase(accountId: number, opts: {
  now?: () => Date; beforeCall?: (what: string) => Promise<void> | void;
  decider?: import('./decider').ArbitrationDecider; dailyMax?: number; passMax?: number; limit?: number;
} = {}): Promise<AttributeArbitrationPhaseResult> {
  const out: AttributeArbitrationPhaseResult = { processed: 0, aiCalls: 0, operations: [], outcomes: {}, applied: 0 };
  const [{ db, pgClient }, deciderMod, contract, m3] = await Promise.all([
    import('@/db'), import('./decider'), import('./contract'), import('../m3'),
  ]);
  const x: Exec = db;
  if (!(await arbitrationTableReady(x))) return out;
  const demandes = await pendingRequests(x, accountId, opts.limit ?? REQUESTS_PER_PASS);
  // Lot 115 (#791, E09) : d'abord les applications inachevées du compte (aucun appel IA).
  const reprises = await pendingApplications(x, accountId, opts.limit ?? REQUESTS_PER_PASS);
  // Carte #836 (E09) : puis celles dont le plafond de reprises est épuisé — escalade explicite.
  const escalades = await escalateExhaustedApplications(x, accountId, opts.limit ?? REQUESTS_PER_PASS);
  // Lot 115 (#791, E08) : puis les valeurs dérivées à réparer après une séparation déjà décidée (aucun appel IA).
  const reparations = await pendingLinkRepairs(x, accountId, opts.limit ?? REQUESTS_PER_PASS);
  if (!demandes.length && !reprises.length && !escalades.length && !reparations.length) return out;
  const now = opts.now ?? (() => new Date());
  const decider = opts.decider ?? deciderMod.arbitrationDecider();
  const parJour = opts.dailyMax ?? m3.operationMatchCallsPerDay();
  const parPassage = opts.passMax ?? m3.operationMatchCallsPerPass();
  const compter = (s: string) => { out.outcomes[s] = (out.outcomes[s] ?? 0) + 1; };
  const touchees = new Set<number>();
  /** Arbitrages RESOLVED de ce passage : valeur avant, à comparer après la reconsolidation. */
  const resolus: Array<{ id: number; operationId: number; field: ConflictField; role: string; fingerprint: string; before: string | null; value: string; claimed: boolean }> = [];

  // Lot 115 (#791, E09) : les reprises entrent dans le même cycle « appliquer puis VÉRIFIER » que les décisions du passage.
  for (const r of reprises) {
    resolus.push({
      id: r.id, operationId: r.operationId, field: r.field, role: r.role, fingerprint: r.fingerprint,
      before: await valueOf(x, accountId, r.operationId, r.field), value: r.value, claimed: true,
    });
    touchees.add(r.operationId);
  }
  if (reprises.length) out.resumed = reprises.length;

  // Carte #836 (E09) : escalade — la contradiction redevient visible et actionnable, et le constat est journalisé.
  for (const e of escalades) {
    touchees.add(e.operationId);
    console.warn(JSON.stringify({
      event: 't3.attribute_arbitration.application_escalated', accountId, operationId: e.operationId, reviewId: e.id,
      field: e.field, attempts: ATTRIBUTE_ARBITRATION_MAX_ATTEMPTS,
    }));
  }
  if (escalades.length) out.escalated = escalades.length;

  // Lot 115 (#791, E08) : la séparation a eu lieu (source partie) — les valeurs dérivées de l'événement sont
  // recalculées par la reconsolidation ciblée ci-dessous, et la propagation est celle du dépôt (événements
  // publiés après commit : Agenda, coût de possession, exports). Aucun détachement n'est décidé ici.
  for (const r of reparations) touchees.add(r.operationId);
  if (reparations.length) out.linkRepairs = reparations.length;

  const cap = await decider.capability();
  if (!cap.available && !demandes.length) {
    // Rien à demander : seules les reprises d'application sont traitées (elles n'appellent pas l'IA).
  } else if (!cap.available) {
    // Branche retirée (ou coupure) : demandes closes « indisponibles » — la contradiction réelle va à la carte.
    for (const d of demandes) {
      await complete(x, d.id, { status: 'UNAVAILABLE', reason: cap.reason, validation: { contractState: cap.contractState ?? null } });
      touchees.add(d.operationId);
      compter('UNAVAILABLE');
      out.processed++;
    }
    out.unavailable = cap.contractState ?? cap.reason;
  } else {
    const { emptyDocumentInventory, loadDocuments } = await import('../../semantic/load');
    for (const d of demandes) {
      const etat = await currentLine(x, accountId, d);
      if (!etat) {
        await complete(x, d.id, { status: 'OBSOLETE', reason: 'LINE_GONE' });
        touchees.add(d.operationId);
        compter('OBSOLETE');
        out.processed++;
        continue;
      }
      // Budget : plafonds existants du rapprochement sémantique — la demande reste en attente.
      if (out.aiCalls >= parPassage || (await callsLastDay(x, accountId)) >= parJour) { compter('DEFERRED_BUDGET'); break; }
      const fichiers = [...new Set(d.values.flatMap((v) => v.fileIds))];
      // Carte #836 (écart E02) : INVENTAIRE de la collecte (documents demandés / chargés / manquants,
      // unités documentaires et références comptées AVANT la sélection, fenêtres parcourues et en échec).
      // Les limites de coût ne changent pas ; ce qu'elles écartent est tracé, et la couverture est prouvée
      // ou refusée — jamais présumée.
      const inventaire = emptyDocumentInventory();
      const docs = await loadDocuments(pgClient, accountId, fichiers, inventaire);
      const somme = (m: Map<number, { total: number; kept: number }>) => [...m.values()]
        .reduce((a, v) => ({ total: a.total + v.total, kept: a.kept + v.kept }), { total: 0, kept: 0 });
      const b = contract.buildArbitrationInput({
        inventory: {
          documentsMissing: inventaire.missing.length, failedWindows: inventaire.failedWindows,
          units: somme(inventaire.units), references: somme(inventaire.references),
          ...(inventaire.unitsUnknown ? { unitsUnknown: true } : {}),
        },
        today: todayParis(now()), field: d.field, role: d.role, operation: { typeCode: etat.type, label: etat.label },
        values: d.values.map((v) => ({ value: v.value, normalized: v.normalized, fileIds: v.fileIds, held: etat.current !== null && v.value === etat.current, userProtected: v.userProtected })),
        documents: docs.map((doc) => ({ id: doc.id, type: doc.type, title: doc.title, date: doc.date, provider: doc.provider, references: doc.references, excerpts: doc.excerpts })),
      });
      // Lot 115 (#791, E02) : la COUVERTURE des preuves n'est pas prouvée (valeurs ou documents au-delà des
      // bornes, pièce non chargée, pagination rompue, source supprimée) → aucun appel, aucun verdict ; le
      // diagnostic est MAINTENU et la carte « À traiter » est posée. Un seul enregistrement, motif tracé.
      if (!b.scope.complete) {
        await complete(x, d.id, {
          status: 'INCOMPLETE', reason: `CONTEXT_INCOMPLETE:${b.scope.incomplete ?? 'BOUNDS'}`,
          validation: {
            complete: false, missing: b.scope.incomplete ?? 'BOUNDS', bounds: b.input.bounds,
            documents: fichiers.length, loaded: docs.length,
            // Carte #836 (écart E02) : l'inventaire est TRACÉ (omissions, versions, couverture) — aucune donnée du client.
            inventory: {
              requested: inventaire.requested.length, loaded: inventaire.loaded.length, missing: inventaire.missing.length,
              windows: inventaire.windows, failedWindows: inventaire.failedWindows,
              units: somme(inventaire.units), references: somme(inventaire.references),
              ...(inventaire.unitsUnknown ? { unitsUnknown: true } : {}),
            },
          },
        });
        touchees.add(d.operationId);
        compter('INCOMPLETE');
        out.processed++;
        continue;
      }
      await opts.beforeCall?.('T3 arbitrage d’une contradiction d’attribut — décision sémantique');
      out.aiCalls++;
      out.processed++;
      touchees.add(d.operationId);
      let answer: { output: unknown; traceId: string | null };
      try {
        answer = await decider.decide({ accountId, fileIds: Object.values(b.scope.documents).filter((f): f is number => f !== undefined), input: b.input });
      } catch (e) {
        const { isExecutionCancelled } = await import('@/services/ai/queue/execution-control');
        if (isExecutionCancelled(e)) throw e;
        // Panne IA : distincte de l'absence de preuve — nouvel essai borné, aucune modification spéculative.
        await complete(x, d.id, {
          status: 'AI_FAILED', reason: 'AI_CALL_FAILED', error: String((e as Error)?.message ?? e), deciderVersion: cap.version, called: true,
          retry: d.attempts + 1 < ATTRIBUTE_ARBITRATION_MAX_ATTEMPTS,
        });
        compter('AI_FAILED');
        continue;
      }
      const commun = { aiOutput: answer.output ?? null, deciderVersion: cap.version, traceId: answer.traceId, called: true };
      const v = contract.validateArbitration(answer.output, b.scope);
      if (!v.ok) {
        await complete(x, d.id, { ...commun, status: 'REJECTED', reason: `INVALID_DECISION:${v.problems[0]?.issue ?? 'SCHEMA'}`, validation: { valid: false, problems: v.problems } });
        compter('REJECTED');
        continue;
      }
      const dec = v.decision;
      const evidence = dec.evidence.map((e) => ({ document: e.document, fileId: b.scope.documents[e.document] ?? null, excerpt: e.excerpt }));
      const base = { ...commun, outcome: dec.outcome, confidence: dec.confidence, reason: dec.reason, evidence, validation: { valid: true, ignored: v.ignored } };
      if (v.ignored === 'ABSTAIN') {
        await complete(x, d.id, { ...base, status: 'ABSTAINED' });
        compter('ABSTAINED');
      } else if (v.ignored === 'NOT_CERTAIN' || !v.effect) {
        await complete(x, d.id, { ...base, status: 'NOT_CERTAIN' });
        compter('NOT_CERTAIN');
      } else if (v.effect.outcome === 'RESOLVED') {
        // Lot 115 (#791, E09) : décision REÇUE — « appliqué » ne sera écrit qu'après vérification de l'effet.
        await complete(x, d.id, { ...base, status: 'DECIDED', retainedValue: v.effect.value, retainedNormalized: v.effect.normalized, applicationState: 'RECEIVED' });
        resolus.push({
          id: d.id, operationId: d.operationId, field: d.field, role: d.role, fingerprint: d.fingerprint,
          before: etat.current, value: v.effect.value, claimed: false,
        });
        compter('DECIDED_RESOLVED');
      } else {
        const etranger = v.effect.outcome === 'LINK_ERROR' ? v.effect.foreignFileId : null;
        await complete(x, d.id, { ...base, status: 'DECIDED', foreignFileId: etranger });
        compter(`DECIDED_${v.effect.outcome}`);
        if (etranger !== null) {
          // Lot 115 (#791, E08) : le verdict est RENDU au moteur qui sait réparer — un doute de rattachement est
          // ouvert au journal 0609 et le candidat est remis en consolidation. La séparation reste décidée par le
          // réexamen existant, sur contradiction CERTAINE seulement : aucun détachement automatique ici.
          const { recordArbitrationLinkDoubt } = await import('../identity-review');
          const doute = await recordArbitrationLinkDoubt(x, accountId, {
            operationId: d.operationId, fileId: etranger, correlationId: 't3-attribute-arbitration',
            signals: ['T3_LINK_ERROR', `FIELD:${d.field}`, `ROLE:${d.role}`, `REVIEW:${d.id}`],
          });
          compter(`LINK_DOUBT_${doute}`);
        }
      }
      console.info(JSON.stringify({ event: 't3.attribute_arbitration', accountId, operationId: d.operationId, reviewId: d.id, outcome: dec.outcome, confidence: dec.confidence }));
    }
  }
  // Reconsolidation : valeur retenue écrite sous les protections, carte « À traiter » posée ou fermée.
  out.operations = [...touchees].sort((a, b) => a - b);
  if (out.operations.length) {
    const traceEtat = await arbitrationStateColumnsReady(x);
    // Lot 115 (#791, E09) : APPLICATION EN COURS, écrite AVANT la reconsolidation — une panne, un échec SQL ou
    // un arrêt laisse une trace durable, reprise (idempotente) au passage suivant, jamais un « appliqué » faux.
    // Carte #836 (E09) : les reprises ont DÉJÀ réservé leur ligne (`pendingApplications`) — seules les
    // décisions nouvelles de ce passage sont à marquer, et seulement si elles n'ont pas déjà abouti
    // (rejeu idempotent, concurrence entre workers).
    const aMarquer = resolus.filter((r) => !r.claimed).map((r) => r.id);
    if (traceEtat && aMarquer.length) {
      await x.execute(sql`
        UPDATE business_operation_attribute_arbitrations
           SET application_state = 'APPLYING', application_attempts = application_attempts + 1, updated_at = now()
         WHERE id = ANY(${intArray(aMarquer)}::bigint[]) AND applied_at IS NULL
           AND application_state IN ('RECEIVED', 'APPLYING', 'APPLY_FAILED')`);
    }
    const { reconsolidateOperations } = await import('../consolidator');
    await reconsolidateOperations(accountId, out.operations, { correlationId: 't3-attribute-arbitration' });
    // Lot 115 (#791, E08) : les valeurs dérivées ont été recalculées depuis les sources ACTIVES (la source
    // étrangère n'en est plus une) et la propagation est partie avec les événements publiés. La ligne porte sa
    // trace : elle n'est plus reprise (idempotent), et le BO lit QUAND la réparation a eu lieu.
    for (const r of reparations) {
      await x.execute(sql`
        UPDATE business_operation_attribute_arbitrations
           SET validation = COALESCE(validation, '{}'::jsonb) || ${JSON.stringify({
    linkRepair: { state: 'SOURCE_SEPARATED', derivedValuesRecomputed: true, foreignFileId: r.fileId, detached: false },
  })}::jsonb, updated_at = now()
         WHERE id = ${r.id} AND account_id = ${accountId}`);
    }
    for (const r of resolus) {
      // Carte #836 (E09) : application VÉRIFIÉE par un CONTRÔLE EN BASE complet (compte, événement actif,
      // champ, valeur, provenance, même fait et même période) — jamais déduite de la décision, et jamais
      // de la seule colonne. Les deux écritures de trace sont réunies en une (atomicité de l'état durable).
      const controle = await verifyApplication(x, accountId, r, r.value);
      const appliquee = controle.applied;
      // Le contrôle NOMME lui-même la cause — protection, source hors gestion, événement disparu, provenance
      // discordante, contradiction encore ouverte. Le repli n'est plus qu'une sécurité de typage.
      const motif = controle.reason ?? 'PROTECTED_OR_UNMANAGED_VALUE';
      if (appliquee && controle.value !== r.before) out.applied++;
      if (!appliquee) out.applyFailed = (out.applyFailed ?? 0) + 1;
      await x.execute(sql`
        UPDATE business_operation_attribute_arbitrations
           SET value_before = ${r.before}, value_after = ${controle.value},
               applied_at = CASE WHEN ${appliquee} THEN now() ELSE NULL END,
               validation = validation || ${JSON.stringify({ applied: appliquee, ...(appliquee ? {} : { notApplied: motif }) })}::jsonb,
               ${traceEtat ? sql`application_state = ${appliquee ? 'APPLIED' : 'APPLY_FAILED'},
                              application_error = ${appliquee ? null : motif},` : sql``}
               updated_at = now()
         WHERE id = ${r.id} AND account_id = ${accountId}`);
    }
  }
  return out;
}
