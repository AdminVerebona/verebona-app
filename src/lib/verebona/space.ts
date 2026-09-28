/**
 * Espace de réponse Verebona — logique d'affichage, sans React.
 * Direction D v2 « La mascotte », §5 à §8.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN SEUL ESPACE, QUEL QUE SOIT LE TRAITEMENT
 *
 * Le serveur choisit toujours le traitement (navigation, recherche, données
 * du compte, règles, aide, IA) : le routage réel de l'assistant est conservé.
 * Ce module ne fait que TRADUIRE une réponse réelle (`VerebonaMessage`) dans
 * les briques communes de l'espace : une phrase, des objets, des actions,
 * un liseré (neutre, succès, erreur) et une pose de mascotte.
 *
 * Isolé des composants pour être testé : le harnais ne rend pas de TSX.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { VerebonaMessage, VerebonaThread } from './useVerebona';
import type { UiResultCard, UiResultGroup } from './assistant-ui';

// ── Types ────────────────────────────────────────────────────────────────────

/** Nature d'une réponse, pour la pose de la mascotte (§6.5). */
export type AnswerKind =
  | 'asset' | 'multi' | 'fact' | 'doc' | 'event' | 'action' | 'conv' | 'help' | 'empty' | 'error';

/** Poses disponibles dans `public/mascot/*.webp`. */
export type MascotPoseName =
  | 'welcome-wave' | 'search-loupe' | 'property-house' | 'info-card' | 'document-analysis-pdf'
  | 'reminder-bell' | 'thumbs-up' | 'dialogue-bubble' | 'questioning' | 'success-check' | 'neutral';

/** Liseré gauche de la réponse (§6.4). */
export type RailTone = 'neutral' | 'success' | 'error';

/** Un échange : la question et la ou les réponses qui la suivent. */
export interface SpaceTurn {
  id: string;
  question: string;
  answers: VerebonaMessage[];
  /** Traitement en cours : trois points animés sous la question (§6.4). */
  pending: boolean;
  /** Question conservée hors ligne (§30.6 du CDC assistant). */
  offline: boolean;
}

/** Objet affiché dans une réponse : ligne-carte avec vignette (§6.4). */
export interface SpaceObject {
  id: string;
  type: UiResultGroup['type'] | 'local';
  title: string;
  /** Sous-titre (bien lié, catégorie…). */
  sub: string | null;
  /** Méta : date · statut. */
  meta: string | null;
  href: string | null;
  cta: string;
  tone: 'blue' | 'green' | 'amber' | 'red' | 'violet' | 'slate';
  icon: 'package' | 'file-text' | 'calendar-days' | 'info' | 'circle-alert' | 'building' | 'clock';
  /** Objet d'une réponse locale : gestionnaire de clic côté interface. */
  actionId?: string;
}

// ── Classification (§6.5) ───────────────────────────────────────────────────

