/**
 * T6 — décision d'interpellation, partie SERVEUR (lot 60).
 *
 * Lit, pour un compte et — s'il est connu — un utilisateur :
 *   · le seuil indicatif (BO › Configuration IA › réglages, « Mascotte
 *     d'accueil — T6 », sinon `MASCOT_T6_INTERPELLATION_THRESHOLD_DAYS`, 60) ;
 *   · les préférences de rappel de CET utilisateur (Duo : jamais celles de
 *     l'autre membre) ;
 *   · les dernières évaluations IA du compte ;
 *   · l'historique récent des présentations à cet utilisateur (anti-répétition) ;
 * puis applique `decideT6Interpellation` à chaque échéance candidate, AVANT la
 * composition de l'accueil. Toutes les lectures sont bornées au compte, et
 * chaque préférence ou évaluation est rejointe à une échéance DU compte.
 *
 * Une lecture en échec (table absente pendant le déploiement, base
 * indisponible) n'empêche jamais l'accueil : décision prudente. Lot 71G
 * (T6-06) : chaque source est lue ISOLÉMENT — une panne des évaluations
 * n'efface jamais les préférences, et des préférences illisibles ne sont
 * jamais prises pour une absence de refus (aucun sujet réintroduit).
 */
import { pgClient } from '@/db';
import type { MascotAgendaRow, MascotDecidedAgenda, MascotRawData } from './signals';
import { EXT_ACTION_LOOKBACK_DAYS, extActionOccurrenceKey, formatDateFr, roleOf } from './signals';
import { canonicalJson, sha256 } from './hash';
import { entriesFingerprint, serializeForHash, sha256 as reportSha256, type ReportEntry } from '@/services/ai/execution-report/model';
import {
  DEFAULT_T6_THRESHOLD_DAYS, T6_ASSESSMENT_CONTRACT, T6_ASSESSMENT_REVISION_REMINDER, T6_FINGERPRINT_V2, T6_MAX_ASSESSMENTS_PER_CALL,
  T6_RELEVANT_FACT_PATTERN, T6_REPEAT_WINDOW_DAYS,
  addDays, agendaFingerprintParts, agendaOccurrenceKey, agendaSubjectKey, assessmentFromDecision, assessmentHorizonDays, compareShown,
  daysBetween, decideT6Interpellation, evidenceSnapshotOf, isT6RelevantFact, preferenceAppliesToCycle, sameT6Context, suggestReminderDate,
  t6FingerprintParts,
  type T6Assessment, type T6Candidate, type T6CandidateRef, type T6DecisionResult, type T6EvidenceVersion, type T6InterpellationBundle,
  type T6ReevaluationReason, type T6ReminderPreference, type T6StoredAssessment,
} from './t6-interpellation';
import {
  T6_EVALUATION_INPUT_SCHEMA_VERSION,
  type T6EvaluationCandidate, type T6EvaluationFact, type T6EvidenceRef, type T6ValidatedDecision,
} from './t6-contract';

type Row = Record<string, unknown>;
const rows = async (sql: string, params: unknown[]): Promise<Row[]> =>
  (await pgClient.unsafe(sql, params as never[])) as unknown as Row[];

/**
 * Empreinte HISTORIQUE d'une échéance (lot 60 : titre, date, nature,
 * qualification). Lot 71G : conservée pour relire les évaluations et reports
 * antérieurs ; les nouvelles décisions portent l'empreinte enrichie
 * (`t6Fingerprint`).
 */
export function agendaFingerprint(p: { title: string; date: string | null; forecast: boolean; requiresQualification: boolean }): string {
  return sha256(agendaFingerprintParts(p)).slice(0, 32);
}

/** Lot 71G (T6-01) : empreinte ENRICHIE (`v2:`) — données métier et documentaires significatives. */
export function t6Fingerprint(p: Parameters<typeof t6FingerprintParts>[0]): string {
  return `${T6_FINGERPRINT_V2}${sha256(t6FingerprintParts(p)).slice(0, 32)}`;
}

// ── Preuves métier et documentaires (lot 71G : T6-01, T6-04) ─────────────────

/** Fait documentaire actif, pertinent pour T6, d'un document lié à l'échéance. */
export interface T6DocumentFact {
  id: number; fileId: number; extractionId: number; key: string; canonicalKey: string | null; label: string | null;
  value: string | null; confidence: string | null; provenance: string; excerpt: string | null;
}

/** Données d'une échéance utiles à la décision, au-delà du titre et de la date. */
export interface T6ItemEvidence {
  description: string | null;
  endDate: string | null;
  originFieldKey: string | null;
  /** Documents liés (lien agenda ou document d'origine), du compte, non supprimés. */
  documents: Array<{ fileId: number; title: string; origin: boolean }>;
  /** Faits pertinents (préavis, renouvellement, obligation…) de ces documents. */
  facts: T6DocumentFact[];
}

/** Faits lus au plus par passage (toutes échéances confondues). */
const T6_FACTS_READ_LIMIT = 4_000;

/**
 * Lit, pour des échéances DU compte, la description, la fin, les documents
 * liés et leurs faits PERTINENTS (T1, revalidés T2, consolidés T3 — version
 * active seulement). Tout est borné au compte : document et fait d'un autre
 * compte jamais lus. Lève en cas d'échec (l'appelant décide du repli).
 */
export async function loadT6Evidence(accountId: number, ids: readonly number[]): Promise<Map<number, T6ItemEvidence>> {
  const out = new Map<number, T6ItemEvidence>();
  if (ids.length === 0) return out;
  const items = await rows(
    `SELECT i.id, i.description, to_char(i.end_date, 'YYYY-MM-DD') AS end_date, i.origin_field_key
       FROM agenda_items i WHERE i.account_id = $1 AND i.id = ANY($2::int[])`,
    [accountId, ids],
  );
  for (const x of items) {
    out.set(Number(x.id), {
      description: typeof x.description === 'string' ? x.description : null,
      endDate: (x.end_date as string | null) ?? null,
      originFieldKey: (x.origin_field_key as string | null) ?? null,
      documents: [], facts: [],
    });
  }
  const docs = await rows(
    `SELECT d.agenda_item_id, f.id AS file_id, bool_or(d.origin) AS origin,
            COALESCE(NULLIF(f.retained_title, ''), NULLIF(f.original_filename, ''), f.filename) AS title
       FROM (SELECT l.agenda_item_id, l.asset_file_id AS file_id, FALSE AS origin
               FROM agenda_file_links l JOIN agenda_items i ON i.id = l.agenda_item_id AND i.account_id = $1
              WHERE l.agenda_item_id = ANY($2::int[])
             UNION ALL
             SELECT i.id, i.origin_ref_id, TRUE FROM agenda_items i
              WHERE i.account_id = $1 AND i.id = ANY($2::int[]) AND i.origin_ref_type = 'asset_file' AND i.origin_ref_id IS NOT NULL) d
       JOIN asset_files f ON f.id = d.file_id AND f.account_id = $1 AND f.deleted_at IS NULL
      GROUP BY d.agenda_item_id, f.id, title`,
    [accountId, ids],
  );
  const fichiers = new Set<number>();
  for (const x of docs) {
    const e = out.get(Number(x.agenda_item_id));
    if (!e) continue;
    e.documents.push({ fileId: Number(x.file_id), title: String(x.title ?? 'Document').slice(0, 120), origin: x.origin === true });
    fichiers.add(Number(x.file_id));
  }
  if (fichiers.size === 0) return out;
  const faits = await rows(
    `SELECT x.id, x.file_id, x.extraction_id, x.fact_key, x.canonical_key, x.label,
            left(COALESCE(NULLIF(x.normalized_value, ''), NULLIF(x.value_text, ''), x.value_number::text, x.value_json::text), 200) AS value,
            x.confidence, x.provenance, left(x.excerpt, 400) AS excerpt
       FROM document_facts x
      WHERE x.account_id = $1 AND x.status = 'active' AND x.file_id = ANY($2::int[])
        AND (coalesce(x.canonical_key, '') || ' ' || x.fact_key || ' ' || coalesce(x.label, '')) ~* $3
      ORDER BY x.file_id, x.id
      LIMIT ${T6_FACTS_READ_LIMIT}`,
    [accountId, [...fichiers], T6_RELEVANT_FACT_PATTERN],
  );
  const parFichier = new Map<number, T6DocumentFact[]>();
  for (const x of faits) {
    const f: T6DocumentFact = {
      id: Number(x.id), fileId: Number(x.file_id), extractionId: Number(x.extraction_id), key: String(x.fact_key),
      canonicalKey: (x.canonical_key as string | null) ?? null, label: (x.label as string | null) ?? null,
      value: (x.value as string | null) ?? null, confidence: (x.confidence as string | null) ?? null,
      provenance: String(x.provenance ?? 'T1_EXTRACTION'), excerpt: (x.excerpt as string | null) ?? null,
    };
    if (!isT6RelevantFact(f)) continue;
    const l = parFichier.get(f.fileId) ?? [];
    l.push(f);
    parFichier.set(f.fileId, l);
  }
  for (const e of out.values()) e.facts = e.documents.flatMap((d) => parFichier.get(d.fileId) ?? []);
  return out;
}

