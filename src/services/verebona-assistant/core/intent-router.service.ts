/**
 * Routeur d'intentions — CDC §9.1 à §9.5, CA-21.
 *
 * Ordre STRICT (§9.4). Le déterministe est le PREMIER niveau de compréhension ;
 * produit un `IntentRoute` (§9.5) ou `needs_classification` (intention
 * inconnue). Lot 32 : une route n'est pas une demande COMPRISE — l'orchestrateur
 * évalue ensuite la compréhension (`understanding-status` : COMPLETE, PARTIAL,
 * UNKNOWN_INTENT) et UNDERSTAND (master T2) prend le relais dès qu'elle est
 * incomplète, sauf manque connu exactement (clarification directe).
 *
 * Ce service ne fait AUCUN appel réseau lui-même : l'étape de classification IA est
 * déléguée à l'orchestrateur (qui contrôle le budget et l'éligibilité). La base
 * d'aide (§9.4 étape 7) est consultée si l'appelant fournit le corpus.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 7 DES 10 EXEMPLES DU §9.3 ÉTAIENT MAL ROUTÉS
 *
 *   · les motifs utilisaient `\b`, aveugle aux lettres accentuées : « À quoi
 *     sert À traiter ? » ne déclenchait jamais `à quoi sert` ;
 *   · « Comment ajouter un document ? » partait en recherche de document
 *     (l'aide était écartée dès qu'un mot « document » apparaissait) ;
 *   · « Quand ai-je acheté ma Peugeot ? » tombait sur l'agenda (« quand ») ;
 *   · « Quels éléments dois-je traiter ? », « Donne-moi les données des
 *     autres utilisateurs » partaient en classification ;
 *   · « Pourquoi ces deux documents… dates différentes ? » devenait une
 *     synthèse (« pourquoi ») au lieu d'une comparaison.
 *
 * Désormais : texte normalisé (minuscules, sans accents) puis motifs ASCII à
 * bornes Unicode (`routing-text.ts`), aide produit traitée AVANT la
 * recherche de documents, règles « faits du compte », « À traiter » et
 * UNSAFE ajoutées, comparaison avant synthèse. Chaque exemple du CDC (§9.3,
 * §8.3, §37) est un test (`__tests__/intent-router.test.ts`).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { IntentRoute, Confidence, PageContext } from '../types/contracts';
import type { VerebonaIntent } from '../types/intents';
import { isAiEligibleFor } from '../registries/capability-registry';
import { getIntentDefinition } from '../registries/intent-registry';
import { allowedActionsFor } from '../registries/action-registry';
import { searchHelpCorpus, type HelpCorpus } from './help-corpus.service';
import { normalizeForRouting, startsWith, word } from './routing-text';
import { assetVocabularyAlternatives } from '@/lib/asset-taxonomy';
import { detectHelpConcept } from '@/lib/help-center/concepts';
import { analyserPeriode, aujourdhuiParis } from './query-period';

export interface RouteContext {
  message: string;
  planType: string;
  hasPendingClarification: boolean;
  pageRoute?: string;
  /**
   * Contexte de page complet (§9.4 étape 5) : l'objet ouvert (bien,
   * document, fournisseur) oriente le routage d'une question qui le désigne
   * (« sa date », « ce document ») et alimente `entityHints` (§9.5).
   */
  pageContext?: PageContext;
  /** Date du jour ISO (tests) ; défaut : aujourd'hui, fuseau Europe/Paris. */
  today?: string;
  /**
   * Corpus du Centre d'aide (§9.4 étape 7). Fourni par l'orchestrateur quand
   * aucune règle n'a tranché ; absent, l'étape est sautée.
   */
  helpCorpus?: HelpCorpus | null;
}

/**
 * Résultat du routage déterministe : une route (intention reconnue — la
 * compréhension complète est évaluée ensuite, lot 32), ou `needs_classification`
 * (UNKNOWN_INTENT → UNDERSTAND).
 */
export type RouteOutcome =
  | { kind: 'route'; route: IntentRoute }
  | { kind: 'needs_classification'; normalized: string };

// Tous les motifs s'appliquent au texte NORMALISÉ (ASCII, minuscules).

