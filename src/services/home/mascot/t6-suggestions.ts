/**
 * Questions suggérées de l'accueil, produites par T6 — lot 55A (ticket
 * « T6 / T2 — Cohérence des suggestions IA »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * L'IA DÉCIDE DE LA PERTINENCE, LE CODE ORCHESTRE ET VALIDE
 *
 * Avant : « Ou demandez-moi » venait du catalogue déterministe
 * (`suggestionsForRoute`), calculé SANS connaître le message de la mascotte —
 * d'où « Que dois-je traiter en priorité ? » sous « Aucun sujet à traiter en
 * priorité aujourd'hui ».
 *
 * Désormais les questions sont rédigées par T6, DANS LE MÊME APPEL que la
 * bulle (`t6_formulate`, règle R12 du master), à partir :
 *   · du message affiché (`bubble.speech`, texte déterministe de la bulle,
 *     dont T6 reformule les sujets dans la même sortie) ;
 *   · de l'état canonique du compte (présences seulement, jamais de
 *     contenu ni de compteur exact : aucun nombre à recopier) ;
 *   · des biens disponibles et nommables (références opaques A1…An) ;
 *   · des prochaines échéances (libellé naturel, bien, date absolue).
 *
 * Le code ne fait que :
 *   · transmettre ce contexte, borné au compte (`loadT6SuggestionContext`) ;
 *   · valider la STRUCTURE de la sortie (`validateT6Suggestions`) : nombre,
 *     longueur, forme interrogative, une ligne, ni emoji ni tutoiement,
 *     doublons exacts, référence de bien connue — un élément douteux est
 *     abandonné, jamais corrigé ;
 *   · rendre les questions retenues cliquables vers T2 (`suggestionSecondaries`).
 * Aucune liste de questions, aucun filtre sur les mots du message T6, aucune
 * règle métier parallèle (interdits du ticket).
 *
 * IA indisponible, prompt sans `{{SUGGESTION_CONTEXT}}` (version BO
 * antérieure), sortie invalide : AUCUNE question — jamais le catalogue,
 * qui pourrait contredire la bulle.
 *
 * Lot 72A (AC06) — cohérence avec les décisions T6, sans classification
 * parallèle ni catalogue de formulations :
 *   · les échéances ÉCARTÉES (décision T6 validée non retenue, report ou refus
 *     de l'utilisateur) ne sont jamais transmises, et les agrégats du compte
 *     (« échéance dans les 30 jours ») ne reposent que sur les échéances
 *     ÉLIGIBLES — un agrégat ne contourne jamais une décision individuelle ;
 *   · R12 v2 (`t6-suggestions-v2`) : chaque échéance transmise porte une
 *     référence opaque (`D1`…) et `signaled` (retenue dans la bulle) ; une
 *     question sur une échéance précise recopie `deadlineRef` et sa finalité
 *     (`CONSULT` / `PREPARE`) — `PREPARE` seulement si l'échéance est
 *     signalée. Référence inconnue, finalité absente ou incompatible,
 *     question qui cite une échéance sans sa référence : écartée ;
 *   · toutes versions : une question qui cite une échéance écartée (libellé
 *     des données du compte) sans référence valide est écartée.
 * Les questions générales et la consultation libre des échéances dans T2
 * restent inchangées.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { MascotSecondary } from './types';
import { EMOJI, TUTOIEMENT } from './t6-contract';
import type { MascotAgendaRow } from './signals';
import { daysBetween, normalizeForFingerprint } from './t6-interpellation';

export const T6_SUGGESTION_CONTEXT_SCHEMA = 't6-suggestions-v1';
/** Lot 72A : contexte à références d'échéance (R12 v2 du prompt maître). */
export const T6_SUGGESTION_CONTEXT_SCHEMA_V2 = 't6-suggestions-v2';
/** Horizon de l'agrégat « échéance dans les 30 jours ». */
const PROCHES_JOURS = 30;
/** Questions affichées au plus (« Ou demandez-moi », 3 pastilles). */
export const MAX_T6_SUGGESTIONS = 3;
/** Biens transmis au plus (références A1…A8). */
export const MAX_SUGGESTION_ASSETS = 8;
/** Prochaines échéances transmises au plus. */
export const MAX_SUGGESTION_DEADLINES = 3;
export const T6_SUGGESTION_MIN = 8;
export const T6_SUGGESTION_MAX = 100;
/**
 * Intention transmise au clic (contexte de page, indicatif) : la question est
 * libre, T2 la comprend lui-même (routage sémantique, lot 54E).
 */
