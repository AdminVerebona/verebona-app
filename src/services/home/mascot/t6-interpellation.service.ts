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
import { documentTitleColumnsSql, documentTitleOf } from '@/lib/documents/document-title-source';
import { pgClient } from '@/db';
import type { MascotAgendaRow, MascotDecidedAgenda, MascotRawData } from './signals';
import { EXT_ACTION_LOOKBACK_DAYS, agendaInToProcess, extActionOccurrenceKey, formatDateFr, roleOf } from './signals';
import { sha256 } from './hash';
import { entriesFingerprint, serializeForHash, sha256 as reportSha256, type ReportEntry } from '@/services/ai/execution-report/model';
import {
  DEFAULT_T6_THRESHOLD_DAYS, T6_ASSESSMENT_CONTRACT, T6_ASSESSMENT_MAX_AGE_DAYS, T6_ASSESSMENT_REVISION_REMINDER, T6_FINGERPRINT_V2, T6_FINGERPRINT_V3,
  T6_FINGERPRINT_V4, t6EvaluationSubjectParts,
  T6_MAX_ASSESSMENTS_PER_CALL, T6_RELEVANT_FACT_PATTERN, T6_REPEAT_WINDOW_DAYS,
  addDays, agendaFingerprintParts, agendaOccurrenceKey, agendaSubjectKey, assessmentFromDecision, assessmentHorizonDays, compareShown,
  daysBetween, decideT6Interpellation, evidenceSnapshotOf, exceptionEvidenceGrounded, isT6RelevantFact, preferenceAppliesToCycle, sameT6Context,
  suggestReminderDate, t6CycleKeySql, t6FingerprintParts, t6ProbativeFingerprintParts,
  type T6Assessment, type T6Candidate, type T6CandidateRef, type T6DecisionResult, type T6EvaluationConfig, type T6EvidenceVersion,
  type T6InterpellationBundle, type T6PersistResult, type T6ReevaluationReason, type T6ReminderPreference, type T6StoredAssessment,
} from './t6-interpellation';
import {
  T6_EVALUATION_INPUT_SCHEMA_VERSION,
  type T6EvaluationCandidate, type T6EvaluationFact, type T6EvidenceRef, type T6ValidatedDecision,
} from './t6-contract';
import {
  T6_RUN_UNAVAILABLE_RECHECK_S, displayGroupOf, effectiveRunState, loadT6Runs, markT6RunsUnavailable, reconcileT6RunsWithDecision, requestT6Runs,
  runStateCounters, t6RunsReady,
  type T6EffectiveRunState, type T6RunRow, type T6RunSubject,
} from './t6-evaluation-runs';

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

/** Lot 71G (T6-01) : empreinte ENRICHIE (`v2:`) — conservée pour relire les décisions et reports antérieurs. */
function t6FingerprintV2(p: Parameters<typeof t6FingerprintParts>[0]): string {
  return `${T6_FINGERPRINT_V2}${sha256(t6FingerprintParts(p)).slice(0, 32)}`;
}

/**
 * Lot 75E (C) : empreinte du CONTENU PROBANT (`v3:`) — celle du lot 71G plus
 * l'extrait de chaque fait (représentation stable) et sa provenance. Portée
 * par toute nouvelle décision et tout nouveau report.
 */