/** Empreinte enrichie d'une échéance à partir de sa ligne et de ses preuves (pure). */
export function fingerprintWithEvidence(
  i: { title: string; date: string | null; forecast: boolean; requiresQualification: boolean }, e: T6ItemEvidence | undefined,
): string {
  return t6Fingerprint({
    ...i, description: e?.description ?? null, endDate: e?.endDate ?? null,
    documents: (e?.documents ?? []).map((d) => ({ fileId: d.fileId, title: d.title })),
    facts: (e?.facts ?? []).map((f) => ({ fileId: f.fileId, key: f.canonicalKey ?? f.key, value: f.value, confidence: f.confidence })),
  });
}

/**
 * Lot 71G — empreintes enrichies COURANTES d'échéances du compte (même calcul
 * que la décision) : reports de l'utilisateur, harnais de test. Lève en cas
 * d'échec.
 */
export async function currentT6Fingerprints(accountId: number, ids: readonly number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (ids.length === 0) return out;
  const [base, ev] = await Promise.all([
    rows(
      `SELECT id, title, to_char(start_date, 'YYYY-MM-DD') AS date, occurrence_nature, requires_qualification
         FROM agenda_items WHERE account_id = $1 AND id = ANY($2::int[])`,
      [accountId, ids],
    ),
    loadT6Evidence(accountId, ids),
  ]);
  for (const x of base) {
    const id = Number(x.id);
    out.set(id, fingerprintWithEvidence({
      title: String(x.title ?? ''), date: (x.date as string | null) ?? null, forecast: x.occurrence_nature === 'FORECAST',
      requiresQualification: x.requires_qualification === true,
    }, ev.get(id)));
  }
  return out;
}

const STATUT_FAIT: Record<string, T6EvaluationFact['status']> = { certain: 'PROVEN', probable: 'DEDUCED', conflictual: 'UNCERTAIN' };
const RANG_CONFIANCE: Record<string, number> = { certain: 0, probable: 1, conflictual: 2 };
/** Faits transmis à EVALUATE par candidat, au plus. */
export const T6_MAX_FACTS_PER_CANDIDATE = 8;
/** Documents (intitulés) transmis à EVALUATE par candidat, au plus. */
export const T6_MAX_DOCUMENTS_PER_CANDIDATE = 5;

/**
 * Lot 71G (T6-04) — preuves transmises à EVALUATE pour UN candidat (pure,
 * testée) : faits pertinents choisis par pertinence métier (clé de
 * l'échéance d'origine, puis confiance, puis document d'origine), avec leur
 * extrait, leur document source, leur provenance et leur statut (prouvé,
 * déduit, incertain) ; documents choisis de même (ceux des faits, l'origine,
 * puis les autres) — jamais les trois premiers titres arbitraires. Rend
 * aussi la version de chaque preuve (reporting, `evidence_snapshot`).
 */
export function evaluationEvidenceOf(subjectId: string, e: T6ItemEvidence | undefined): {
  documents: string[]; facts: T6EvaluationFact[]; refs: T6EvidenceRef[]; versions: Map<string, T6EvidenceVersion>;
} {
  const versions = new Map<string, T6EvidenceVersion>();
  if (!e) return { documents: [], facts: [], refs: [], versions };
  const origine = new Set(e.documents.filter((d) => d.origin).map((d) => d.fileId));
  const cleOrigine = e.originFieldKey;
  const faits = [...e.facts].sort((a, b) =>
    Number(!(cleOrigine && (a.key === cleOrigine || a.canonicalKey === cleOrigine))) - Number(!(cleOrigine && (b.key === cleOrigine || b.canonicalKey === cleOrigine)))
    || (RANG_CONFIANCE[a.confidence ?? ''] ?? 3) - (RANG_CONFIANCE[b.confidence ?? ''] ?? 3)
    || Number(!origine.has(a.fileId)) - Number(!origine.has(b.fileId))
    || a.id - b.id).slice(0, T6_MAX_FACTS_PER_CANDIDATE);
  const ordreDocs: number[] = [];
  const ajouter = (id: number) => { if (!ordreDocs.includes(id)) ordreDocs.push(id); };
  faits.forEach((f) => ajouter(f.fileId));
  e.documents.filter((d) => d.origin).forEach((d) => ajouter(d.fileId));
  [...e.documents].sort((a, b) => a.title.localeCompare(b.title, 'fr') || a.fileId - b.fileId).forEach((d) => ajouter(d.fileId));
  const retenus = ordreDocs.slice(0, T6_MAX_DOCUMENTS_PER_CANDIDATE);
  const docRef = new Map<number, string>();
  const refs: T6EvidenceRef[] = [];
  const documents = retenus.map((fileId, n) => {
    const ref = `${subjectId}.doc${n + 1}`;
    docRef.set(fileId, ref);
    refs.push({ ref, kind: 'DOCUMENT' });
    versions.set(ref, { ref, kind: 'DOCUMENT', fileId });
    return e.documents.find((d) => d.fileId === fileId)!.title;
  });
  const facts: T6EvaluationFact[] = faits.map((f, n) => {
    const ref = `${subjectId}.fact${n + 1}`;
    refs.push({ ref, kind: 'DOCUMENT_FACT' });
    versions.set(ref, { ref, kind: 'DOCUMENT_FACT', fileId: f.fileId, extractionId: f.extractionId, factId: f.id, factKey: f.canonicalKey ?? f.key, provenance: f.provenance });
    const texte = (v: string | null, max: number) => (v ? v.replace(/\s+/g, ' ').trim().slice(0, max) || null : null);
    return {
      ref, document: docRef.get(f.fileId) ?? null, label: texte(f.label, 120) ?? f.key.slice(0, 80), value: texte(f.value, 160),
      excerpt: texte(f.excerpt, 300), status: STATUT_FAIT[f.confidence ?? ''] ?? 'UNCERTAIN', provenance: f.provenance.slice(0, 40),
    };
  });
  return { documents, facts, refs, versions };
}

// ── Réglage ──────────────────────────────────────────────────────────────────

/** Seuil indicatif effectif (BO > environnement > 60). Ne lève jamais. */
export async function t6ThresholdDays(): Promise<number> {
  try {
    const m = await import('@/services/verebona-assistant/config/assistant-settings');
    await m.refreshAssistantSettings();
    const v = Number(m.effectiveSetting('t6_interpellation_threshold_days'));
    return Number.isInteger(v) && v > 0 ? v : DEFAULT_T6_THRESHOLD_DAYS;
  } catch {
    return DEFAULT_T6_THRESHOLD_DAYS;
  }
}

// ── Lectures ─────────────────────────────────────────────────────────────────

/** Préférences de rappel de l'utilisateur, rattachées à une échéance du compte (ou à une série). */
export async function loadUserPreferences(accountId: number, userId: number): Promise<T6ReminderPreference[]> {
  const r = await rows(
    `SELECT p.scope, p.decision, to_char(p.remind_at, 'YYYY-MM-DD') AS remind_at, p.context_fingerprint,
            p.agenda_item_id, p.series_key, p.updated_at,
            -- Lot 71G (0507) : lue sans dépendre de la colonne (fenêtre de déploiement).
            to_jsonb(p) ->> 'occurrence_date' AS occurrence_date
       FROM t6_reminder_preferences p
      WHERE p.account_id = $1 AND p.user_id = $2
        AND (p.agenda_item_id IS NULL
             OR EXISTS (SELECT 1 FROM agenda_items i WHERE i.id = p.agenda_item_id AND i.account_id = p.account_id))
      LIMIT 2000`,
    [accountId, userId],
  );
  return r.map((x) => ({
    scope: x.scope === 'SERIES' ? 'SERIES' : 'OCCURRENCE',
    decision: x.decision === 'DISMISSED' ? 'DISMISSED' : 'SNOOZED',
    remindAt: (x.remind_at as string | null) ?? null,
    contextFingerprint: (x.context_fingerprint as string | null) ?? null,
    agendaItemId: x.agenda_item_id == null ? null : Number(x.agenda_item_id),
    seriesKey: (x.series_key as string | null) ?? null,
    updatedAt: x.updated_at ? new Date(String(x.updated_at)).toISOString() : null,
    occurrenceDate: typeof x.occurrence_date === 'string' ? x.occurrence_date.slice(0, 10) : null,
  }));
}