export const T6_SUGGESTION_INTENT = 'HOME_T6_SUGGESTION';

export interface T6SuggestionAssetRef {
  ref: string;
  name: string;
  hasDocuments: boolean;
  hasDeadlinesNext30Days: boolean;
}

export interface T6SuggestionDeadline {
  /** Lot 72A (R12 v2) : référence opaque (`D1`…), recopiée dans `deadlineRef`. */
  ref?: string;
  /** Libellé naturel (« Contrôle technique »), jamais le titre technique brut. */
  label: string;
  assetRef: string | null;
  dateLabel: string;
  dateNature: 'confirmée' | 'prévisionnelle';
  /** Lot 72A (R12 v2) : retenue dans la bulle — seule une échéance signalée admet une question « préparer / agir ». */
  signaled?: boolean;
}

/** Contexte transmis à T6 ({{SUGGESTION_CONTEXT}}). Présences, jamais de compteurs exacts. */
export interface T6SuggestionContext {
  schemaVersion: typeof T6_SUGGESTION_CONTEXT_SCHEMA | typeof T6_SUGGESTION_CONTEXT_SCHEMA_V2;
  bubble: {
    /** Message affiché tel quel si T6 ne reformule rien (les sujets sont dans `messages`). */
    speech: string;
    /** Des éléments demandent l'attention aujourd'hui (sujets d'attention, « À faire en premier »). */
    attentionToday: boolean;
  };
  account: {
    hasDocuments: boolean;
    hasDocumentsInAnalysis: boolean;
    hasUnlinkedDocuments: boolean;
    hasPendingToProcess: boolean;
    hasOperations: boolean;
    hasUpcomingDeadlines: boolean;
    hasDeadlinesNext30Days: boolean;
    hasExportsReady: boolean;
  };
  assets: T6SuggestionAssetRef[];
  nextDeadlines: T6SuggestionDeadline[];
}

/** Finalité d'une question portant sur une échéance précise (R12 v2). */
export type T6SuggestionPurpose = 'CONSULT' | 'PREPARE';

/** Question retenue : libellé et bien désigné (revalidé par T2 au clic). */
export interface T6Suggestion {
  question: string;
  assetId: number | null;
  /** Référence transmise par T6 (serveur seulement : cache, revalidée à la relecture). */
  assetRef?: string | null;
  /** Lot 72A : échéance précise visée (`D1`…), revalidée à la relecture du cache. */
  deadlineRef?: string | null;
  purpose?: T6SuggestionPurpose | null;
}

/** Échéance transmise (serveur seulement) : identifiant et statut dans la bulle. */
export interface T6SuggestionDeadlineRef { agendaItemId: number; signaled: boolean; label: string }

/** Contexte complet : la correspondance référence → bien reste côté serveur. */
export interface T6SuggestionBundle {
  context: T6SuggestionContext;
  /** A1 → identifiant du bien (jamais transmis à T6). */
  assetIds: ReadonlyMap<string, number>;
  /** Lot 72A : D1 → échéance éligible (jamais transmise à T6). */
  deadlineRefs?: ReadonlyMap<string, T6SuggestionDeadlineRef>;
  /** Lot 72A : libellés normalisés des échéances ÉCARTÉES (serveur seulement). */
  excludedLabels?: readonly string[];
  /** Lot 72A : R12 v2 en service — toute question sur une échéance précise porte sa référence. */
  structuredRefs?: boolean;
}

/** Portée de validation des questions (sous-ensemble du `T6SuggestionBundle`). */
export type T6SuggestionScope = Pick<T6SuggestionBundle, 'deadlineRefs' | 'excludedLabels' | 'structuredRefs'>;

export interface SuggestionSourceData {
  speech: string;
  attentionToday: boolean;
  state: {
    documentsTotal?: number; documentsInAnalysis?: number; documentsUnlinked?: number; toProcessPending?: number;
    deadlinesUpcoming?: number; deadlinesSoon?: number; exportsReady?: number;
  } | null;
  operations: number;
  assets: Array<{ id: number; name: string; documents: number; deadlines?: number }>;
  /** Échéances FUTURES, dans l'ordre (déjà lues par le collecteur de la mascotte). */
  agenda: MascotAgendaRow[];
  /** Libellé naturel d'une échéance (injecté : `deadlineButtonLabel`). */
  labelOf: (row: MascotAgendaRow) => string;
  formatDate: (day: string) => string;
  /**
   * Lot 72A : jour courant — présent, les agrégats « dans les 30 jours » sont
   * calculés sur les échéances ÉLIGIBLES (`agenda`) seulement, jamais sur les
   * compteurs bruts du compte (qui incluent les échéances écartées).
   */
  today?: string;
  /** Lot 72A : échéances écartées (décision T6, report ou refus) — jamais transmises ni citées. */
  excluded?: readonly MascotAgendaRow[];
  /** Lot 72A : échéances retenues dans la bulle (`T6Preparation.shown`). */
  signaledIds?: ReadonlySet<number>;
  /** Lot 72A : R12 v2 en service (références d'échéance). */
  structuredRefs?: boolean;
}

