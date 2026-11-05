/**
 * SERVICE UNIQUE des suggestions partagées — lot 108J (ticket « Suggestions
 * de l'accueil et de T2 : source unique, trois objectifs »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI LES SUGGESTIONS DISPARAISSAIENT (diagnostic par le code)
 *
 * Jusqu'au lot 106B, la zone de l'accueil dépendait ENTIÈREMENT de la prise
 * de parole de la mascotte (GET /api/home/mascot) :
 *   1. questions personnalisées seulement si le prompt T6 ACTIF porte le
 *      contrat `t6-suggestions-v3` (absent du prompt livré), puis seulement
 *      après une génération T6 en arrière-plan ;
 *   2. aucune question de repli pour un compte non vide : la liste « de la
 *      page » était calculée dans le NAVIGATEUR sans contexte serveur, et
 *      toutes les entrées de l'accueil ont une précondition — elle était
 *      toujours vide (démontré, test L108J-U01) ;
 *   3. la relecture « 20 s » du lot 106B rapportait les suggestions, mais le
 *      client conservait la présentation déjà affichée tant que l'empreinte
 *      de contexte (qui n'inclut pas les suggestions) ne changeait pas — les
 *      suggestions arrivées entre-temps n'apparaissaient donc jamais pendant
 *      la visite (démontré, test L108J-U02) ;
 *   4. toute panne de la prise de parole (erreur, données partielles, compte
 *      non éligible aux traitements IA) supprimait aussi la zone.
 * Le correctif du lot 106B (invitations « Ajouter … » + « Autre
 * suggestion ») laissait ces dépendances en place.
 *
 * DÉSORMAIS
 *
 *   · un service SERVEUR unique (ce module), indépendant de T6 et de la
 *     bulle, sert les MÊMES trois suggestions (même ordre, même version) à
 *     l'accueil ET à l'état initial de « Demander à Verebona »
 *     (GET /api/suggestions) ;
 *   · stock prévalidé (`stock.ts`) : catalogue validé de l'assistant pour
 *     les questions personnelles (A / B), guide éditorial répondable par le
 *     Centre d'aide ou les Ressources (C) — AUCUN appel IA ;
 *   · repli éditorial sûr : un compte vide, des données illisibles ou T6 en
 *     panne donnent toujours trois questions de prise en main répondables ;
 *   · empreinte commune (faits pertinents, versions des corpus, période de
 *     rotation, consultations, compte ET utilisateur) : sélection stable
 *     pendant la consultation, renouvelée aux jalons utiles, jamais celle
 *     d'un autre compte ou d'un autre membre du Duo ;
 *   · clic → vraie question T2 : la route de l'assistant revalide la
 *     suggestion (`resolveSuggestionForMessage`) et en tire l'intention et la
 *     cible ; la consultation est enregistrée (rotation seulement).
 *   · diagnostic BO (rapport T6 « Suggestions partagées ») : version du
 *     prompt T6 actif, contrat `t6-suggestions-v3`, état des caches et des
 *     corpus, provenance de chaque suggestion.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'node:crypto';
import { pgClient } from '@/db';
import { MAX_HOME_SUGGESTIONS } from '@/services/home/mascot/types';
import { loadSuggestionContext } from '@/services/verebona-assistant/core/account-state';
import { renderSuggestionEntry, type SuggestionContext } from '@/services/verebona-assistant/registries/capability-registry';
import { loadHelpCorpus } from '@/services/verebona-assistant/core/help-corpus.service';
import { asHelpSearchCorpus, loadResourcesCorpus, resourcesCorpusHealth } from '@/services/verebona-assistant/core/resources-corpus.service';
import { effectiveAnalysisStateSql } from '@/services/ai/processing-status/effective-state-sql';
import type { AssistantRequestInput } from '@/services/verebona-assistant/types/contracts';
import {
  ACCOUNT_STOCK, GUIDE_STOCK, SAFE_FALLBACK_GUIDE_IDS, guideStageOf,
  type GuideStage, type UsageSignals,
} from './stock';
import { guideAnswerability, resourceCoverageOf, type CorporaForAnswerability } from './answerability';
import {
  rotationBucketOf, selectSharedSuggestions, selectionSeedOf,
  type AccountCandidate, type GuideCandidate, type SharedSuggestion, type SharedSuggestionSelection,
} from './select';
import { readConsultedSuggestions, recordSuggestionConsultation } from './consultations';
import { RESOURCE_QUESTION_CATALOG_VERSION, checkResourceEvidence } from './resource-questions';
import type { SuggestionEvidence } from '@/services/verebona-assistant/types/contracts';

/** Codes stables du diagnostic (BO, jamais affichés à l'utilisateur). */
export type SharedSuggestionDiagnosticCode =
  /** Au moins une question personnelle fondée sur les données du compte. */
  | 'OK'
  /** Compte avec des données, mais aucune question personnelle fiable : guide seulement (issue normale). */
  | 'NO_PERSONAL_FACT'
  /** Compte vide : questions de bienvenue (prise en main). */
  | 'EMPTY_ACCOUNT'
  /** Usages du compte illisibles : repli éditorial sûr (aucune donnée personnelle). */
  | 'DATA_UNAVAILABLE';

