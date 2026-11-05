/**
 * Journal BO « Questions sans réponse » — lot 110E (ticket « T2 : réponses
 * issues des Ressources », §5).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * AUCUN JOURNAL CONCURRENT
 *
 * Les OCCURRENCES sont les traces T2 déjà écrites à chaque demande
 * (`verebona_request_runs`, dans la transaction de l'historique, sans
 * bloquer la réponse) : leur bloc `resources` (lot 110E) porte l'origine
 * (question libre / suggestion et son identifiant), le corpus et sa version,
 * l'environnement, la révision applicative, les sections examinées avec leur
 * score et le verdict de la garde, la sélection, l'issue et le MOTIF. Les
 * demandes plus anciennes (sans bloc) sont classées par leurs champs
 * historiques (motif de repli de l'aide, nombre de sources, état final).
 * Une demande = une ligne : aucune écriture supplémentaire, donc aucune
 * duplication à chaque repli ou rechargement.
 *
 * Seule la DÉCISION de revue est écrite (`t2_unanswered_reviews`, migration
 * 1185) : statut À analyser / À corriger / Résolu, par groupe de questions
 * proches.
 *
 * CONFIDENTIALITÉ
 *
 *   · question : texte EXPURGÉ (`expurgerQuestion`), et seulement tant que le
 *     message est conservé (fil actif, non expiré — même règle que §10.4) ;
 *     jamais de compte ni d'utilisateur, jamais de texte d'article ;
 *   · fenêtre de lecture bornée par la durée de l'historique de l'assistant
 *     (`retentionPolicy().conversationDays`, réglage BO / variable
 *     `VEREBONA_ASSISTANT_HISTORY_DAYS`) ; statuts purgés à la même durée ;
 *   · lien vers la trace : identifiant de demande, ouvert par les routes BO
 *     existantes (sources sans contenu ; contenu sur justification, accès
 *     restreint et journalisé).
 *
 * MOTIFS (distincts) : couverture absente, couverture partielle, recherche
 * ayant raté une source existante, données du compte insuffisantes,
 * contradiction / ambiguïté, corpus indisponible, alerte qualité (réponse
 * produite mais source la mieux notée hors sujet). Le repérage automatique
 * des hors-sujet n'est PAS exhaustif : l'alerte qualité est un signal à
 * revoir, pas une mesure complète.
 *
 * Lot 111K : les demandes sur les DONNÉES DU COMPTE portent le bloc
 * `pertinence` (même trace) : motif dans ce vocabulaire, cause précise en
 * `fallbackReason` (`PERTINENCE:NO_DATA`, `EVIDENCE_REJECTED`,
 * `EVIDENCE_UNCERTAIN`, `REAL_CONFLICT`, `PRODUCTION_REJECTED`) ; une réponse
 * rejetée par le contrôle final est une alerte qualité.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'node:crypto';
import { HELP_INTENTS } from './help-corpus.service';
import { classifyUnanswered, expurgerQuestion } from './unanswered-help.repository';
import type { ResourcesTrace, UnansweredMotive } from './resources-answer';
import type { PertinenceTrace } from './pertinence-trace';

export const JOURNAL_MOTIVES: readonly UnansweredMotive[] = [
  'COVERAGE_ABSENT', 'PARTIAL_COVERAGE', 'RETRIEVAL_MISSED', 'ACCOUNT_DATA_INSUFFICIENT',
  'CONTRADICTION_AMBIGUITY', 'CORPUS_UNAVAILABLE', 'QUALITY_ALERT',
];

export const JOURNAL_MOTIVE_LABELS: Readonly<Record<UnansweredMotive, string>> = {
  COVERAGE_ABSENT: 'Couverture absente',
  PARTIAL_COVERAGE: 'Couverture partielle',
  RETRIEVAL_MISSED: 'Recherche ayant raté une source existante',
  ACCOUNT_DATA_INSUFFICIENT: 'Données du compte insuffisantes',
  CONTRADICTION_AMBIGUITY: 'Contradiction ou ambiguïté',
  CORPUS_UNAVAILABLE: 'Corpus indisponible',
  QUALITY_ALERT: 'Alerte qualité (réponse peut-être hors sujet)',
};

/** Ce que chaque motif aide à décider (BO). */
export const JOURNAL_MOTIVE_HINTS: Readonly<Record<UnansweredMotive, string>> = {
  COVERAGE_ABSENT: 'Nouvel article ou complément éditorial à prévoir.',
  PARTIAL_COVERAGE: 'Compléter l’article sur le point manquant indiqué.',
  RETRIEVAL_MISSED: 'Correction de la recherche (l’article existe).',
  ACCOUNT_DATA_INSUFFICIENT: 'Information manquante côté utilisateur (documents, fiche du bien).',
  CONTRADICTION_AMBIGUITY: 'Harmoniser les articles ou préciser la question.',
  CORPUS_UNAVAILABLE: 'Incident de publication du corpus : ce n’est pas un manque de couverture.',
  QUALITY_ALERT: 'Relire la réponse : la source la mieux notée a été écartée comme hors sujet.',
};