export function t6Fingerprint(p: Parameters<typeof t6FingerprintParts>[0]): string {
  return `${T6_FINGERPRINT_V3}${sha256(t6ProbativeFingerprintParts(p)).slice(0, 32)}`;
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
            ${documentTitleColumnsSql('f')}
       FROM (SELECT l.agenda_item_id, l.asset_file_id AS file_id, FALSE AS origin
               FROM agenda_file_links l JOIN agenda_items i ON i.id = l.agenda_item_id AND i.account_id = $1
              WHERE l.agenda_item_id = ANY($2::int[])
             UNION ALL
             SELECT i.id, i.origin_ref_id, TRUE FROM agenda_items i
              WHERE i.account_id = $1 AND i.id = ANY($2::int[]) AND i.origin_ref_type = 'asset_file' AND i.origin_ref_id IS NOT NULL) d
       JOIN asset_files f ON f.id = d.file_id AND f.account_id = $1 AND f.deleted_at IS NULL
      GROUP BY d.agenda_item_id, f.id`,
    [accountId, ids],
  );
  const fichiers = new Set<number>();
  for (const x of docs) {
    const e = out.get(Number(x.agenda_item_id));
    if (!e) continue;
    e.documents.push({ fileId: Number(x.file_id), title: documentTitleOf(x).slice(0, 120), origin: x.origin === true });
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

/** Données de l'empreinte d'une échéance à partir de sa ligne et de ses preuves (pure). */
function fingerprintInput(i: { title: string; date: string | null; forecast: boolean; requiresQualification: boolean }, e: T6ItemEvidence | undefined) {
  return {
    ...i, description: e?.description ?? null, endDate: e?.endDate ?? null,
    documents: (e?.documents ?? []).map((d) => ({ fileId: d.fileId, title: d.title })),
    facts: (e?.facts ?? []).map((f) => ({
      fileId: f.fileId, key: f.canonicalKey ?? f.key, value: f.value, confidence: f.confidence, excerpt: f.excerpt, provenance: f.provenance,
    })),
  };
}

/**
 * Empreinte (contenu probant, `v3:`) d'une échéance à partir de sa ligne et de
 * ses preuves (pure). Lot 76A : n'est plus portée par les nouvelles décisions
 * (`t6ContextFingerprint`, `v4:`) — sert à relire les décisions et reports du lot 75E.
 */
export function fingerprintWithEvidence(
  i: { title: string; date: string | null; forecast: boolean; requiresQualification: boolean }, e: T6ItemEvidence | undefined,
): string {
  return t6Fingerprint(fingerprintInput(i, e));
}

/** Lot 75E : empreinte du lot 71G (`v2:`) de la même échéance — relecture des décisions antérieures (pure). */
export function fingerprintV2WithEvidence(
  i: { title: string; date: string | null; forecast: boolean; requiresQualification: boolean }, e: T6ItemEvidence | undefined,
): string {
  return t6FingerprintV2(fingerprintInput(i, e));
}

/**
 * Lot 71G — empreintes enrichies COURANTES d'échéances du compte (même calcul
 * que la décision) : reports de l'utilisateur, harnais de test. Lève en cas
 * d'échec. Lot 76A : empreinte `v4:` du contexte transmis, à partir de la
 * MÊME lecture des lignes que la mascotte (`readAgendaRowsByIds` : bien du
 * compte, rôle de la date, série) et des mêmes preuves.
 */
export async function currentT6Fingerprints(accountId: number, ids: readonly number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (ids.length === 0) return out;
  const { readAgendaRowsByIds } = await import('./collector');
  const [lignes, ev] = await Promise.all([readAgendaRowsByIds(accountId, ids), loadT6Evidence(accountId, ids)]);
  for (const x of lignes) out.set(x.id, t6ContextFingerprint(x, ev.get(x.id)));
  return out;
}

const STATUT_FAIT: Record<string, T6EvaluationFact['status']> = { certain: 'PROVEN', probable: 'DEDUCED', conflictual: 'UNCERTAIN' };
const RANG_CONFIANCE: Record<string, number> = { certain: 0, probable: 1, conflictual: 2 };
/** Faits transmis à EVALUATE par candidat, au plus. */
const T6_MAX_FACTS_PER_CANDIDATE = 8;
/** Documents (intitulés) transmis à EVALUATE par candidat, au plus. */
const T6_MAX_DOCUMENTS_PER_CANDIDATE = 5;

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
    // Lot 75E (C) : statut du fait conservé avec sa version (exception au seuil, reporting).
    versions.set(ref, {
      ref, kind: 'DOCUMENT_FACT', fileId: f.fileId, extractionId: f.extractionId, factId: f.id, factKey: f.canonicalKey ?? f.key, provenance: f.provenance,
      status: STATUT_FAIT[f.confidence ?? ''] ?? 'UNCERTAIN',
    });
    const texte = (v: string | null, max: number) => (v ? v.replace(/\s+/g, ' ').trim().slice(0, max) || null : null);
    return {
      ref, document: docRef.get(f.fileId) ?? null, label: texte(f.label, 120) ?? f.key.slice(0, 80), value: texte(f.value, 160),
      excerpt: texte(f.excerpt, 300), status: STATUT_FAIT[f.confidence ?? ''] ?? 'UNCERTAIN', provenance: f.provenance.slice(0, 40),
    };
  });
  return { documents, facts, refs, versions };
}

/** Données d'une échéance utiles au contexte EVALUATE (ligne de l'agenda de la mascotte). */
type T6SubjectRow = Pick<MascotAgendaRow, 'title' | 'date' | 'forecast' | 'requiresQualification' | 'assetName' | 'dateRole'>
  & Partial<Pick<MascotAgendaRow, 'assetCategory' | 'seriesKey'>>;

/**
 * Lot 76A (P1) — REPRÉSENTATION COMMUNE du candidat transmis à EVALUATE
 * (pure) : la partie stable (`core`) sert À LA FOIS au contexte transmis
 * (`prepareT6Interpellation`) et à son empreinte (`t6ContextFingerprint`) —
 * jamais deux constructions divergentes. Les preuves (documents, faits avec
 * extrait, document source, statut, provenance) sont celles d'`evaluationEvidenceOf`.
 */
export function evaluationSubjectOf(subjectId: string, row: T6SubjectRow, e: T6ItemEvidence | undefined): {
  core: import('./t6-interpellation').T6EvaluationSubjectCore;
  preuves: ReturnType<typeof evaluationEvidenceOf>;
} {
  const desc = (e?.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const preuves = evaluationEvidenceOf(subjectId, e);
  const position = new Map(preuves.refs.filter((x) => x.kind === 'DOCUMENT').map((x, n) => [x.ref, n]));
  return {
    preuves,
    core: {
      title: row.title, description: desc || null, assetName: row.assetName ?? null, assetCategory: row.assetCategory ?? null,
      dueDate: row.date, dateNature: row.forecast ? 'prévisionnelle' : 'confirmée', dateRole: roleOf(row),
      requiresQualification: row.requiresQualification, recurring: !!row.seriesKey,
      documents: preuves.documents,
      facts: preuves.facts.map((f) => ({
        document: f.document != null ? position.get(f.document) ?? null : null, label: f.label, value: f.value, excerpt: f.excerpt, status: f.status, provenance: f.provenance,
      })),
    },
  };
}

/**
 * Lot 76A (P1) — empreinte (`v4:`) du contexte RÉELLEMENT transmis à
 * EVALUATE (pure) : portée par toute nouvelle décision et tout nouveau report.
 */
export function t6ContextFingerprint(row: T6SubjectRow, e: T6ItemEvidence | undefined): string {
  return `${T6_FINGERPRINT_V4}${sha256(t6EvaluationSubjectParts(evaluationSubjectOf('S', row, e).core)).slice(0, 32)}`;
}

/**
 * Lot 76A (AC10) — rebasage des décisions antérieures (`v2:`, `v3:`) dont le
 * contexte est INCHANGÉ selon leur empreinte : leur empreinte devient la
 * courante (`v4:`), pour qu'un changement ULTÉRIEUR des données désormais
 * couvertes (extrait reformulé, bien, rôle de la date…) les invalide. Ligne
 * modifiée seulement si elle porte encore l'ancienne empreinte (aucune
 * décision plus récente écrasée), bornée au compte. Rend le nombre rebasé.
 */
async function rebaseT6AssessmentFingerprints(accountId: number, list: ReadonlyArray<{ agendaItemId: number; from: string; to: string }>): Promise<number> {
  if (list.length === 0) return 0;
  const r = await rows(
    `UPDATE t6_interpellation_assessments a SET context_fingerprint = m.to_fp
       FROM unnest($2::int[], $3::text[], $4::text[]) AS m(id, from_fp, to_fp)
      WHERE a.account_id = $1 AND a.agenda_item_id = m.id AND a.context_fingerprint = m.from_fp
     RETURNING a.id`,
    [accountId, list.map((x) => x.agendaItemId), list.map((x) => x.from), list.map((x) => x.to)],
  );
  return r.length;
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

/** Lot 75E (E) : préférences lues au plus par passage ; au-delà, la lecture est INCOMPLÈTE. */
export const T6_PREFERENCES_READ_LIMIT = 2000;

/**
 * Lot 75E (E) : lecture des préférences INCOMPLÈTE — un refus ou un report
 * peut manquer : jamais pris pour une absence de préférence (dégradation
 * prudente, tracée `preferences_incomplete`).
 */
export class T6PreferencesIncompleteError extends Error {
  readonly source = 'preferences_incomplete';
  constructor(readonly read: number) { super(`préférences T6 : lecture incomplète (plus de ${read} lignes)`); }
}

/**
 * Préférences de rappel de l'utilisateur, rattachées à une échéance du compte (ou à une série).
 *
 * Lot 75E (E) : lecture CIBLÉE — avec `scope`, seules les préférences des
 * candidats effectivement examinés (leur occurrence, leur série) sont lues,
 * toujours bornées au compte ET à l'utilisateur (Premium Duo : jamais celles
 * de l'autre membre). Une lecture qui atteint sa borne est INCOMPLÈTE : elle
 * lève `T6PreferencesIncompleteError` (jamais un résultat tronqué pris pour
 * exhaustif).
 */
export async function loadUserPreferences(
  accountId: number, userId: number,
  scope?: { agendaIds: readonly number[]; seriesKeys: readonly string[] } | null,
  limit: number = T6_PREFERENCES_READ_LIMIT,
): Promise<T6ReminderPreference[]> {
  if (scope && scope.agendaIds.length === 0 && scope.seriesKeys.length === 0) return [];
  const r = await rows(
    `SELECT p.scope, p.decision, to_char(p.remind_at, 'YYYY-MM-DD') AS remind_at, p.context_fingerprint,
            p.agenda_item_id, p.series_key, p.updated_at,
            -- Lot 71G (0507) / lot 75E (0551) : lues sans dépendre des colonnes (fenêtre de déploiement).
            to_jsonb(p) ->> 'occurrence_date' AS occurrence_date, to_jsonb(p) ->> 'cycle_key' AS cycle_key
       FROM t6_reminder_preferences p
      WHERE p.account_id = $1 AND p.user_id = $2
        AND (p.agenda_item_id IS NULL
             OR EXISTS (SELECT 1 FROM agenda_items i WHERE i.id = p.agenda_item_id AND i.account_id = p.account_id))
        ${scope ? `AND ((p.scope = 'OCCURRENCE' AND p.agenda_item_id = ANY($3::int[]))
                        OR (p.scope = 'SERIES' AND p.series_key = ANY($4::text[])))` : ''}
      ORDER BY p.id
      LIMIT ${Math.max(1, Math.trunc(limit)) + 1}`,
    scope ? [accountId, userId, [...scope.agendaIds], [...scope.seriesKeys]] : [accountId, userId],
  );
  if (r.length > limit) throw new T6PreferencesIncompleteError(limit);
  return r.map((x) => ({
    scope: x.scope === 'SERIES' ? 'SERIES' : 'OCCURRENCE',
    decision: x.decision === 'DISMISSED' ? 'DISMISSED' : 'SNOOZED',
    remindAt: (x.remind_at as string | null) ?? null,
    contextFingerprint: (x.context_fingerprint as string | null) ?? null,
    agendaItemId: x.agenda_item_id == null ? null : Number(x.agenda_item_id),
    seriesKey: (x.series_key as string | null) ?? null,
    updatedAt: x.updated_at ? new Date(String(x.updated_at)).toISOString() : null,
    occurrenceDate: typeof x.occurrence_date === 'string' ? x.occurrence_date.slice(0, 10) : null,
    cycleKey: typeof x.cycle_key === 'string' && x.cycle_key ? x.cycle_key : null,
  }));
}

/**
 * Lot 75E (D) — cycle COURANT de chaque échéance du compte (`t6CycleKey`) :
 * occurrence T4 et nombre de réalisations tracées. Lève en cas d'échec
 * (l'appelant applique alors les préférences : prudence).
 */
async function loadCycleKeys(accountId: number, ids: readonly number[]): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();
  const r = await rows(
    `SELECT i.id, ${t6CycleKeySql('i')} AS cycle_key FROM agenda_items i WHERE i.account_id = $1 AND i.id = ANY($2::int[])`,
    [accountId, [...ids]],
  );
  return new Map(r.map((x) => [Number(x.id), String(x.cycle_key)]));
}

/** Lot 75E (B) : examen achevé d'une échéance de la lecture complémentaire (curseur persistant). */
interface T6ExaminationMark { agendaItemId: number; selectionSignature: string; fingerprint: string | null; recheckOn: string | null }

/**
 * Lot 75E (B) — enregistre les examens ACHEVÉS (pré-génération du compte) :
 * l'échéance quitte la file d'examen jusqu'à un changement de ses données
 * (signature) ou sa date de réexamen. Idempotent (une ligne par échéance,
 * la dernière l'emporte), borné au compte. Table absente (0551 non
 * appliquée) : sans effet. Rend le nombre d'examens enregistrés.
 */
async function recordT6Examinations(accountId: number, marks: readonly T6ExaminationMark[]): Promise<number> {
  if (marks.length === 0) return 0;
  const { t6ExaminationsReady } = await import('./collector');
  if (!(await t6ExaminationsReady())) return 0;
  const r = await rows(
    `INSERT INTO t6_candidate_examinations (account_id, agenda_item_id, examined_at, selection_signature, context_fingerprint, recheck_on)
     SELECT $1, i.id, now(), m.sig, m.fp, m.recheck::date
       FROM unnest($2::int[], $3::text[], $4::text[], $5::text[]) AS m(id, sig, fp, recheck)
       JOIN agenda_items i ON i.id = m.id AND i.account_id = $1
     ON CONFLICT (agenda_item_id) DO UPDATE SET
       account_id = EXCLUDED.account_id, examined_at = EXCLUDED.examined_at, selection_signature = EXCLUDED.selection_signature,
       context_fingerprint = EXCLUDED.context_fingerprint, recheck_on = EXCLUDED.recheck_on
     RETURNING agenda_item_id`,
    [accountId, marks.map((m) => m.agendaItemId), marks.map((m) => m.selectionSignature), marks.map((m) => m.fingerprint), marks.map((m) => m.recheckOn)],
  );
  return r.length;
}

/**
 * Préférences applicables à une échéance : son occurrence, et sa série.
 * Lot 75E (D) : une préférence d'occurrence s'applique tant que le CYCLE
 * persistant de l'occurrence est le même (`preferenceAppliesToCycle`) —
 * replanification comprise, quel que soit l'écart de dates ; jamais au cycle
 * suivant. Cycle inconnu : appliquée (prudence).
 */
export function preferencesFor(prefs: readonly T6ReminderPreference[], agendaItemId: number, seriesKey: string | null, cycleKey: string | null = null): T6ReminderPreference[] {
  return prefs.filter((p) => (p.scope === 'OCCURRENCE' && p.agendaItemId === agendaItemId && preferenceAppliesToCycle(p, cycleKey))
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
            to_jsonb(a) -> 'evidence_snapshot' AS evidence_snapshot, to_jsonb(a) ->> 'reevaluation_reason' AS reevaluation_reason,
            -- Lot 72A (0510) : signature de la configuration EVALUATE, lue sans dépendre de la colonne.
            to_jsonb(a) ->> 'evaluation_signature' AS evaluation_signature
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
      evaluationSignature: (x.evaluation_signature as string | null) ?? null,
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
async function loadDisplayHistory(
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
async function loadDueReminders(accountId: number, today: string): Promise<Map<number, string>> {
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
 *
 * Lot 72A (AC05) : le lot accepté est écrit dans UNE transaction — une ligne
 * en échec annule tout (rien n'est alors présenté comme disponible dans le
 * cache) et l'erreur remonte à l'appelant. Rend les `subjectId` réellement
 * enregistrés (une échéance supprimée entre-temps n'est pas écrite).
 */
export async function persistT6AssessmentsDetailed(
  accountId: number, today: string,
  refs: T6InterpellationBundle['refs'],
  list: readonly T6ValidatedDecision[],
  meta: {
    promptVersion: string; traceId: string | null; contractRevision?: number; evaluationSignature?: string | null;
    /** Lot 81B (D) : exécution durable qui écrit — propriété vérifiée dans la transaction. */
    run?: { runId: string; leaseMs?: number } | null;
  },
): Promise<{ persisted: number; persistedSubjectIds: string[]; lostSubjectIds?: string[] }> {
  // Lot 68 : révision 2 seulement si la version du prompt qui a évalué connaît
  // le rappel informatif (sinon l'évaluation sera renouvelée après activation).
  const revision = meta.contractRevision === T6_ASSESSMENT_REVISION_REMINDER ? T6_ASSESSMENT_REVISION_REMINDER : 1;
  // Colonnes facultatives sondées AVANT la transaction (fenêtre de déploiement).
  const [avecRevision, avecPreuves, avecSignature] = await Promise.all([hasContractRevision(), hasEvidenceSnapshot(), hasEvaluationSignature()]);
  const lignes = list.map((d) => ({ d, c: refs.get(d.subjectId) })).filter((x): x is { d: T6ValidatedDecision; c: T6CandidateRef } => !!x.c);
  if (lignes.length === 0) return { persisted: 0, persistedSubjectIds: [] };
  const perdues: string[] = [];
  const ecrire = async (q: (sql: string, params: unknown[]) => Promise<Row[]>): Promise<string[]> => {
    const ok: string[] = [];
    perdues.length = 0;
    // Lot 81B (D) : propriété de l'exécution contrôlée AU MOMENT de l'écriture,
    // sous le verrou du compte et des lignes d'exécution (même transaction) —
    // une instance dépossédée (bail repris ailleurs) n'écrit rien, et ne peut
    // donc pas écraser la décision d'une exécution plus récente.
    let detenues: Set<number> | null = null;
    if (meta.run) {
      const { lockOwnedT6Runs } = await import('./t6-evaluation-runs');
      detenues = await lockOwnedT6Runs(q, { accountId, runId: meta.run.runId, ids: lignes.map((x) => x.c.agendaItemId), leaseMs: meta.run.leaseMs });
    }
    for (const { d, c } of lignes) {
      if (detenues && !detenues.has(c.agendaItemId)) { perdues.push(d.subjectId); continue; }
      // Lot 75E (C) : statut des faits transmis — l'intitulé d'un document ou un
      // fait incertain ne fondent jamais une exception au seuil.
      const a = assessmentFromDecision(d, c.evidenceVersions);
      // Paramètres facultatifs après les 23 du contrat : preuves (0507), signature (0510), révision (0474).
      const extra: unknown[] = [];
      const cols: string[] = [];
      const vals: string[] = [];
      const add = (col: string, cast: string, v: unknown) => { extra.push(v); cols.push(col); vals.push(`$${23 + extra.length}${cast}`); };
      if (avecPreuves) {
        add('evidence_snapshot', '::jsonb', JSON.stringify(evidenceSnapshotOf(d.evidenceRefs, c.evidenceVersions, c.fingerprint)));
        add('reevaluation_reason', '', c.reevaluationReason ?? null);
      }
      if (avecSignature) add('evaluation_signature', '', meta.evaluationSignature ?? null);
      if (avecRevision) add('contract_revision', '::smallint', revision);
      const r = await q(
        `INSERT INTO t6_interpellation_assessments
           (account_id, agenda_item_id, subject_key, context_fingerprint, assessed_on, interpellation, action_needed, priority,
            action_date, reevaluate_on, reason, action, consequence, uncertainty, exception_reason, prompt_version, trace_id,
            contract_version, decision, category, reason_code, evidence_refs, uncertainties${cols.map((x) => `, ${x}`).join('')})
         SELECT $1, i.id, $3, $4, $5::date, $6, $7, $8, $9::date, $10::date, $11, $12, $13, $14, $15, $16, $17,
                $18, $19, $20, $21, $22::jsonb, $23::jsonb${vals.map((x) => `, ${x}`).join('')}
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
           ${cols.map((x) => `${x} = EXCLUDED.${x},`).join(' ')}
           updated_at = now()
         RETURNING id`,
        [accountId, c.agendaItemId, c.subjectKey, c.fingerprint, today, a.interpellation, a.actionNeeded, a.priority,
          a.actionDate, a.reevaluateOn, a.reason, a.action, a.consequence, a.uncertainty, a.exceptionReason,
          meta.promptVersion, meta.traceId,
          T6_ASSESSMENT_CONTRACT, d.decision, d.category, d.reasonCode, JSON.stringify(d.evidenceRefs), JSON.stringify(d.uncertainties),
          ...extra],
      );
      if (r.length > 0) ok.push(d.subjectId);
    }
    return ok;
  };
  const client = pgClient as unknown as { begin?: <T>(f: (tx: { unsafe: (s: string, p: never[]) => Promise<unknown> }) => Promise<T>) => Promise<T> };
  const ids = typeof client.begin === 'function'
    ? await client.begin((tx) => ecrire(async (sql, params) => (await tx.unsafe(sql, params as never[])) as unknown as Row[]))
    // Client simulé sans transaction (tests unitaires historiques) : écriture séquentielle.
    : await ecrire(rows);
  if (perdues.length > 0) console.warn(`[mascotte] ${perdues.length} décision(s) EVALUATE non écrite(s) : exécution dépossédée (bail repris par une autre instance).`);
  return { persisted: ids.length, persistedSubjectIds: ids, ...(meta.run ? { lostSubjectIds: [...perdues] } : {}) };
}

/** Nombre de décisions enregistrées (appelants antérieurs) — voir `persistT6AssessmentsDetailed`. */
export async function persistT6Assessments(
  accountId: number, today: string,
  refs: T6InterpellationBundle['refs'],
  list: readonly T6ValidatedDecision[],
  meta: { promptVersion: string; traceId: string | null; contractRevision?: number; evaluationSignature?: string | null },
): Promise<number> {
  return (await persistT6AssessmentsDetailed(accountId, today, refs, list, meta)).persisted;
}

/**
 * Lot 68 : la colonne `contract_revision` (migration 0474) existe-t-elle ?
 * Lue une fois par processus ; en échec ou absente (fenêtre de déploiement),
 * l'enregistrement se fait sans elle — jamais de décision perdue.
 */
let revisionColumn: Promise<boolean> | null = null;
function hasContractRevision(): Promise<boolean> {
  revisionColumn ??= rows(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 't6_interpellation_assessments' AND column_name = 'contract_revision' LIMIT 1`, [],
  ).then((r) => r.length > 0).catch(() => { revisionColumn = null; return false; });
  return revisionColumn;
}
/** Réservé aux tests. */
export function resetContractRevisionProbe(): void { revisionColumn = null; snapshotColumn = null; signatureColumn = null; }

