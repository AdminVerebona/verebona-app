/**
 * Logique d'affichage de l'assistant, sans React — CDC §4.2, §19.8, §27.9,
 * §27.11.
 *
 * Isolée des composants pour être testée (le harnais ne rend pas de TSX) :
 * message d'erreur avec ses suites, cible d'un « Réessayer », mise en forme
 * de l'explication « Pourquoi ? ».
 */
import type { VerebonaAction, VerebonaMessage } from './useVerebona';
import type { AssistantUiError } from './error-messages';

/**
 * Destination de « Ouvrir l'aide » quand le serveur n'a pas répondu : il
 * n'a donc pas pu fournir de href (§27.1). Route réelle de l'application
 * (`ROUTES.AIDE` côté serveur).
 */
export const HELP_HREF = '/aide';

/** Actions d'une erreur : « Réessayer » si l'erreur s'y prête, puis l'aide. */
export function errorActions(error: Pick<AssistantUiError, 'recoverable'>, idSeed: string): VerebonaAction[] {
  const actions: VerebonaAction[] = [];
  if (error.recoverable) {
    actions.push({
      actionId: `${idSeed}-retry`, type: 'RETRY_REQUEST', label: 'Réessayer', href: null,
      requiresConfirmation: false, analyticsCode: 'verebona.action.retry_request',
    });
  }
  actions.push({
    actionId: `${idSeed}-help`, type: 'OPEN_HELP', label: 'Ouvrir l’aide', href: HELP_HREF,
    requiresConfirmation: false, analyticsCode: 'verebona.action.open_help',
  });
  return actions;
}

/**
 * Message assistant affiché à la place d'une impasse (§4.2) : libellé
 * Verebona, jamais le texte technique, et une suite possible.
 */
export function errorAssistantMessage(error: AssistantUiError, id: string): VerebonaMessage {
  return {
    id,
    role: 'assistant',
    content: error.message,
    error,
    actions: errorActions(error, id),
  };
}

/**
 * Texte à renvoyer pour « Réessayer » (§27.11 `recoverable`) : la dernière
 * question de l'utilisateur précédant le message `fromMessageId` (ou la
 * dernière tout court). `null` s'il n'y en a pas.
 */
export function retryTarget(
  messages: VerebonaMessage[],
  fromMessageId?: string,
): { text: string; userMessageId: string } | null {
  const end = fromMessageId ? messages.findIndex((m) => m.id === fromMessageId) : messages.length;
  const limite = end < 0 ? messages.length : end;
  for (let i = limite - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user' && m.content.trim()) return { text: m.content, userMessageId: m.id };
  }
  return null;
}

// ── « Pourquoi ? » (§19.8, §27.9) ──────────────────────────────────────────

export interface ExplanationRow {
  claim_text: string;
  derivation?: string | null;
  sources?: Array<string | null> | null;
}

export interface ExplanationItem {
  text: string;
  derivation: string | null;
  sources: string[];
}

const DERIVATIONS: Record<string, string> = {
  direct: 'lu dans la source',
  calculated: 'calculé à partir des sources',
  synthesized: 'synthèse des sources',
};

/**
 * Justification synthétique : les faits utilisés, leur nature (lu, calculé,
 * synthétisé) et leurs sources — jamais un raisonnement interne (§19.8).
 */
export function formatExplanation(rows: ExplanationRow[] | null | undefined): ExplanationItem[] {
  return (rows ?? [])
    .filter((r) => r && typeof r.claim_text === 'string' && r.claim_text.trim())
    .map((r) => ({
      text: r.claim_text.trim(),
      derivation: r.derivation ? (DERIVATIONS[r.derivation] ?? null) : null,
      sources: [...new Set((r.sources ?? []).filter((s): s is string => typeof s === 'string' && s.trim() !== ''))],
    }));
}

/**
 * Règle ou calcul appliqué, et limites (§19.8) — rendus tels que le serveur
 * les a formulés ; toute valeur inattendue est écartée.
 */
export function formatExplanationDetails(data: unknown): { rule: string | null; limits: string[] } {
  const d = (data ?? {}) as { rule?: unknown; limits?: unknown };
  return {
    rule: typeof d.rule === 'string' && d.rule.trim() ? d.rule.trim() : null,
    limits: Array.isArray(d.limits)
      ? [...new Set(d.limits.filter((l): l is string => typeof l === 'string' && l.trim() !== '').map((l) => l.trim()))]
      : [],
  };
}

/** Phrase affichée quand aucune affirmation n'est enregistrée pour la réponse. */
export const EXPLANATION_EMPTY =
  'Cette réponse a été produite par une règle de l’application, à partir des éléments affichés dans les sources.';

