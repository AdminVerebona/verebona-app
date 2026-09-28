/**
 * Filtrage du texte produit par le modèle — CDC §18.7, CA-09, 37.12.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE TEXTE D'UNE AFFIRMATION SOURCÉE PASSAIT TEL QUEL
 *
 * Les actions du modèle étaient ignorées et la réponse reconstruite à partir
 * des affirmations validées — mais le TEXTE de ces affirmations n'était pas
 * contrôlé : une URL libre, un lien Markdown, du HTML ou du JavaScript cité
 * dans une affirmation sourcée atteignait le client. Le §18.7 interdit au
 * modèle de produire directement une URL libre, du HTML ou du JavaScript,
 * une requête SQL ou une instruction à exécuter.
 *
 * Règles, appliquées à CHAQUE phrase avant qu'elle n'entre dans la réponse :
 *   · balises HTML, liens Markdown, URL (http, www, schémas) : RETIRÉS du
 *     texte (le libellé d'un lien Markdown est conservé) ;
 *   · script, gestionnaire d'événement, `javascript:`, requête SQL, commande
 *     de suppression : l'affirmation est REJETÉE en entier — la retoucher
 *     laisserait une phrase au sens imprévisible ;
 *   · un texte vidé par le filtrage est rejeté.
 * Chaque retrait ou rejet devient un ÉVÉNEMENT DE SÉCURITÉ, journalisé et
 * enregistré dans la trace de la demande (37.12).
 * ══════════════════════════════════════════════════════════════════════════
 */

export type SecurityEventCode =
  | 'MODEL_URL_STRIPPED'
  | 'MODEL_MARKUP_STRIPPED'
  | 'MODEL_SCRIPT_REJECTED'
  | 'MODEL_SQL_REJECTED'
  | 'MODEL_ACTION_REJECTED'
  | 'MODEL_UNKNOWN_SOURCE_REJECTED'
  /** §18.5 : intention de la sortie ≠ intention routée par le serveur. */
  | 'MODEL_INTENT_MISMATCH'
  /** §21.5 : tournure du vocabulaire interdit dans la réponse. */
  | 'MODEL_FORBIDDEN_VOCABULARY';

export interface SecurityEvent {
  code: SecurityEventCode;
  /** Clé de l'affirmation concernée, ou type d'action rejetée. */
  target?: string;
  /** Détail court, jamais le texte complet (pas de contenu du compte). */
  detail?: string;
}

