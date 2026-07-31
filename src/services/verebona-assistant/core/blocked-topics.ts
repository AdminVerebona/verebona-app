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

export function checkBlockedTopic(question: string): TopicCheck {
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