export type ReviewStatus = 'TO_ANALYZE' | 'TO_FIX' | 'RESOLVED';
export const REVIEW_STATUS_LABELS: Readonly<Record<ReviewStatus, string>> = {
  TO_ANALYZE: 'À analyser', TO_FIX: 'À corriger', RESOLVED: 'Résolu',
};
export const REVIEW_STATUSES = Object.keys(REVIEW_STATUS_LABELS) as ReviewStatus[];

export type JournalOrigin = 'FREE' | 'SUGGESTION';
export type JournalCorpus = 'ACCOUNT' | 'HELP' | 'RESOURCES';

/** Ligne lue dans les traces (aucun contenu d'article ni de compte). */
export interface JournalRow {
  request_id: string;
  created_at: string | Date;
  intent: string | null;
  status: string | null;
  error_code: string | null;
  state: string | null;
  strategy: string | null;
  source_count: number | null;
  ref_outcome: string | null;
  fallback_reason: string | null;
  help_fallback_reason: string | null;
  help_article: string | null;
  help_corpus_version: string | null;
  resources: ResourcesTrace | null;
  /** Lot 111K : pertinence des preuves (données du compte) — motif et cause. */
  pertinence?: Pick<PertinenceTrace, 'motive' | 'cause' | 'outcome'> | null;
  /** Question posée (encore conservée), expurgée avant tout usage. */
  content: string | null;
}

export interface JournalOccurrence {
  requestId: string;
  at: string;
  intent: string | null;
  origin: JournalOrigin;
  suggestionId: string | null;
  corpus: JournalCorpus;
  corpusVersion: string | null;
  environment: string | null;
  appRevision: string | null;
  motive: UnansweredMotive;
  qualityAlerts: string[];
  fallbackReason: string | null;
  examined: Array<{ articleId: string; anchor: string; score: number; kept: boolean; reason?: string }>;
  selected: { articleId: string; anchors: string[] } | null;
  evidenceStatus: string | null;
  missingSubjects: string[];
}

const CORPUS_CODE = /^(?:HELP|RESOURCES)_CORPUS_/;