/** Lot 71G : colonnes `evidence_snapshot` / `reevaluation_reason` (0507) présentes ? Même principe. */
let snapshotColumn: Promise<boolean> | null = null;
function hasEvidenceSnapshot(): Promise<boolean> {
  snapshotColumn ??= rows(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 't6_interpellation_assessments' AND column_name = 'reevaluation_reason' LIMIT 1`, [],
  ).then((r) => r.length > 0).catch(() => { snapshotColumn = null; return false; });
  return snapshotColumn;
}

/** Lot 72A : colonne `evaluation_signature` (0510) présente ? Même principe. */
let signatureColumn: Promise<boolean> | null = null;
function hasEvaluationSignature(): Promise<boolean> {
  signatureColumn ??= rows(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 't6_interpellation_assessments' AND column_name = 'evaluation_signature' LIMIT 1`, [],
  ).then((r) => r.length > 0).catch(() => { signatureColumn = null; return false; });
  return signatureColumn;
}

// ── Candidats ────────────────────────────────────────────────────────────────

interface T6CandidateRow { candidate: T6Candidate; row: MascotAgendaRow }

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
    // « C'est fait » déclaré pour ce cycle : le sujet est résolu. Lot 72A
    // (ATP-FIX-17) : une décision « À traiter » qui RÈGLE l'échéance passée
    // (aucune intervention attendue, ou tranchée) la clôt aussi quand elle
    // est « à préciser » — jamais de relance T6 qui la contredirait.
    // Lot 72 (intégration 72C) : une intervention tranchée dans « À traiter »
    // règle l'échéance quelle que soit sa date (à venir comprise).
    const fait = regles.has(i.id)
      || (!future && !i.requiresQualification && acquittes.has(`${extActionOccurrenceKey(i.id)}|${i.date}`));
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
   * Lot 75E (B) : examens achevés enregistrés par ce passage (curseur
   * persistant de la lecture complémentaire, pré-génération du compte) et
   * file d'examen plus longue que la lecture (`backlog`) — la reprise
   * continue tant qu'un passage progresse.
   */
  examined?: number;
  selectionBacklog?: boolean;
  /**
   * Lot 76A : signature de configuration EVALUATE courante (`e2:`, reporting)
   * et décisions rebasées sur l'empreinte du contexte transmis (transition).
   */
  evaluationSignature?: string | null;
  rebased?: number;
  /**
   * Lot 61 — état de l'évaluation pour la présentation : `PENDING`, une
   * échéance proche (dans le seuil) attend son évaluation ; `UNAVAILABLE`,
   * une échéance proche n'a pas pu être évaluée (T6 coupé, version BO sans
   * EVALUATE, lectures en échec) ; `OK` sinon. Jamais « rien à signaler »
   * tant qu'une échéance proche n'a pas été examinée.
   */
  evaluation: T6EvaluationState;
  /**
   * Lot 78C : état RÉEL de l'évaluation de chaque échéance éligible
   * (`t6_evaluation_runs`), `null` si la table n'est pas déployée ou illisible
   * (comportement du lot 77).
   */
  runStates?: Map<number, T6EffectiveRunState> | null;
  /** Lot 78C : avancement des évaluations éligibles (pré-génération, rafraîchissement, reporting). */
  evaluationProgress?: T6EvaluationProgress | null;
  /**
   * Lot 87C : preuves canoniques lues par ce passage (`loadT6Evidence` :
   * description, documents liés, faits pertinents) — réutilisées, sans
   * relecture, par les fondements des questions suggérées. `null` : lecture
   * en échec (aucun fondement documentaire transmis).
   */
  evidence?: ReadonlyMap<number, T6ItemEvidence> | null;
}

/** Lot 78C — avancement des évaluations éligibles après ce passage. */
export interface T6EvaluationProgress {
  /** Échéances éligibles sans décision valide (évaluations incomplètes). */
  eligible: number;
  /** Prenables maintenant (dont celles transmises à ce passage). */
  claimable: number;
  /** Transmises à EVALUATE par ce passage. */
  inBundle: number;
  /** En cours ailleurs, en attente d'un essai planifié ou du délai anti-boucle. */
  waiting: number;
  failed: number;
  unavailable: number;
  /** Attentes anormalement longues (anomalie de supervision). */
  stale: number;
  /** Prochain changement attendu (fin de bail, prochain essai), le plus proche. */
  waitingUntil: string | null;
  /** Compteurs par état réel. */
  counters: Record<string, number>;
  /** Lot 81B (B) : T6 indisponible — évaluations non exécutées, état explicite, reprise au rétablissement. */
  t6Unavailable?: boolean;
}