export interface SharedSuggestionDiagnostic {
  code: SharedSuggestionDiagnosticCode;
  stage: GuideStage;
  personal: number;
  guide: number;
  /** Questions du guide écartées faute d'article publié et retrouvé (non répondables). */
  notAnswerable: string[];
  /** Questions de prise en main proposées sans corpus d'aide vérifiable (Centre d'aide indisponible). */
  unverified: string[];
  consulted: number;
  helpCorpus: { available: boolean; version: string | null };
  resourcesCorpus: { available: boolean; version: string | null; articles: number; alert: string | null };
  /** Lot 110E : couverture effective de chaque question Ressources du catalogue (preuve de réponse). */
  resourceCoverage?: Array<{ id: string; status: string; articleId: string | null; revision: number | null; revisionChanged: boolean; missingSubjects: string[] }>;
  cache: 'HIT' | 'MISS';
}

export interface SharedSuggestionsResult {
  selection: SharedSuggestionSelection;
  diagnostic: SharedSuggestionDiagnostic;
}

/** Empreinte des DÉFINITIONS du stock : un stock modifié change la version. */
const STOCK_VERSION = createHash('sha256')
  .update(JSON.stringify([ACCOUNT_STOCK, GUIDE_STOCK.map(({ when: _w, ...e }) => e), RESOURCE_QUESTION_CATALOG_VERSION]))
  .digest('hex').slice(0, 12);

// ── Lecture des usages (compteurs bornés au compte) ─────────────────────────

const BORNE = 10;

async function readUsage(accountId: number, userId: number | null, ctx: SuggestionContext): Promise<UsageSignals> {
  const r = (await pgClient.unsafe(
    `SELECT
       (SELECT count(*)::int FROM (SELECT 1 FROM asset_files WHERE account_id = $1 AND deleted_at IS NULL
          AND ${effectiveAnalysisStateSql('asset_files')} = 'ANALYZED' LIMIT ${BORNE}) x) AS "documentsAnalyzed",
       (SELECT count(*)::int FROM (SELECT 1 FROM asset_files WHERE account_id = $1 AND user_id = $2 AND deleted_at IS NULL LIMIT ${BORNE}) x) AS "userDocuments",
       (SELECT count(*)::int FROM (SELECT 1 FROM verebona_messages m JOIN verebona_conversations c ON c.id = m.conversation_id
          WHERE c.account_id = $1 AND c.user_id = $2 AND m.role = 'user' LIMIT ${BORNE}) x) AS "userQuestions",
       (SELECT count(*)::int FROM (SELECT 1 FROM export_generation WHERE account_id = $1 LIMIT ${BORNE}) x) AS "exportsTotal"`,
    [accountId, userId ?? 0] as never[],
  )) as unknown as Array<Record<string, number>>;
  const s = ctx.state;
  if (!s) throw new Error('état du compte illisible');
  return {
    assetsTotal: Number(s.assetsTotal ?? 0),
    documentsTotal: Number(s.documentsTotal ?? 0),
    documentsAnalyzed: Number(r[0]?.documentsAnalyzed ?? 0),
    userDocuments: Number(r[0]?.userDocuments ?? 0),
    userQuestions: Number(r[0]?.userQuestions ?? 0),
    deadlinesUpcoming: Number(s.deadlinesUpcoming ?? 0),
    exportsTotal: Number(r[0]?.exportsTotal ?? 0),
  };
}