/**
 * Préférences applicables à une échéance : son occurrence, et sa série.
 * Lot 71G (T6-07) : une préférence d'occurrence posée sur un cycle
 * précédent (identifiant réutilisé par T4 pour le renouvellement) ne
 * s'applique pas au nouveau cycle ; une replanification la conserve.
 */
export function preferencesFor(prefs: readonly T6ReminderPreference[], agendaItemId: number, seriesKey: string | null, dueDate: string | null = null): T6ReminderPreference[] {
  return prefs.filter((p) => (p.scope === 'OCCURRENCE' && p.agendaItemId === agendaItemId && preferenceAppliesToCycle(p, dueDate))
    || (p.scope === 'SERIES' && seriesKey != null && p.seriesKey === seriesKey));
}

export async function loadAssessments(accountId: number, agendaIds: number[]): Promise<Map<number, T6StoredAssessment>> {
  const out = new Map<number, T6StoredAssessment>();
  if (agendaIds.length === 0) return out;
  const r = await rows(
    `SELECT a.id, a.agenda_item_id, a.context_fingerprint, to_char(a.assessed_on, 'YYYY-MM-DD') AS assessed_on,
            a.interpellation, a.action_needed, a.priority, to_char(a.action_date, 'YYYY-MM-DD') AS action_date,
            to_char(a.reevaluate_on, 'YYYY-MM-DD') AS reevaluate_on, a.reason, a.action, a.consequence, a.uncertainty,
            a.exception_reason, a.prompt_version, a.trace_id,
            a.contract_version, a.decision, a.category, a.reason_code, a.evidence_refs, a.uncertainties,
            to_jsonb(a) -> 'contract_revision' AS contract_revision,
            -- Lot 71G (0507) : lues sans dépendre des colonnes.
            to_jsonb(a) -> 'evidence_snapshot' AS evidence_snapshot, to_jsonb(a) ->> 'reevaluation_reason' AS reevaluation_reason
       FROM t6_interpellation_assessments a
       JOIN agenda_items i ON i.id = a.agenda_item_id AND i.account_id = a.account_id
      WHERE a.account_id = $1 AND a.agenda_item_id = ANY($2::int[])`,
    [accountId, agendaIds],
  );
  for (const x of r) {
    out.set(Number(x.agenda_item_id), {
      id: Number(x.id),
      fingerprint: String(x.context_fingerprint),
      assessedOn: String(x.assessed_on),
      interpellation: x.interpellation as T6Assessment['interpellation'],
      actionNeeded: x.action_needed === true,
      priority: x.priority as T6Assessment['priority'],
      actionDate: (x.action_date as string | null) ?? null,
      reevaluateOn: (x.reevaluate_on as string | null) ?? null,
      reason: String(x.reason ?? ''),
      action: (x.action as string | null) ?? null,
      consequence: (x.consequence as string | null) ?? null,
      uncertainty: (x.uncertainty as string | null) ?? null,
      exceptionReason: (x.exception_reason as string | null) ?? null,
      promptVersion: (x.prompt_version as string | null) ?? null,
      traceId: (x.trace_id as string | null) ?? null,
      // Lot 61 (migration 0447) : contrat `t6-evaluation-v1`.
      contractVersion: (x.contract_version as string | null) ?? null,
      decision: (x.decision as T6Assessment['decision']) ?? undefined,
      category: (x.category as T6Assessment['category']) ?? undefined,
      reasonCode: (x.reason_code as string | null) ?? null,
      evidenceRefs: Array.isArray(x.evidence_refs) ? (x.evidence_refs as string[]) : [],
      uncertainties: Array.isArray(x.uncertainties) ? (x.uncertainties as string[]) : [],
      // Lot 68 (migration 0474) : lue sans dépendre de la colonne (déploiement avant migration : révision 1).
      contractRevision: x.contract_revision == null ? 1 : Number(x.contract_revision),
      evidenceSnapshot: x.evidence_snapshot && typeof x.evidence_snapshot === 'object' ? x.evidence_snapshot as T6StoredAssessment['evidenceSnapshot'] : null,
      reevaluationReason: (x.reevaluation_reason as string | null) ?? null,
    });
  }
  return out;
}

/** Clés d'occurrence possibles d'une échéance dans la télémétrie de la mascotte. */
const telemetryKeys = (id: number) => [`DATE-NEXT:${id}`, extActionOccurrenceKey(id), `MASC-BLOCKED:agenda:${id}`];

/**
 * Jours DISTINCTS où l'échéance a été présentée à cet utilisateur
 * (télémétrie « affiché »), dans la fenêtre d'anti-répétition et depuis la
 * dernière évaluation (même contexte). Par échéance.
 */
export async function loadDisplayHistory(
  accountId: number, userId: number, since: ReadonlyMap<number, string>, today: string,
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (since.size === 0) return out;
  const cles = [...since.keys()].flatMap(telemetryKeys);
  const r = await rows(
    `SELECT occurrence_key, array_agg(DISTINCT to_char(created_at AT TIME ZONE 'Europe/Paris', 'YYYY-MM-DD')) AS jours
       FROM home_mascot_events
      WHERE account_id = $1 AND user_id = $2 AND event_type = 'displayed' AND occurrence_key = ANY($3::text[])
        AND created_at > ($4::date - $5::int)
      GROUP BY occurrence_key`,
    [accountId, userId, cles, today, T6_REPEAT_WINDOW_DAYS],
  );
  const parId = new Map<number, Set<string>>();
  for (const x of r) {
    const m = /(\d+)$/.exec(String(x.occurrence_key));
    if (!m) continue;
    const id = Number(m[1]);
    const depuis = since.get(id);
    if (!depuis) continue;
    const s = parId.get(id) ?? new Set<string>();
    for (const j of (x.jours as string[] | null) ?? []) if (j >= depuis) s.add(j);
    parId.set(id, s);
  }
  for (const [id, s] of parId) out.set(id, s.size);
  return out;
}

/**
 * Lot 71G (T6-05) — reports arrivés à leur date, tous utilisateurs du compte
 * confondus : échéance → date de rappel la plus récente déjà atteinte. La
 * pré-génération du compte réévalue ces sujets AVANT toute réapparition,
 * sans attendre une visite (aucune préférence n'est lue pour l'affichage).
 */
export async function loadDueReminders(accountId: number, today: string): Promise<Map<number, string>> {
  const r = await rows(
    `SELECT p.agenda_item_id, to_char(max(p.remind_at), 'YYYY-MM-DD') AS remind_at
       FROM t6_reminder_preferences p JOIN agenda_items i ON i.id = p.agenda_item_id AND i.account_id = p.account_id
      WHERE p.account_id = $1 AND p.decision = 'SNOOZED' AND p.remind_at <= $2::date
      GROUP BY p.agenda_item_id`,
    [accountId, today],
  );
  return new Map(r.map((x) => [Number(x.agenda_item_id), String(x.remind_at)]));
}

/**
 * Enregistre les décisions EVALUATE validées (lot 61, contrat
 * `t6-evaluation-v1`) : une ligne par échéance, la plus récente l'emporte —
 * `t6_interpellation_assessments` sert de CACHE des évaluations valides
 * (réutilisées tant que l'échéance ne change pas de façon significative).
 * L'échéance est revérifiée DANS le compte : jamais une évaluation rattachée
 * à l'échéance d'un autre compte. Aucune préférence de rappel n'est écrite
 * (`suggestedReviewAt` reste une réévaluation système).
 */
