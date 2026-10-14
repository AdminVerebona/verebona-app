/**
 * Périmètre SÉMANTIQUE d'une demande T2 — lot 49 (ticket « T2 : réduire le
 * routage déterministe et laisser l'IA gérer les ambiguïtés métier »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE CODE ENCADRE, EXPOSE LES SOURCES, VALIDE ET CALCULE ; T2 COMPREND
 *
 * Deux défauts de même nature :
 *   · « Quand finit le contrat de la Cupra ? » — « quand » suffisait à router
 *     vers l'agenda (aucun résultat + « Ouvrir l'agenda ») alors que
 *     « contrat » peut désigner une LLD, une assurance… ;
 *   · « Je paye combien pour internet à la maison ? » — « paye » + « combien »
 *     déclenchaient une stratégie de dépense, « internet » n'était compris par
 *     rien, et la réponse ÉLARGISSAIT silencieusement la demande (prix
 *     d'achat, somme des abonnements…).
 *
 * Ce module, PUR, formalise ce que le déterministe sait réellement :
 *
 *   DETERMINISTIC_STRONG  intention, cible, périmètre métier et opération
 *                         structurée connus → exécution directe ;
 *   DETERMINISTIC_WEAK    la décision ne repose que sur des signaux faibles
 *                         (« quand », « combien », « paye »…) ou un sujet
 *                         métier significatif reste NON CONSOMMÉ (le
 *                         « résidu sémantique ») → jamais d'élargissement :
 *                         UNDERSTAND, sources réelles, choix / clarification.
 *
 * Le résidu ne repose sur AUCUN dictionnaire métier (pas de « internet →
 * Orange ») : c'est ce qui reste de la question une fois retirés les mots
 * outils, les signaux de besoin (date, montant), les biens du compte et ce
 * que la stratégie candidate CONSOMME réellement (thème explicite, champ du
 * registre…). La correspondance entre le besoin et les sources se fait
 * ensuite sur le TEXTE DES DONNÉES RÉELLES (libellés des opérations,
 * prestataires, titres des documents, libellés du registre), enrichi des
 * sujets que T2 (UNDERSTAND) a compris.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { withoutAssetDesignations, isAssetVocabularyWord } from '@/lib/asset-taxonomy';
import { findReadableFields } from '../canonical/field-vocabulary';

export type DeterministicConfidence = 'STRONG' | 'WEAK';

/** Besoin de VALEUR exprimé par la question (signal, jamais un périmètre). */
export type ValueNeed = 'end_date' | 'date' | 'amount';

const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’]/g, "'");