const NO_RESULT = /^Je n[’']ai rien trouvé/i;

const HELP_INTENTS = new Set(['PRODUCT_HELP_HOW_TO', 'PRODUCT_HELP_EXPLAIN', 'PRODUCT_HELP_STATUS', 'PRODUCT_PLAN_LIMIT', 'EXPORT_HELP']);
const CONV_INTENTS = new Set(['GREETING', 'THANKS', 'GOODBYE', 'ACCOUNT_SUMMARY', 'ACCOUNT_COMPARISON', 'ACCOUNT_TIMELINE', 'OUT_OF_SCOPE', 'SENSITIVE_ADVICE']);
const SEARCH_INTENTS = new Set(['ACCOUNT_SEARCH_ASSET', 'ACCOUNT_SEARCH_DOCUMENT', 'ACCOUNT_SEARCH_AGENDA', 'ACCOUNT_SEARCH_SUPPLIER', 'NAVIGATION_FIND']);

/** Cartes non vides, dans l'ordre des groupes. */
export function resultCards(msg: Pick<VerebonaMessage, 'resultGroups'>): Array<UiResultCard & { groupType: UiResultGroup['type'] }> {
  return (msg.resultGroups ?? [])
    .filter((g) => g && Array.isArray(g.items))
    .flatMap((g) => g.items.map((c) => ({ ...c, groupType: g.type })));
}

/**
 * Nature d'une réponse réelle. L'ordre compte : une erreur l'emporte sur
 * tout, une décision à prendre sur une liste, un résultat unique sur l'intention.
 */
export function classifyAnswer(msg: VerebonaMessage): AnswerKind {
  if (msg.error) return 'error';
  if (msg.local?.kind) return msg.local.kind;
  if (msg.commandPlan || msg.clarification) return 'action';
  const cards = resultCards(msg);
  if (cards.length === 0 && NO_RESULT.test(msg.content.trim())) return 'empty';
  if (cards.length > 1) return 'multi';
  if (cards.length === 1) {
    switch (cards[0].groupType) {
      case 'asset': return 'asset';
      case 'document': return 'doc';
      case 'agenda': return 'event';
      case 'help': return 'help';
      case 'to_process': return 'action';
      default: return 'fact';
    }
  }
  const intent = msg.intent ?? '';
  if (HELP_INTENTS.has(intent)) return 'help';
  if (CONV_INTENTS.has(intent) || msg.mode === 'ai') return 'conv';
  if (SEARCH_INTENTS.has(intent)) return 'empty';
  return 'fact';
}

const POSE_FOR_KIND: Record<AnswerKind, MascotPoseName> = {
  asset: 'property-house',
  multi: 'search-loupe',
  fact: 'info-card',
  help: 'info-card',
  doc: 'document-analysis-pdf',
  event: 'reminder-bell',
  action: 'thumbs-up',
  conv: 'dialogue-bubble',
  empty: 'questioning',
  error: 'questioning',
};

export function poseForKind(kind: AnswerKind): MascotPoseName {
  return POSE_FOR_KIND[kind];
}

/**
 * Pose de la mascotte du champ et de l'en-tête mobile (§6.5, §12bis) :
 * aucun échange → `welcome-wave` ; demande envoyée → `search-loupe` ;
 * réponse arrivée → pose du type de réponse.
 */
export function spacePose(turns: SpaceTurn[]): MascotPoseName {
  const last = turns[turns.length - 1];
  if (!last) return 'welcome-wave';
  if (last.pending || last.answers.length === 0) return 'search-loupe';
  return poseForKind(classifyAnswer(last.answers[last.answers.length - 1]));
}

/** Liseré : rouge pour une erreur, vert pour une action réussie (§6.4). */
export function railTone(msg: VerebonaMessage): RailTone {
  if (msg.error) return 'error';
  if (msg.local?.tone === 'success') return 'success';
  if (msg.commandPlan?.status === 'EXECUTED') return 'success';
  return 'neutral';
}

// ── Échanges ────────────────────────────────────────────────────────────────

/**
 * Regroupe les messages en échanges « question → réponse(s) ». Une réponse
 * sans question (historique tronqué par la pagination) ouvre un échange sans
 * question plutôt que d'être rattachée à tort à la précédente.
 */
export function buildTurns(messages: VerebonaMessage[], isLoading: boolean): SpaceTurn[] {
  const turns: SpaceTurn[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      turns.push({ id: m.id, question: m.content, answers: [], pending: false, offline: !!m.pendingOffline });
    } else if (turns.length === 0) {
      turns.push({ id: `a-${m.id}`, question: '', answers: [m], pending: false, offline: false });
    } else {
      turns[turns.length - 1].answers.push(m);
    }
  }
  const last = turns[turns.length - 1];
  if (last && isLoading && !last.offline) {
    // Une décision (plan, clarification) en cours d'envoi se rattache à
    // l'échange existant : les points s'affichent sous sa dernière réponse.
    last.pending = true;
  }
  return turns;
}

/** Seuls les 2 derniers échanges restent affichés en entier (§7.2). */
export const KEEP_RECENT = 2;

/**
 * Un échange qui attend encore une décision ne se replie jamais : plan à
 * confirmer (ou en cours d'envoi), action exécutée encore annulable (fenêtre
 * de 15 minutes), clarification ouverte. Replié, il perdrait ses boutons.
 */