export async function persistT6Assessments(
  accountId: number, today: string,
  refs: T6InterpellationBundle['refs'],
  list: readonly T6ValidatedDecision[],
  meta: { promptVersion: string; traceId: string | null; contractRevision?: number },
): Promise<number> {
  let n = 0;
  // Lot 68 : révision 2 seulement si la version du prompt qui a évalué connaît
  // le rappel informatif (sinon l'évaluation sera renouvelée après activation).
  const revision = meta.contractRevision === T6_ASSESSMENT_REVISION_REMINDER ? T6_ASSESSMENT_REVISION_REMINDER : 1;
  const avecRevision = await hasContractRevision();
  // Lot 71G (0507) : instantané des preuves citées et motif de la réévaluation.
  const avecPreuves = await hasEvidenceSnapshot();
  for (const d of list) {
    const c = refs.get(d.subjectId);
    if (!c) continue;
    const a = assessmentFromDecision(d);
    const extra = avecPreuves
      ? [JSON.stringify(evidenceSnapshotOf(d.evidenceRefs, c.evidenceVersions, c.fingerprint)), c.reevaluationReason ?? null]
      : [];
    // Paramètres facultatifs après les 23 du contrat : preuves (0507), puis révision (0474).
    const rev = avecPreuves ? 26 : 24;
    const r = await rows(
      `INSERT INTO t6_interpellation_assessments
         (account_id, agenda_item_id, subject_key, context_fingerprint, assessed_on, interpellation, action_needed, priority,
          action_date, reevaluate_on, reason, action, consequence, uncertainty, exception_reason, prompt_version, trace_id,
          contract_version, decision, category, reason_code, evidence_refs, uncertainties${avecPreuves ? ', evidence_snapshot, reevaluation_reason' : ''}${avecRevision ? ', contract_revision' : ''})
       SELECT $1, i.id, $3, $4, $5::date, $6, $7, $8, $9::date, $10::date, $11, $12, $13, $14, $15, $16, $17,
              $18, $19, $20, $21, $22::jsonb, $23::jsonb${avecPreuves ? ', $24::jsonb, $25' : ''}${avecRevision ? `, $${rev}::smallint` : ''}
         FROM agenda_items i WHERE i.id = $2 AND i.account_id = $1
       ON CONFLICT (account_id, subject_key) DO UPDATE SET
         agenda_item_id = EXCLUDED.agenda_item_id, context_fingerprint = EXCLUDED.context_fingerprint,
         assessed_on = EXCLUDED.assessed_on, interpellation = EXCLUDED.interpellation, action_needed = EXCLUDED.action_needed,
         priority = EXCLUDED.priority, action_date = EXCLUDED.action_date, reevaluate_on = EXCLUDED.reevaluate_on,
         reason = EXCLUDED.reason, action = EXCLUDED.action, consequence = EXCLUDED.consequence,
         uncertainty = EXCLUDED.uncertainty, exception_reason = EXCLUDED.exception_reason,
         prompt_version = EXCLUDED.prompt_version, trace_id = EXCLUDED.trace_id,
         contract_version = EXCLUDED.contract_version, decision = EXCLUDED.decision, category = EXCLUDED.category,
         reason_code = EXCLUDED.reason_code, evidence_refs = EXCLUDED.evidence_refs, uncertainties = EXCLUDED.uncertainties,
         ${avecRevision ? 'contract_revision = EXCLUDED.contract_revision,' : ''}
         ${avecPreuves ? 'evidence_snapshot = EXCLUDED.evidence_snapshot, reevaluation_reason = EXCLUDED.reevaluation_reason,' : ''}
         updated_at = now()
       RETURNING id`,
      [accountId, c.agendaItemId, c.subjectKey, c.fingerprint, today, a.interpellation, a.actionNeeded, a.priority,
        a.actionDate, a.reevaluateOn, a.reason, a.action, a.consequence, a.uncertainty, a.exceptionReason,
        meta.promptVersion, meta.traceId,
        T6_ASSESSMENT_CONTRACT, d.decision, d.category, d.reasonCode, JSON.stringify(d.evidenceRefs), JSON.stringify(d.uncertainties),
        ...extra, ...(avecRevision ? [revision] : [])],
    );
    n += r.length;
  }
  return n;
}

/**
 * Lot 68 : la colonne `contract_revision` (migration 0474) existe-t-elle ?
 * Lue une fois par processus ; en échec ou absente (fenêtre de déploiement),
 * l'enregistrement se fait sans elle — jamais de décision perdue.
 */
let revisionColumn: Promise<boolean> | null = null;
export function hasContractRevision(): Promise<boolean> {
  revisionColumn ??= rows(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 't6_interpellation_assessments' AND column_name = 'contract_revision' LIMIT 1`, [],
  ).then((r) => r.length > 0).catch(() => { revisionColumn = null; return false; });
  return revisionColumn;
}
/** Réservé aux tests. */
export function resetContractRevisionProbe(): void { revisionColumn = null; snapshotColumn = null; }

/** Lot 71G : colonnes `evidence_snapshot` / `reevaluation_reason` (0507) présentes ? Même principe. */
let snapshotColumn: Promise<boolean> | null = null;
export function hasEvidenceSnapshot(): Promise<boolean> {
  snapshotColumn ??= rows(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 't6_interpellation_assessments' AND column_name = 'reevaluation_reason' LIMIT 1`, [],
  ).then((r) => r.length > 0).catch(() => { snapshotColumn = null; return false; });
  return snapshotColumn;
}

// ── Candidats ────────────────────────────────────────────────────────────────

/** Échéances déjà portées par une action « À traiter » (ATP-004). */
function agendaInToProcess(raw: MascotRawData): Set<number> {
  const ids = new Set((raw.toProcess ?? []).filter((a) => a.targetType === 'AGENDA_ITEM').map((a) => a.targetId));
  (raw.toProcessAgendaIds ?? []).forEach((id) => ids.add(id));
  return ids;
}

export interface T6CandidateRow { candidate: T6Candidate; row: MascotAgendaRow }

/**
 * Échéances candidates (pur) : à venir (hors « à préciser ») et arrivées à
 * date depuis moins de 60 jours (hors prévisions) — mêmes sources et mêmes
 * exclusions que le chemin historique, une échéance = un candidat.
 * Lot 71G : plus les échéances lues pour T6 seulement (`raw.t6Agenda`) — au-
 * delà des 200 premières, ou dépassées depuis plus de 60 jours avec une
 * action identifiable (T6-02 : jamais la seule ancienneté, dans un sens ou
 * dans l'autre). L'empreinte rendue ici est l'empreinte historique ; la
 * préparation la remplace par l'empreinte enrichie.
 */
export function t6Candidates(raw: MascotRawData): T6CandidateRow[] {
  const exclues = agendaInToProcess(raw);
  const acquittes = new Set((raw.acknowledgments ?? []).map((a) => `${a.occurrenceKey}|${a.cycleKey}`));
  // Lot 61 : échéance passée réglée par « À traiter » (aucune intervention attendue, ou tranchée).
  const regles = new Set(raw.toProcessSettledAgendaIds ?? []);
  const out: T6CandidateRow[] = [];
  const vus = new Set<number>();
  for (const i of [...(raw.agenda ?? []), ...(raw.t6Agenda ?? [])]) {
    if (!i.date || exclues.has(i.id) || vus.has(i.id)) continue;
    vus.add(i.id);
    const future = i.date > raw.today;
    if (future && i.requiresQualification) continue;
    if (!future && (i.forecast || (daysBetween(i.date, raw.today) > EXT_ACTION_LOOKBACK_DAYS && !i.t6LongOverdue))) continue;
    // « C'est fait » déclaré pour ce cycle : le sujet est résolu.
    const fait = !future && !i.requiresQualification
      && (acquittes.has(`${extActionOccurrenceKey(i.id)}|${i.date}`) || regles.has(i.id));
    out.push({
      row: i,
      candidate: {
        subjectKey: agendaSubjectKey(i.id), agendaItemId: i.id, occurrenceKey: agendaOccurrenceKey(i.id, i.date),
        seriesKey: i.seriesKey ?? null, accountId: raw.accountId, assetId: i.assetId, dueDate: i.date,
        state: fait ? 'RESOLVED' : 'ACTIVE', requiresQualification: i.requiresQualification,
        fingerprint: agendaFingerprint({ title: i.title, date: i.date, forecast: i.forecast, requiresQualification: i.requiresQualification }),
        legacyFingerprint: agendaFingerprint({ title: i.title, date: i.date, forecast: i.forecast, requiresQualification: i.requiresQualification }),
      },
    });
  }
  return out;
}

// ── Préparation (décision de toutes les échéances candidates) ───────────────

export interface T6DecisionTrace extends T6DecisionResult {
  agendaItemId: number;
  dueDate: string | null;
  seriesKey: string | null;
  assessment: T6StoredAssessment | null;
  displayedDays: number;
  /** Lot 71G : empreinte du contexte courant (reporting, sans donnée personnelle). */
  fingerprint?: string;
}