type T6EvaluationState = 'OK' | 'PENDING' | 'UNAVAILABLE';

/** Codes d'une échéance proche en attente d'évaluation. */
const EN_ATTENTE = new Set(['AI_ASSESSMENT_PENDING', 'AWAITING_REEVALUATION_AFTER_SNOOZE']);
/** Lot 71G : codes d'une décision PROVISOIRE (non évaluée, indisponible) — jamais une décision métier définitive. */
const T6_PROVISIONAL_CODES: ReadonlySet<string> = new Set([...EN_ATTENTE, 'EVALUATION_UNAVAILABLE', 'PREFERENCES_UNAVAILABLE', 'TO_PROCESS_UNAVAILABLE']);

/** État de l'évaluation des échéances proches (pure, testée T6-EV). */
export function evaluationStateOf(decisions: readonly T6DecisionResult[], opts: { degraded?: boolean; recentFailure?: boolean } = {}): T6EvaluationState {
  const proches = decisions.filter((d) => !d.thresholdApplied);
  if (proches.some((d) => d.code === 'EVALUATION_UNAVAILABLE')) return 'UNAVAILABLE';
  // Lot 71G (T6-06) : préférences illisibles — jamais « rien à signaler ».
  // Lot 72A (ATP-FIX-17) : « À traiter » illisible, idem.
  if (decisions.some((d) => d.code === 'PREFERENCES_UNAVAILABLE' || d.code === 'TO_PROCESS_UNAVAILABLE')) return 'UNAVAILABLE';
  if (proches.some((d) => EN_ATTENTE.has(d.code))) return opts.recentFailure || opts.degraded ? 'UNAVAILABLE' : 'PENDING';
  return 'OK';
}

/**
 * Lot 78C — état de l'évaluation des échéances proches d'après leur état
 * RÉEL (pure, testée). « En cours d'examen » (`PENDING`) seulement si chaque
 * échéance proche en attente est réellement demandée et prenable, ou en
 * cours d'exécution, depuis moins que le délai d'alerte ; un échec (essai
 * planifié, tentatives épuisées), une indisponibilité ou une attente
 * anormalement longue rendent `UNAVAILABLE` — jamais une attente fictive.
 */
export function evaluationStateFromRuns(
  decisions: ReadonlyArray<T6DecisionResult & { agendaItemId?: number }>, runs: ReadonlyMap<number, T6EffectiveRunState>,
  opts: { degraded?: boolean } = {},
): T6EvaluationState {
  const base = evaluationStateOf(decisions, { degraded: opts.degraded });
  if (base !== 'PENDING') return base;
  const attente = decisions.filter((d) => !d.thresholdApplied && EN_ATTENTE.has(d.code));
  return attente.some((d) => {
    const s = d.agendaItemId != null ? runs.get(d.agendaItemId) : undefined;
    return s != null && displayGroupOf(s) === 'UNAVAILABLE';
  }) ? 'UNAVAILABLE' : 'PENDING';
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
  /**
   * Lot 72A (AC02) : configuration EVALUATE courante (`t6EvaluationConfig`) —
   * invalide les décisions prises sous une autre ; conservée avec les
   * nouvelles. Absente ou en échec : aucune invalidation.
   */
  evaluationConfig?: (thresholdDays: number) => Promise<T6EvaluationConfig | null>;
  /**
   * Lot 78C : état durable des évaluations (`t6_evaluation_runs`). Absent ou
   * table non déployée : comportement du lot 77 (mémoire de l'instance).
   */
  runs?: T6RunLoaders | null;
  /** Lot 78C : horloge (tests). */
  now?: () => Date;
}

/** Lot 78C : lectures et demandes des exécutions durables. */
export interface T6RunLoaders {
  ready: () => Promise<boolean>;
  request: (accountId: number, subjects: readonly T6RunSubject[]) => Promise<number>;
  load: (accountId: number, ids: readonly number[]) => Promise<Map<number, T6RunRow>>;
  /**
   * Lot 81B (B) : T6 indisponible — évaluations éligibles enregistrées
   * UNAVAILABLE (`t6_unavailable`), reprises au rétablissement. Absent : rien
   * n'est enregistré (comportement du lot 78C).
   */
  markUnavailable?: (accountId: number, subjects: readonly T6RunSubject[]) => Promise<number[]>;
  /** Lot 81B (G) : décisions valides enregistrées dont l'état durable n'a pas été clos — clôture rattrapée. */
  reconcile?: (accountId: number, subjects: ReadonlyArray<{ agendaItemId: number; fingerprint: string | null }>) => Promise<number[]>;
}

export const T6_RUN_LOADERS: T6RunLoaders = {
  ready: t6RunsReady, request: requestT6Runs, load: loadT6Runs, markUnavailable: (a, s) => markT6RunsUnavailable(a, s),
  reconcile: reconcileT6RunsWithDecision,
};

/** Lot 71G : sources lues par la préparation, chacune isolément. */
export interface T6Loaders {
  /** Lot 75E (E) : lecture ciblée sur les candidats examinés (occurrences, séries). */
  preferences: (accountId: number, userId: number, scope: { agendaIds: readonly number[]; seriesKeys: readonly string[] }) => Promise<T6ReminderPreference[]>;
  assessments: (accountId: number, agendaIds: number[]) => Promise<Map<number, T6StoredAssessment>>;
  evidence: (accountId: number, agendaIds: number[]) => Promise<Map<number, T6ItemEvidence>>;
  dueReminders: (accountId: number, today: string) => Promise<Map<number, string>>;
  /** Lot 75E (D) : cycle persistant courant des candidats. */
  cycles: (accountId: number, agendaIds: number[]) => Promise<Map<number, string>>;
  /** Lot 75E (B) : examens achevés (curseur persistant). */
  examinations: (accountId: number, marks: readonly T6ExaminationMark[]) => Promise<number>;
  /** Lot 76A (AC10) : rebasage des décisions antérieures (`v2:`/`v3:`) au contexte inchangé. */
  rebaseFingerprints: (accountId: number, list: ReadonlyArray<{ agendaItemId: number; from: string; to: string }>) => Promise<number>;
}

const DEFAULT_LOADERS: T6Loaders = {
  preferences: (a, u, scope) => loadUserPreferences(a, u, scope), assessments: loadAssessments, evidence: loadT6Evidence,
  dueReminders: loadDueReminders, cycles: loadCycleKeys, examinations: recordT6Examinations,
  rebaseFingerprints: rebaseT6AssessmentFingerprints,
};