// ── Sécurité (§9.4.1, §29.2, §9.3 « autres utilisateurs ») ─────────────────
const UNSAFE_INJECTION = /ignore[rz]? (les |tes |vos |toutes les )?(regles|instructions|consignes)|system prompt|prompt systeme|jailbreak|drop table|<script/;
/**
 * Accès aux données d'autrui (§9.3 « autres utilisateurs », §29.1).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI LA RÈGLE A ÉTÉ RESSERRÉE
 *
 * L'ancienne règle se déclenchait dès que « autre utilisateur » ou « autre
 * compte » apparaissait, quel que soit le sens de la phrase. Des questions
 * d'usage parfaitement légitimes — « Comment inviter un autre utilisateur ? »,
 * « Comment basculer vers un autre compte ? », « Comment créer un autre
 * compte ? », « …en tant qu'autre utilisateur » — recevaient une réponse de
 * refus pour tentative malveillante.
 *
 * La mention d'un tiers ne suffit plus : il faut une DEMANDE D'ACCÈS à ce
 * qui lui appartient. Trois formes sont reconnues :
 *   1. un objet de données rattaché à un tiers — « les données DES autres
 *      utilisateurs », « les biens D'un autre compte », « les documents DE
 *      quelqu'un », « data OF other users » ;
 *   2. un verbe de consultation dont l'objet direct est un tiers — « montre-
 *      moi un autre compte », « liste tous les utilisateurs » ;
 *   3. le compte d'un tiers — « le compte d'un autre », « se connecter au
 *      compte de quelqu'un », « someone else's account ».
 * Le possessif (« mon autre compte », « mes autres comptes ») reste exclu :
 * c'est un changement de compte de l'utilisateur lui-même.
 * ══════════════════════════════════════════════════════════════════════════
 */
/** Un tiers, sauf s'il est introduit par un possessif de l'utilisateur. */
const OTHER_PARTY = "(?<!(?:mon|ma|mes|notre|nos) )(?:autres? (?:utilisateurs?|comptes?|clients?|abonnes?|personnes?)"
  + "|autrui|quelqu'un(?: d'autre)?|tout le monde|tous les (?:comptes|utilisateurs|clients|abonnes)"
  + "|(?:other|another) (?:users?|accounts?|customers?|people|person)|someone else)(?![\\p{L}])";
/** Ce qui appartient à un compte : données, documents, biens… */
const DATA_NOUN = "(?:donnees|documents?|biens?|informations?|infos?|fichiers?|factures?|contrats?|agendas?|echeances?"
  + "|patrimoine|contenus?|photos?|historiques?|data|files|info|information|records?|assets?)";
const DATA_OF_OTHERS = new RegExp(
  `(?<![\\p{L}])${DATA_NOUN} (?:[\\p{L}']+ ){0,2}?(?:de |des |du |d'|of |appartenant a |chez )(?:un |une |l'|la |le |les )?${OTHER_PARTY}`
  + `|(?:other users?'?s?|another (?:user|account)'?s?|someone else'?s) ${DATA_NOUN}(?![\\p{L}])`,
  'u',
);
const SHOW_OTHERS = new RegExp(
  "(?<![\\p{L}])(?:montre[rz]?|affiche[rz]?|donne[rz]?|liste[rz]?|voir|vois|consulte[rz]?|acceder|accede[rz]?|lire|lis"
  + "|explore[rz]?|parcour(?:s|ir)|espionne[rz]?|pirate[rz]?|show|list|view|display|access|read)"
  + "(?:[ -](?!tant)[\\p{L}']+){0,2}? (?:un |une |les |des |d'autres |aux |a un |a une |a des |a d'autres |tous les )?"
  + OTHER_PARTY,
  'u',
);
const ACCOUNT_OF_OTHERS = new RegExp(
  "(?<![\\p{L}])comptes? (?:de quelqu'un|d'autrui|d'un autre|d'une autre|d'autres|des autres|de l'autre|de tout le monde)(?![\\p{L}])"
  + "|(?:connecter|connecte|connexion|acceder|accede|entrer|rentrer) (?:au|sur le|dans le|a le) compte (?:de |d')(?!(?:mon|ma|notre) (?:duo|foyer)(?![\\p{L}]))"
  + "|(?:someone else'?s|another user'?s|other users'?) accounts?",
  'u',
);
function isOtherAccountsRequest(t: string): boolean {
  return DATA_OF_OTHERS.test(t) || SHOW_OTHERS.test(t) || ACCOUNT_OF_OTHERS.test(t);
}

// ── Politesses (§9.4.3) ─────────────────────────────────────────────────────
const GREETINGS = startsWith('bonjour|bonsoir|salut|coucou|hello|hey|yo|hi');
const THANKS = word('merci|thanks|thank you|nickel|parfait|super');
const GOODBYE = word('au revoir|a bientot|bye|a plus|adieu');