/** Questions personnelles A / B rendues avec le contexte serveur (préconditions du catalogue). */
export function accountCandidatesOf(ctx: SuggestionContext | null): AccountCandidate[] {
  if (!ctx?.state) return [];
  const out: AccountCandidate[] = [];
  for (const e of ACCOUNT_STOCK) {
    const r = renderSuggestionEntry(e.catalogId, ctx);
    if (!r) continue;
    out.push({ catalogId: e.catalogId, label: r.label, objective: e.objective, priority: e.priority, canonicalIntent: r.canonicalIntent, topic: r.topic, ...(r.assetId ? { assetId: r.assetId } : {}) });
  }
  return out;
}

/** Questions du guide de l'étape, répondables (pure à mémoïsation près). */
export function guideCandidatesOf(stage: GuideStage, usage: UsageSignals | null, corpora: CorporaForAnswerability): { candidates: GuideCandidate[]; notAnswerable: string[] } {
  const notAnswerable: string[] = [];
  const candidates: GuideCandidate[] = [];
  const entries = usage
    ? GUIDE_STOCK.filter((e) => e.stages.includes(stage) && (!e.when || e.when(usage)))
    : GUIDE_STOCK.filter((e) => SAFE_FALLBACK_GUIDE_IDS.includes(e.id));
  for (const e of entries) {
    const a = guideAnswerability(e, corpora);
    if (a === 'NOT_ANSWERABLE') { notAnswerable.push(e.id); continue; }
    const c = e.corpus === 'HELP' ? corpora.help : corpora.resources;
    candidates.push({ entry: e, answerability: a, version: c?.version ?? null });
  }
  return { candidates, notAnswerable };
}

// ── Cache commun (empreinte) ────────────────────────────────────────────────

const CACHE_MAX = 5_000;
const cache = new Map<string, { fingerprint: string; result: SharedSuggestionsResult }>();
/** Réservé aux tests. */
export function resetSharedSuggestionsCache(): void { cache.clear(); reported.clear(); }

async function loadCorpora(): Promise<CorporaForAnswerability> {
  const [help, res] = await Promise.all([
    loadHelpCorpus({ staleWhileRevalidate: true }).catch(() => null),
    loadResourcesCorpus({ staleWhileRevalidate: true }).catch(() => null),
  ]);
  return { help: help && help.articles.length > 0 ? help : null, resources: res && res.articles.length > 0 ? asHelpSearchCorpus(res) : null };
}

/**
 * Sélection partagée d'un utilisateur dans un compte. Ne lève jamais : en
 * dernier recours, le repli éditorial sûr (questions de prise en main).
 * Aucun appel IA.
 */