/** Motifs d'une réévaluation liée au seul vieillissement d'une décision (aucune donnée changée). */
const REEVALUATION_PAR_AGE = new Set<T6ReevaluationReason>(['AGED', 'REVIEW_DATE', 'LEGACY_FINGERPRINT', 'REMINDER_RENEWAL']);

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
      // Lot 75E (E) : lecture incomplète distinguée d'une panne (reporting).
      echecs.push((e as { source?: unknown }).source === 'preferences_incomplete' ? 'preferences_incomplete' : nom);
      return { ok: false, v: defaut };
    }
  };
  // Lot 75E (E) : préférences des candidats EFFECTIVEMENT examinés (occurrences et séries).
  const portee = {
    agendaIds: ids,
    seriesKeys: [...new Set(candidats.map((c) => c.candidate.seriesKey).filter((k): k is string => !!k))],
  };
  const [thresholdDays, aiCapableBrut, reminderCapable, prefsR, evalsR, preuvesR, echusR, cyclesR] = await Promise.all([
    deps.thresholdDays().catch(() => DEFAULT_T6_THRESHOLD_DAYS),
    deps.aiCapable().catch(() => false),
    deps.reminderCapable ? deps.reminderCapable().catch(() => false) : Promise.resolve(false),
    p.userId != null ? lire('preferences', () => L.preferences(p.accountId, p.userId!, portee), [] as T6ReminderPreference[]) : Promise.resolve({ ok: true, v: [] as T6ReminderPreference[] }),
    lire('assessments', () => L.assessments(p.accountId, ids), new Map<number, T6StoredAssessment>()),
    lire('evidence', () => L.evidence(p.accountId, ids), new Map<number, T6ItemEvidence>()),
    // Pré-génération du compte : reports arrivés à date (tous utilisateurs), réévalués sans visite.
    p.userId == null ? lire('dueReminders', () => L.dueReminders(p.accountId, today), new Map<number, string>()) : Promise.resolve({ ok: true, v: new Map<number, string>() }),
    // Lot 75E (D) : cycle persistant (préférences d'occurrence) ; illisible : préférences appliquées.
    p.userId != null ? lire('cycles', () => L.cycles(p.accountId, ids), new Map<number, string>()) : Promise.resolve({ ok: true, v: new Map<number, string>() }),
  ]);
  const prefs = prefsR.v;
  const evaluations = evalsR.v;
  // Lot 72A (AC02) : configuration EVALUATE courante (prompt, modèle, seuil).
  const evaluationConfig = deps.evaluationConfig ? await deps.evaluationConfig(thresholdDays).catch(() => null) : null;
  // Lot 72A (ATP-FIX-17) : « À traiter » illisible — actions ouvertes (toutes
  // les échéances) ou décisions qui règlent une échéance passée.
  const atpInconnu = p.raw.toProcessAgendaIds === null;
  const regleesInconnues = p.raw.toProcessSettledAgendaIds === null;
  if (atpInconnu) echecs.push('toProcess');
  if (regleesInconnues) echecs.push('toProcessSettled');
  // Évaluations illisibles : dégradation sans IA (préférences TOUJOURS appliquées).
  const aiCapable = aiCapableBrut && evalsR.ok;
  // Empreinte enrichie (T6-01) ; preuves illisibles : empreinte inconnue, aucune réévaluation.
  for (const { candidate: c, row: i } of candidats) {
    c.cycleKey = cyclesR.ok ? cyclesR.v.get(c.agendaItemId) ?? null : null;
    if (!preuvesR.ok) { c.fingerprintUnavailable = true; continue; }
    const e = preuvesR.v.get(c.agendaItemId);
    const ligne = { title: i.title, date: i.date, forecast: i.forecast, requiresQualification: i.requiresQualification };
    // Lot 76A (P1) : contexte RÉELLEMENT transmis (`v4:`, représentation commune) ;
    // `v3:` (lot 75E) et `v2:` (lot 71G) pour relire les décisions et reports antérieurs.
    c.fingerprint = t6ContextFingerprint(i, e);
    c.v3Fingerprint = fingerprintWithEvidence(ligne, e);
    c.v2Fingerprint = fingerprintV2WithEvidence(ligne, e);
    c.hasDocumentaryEvidence = (e?.facts.length ?? 0) > 0 || (e?.documents.length ?? 0) > 0;
    c.hasEvidence = c.hasDocumentaryEvidence || !!(e?.description ?? '').trim();
  }
  // Lot 76A (AC10) — transition sans réévaluation de masse : une décision
  // antérieure (`v2:`, `v3:`) dont le contexte est inchangé selon son
  // empreinte reste valable ; elle est REBASÉE sur l'empreinte courante pour
  // qu'un changement ultérieur des données désormais couvertes l'invalide.
  // Échec : sans effet sur la décision (nouvel essai au passage suivant).
  let rebased = 0;
  if (evalsR.ok && preuvesR.ok) {
    const aRebaser = candidats.flatMap(({ candidate: c }) => {
      const a = evaluations.get(c.agendaItemId);
      return a && /^v[23]:/.test(a.fingerprint) && sameT6Context(a.fingerprint, c) ? [{ agendaItemId: c.agendaItemId, from: a.fingerprint, to: c.fingerprint }] : [];
    });
    if (aRebaser.length > 0) {
      rebased = await L.rebaseFingerprints(p.accountId, aRebaser).catch((e) => {
        console.error('[mascotte] décision T6 : empreintes non rebasées —', (e as Error).message);
        return 0;
      });
    }
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

  // Lot 81B (B) : T6 INDISPONIBLE (désactivé, suspendu, prompt sans EVALUATE)
  // mais décisions lisibles — évaluations qui SERAIENT demandées, pour leur
  // donner un état explicite et une reprise au rétablissement.
  const t6Indisponible = !aiCapableBrut && evalsR.ok;
  const ombre = new Map<number, boolean>();
  const sansReevaluationParAge = (row: MascotAgendaRow, assessment: T6StoredAssessment | null, d0: T6DecisionResult) =>
    row.t6LongOverdue && assessment?.decision === 'SUPPRESS' && d0.needsAssessment && d0.reevaluationReason && REEVALUATION_PAR_AGE.has(d0.reevaluationReason);
  const decisions: T6DecisionTrace[] = candidats.map(({ candidate: c, row }) => {
    const assessment = evaluations.get(c.agendaItemId) ?? null;
    const displayedDays = historique.get(c.agendaItemId) ?? 0;
    // Lot 75E (C) : l'exception au seuil n'est retenue que si une preuve
    // concrète citée est RÉELLEMENT disponible (preuves lisibles seulement).
    const ev = preuvesR.ok ? preuvesR.v.get(c.agendaItemId) : undefined;
    const exceptionGrounded = assessment && preuvesR.ok
      ? exceptionEvidenceGrounded(assessment, { description: ev?.description ?? null, facts: ev?.facts ?? [] })
      : undefined;
    const entree = {
      candidate: c, today, thresholdDays, aiCapable, assessment,
      preferences: preferencesFor(prefs, c.agendaItemId, c.seriesKey, c.cycleKey ?? null),
      history: { displayedDays }, reminderCapable, preferencesUnavailable: !prefsR.ok, evaluationConfig,
      toProcessUnavailable: atpInconnu || (regleesInconnues && !!c.dueDate && c.dueDate <= today),
      exceptionGrounded,
    };
    const d0 = decideT6Interpellation(entree);
    if (t6Indisponible) {
      const o = decideT6Interpellation({ ...entree, aiCapable: true });
      ombre.set(c.agendaItemId, o.needsAssessment && !sansReevaluationParAge(row, assessment, o));
    }
    // Lot 75E (A) : échéance dépassée de longue date déjà ÉCARTÉE, données
    // inchangées — jamais réévaluée pour le seul vieillissement de la décision
    // (aucun appel répété) ; un changement de ses données la réévalue.
    const d = sansReevaluationParAge(row, assessment, d0)
      ? { ...d0, needsAssessment: false, reevaluationReason: null }
      : d0;
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
  let runStates: Map<number, T6EffectiveRunState> | null = null;
  let evaluationProgress: T6EvaluationProgress | null = null;
  if (aiCapable) {
    const horizon = addDays(today, assessmentHorizonDays(thresholdDays));
    const toutes = decisions
      .filter((d) => {
        const c = parId.get(d.agendaItemId)!.candidate;
        return d.needsAssessment && !!d.dueDate && !c.fingerprintUnavailable && (d.dueDate <= horizon || !!c.hasDocumentaryEvidence);
      })
      .map((d) => ({ d, rang: rangEvaluation(d, thresholdDays, !!parId.get(d.agendaItemId)!.candidate.hasDocumentaryEvidence) }))
      .sort((a, b) => a.rang - b.rang || (a.d.dueDate ?? '').localeCompare(b.d.dueDate ?? '') || a.d.agendaItemId - b.d.agendaItemId)
      .map((x) => x.d);
    // Lot 78C — étape « évaluation demandée » DURABLE, puis état RÉEL : seules
    // les évaluations prenables (ni en cours ailleurs, ni en attente d'un
    // essai planifié, ni en échec définitif) sont transmises ; les autres ont
    // un motif explicite (`runStates`). Table absente : lot 77.
    let eligibles = toutes;
    // Lot 81B (G) : décision valide déjà enregistrée (rien à demander) mais
    // état durable resté ouvert (clôture technique en échec) — rattrapé par la
    // pré-génération du compte (jamais une écriture à chaque affichage).
    const decidees = p.userId != null ? [] : decisions.filter((d) => !d.needsAssessment && d.assessmentFresh && !!d.fingerprint && !!d.assessment
      && d.assessment.fingerprint === d.fingerprint);
    if (deps.runs?.reconcile && decidees.length > 0 && await deps.runs.ready().catch(() => false)) {
      await deps.runs.reconcile(p.accountId, decidees.map((d) => ({ agendaItemId: d.agendaItemId, fingerprint: d.fingerprint ?? null })))
        .catch((e) => console.error('[mascotte] décision T6 : clôtures non rattrapées —', (e as Error).message));
    }
    if (deps.runs && toutes.length > 0 && await deps.runs.ready().catch(() => false)) {
      try {
        const sujets = toutes.map((d) => ({ agendaItemId: d.agendaItemId, fingerprint: d.fingerprint ?? null, signature: evaluationConfig?.signature ?? null }));
        await deps.runs.request(p.accountId, sujets);
        const lignes = await deps.runs.load(p.accountId, toutes.map((d) => d.agendaItemId));
        const maintenant = (deps.now ?? (() => new Date()))();
        runStates = new Map(toutes.map((d) => [d.agendaItemId, effectiveRunState(lignes.get(d.agendaItemId) ?? null, maintenant)]));
        eligibles = toutes.filter((d) => runStates!.get(d.agendaItemId)!.claimable);
      } catch (e) {
        // Repli du lot 77 (mémoire de l'instance) : jamais une source métier en panne.
        console.error('[mascotte] décision T6 : état des évaluations illisible —', (e as Error).message);
        runStates = null;
      }
    }
    const aEvaluer = eligibles.slice(0, T6_MAX_ASSESSMENTS_PER_CALL);
    pendingAssessments = eligibles.length - aEvaluer.length;
    if (runStates) {
      const etats = [...runStates.values()];
      const attentes = etats.map((x) => x.waitingUntil).filter((x): x is string => !!x).sort();
      evaluationProgress = {
        eligible: toutes.length, claimable: eligibles.length, inBundle: aEvaluer.length,
        waiting: etats.filter((x) => !x.claimable && x.state !== 'FAILED').length,
        failed: etats.filter((x) => x.state === 'FAILED').length,
        unavailable: etats.filter((x) => x.state === 'UNAVAILABLE').length,
        stale: etats.filter((x) => x.stale).length,
        waitingUntil: attentes[0] ?? null,
        counters: runStateCounters(etats),
      };
    }
    if (aEvaluer.length > 0) {
      const refs = new Map<string, T6CandidateRef>();
      const candidates: T6EvaluationCandidate[] = aEvaluer.map((d, k) => {
        const { candidate: c, row: i } = parId.get(d.agendaItemId)!;
        const subjectId = `C${k + 1}`;
        const ev = preuvesR.v.get(c.agendaItemId);
        // Lot 76A (P1) : MÊME construction que l'empreinte (`t6ContextFingerprint`).
        const { core, preuves } = evaluationSubjectOf(subjectId, i, ev);
        const description = core.description;
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
          subjectId, title: core.title, description,
          assetName: core.assetName, assetCategory: core.assetCategory,
          dueDate: core.dueDate, dateLabel: i.date ? formatDateFr(i.date) : null,
          daysUntilDue: d.daysUntilDue, dateNature: core.dateNature,
          dateRole: core.dateRole, overdue: !!i.date && i.date <= today, requiresQualification: core.requiresQualification,
          recurring: core.recurring, documents: preuves.documents,
          // T6-04 : clauses réellement extraites (extrait, document source, provenance, statut).
          ...(preuves.facts.length ? { facts: preuves.facts } : {}),
          recentlyShownDays: d.displayedDays, evidence,
        };
      });
      bundle = {
        context: { schemaVersion: T6_EVALUATION_INPUT_SCHEMA_VERSION, today, thresholdDays, candidates },
        refs,
        // Lot 72A : transaction du lot accepté ; signature de la configuration
        // EVALUATE conservée avec chaque décision (AC02).
        persist: async (list, meta): Promise<T6PersistResult> => {
          const r = await persistT6AssessmentsDetailed(p.accountId, today, refs, list, { ...meta, evaluationSignature: evaluationConfig?.signature ?? null });
          if (r.persisted > 0) deps.onAssessed?.(r.persisted);
          return r;
        },
        evaluationSignature: evaluationConfig?.signature ?? null,
      };
    }
  } else if (t6Indisponible && deps.runs?.markUnavailable && preuvesR.ok) {
    // Lot 81B (B) — T6 indisponible : les évaluations éligibles (mêmes règles
    // d'horizon et de preuve qu'en service) reçoivent un état EXPLICITE
    // (UNAVAILABLE `t6_unavailable`), jamais une absence ni un PENDING fictif ;
    // reprises dès le rétablissement par la pré-génération durable, sans
    // nouvelle visite. Aucun appel IA. Échec : comportement du lot 78C.
    const horizon = addDays(today, assessmentHorizonDays(thresholdDays));
    const sujets: T6RunSubject[] = candidats
      .filter(({ candidate: c }) => ombre.get(c.agendaItemId) === true && !!c.dueDate && !c.fingerprintUnavailable
        && (c.dueDate <= horizon || !!c.hasDocumentaryEvidence))
      .map(({ candidate: c }) => ({ agendaItemId: c.agendaItemId, fingerprint: c.fingerprint ?? null, signature: evaluationConfig?.signature ?? null }));
    if (sujets.length > 0 && await deps.runs.ready().catch(() => false)) {
      try {
        await deps.runs.markUnavailable(p.accountId, sujets);
        const lignes = await deps.runs.load(p.accountId, sujets.map((x) => x.agendaItemId));
        const maintenant = (deps.now ?? (() => new Date()))();
        runStates = new Map(sujets.map((x) => [x.agendaItemId, effectiveRunState(lignes.get(x.agendaItemId) ?? null, maintenant)]));
        const etats = [...runStates.values()];
        const attentes = etats.map((x) => x.waitingUntil).filter((x): x is string => !!x).sort();
        // Rien n'est prenable tant que T6 est indisponible : attente jusqu'à
        // la prochaine vérification (aucun essai consommé, aucune boucle).
        const verification = new Date(maintenant.getTime() + T6_RUN_UNAVAILABLE_RECHECK_S * 1000).toISOString();
        evaluationProgress = {
          eligible: sujets.length, claimable: 0, inBundle: 0,
          waiting: etats.filter((x) => x.state !== 'FAILED').length,
          failed: etats.filter((x) => x.state === 'FAILED').length,
          unavailable: etats.filter((x) => x.state === 'UNAVAILABLE').length,
          stale: etats.filter((x) => x.stale).length,
          waitingUntil: attentes.find((x) => x > maintenant.toISOString()) ?? verification,
          counters: runStateCounters(etats),
          t6Unavailable: true,
        };
      } catch (e) {
        console.error('[mascotte] décision T6 : indisponibilité des évaluations non enregistrée —', (e as Error).message);
        runStates = null;
      }
    }
  }

  // Lot 75E (B) — curseur d'examen PERSISTANT de la lecture complémentaire :
  // pré-génération du compte seulement (décisions sans préférence
  // personnelle), sources lues, IA disponible. Une échéance DUE dont
  // l'examen est achevé (décision utilisable, rien à demander à l'IA, ou
  // hors horizon d'évaluation) laisse sa place ; une échéance à évaluer
  // (plafond de 8, évaluation en cours ou en échec) reste en tête de file.
  let examined = 0;
  if (p.userId == null && aiCapable && preuvesR.ok && !atpInconnu) {
    const horizonJours = assessmentHorizonDays(thresholdDays);
    const demain = addDays(today, 1);
    const enAttente = new Set(bundle ? [...bundle.refs.values()].map((x) => x.agendaItemId) : []);
    const marks: T6ExaminationMark[] = [];
    for (const d of decisions) {
      const { candidate: c, row } = parId.get(d.agendaItemId)!;
      if (!row.t6Due || !row.t6SelectionSignature || enAttente.has(d.agendaItemId)) continue;
      if (T6_PROVISIONAL_CODES.has(d.code) && !d.needsAssessment) continue;
      const horsHorizon = d.needsAssessment && !!d.dueDate && d.dueDate > addDays(today, horizonJours) && !c.hasDocumentaryEvidence;
      if (d.needsAssessment && !horsHorizon) continue; // à évaluer : reste dans la file
      const a = d.assessment;
      const recheck = horsHorizon
        ? addDays(d.dueDate!, -horizonJours)
        // Dépassée de longue date et écartée : réexaminée seulement si ses données changent.
        : row.t6LongOverdue && a?.decision === 'SUPPRESS' ? null
          : [d.nextReevaluationAt, a?.reevaluateOn ?? null, a ? addDays(a.assessedOn, T6_ASSESSMENT_MAX_AGE_DAYS + 1) : addDays(today, T6_ASSESSMENT_MAX_AGE_DAYS)]
            .filter((x): x is string => !!x && x > today).sort()[0] ?? addDays(today, T6_ASSESSMENT_MAX_AGE_DAYS);
      marks.push({ agendaItemId: d.agendaItemId, selectionSignature: row.t6SelectionSignature, fingerprint: c.fingerprintUnavailable ? null : c.fingerprint, recheckOn: recheck && recheck < demain ? demain : recheck });
    }
    examined = await L.examinations(p.accountId, marks).catch((e) => {
      console.error('[mascotte] décision T6 : examens non enregistrés —', (e as Error).message);
      return 0;
    });
  }

  const degraded = echecs.length > 0;
  // Évaluations illisibles (T6-06) : dégradation explicite — jamais « rien à signaler ».
  // Lot 78C : d'après l'état RÉEL des évaluations quand il est connu ; sinon
  // (table non déployée, lecture en échec) échec récent de l'instance (lot 77).
  const evaluation = runStates
    ? evaluationStateFromRuns(decisions, runStates, { degraded: degraded && !evalsR.ok })
    : evaluationStateOf(decisions, { degraded: degraded && !evalsR.ok, recentFailure: aiCapable && (deps.recentEvaluationFailure?.(p.accountId) ?? false) });
  return {
    thresholdDays, aiCapable, shown, decisions, notInterpellated, userSilenced, discarded, bundle, degraded, evaluation,
    failedSources: echecs, pendingAssessments, examined, selectionBacklog: p.raw.t6AgendaBacklog === true,
    evaluationSignature: evaluationConfig?.signature ?? null, rebased, runStates, evaluationProgress,
    // Lot 87C : preuves DÉJÀ lues pour la décision, réutilisées par les fondements des questions suggérées.
    evidence: preuvesR.ok ? preuvesR.v : null,
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
type T6DecisionOutcome = 'INFORMATIVE_REMINDER' | 'ACTION' | 'USER_SNOOZED' | 'USER_DISMISSED' | 'DEFERRED' | 'SUPPRESSED';
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

export function t6ReportEntries(
  decisions: readonly T6DecisionTrace[], thresholdDays: number,
  /** Lot 78C : état réel de l'évaluation de chaque échéance éligible. */
  runStates?: ReadonlyMap<number, T6EffectiveRunState> | null,
): ReportEntry[] {
  const out: ReportEntry[] = [];
  for (const d of decisions) {
    const a = d.assessment;
    const run = runStates?.get(d.agendaItemId) ?? null;
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
          refs: a.evidenceSnapshot.refs.map((x) => ({ ref: x.ref, kind: x.kind, fileId: x.fileId ?? null, extractionId: x.extractionId ?? null, factId: x.factId ?? null, status: x.status ?? null })),
          assessedWithFingerprint: (a.evidenceSnapshot.fingerprint ?? a.fingerprint).slice(0, 16),
          reevaluationReason: a.reevaluationReason ?? null,
        } : null,
        failure: d.code === 'PREFERENCES_UNAVAILABLE' ? 'preferences' : d.code === 'EVALUATION_UNAVAILABLE' ? 'evaluation'
          : d.code === 'THRESHOLD_EXCEPTION_UNPROVEN' ? 'exception_evidence'
          : d.code === 'TO_PROCESS_UNAVAILABLE' ? 'toProcess' : null,
        // Lot 78C : état RÉEL de l'évaluation (jamais déduit de l'absence de décision).
        ...(run ? {
          evaluationRun: {
            state: run.state, claimable: run.claimable, attempts: run.attempts, lastErrorKind: run.lastErrorKind,
            nextAttemptAt: run.nextAttemptAt, waitingUntil: run.waitingUntil, interrupted: run.interrupted, stale: run.stale,
          },
        } : {}),
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
  /**
   * Lot 87C : questions suggérées du passage — prompt compatible ou non avec
   * le contrat des questions fondées, origine (génération, cache), nombres
   * produits / acceptés / rejetés / retirés et motifs structurés. Aucune
   * question ni donnée personnelle. Absent ou null : aucune question demandée.
   */
  suggestions?: {
    supported: boolean; contract: string | null; source: 'generated' | 'cache' | 'none';
    produced: number; accepted: number; rejected: number; invalidated: number; reasons: Record<string, number>;
  } | null;
}

/** Lignes FORMULATE du rapport (pure) : sujets transmis et affichés, secours. */
export function t6FormulateEntries(f: T6FormulateTrace): ReportEntry[] {
  const q = f.suggestions ?? null;
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
  }, ...(q ? [{
    // Lot 87C : une génération « validée » ne masque jamais les questions rejetées.
    section: 'FORMULATE',
    fieldKey: 'suggestions', label: 'Questions suggérées (contrat des questions fondées)',
    value: { ...q },
    recordStatus: !q.supported ? 'PROMPT_UNSUPPORTED' : q.rejected > 0 || q.invalidated > 0 ? 'PARTIAL' : q.accepted > 0 ? 'ACCEPTED' : 'NONE',
    writeResult: 'NOT_WRITTEN' as const,
    reasonCode: !q.supported ? 'PROMPT_UNSUPPORTED' : Object.keys(q.reasons).sort().join(',') || null,
    reason: !q.supported
      ? 'Prompt maître effectif sans le contrat des questions fondées : aucune question publiée.'
      : `${q.accepted} question(s) affichée(s), ${q.rejected} rejetée(s), ${q.invalidated} retirée(s) — aucune question n’est une anomalie.`,
  }] : [])];
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
      ...t6ReportEntries(p.prep.decisions, p.prep.thresholdDays, p.prep.runStates),
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
        // Lot 87C : questions suggérées produites, acceptées, rejetées, retirées (fondements devenus invalides).
        ...(p.formulate?.suggestions ? {
          suggestionsProduced: p.formulate.suggestions.produced, suggestionsAccepted: p.formulate.suggestions.accepted,
          suggestionsRejected: p.formulate.suggestions.rejected, suggestionsInvalidated: p.formulate.suggestions.invalidated,
        } : {}),
        // Lot 71G : décisions provisoires (non évaluées, indisponibles) séparées des décisions définitives.
        provisional: p.prep.decisions.filter((d) => T6_PROVISIONAL_CODES.has(d.code)).length,
        finalDecisions: p.prep.decisions.filter((d) => !T6_PROVISIONAL_CODES.has(d.code)).length,
        pendingAssessments: p.prep.pendingAssessments ?? 0,
        // Lot 75E (B, C) : examens achevés (curseur), file plus longue que la lecture, exceptions au seuil sans preuve.
        examined: p.prep.examined ?? 0, selectionBacklog: p.prep.selectionBacklog ? 1 : 0,
        thresholdExceptionsUnproven: p.prep.decisions.filter((d) => d.code === 'THRESHOLD_EXCEPTION_UNPROVEN').length,
        // Lot 76A : invalidations par motif (preuves / configuration EVALUATE) et décisions rebasées (transition).
        invalidatedContext: p.prep.decisions.filter((d) => d.needsAssessment && d.reevaluationReason === 'CONTEXT_CHANGED').length,
        invalidatedConfig: p.prep.decisions.filter((d) => d.needsAssessment && d.reevaluationReason === 'CONFIG_CHANGED').length,
        rebased: p.prep.rebased ?? 0,
        // Lot 78C : états réels des évaluations éligibles.
        ...(p.prep.evaluationProgress ? {
          runsPending: p.prep.evaluationProgress.counters.PENDING ?? 0, runsRunning: p.prep.evaluationProgress.counters.RUNNING ?? 0,
          runsRetryWait: p.prep.evaluationProgress.counters.RETRY_WAIT ?? 0, runsFailed: p.prep.evaluationProgress.failed,
          runsUnavailable: p.prep.evaluationProgress.unavailable, runsStale: p.prep.evaluationProgress.stale,
        } : {}),
      },
      steps: [
        { step: 'candidates', status: 'OK', detail: { count: p.prep.decisions.length } },
        { step: 'decision', status: p.prep.degraded ? 'FAILED' : 'OK',
          // Lot 71G (T6-06) : source défaillante tracée précisément.
          error: p.prep.degraded ? `lectures indisponibles (${(p.prep.failedSources ?? []).join(', ') || 'inconnue'}) : décision prudente` : null,
          detail: {
            thresholdDays: p.prep.thresholdDays, aiCapable: p.prep.aiCapable, evaluation: p.prep.evaluation, failedSources: p.prep.failedSources ?? [],
            pendingAssessments: p.prep.pendingAssessments ?? 0,
            // Lot 75E (E) : préférences illisibles ou lues incomplètement — aucun sujet réintroduit.
            preferencesUnverified: (p.prep.failedSources ?? []).some((x) => x === 'preferences' || x === 'preferences_incomplete'),
            examined: p.prep.examined ?? 0, selectionBacklog: p.prep.selectionBacklog === true,
            // Lot 76A : configuration EVALUATE sous laquelle les décisions sont valables.
            evaluationSignature: p.prep.evaluationSignature ?? null,
            // Lot 78C : avancement réel des évaluations (prochain changement attendu).
            evaluationProgress: p.prep.evaluationProgress ? { ...p.prep.evaluationProgress } : null,
          } },
        { step: 'assessment_request', status: p.prep.bundle ? 'OK' : 'SKIPPED', detail: { mode: 'EVALUATE', candidates: p.prep.bundle?.refs.size ?? 0 } },
        { step: 'formulate', status: p.formulate ? 'OK' : 'SKIPPED', detail: p.formulate ? {
          mode: 'FORMULATE', promptVersion: p.formulate.promptVersion, contract: p.formulate.contract, source: p.formulate.source, status: p.formulate.status,
          // Lot 87C : contrat des questions et issue (aucune question n'est pas un échec).
          suggestions: p.formulate.suggestions ?? null,
        } : null },
      ],
      sources: { thresholdDays: p.prep.thresholdDays, aiCapable: p.prep.aiCapable, userPreferences: p.userId != null, evaluation: p.prep.evaluation },
    }, entries);
  } catch (e) {
    console.error('[mascotte] rapport T6 non écrit :', (e as Error).message);
    return null;
  }
}