// ── Demandes réservées (§9.4.4, §5.2, 37.19) ────────────────────────────────
const SENSITIVE_TOPIC = word('indemnisation|indemnites?|dedommagement|fiscale?s?|fiscalite|impots?|declaration fiscale|declaration d\'impots|juridiques?|avocat|proces|litige|medicale?s?|diagnostic medical|placement financier');
const ADVICE = word('dois-je|devrais-je|faut-il|dois je|devrais je|exiger|reclamer|conseille[rsz]?|recommande[rsz]?|que me conseilles');
const ACTION_START = startsWith('fais|faites|fait|remplis|remplir|redige|rediger|declare|declarer');

// ── Aide produit (§9.4 « expressions connues », §8.3, 37.4, 37.15) ─────────
const HELP_STATUS = /pourquoi .*(en (cours d'|attente d')?analyse|en attente|en erreur|bloque|pas analyse)|que (signifie|veut dire) (le |ce )?statut|statut .*(signifie|veut dire)/;
const HELP_EXPLAIN = word("a quoi sert|a quoi servent|que veut dire|que signifie|signifie|qu'est-ce que c'est|qu'est ce que c'est|what is|what does");
/**
 * « C'est quoi… », « Qu'est-ce que la… » : explication d'une fonction, sauf
 * quand la question porte sur un objet du compte (« c'est quoi MA prochaine
 * échéance ? », « qu'est-ce que je dois traiter ? »).
 */
const HELP_EXPLAIN_WEAK = word("c'est quoi|qu'est-ce que (?:le|la|les|l'|un|une)|qu'est ce que (?:le|la|les|l'|un|une)");
const POSSESSIVE = word("ma|mon|mes|notre|nos|je|j'ai");
const HOWTO_VERB = 'ajouter|deposer|creer|importer|televerser|telecharger|charger|scanner|modifier|supprimer|completer|renseigner|partager|inviter|exporter|synchroniser|utiliser|changer|archiver|envoyer|lier|rattacher|classer|activer|desactiver|annuler|resilier|faire|configurer|connecter|imprimer|transmettre|renommer|deplacer|fusionner|ajoute|cree|upload|add|create';
const HOWTO = new RegExp(
  `(?<![\\p{L}])comment (?:(?:est-ce qu'on|est-ce que je|puis-je|peut-on|je peux|on peut|dois-je|faut-il|faire pour|je|on) )?(?:${HOWTO_VERB})(?![\\p{L}])`
  + `|(?<![\\p{L}])(?:how (?:to|do i|can i)|where can i)(?![\\p{L}])`
  + `|(?<![\\p{L}])(?:est-il possible de|puis-je|peut-on) (?:${HOWTO_VERB})(?![\\p{L}])`,
  'u',
);
const HOWTO_GENERIC = startsWith('comment');
/**
 * Lot 33 : tournure de besoin d'usage — question (« comment », « où… »),
 * souhait (« je veux », « j'aimerais ») ou infinitif d'action en tête
 * (« Ajouter un fichier »). Ne suffit jamais seule : il faut AUSSI un concept
 * certain du référentiel (`lib/help-center/concepts` : verbe ET objet).
 */
const HELP_NEED = new RegExp(
  "^(?:ou|comment|puis-je|peut-on|est-il possible de|how|where|ajouter|importer|deposer|joindre|televerser|mettre)(?![\\p{L}])"
  + "|(?<![\\p{L}])(?:je veux|je voudrais|je souhaite|j'aimerais|je dois|comment)(?![\\p{L}])",
  'u',
);
const WHERE_FIND = word("ou (trouver|trouve-t-on|est|sont|se trouve|se trouvent|puis-je trouver)|where is|where are");
/** Un objet précis du compte (« ma facture ») se cherche, il ne se navigue pas. */
const SPECIFIC_OBJECT = word(`(ma|mon|la|le|l'|cette|ce|cet) ?(facture|garantie|contrat|manuel|notice|certificat|devis|justificatif|document|fichier|${assetVocabularyAlternatives()})`);

// ── Navigation (§9.4.5) ─────────────────────────────────────────────────────
const OPEN_VERB = word('ouvre|ouvrir|montre|montre-moi|affiche|affiche-moi|va sur|aller sur|acceder|accede|emmene-moi|open|go to|show me');