/** Motif et origine d'une trace, ou `null` (réponse sans signal). Pur, testé. */
export function classifyJournalRow(r: JournalRow): JournalOccurrence | null {
  const res = r.resources;
  const at = new Date(r.created_at).toISOString();
  const help = HELP_INTENTS.has(r.intent ?? '');
  const fb = r.help_fallback_reason ?? r.fallback_reason ?? null;
  let motive: UnansweredMotive | null = null;
  if (res) {
    motive = res.motive ?? (res.qualityAlerts?.length ? 'QUALITY_ALERT' : null);
  } else if (r.pertinence?.motive) {
    // Lot 111K : données du compte — motif calculé par la trace de pertinence
    // (même vocabulaire), la cause distingue absence de donnée, preuve
    // rejetée ou incertaine, conflit réel, défaut de production.
    motive = r.pertinence.motive;
  } else if (r.status !== 'pending' && r.state !== 'CANCELLED') {
    if (fb && CORPUS_CODE.test(fb)) motive = 'CORPUS_UNAVAILABLE';
    else if (fb === 'HELP_CONTRADICTION') motive = 'CONTRADICTION_AMBIGUITY';
    else {
      const legacy = classifyUnanswered({
        intent: r.intent, status: r.status ?? 'ok', error_code: r.error_code, state: r.state, strategy: r.strategy,
        no_source: Number(r.source_count ?? 0) === 0, ambiguous_ref: r.ref_outcome === 'ambiguous',
      });
      motive = legacy === 'absence_article_aide' ? 'COVERAGE_ABSENT'
        : legacy === 'aucune_donnee' ? 'ACCOUNT_DATA_INSUFFICIENT'
          : legacy === 'ambiguite' ? 'CONTRADICTION_AMBIGUITY' : null;
    }
  }
  if (!motive) return null;
  return {
    requestId: r.request_id, at, intent: r.intent,
    origin: res?.origin ?? 'FREE',
    suggestionId: res?.suggestionId ?? null,
    corpus: res ? 'RESOURCES' : help ? 'HELP' : 'ACCOUNT',
    corpusVersion: res?.corpus?.version ?? res?.evidence?.corpusVersion ?? r.help_corpus_version ?? null,
    environment: res?.appEnvironment ?? res?.corpus?.environment ?? null,
    appRevision: res?.appRevision ?? null,
    motive,
    qualityAlerts: res?.qualityAlerts ?? [],
    fallbackReason: res?.fallbackReason ?? (r.pertinence?.cause ? `PERTINENCE:${r.pertinence.cause}` : null) ?? fb,
    examined: (res?.examined ?? []).slice(0, 12).map((x) => ({ articleId: x.articleId, anchor: x.anchor, score: x.score, kept: x.kept, ...(x.reason ? { reason: x.reason } : {}) })),
    selected: res?.selected ?? (r.help_article ? { articleId: r.help_article, anchors: [] } : null),
    evidenceStatus: res?.evidence?.status ?? null,
    missingSubjects: res?.evidence?.missingSubjects ?? [],
  };
}

// ── Regroupement des questions proches ──────────────────────────────────────

const VIDES = new Set(('a au aux avec ce ces comment dans de des du en est et il je la le les leur ma mes mon ne nos notre nous on ou par pas '
  + 'pour qu que quel quelle quels quelles qui sa se ses son sur ta tes ton tu un une vos votre vous y d l j m n s t c faire fait peut '
  + 'peux dois doit faut il verebona est ce qu svp merci bonjour').split(' '));
const racine = (w: string) => (w.length > 5 ? w.replace(/(?:ements?|ations?|ees?|es|er|ez|s|x|e)$/, '') : w);