export async function getSharedSuggestions(accountId: number, userId: number | null, now: Date = new Date()): Promise<SharedSuggestionsResult> {
  const [corpora, consulted] = await Promise.all([loadCorpora(), readConsultedSuggestions(accountId, userId)]);
  let ctx: SuggestionContext | null = null;
  let usage: UsageSignals | null = null;
  try {
    ctx = await loadSuggestionContext(accountId, '/accueil');
    usage = await readUsage(accountId, userId, ctx);
  } catch (e) {
    console.warn('[suggestions] usages du compte illisibles — repli éditorial sûr :', (e as Error).message);
    usage = null;
  }
  const stage: GuideStage = usage ? guideStageOf(usage) : 'START';
  const account = usage ? accountCandidatesOf(ctx) : [];
  const { candidates: guide, notAnswerable } = guideCandidatesOf(stage, usage, corpora);
  const bucket = rotationBucketOf(now);
  const fingerprint = createHash('sha256').update(JSON.stringify([
    STOCK_VERSION, accountId, userId, usage, account, stage, [...consulted].sort(),
    corpora.help?.version ?? null, corpora.resources?.version ?? null, guide.map((g) => [g.entry.id, g.answerability]), bucket,
  ])).digest('hex');
  const key = `${accountId}:${userId ?? 0}`;
  const prev = cache.get(key);
  if (prev && prev.fingerprint === fingerprint) {
    return { ...prev.result, diagnostic: { ...prev.result.diagnostic, cache: 'HIT' } };
  }
  const selection = selectSharedSuggestions({
    stage, account, guide, consulted, seed: selectionSeedOf(accountId, userId), bucket, max: MAX_HOME_SUGGESTIONS, fingerprint, now,
  });
  const res = resourcesCorpusHealth();
  const diagnostic: SharedSuggestionDiagnostic = {
    code: !usage ? 'DATA_UNAVAILABLE'
      : usage.assetsTotal === 0 && usage.documentsTotal === 0 ? 'EMPTY_ACCOUNT'
        : selection.items.some((x) => x.objective !== 'GUIDE') ? 'OK' : 'NO_PERSONAL_FACT',
    stage,
    personal: selection.items.filter((x) => x.objective !== 'GUIDE').length,
    guide: selection.items.filter((x) => x.objective === 'GUIDE').length,
    notAnswerable,
    unverified: selection.items.filter((x) => x.answerability === 'UNVERIFIED').map((x) => x.id),
    consulted: consulted.size,
    helpCorpus: { available: !!corpora.help, version: corpora.help?.version ?? null },
    resourcesCorpus: { available: !!corpora.resources, version: corpora.resources?.version ?? null, articles: corpora.resources?.articles.length ?? 0, alert: res.alert?.code ?? null },
    resourceCoverage: GUIDE_STOCK.filter((e) => e.corpus === 'RESOURCES').map((e) => {
      const c = resourceCoverageOf(e, corpora.resources);
      return { id: e.id, status: c.status, articleId: c.articleId, revision: c.revision, revisionChanged: c.revisionChanged, missingSubjects: c.missingSubjects };
    }),
    cache: 'MISS',
  };
  const result = { selection, diagnostic };
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(key, { fingerprint, result });
  void writeSharedSuggestionsReport(accountId, userId, result).catch(() => {});
  return result;
}

/** Charge utile servie au client : la sélection, sans le diagnostic (BO seulement). */
export function publicSelectionOf(s: SharedSuggestionSelection) {
  const pub = (x: SharedSuggestion) => ({
    id: x.id, label: x.label, objective: x.objective, source: x.source.kind, ...(x.target ? { assetId: x.target.assetId } : {}),
  });
  return { contract: s.contract, version: s.version, generatedAt: s.generatedAt, items: s.items.map(pub), reserve: s.reserve.map(pub) };
}

// ── Clic : revalidation serveur ─────────────────────────────────────────────

/**
 * Suggestion cliquée → intention et cible VÉRIFIÉES côté serveur (jamais
 * celles du client). Valide seulement si l'identifiant appartient au stock,
 * que son libellé est EXACTEMENT celui envoyé et que, pour une question
 * personnelle, elle est encore rendue par les données du compte (bien du
 * compte, préconditions satisfaites). Enregistre la consultation (rotation
 * seulement). `null` : question libre, sans aucun privilège.
 */