// ── Objets et données du compte (§9.4.6) ────────────────────────────────────
const DOC = word('documents?|factures?|garanties?|contrats?|manuels?|notices?|certificats?|devis|justificatifs?|fichiers?|pieces?');
const DOC_LIST = word('documents|factures|fichiers|pieces');
/** « …de ma Clio », « …du chalet » : les documents DE quelque chose. */
const OF_SOMETHING = word("(de|du|des) (ma|mon|mes|la|le|l'|notre|nos)|du [a-z]{3,}");
/** Biens : tout le vocabulaire du référentiel `asset-taxonomy` (lot 30 — plus de liste figée). */
const ASSET = word(assetVocabularyAlternatives());
const TO_PROCESS = word("a traiter|dois-je traiter|dois je traiter|je dois traiter|reste a traiter|faut-il traiter|en priorite|prioritaires?");
/**
 * Faits du compte (37.2) : date d'achat, date d'un document, montant. Lus
 * dans les données structurées, sans modèle (§14).
 */
const FACT = new RegExp(
  "(?<![\\p{L}])(?:quand (?:ai-je|j'ai|avons-nous|a-t-on|ai je) (?:achete|acquis|paye|installe|commande|recu|signe|mis en service|fait)"
  + "|(?:quelle est la |la )?date (?:d'|de |du |des )(?:achat|acquisition|mise en service|installation|signature|la facture|facture|livraison|fin|debut|document|contrat|souscription|l'achat)"
  + "|quelle est la date|date (?:indiquee|inscrite|figurant)"
  + "|(?:quel est le |le )?montant|combien (?:ai-je|j'ai) (?:paye|depense|achete)|combien (?:a )?coute|quel (?:est le )?prix)(?![\\p{L}])",
  'u',
);
const DEADLINE = word('echeances?|expire|expirent|expiration|a renouveler|renouvellement|quand|bientot');
const AGENDA = word('agenda|rendez-vous|planning|calendrier|rappels?');
const EXPORT = word('export|exporter|dossier|pdf|transmettre');
const SUPPLIER = word('fournisseurs?|prestataires?|artisans?|reparateurs?');

// ── Gabarits déterministes du §9.2 / §14.1 ─────────────────────────────────
/** Ce que comprend l'offre, fonction non incluse (§9.2 PRODUCT_PLAN_LIMIT). */
const PLAN_LIMIT = new RegExp(
  "(?<![\\p{L}])(?:que comprend|qu'inclut|que contient|qu'est-ce qui est inclus dans|qu'y a-t-il dans) (?:mon |mes |l'|votre |cette )?(?:offre|abonnement|forfait)"
  + "|(?:inclus|incluse|disponible|compris|comprise) (?:dans|avec) (?:mon offre|mon abonnement|l'offre|standard|premium)"
  + "|(?:fait|fait-elle|fait-il) partie de (?:mon offre|l'offre|premium)"
  + "|pourquoi (?:je ne peux pas|ne puis-je pas|est-ce bloque|c'est bloque|c'est reserve)[^?]*(?:offre|premium|abonnement)"
  + "|(?:passer|passage) (?:a|en|vers) premium|difference entre (?:standard|les offres|premium)|limites? de (?:mon offre|l'offre standard)(?![\\p{L}])",
  'u',
);
/** Informations manquantes du compte (§9.2 ACCOUNT_MISSING_INFORMATION). */
const MISSING_INFO = word("qu'est-ce qui manque|qu'est ce qui manque|que manque-t-il|il manque quoi|informations? manquantes?|donnees manquantes|champs? (?:a completer|manquants?)|que (?:dois-je|faut-il|reste-t-il a) completer|fiches? incompletes?");
/**
 * Action que l'assistant n'exécute pas (§9.2 UNSUPPORTED_ACTION) :
 * impératif en tête de message (« supprime… », « envoie… », « paie… »). Les
 * commandes d'écriture prises en charge sont préparées AVANT le routage.
 */
const UNSUPPORTED_START = startsWith('supprime|supprimer|efface|effacer|envoie|envoyer|paie|paye|payer|regle la|appelle|appeler|telephone a|achete|acheter|commander|resilie|resilier|signe|signer|imprime|imprimer|ecris a|mail a');
/** Problème technique (§9.2 TECHNICAL_ISSUE). */
const TECHNICAL = new RegExp(
  "(?<![\\p{L}])(?:(?:ca|cela|l'application|l'appli|le site|verebona|l'assistant|la page|l'ecran) (?:ne (?:marche|fonctionne|charge|repond)|plante|bug|beugue|rame)"
  + "|message d'erreur|page blanche|ecran blanc|erreur (?:500|technique|serveur)"
  + "|je n'arrive (?:pas|plus) a (?:me connecter|ouvrir l'application|charger|acceder a mon compte)|impossible de me connecter)(?![\\p{L}])",
  'u',
);
/** Hors périmètre (§9.2 OUT_OF_SCOPE) : sujets sans rapport avec Verebona. */
const OUT_OF_SCOPE = word("meteo|blague|horoscope|recette de cuisine|resultats? (?:du|de) (?:match|foot|football)|cours de la bourse|capitale de|qui a gagne|ecris(?:-moi)? un poeme|chante");

