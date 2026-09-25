/**
 * Sujets réservés — CDC Assistant §4.3.3 et §13 du CDC Refonte.
 *
 * ── DÉPLACÉ DEPUIS `src/services/ai/assistant/` ────────────────────────────
 *
 * Ce module vivait dans une implémentation d'assistant qui n'est branchée à
 * aucune route : seul le cron de purge des journaux l'importait. Le contrôle
 * des sujets réservés n'était donc JAMAIS exécuté sur les questions réelles,
 * qui passent toutes par `/api/verebona/messages`.
 *
 * Ce n'est pas une lacune de confort : le §13 interdit à l'assistant de
 * donner un conseil juridique, fiscal, médical ou assurantiel personnalisé.
 * Un contrôle écrit mais non appelé ne protège de rien.
 *
 * « Aucun conseil juridique, fiscal, médical ou assurantiel personnalisé. »
 *
 * DISTINCTION IMPORTANTE, et c'est tout l'enjeu de ce module : la question
 * « quel est le montant de ma prime d'assurance ? » est une question sur les
 * DONNÉES du compte, parfaitement légitime. La question « dois-je changer
 * d'assurance ? » demande un CONSEIL personnalisé, et doit être refusée.
 *
 * Bloquer trop large rendrait l'assistant inutile sur la moitié du patrimoine
 * de l'utilisateur ; bloquer trop peu l'exposerait à donner des conseils qu'il
 * n'a pas qualité à donner. Le critère retenu est la présence d'une demande de
 * recommandation ou d'appréciation, pas la présence d'un mot-clé thématique.
 */

export type BlockReason = 'legal' | 'tax' | 'medical' | 'insurance_advice' | null;

/** Formulations exprimant une demande de conseil, de décision ou d'appréciation. */
const ADVICE_PATTERNS: RegExp[] = [
  /\bdois-?je\b/i, /\bfaut-?il que je\b/i, /\bdevrais-?je\b/i,
  /\bme conseill/i, /\bque me conseill/i, /\bvotre avis\b/i,
  /\bai-?je (le )?droit\b/i, /\bpuis-?je\b/i,
  /\bque dois-je faire\b/i, /\bqu'est-ce que je risque\b/i,
  /\bes[t]?-ce que je suis\b/i, /\bsuis-?je (bien )?(couvert|imposable|obligé|responsable)/i,
  /\bcomment (éviter|réduire|contourner|optimiser)/i,
  /\bvaut-il mieux\b/i, /\best-il préférable\b/i,
  /\bquelle? .{0,20}(choisir|prendre|souscrire)\b/i,
  /\bchanger d'assurance\b/i,
  // Appréciations : « est-ce une bonne franchise ? », « ce préavis est-il
  // légal ? » — le critère reste la demande de jugement, pas le thème.
  /\best-ce (une |un )?(bon|bonne|bien|normal|correct|cher|raisonnable|suffisant|adapté|legal|légal|abusif|conforme)/i,
  /\best-ce que (ce|cette|cet|mon|ma|mes)\b.{0,40}\b(légal|legal|légale|legale|abusi[fv]e?|conforme|normal|normale|adapté|adaptée|suffisant|suffisante|valable)\b/i,
  /\b(est|sont)-(il|elle|ils|elles) (légal|legal|légale|legale|abusi[fv]e?|conforme|normal|normale|adapté|adaptée|suffisant|suffisante|valable)/i,
  /\bchanger d'assureur\b/i,
];

/**
 * Domaines réservés, exprimés en RADICAUX et non en mots entiers.
 *
 * ⚠️ Erreur corrigée lors de la première exécution des tests : les motifs
 * étaient encadrés de `\b` des deux côtés, si bien que « défiscalis » ne
 * pouvait jamais reconnaître « défiscalisation », ni « expulsion » reconnaître
 * « expulser ». Quatre questions de conseil passaient donc au travers du
 * filtre. Le radical est désormais ouvert à droite.
 */