export async function resolveSuggestionForMessage(
  accountId: number, userId: number, suggestionId: string, message: string, version: string | null = null,
): Promise<{ suggestion: NonNullable<AssistantRequestInput['suggestion']>; assetId: number | null } | null> {
  const texte = message.replace(/\s+/g, ' ').trim();
  let found: { suggestion: NonNullable<AssistantRequestInput['suggestion']>; assetId: number | null } | null = null;
  const guide = GUIDE_STOCK.find((e) => e.id === suggestionId);
  if (guide && guide.label === texte) {
    // Lot 110E : référence canonique (article + passages probants) retrouvée
    // ICI depuis l'identifiant, revalidée sur le corpus de l'environnement —
    // jamais un article fourni par le client.
    const evidence = guide.corpus === 'RESOURCES' ? await suggestionEvidenceOf(guide.id) : null;
    found = {
      suggestion: { id: guide.id, version, objective: 'GUIDE', canonicalIntent: guide.canonicalIntent, corpus: guide.corpus, forceIntent: true,
        ...(guide.corpus === 'RESOURCES' ? { evidence } : {}) },
      assetId: null,
    };
  } else if (suggestionId.startsWith('acc_')) {
    const entry = ACCOUNT_STOCK.find((e) => `acc_${e.catalogId}` === suggestionId);
    if (entry) {
      const ctx = await loadSuggestionContext(accountId, '/accueil').catch(() => null);
      const r = ctx ? renderSuggestionEntry(entry.catalogId, ctx) : null;
      if (r && r.label === texte) {
        found = {
          suggestion: { id: suggestionId, version, objective: entry.objective, canonicalIntent: r.canonicalIntent, corpus: 'ACCOUNT', forceIntent: false },
          assetId: r.assetId ?? null,
        };
      }
    }
  }
  if (!found) return null;
  await recordSuggestionConsultation(accountId, userId, suggestionId);
  // La sélection suivante tient compte de la consultation (empreinte).
  return found;
}

/**
 * Preuve de réponse d'une question Ressources, revalidée au clic sur le
 * corpus Ressources servi dans l'environnement (articles publiés seulement,
 * environnement contrôlé par le chargement — ENV-02). Ne lève jamais.
 */
export async function suggestionEvidenceOf(questionId: string): Promise<SuggestionEvidence> {
  const corpus = await loadResourcesCorpus({ staleWhileRevalidate: true }).catch(() => null);
  const c = checkResourceEvidence(questionId, corpus && corpus.articles.length > 0 ? corpus : null);
  return {
    questionId, status: c.status, articleId: c.articleId, revision: c.revision, revisionChanged: c.revisionChanged,
    corpusVersion: c.corpusVersion, environment: c.environment,
    answerSections: c.answerSections, reserveSections: c.reserveSections, missingSubjects: c.missingSubjects,
    answerSentences: c.answerSentences,
  };
}

// ── Diagnostic BO : rapport « Suggestions partagées » ───────────────────────

const reported = new Map<string, string>();

/**
 * Rapport T6 (scope `SUGGESTIONS`) du compte et de l'utilisateur, écrit
 * seulement quand le diagnostic CHANGE. Codes, identifiants et versions —
 * aucun texte personnel. Ne lève jamais.
 */