// ── Statut d'un document et exports disponibles (§12.1, §12.2) ─────────────
const DOC_STATUS = new RegExp(
  "(?<![\\p{L}])(?:(?:statut|etat) (?:de |du |d'|des )|ou en est|est-(?:il|elle) (?:bien )?analyse|a-t-(?:il|elle) ete analyse|deja ete analyse)",
  'u',
);
const EXPORT_LIST = new RegExp(
  "(?<![\\p{L}])(?:(?:quels?|quelles?|mes|liste|montre|affiche)(?: moi| les| mes| des)? (?:exports?|dossiers?)"
  + "|(?:exports?|dossiers?) (?:disponibles?|generes?|prets?|deja (?:faits?|generes?))"
  + "|(?:ai-je|j'ai) (?:deja )?(?:genere|fait|prepare) (?:des |un )?(?:exports?|dossiers?))(?![\\p{L}])",
  'u',
);

// ── Contexte de page (§9.4 étape 5) ────────────────────────────────────────
/** Question qui désigne l'objet affiché (« sa date », « ce document », « ici »). */
const DEICTIC = word("ce|cet|cette|ces|ici|sa|son|ses|celui-ci|celle-ci|dessus|dedans");
const PAGE_ASSET = /^\/assets\/[^/?#]+/;
const PAGE_DOCUMENT = /^\/documents\/[^/?#]+/;

/**
 * Action ambiguë (§20.1) : un verbe d'action seul, sans objet reconnaissable
 * (« ajoute », « ouvre-le » hors d'un fil, « exporte ça »).
 */
const AMBIGUOUS_ACTION = /^(ajoute|ajouter|cree|creer|ouvre|ouvrir|exporte|exporter|modifie|modifier)(?:-(?:le|la|les|moi))?(?: (?:ca|cela|le|la|les|un truc|quelque chose|un element))?[ .!?]*$/;

// ── Synthèse, comparaison, chronologie (candidats IA — §9.4.7) ─────────────
const COMPARE = word('compare|comparer|comparaison|difference|differences|different|differents|differente|differentes|divergent|divergentes?|contradictoires?|versus|par rapport|ne concordent pas');
const SUMMARY = word('resume|resumer|synthese|fais le point|bilan|panorama|explique|expliquer|analyse|analyser|pourquoi|tendance');
const TIMELINE = word('historique|chronologie|timeline|au fil du temps|evolution');

/** Seuil de pertinence d'un article pour router en aide sans modèle (§9.4.7). */
export const HELP_CORPUS_ROUTE_THRESHOLD = 0.4;

function buildRoute(
  intent: VerebonaIntent,
  confidence: Confidence,
  planType: string,
  reason: string,
  requiresRetrieval?: boolean,
  hints: IntentRoute['entityHints'] = [],
  clarificationRequired = false,
): IntentRoute {
  const def = getIntentDefinition(intent);
  return {
    intent,
    confidence,
    accountScope: 'server-enforced', // le vrai account_id est injecté serveur (§13.2)
    entityHints: hints,
    requiresRetrieval: requiresRetrieval ?? def.requiresRetrieval,
    // §25.6 : éligibilité lue dans le registre des capacités (offre, capacité
    // activée, flag du §39) — `capabilityForIntent` n'avait aucun appelant.
    aiEligible: isAiEligibleFor(intent, planType, def.geminiEligible),
    clarificationRequired,
    allowedActionTypes: allowedActionsFor(intent),
    routeReason: reason,
  };
}

/**
 * Indices d'entités (§9.5) : l'objet de la page, puis les familles d'objets
 * nommées dans la question et les noms cités entre guillemets. Ce sont des
 * INDICES : aucune entité n'est considérée comme résolue ni autorisée ici
 * (la résolution et le contrôle d'accès restent côté retrieval, §13.2).
 */
export function entityHintsFor(message: string, page?: PageContext): IntentRoute['entityHints'] {
  const t = normalizeForRouting(message);
  const hints: IntentRoute['entityHints'] = [];
  const ajoute = (type: IntentRoute['entityHints'][number]['type'], value: string) => {
    if (value && !hints.some((h) => h.type === type && h.value === value)) hints.push({ type, value });
  };
  if (page?.assetId) ajoute('asset', `page:${page.assetId}`);
  if (page?.documentId) ajoute('document', `page:${page.documentId}`);
  if (page?.supplierId) ajoute('supplier', `page:${page.supplierId}`);
  for (const m of message.matchAll(/[«"“]\s*([^»"”]{2,60}?)\s*[»"”]/g)) ajoute('document', m[1].trim());
  const d = t.match(DOC); if (d) ajoute('document', d[0]);
  const a = t.match(ASSET); if (a) ajoute('asset', a[0]);
  const g = t.match(AGENDA) ?? t.match(DEADLINE); if (g) ajoute('agenda', g[0]);
  const s = t.match(SUPPLIER); if (s) ajoute('supplier', s[0]);
  return hints.slice(0, 6);
}

/** Motif d'une clarification exigée par le routage (§20.1). */
export type RouteClarificationReason = 'PERIOD_UNIDENTIFIABLE' | 'ACTION_AMBIGUOUS';

/**
 * La demande exige-t-elle une clarification avant tout traitement (§20.1) ?
 *   · période non identifiable (« en mars » sans année, « l'autre jour »)
 *     pour une question sur les données du compte ;
 *   · action ambiguë (verbe d'action seul, sans objet).
 */
export function routeClarificationReason(
  message: string,
  intent: VerebonaIntent,
  today?: string,
): RouteClarificationReason | null {
  const t = normalizeForRouting(message);
  if (AMBIGUOUS_ACTION.test(t)) return 'ACTION_AMBIGUOUS';
  if (intent.startsWith('ACCOUNT_') && analyserPeriode(message, today ?? aujourdhuiParis())?.kind === 'ambiguous') return 'PERIOD_UNIDENTIFIABLE';
  return null;
}

/**
 * Route d'une intention déjà connue — reprise après clarification : la
 * demande initiale garde SON intention, sans être re-routée.
 */
export function routeForIntent(intent: VerebonaIntent, planType: string, reason: string): IntentRoute {
  return buildRoute(intent, 'exact', planType, reason);
}

/**
 * Routage déterministe. Retourne une route directe ou signale une classification IA.
 */
export function routeDeterministic(ctx: RouteContext): RouteOutcome {
  const t = normalizeForRouting(ctx.message);
  const hints = entityHintsFor(ctx.message, ctx.pageContext);
  const today = ctx.today;
  const R = (i: VerebonaIntent, c: Confidence, reason: string, rr?: boolean): RouteOutcome => ({
    kind: 'route',
    // §9.5 : indices d'entités et besoin de clarification renseignés sur
    // TOUTES les routes déterministes (ils valaient `[]` et `false`).
    route: buildRoute(i, c, ctx.planType, reason, rr, hints, routeClarificationReason(ctx.message, i, today) != null),
  });
  const route = ctx.pageRoute ?? ctx.pageContext?.route ?? '';
  const pageDocument = Boolean(ctx.pageContext?.documentId) || PAGE_DOCUMENT.test(route);
  const pageAsset = Boolean(ctx.pageContext?.assetId) || PAGE_ASSET.test(route);

  // Étape 1 — Sécurité / anti-injection / données d'autrui (§9.4.1, §29.2)
  if (UNSAFE_INJECTION.test(t)) return R('UNSAFE_OR_MALICIOUS', 'exact', 'motif malveillant détecté');
  if (isOtherAccountsRequest(t)) return R('UNSAFE_OR_MALICIOUS', 'exact', 'données d’autres comptes demandées');

  // Étape 2 — Réponse à une clarification en attente (§9.4.2)
  if (ctx.hasPendingClarification) return R('CLARIFICATION_ANSWER', 'exact', 'clarification en attente');

  // Étape 3 — Politesses (§9.4.3). Une salutation suivie d'une vraie
  // question (« Bonjour, retrouve ma facture ») n'est pas une politesse.
  if (GREETINGS.test(t)) {
    const reste = t.replace(GREETINGS, '').replace(/^[\s,!.;:-]*(verebona)?[\s,!.;:-]*/, '');
    if (reste.split(' ').filter(Boolean).length < 3) return R('GREETING', 'exact', 'salutation');
  }
  if (GOODBYE.test(t) && t.length < 60) return R('GOODBYE', 'exact', 'fin d’échange');
  if (THANKS.test(t) && t.length < 40) return R('THANKS', 'exact', 'remerciement');

  // Étape 4 — Demandes réservées (§9.4.4, §9.3 « Fais ma déclaration
  // fiscale », 37.19). Le thème seul ne suffit pas : « le montant de mon
  // impôt foncier » interroge les DONNÉES ; il faut une demande de conseil
  // ou d'exécution.
  if (SENSITIVE_TOPIC.test(t) && (ADVICE.test(t) || ACTION_START.test(t))) {
    return R('SENSITIVE_ADVICE', 'probable', 'conseil ou démarche réservés');
  }

  // Étape 4 bis — Gabarits déterministes (§9.2, §14.1) : hors périmètre,
  // offre, problème technique. Sans ces règles, seule la classification par
  // modèle produisait ces intentions (jamais en Standard).
  if (OUT_OF_SCOPE.test(t) && !DOC.test(t) && !ASSET.test(t)) return R('OUT_OF_SCOPE', 'probable', 'sujet hors Verebona');
  if (PLAN_LIMIT.test(t)) return R('PRODUCT_PLAN_LIMIT', 'probable', 'contenu ou limite de l’offre');
  if (TECHNICAL.test(t)) return R('TECHNICAL_ISSUE', 'probable', 'problème technique');

  // Étape 5 — Aide produit, AVANT navigation et recherche (§9.4, §8.3) :
  // « Comment ajouter un document ? » est une question d'usage, pas une
  // recherche de document.
  if (HELP_STATUS.test(t)) return R('PRODUCT_HELP_STATUS', 'probable', 'signification d’un statut');
  // « Quel est le statut de ce document ? » : le statut d'UN document du
  // compte, lu tel quel (§12.2) — pas la signification d'un statut.
  if (DOC_STATUS.test(t) && (DOC.test(t) || /analys/.test(t) || pageDocument)) {
    return R('ACCOUNT_FACT_DOCUMENT', 'probable', 'statut d’un document', true);
  }
  if (HELP_EXPLAIN.test(t)) return R('PRODUCT_HELP_EXPLAIN', 'probable', 'explication fonction');
  if (HELP_EXPLAIN_WEAK.test(t) && !POSSESSIVE.test(t)) return R('PRODUCT_HELP_EXPLAIN', 'probable', 'explication fonction');
  if (HOWTO.test(t)) return R('PRODUCT_HELP_HOW_TO', 'probable', 'how-to produit');
  if (HOWTO_GENERIC.test(t) && !DOC.test(t) && !OF_SOMETHING.test(t)) {
    return R('PRODUCT_HELP_HOW_TO', 'probable', 'how-to produit');
  }
  // Lot 33 : « je veux mettre une facture dans Verebona », « où déposer ma
  // facture ? », « comment joindre un fichier ? » — un besoin d'usage
  // reconnu par le référentiel des concepts (verbe ET objet), pas une
  // recherche dans les documents du compte.
  if (HELP_NEED.test(t)) {
    const concept = detectHelpConcept(ctx.message);
    if (concept?.certain) return R('PRODUCT_HELP_HOW_TO', 'probable', `how-to produit — concept ${concept.concept.id}`);
  }
  // « Où trouver mes documents ? » : une fonction de l'application.
  // « Où est la facture de mon vélo ? » : un objet du compte → plus bas.
  if (WHERE_FIND.test(t) && !SPECIFIC_OBJECT.test(t) && !OF_SOMETHING.test(t)) {
    return R('NAVIGATION_FIND', 'probable', 'où trouver une fonction');
  }

  // Étape 6 — Navigation explicite (§9.4.5)
  //
  // « Montre-moi les documents de ma maison » n'est pas une navigation : c'est
  // une question sur les données d'un bien (liste de ses documents), qui peut
  // appeler une clarification si plusieurs biens correspondent.
  if (OPEN_VERB.test(t) && DOC_LIST.test(t) && (ASSET.test(t) || OF_SOMETHING.test(t))) {
    return R('ACCOUNT_SEARCH_DOCUMENT', 'probable', 'documents d’un bien', true);
  }
  if (OPEN_VERB.test(t)) return R('NAVIGATION_OPEN', 'probable', 'verbe d’ouverture');
  if (UNSUPPORTED_START.test(t)) return R('UNSUPPORTED_ACTION', 'probable', 'action non exécutable par l’assistant');
  // Verbe d'action seul (« ajoute ») : clarification sur l'action (§20.1).
  if (AMBIGUOUS_ACTION.test(t)) return R('UNKNOWN', 'ambiguous', 'action ambiguë');

  // Étape 7 — Règles « données » déterministes (§9.4.6)
  if (MISSING_INFO.test(t)) return R('ACCOUNT_MISSING_INFORMATION', 'probable', 'informations manquantes', true);
  if (TO_PROCESS.test(t)) return R('ACCOUNT_TO_PROCESS', 'probable', 'éléments à traiter', true);
  // Exports et dossiers DÉJÀ générés (§12.1) : une donnée du compte, pas
  // une question d'usage.
  if (EXPORT_LIST.test(t)) return R('ACCOUNT_SEARCH_DOCUMENT', 'probable', 'exports et dossiers disponibles', true);
  if (EXPORT.test(t)) return R('EXPORT_HELP', 'probable', 'aide export');

  // Comparaison AVANT synthèse : « Pourquoi ces deux documents donnent-ils
  // des dates différentes ? » compare, il ne résume pas (§9.3).
  if (COMPARE.test(t)) return R('ACCOUNT_COMPARISON', 'probable', 'comparaison', true);

  // Faits du compte (date d'achat, date d'un document, montant — 37.2).
  // Sur la page d'un document, « quel est le montant ? » porte sur CE
  // document (§9.4 étape 5, contexte de page).
  if (FACT.test(t) && !SUMMARY.test(t) && !TIMELINE.test(t)) {
    return DOC.test(t) || (pageDocument && !ASSET.test(t))
      ? R('ACCOUNT_FACT_DOCUMENT', 'probable', DOC.test(t) ? 'donnée d’un document' : 'donnée du document de la page', true)
      : R('ACCOUNT_FACT_ASSET', 'probable', 'donnée d’un bien', true);
  }

  // Étape 8 — Synthèse / chronologie (candidats IA — §9.4.7)
  if (SUMMARY.test(t)) return R('ACCOUNT_SUMMARY', 'probable', 'synthèse', true);
  if (TIMELINE.test(t)) return R('ACCOUNT_TIMELINE', 'probable', 'chronologie', true);

  // Étape 9 — Recherche compte par type d'objet (§9.4.8)
  if (SUPPLIER.test(t)) return R('ACCOUNT_SEARCH_SUPPLIER', 'probable', 'recherche fournisseur', true);
  if (AGENDA.test(t) || DEADLINE.test(t)) return R('ACCOUNT_SEARCH_AGENDA', 'probable', 'recherche agenda', true);
  if (DOC.test(t)) return R('ACCOUNT_SEARCH_DOCUMENT', 'probable', 'recherche document', true);
  // En dernier des motifs par type : un message qui cite un document ET un bien
  // porte le plus souvent sur le document (« la facture de la maison »).
  if (ASSET.test(t)) return R('ACCOUNT_SEARCH_ASSET', 'probable', 'recherche bien', true);

  // Étape 9 bis — Contexte de page (§9.4 étape 5) : une question qui
  // désigne l'objet affiché (« et sa date ? », « qu'y a-t-il ici ? ») porte
  // sur lui, sans modèle.
  if (DEICTIC.test(t)) {
    if (pageDocument) return R('ACCOUNT_FACT_DOCUMENT', 'probable', 'contexte de page : document', true);
    if (pageAsset) return R('ACCOUNT_FACT_ASSET', 'probable', 'contexte de page : bien', true);
    if (/^\/agenda/.test(route)) return R('ACCOUNT_SEARCH_AGENDA', 'probable', 'contexte de page : agenda', true);
    if (/^\/fournisseurs/.test(route) || ctx.pageContext?.supplierId) return R('ACCOUNT_SEARCH_SUPPLIER', 'probable', 'contexte de page : fournisseurs', true);
    if (/^\/accueil\/a-traiter/.test(route)) return R('ACCOUNT_TO_PROCESS', 'probable', 'contexte de page : À traiter', true);
  }

  // Étape 10 — Base d'aide (§9.4.7) : un article nettement pertinent suffit
  // à router en aide produit, sans modèle.
  if (ctx.helpCorpus) {
    const [best] = searchHelpCorpus(ctx.helpCorpus, ctx.message, 1);
    if (best && best.score >= HELP_CORPUS_ROUTE_THRESHOLD) {
      return R('PRODUCT_HELP_HOW_TO', 'probable', `base d’aide — ${best.article.id}`);
    }
  }

  // Étape 11 — Intention inconnue : UNDERSTAND (§9.4.9 ; lot 32 — fallback
  // général de compréhension, pas un simple classifieur de dernier recours).
  return { kind: 'needs_classification', normalized: ctx.message.trim().replace(/\s+/g, ' ').slice(0, 2000) };
}