const SCRIPT = /<\s*\/?\s*script\b|javascript\s*:|vbscript\s*:|\bon[a-z]+\s*=\s*["']|data\s*:\s*text\/html/i;
const SQL = /\b(select\s+[\w*,\s]+\s+from|insert\s+into|update\s+\w+\s+set|delete\s+from|drop\s+(table|database)|truncate\s+table|alter\s+table)\b/i;
const HTML_TAG = /<\s*\/?\s*[a-z][a-z0-9-]*(\s[^<>]*)?\/?\s*>/gi;
const HTML_ENTITY_TAG = /&lt;\s*\/?\s*[a-z][^&]*&gt;/gi;
const MD_LINK = /!?\[([^\]]*)\]\(([^)\s]*)[^)]*\)/g;
const URL = /\b(?:https?|ftp|file|mailto|tel|sms|intent|data):\/*[^\s<>"')\]]+|\bwww\.[^\s<>"')\]]+/gi;
/** Domaine nu (« exemple.com/page ») : TLD courants seulement, pour ne pas toucher « 12.5 » ni « M. Dupont ». */
const BARE_DOMAIN = /\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|fr|net|org|io|info|biz|eu|be|ch|co|me|app|dev|xyz|ly|gl|gov|edu)(?:\/[^\s<>"')\]]*)?\b/gi;

/** `test` sans état résiduel sur une expression globale. */
function has(re: RegExp, s: string): boolean {
  re.lastIndex = 0;
  const r = re.test(s);
  re.lastIndex = 0;
  return r;
}

export interface SanitizedText {
  text: string;
  /** Affirmation à rejeter en entier. */
  rejected: boolean;
  events: SecurityEvent[];
}

/** Filtre une phrase du modèle. `target` = clé de l'affirmation (trace). */
export function sanitizeModelText(raw: string, target?: string): SanitizedText {
  const events: SecurityEvent[] = [];
  const src = String(raw ?? '');
  if (SCRIPT.test(src)) {
    return { text: '', rejected: true, events: [{ code: 'MODEL_SCRIPT_REJECTED', target }] };
  }
  if (SQL.test(src)) {
    return { text: '', rejected: true, events: [{ code: 'MODEL_SQL_REJECTED', target }] };
  }
  let text = src;
  if (has(MD_LINK, text)) {
    events.push({ code: 'MODEL_URL_STRIPPED', target, detail: 'lien markdown' });
    text = text.replace(MD_LINK, (_m, label: string) => label);
  }
  if (has(HTML_TAG, text) || has(HTML_ENTITY_TAG, text)) {
    events.push({ code: 'MODEL_MARKUP_STRIPPED', target });
    text = text.replace(HTML_TAG, ' ').replace(HTML_ENTITY_TAG, ' ');
  }
  const avantUrl = text;
  text = text.replace(URL, ' ').replace(BARE_DOMAIN, ' ');
  if (text !== avantUrl && !events.some((e) => e.code === 'MODEL_URL_STRIPPED')) {
    events.push({ code: 'MODEL_URL_STRIPPED', target });
  }
  text = text
    .replace(/\(\s*\)|\[\s*\]/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  // Une phrase réduite à de la ponctuation ou à un mot isolé n'informe plus.
  if (!/[\p{L}\p{N}]{2,}/u.test(text)) return { text: '', rejected: true, events };
  return { text, rejected: false, events };
}

/** Le texte contient-il encore une URL ou du balisage ? (garde de test) */
export function containsUrlOrMarkup(text: string): boolean {
  return has(URL, text) || has(HTML_TAG, text) || SCRIPT.test(text) || has(BARE_DOMAIN, text);
}

/**
 * Journalise les événements de sécurité d'une demande. Ne lève jamais.
 * Ils sont AUSSI enregistrés dans la trace persistée de la demande
 * (`verebona_request_runs.retrieval_methods_json.securityEvents`) par
 * l'orchestrateur.
 */
export function logSecurityEvents(events: SecurityEvent[], ctx: { requestId?: string; accountId?: number }): void {
  if (!events.length) return;
  try {
    console.warn('[verebona][securite]', JSON.stringify({
      requestId: ctx.requestId ?? null, accountId: ctx.accountId ?? null,
      events: events.map((e) => ({ code: e.code, target: e.target ?? null, detail: e.detail ?? null })),
    }));
  } catch { /* journalisation impossible : sans effet sur la réponse */ }
}

/**
 * Vocabulaire interdit — CDC §21.5. Une réponse qui en contient n'est pas
 * affichée : elle est rejetée (`QUALITY_RULE`, §15.4 d — escalade permise,
 * sinon repli déterministe). Comparaison sans casse ni accents, sur des
 * mots entiers (« prompte » ou « tokenisation » ne déclenchent rien).
 */
export const FORBIDDEN_VOCABULARY: ReadonlyArray<{ code: string; re: RegExp }> = [
  { code: 'en tant qu’IA', re: /\ben tant qu['’ ]?(une )?(ia|intelligence artificielle)\b/ },
  { code: 'hallucination', re: /\bhallucination(s)?\b/ },
  { code: 'score de confiance', re: /\bscore(s)? de confiance\b/ },
  { code: 'prompt', re: /\bprompt(s)?\b/ },
  { code: 'token', re: /\btoken(s)?\b/ },
  { code: 'je garantis', re: /\bje (vous )?garantis\b/ },
  { code: 'je certifie', re: /\bje (vous )?certifie\b/ },
  { code: 'je vous conseille juridiquement', re: /\bje vous conseille juridiquement\b/ },
  { code: 'je suis sûr à 100 %', re: /\bje suis (sur|certain) a 100\s?(%|pour ?cent)/ },
];

const sansAccents = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/’/g, "'");

/** Tournures interdites présentes dans un texte (codes lisibles, sans doublon). */
export function findForbiddenVocabulary(text: string): string[] {
  const t = sansAccents(String(text ?? ''));
  return FORBIDDEN_VOCABULARY.filter((f) => f.re.test(t)).map((f) => f.code);
}