/** Mots d'une question (sans accents, minuscules). */
export function tokensOf(text: string): string[] {
  return plain(text ?? '').replace(/'/g, ' ').split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * Signaux FAIBLES : ils disent qu'une date ou un montant est cherché, jamais
 * QUELLE donnée métier le porte (ticket §3). Seuls, ils n'imposent ni une
 * intention ni une stratégie.
 */
const END_DATE = /\b(fin|finit|finissent|finira|termine\w*|expire\w*|expiration|echeance|echu\w*|jusqu'?a quand|arrive a (son )?terme)\b/;
const DATE = /\b(quand|date|dates|depuis quand|a quelle date)\b/;
const AMOUNT = /\b(combien|montant|montants|prix|tarif|tarifs|cout|couts|coute|coutent|coutait|paye|payes|payee|payees|payer|payons|payez|depense\w*|regle|reglee|verse|facture combien|mensualite\w*|cotisation\w*)\b/;

/** Besoin de valeur (pure, testée) : fin, date, montant ; `null` : aucun. */
export function detectValueNeed(message: string): ValueNeed | null {
  const m = plain(message);
  if (AMOUNT.test(m) && !/\b(combien de|nombre de)\b/.test(m)) return 'amount';
  if (END_DATE.test(m)) return 'end_date';
  if (DATE.test(m)) return 'date';
  return null;
}

/**
 * Mots qui ne désignent jamais un SUJET métier : mots outils, formes
 * interrogatives, signaux de besoin (date, montant), verbes d'usage, période.
 * Liste volontairement fermée et générique — aucun vocabulaire de domaine.
 */
const NON_SUJETS = new Set([
  // Mots outils, pronoms, possessifs.
  'a', 'ai', 'as', 'ait', 'au', 'aux', 'avec', 'avoir', 'c', 'ca', 'ce', 'cela', 'ces', 'cet', 'cette', 'ci', 'comme', 'd', 'dans', 'de',
  'des', 'du', 'elle', 'elles', 'en', 'est', 'et', 'eu', 'il', 'ils', 'j', 'je', 'l', 'la', 'le', 'les', 'leur', 'leurs', 'lui', 'm', 'ma',
  'me', 'mes', 'moi', 'mon', 'n', 'ne', 'ni', 'nos', 'notre', 'nous', 'on', 'ont', 'ou', 'par', 'pas', 'pour', 'qu', 'que', 'qui', 'quoi',
  's', 'sa', 'se', 'ses', 'son', 'sont', 'sur', 't', 'ta', 'tes', 'toi', 'ton', 'tu', 'un', 'une', 'vos', 'votre', 'vous', 'y', 'chez',
  'sous', 'vers', 'entre', 'sans', 'plus', 'moins', 'tres', 'bien', 'aussi', 'encore', 'deja', 'tout', 'tous', 'toute', 'toutes',
  'quel', 'quelle', 'quels', 'quelles', 'lequel', 'laquelle', 'lesquels', 'comment', 'pourquoi', 'quand', 'combien', 'est-ce', 'ici',
  // Verbes d'usage et auxiliaires (formes courantes d'une question).
  'suis', 'es', 'sommes', 'etes', 'etait', 'etaient', 'sera', 'seront', 'ete', 'avons', 'avez', 'avais', 'avait', 'aurai', 'aura',
  'fait', 'faire', 'fais', 'faut', 'dois', 'doit', 'devons', 'devez', 'doivent', 'dois-je', 'peux', 'peut', 'pouvez', 'puis', 'puis-je',
  'veux', 'voudrais', 'sais', 'savoir', 'dis', 'dire', 'dit', 'donne', 'donner', 'montre', 'montrer', 'affiche', 'afficher', 'voir',
  'connaitre', 'rappelle', 'rappeler', 'indique', 'indiquer', 'trouve', 'trouver', 'retrouve', 'retrouver', 'cherche', 'chercher',
  'svp', 'stp', 'merci', 'bonjour', 'actuellement', 'actuel', 'actuelle', 'reste', 'restent', 'arrive', 'arrivent',
  // Lot 53 (PO D22) : « vaut », « lieu », « passe », « concerne »… ne sont
  // PLUS exclus d'office — leur rôle est lu dans le CONTEXTE (`roleGrammatical`).
  // Signaux de besoin : date / montant (§3 — des indices, pas des sujets).
  'date', 'dates', 'fin', 'finit', 'finissent', 'finira', 'termine', 'terminee', 'terminent', 'terminera', 'expire', 'expirent', 'expirera',
  'expiration', 'echeance', 'echeances', 'echu', 'echue', 'jusqu', 'terme', 'bientot', 'prochain', 'prochaine', 'prochains', 'prochaines',
  'dernier', 'derniere', 'derniers', 'dernieres', 'montant', 'montants', 'prix', 'tarif', 'tarifs', 'cout', 'couts', 'coute', 'coutent',
  'coutait', 'coutes', 'coutee', 'paye', 'payes', 'payee', 'payees', 'payer', 'payons', 'payez', 'paie', 'paies', 'regle', 'reglee',
  'regles', 'reglees', 'verse', 'versee', 'depense', 'depenses', 'depensee', 'depensees', 'depenser', 'total', 'somme', 'euros', 'euro',
  'mensualite', 'mensualites', 'mois', 'mensuel', 'mensuelle', 'annuel', 'annuelle', 'an', 'ans', 'annee', 'annees', 'jour',
  'jours', 'semaine', 'semaines', 'aujourd', 'hui', 'hier', 'demain', 'maintenant', 'depuis', 'avant', 'apres', 'pendant', 'court', 'courir',
]);

/** Mois et années : une période, jamais un sujet. */
const PERIODE = /^(janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre|\d{1,4})$/;

/**
 * ANALYSE CONTEXTUELLE (lot 53, retour PO D22) — remplace l'exclusion
 * systématique de « vaut », « lieu », « passe », « concerne »… (lot 49).
 *
 * Ces mots sont des HOMOGRAPHES : verbe ou locution dans « quand a lieu… »,
 * « ce qui se passe », « l'an passé », « pour ce qui concerne… », « combien
 * vaut… » ; NOM (donc sujet métier) dans « le lieu de stockage », « le passe
 * Navigo ». Leur rôle se lit dans la phrase : un nom est introduit par un
 * DÉTERMINANT (« le », « mon », « quel »…), un verbe ou une locution ne l'est
 * jamais. Un nom est donc conservé dans le résidu (→ compréhension, sources,
 * clarification si plusieurs lectures) ; un verbe ou une locution, non.
 * Aucun mot n'est plus exempté par principe : un homographe employé comme nom
 * déclenche la même analyse que n'importe quel autre sujet.
 */
const HOMOGRAPHES = /^(lieu|lieux|passe|passee|passes|passees|concerne|concernee|concernes|concernees|concernent|concernant|concernait|vaut|valent|valait|valaient|vaudra)$/;
const DETERMINANTS = new Set([
  'le', 'la', 'les', 'l', 'un', 'une', 'du', 'des', 'au', 'aux', 'ce', 'cet', 'cette', 'ces', 'mon', 'ma', 'mes', 'ton', 'ta', 'tes',
  'son', 'sa', 'ses', 'notre', 'nos', 'votre', 'vos', 'leur', 'leurs', 'quel', 'quelle', 'quels', 'quelles', 'chaque',
]);

/**
 * Rôle d'un homographe dans la question (pure, testée) : `nom` s'il est
 * introduit par un déterminant (hors locution « au lieu de »), `grammatical`
 * sinon (verbe, participe, locution : « a lieu », « se passe », « an passé »).
 */
export function roleGrammatical(tokens: readonly string[], i: number): 'nom' | 'grammatical' {
  const w = tokens[i];
  const avant = tokens[i - 1];
  if (!avant || !DETERMINANTS.has(avant)) return 'grammatical';
  if (/^lieux?$/.test(w) && avant === 'au' && /^(de|d|du|des)$/.test(tokens[i + 1] ?? '')) return 'grammatical';
  return 'nom';
}

/**
 * RÉSIDU SÉMANTIQUE (pure, testée) : termes significatifs de la question
 * qu'aucune lecture ne consomme. `assetNames` : noms des biens du compte (ou
 * de la cible) — ils désignent la cible, pas un sujet ; `consumed` : mots que
 * la stratégie candidate traite RÉELLEMENT (thème explicite, libellé…).
 *
 * Les formulations du registre canonique (« date d'achat », « kilométrage »,
 * « échéance de l'assurance »…) sont comprises par la lecture canonique : elles
 * ne laissent pas de résidu.
 */
export function semanticResidue(
  message: string,
  opts: { assetNames?: readonly string[]; consumed?: readonly string[] } = {},
): string[] {
  let m = plain(message ?? '');
  for (const x of findReadableFields(message ?? '').sort((a, b) => b.index - a.index)) {
    m = `${m.slice(0, x.index)} ${m.slice(x.index + x.phrase.length)}`;
  }
  m = plain(withoutAssetDesignations(m));
  const noms = new Set((opts.assetNames ?? []).flatMap((n) => tokensOf(n)));
  const consommes = new Set((opts.consumed ?? []).flatMap((c) => tokensOf(c)));
  const out = new Set<string>();
  const mots = tokensOf(m);
  for (const [i, w] of mots.entries()) {
    if (w.length < 3 || NON_SUJETS.has(w) || PERIODE.test(w)) continue;
    // Lot 53 (D22) : homographe verbe / nom — le CONTEXTE décide.
    if (HOMOGRAPHES.test(w) && roleGrammatical(mots, i) === 'grammatical') continue;
    if (/-(je|tu|il|elle|on|nous|vous|ils|elles|t|ce)$/.test(w)) continue;
    if (noms.has(w) || consommes.has(w) || consumedByStem(w, consommes) || isAssetVocabularyWord(w)) continue;
    out.add(w);
  }
  return [...out].slice(0, 8);
}

/** « abonnement » consommé par « abonnements » (pluriel / singulier). */
function consumedByStem(w: string, consommes: ReadonlySet<string>): boolean {
  for (const c of consommes) if (c.length >= 4 && (w.startsWith(c) || c.startsWith(w)) && Math.abs(w.length - c.length) <= 2) return true;
  return false;
}

// ── Sources métier exposées par le serveur (abstraction, ticket §2) ───────

/**
 * Domaines de sources métier. T2 raisonne sur ces sources sans connaître
 * leur stockage ; une source future (fournisseurs, « À traiter »…) s'ajoute
 * par un nouveau fournisseur, sans règle lexicale.
 */
export type BusinessSourceDomain = 'operation' | 'field' | 'agenda' | 'document';

/**
 * Candidat métier RÉEL (lu en base, borné au compte et aux biens disponibles)
 * — jamais fourni par le modèle. `ref` est validé par le serveur à chaque
 * usage (clarification, reprise).
 */
export interface BusinessSource {
  /** Référence stable : `operation:<id>`, `field:<bienId>:<clé>`, `agenda:<id>`, `document:<id>`. */
  ref: string;
  domain: BusinessSourceDomain;
  /** Libellé présenté (« Contrat « LLD » », « Échéance de l'assurance »). */
  label: string;
  /** Détail présenté (prestataire, période, valeur…). */
  detail: string | null;
  /** Texte de correspondance : libellés, prestataire, documents, type. */
  text: string;
  /** Nom du type métier (P09 : « contrat », « intervention »…), opérations seulement. */
  kindNoun?: string | null;
  /** Clé canonique (domaine `field`). */
  fieldKey?: string | null;
  assetId: number | null;
  /** Montant (centimes EUR) porté par la source, s'il y en a un. */
  amountCents?: number | null;
  /** Date de fin (contrat, échéance) ou date significative. */
  endDate?: string | null;
  date?: string | null;
  /** Documents représentés par la source (une opération) — jamais recomptés. */
  representedFileIds?: number[];
  /** Source ouvrable (document, sinistre, champ, échéance) citée par la réponse. */
  source?: import('../types/sources').RetrievedSource;
  /** Valeurs utiles à la rédaction serveur (total, dernière date, affichage). */
  meta?: Record<string, unknown>;
}

/** Besoin sémantique compris : termes, faits du registre, besoin de valeur. */
export interface SemanticNeed {
  /** Résidu déterministe + sujets UNDERSTAND + fournisseur filtré. */
  terms: string[];
  /** Clés du FIELD_CATALOG demandées par UNDERSTAND. */
  facts: string[];
  need: ValueNeed | null;
}

/** Termes de correspondance (pure) : sujets UNDERSTAND découpés, sans mots non significatifs. */
export function semanticTerms(residue: readonly string[], topics: readonly string[] = [], supplier?: string | null): string[] {
  const out = new Set<string>();
  for (const t of [...residue, ...topics, ...(supplier ? [supplier] : [])]) {
    for (const w of tokensOf(t)) if (w.length >= 3 && !NON_SUJETS.has(w) && !PERIODE.test(w)) out.add(w);
  }
  return [...out].slice(0, 12);
}

/** Le mot `w` de la source répond-il au terme `t` (préfixe commun, sans lexique) ? */
function correspond(t: string, w: string): boolean {
  if (t === w) return true;
  if (t.length < 4 || w.length < 4) return false;
  return w.startsWith(t) || (t.startsWith(w) && t.length - w.length <= 3);
}

/** Le texte (données réelles) répond-il à au moins un des termes (pure) ? */
export function textMatchesTerms(text: string, terms: readonly string[]): boolean {
  const mots = tokensOf(text);
  return terms.some((t) => mots.some((w) => correspond(t, w)));
}

/** Score d'une source : nombre de termes distincts retrouvés dans SON texte (pure). */
export function sourceScore(s: BusinessSource, terms: readonly string[]): number {
  const mots = new Set(tokensOf(`${s.text} ${s.kindNoun ?? ''}`));
  let n = 0;
  for (const t of terms) if ([...mots].some((w) => correspond(t, w))) n += 1;
  return n;
}

/** La source porte-t-elle la valeur demandée ? */
function porteLaValeur(s: BusinessSource, need: ValueNeed | null): boolean {
  if (!need) return true;
  if (s.domain === 'operation') return true; // l'interprétation reste plausible ; la valeur absente est dite
  if (need === 'amount') return s.amountCents != null;
  return Boolean(s.endDate ?? s.date);
}

/** Priorité des domaines (ticket §9) : l'opération d'abord quand elle existe. */
export const DOMAIN_PRIORITY: readonly BusinessSourceDomain[] = ['operation', 'field', 'agenda', 'document'];

export interface SemanticSelection {
  /** Interprétations retenues (même meilleur score, domaine prioritaire). */
  selected: BusinessSource[];
  /** Domaine retenu, ou `null` : aucune source pertinente. */
  domain: BusinessSourceDomain | null;
  /** Candidats examinés, avec leur score (trace). */
  scored: Array<{ ref: string; domain: BusinessSourceDomain; score: number }>;
}

/**
 * Sélection des interprétations plausibles parmi les sources RÉELLES (pure,
 * testée) — aucune règle lexicale :
 *   · un champ du registre demandé par UNDERSTAND et RENSEIGNÉ est plausible ;
 *   · une autre source l'est si son texte répond à au moins un terme du
 *     besoin, au meilleur score ;
 *   · domaine prioritaire : opérations, puis champs, agenda, documents — une
 *     opération et ses propres documents ne font jamais deux interprétations.
 * Une seule interprétation → réponse directe ; plusieurs → clarification ;
 * aucune → information insuffisante (jamais un total plus large).
 */
export function selectInterpretations(
  sources: readonly BusinessSource[], need: SemanticNeed, opts: { period?: { from: string; to: string } | null } = {},
): SemanticSelection {
  const representes = new Set(sources.filter((s) => s.domain === 'operation').flatMap((s) => s.representedFileIds ?? []));
  // Lot 53 (PO D21) : période demandée — une pièce ou une échéance DATÉE hors
  // de la période n'y répond pas (une opération reste plausible : sa réponse
  // ne retient que les montants de la période, ou dit qu'il n'y en a pas).
  const horsPeriode = (s: BusinessSource) => Boolean(opts.period) && (s.domain === 'document' || s.domain === 'agenda')
    && Boolean(s.date) && (String(s.date).slice(0, 10) < opts.period!.from || String(s.date).slice(0, 10) > opts.period!.to);
  const utiles = sources.filter((s) => !(s.domain === 'document' && representes.has(Number(s.ref.split(':')[1]))) && !horsPeriode(s));
  const scored = utiles.map((s) => {
    const parFait = s.domain === 'field' && s.fieldKey != null && need.facts.includes(s.fieldKey) ? 1 : 0;
    return { s, score: porteLaValeur(s, need.need) ? sourceScore(s, need.terms) + parFait : 0 };
  });
  for (const domain of DOMAIN_PRIORITY) {
    const dans = scored.filter((x) => x.s.domain === domain && x.score > 0);
    if (!dans.length) continue;
    const best = Math.max(...dans.map((x) => x.score));
    return {
      selected: dans.filter((x) => x.score === best).map((x) => x.s),
      domain,
      scored: scored.map((x) => ({ ref: x.s.ref, domain: x.s.domain, score: x.score })),
    };
  }
  return { selected: [], domain: null, scored: scored.map((x) => ({ ref: x.s.ref, domain: x.s.domain, score: x.score })) };
}

/** Genre des noms métier (P09) pour la question de clarification. */
const FEMININ = new Set(['intervention', 'vente', 'dépense', 'information', 'échéance']);

/**
 * Question de clarification métier (pure, testée), issue des candidats :
 * « De quel contrat parlez-vous ? » quand tous sont du même type métier.
 */
export function semanticQuestion(cands: readonly BusinessSource[]): string {
  const noms = [...new Set(cands.map((c) => (c.domain === 'operation' ? c.kindNoun ?? null : c.domain === 'field' ? 'information' : c.domain === 'agenda' ? 'échéance' : 'document')))];
  if (noms.length === 1 && noms[0]) return `De quel${FEMININ.has(noms[0]) ? 'le' : ''} ${noms[0]} parlez-vous ?`;
  return 'Plusieurs éléments correspondent à votre question. Lequel voulez-vous consulter ?';
}

/**
 * Lot 53 (PO Q24) — question de clarification CONTEXTUELLE quand aucune
 * source ne correspond aux termes de la demande mais que le bien porte
 * plusieurs contrats / services susceptibles d'y répondre (libellés des
 * données différents des mots de l'utilisateur) : « De quel contrat ou
 * service parlez-vous ? » plutôt que le message générique d'absence.
 * Pure, testée ; texte soumis à la relecture du PO (Q24).
 */
export function contextualQuestion(terms: readonly string[], cands: readonly BusinessSource[], assetName: string | null): string {
  const sujet = terms.length ? `« ${terms.slice(0, 3).join(' ')} »` : 'votre demande';
  const pour = assetName ? ` pour ${assetName}` : '';
  const noms = [...new Set(cands.map((c) => c.kindNoun ?? null))];
  const question = noms.length === 1 && noms[0] === 'contrat' ? 'De quel contrat ou service parlez-vous ?' : semanticQuestion(cands);
  return `Je n’ai trouvé aucun élément mentionnant ${sujet}${pour}. ${question}`;
}

/** Trace d'observabilité du périmètre sémantique (ticket §13). */
export interface SemanticTrace {
  deterministicMatch: string | null;
  deterministicConfidence: DeterministicConfidence;
  classificationEscalated: boolean;
  understandCalled: boolean;
  intent: string | null;
  understandConfidence: string | null;
  resolvedTargets: number[];
  requestedFacts: string[];
  requestedTopics: string[];
  semanticScopeResolved: boolean;
  semanticAmbiguity: boolean;
  /** Termes non résolus (résidu) — « internet ». */
  semanticResidue: string[];
  semanticCandidates: Array<{ ref: string; domain: string; score: number }>;
  sourceDomainsAvailable: string[];
  operationCandidates: number[];
  selectedOperationId: number | null;
  selectedSource: string | null;
  structuredStrategyCandidate: string | null;
  structuredStrategyExecuted: boolean;
  structuredScopeFallbackPrevented: boolean;
  clarificationCreated: boolean;
  clarificationReason: string | null;
  fallbackReason: string | null;
  /** Ce qui a déclenché l'étape (`none` : décision déterministe exécutée telle quelle). */
  trigger: 'none' | 'weak_route' | 'structured_scope' | 'resume_choice' | 'resume_scope' | 'classified_scope';
}

export function emptySemanticTrace(p: Pick<SemanticTrace, 'trigger' | 'deterministicMatch' | 'deterministicConfidence'>): SemanticTrace {
  return {
    ...p, classificationEscalated: false, understandCalled: false, intent: null, understandConfidence: null, resolvedTargets: [],
    requestedFacts: [], requestedTopics: [], semanticScopeResolved: false, semanticAmbiguity: false, semanticResidue: [],
    semanticCandidates: [], sourceDomainsAvailable: [], operationCandidates: [], selectedOperationId: null, selectedSource: null,
    structuredStrategyCandidate: null, structuredStrategyExecuted: false, structuredScopeFallbackPrevented: false,
    clarificationCreated: false, clarificationReason: null, fallbackReason: null,
  };
}
