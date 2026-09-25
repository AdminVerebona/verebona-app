/**
 * Dictionnaire de navigation et action principale — CDC §22.9, §22.10,
 * §10.5, CA-14, 37.4, 37.11, 37.15.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE ACTION PRINCIPALE, PERTINENTE
 *
 * « Une action principale par réponse ; au maximum deux secondaires ; l'action
 *   principale doit correspondre à la prochaine étape la plus utile » (§22.9).
 *
 * Avant : tous les types sans cible autorisés pour l'intention étaient
 * ajoutés en bloc. « Ouvre mon agenda » donnait trois boutons (Ouvrir
 * l'agenda, Voir « À traiter », Ouvrir mon compte) et « Comment ajouter un
 * document ? » proposait « Ajouter un bien ».
 *
 * Ici : la destination est lue dans le message (agenda, À traiter,
 * documents, compte, offres, aide) et donne UNE action. Les routes restent
 * construites par le résolveur (§22.7) ; ce module ne choisit que le TYPE.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { VerebonaActionType } from '../types/actions';
import type { VerebonaIntent } from '../types/intents';
import { normalizeForRouting, word } from './routing-text';

export interface NavigationTarget {
  key: 'to_process' | 'agenda' | 'documents' | 'account' | 'pricing' | 'help';
  action: VerebonaActionType;
  /** Gabarit de réponse court (§22.10 : bouton unique, aucune ouverture auto). */
  answer: string;
  pattern: RegExp;
}

/**
 * Ordre significatif : « À traiter » avant « documents » (« les documents à
 * traiter » visent la page À traiter), l'aide en dernier (« centre d'aide »
 * ne doit pas masquer un objet plus précis).
 */
export const NAVIGATION_TARGETS: readonly NavigationTarget[] = [
  { key: 'to_process', action: 'OPEN_TO_PROCESS', answer: 'Voici vos éléments « À traiter ».', pattern: word("a traiter|elements? a traiter|taches? a traiter") },
  { key: 'agenda', action: 'OPEN_AGENDA', answer: 'Voici votre agenda.', pattern: word('agenda|calendrier|planning|echeances?|rendez-vous|rappels') },
  { key: 'documents', action: 'OPEN_DOCUMENTS_PAGE', answer: 'Voici vos documents.', pattern: word('documents|mes documents|mes fichiers|fichiers|justificatifs') },
  { key: 'account', action: 'OPEN_ACCOUNT', answer: 'Voici votre compte.', pattern: word('mon compte|compte|profil|parametres|reglages') },
  { key: 'pricing', action: 'OPEN_PRICING', answer: 'Voici les offres Verebona.', pattern: word('offres?|abonnements?|tarifs?|forfaits?') },
  { key: 'help', action: 'OPEN_HELP', answer: 'Voici le Centre d’aide.', pattern: word("aide|centre d'aide|faq|support") },
];

/** Destination nommée dans le message, ou `null`. */
export function findNavigationTarget(message: string): NavigationTarget | null {
  const t = normalizeForRouting(message);
  return NAVIGATION_TARGETS.find((n) => n.pattern.test(t)) ?? null;
}

// ── Aide produit : l'action qui fait ce que la question demande ────────────

const ADD_VERB = word('ajouter|ajoute|deposer|depose|importer|importe|televerser|telecharger|charger|scanner|creer|cree|enregistrer|upload|uploader|add|create');
const ADD_DOC = word('documents?|factures?|fichiers?|justificatifs?|pieces? jointes?|photos?|contrats?|garanties?|document|file');
const ADD_ASSET = word('biens?|maisons?|appartements?|vehicules?|voitures?|logements?|asset');
const ADD_AGENDA = word('echeances?|rappels?|rendez-vous|evenements?|taches?|agenda');

/**
 * Action principale d'une question d'aide (§10.5, 37.4, 37.15) :
 *   - « comment ajouter / déposer un document », « where can I upload a
 *     document » → Ajouter un document ;
 *   - « … un bien » → Ajouter un bien ; « … une échéance » → Créer une échéance ;
 *   - « à quoi sert À traiter ? » → la page nommée (Ouvrir « À traiter »).
 * `null` : l'aide seule (OPEN_HELP) reste proposée.
 */
export function helpPrimaryAction(message: string, intent: VerebonaIntent): VerebonaActionType | null {
  const t = normalizeForRouting(message);
  if (intent === 'PRODUCT_HELP_HOW_TO' && ADD_VERB.test(t)) {
    if (ADD_DOC.test(t)) return 'START_ADD_DOCUMENT';
    if (ADD_AGENDA.test(t)) return 'START_ADD_AGENDA_ITEM';
    if (ADD_ASSET.test(t)) return 'START_ADD_ASSET';
  }
  const nav = findNavigationTarget(message);
  return nav && nav.action !== 'OPEN_HELP' ? nav.action : null;
}

/**
 * Action de repli sans cible, UNE seule, par intention — la page où
 * poursuivre quand aucune entité précise n'a été trouvée.
 */
export const DEFAULT_ACTION_BY_INTENT: Partial<Record<VerebonaIntent, VerebonaActionType>> = {
  ACCOUNT_TO_PROCESS: 'OPEN_TO_PROCESS',
  ACCOUNT_SEARCH_DOCUMENT: 'OPEN_DOCUMENTS_PAGE',
  ACCOUNT_SEARCH_SUPPLIER: 'OPEN_DOCUMENTS_PAGE',
  ACCOUNT_SEARCH_AGENDA: 'OPEN_AGENDA',
  ACCOUNT_MISSING_INFORMATION: 'OPEN_TO_PROCESS',
  PRODUCT_HELP_HOW_TO: 'OPEN_HELP',
  PRODUCT_HELP_EXPLAIN: 'OPEN_HELP',
  PRODUCT_HELP_STATUS: 'OPEN_HELP',
  PRODUCT_PLAN_LIMIT: 'OPEN_PRICING',
  NAVIGATION_FIND: 'OPEN_HELP',
  EXPORT_HELP: 'OPEN_HELP',
  TECHNICAL_ISSUE: 'OPEN_HELP',
  UNSUPPORTED_ACTION: 'OPEN_HELP',
  SENSITIVE_ADVICE: 'OPEN_HELP',
};