// ── Reporting EVALUATE (lot 61) ──────────────────────────────────────────────

/** Issue d'une exécution EVALUATE, telle que tracée (aucune donnée personnelle). */
interface T6EvaluationTrace {
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
  /**
   * Lot 72A (AC05, AC08) : décisions acceptées RÉELLEMENT enregistrées
   * (`null` : inconnu — persistance qui ne rend qu'un nombre) et celles qui
   * ne l'ont pas été, avec leur motif (`write_failed`, `not_written`).
   */
  persistedSubjectIds?: string[] | null;
  notPersisted?: Array<{ subjectId: string; reason: string }>;
  /** Lot 72A (AC08) : mode d'appel déclaré à la passerelle (`displayed` / `pregeneration`). */
  callerMode?: 'displayed' | 'pregeneration' | null;
  /** Lot 78C : exécution durable (prise, tentatives, état écrit à la clôture). */
  run?: import('./t6-runner').T6EvaluationRunTrace | null;
}

/** Lot 72A — issue du runner → trace du reporting (pure, sans donnée personnelle). */
export function t6EvaluationTraceOf(o: import('./t6-runner').T6EvaluationOutcome): T6EvaluationTrace {
  return {
    status: o.status, promptVersion: o.promptVersion, inputContract: T6_EVALUATION_INPUT_SCHEMA_VERSION, outputContract: T6_ASSESSMENT_CONTRACT,
    traceId: o.traceId ?? null, error: o.error ?? null, persisted: o.persisted,
    accepted: o.accepted.map((d) => ({ subjectId: d.subjectId, decision: d.decision, category: d.category, reasonCode: d.reasonCode, priorityHint: d.priorityHint, evidenceRefs: d.evidenceRefs })),
    rejected: o.rejected.map((r) => ({ subjectId: r.subjectId, reason: r.reason })),
    persistedSubjectIds: o.persistedSubjectIds ?? null, notPersisted: o.notPersisted ?? [], callerMode: o.callerMode ?? null,
    run: o.run ?? null,
  };
}