export interface T6Preparation {
  thresholdDays: number;
  aiCapable: boolean;
  /** Échéances à présenter, dans l'ordre (priorité, puis date). */
  shown: MascotDecidedAgenda[];
  decisions: T6DecisionTrace[];
  /** Échéances écartées ou différées (texte libre : jamais réintroduites). */
  notInterpellated: Set<number>;
  /** Échéances que l'utilisateur a reportées ou refusées (questions suggérées : retirées). */
  userSilenced: Set<number>;
  /**
   * Lot 61 : échéances ÉCARTÉES après évaluation (décision IA validée non
   * retenue, ou préférence de l'utilisateur) — jamais réintroduites par une
   * question suggérée. Une échéance jamais évaluée (au-delà de l'horizon)
   * reste consultable : seule une question de consultation peut la citer.
   */
  discarded: Set<number>;
  /** Candidats à faire évaluer par T6 (MODE=EVALUATE, lot 61), ou null. */
  bundle: T6InterpellationBundle | null;
  /** Une lecture a échoué : décision prudente (lot 71G : source par source, `failedSources`). */
  degraded: boolean;
  /**
   * Lot 71G (T6-06) : sources illisibles — `preferences` (aucun sujet
   * réintroduit), `assessments` (dégradation sans IA), `evidence` (aucune
   * réévaluation sur un contexte incomplet), `history`, `dueReminders`.
   */
  failedSources: string[];
  /**
   * Lot 71G (T6-03) : candidats à évaluer restés hors de ce passage (plafond
   * de 8 par appel) — repris par une nouvelle pré-génération durable.
   */
  pendingAssessments: number;
  /**
   * Lot 61 — état de l'évaluation pour la présentation : `PENDING`, une
   * échéance proche (dans le seuil) attend son évaluation ; `UNAVAILABLE`,
   * une échéance proche n'a pas pu être évaluée (T6 coupé, version BO sans
   * EVALUATE, lectures en échec) ; `OK` sinon. Jamais « rien à signaler »
   * tant qu'une échéance proche n'a pas été examinée.
   */
  evaluation: T6EvaluationState;
}

export type T6EvaluationState = 'OK' | 'PENDING' | 'UNAVAILABLE';

/** Codes d'une échéance proche en attente d'évaluation. */
const EN_ATTENTE = new Set(['AI_ASSESSMENT_PENDING', 'AWAITING_REEVALUATION_AFTER_SNOOZE']);
/** Lot 71G : codes d'une décision PROVISOIRE (non évaluée, indisponible) — jamais une décision métier définitive. */
export const T6_PROVISIONAL_CODES: ReadonlySet<string> = new Set([...EN_ATTENTE, 'EVALUATION_UNAVAILABLE', 'PREFERENCES_UNAVAILABLE']);

/** État de l'évaluation des échéances proches (pure, testée T6-EV). */
export function evaluationStateOf(decisions: readonly T6DecisionResult[], opts: { degraded?: boolean; recentFailure?: boolean } = {}): T6EvaluationState {
  const proches = decisions.filter((d) => !d.thresholdApplied);
  if (proches.some((d) => d.code === 'EVALUATION_UNAVAILABLE')) return 'UNAVAILABLE';
  // Lot 71G (T6-06) : préférences illisibles — jamais « rien à signaler ».
  if (decisions.some((d) => d.code === 'PREFERENCES_UNAVAILABLE')) return 'UNAVAILABLE';
  if (proches.some((d) => EN_ATTENTE.has(d.code))) return opts.recentFailure || opts.degraded ? 'UNAVAILABLE' : 'PENDING';
  return 'OK';
}

export interface PrepareDeps {
  aiCapable: () => Promise<boolean>;
  /** Lot 68 : le prompt effectif connaît le rappel informatif (renouvellement ciblé des évaluations). */
  reminderCapable?: () => Promise<boolean>;
  thresholdDays: () => Promise<number>;
  /** Lot 61 : une évaluation EVALUATE de ce compte a échoué récemment (mode dégradé). */
  recentEvaluationFailure?: (accountId: number) => boolean;
  /** Après enregistrement d'évaluations (ex. : pré-génération de l'accueil). */
  onAssessed?: (count: number) => void;
  /** Lot 71G : lectures injectables (tests de panne T6-06) ; défaut : base. */
  loaders?: Partial<T6Loaders>;
}

/** Lot 71G : sources lues par la préparation, chacune isolément. */
export interface T6Loaders {
  preferences: (accountId: number, userId: number) => Promise<T6ReminderPreference[]>;
  assessments: (accountId: number, agendaIds: number[]) => Promise<Map<number, T6StoredAssessment>>;
  evidence: (accountId: number, agendaIds: number[]) => Promise<Map<number, T6ItemEvidence>>;
  dueReminders: (accountId: number, today: string) => Promise<Map<number, string>>;
}

const DEFAULT_LOADERS: T6Loaders = {
  preferences: loadUserPreferences, assessments: loadAssessments, evidence: loadT6Evidence, dueReminders: loadDueReminders,
};

/** Rang de priorité d'un candidat à évaluer (pure, T6-03) : report échu, proche, documenté, autre. */
function rangEvaluation(d: T6DecisionTrace, thresholdDays: number, documente: boolean): number {
  if (d.reevaluationReason === 'SNOOZE_DUE') return 0;
  if (d.daysUntilDue != null && d.daysUntilDue <= thresholdDays) return 1;
  if (documente) return 2;
  return 3;
}

/**
 * Décide, pour chaque échéance candidate du compte, s'il faut l'afficher,
 * la différer ou l'écarter — pour CET utilisateur (`userId` null :
 * pré-génération du compte, sans préférence personnelle).
 */