const pos = (n: number | undefined | null) => typeof n === 'number' && n > 0;

/** Contexte des questions suggérées (pur, testé). */
export function buildT6SuggestionContext(d: SuggestionSourceData): T6SuggestionBundle {
  const assetIds = new Map<string, number>();
  const refOf = new Map<number, string>();
  const assets = d.assets.slice(0, MAX_SUGGESTION_ASSETS).map((a, i) => {
    const ref = `A${i + 1}`;
    assetIds.set(ref, a.id);
    refOf.set(a.id, ref);
    return { ref, name: a.name, hasDocuments: a.documents > 0, hasDeadlinesNext30Days: pos(a.deadlines) };
  });
  const deadlineRefs = new Map<string, T6SuggestionDeadlineRef>();
  const v2 = d.structuredRefs === true;
  const nextDeadlines = d.agenda.filter((r) => r.date).slice(0, MAX_SUGGESTION_DEADLINES).map((r, i) => {
    const label = d.labelOf(r);
    const signaled = d.signaledIds?.has(r.id) ?? false;
    const base = {
      label,
      assetRef: r.assetId != null ? refOf.get(r.assetId) ?? null : null,
      dateLabel: d.formatDate(r.date!),
      dateNature: r.forecast ? 'prévisionnelle' as const : 'confirmée' as const,
    };
    if (!v2) return base;
    const ref = `D${i + 1}`;
    deadlineRefs.set(ref, { agendaItemId: r.id, signaled, label });
    return { ref, ...base, signaled };
  });
  const s = d.state;
  // Lot 72A : agrégats « dans les 30 jours » fondés sur les SEULES échéances éligibles.
  const proche = (r: MascotAgendaRow) => !!d.today && !!r.date && r.date > d.today && daysBetween(d.today, r.date) <= PROCHES_JOURS;
  const prochesEligibles = d.today ? d.agenda.filter(proche) : null;
  const excludedLabels = [...new Set((d.excluded ?? []).flatMap((r) => [d.labelOf(r), r.title]).map(normalizeForFingerprint).filter((x) => x.length >= 4))];
  return {
    assetIds,
    deadlineRefs,
    excludedLabels,
    structuredRefs: v2,
    context: {
      schemaVersion: v2 ? T6_SUGGESTION_CONTEXT_SCHEMA_V2 : T6_SUGGESTION_CONTEXT_SCHEMA,
      bubble: { speech: d.speech, attentionToday: d.attentionToday },
      account: {
        hasDocuments: pos(s?.documentsTotal),
        hasDocumentsInAnalysis: pos(s?.documentsInAnalysis),
        hasUnlinkedDocuments: pos(s?.documentsUnlinked),
        hasPendingToProcess: pos(s?.toProcessPending),
        hasOperations: d.operations > 0,
        // Consultation libre : l'existence d'échéances à venir reste connue.
        hasUpcomingDeadlines: pos(s?.deadlinesUpcoming) || nextDeadlines.length > 0,
        hasDeadlinesNext30Days: prochesEligibles ? prochesEligibles.length > 0 : pos(s?.deadlinesSoon),
        hasExportsReady: pos(s?.exportsReady),
      },
      assets: prochesEligibles
        ? assets.map((a) => ({ ...a, hasDeadlinesNext30Days: prochesEligibles.some((r) => r.assetId === assetIds.get(a.ref)) }))
        : assets,
      nextDeadlines,
    },
  };
}

/** Le libellé (normalisé) figure-t-il, en mots entiers, dans la question (normalisée) ? */
const cite = (question: string, label: string) => ` ${question} `.includes(` ${label} `);

/** Tutoiement en inversion interrogative (« dois-tu », « peux-tu »), propre aux questions. */
const INVERSION_TU = /-(tu|toi)(?=[\s?,.!]|$)/i;