/** Une décision acceptée a-t-elle été enregistrée (pure) ? Détail connu, sinon le compte global. */
function ecrite(t: T6EvaluationTrace, subjectId: string): boolean {
  if (t.notPersisted?.some((x) => x.subjectId === subjectId)) return false;
  if (t.persistedSubjectIds) return t.persistedSubjectIds.includes(subjectId);
  return t.persisted >= t.accepted.length;
}

/** Lot 81B (G) : refus de prise sans exécution (exécution vivante ailleurs, essai planifié, délai anti-boucle). */
const REFUS_SANS_EXECUTION = new Set(['running_elsewhere', 'retry_wait', 'cooldown']);

/**
 * Lot 81B (G) — la clôture technique de l'exécution durable est-elle
 * COMPLÈTE (pure) ? Chaque évaluation prise a reçu son état ; `true` sans
 * exécution durable (table non déployée).
 */
export function t6RunClosed(t: Pick<T6EvaluationTrace, 'run'>): boolean {
  if (!t.run?.claimed) return true;
  return !!t.run.finished && (t.run.notClosed?.length ?? 0) === 0 && !t.run.closeError;
}

/**
 * Statut de l'exécution EVALUATE au reporting (pure) — jamais SUCCESS sans
 * écriture complète (AC05). Lot 81B (G) : calculé sur la validation, la
 * persistance métier ET la clôture technique — SUCCESS seulement si les trois
 * ont abouti ; PARTIAL si une partie est enregistrée (décisions écrites mais
 * clôture en échec, rejets, écriture partielle, dépossession partielle) ;
 * FAILED si rien d'exploitable n'est enregistré ; NO_CHANGE pour un refus de
 * prise sans exécution (tracé, motif et instant attendu).
 */
export function t6EvaluationReportStatus(t: T6EvaluationTrace): 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'NO_CHANGE' {
  if (t.status === 'skipped' && t.run && !t.run.claimed && REFUS_SANS_EXECUTION.has(t.run.refusal?.reason ?? '')) return 'NO_CHANGE';
  let s: 'SUCCESS' | 'PARTIAL' | 'FAILED';
  if (t.status === 'generated') s = t.rejected.length || (t.notPersisted?.length ?? 0) ? 'PARTIAL' : 'SUCCESS';
  else if (t.status === 'partially_persisted') s = 'PARTIAL';
  else s = 'FAILED';
  if (s === 'SUCCESS' && (!t6RunClosed(t) || (t.run?.ownershipLost?.length ?? 0) > 0)) s = 'PARTIAL';
  return s;
}

/** Mode d'exécution lisible (AC08) : à l'affichage ou en pré-génération. */
const executionModeOf = (callerMode: T6EvaluationTrace['callerMode'], mode: string) =>
  (callerMode ?? (mode === 'display' ? 'displayed' : 'pregeneration')) === 'displayed' ? 'DISPLAY' as const : 'PREGENERATION' as const;

/**
 * Lignes du rapport EVALUATE (pure) : une par candidat évalué — décision
 * validée et enregistrée, validée NON enregistrée, rejetée (motif), ou
 * évaluation indisponible (lot 72A).
 */
/** Lot 78C : état durable d'une échéance à la clôture de l'exécution (pure). */
function runOf(t: T6EvaluationTrace, agendaItemId: number) {
  if (!t.run) return null;
  const f = t.run.finished?.find((x) => x.agendaItemId === agendaItemId) ?? null;
  const res = t.run.results?.find((x) => x.agendaItemId === agendaItemId) ?? null;
  return {
    runId: t.run.runId, attempt: t.run.attempts?.[agendaItemId] ?? f?.attempts ?? null,
    // `null` : clôture non enregistrée (l'évaluation sera reprise à l'expiration du bail).
    status: f?.status ?? null, nextAttemptAt: f?.nextAttemptAt ?? null,
    errorKind: res?.errorKind ?? null, interrupted: (t.run.interrupted ?? []).includes(agendaItemId),
    // Lot 81B (D, G) : clôture écrite ou non, propriété perdue.
    closed: !!f, ownershipLost: (t.run.ownershipLost ?? []).includes(agendaItemId),
  };
}