export async function prepareT6Interpellation(
  p: { accountId: number; userId: number | null; raw: MascotRawData },
  deps: PrepareDeps,
): Promise<T6Preparation> {
  const today = p.raw.today;
  const L: T6Loaders = { ...DEFAULT_LOADERS, ...deps.loaders };
  const candidats = t6Candidates(p.raw);
  const ids = candidats.map((c) => c.candidate.agendaItemId);
  const echecs: string[] = [];
  // Lot 71G (T6-06) : chaque source isolément — une panne n'en vide jamais une autre.
  const lire = async <T>(nom: string, f: () => Promise<T>, defaut: T): Promise<{ ok: boolean; v: T }> => {
    try {
      return { ok: true, v: await f() };
    } catch (e) {
      console.error(`[mascotte] décision T6 : source « ${nom} » indisponible —`, (e as Error).message);
      echecs.push(nom);
      return { ok: false, v: defaut };
    }
  };
  const [thresholdDays, aiCapableBrut, reminderCapable, prefsR, evalsR, preuvesR, echusR] = await Promise.all([
    deps.thresholdDays().catch(() => DEFAULT_T6_THRESHOLD_DAYS),
    deps.aiCapable().catch(() => false),
    deps.reminderCapable ? deps.reminderCapable().catch(() => false) : Promise.resolve(false),
    p.userId != null ? lire('preferences', () => L.preferences(p.accountId, p.userId!), [] as T6ReminderPreference[]) : Promise.resolve({ ok: true, v: [] as T6ReminderPreference[] }),
    lire('assessments', () => L.assessments(p.accountId, ids), new Map<number, T6StoredAssessment>()),
    lire('evidence', () => L.evidence(p.accountId, ids), new Map<number, T6ItemEvidence>()),
    // Pré-génération du compte : reports arrivés à date (tous utilisateurs), réévalués sans visite.
    p.userId == null ? lire('dueReminders', () => L.dueReminders(p.accountId, today), new Map<number, string>()) : Promise.resolve({ ok: true, v: new Map<number, string>() }),
  ]);
  const prefs = prefsR.v;
  const evaluations = evalsR.v;
  // Évaluations illisibles : dégradation sans IA (préférences TOUJOURS appliquées).
  const aiCapable = aiCapableBrut && evalsR.ok;
  // Empreinte enrichie (T6-01) ; preuves illisibles : empreinte inconnue, aucune réévaluation.
  for (const { candidate: c, row: i } of candidats) {
    if (!preuvesR.ok) { c.fingerprintUnavailable = true; continue; }
    const e = preuvesR.v.get(c.agendaItemId);
    c.fingerprint = fingerprintWithEvidence({ title: i.title, date: i.date, forecast: i.forecast, requiresQualification: i.requiresQualification }, e);
    c.hasDocumentaryEvidence = (e?.facts.length ?? 0) > 0 || (e?.documents.length ?? 0) > 0;
    c.hasEvidence = c.hasDocumentaryEvidence || !!(e?.description ?? '').trim();
  }
  let historique = new Map<number, number>();
  if (p.userId != null && evalsR.ok) {
    const depuis = new Map<number, string>();
    for (const c of candidats) {
      const a = evaluations.get(c.candidate.agendaItemId);
      if (a && sameT6Context(a.fingerprint, c.candidate)) depuis.set(c.candidate.agendaItemId, a.assessedOn);
    }
    historique = await loadDisplayHistory(p.accountId, p.userId, depuis, today).catch(() => { echecs.push('history'); return new Map(); });
  }

  const decisions: T6DecisionTrace[] = candidats.map(({ candidate: c }) => {
    const assessment = evaluations.get(c.agendaItemId) ?? null;
    const displayedDays = historique.get(c.agendaItemId) ?? 0;
    const d = decideT6Interpellation({
      candidate: c, today, thresholdDays, aiCapable, assessment,
      preferences: preferencesFor(prefs, c.agendaItemId, c.seriesKey, c.dueDate),
      history: { displayedDays }, reminderCapable, preferencesUnavailable: !prefsR.ok,
    });
    // Lot 71G (T6-05) : report arrivé à sa date (un utilisateur du compte),
    // sans réévaluation depuis — la pré-génération le réévalue maintenant.
    const echu = echusR.v.get(c.agendaItemId);
    const aRevoir = aiCapable && echu != null && c.state === 'ACTIVE' && !(assessment && assessment.assessedOn >= echu && d.assessmentFresh);
    return {
      ...d, ...(aRevoir ? { needsAssessment: true, reevaluationReason: 'SNOOZE_DUE' as T6ReevaluationReason } : {}),
      agendaItemId: c.agendaItemId, dueDate: c.dueDate, seriesKey: c.seriesKey, assessment, displayedDays, fingerprint: c.fingerprint,
    };
  });

  const parId = new Map(candidats.map((c) => [c.candidate.agendaItemId, c]));
  const shown: MascotDecidedAgenda[] = decisions
    .filter((d) => d.decision === 'SHOW_NOW')
    .sort(compareShown)
    .map((d) => ({
      agendaItemId: d.agendaItemId,
      interpellation: {
        mode: d.mode ?? 'LEGACY', priority: d.priority, code: d.code,
        // Lot 61 : motif et catégorie VALIDÉS de l'IA — nature de la carte et pose.
        reasonCode: d.mode === 'LEGACY' ? null : d.assessment?.reasonCode ?? null,
        category: d.mode === 'LEGACY' ? null : d.assessment?.category ?? null,
      },
      action: d.mode === 'LEGACY' ? null : d.action,
      reminder: {
        agendaItemId: d.agendaItemId,
        suggestedDate: suggestReminderDate({ today, dueDate: d.dueDate, assessment: d.assessment }),
        hasSeries: !!parId.get(d.agendaItemId)?.candidate.seriesKey,
      },
    }));
  const notInterpellated = new Set(decisions.filter((d) => d.decision !== 'SHOW_NOW').map((d) => d.agendaItemId));
  const userSilenced = new Set(decisions.filter((d) => d.userPreference != null && d.decision !== 'SHOW_NOW').map((d) => d.agendaItemId));
  const discarded = new Set(decisions.filter((d) => d.decision !== 'SHOW_NOW' && (d.aiDecision != null || d.userPreference != null)).map((d) => d.agendaItemId));

  // Candidats à faire évaluer (lot 71G, T6-03) : dans l'horizon d'évaluation,
  // ou au-delà s'ils portent une preuve documentaire (préavis, délai
  // contractuel : la démarche peut commencer bien avant l'échéance) ; par
  // priorité (report échu, proche, documenté), puis date. Au plus 8 par
  // appel : les autres sont REPRIS par une pré-génération suivante.
  let bundle: T6InterpellationBundle | null = null;
  let pendingAssessments = 0;
  if (aiCapable) {
    const horizon = addDays(today, assessmentHorizonDays(thresholdDays));
    const eligibles = decisions
      .filter((d) => {
        const c = parId.get(d.agendaItemId)!.candidate;
        return d.needsAssessment && !!d.dueDate && !c.fingerprintUnavailable && (d.dueDate <= horizon || !!c.hasDocumentaryEvidence);
      })
      .map((d) => ({ d, rang: rangEvaluation(d, thresholdDays, !!parId.get(d.agendaItemId)!.candidate.hasDocumentaryEvidence) }))
      .sort((a, b) => a.rang - b.rang || (a.d.dueDate ?? '').localeCompare(b.d.dueDate ?? '') || a.d.agendaItemId - b.d.agendaItemId)
      .map((x) => x.d);
    const aEvaluer = eligibles.slice(0, T6_MAX_ASSESSMENTS_PER_CALL);
    pendingAssessments = eligibles.length - aEvaluer.length;
    if (aEvaluer.length > 0) {
      const refs = new Map<string, T6CandidateRef>();
      const candidates: T6EvaluationCandidate[] = aEvaluer.map((d, k) => {
        const { candidate: c, row: i } = parId.get(d.agendaItemId)!;
        const subjectId = `C${k + 1}`;
        const ev = preuvesR.v.get(c.agendaItemId);
        const desc = (ev?.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
        const description = desc || null;
        const preuves = evaluationEvidenceOf(subjectId, ev);
        // Références justificatives AUTORISÉES : seules celles-ci peuvent
        // fonder une décision (`evidenceRefs`, contrôlées à la validation).
        const evidence: T6EvidenceRef[] = [
          { ref: `${subjectId}.title`, kind: 'TITLE' },
          { ref: `${subjectId}.dueDate`, kind: 'DUE_DATE' },
          ...(description ? [{ ref: `${subjectId}.description`, kind: 'DESCRIPTION' as const }] : []),
          ...preuves.refs,
          ...(i.assetName ? [{ ref: `${subjectId}.asset`, kind: 'ASSET' as const }] : []),
          ...(c.seriesKey ? [{ ref: `${subjectId}.series`, kind: 'SERIES' as const }] : []),
          ...(d.displayedDays > 0 ? [{ ref: `${subjectId}.history`, kind: 'HISTORY' as const }] : []),
        ];
        const versions = new Map(preuves.versions);
        for (const e of evidence) if (!versions.has(e.ref)) versions.set(e.ref, { ref: e.ref, kind: e.kind });
        refs.set(subjectId, {
          subjectKey: c.subjectKey, agendaItemId: c.agendaItemId, fingerprint: c.fingerprint, daysUntilDue: d.daysUntilDue,
          reevaluationReason: d.reevaluationReason ?? 'FIRST_ASSESSMENT', evidenceVersions: versions,
        });
        return {
          subjectId, title: i.title, description,
          assetName: i.assetName, assetCategory: i.assetCategory ?? null,
          dueDate: i.date, dateLabel: i.date ? formatDateFr(i.date) : null,
          daysUntilDue: d.daysUntilDue, dateNature: i.forecast ? 'prévisionnelle' as const : 'confirmée' as const,
          dateRole: roleOf(i), overdue: !!i.date && i.date <= today, requiresQualification: i.requiresQualification,
          recurring: !!c.seriesKey, documents: preuves.documents,
          // T6-04 : clauses réellement extraites (extrait, document source, provenance, statut).
          ...(preuves.facts.length ? { facts: preuves.facts } : {}),
          recentlyShownDays: d.displayedDays, evidence,
        };
      });
      bundle = {
        context: { schemaVersion: T6_EVALUATION_INPUT_SCHEMA_VERSION, today, thresholdDays, candidates },
        refs,
        persist: async (list, meta) => {
          const n = await persistT6Assessments(p.accountId, today, refs, list, meta);
          if (n > 0) deps.onAssessed?.(n);
          return n;
        },
      };
    }
  }

  const degraded = echecs.length > 0;
  // Évaluations illisibles (T6-06) : dégradation explicite — jamais « rien à signaler ».
  const evaluation = evaluationStateOf(decisions, { degraded: degraded && !evalsR.ok, recentFailure: aiCapable && (deps.recentEvaluationFailure?.(p.accountId) ?? false) });
  return {
    thresholdDays, aiCapable, shown, decisions, notInterpellated, userSilenced, discarded, bundle, degraded, evaluation,
    failedSources: echecs, pendingAssessments,
  };
}

// ── Reporting T6 (BO › Exécutions IA › Rapports) ─────────────────────────────

/**
 * Lignes du rapport T6 (pure) : une par échéance candidate, AFFICHÉE ou
 * ÉCARTÉE — décision, motif, seuil, rappel utilisateur, évaluation IA
 * (codes, dates). Aucune donnée personnelle recopiée : ni titre, ni bien, ni
 * description ; la justification de l'IA est RÉFÉRENCÉE (empreinte) dans
 * `t6_interpellation_assessments`, relue en direct par le BO.
 */
/**
 * Lot 68 — issue d'une décision pour les rapports et compteurs : rappel
 * informatif, action, report ou refus de l'utilisateur, différé, écarté
 * (pure). Un rappel informatif n'est JAMAIS compté comme une action.
 */
export type T6DecisionOutcome = 'INFORMATIVE_REMINDER' | 'ACTION' | 'USER_SNOOZED' | 'USER_DISMISSED' | 'DEFERRED' | 'SUPPRESSED';
export function t6OutcomeOf(d: Pick<T6DecisionResult, 'decision' | 'mode' | 'code'>): T6DecisionOutcome {
  if (d.decision === 'SHOW_NOW') return d.mode === 'INFORM' ? 'INFORMATIVE_REMINDER' : 'ACTION';
  if (d.code === 'USER_SNOOZED') return 'USER_SNOOZED';
  if (d.code === 'USER_DISMISSED_OCCURRENCE' || d.code === 'USER_DISMISSED_SERIES') return 'USER_DISMISSED';
  return d.decision === 'DEFER' ? 'DEFERRED' : 'SUPPRESSED';
}

/** Lot 68 : compteurs par issue (rapport T6). */
export function t6OutcomeCounters(decisions: readonly Pick<T6DecisionResult, 'decision' | 'mode' | 'code'>[]): Record<T6DecisionOutcome, number> {
  const c: Record<T6DecisionOutcome, number> = { INFORMATIVE_REMINDER: 0, ACTION: 0, USER_SNOOZED: 0, USER_DISMISSED: 0, DEFERRED: 0, SUPPRESSED: 0 };
  for (const d of decisions) c[t6OutcomeOf(d)] += 1;
  return c;
}

export function t6ReportEntries(decisions: readonly T6DecisionTrace[], thresholdDays: number): ReportEntry[] {
  const out: ReportEntry[] = [];
  for (const d of decisions) {
    const a = d.assessment;
    out.push({
      section: 'INTERPELLATION',
      tableName: 'agenda_items', recordId: d.agendaItemId, fieldKey: d.subjectKey,
      label: `Échéance #${d.agendaItemId}`, entityType: 'AGENDA_ITEM', entityId: d.agendaItemId,
      value: {
        decision: d.decision, code: d.code, priority: d.priority, deferredBy: d.deferredBy,
        // Lot 68 : rappel informatif / action / report / refus / différé / écarté.
        outcome: t6OutcomeOf(d), mode: d.mode,
        nextReevaluationAt: d.nextReevaluationAt,
        // Lot 61 : décision de l'IA et écart avec la décision du serveur.
        aiDecision: d.aiDecision, divergence: d.aiDecision != null && d.aiDecision !== d.decision,
        dates: { dueDate: d.dueDate, actionDate: d.actionDate },
        threshold: { days: thresholdDays, applied: d.thresholdApplied, exception: d.thresholdException },
        userPreference: d.userPreference,
        assessment: a ? {
          contract: a.contractVersion ?? null, revision: a.contractRevision ?? 1, decision: a.decision ?? null, category: a.category ?? null,
          reasonCode: a.reasonCode ?? null, evidenceRefs: a.evidenceRefs ?? [], uncertainties: (a.uncertainties ?? []).length,
          interpellation: a.interpellation, actionNeeded: a.actionNeeded, priority: a.priority,
          assessedOn: a.assessedOn, reevaluateOn: a.reevaluateOn, fresh: d.assessmentFresh,
          exceptionMotivated: !!a.exceptionReason, uncertain: !!a.uncertainty, traceId: a.traceId ?? null,
        } : null,
        assessmentRequested: d.needsAssessment,
        recentlyShownDays: d.displayedDays,
        series: d.seriesKey != null,
        // Lot 71G : décision définitive ou provisoire (non évaluée, indisponible —
        // jamais comptée comme une décision métier), motif de réévaluation,
        // empreinte du contexte et preuves (références et versions, sans texte).
        final: !T6_PROVISIONAL_CODES.has(d.code),
        reevaluationReason: d.needsAssessment ? d.reevaluationReason : null,
        contextFingerprint: d.fingerprint ? d.fingerprint.slice(0, 16) : null,
        evidence: a?.evidenceSnapshot?.refs ? {
          refs: a.evidenceSnapshot.refs.map((x) => ({ ref: x.ref, kind: x.kind, fileId: x.fileId ?? null, extractionId: x.extractionId ?? null, factId: x.factId ?? null })),
          assessedWithFingerprint: (a.evidenceSnapshot.fingerprint ?? a.fingerprint).slice(0, 16),
          reevaluationReason: a.reevaluationReason ?? null,
        } : null,
        failure: d.code === 'PREFERENCES_UNAVAILABLE' ? 'preferences' : d.code === 'EVALUATION_UNAVAILABLE' ? 'evaluation' : null,
      },
      recordStatus: d.decision,
      writeResult: 'NOT_WRITTEN',
      reasonCode: d.code,
      reason: d.explanation,
    });
    if (a?.id != null && a.reason) {
      out.push({
        section: 'INTERPELLATION_AI',
        tableName: 't6_interpellation_assessments', recordId: a.id, columnPath: 'reason', fieldKey: d.subjectKey,
        label: `Justification IA — échéance #${d.agendaItemId}`, entityType: 'AGENDA_ITEM', entityId: d.agendaItemId,
        ref: { sha256: reportSha256(serializeForHash(a.reason)), chars: a.reason.length },
        recordStatus: a.interpellation, writeResult: 'OBSERVED', reasonCode: a.interpellation,
        reason: `Évaluation IA du ${a.assessedOn} (${a.priority}).`,
      });
    }
  }
  return out;
}

/**
 * Écrit le rapport T6 du passage — seulement si les décisions ont CHANGÉ
 * depuis le dernier rapport du même compte et du même utilisateur (pas de
 * rapport à chaque affichage). Ne lève jamais.
 */
export interface T6FormulateTrace {
  /** Version effective du prompt maître (FORMULATE), contrat de sortie. */
  promptVersion: string | null;
  contract: 't6-output-v2';
  /** Sujets transmis à FORMULATE (identifiants techniques, jamais de texte). */
  transmitted: string[];
  /** Sujets finalement affichés. */
  displayed: string[];
  /** Issue : `t6`, `fallback` (texte de secours), `deterministic` (rien à formuler). */
  source: 't6' | 'fallback' | 'deterministic';
  status: string | null;
  /** Sujets repliés sur leur texte de secours (repli sujet par sujet). */
  fallbackSubjects?: number;
  /** État de présentation retenu (`MascotPresentationState.kind`). */
  presentation: string | null;
}

/** Lignes FORMULATE du rapport (pure) : sujets transmis et affichés, secours. */
export function t6FormulateEntries(f: T6FormulateTrace): ReportEntry[] {
  return [{
    section: 'FORMULATE',
    fieldKey: 'formulate', label: 'Formulation (MODE=FORMULATE)',
    value: {
      mode: 'FORMULATE', contract: f.contract, transmitted: f.transmitted, displayed: f.displayed,
      source: f.source, fallbackUsed: f.source === 'fallback' || (f.fallbackSubjects ?? 0) > 0,
      fallbackSubjects: f.fallbackSubjects ?? 0, presentation: f.presentation,
    },
    // Motif = issue affichée (jamais le statut technique volatil — cache, génération —
    // pour qu'un affichage identique n'écrive pas un nouveau rapport).
    recordStatus: f.source, writeResult: 'NOT_WRITTEN', reasonCode: f.source,
    reason: f.source === 'deterministic' ? 'Aucun sujet à formuler : message déterministe de l’état de présentation.'
      : f.source === 'fallback' ? 'Texte de secours affiché (formulation indisponible, en cours ou rejetée).'
        : 'Formulation T6 validée affichée.',
  }];
}

export async function writeT6InterpellationReport(p: {
  accountId: number; userId: number | null; mode: string; prep: T6Preparation;
  /** Lot 61 : formulation du passage (sujets transmis, affichés, secours). */
  formulate?: T6FormulateTrace | null;
}): Promise<number | null> {
  try {
    const repo = await import('@/services/ai/execution-report/repository');
    if (!(await repo.executionReportsReady())) return null;
    const entries = [
      ...t6ReportEntries(p.prep.decisions, p.prep.thresholdDays),
      ...(p.formulate ? t6FormulateEntries(p.formulate) : []),
    ];
    const empreinte = entriesFingerprint(entries);
    const [prev] = await rows(
      `SELECT entries_fingerprint FROM ai_execution_reports
        WHERE account_id = $1 AND treatment = 'T6' AND target_id IS NOT DISTINCT FROM $2::int
        ORDER BY id DESC LIMIT 1`,
      [p.accountId, p.userId],
    );
    if (prev && prev.entries_fingerprint === empreinte) return null;
    const compte = (k: string) => p.prep.decisions.filter((d) => d.decision === k).length;
    const issues = t6OutcomeCounters(p.prep.decisions);
    const traces = [...new Set(p.prep.decisions.map((d) => d.assessment?.traceId).filter((x): x is string => !!x))].slice(0, 50);
    return await repo.writeExecutionReport({
      accountId: p.accountId, treatment: 'T6', scope: 'HOME',
      targetType: p.userId != null ? 'USER' : null, targetId: p.userId,
      triggerCode: p.mode, traceIds: traces, status: 'NO_CHANGE',
      counters: {
        candidates: p.prep.decisions.length, shown: compte('SHOW_NOW'), deferred: compte('DEFER'), suppressed: compte('SUPPRESS'),
        // Lot 68 : rappels informatifs et actions distingués, reports et refus de l'utilisateur.
        shownActions: issues.ACTION, shownInformativeReminders: issues.INFORMATIVE_REMINDER,
        userSnoozed: issues.USER_SNOOZED, userDismissed: issues.USER_DISMISSED,
        assessmentRequested: p.prep.bundle?.refs.size ?? 0, thresholdDays: p.prep.thresholdDays,
        // Lot 61 : écarts IA / serveur, sujets transmis à FORMULATE et affichés.
        divergences: p.prep.decisions.filter((d) => d.aiDecision != null && d.aiDecision !== d.decision).length,
        formulateTransmitted: p.formulate?.transmitted.length ?? 0, displayed: p.formulate?.displayed.length ?? 0,
        // Lot 71G : décisions provisoires (non évaluées, indisponibles) séparées des décisions définitives.
        provisional: p.prep.decisions.filter((d) => T6_PROVISIONAL_CODES.has(d.code)).length,
        finalDecisions: p.prep.decisions.filter((d) => !T6_PROVISIONAL_CODES.has(d.code)).length,
        pendingAssessments: p.prep.pendingAssessments ?? 0,
      },
      steps: [
        { step: 'candidates', status: 'OK', detail: { count: p.prep.decisions.length } },
        { step: 'decision', status: p.prep.degraded ? 'FAILED' : 'OK',
          // Lot 71G (T6-06) : source défaillante tracée précisément.
          error: p.prep.degraded ? `lectures indisponibles (${(p.prep.failedSources ?? []).join(', ') || 'inconnue'}) : décision prudente` : null,
          detail: { thresholdDays: p.prep.thresholdDays, aiCapable: p.prep.aiCapable, evaluation: p.prep.evaluation, failedSources: p.prep.failedSources ?? [], pendingAssessments: p.prep.pendingAssessments ?? 0 } },
        { step: 'assessment_request', status: p.prep.bundle ? 'OK' : 'SKIPPED', detail: { mode: 'EVALUATE', candidates: p.prep.bundle?.refs.size ?? 0 } },
        { step: 'formulate', status: p.formulate ? 'OK' : 'SKIPPED', detail: p.formulate ? {
          mode: 'FORMULATE', promptVersion: p.formulate.promptVersion, contract: p.formulate.contract, source: p.formulate.source, status: p.formulate.status,
        } : null },
      ],
      sources: { thresholdDays: p.prep.thresholdDays, aiCapable: p.prep.aiCapable, userPreferences: p.userId != null, evaluation: p.prep.evaluation },
    }, entries);
  } catch (e) {
    console.error('[mascotte] rapport T6 non écrit :', (e as Error).message);
    return null;
  }
}

/** Empreinte (tests) d'un ensemble de décisions — indépendante du jour. */
export const decisionsFingerprint = (d: readonly T6DecisionTrace[]) => sha256(canonicalJson(d.map((x) => [x.subjectKey, x.decision, x.code])));

// ── Reporting EVALUATE (lot 61) ──────────────────────────────────────────────

/** Issue d'une exécution EVALUATE, telle que tracée (aucune donnée personnelle). */
export interface T6EvaluationTrace {
  status: string;
  promptVersion: string | null;
  inputContract: string;
  outputContract: string;
  traceId: string | null;
  error: string | null;
  /** subjectId → décision acceptée (motif fermé) ; rejets avec motif. */
  accepted: Array<{ subjectId: string; decision: string; category: string; reasonCode: string; priorityHint: string | null; evidenceRefs: string[] }>;
  rejected: Array<{ subjectId: string; reason: string }>;
  persisted: number;
}

/** Lignes du rapport EVALUATE (pure) : une par candidat évalué. */
export function t6EvaluationEntries(t: T6EvaluationTrace, refs: T6InterpellationBundle['refs']): ReportEntry[] {
  const out: ReportEntry[] = [];
  for (const [subjectId, c] of refs) {
    const a = t.accepted.find((x) => x.subjectId === subjectId);
    const r = t.rejected.find((x) => x.subjectId === subjectId);
    out.push({
      section: 'EVALUATE',
      tableName: 'agenda_items', recordId: c.agendaItemId, fieldKey: c.subjectKey,
      label: `Échéance #${c.agendaItemId} (${subjectId})`, entityType: 'AGENDA_ITEM', entityId: c.agendaItemId,
      value: a ? {
        subjectId, decision: a.decision, category: a.category, reasonCode: a.reasonCode, priorityHint: a.priorityHint, evidenceRefs: a.evidenceRefs,
        informativeReminder: a.decision === 'SHOW_NOW' && a.category === 'INFORMATION',
      }
        : { subjectId, rejected: r?.reason ?? t.error ?? t.status },
      recordStatus: a ? a.decision : 'REJECTED',
      // Écriture confirmée seulement si toutes les décisions acceptées ont été conservées.
      writeResult: a ? (t.persisted >= t.accepted.length ? 'WRITTEN' : 'DECIDED_NOT_CONFIRMED') : 'NOT_PERSISTED',
      reasonCode: a ? a.reasonCode : r ? `VALIDATION:${r.reason}` : t.status.toUpperCase(),
      reason: a ? 'Décision IA validée, conservée (cache des évaluations).'
        : r ? `Décision rejetée par la validation (${r.reason}) : candidat en attente, jamais affiché d’office.`
          : `Évaluation non obtenue (${t.status}${t.error ? ` : ${t.error.slice(0, 120)}` : ''}) : candidat en attente.`,
    });
  }
  return out;
}

/** Rapport d'une exécution EVALUATE (BO › Exécutions IA › Rapports). Ne lève jamais. */
export async function writeT6EvaluationReport(p: {
  accountId: number; mode: string; bundle: T6InterpellationBundle; trace: T6EvaluationTrace;
}): Promise<number | null> {
  try {
    const repo = await import('@/services/ai/execution-report/repository');
    if (!(await repo.executionReportsReady())) return null;
    const t = p.trace;
    const compte = (k: string) => t.accepted.filter((d) => d.decision === k).length;
    return await repo.writeExecutionReport({
      accountId: p.accountId, treatment: 'T6', scope: 'HOME', targetType: null, targetId: null,
      triggerCode: `evaluate:${p.mode}`, traceIds: t.traceId ? [t.traceId] : [],
      status: t.status !== 'generated' ? 'FAILED' : t.rejected.length ? 'PARTIAL' : 'SUCCESS',
      counters: {
        evaluated: p.bundle.refs.size, accepted: t.accepted.length, rejected: t.rejected.length, persisted: t.persisted,
        showNow: compte('SHOW_NOW'), defer: compte('DEFER'), suppress: compte('SUPPRESS'),
        // Lot 68 : SHOW_NOW + INFORMATION (rappel informatif), jamais compté comme action.
        showNowInformation: t.accepted.filter((d) => d.decision === 'SHOW_NOW' && d.category === 'INFORMATION').length,
      },
      steps: [{
        step: 'evaluate', status: t.status === 'generated' ? 'OK' : 'FAILED', error: t.error,
        detail: { mode: 'EVALUATE', promptVersion: t.promptVersion, inputContract: t.inputContract, outputContract: t.outputContract },
      }],
      sources: { mode: 'EVALUATE', promptVersion: t.promptVersion },
    }, t6EvaluationEntries(t, p.bundle.refs));
  } catch (e) {
    console.error('[mascotte] rapport EVALUATE non écrit :', (e as Error).message);
    return null;
  }
}