export function turnNeedsAttention(t: SpaceTurn, nowMs: number = Date.now()): boolean {
  return t.answers.some((m) => {
    if (m.clarification && m.clarification.choices.length > 0) return true;
    const p = m.commandPlan;
    if (!p) return false;
    if (p.status === 'DECIDING' || p.status === 'EXECUTING') return true;
    if (p.status === 'PENDING_CONFIRMATION') {
      const fin = Date.parse(p.expiresAt);
      return !Number.isFinite(fin) || fin > nowMs;
    }
    if ((p.status === 'EXECUTED' || p.status === 'PARTIAL') && p.undoUntil) return Date.parse(p.undoUntil) > nowMs;
    return false;
  });
}

/**
 * Les `keep` derniers échanges restent entiers (§7.2), ainsi que tout échange
 * qui attend une décision ; les autres sont regroupés, dans l'ordre.
 */
export function splitTurns(turns: SpaceTurn[], keep = KEEP_RECENT, nowMs: number = Date.now()): { recent: SpaceTurn[]; older: SpaceTurn[] } {
  const recent: SpaceTurn[] = [];
  const older: SpaceTurn[] = [];
  turns.forEach((t, i) => {
    if (i >= turns.length - keep || turnNeedsAttention(t, nowMs)) recent.push(t);
    else older.push(t);
  });
  return { recent, older };
}

/** « 1 échange », « 3 échanges », rien pour zéro. */
export function exchangeCountLabel(n: number): string {
  if (n <= 0) return '';
  return n === 1 ? '1 échange' : `${n} échanges`;
}

/** Tiroir replié des échanges précédents (§7.2). */
export function olderLabel(n: number): string {
  return n > 1 ? `${n} échanges précédents sur ce sujet` : '1 échange précédent';
}

// ── Résumés (« Reprendre », lignes compressées, demandes précédentes) ───────

const GROUP_NOUNS: Record<UiResultGroup['type'], [string, string]> = {
  asset: ['bien', 'biens'],
  document: ['document', 'documents'],
  agenda: ['échéance', 'échéances'],
  supplier: ['fournisseur', 'fournisseurs'],
  to_process: ['élément à traiter', 'éléments à traiter'],
  help: ['article d’aide', 'articles d’aide'],
};

/** Première phrase, sans ponctuation finale, bornée à `max` caractères. */
export function firstSentence(text: string, max = 60): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const m = /^(.+?[.!?…])(\s|$)/.exec(t);
  let s = (m ? m[1] : t).replace(/[.!?…:]+$/, '').trim();
  if (s.length > max) s = `${s.slice(0, max - 1).trimEnd()}…`;
  return s;
}

/** Résumé court d'une réponse (§9 : `summary`). */
export function answerSummary(msg: VerebonaMessage | undefined): string {
  if (!msg) return '…';
  if (msg.local?.summary) return msg.local.summary;
  if (msg.error) return 'Réponse impossible pour le moment';
  const groups = (msg.resultGroups ?? []).filter((g) => g.items?.length);
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  if (total === 1) return groups[0].items[0].title;
  if (total > 1) {
    return groups
      .map((g) => {
        const n = Math.max(g.total ?? 0, g.items.length);
        const [sg, pl] = GROUP_NOUNS[g.type] ?? ['résultat', 'résultats'];
        return `${n} ${n > 1 ? pl : sg}`;
      })
      .join(', ');
  }
  return firstSentence(msg.content) || '…';
}

/** Résumé de la dernière réponse d'un échange, ou « … » en attente. */
export function turnSummary(turn: SpaceTurn | undefined): string {
  if (!turn) return '';
  return answerSummary(turn.answers[turn.answers.length - 1]);
}

/**
 * État 4 (§6.5) : un résultat unique s'affiche SEUL, sans la phrase
 * d'annonce générique (« J'ai trouvé 1 élément : »). Toute autre phrase
 * porte une information et reste affichée.
 */