const forme = (t: string) => t.normalize('NFC').toLocaleLowerCase('fr').replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();

/**
 * Validation STRUCTURELLE des questions de T6 (pure, testée) — format,
 * nombre, longueur, doublons exacts, référence de bien connue. Un élément
 * douteux est abandonné ; une liste illisible donne `[]`. Aucun contrôle de
 * sens : la pertinence appartient à T6 (R12).
 *
 * Lot 72A (AC06) — `scope` : rattachement vérifiable aux décisions T6 —
 * référence d'échéance connue et finalité compatible (`PREPARE` seulement
 * pour une échéance signalée) ; sans référence, aucune échéance écartée citée
 * (toutes versions) ni, en R12 v2, aucune échéance transmise citée.
 */
export function validateT6Suggestions(raw: unknown, assetIds: ReadonlyMap<string, number>, scope: T6SuggestionScope = {}): T6Suggestion[] {
  if (!Array.isArray(raw)) return [];
  const out: T6Suggestion[] = [];
  const vues = new Set<string>();
  const refs = scope.deadlineRefs ?? new Map<string, T6SuggestionDeadlineRef>();
  const ecartees = scope.excludedLabels ?? [];
  const transmises = [...refs.values()].map((r) => normalizeForFingerprint(r.label)).filter((x) => x.length >= 4);
  for (const item of raw) {
    if (out.length >= MAX_T6_SUGGESTIONS) break;
    const o = (typeof item === 'string' ? { question: item, assetRef: null } : item) as { question?: unknown; assetRef?: unknown; deadlineRef?: unknown; purpose?: unknown } | null;
    if (!o || typeof o !== 'object' || typeof o.question !== 'string') continue;
    if (/[\r\n]/.test(o.question)) continue;
    const question = o.question.replace(/\s+/g, ' ').trim();
    if (question.length < T6_SUGGESTION_MIN || question.length > T6_SUGGESTION_MAX) continue;
    if (!question.endsWith('?') || EMOJI.test(question) || TUTOIEMENT.test(question) || INVERSION_TU.test(question)) continue;
    let assetId: number | null = null;
    let assetRef: string | null = null;
    if (o.assetRef != null) {
      if (typeof o.assetRef !== 'string' || !assetIds.has(o.assetRef)) continue;
      assetRef = o.assetRef;
      assetId = assetIds.get(o.assetRef)!;
    }
    // Lot 72A (AC06) : rattachement à une échéance précise.
    let deadlineRef: string | null = null;
    let purpose: T6SuggestionPurpose | null = null;
    if (o.deadlineRef != null) {
      const ref = typeof o.deadlineRef === 'string' ? refs.get(o.deadlineRef) : undefined;
      if (!ref) continue; // référence inconnue ou échéance devenue inéligible
      if (o.purpose !== 'CONSULT' && o.purpose !== 'PREPARE') continue; // cohérence non établie
      if (o.purpose === 'PREPARE' && !ref.signaled) continue; // incitation sur un sujet non signalé
      deadlineRef = o.deadlineRef as string;
      purpose = o.purpose;
    } else {
      const q = normalizeForFingerprint(question);
      if (ecartees.some((l) => cite(q, l))) continue; // échéance écartée réintroduite
      if (scope.structuredRefs && transmises.some((l) => cite(q, l))) continue; // rattachement non établi
    }
    const k = forme(question);
    if (vues.has(k)) continue;
    vues.add(k);
    out.push({ question, assetId, assetRef, ...(deadlineRef ? { deadlineRef, purpose } : {}) });
  }
  return out;
}

/** Questions retenues → éléments secondaires « question » (cliqués : T2, comme aujourd'hui). */
export function suggestionSecondaries(list: readonly T6Suggestion[]): MascotSecondary[] {
  return list.map((s, i) => ({
    id: `Q:T6:${i + 1}`,
    kind: 'question' as const,
    sourceCode: 'Q:T6',
    occurrenceKey: `Q:T6:${forme(s.question)}${s.assetId ? `:${s.assetId}` : ''}`,
    action: {
      actionId: `Q:T6:${i + 1}`,
      label: s.question,
      target: {
        kind: 'ask' as const, question: s.question,
        context: { intent: T6_SUGGESTION_INTENT, ...(s.assetId ? { assetId: s.assetId } : {}) },
      },
    },
  }));
}

/** Le texte master effectif porte-t-il l'emplacement des questions ? `null` : fichier du dépôt. */
export function promptSupportsSuggestions(effectiveText: string | null | undefined): boolean {
  return effectiveText == null || effectiveText.includes('{{SUGGESTION_CONTEXT}}');
}