const DOMAIN_PATTERNS: Array<{ reason: NonNullable<BlockReason>; pattern: RegExp }> = [
  { reason: 'legal', pattern: /(juridiqu|litige|tribunal|avocat|contentieux|prud'hom|\bbail\b|expuls|servitude|copropriét|locataire|préavis|résili|succession|indivision)/i },
  { reason: 'tax', pattern: /(fiscal|défiscalis|defiscalis|impôt|impot|\btaxe|\bifi\b|plus-value|abattement|déclaration de revenus)/i },
  { reason: 'medical', pattern: /(médical|medical|santé|sante|symptôm|symptom|maladie|traitement|toxicité|toxicite)/i },
  { reason: 'insurance_advice', pattern: /(assurance|assureur|garantie|couvert|franchise|mutuelle|sinistre)/i },
];

export interface TopicCheck {
  blocked: boolean;
  reason: BlockReason;
  /** Message affiché à l'utilisateur — factuel, sans reproche. */
  message?: string;
}

export function checkBlockedTopic(input: string): TopicCheck {
  // Apostrophe typographique (« d’assurance ») : les motifs utilisent l'ASCII.
  const question = input.replace(/[’‘]/g, "'");
  const asksForAdvice = ADVICE_PATTERNS.some((p) => p.test(question));
  if (!asksForAdvice) return { blocked: false, reason: null };

  for (const { reason, pattern } of DOMAIN_PATTERNS) {
    if (pattern.test(question)) {
      return { blocked: true, reason, message: MESSAGES[reason] };
    }
  }

  return { blocked: false, reason: null };
}

const MESSAGES: Record<NonNullable<BlockReason>, string> = {
  legal:
    "Je peux retrouver vos documents et les informations qu'ils contiennent, mais je ne peux pas " +
    "vous conseiller sur une question juridique. Pour une décision de cette nature, adressez-vous " +
    'à un professionnel du droit.',
  tax:
    "Je peux retrouver les montants et les dates figurant dans vos documents, mais je ne peux pas " +
    'vous conseiller en matière fiscale. Un conseiller fiscal ou votre centre des impôts sera plus utile.',
  medical:
    "Je ne peux pas répondre à une question de santé. Adressez-vous à un professionnel de santé.",
  insurance_advice:
    "Je peux vous indiquer ce que disent vos contrats — garanties, montants, échéances — mais pas " +
    "juger si votre couverture est adaptée. Votre assureur ou un courtier pourra le faire.",
};

// ══════════════════════════════════════════════════════════════════════════
// REQUÊTES MIXTES — répondre à ce qui est autorisé, refuser le reste
//
// « Quelle est la date d'échéance de mon contrat et est-ce que je devrais
// changer d'assureur ? » : le contrôle global refusait TOUT le message, et la
// date — une donnée du compte, parfaitement légitime — n'était jamais
// cherchée. Le message est désormais découpé en sous-demandes, chacune
// classée par le même critère (demande de conseil dans un domaine réservé).
// La provenance compte avant le sujet : restituer une donnée du compte sur
// un thème sensible reste autorisé.
// ══════════════════════════════════════════════════════════════════════════

export type ScopeKind = 'FULLY_ALLOWED' | 'PARTIALLY_ALLOWED' | 'FULLY_BLOCKED' | 'AMBIGUOUS';

export interface SubRequest {
  text: string;
  allowed: boolean;
  reason: BlockReason;
}

export interface ScopeAnalysis {
  kind: ScopeKind;
  parts: SubRequest[];
  /** Texte des seules sous-demandes autorisées — c'est lui qui suit le flux T2. */
  allowedText: string;
  /** Refus ciblé(s), à ajouter à la réponse de la partie autorisée. */
  refusal: string | null;
  /** Question de clarification quand la séparation n'est pas fiable. */
  clarification: string | null;
  reasons: NonNullable<BlockReason>[];
}

/** Début d'une nouvelle sous-demande après « et », « mais », « aussi »… */
const SPLIT = /\s*(?:[?;!]|\.(?=\s|$))\s*|\s+(?:et|mais|puis|aussi|et aussi|ensuite)\s+(?=(?:est-ce|dois-je|devrais-je|faut-il|puis-je|pourrais-je|vaut-il|comment|que |qu'|quel|quelle|quels|quelles|quand|combien|où|ou est|me conseill|ai-je|suis-je|est-il|est-elle|y a-t-il|sais-tu|peux-tu|pouvez-vous|donne|dis-moi|indique)\b)/i;

/** Appréciation dont on ne peut séparer ni la donnée ni le conseil de façon fiable. */
const AMBIGU = /\b(que penser|qu'en penser|qu'en penses?-tu|qu'en pensez-vous|ton avis sur|votre avis sur|que vaut|que valent)\b/i;

/** Refus ciblés, à accoler à la réponse factuelle. */
const PARTIAL_MESSAGES: Record<NonNullable<BlockReason>, string> = {
  insurance_advice: "En revanche, je peux vous indiquer ce que contiennent vos contrats, mais pas vous conseiller sur le choix ou le changement de votre assurance.",
  legal: "En revanche, je ne peux pas déterminer si cela est juridiquement applicable à votre situation : un professionnel du droit pourra vous répondre.",
  tax: "En revanche, je ne peux pas vous conseiller en matière fiscale : un conseiller fiscal ou votre centre des impôts sera plus utile.",
  medical: "En revanche, je ne peux pas répondre à la question de santé : adressez-vous à un professionnel de santé.",
};

const CLARIFY: Record<NonNullable<BlockReason>, string> = {
  insurance_advice: "Je peux vous indiquer ce que prévoient vos contrats (montants, franchises, garanties, échéances), mais pas juger s’ils sont adaptés. Voulez-vous que je retrouve cette information dans vos documents ?",
  legal: "Je peux vous indiquer ce que disent vos documents, mais pas apprécier leur portée juridique. Voulez-vous que je retrouve cette information ?",
  tax: "Je peux retrouver les montants et dates de vos documents, mais pas les apprécier sur le plan fiscal. Voulez-vous que je retrouve cette information ?",
  medical: "Je ne peux pas apprécier une question de santé, mais je peux retrouver les informations de vos documents. Voulez-vous que je les recherche ?",
};

export function splitSubRequests(message: string): string[] {
  return message.split(SPLIT).map((x) => x?.trim()).filter((x): x is string => !!x && x.length >= 3);
}

/**
 * Analyse du périmètre, sous-demande par sous-demande.
 *
 *   · FULLY_ALLOWED     : parcours classique, inchangé ;
 *   · PARTIALLY_ALLOWED : seules les parties autorisées suivent le flux T2
 *                         (routage, retrieval, éventuelle IA) ; la partie
 *                         interdite ne déclenche ni retrieval ni appel modèle ;
 *   · FULLY_BLOCKED     : refus, comme avant ;
 *   · AMBIGUOUS         : appréciation mêlée à une donnée (« que penser de ma
 *                         franchise ? ») — on propose de restituer la donnée
 *                         plutôt que de refuser en bloc.
 */
export function analyzeScope(message: string): ScopeAnalysis {
  const texte = message.replace(/[’‘]/g, "'");
  const parts = splitSubRequests(texte);
  const list = parts.length ? parts : [texte];
  // Le texte rendu est celui de l'utilisateur (apostrophes d'origine) : la
  // normalisation ne change pas les longueurs, les positions se retrouvent.
  let curseur = 0;
  const original = (t: string) => {
    const i = texte.indexOf(t, curseur);
    if (i < 0) return t;
    curseur = i + t.length;
    return message.slice(i, i + t.length);
  };
  const sub: SubRequest[] = list.map((t) => {
    const c = checkBlockedTopic(t);
    return { text: original(t), allowed: !c.blocked, reason: c.reason };
  });

  // Appréciation sur un domaine réservé, sans demande factuelle séparable.
  if (sub.length === 1 && sub[0].allowed && AMBIGU.test(texte)) {
    const domaine = DOMAIN_PATTERNS.find((d) => d.pattern.test(texte));
    if (domaine) {
      return {
        kind: 'AMBIGUOUS', parts: [{ text: message, allowed: false, reason: domaine.reason }], allowedText: '',
        refusal: null, clarification: CLARIFY[domaine.reason], reasons: [domaine.reason],
      };
    }
  }

  const reasons = [...new Set(sub.filter((x) => !x.allowed).map((x) => x.reason!).filter(Boolean))];
  const allowed = sub.filter((x) => x.allowed);
  if (reasons.length === 0) {
    return { kind: 'FULLY_ALLOWED', parts: sub, allowedText: message, refusal: null, clarification: null, reasons: [] };
  }
  if (allowed.length === 0) {
    return {
      kind: 'FULLY_BLOCKED', parts: sub, allowedText: '',
      refusal: reasons.map((r) => MESSAGES[r]).join(' '), clarification: null, reasons,
    };
  }
  return {
    kind: 'PARTIALLY_ALLOWED',
    parts: sub,
    allowedText: allowed.map((x) => (/[?.!]$/.test(x.text) ? x.text : `${x.text} ?`)).join(' '),
    refusal: reasons.map((r) => PARTIAL_MESSAGES[r]).join(' '),
    clarification: null,
    reasons,
  };
}
