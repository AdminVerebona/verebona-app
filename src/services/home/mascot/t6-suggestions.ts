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
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { MascotSecondary } from './types';
import { EMOJI, TUTOIEMENT } from './t6-contract';
import type { MascotAgendaRow } from './signals';

export const T6_SUGGESTION_CONTEXT_SCHEMA = 't6-suggestions-v1';
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
  /** Libellé naturel (« Contrôle technique »), jamais le titre technique brut. */
  label: string;
  assetRef: string | null;
  dateLabel: string;
  dateNature: 'confirmée' | 'prévisionnelle';
}

/** Contexte transmis à T6 ({{SUGGESTION_CONTEXT}}). Présences, jamais de compteurs exacts. */
export interface T6SuggestionContext {
  schemaVersion: typeof T6_SUGGESTION_CONTEXT_SCHEMA;
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

/** Question retenue : libellé et bien désigné (revalidé par T2 au clic). */
export interface T6Suggestion {
  question: string;
  assetId: number | null;
  /** Référence transmise par T6 (serveur seulement : cache, revalidée à la relecture). */
  assetRef?: string | null;
}

/** Contexte complet : la correspondance référence → bien reste côté serveur. */
export interface T6SuggestionBundle {
  context: T6SuggestionContext;
  /** A1 → identifiant du bien (jamais transmis à T6). */
  assetIds: ReadonlyMap<string, number>;
}

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
  const nextDeadlines = d.agenda.filter((r) => r.date).slice(0, MAX_SUGGESTION_DEADLINES).map((r) => ({
    label: d.labelOf(r),
    assetRef: r.assetId != null ? refOf.get(r.assetId) ?? null : null,
    dateLabel: d.formatDate(r.date!),
    dateNature: r.forecast ? 'prévisionnelle' as const : 'confirmée' as const,
  }));
  const s = d.state;
  return {
    assetIds,
    context: {
      schemaVersion: T6_SUGGESTION_CONTEXT_SCHEMA,
      bubble: { speech: d.speech, attentionToday: d.attentionToday },
      account: {
        hasDocuments: pos(s?.documentsTotal),
        hasDocumentsInAnalysis: pos(s?.documentsInAnalysis),
        hasUnlinkedDocuments: pos(s?.documentsUnlinked),
        hasPendingToProcess: pos(s?.toProcessPending),
        hasOperations: d.operations > 0,
        hasUpcomingDeadlines: pos(s?.deadlinesUpcoming) || nextDeadlines.length > 0,
        hasDeadlinesNext30Days: pos(s?.deadlinesSoon),
        hasExportsReady: pos(s?.exportsReady),
      },
      assets,
      nextDeadlines,
    },
  };
}

/** Tutoiement en inversion interrogative (« dois-tu », « peux-tu »), propre aux questions. */
const INVERSION_TU = /-(tu|toi)(?=[\s?,.!]|$)/i;

const forme = (t: string) => t.normalize('NFC').toLocaleLowerCase('fr').replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();

/**
 * Validation STRUCTURELLE des questions de T6 (pure, testée) — format,
 * nombre, longueur, doublons exacts, référence de bien connue. Un élément
 * douteux est abandonné ; une liste illisible donne `[]`. Aucun contrôle de
 * sens : la pertinence appartient à T6 (R12).
 */
export function validateT6Suggestions(raw: unknown, assetIds: ReadonlyMap<string, number>): T6Suggestion[] {
  if (!Array.isArray(raw)) return [];
  const out: T6Suggestion[] = [];
  const vues = new Set<string>();
  for (const item of raw) {
    if (out.length >= MAX_T6_SUGGESTIONS) break;
    const o = (typeof item === 'string' ? { question: item, assetRef: null } : item) as { question?: unknown; assetRef?: unknown } | null;
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
    const k = forme(question);
    if (vues.has(k)) continue;
    vues.add(k);
    out.push({ question, assetId, assetRef });
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
  p: { speech: string; attentionToday: boolean; agenda: MascotAgendaRow[] | null; today: string },
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
    });
  } catch (e) {
    console.error('[mascotte] contexte des questions suggérées indisponible :', (e as Error).message);
    return null;
  }
}