/**
 * Lot 72A — le texte master effectif porte-t-il R12 v2 (sortie
 * `"deadlineRef"`) ? `null` : fichier du dépôt (qui la porte). Une version BO
 * antérieure garde le contexte v1 tant que le PO n'a pas activé la nouvelle.
 */
export function promptSupportsSuggestionRefs(effectiveText: string | null | undefined): boolean {
  return effectiveText == null || (promptSupportsSuggestions(effectiveText) && effectiveText.includes('"deadlineRef"'));
}

/**
 * Lot 72A (AC06) — échéances du contexte des questions, à partir des
 * décisions T6 du passage (pure) : `agenda` — éligibles (ni écartées après
 * évaluation, ni reportées ou refusées par l'utilisateur) ; `excluded` — les
 * autres, jamais transmises ni citées ; `signaledIds` — retenues dans la bulle.
 */
export function suggestionAgendaOf(
  rows: readonly MascotAgendaRow[],
  prep: { discarded: ReadonlySet<number>; userSilenced: ReadonlySet<number>; shown: ReadonlyArray<{ agendaItemId: number }> },
): { agenda: MascotAgendaRow[]; excluded: MascotAgendaRow[]; signaledIds: Set<number> } {
  const ecartee = (r: MascotAgendaRow) => prep.discarded.has(r.id) || prep.userSilenced.has(r.id);
  return {
    agenda: rows.filter((r) => !ecartee(r)),
    excluded: rows.filter(ecartee),
    signaledIds: new Set(prep.shown.map((x) => x.agendaItemId)),
  };
}

// ── Lecture (serveur) ────────────────────────────────────────────────────────

/** Opérations actives du compte (réalisées ou envisagées), bornées au compte. */
async function countOperations(accountId: number): Promise<number> {
  const { pgClient } = await import('@/db');
  const r = (await pgClient.unsafe(
    `SELECT count(*)::int AS n FROM (SELECT 1 FROM business_operations
      WHERE account_id = $1 AND invalidated_at IS NULL AND status <> 'CANCELLED' LIMIT 1) x`,
    [accountId] as never[],
  )) as unknown as Array<{ n: number }>;
  return Number(r[0]?.n ?? 0);
}

/**
 * Contexte des questions suggérées d'un compte — lectures canoniques
 * existantes (`account-state`), bornées au compte. Rend `null` si le compte
 * est vide (l'accueil propose alors ses questions d'amorce) ou si une lecture
 * échoue (aucune question plutôt qu'une question trompeuse).
 */
export async function loadT6SuggestionContext(
  accountId: number,
  p: {
    speech: string; attentionToday: boolean; agenda: MascotAgendaRow[] | null; today: string;
    /** Lot 72A : échéances écartées, retenues, R12 v2 en service. */
    excluded?: readonly MascotAgendaRow[]; signaledIds?: ReadonlySet<number>; structuredRefs?: boolean;
  },
): Promise<T6SuggestionBundle | null> {
  try {
    const [{ loadAccountSuggestionState, listNameableSuggestionAssets }, { deadlineButtonLabel }, { formatDateFr, roleOf }] = await Promise.all([
      import('@/services/verebona-assistant/core/account-state'),
      import('./deadline-label'),
      import('./signals'),
    ]);
    const [state, assets, operations] = await Promise.all([
      loadAccountSuggestionState(accountId),
      listNameableSuggestionAssets(accountId, MAX_SUGGESTION_ASSETS),
      countOperations(accountId).catch(() => 0),
    ]);
    if ((state.assetsTotal ?? 0) === 0 && (state.documentsTotal ?? 0) === 0) return null;
    const futures = (p.agenda ?? [])
      .filter((r) => r.date && r.date > p.today && !r.requiresQualification)
      .sort((a, b) => a.date!.localeCompare(b.date!) || a.id - b.id);
    return buildT6SuggestionContext({
      speech: p.speech, attentionToday: p.attentionToday, state, operations, assets, agenda: futures,
      labelOf: (r) => deadlineButtonLabel({ ...r, dateRole: roleOf(r) }),
      formatDate: formatDateFr,
      today: p.today, excluded: p.excluded ?? [], signaledIds: p.signaledIds, structuredRefs: p.structuredRefs,
    });
  } catch (e) {
    console.error('[mascotte] contexte des questions suggérées indisponible :', (e as Error).message);
    return null;
  }
}