async function writeSharedSuggestionsReport(accountId: number, userId: number | null, r: SharedSuggestionsResult): Promise<void> {
  try {
    const repo = await import('@/services/ai/execution-report/repository');
    if (!(await repo.executionReportsReady())) return;
    const { t6PromptDiagnostic } = await import('@/services/home/mascot/t6-runner');
    const [t6, t6Cache] = await Promise.all([
      t6PromptDiagnostic().catch(() => ({ promptVersion: null, suggestionsV3: false, discoveryV1: false, source: 'unreadable' as const })),
      pgClient.unsafe(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE suggestions IS NOT NULL)::int AS avec_suggestions FROM home_mascot_cache WHERE account_id = $1`,
        [accountId] as never[],
      ).then((x) => (x as unknown as Array<{ total: number; avec_suggestions: number }>)[0] ?? null).catch(() => null),
    ]);
    const d = r.diagnostic;
    const { entriesFingerprint } = await import('@/services/ai/execution-report/model');
    const entries = [
      {
        section: 'SUGGESTIONS', fieldKey: 'diagnostic', label: 'Suggestions partagées (accueil et « Demander à Verebona »)',
        value: {
          ...d, contract: r.selection.contract, version: r.selection.version, cache: undefined,
          // Révision réellement déployée (Scalingo : SOURCE_VERSION), pour la recette sur l'environnement.
          revision: (process.env.SOURCE_VERSION || process.env.APP_COMMIT || '').slice(0, 12) || null,
        },
        recordStatus: d.code, writeResult: 'NOT_WRITTEN' as const, reasonCode: d.code,
        reason: SHARED_SUGGESTION_DIAGNOSTIC_LABELS[d.code],
      },
      {
        section: 'SUGGESTIONS', fieldKey: 't6', label: 'T6 (bulle seulement) — prompt actif et cache',
        value: { promptVersion: t6.promptVersion, contractT6SuggestionsV3: t6.suggestionsV3, contractT6DiscoveryV1: t6.discoveryV1, promptSource: t6.source,
          role: 'BUBBLE_ONLY', cacheEntries: t6Cache?.total ?? null, legacyCacheEntriesWithSuggestions: t6Cache?.avec_suggestions ?? null },
        recordStatus: 'BUBBLE_ONLY', writeResult: 'NOT_WRITTEN' as const, reasonCode: t6.suggestionsV3 ? 'T6_SUGGESTIONS_V3_PRESENT' : 'T6_SUGGESTIONS_V3_ABSENT',
        reason: 'Depuis le lot 108J, T6 formule la bulle et ne produit plus de suggestions : le contrat t6-suggestions-v3 est indiqué pour information, il ne conditionne plus l’affichage.',
      },
      ...r.selection.items.map((x, i) => ({
        section: 'SUGGESTIONS', fieldKey: `item_${i + 1}`, label: `Suggestion ${i + 1}`,
        value: { id: x.id, objective: x.objective, source: x.source.kind, ref: x.source.ref, sourceVersion: x.source.version, answerability: x.answerability, assetId: x.target?.assetId ?? null },
        recordStatus: x.objective, writeResult: 'NOT_WRITTEN' as const, reasonCode: x.source.kind, reason: null,
      })),
    ];
    const empreinte = entriesFingerprint(entries);
    const cle = `${accountId}:${userId ?? 0}`;
    if (reported.get(cle) === empreinte) return;
    const prev = (await pgClient.unsafe(
      `SELECT entries_fingerprint FROM ai_execution_reports
        WHERE account_id = $1 AND treatment = 'T6' AND scope = 'SUGGESTIONS' AND target_id IS NOT DISTINCT FROM $2::int
        ORDER BY id DESC LIMIT 1`,
      [accountId, userId] as never[],
    )) as unknown as Array<{ entries_fingerprint: string }>;
    if (prev[0]?.entries_fingerprint === empreinte) { reported.set(cle, empreinte); return; }
    await repo.writeExecutionReport({
      accountId, treatment: 'T6', scope: 'SUGGESTIONS', targetType: userId != null ? 'USER' : null, targetId: userId,
      triggerCode: 'display', status: 'NO_CHANGE',
      counters: { personal: d.personal, guide: d.guide, notAnswerable: d.notAnswerable.length, unverified: d.unverified.length, consulted: d.consulted, reserve: r.selection.reserve.length },
      steps: [
        { step: 'stock', status: 'OK', detail: { stage: d.stage } },
        { step: 'corpus', status: d.helpCorpus.available ? 'OK' : 'FAILED', error: d.helpCorpus.available ? null : 'Centre d’aide indisponible', detail: { help: d.helpCorpus, resources: d.resourcesCorpus } },
        { step: 'selection', status: 'OK', detail: { version: r.selection.version, contract: r.selection.contract } },
      ],
    }, entries);
    reported.set(cle, empreinte);
  } catch (e) {
    console.warn('[suggestions] rapport BO non écrit :', (e as Error).message);
  }
}

/** Libellés du diagnostic, en mots simples (BO). */
export const SHARED_SUGGESTION_DIAGNOSTIC_LABELS: Readonly<Record<SharedSuggestionDiagnosticCode, string>> = {
  OK: 'Suggestions affichées, dont au moins une question fondée sur les données du compte.',
  NO_PERSONAL_FACT: 'Aucune question personnelle fiable pour ce compte : questions du guide (Centre d’aide, Ressources) seulement — issue normale.',
  EMPTY_ACCOUNT: 'Compte vide : questions de bienvenue (prise en main), aucune donnée personnelle.',
  DATA_UNAVAILABLE: 'Données du compte illisibles : repli éditorial sûr (questions de prise en main), aucune donnée personnelle.',
};