export function t6EvaluationEntries(t: T6EvaluationTrace, refs: T6InterpellationBundle['refs']): ReportEntry[] {
  const out: ReportEntry[] = [];
  for (const [subjectId, c] of refs) {
    const a = t.accepted.find((x) => x.subjectId === subjectId);
    const r = t.rejected.find((x) => x.subjectId === subjectId);
    const np = t.notPersisted?.find((x) => x.subjectId === subjectId);
    const ok = !!a && ecrite(t, subjectId);
    // Lot 78C : empreinte du contexte évalué et état durable de l'évaluation.
    const commun = { contextFingerprint: c.fingerprint ? c.fingerprint.slice(0, 16) : null, ...(t.run ? { run: runOf(t, c.agendaItemId) } : {}) };
    out.push({
      section: 'EVALUATE',
      tableName: 'agenda_items', recordId: c.agendaItemId, fieldKey: c.subjectKey,
      label: `Échéance #${c.agendaItemId} (${subjectId})`, entityType: 'AGENDA_ITEM', entityId: c.agendaItemId,
      value: a ? {
        subjectId, decision: a.decision, category: a.category, reasonCode: a.reasonCode, priorityHint: a.priorityHint, evidenceRefs: a.evidenceRefs,
        informativeReminder: a.decision === 'SHOW_NOW' && a.category === 'INFORMATION',
        persisted: ok, ...(ok ? {} : { notPersisted: np?.reason ?? 'not_written' }), ...commun,
      }
        : { subjectId, rejected: r?.reason ?? t.error ?? t.status, ...commun },
      // Lot 72A : décision validée enregistrée / non enregistrée, rejetée, indisponible.
      recordStatus: a ? (ok ? a.decision : 'NOT_PERSISTED') : r ? 'REJECTED' : 'UNAVAILABLE',
      writeResult: ok ? 'WRITTEN' : 'NOT_PERSISTED',
      reasonCode: a ? (ok ? a.reasonCode : `PERSISTENCE:${np?.reason ?? 'not_written'}`) : r ? `VALIDATION:${r.reason}` : t.status.toUpperCase(),
      reason: a ? (ok ? 'Décision IA validée, conservée (cache des évaluations).'
        : 'Décision IA validée mais NON enregistrée : jamais utilisée, candidat en attente (reprise différée).')
        : r ? `Décision rejetée par la validation (${r.reason}) : candidat en attente, jamais affiché d’office.`
          : `Évaluation non obtenue (${t.status}${t.error ? ` : ${t.error.slice(0, 120)}` : ''}) : candidat en attente.`,
    });
  }
  return out;
}

/** Rapport d'une exécution EVALUATE (BO › Exécutions IA › Rapports). Ne lève jamais. */
/** Lot 78C : état de la pré-génération du compte (reporting). Ne lève jamais. */
async function readPregenState(accountId: number): Promise<Record<string, unknown> | null> {
  try {
    const [r] = await rows(
      `SELECT last_status, reason, attempts, requested_at, processed_at, claimed_until,
              (processed_at IS NULL OR requested_at > processed_at) AS pending,
              -- Lot 81B (C, 0629) : épuisements, lus sans dépendre des colonnes.
              to_jsonb(r) ->> 'exhausted_count' AS exhausted_count, to_jsonb(r) ->> 'exhausted_at' AS exhausted_at
         FROM home_mascot_pregen_requests r WHERE account_id = $1`,
      [accountId],
    );
    if (!r) return { exists: false };
    const d = (v: unknown) => (v == null ? null : new Date(String(v instanceof Date ? v.toISOString() : v)).toISOString());
    return {
      exists: true, pending: r.pending === true, lastStatus: (r.last_status as string | null) ?? null, reason: (r.reason as string | null) ?? null,
      // Lot 81B (C) : tentatives de la DEMANDE (distinctes de celles des évaluations, par échéance).
      attempts: Number(r.attempts ?? 0), requestedAt: d(r.requested_at), processedAt: d(r.processed_at), claimedUntil: d(r.claimed_until),
      exhaustedCount: r.exhausted_count == null ? null : Number(r.exhausted_count), exhaustedAt: d(r.exhausted_at),
    };
  } catch {
    return null;
  }
}

export async function writeT6EvaluationReport(p: {
  accountId: number; mode: string; bundle: T6InterpellationBundle; trace: T6EvaluationTrace;
  /** Lot 78C : lecture de l'état de la pré-génération (injectable). */
  pregenState?: (accountId: number) => Promise<Record<string, unknown> | null>;
}): Promise<number | null> {
  try {
    const repo = await import('@/services/ai/execution-report/repository');
    if (!(await repo.executionReportsReady())) return null;
    const t = p.trace;
    const pregen = await (p.pregenState ?? readPregenState)(p.accountId).catch(() => null);
    const fins = t.run?.finished ?? [];
    const parEtat = (k: string) => fins.filter((f) => f.status === k).length;
    const compte = (k: string) => t.accepted.filter((d) => d.decision === k).length;
    const notPersisted = t.accepted.filter((d) => !ecrite(t, d.subjectId)).length;
    const callerMode = t.callerMode ?? (p.mode === 'display' ? 'displayed' : 'pregeneration');
    const executionMode = executionModeOf(t.callerMode, p.mode);
    const evalOk = ['generated', 'partially_persisted', 'persist_failed'].includes(t.status);
    const statut = t6EvaluationReportStatus(t);
    const entries = t6EvaluationEntries(t, p.bundle.refs);
    // Lot 81B (G) : refus, indisponibilité, prise impossible — tracés, mais pas
    // à chaque affichage identique (même issue que le dernier rapport : rien).
    if (!t.run?.claimed && !evalOk) {
      const empreinte = entriesFingerprint(entries);
      const [prev] = await rows(
        `SELECT entries_fingerprint FROM ai_execution_reports
          WHERE account_id = $1 AND treatment = 'T6' AND trigger_code = $2 ORDER BY id DESC LIMIT 1`,
        [p.accountId, `evaluate:${p.mode}`],
      );
      if (prev && prev.entries_fingerprint === empreinte) return null;
    }
    const refus = t.run && !t.run.claimed ? t.run.refusal ?? null : null;
    const cloture = t6RunClosed(t);
    return await repo.writeExecutionReport({
      accountId: p.accountId, treatment: 'T6', scope: 'HOME', targetType: null, targetId: null,
      triggerCode: `evaluate:${p.mode}`, traceIds: t.traceId ? [t.traceId] : [],
      // Lot 72A (AC05) : statut RÉEL — écriture comprise ; lot 81B (G) : clôture technique comprise.
      status: statut,
      counters: {
        evaluated: p.bundle.refs.size, accepted: t.accepted.length, rejected: t.rejected.length, persisted: t.persisted, notPersisted,
        showNow: compte('SHOW_NOW'), defer: compte('DEFER'), suppress: compte('SUPPRESS'),
        // Lot 68 : SHOW_NOW + INFORMATION (rappel informatif), jamais compté comme action.
        showNowInformation: t.accepted.filter((d) => d.decision === 'SHOW_NOW' && d.category === 'INFORMATION').length,
        // Lot 78C : état écrit à la clôture de chaque évaluation.
        ...(t.run ? {
          runCompleted: parEtat('COMPLETED'), runRetryWait: parEtat('RETRY_WAIT'), runFailed: parEtat('FAILED'),
          runUnavailable: parEtat('UNAVAILABLE'), runInterrupted: (t.run.interrupted ?? []).length,
          // Lot 81B : clôtures non écrites, dépossessions, renouvellements du bail, indisponibilité T6.
          runNotClosed: t.run.claimed ? (t.run.finished ? (t.run.notClosed ?? []).length : (t.run.results ?? []).length) : 0,
          runOwnershipLost: (t.run.ownershipLost ?? []).length, runRenewals: t.run.renewals ?? 0,
          runT6Unavailable: (t.run.unavailable ?? []).length,
        } : {}),
      },
      steps: [
        {
          step: 'evaluate',
          // Lot 81B (G) : refus de prise sans exécution — étape ignorée, motif tracé.
          status: evalOk ? 'OK' as const : statut === 'NO_CHANGE' ? 'SKIPPED' as const : 'FAILED' as const, error: evalOk ? null : t.error,
          detail: {
            mode: 'EVALUATE', promptVersion: t.promptVersion, inputContract: t.inputContract, outputContract: t.outputContract, callerMode, executionMode,
            ...(refus ? { refusal: refus } : {}),
          },
        },
        ...(evalOk && t.accepted.length > 0 ? [{
          step: 'persist', status: t.status === 'persist_failed' ? 'FAILED' as const : 'OK' as const,
          error: t.status === 'persist_failed' ? (t.error ?? 'décisions non enregistrées')
            : notPersisted > 0 ? `écriture partielle : ${notPersisted} décision(s) non enregistrée(s)` : null,
          detail: { persisted: t.persisted, notPersisted, transactional: true },
        }] : []),
        // Lot 78C : prise en charge et clôture durables (statut réel, tentatives, prochain essai).
        ...(t.run?.claimed ? [{
          step: 'run_state', status: cloture ? 'OK' as const : 'FAILED' as const,
          error: cloture ? null
            : !t.run.finished ? `état d’exécution non enregistré${t.run.closeError ? ` (${t.run.closeError.slice(0, 160)})` : ''} : reprise à l’expiration du bail`
              : `clôture non écrite pour ${(t.run.notClosed ?? []).length} évaluation(s) : exécution dépossédée`,
          detail: {
            runId: t.run.runId, attempts: t.run.attempts ?? {}, interrupted: t.run.interrupted ?? [],
            finished: fins.map((f) => ({ agendaItemId: f.agendaItemId, status: f.status, attempts: f.attempts, nextAttemptAt: f.nextAttemptAt, errorKind: f.errorKind })),
            notClosed: t.run.notClosed ?? [], ownershipLost: t.run.ownershipLost ?? [], renewals: t.run.renewals ?? 0,
            closeError: t.run.closeError ?? null,
          },
        }] : []),
        // Lot 81B (B, G) : prise refusée / T6 indisponible — motif, instant attendu, évaluations marquées.
        ...(t.run && !t.run.claimed ? [{
          step: 'run_state', status: 'SKIPPED' as const, error: null,
          detail: { claimed: false, refusal: t.run.refusal ?? null, unavailable: t.run.unavailable ?? [] },
        }] : []),
      ],
      sources: { mode: 'EVALUATE', promptVersion: t.promptVersion, callerMode, executionMode, runId: t.run?.runId ?? null, pregen },
    }, entries);
  } catch (e) {
    console.error('[mascotte] rapport EVALUATE non écrit :', (e as Error).message);
    return null;
  }
}