export function showAnswerText(msg: VerebonaMessage): boolean {
  const text = msg.content.trim();
  if (!text) return false;
  if (msg.error) return true;
  const cards = resultCards(msg);
  if (cards.length === 1 && /^(J[’']ai trouvé|Voici)\s+(1|un|une)\b[^.]*[:.]?$/i.test(text)) return false;
  return true;
}

// ── Objets ──────────────────────────────────────────────────────────────────

const CTA: Record<UiResultGroup['type'], string> = {
  asset: 'Ouvrir',
  document: 'Ouvrir',
  agenda: 'Voir dans l’agenda',
  supplier: 'Ouvrir',
  to_process: 'Traiter',
  help: 'Lire l’article',
};

const ICON: Record<UiResultGroup['type'], SpaceObject['icon']> = {
  asset: 'package', document: 'file-text', agenda: 'calendar-days', supplier: 'building', to_process: 'circle-alert', help: 'info',
};

const TONE: Record<UiResultGroup['type'], SpaceObject['tone']> = {
  asset: 'blue', document: 'slate', agenda: 'amber', supplier: 'slate', to_process: 'amber', help: 'violet',
};

/** « 2026-10-12 » → « 12/10/2026 ». */
export function formatIsoDay(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

/** Cartes du serveur → objets de l'espace (href construit par le serveur, §22.1). */
export function objectsFromCards(cards: Array<UiResultCard & { groupType: UiResultGroup['type'] }>): SpaceObject[] {
  return cards.map((c) => ({
    id: `${c.groupType}:${c.id}`,
    type: c.groupType,
    title: c.title,
    sub: c.subtitle ?? c.typeLabel ?? null,
    meta: [formatIsoDay(c.date), c.status].filter((x): x is string => !!x && x.trim() !== '').join(' · ') || null,
    href: c.href,
    cta: CTA[c.groupType] ?? 'Ouvrir',
    tone: TONE[c.groupType] ?? 'slate',
    icon: ICON[c.groupType] ?? 'file-text',
  }));
}

// ── Champ ───────────────────────────────────────────────────────────────────

/** Placeholder du champ (§5) : « Poursuivre… » dès qu'un échange existe. */
export function fieldPlaceholder(turnCount: number): string {
  return turnCount > 0 ? 'Poursuivre…' : 'Demander à Verebona';
}

/** Bouton « Reprendre · n échanges » (§5, §6.2), espace fermé seulement. */
export function resumeLabel(turnCount: number): string {
  return `Reprendre · ${exchangeCountLabel(turnCount)}`;
}

/** Libellé du champ mobile au repos (§4.1). */
export function mobileFieldLabel(turns: SpaceTurn[]): string {
  const last = turns[turns.length - 1];
  if (!last) return 'Demander à Verebona';
  const s = last.answers.length ? turnSummary(last) : last.question;
  return `Reprendre · ${s}`;
}

// ── Demandes précédentes (§8) ───────────────────────────────────────────────

export const MAX_PREVIOUS_REQUESTS = 4;

const JOURS = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
const MOIS_COURTS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** « À l'instant », « Aujourd'hui », « Hier », « Lundi », « 12 sept. ». */
export function relativeMoment(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const diffMs = now.getTime() - d.getTime();
  if (diffMs >= 0 && diffMs < 5 * 60_000) return 'À l’instant';
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (days <= 0) return 'Aujourd’hui';
  if (days === 1) return 'Hier';
  if (days < 7) return JOURS[d.getDay()];
  return `${d.getDate()} ${MOIS_COURTS[d.getMonth()]}`;
}

export interface PreviousRequestRow {
  id: number;
  title: string;
  sub: string;
}

/**
 * Fils archivés (§8) : la liste « Demandes précédentes », 4 au plus, sans le
 * fil en cours ni les fils vides. Chaque ligne : première question, puis
 * moment · n échanges · résumé de la dernière réponse.
 */
export function previousRequests(
  threads: Array<VerebonaThread & { lastAnswer?: string | null }>,
  currentId: number | null,
  now: Date = new Date(),
  max = MAX_PREVIOUS_REQUESTS,
): PreviousRequestRow[] {
  return threads
    .filter((t) => t.id !== currentId && t.messageCount > 0)
    .slice(0, max)
    .map((t) => {
      const n = Math.max(1, Math.round(t.messageCount / 2));
      const parts = [relativeMoment(t.lastMessageAt ?? t.createdAt, now)];
      if (n > 1) parts.push(exchangeCountLabel(n));
      const resume = t.lastAnswer ? firstSentence(t.lastAnswer, 48) : '';
      if (resume) parts.push(resume);
      return { id: t.id, title: t.title?.trim() || 'Demande sans titre', sub: parts.filter(Boolean).join(' · ') };
    });
}