/** Clé de regroupement (pure) : mots significatifs de la question expurgée, racinisés, triés. */
export function groupKeyOf(question: string | null, fallback: string): string {
  const mots = question
    ? [...new Set(question.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’'`]/g, ' ').replace(/\[[^\]]*\]/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w.length > 1 && !VIDES.has(w)).map(racine))].sort()
    : [];
  const base = mots.length ? `q:${mots.join(' ')}` : `x:${fallback}`;
  return createHash('sha256').update(base).digest('hex').slice(0, 24);
}

export interface JournalGroup {
  groupKey: string;
  /** Formulation expurgée la plus récente (`null` : message purgé ou effacé). */
  question: string | null;
  count: number;
  firstSeen: string;
  lastSeen: string;
  motives: Array<{ motive: UnansweredMotive; label: string; count: number }>;
  corpora: JournalCorpus[];
  origins: JournalOrigin[];
  suggestionIds: string[];
  status: ReviewStatus;
  statusLabel: string;
  note: string | null;
  statusUpdatedAt: string | null;
  /** Résolu, mais de nouvelles occurrences depuis la décision. */
  reopened: boolean;
  occurrences: JournalOccurrence[];
}

export interface JournalFilters {
  days?: number;
  origin?: JournalOrigin | null;
  corpus?: JournalCorpus | null;
  motive?: UnansweredMotive | null;
  status?: ReviewStatus | null;
}

/** Agrège des lignes en groupes (pur, testé). */
export function aggregateJournal(
  rows: JournalRow[],
  reviews: Map<string, { status: ReviewStatus; note: string | null; updated_at: string | Date }>,
  f: JournalFilters = {},
  limit = 100,
): { groups: JournalGroup[]; totals: Array<{ motive: UnansweredMotive; label: string; count: number }>; occurrences: number } {
  const groupes = new Map<string, JournalGroup & { _m: Map<UnansweredMotive, number> }>();
  const totaux = new Map<UnansweredMotive, number>();
  let n = 0;
  for (const r of rows) {
    const o = classifyJournalRow(r);
    if (!o) continue;
    if (f.origin && o.origin !== f.origin) continue;
    if (f.corpus && o.corpus !== f.corpus) continue;
    if (f.motive && o.motive !== f.motive) continue;
    const question = r.content ? expurgerQuestion(r.content) || null : null;
    const key = groupKeyOf(question, o.suggestionId ? `s:${o.suggestionId}` : `${o.intent ?? 'UNKNOWN'}:${o.motive}`);
    let g = groupes.get(key);
    if (!g) {
      const rv = reviews.get(key);
      g = {
        groupKey: key, question, count: 0, firstSeen: o.at, lastSeen: o.at, motives: [], corpora: [], origins: [], suggestionIds: [],
        status: rv?.status ?? 'TO_ANALYZE', statusLabel: REVIEW_STATUS_LABELS[rv?.status ?? 'TO_ANALYZE'], note: rv?.note ?? null,
        statusUpdatedAt: rv ? new Date(rv.updated_at).toISOString() : null, reopened: false, occurrences: [], _m: new Map(),
      };
      groupes.set(key, g);
    }
    g.count += 1;
    if (o.at > g.lastSeen) { g.lastSeen = o.at; if (question) g.question = question; }
    if (o.at < g.firstSeen) g.firstSeen = o.at;
    if (!g.question && question) g.question = question;
    g._m.set(o.motive, (g._m.get(o.motive) ?? 0) + 1);
    if (!g.corpora.includes(o.corpus)) g.corpora.push(o.corpus);
    if (!g.origins.includes(o.origin)) g.origins.push(o.origin);
    if (o.suggestionId && !g.suggestionIds.includes(o.suggestionId)) g.suggestionIds.push(o.suggestionId);
    if (g.status === 'RESOLVED' && g.statusUpdatedAt && o.at > g.statusUpdatedAt) g.reopened = true;
    if (g.occurrences.length < 20) g.occurrences.push(o);
    totaux.set(o.motive, (totaux.get(o.motive) ?? 0) + 1);
    n += 1;
  }
  const groups = [...groupes.values()]
    .map(({ _m, ...g }) => ({
      ...g,
      motives: [..._m.entries()].map(([motive, count]) => ({ motive, label: JOURNAL_MOTIVE_LABELS[motive], count })).sort((a, b) => b.count - a.count),
      occurrences: g.occurrences.sort((a, b) => b.at.localeCompare(a.at)),
    }))
    .filter((g) => !f.status || g.status === f.status)
    .sort((a, b) => Number(b.reopened) - Number(a.reopened) || b.count - a.count || b.lastSeen.localeCompare(a.lastSeen))
    .slice(0, limit);
  return {
    groups,
    totals: JOURNAL_MOTIVES.map((motive) => ({ motive, label: JOURNAL_MOTIVE_LABELS[motive], count: totaux.get(motive) ?? 0 })),
    occurrences: n,
  };
}

// ── Lecture / écriture (base) ───────────────────────────────────────────────

/** Fenêtre maximale de lecture : la durée de conservation de l'historique (politique existante). */
export async function journalRetentionDays(): Promise<number> {
  const { retentionPolicy } = await import('@/services/ai/assistant/retention/purge-assistant-logs.job');
  return retentionPolicy().conversationDays;
}

/** Journal des `days` derniers jours (≤ rétention), filtré et regroupé. Lecture seule. */
export async function listUnansweredJournal(f: JournalFilters = {}) {
  const max = await journalRetentionDays();
  const days = Math.min(Math.max(Math.floor(f.days ?? 30), 1), max);
  const { readOnlyObservabilityQuery } = await import('@/services/ai/telemetry/observability.repository');
  const rows = (await readOnlyObservabilityQuery(
    `SELECT r.request_id, r.created_at, r.intent, COALESCE(r.status, 'ok') AS status, r.error_code,
            r.machine_final_state AS state, r.retrieval_methods_json->>'strategy' AS strategy, r.source_count,
            r.retrieval_methods_json->'reference'->>'outcome' AS ref_outcome,
            r.retrieval_methods_json->>'fallbackReason' AS fallback_reason,
            r.retrieval_methods_json->'help'->>'fallbackReason' AS help_fallback_reason,
            r.retrieval_methods_json->'help'->'observability'->>'articleId' AS help_article,
            r.retrieval_methods_json->'help'->'corpus'->>'version' AS help_corpus_version,
            r.retrieval_methods_json->'resources' AS resources,
            r.retrieval_methods_json->'pertinence' AS pertinence,
            -- Question encore conservée (fil actif, non expiré) : sinon aucun texte.
            (SELECT m.content FROM verebona_messages m
               JOIN verebona_conversations c ON c.id = m.conversation_id AND c.account_id = m.account_id
                AND c.status = 'active' AND c.expires_at > now()
              WHERE m.request_id = r.request_id AND m.account_id = r.account_id AND m.role = 'user' AND m.expires_at > now()
              LIMIT 1) AS content
       FROM verebona_request_runs r
      WHERE r.created_at >= now() - make_interval(days => $1::int)
        AND COALESCE(r.status, 'ok') <> 'pending'
        AND (r.retrieval_methods_json ? 'resources'
             OR r.retrieval_methods_json->'pertinence'->>'motive' IS NOT NULL
             OR COALESCE(r.source_count, 0) = 0
             OR r.retrieval_methods_json->'help'->>'fallbackReason' IS NOT NULL)
      ORDER BY r.created_at DESC
      LIMIT 3000`,
    [days],
  )) as unknown as JournalRow[];
  const reviews = await readReviews();
  return { days, retentionDays: max, ...aggregateJournal(rows, reviews, f) };
}

async function readReviews(): Promise<Map<string, { status: ReviewStatus; note: string | null; updated_at: string | Date }>> {
  try {
    const { pgClient } = await import('@/db');
    const r = (await pgClient.unsafe(`SELECT group_key, status, note, updated_at FROM t2_unanswered_reviews`)) as unknown as
      Array<{ group_key: string; status: ReviewStatus; note: string | null; updated_at: string }>;
    return new Map(r.map((x) => [x.group_key, x]));
  } catch {
    // Table absente (migration 1185 non jouée) : tout est « À analyser ».
    return new Map();
  }
}

export const GROUP_KEY_PATTERN = /^[0-9a-f]{24}$/;

/** Décision de revue d'un groupe (administrateur). Note expurgée, ≤ 500 caractères. */
export async function setReviewStatus(p: { groupKey: string; status: ReviewStatus; note?: string | null; adminUserId: number | null }): Promise<boolean> {
  if (!GROUP_KEY_PATTERN.test(p.groupKey) || !REVIEW_STATUSES.includes(p.status)) return false;
  const note = p.note ? expurgerQuestion(p.note).slice(0, 500) || null : null;
  const { pgClient } = await import('@/db');
  await pgClient.unsafe(
    `INSERT INTO t2_unanswered_reviews (group_key, status, note, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (group_key) DO UPDATE SET status = EXCLUDED.status, note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [p.groupKey, p.status, note, p.adminUserId] as never[],
  );
  return true;
}

/** Purge des décisions de revue au-delà de la durée de l'historique (appelée par la purge de l'assistant). */
export async function purgeUnansweredReviews(days: number, run: (sql: string) => Promise<number>): Promise<number> {
  const d = Math.max(1, Math.floor(days));
  return run(`DELETE FROM t2_unanswered_reviews WHERE updated_at < NOW() - INTERVAL '${d} days'`).catch(() => 0);
}