/**
 * Statut de traitement court et contextualisé — CDC §7.7 (P3).
 * « Verebona réfléchit… » seul ne disait rien de l'avancement ; le libellé
 * suit le temps écoulé, sans prétendre à une précision qu'il n'a pas.
 */
export function processingStatus(elapsedMs: number): string {
  if (elapsedMs < 2500) return 'Je recherche les informations utiles…';
  if (elapsedMs < 6000) return 'Je vérifie vos documents…';
  return 'Je prépare la réponse…';
}

/**
 * Réponse serveur à ignorer côté client : demande annulée par l'utilisateur
 * (la réponse tardive n'est jamais affichée — §7.8, CA-22).
 */
export function isCancelledResponse(data: unknown): boolean {
  const d = data as { status?: string; error?: { code?: string } } | null;
  return d?.status === 'cancelled' || d?.error?.code === 'REQUEST_CANCELLED';
}

/** Plateforme d'affichage transmise au serveur (choix des articles d'aide — T2-05). */
export function currentPlatform(): 'web' | 'mobile' {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'web';
  return window.matchMedia('(max-width: 767px)').matches || window.matchMedia('(display-mode: standalone)').matches
    ? 'mobile' : 'web';
}

// ── Sources (§19.3, §19.5, §27.8) ─────────────────────────────────────────

/** Ligne renvoyée par GET /api/verebona/messages/{id}/sources. */
export interface SourceRow {
  source_type: string;
  source_id?: string | null;
  type_label?: string | null;
  title_snapshot: string | null;
  excerpt_snapshot: string | null;
  linked_asset_label?: string | null;
  useful_date?: string | null;
  status_label?: string | null;
  is_available: boolean;
  /** Construit par le serveur (§22.1) ; `null` si l'objet n'est pas ouvrable. */
  href: string | null;
}

/** Libellé du bouton de repli : « Voir les sources » (§19.5). */
export function sourcesToggleLabel(open: boolean, count: number): string {
  if (open) return 'Masquer les sources';
  return count > 1 ? `Voir les sources (${count})` : 'Voir les sources';
}

/** Bien lié · date utile · statut (§19.5), ou `null` s'il n'y a rien à dire. */
export function formatSourceMeta(r: Pick<SourceRow, 'linked_asset_label' | 'useful_date' | 'status_label'>): string | null {
  const date = r.useful_date ? formatIsoDateFr(r.useful_date) : null;
  const parts = [r.linked_asset_label, date, r.status_label].filter((x): x is string => typeof x === 'string' && x.trim() !== '');
  return parts.length ? parts.join(' · ') : null;
}

function formatIsoDateFr(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

// ── Cartes de résultats (§11.3, §22.3) ────────────────────────────────────

export interface UiResultCard {
  id: string; typeLabel: string; title: string; subtitle: string | null;
  date: string | null; status: string | null; excerpt: string | null; href: string | null;
}
export interface UiResultGroup {
  type: string; label: string; items: UiResultCard[]; total: number; hasMore: boolean; moreHref: string | null;
}

/** Cartes visibles avant « Voir tous les résultats » (§22.3). */
export const MAX_VISIBLE_RESULT_CARDS = 5;

/**
 * Groupes à afficher : repliés, 5 cartes au total dans l'ordre des groupes ;
 * dépliés, tous les groupes (déjà bornés par les quotas du §11.3).
 * `hiddenCount` : cartes masquées (0 → pas de bouton).
 */
export function visibleResultGroups(groups: UiResultGroup[] | null | undefined, all: boolean): { groups: UiResultGroup[]; hiddenCount: number } {
  const liste = (groups ?? []).filter((g) => g && Array.isArray(g.items) && g.items.length > 0);
  const totalCartes = liste.reduce((n, g) => n + g.items.length, 0);
  const plusAilleurs = liste.some((g) => g.hasMore);
  if (all) return { groups: liste, hiddenCount: 0 };
  let reste = MAX_VISIBLE_RESULT_CARDS;
  const out: UiResultGroup[] = [];
  for (const g of liste) {
    if (reste <= 0) break;
    out.push({ ...g, items: g.items.slice(0, reste) });
    reste -= Math.min(reste, g.items.length);
  }
  const visibles = out.reduce((n, g) => n + g.items.length, 0);
  // Même si toutes les cartes tiennent, un groupe au-delà de son quota
  // justifie « Voir tous les résultats » (page complète).
  return { groups: out, hiddenCount: totalCartes - visibles + (plusAilleurs && totalCartes === visibles ? 1 : 0) };
}
