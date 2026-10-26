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
import { getField, getEventEntry } from '@/services/canonical/registry';
import { plain } from './routing-text';

type DeterministicConfidence = 'STRONG' | 'WEAK';

/** Besoin de VALEUR exprimé par la question (signal, jamais un périmètre). */
export type ValueNeed = 'end_date' | 'date' | 'amount';

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

/**
 * Lot 75J (#419 R01) — la question demande-t-elle un TOTAL (cumul sur
 * plusieurs montants ou plusieurs périodes) plutôt qu'un montant unitaire
 * (pure) ? Signal générique de besoin, jamais un sujet métier : une demande
 * de total n'est jamais servie par la seule dernière pièce.
 */
const TOTAL = /\b(au total|en tout|total|totaux|cumul\w*|somme|depuis le debut|depuis l'achat|depuis le depart)\b/;
export function wantsAggregate(message: string): boolean {
  return TOTAL.test(plain(message ?? ''));
}

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

// ══════════════════════════════════════════════════════════════════════════
// LOT 75J (#419 R02) — SIGNIFICATION MÉTIER D'UNE DATE
//
// Une date n'est une FIN que si la donnée le dit. Signification lue sur les
// métadonnées EXISTANTES (registre canonique `agendaEffect`, catalogue des
// événements), jamais sur un titre :
//   · `contract_end` — échéance TERMINALE : le type d'événement n'a pour seule
//     nature que DEADLINE et n'est pas récurrent (fin de contrat, de bail,
//     de garantie, de validité) ;
//   · `next_due`     — prochaine échéance d'une activité récurrente ou
//     répétée (entretien, contrôle, échéance annuelle d'assurance) ;
//   · `event_date`   — fait daté (historique) ;
//   · `unknown`      — rien ne qualifie la date (événement libre, prévision
//     sans type métier) : jamais une fin.
// Côté documents : `document_date` ; côté opérations : date d'effet / de
// réalisation, et fin explicite (`effectiveTo`, `endDate`) seulement.
// ══════════════════════════════════════════════════════════════════════════
export type DateMeaning = 'contract_end' | 'next_due' | 'event_date' | 'document_date' | 'effective_date' | 'unknown';

/**
 * Signification d'une date d'événement (pure, testée) — registre et catalogue, jamais le titre.
 * Lot 86C : une échéance TERMINALE (« fin ») n'est une fin certaine que si sa
 * PROVENANCE la justifie (champ métier qualifié, fin de contrat établie
 * projetée, saisie de l'utilisateur) ; un élément automatique sans provenance
 * contractuelle (`provenance: 'UNPROVEN'`) n'est jamais présenté comme une fin.
 */
export function eventDateMeaning(e: { nature?: string | null; businessType?: string | null; originFieldKey?: string | null; provenance?: string | null }): DateMeaning {
  const sens = eventDateMeaningRaw(e);
  return sens === 'contract_end' && e.provenance === 'UNPROVEN' ? 'unknown' : sens;
}

function eventDateMeaningRaw(e: { nature?: string | null; businessType?: string | null; originFieldKey?: string | null }): DateMeaning {
  const effet = e.originFieldKey ? getField(e.originFieldKey)?.agendaEffect : undefined;
  const nature = e.nature ?? effet?.nature ?? null;
  const type = e.businessType ?? effet?.businessType ?? null;
  if (nature === 'HISTORICAL') return 'event_date';
  const entree = type ? getEventEntry(type) : undefined;
  if (nature !== 'DEADLINE' && !(entree && entree.natures.length === 1 && entree.natures[0] === 'DEADLINE')) return 'unknown';
  if (!entree) return 'next_due';
  const terminale = entree.natures.length === 1 && entree.natures[0] === 'DEADLINE' && !effet?.recurrence;
  return terminale ? 'contract_end' : 'next_due';
}

// ── Sources métier exposées par le serveur (abstraction, ticket §2) ───────

/**
 * Domaines de sources métier. T2 raisonne sur ces sources sans connaître
 * leur stockage. Lot 54E (#419 écart 8) : liste OUVERTE — une source future
 * (« À traiter », fournisseurs…) s'ajoute par un fournisseur et un
 * descripteur (`registerSourceDomain`), sans modifier la sélection ni
 * l'orchestrateur.
 */
export type BusinessSourceDomain = 'operation' | 'field' | 'agenda' | 'document' | (string & {});

/**
 * Descripteur d'un domaine (#419 écart 2) : AUTORITÉ / provenance (une
 * opération consolidée, un champ canonique > une pièce brute) et niveau de
 * STRUCTURATION. Ils ordonnent les candidats et départagent des sources
 * COMPLÉMENTAIRES d'une même réalité ; ils ne font JAMAIS gagner une source
 * qui ne porte pas la valeur demandée face à une source qui la porte.
 */
export interface SourceDomainDescriptor {
  domain: BusinessSourceDomain;
  /** 0–3 : 3 = état métier consolidé (opération, champ canonique). */
  authority: number;
  /** Donnée structurée (valeur typée) plutôt que pièce à interpréter. */
  structured: boolean;
  /** Nom métier par défaut (clarification) quand la source n'en porte pas. */
  noun: string;
}

const DOMAINES = new Map<string, SourceDomainDescriptor>([
  ['operation', { domain: 'operation', authority: 3, structured: true, noun: 'élément' }],
  ['field', { domain: 'field', authority: 3, structured: true, noun: 'information' }],
  ['agenda', { domain: 'agenda', authority: 2, structured: true, noun: 'échéance' }],
  ['document', { domain: 'document', authority: 1, structured: false, noun: 'document' }],
  // Lot 75J (#419 R07) : information de CONTEXTE apportée dans le message (temporaire, jamais enregistrée).
  ['context', { domain: 'context', authority: 3, structured: true, noun: 'information' }],
]);

/** Déclare (ou remplace) un domaine de sources — extensibilité (#419 écart 8). */
export function registerSourceDomain(d: SourceDomainDescriptor): void {
  DOMAINES.set(d.domain, d);
}

/** Descripteur d'un domaine (inconnu : autorité minimale, non structuré). */
export function sourceDomain(domain: BusinessSourceDomain): SourceDomainDescriptor {
  return DOMAINES.get(domain) ?? { domain, authority: 0, structured: false, noun: 'élément' };
}

/**
 * Candidat métier RÉEL (lu en base, borné au compte et aux biens disponibles)
 * — jamais fourni par le modèle. `ref` est validé par le serveur à chaque
 * usage (clarification, reprise, arbitrage).
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
  /** Prestataire / fournisseur STRUCTURÉ (opération, document) — preuve de même réalité. */
  provider?: string | null;
  /** Montant (centimes EUR) porté par la source, s'il y en a un. */
  amountCents?: number | null;
  /**
   * Lot 75J (#419 R01) — NATURE du montant porté : coût réalisé consolidé
   * (`realized`), montant facturé / documenté (`documented`), tarif ou devis
   * PRÉVISIONNEL (`forecast`), preuve de RÈGLEMENT (`payment`). Absent :
   * documenté. Un règlement ou une prévision ne se substitue jamais
   * automatiquement à une facture.
   */
  amountNature?: AmountNature | null;
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

/** Nature d'un montant (lot 75J, #419 R01). */
type AmountNature = 'realized' | 'documented' | 'forecast' | 'payment';

/** Nature du montant d'une source (pure) : celle déclarée, sinon documenté. */
export function amountNatureOf(s: Pick<BusinessSource, 'amountNature' | 'meta'>): AmountNature {
  const m = (s.meta ?? {}) as { amountNature?: unknown };
  const n = s.amountNature ?? (typeof m.amountNature === 'string' ? m.amountNature : null);
  return n === 'realized' || n === 'forecast' || n === 'payment' ? n : 'documented';
}

/** Montant PRINCIPAL (coût réalisé ou facturé) — jamais un règlement ni une prévision (pure). */
function isPrimaryAmount(s: Pick<BusinessSource, 'amountNature' | 'meta'>): boolean {
  const n = amountNatureOf(s);
  return n === 'realized' || n === 'documented';
}

/** Besoin sémantique compris : termes, faits du registre, besoin de valeur. */
export interface SemanticNeed {
  /** Résidu déterministe + sujets UNDERSTAND + fournisseur filtré. */
  terms: string[];
  /** Clés du FIELD_CATALOG demandées par UNDERSTAND. */
  facts: string[];
  need: ValueNeed | null;
  /** Lot 75J (#419 R01) : un TOTAL est demandé (jamais la seule dernière pièce). */
  aggregate?: boolean;
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

/**
 * Nombre de termes distincts retrouvés dans le texte RÉEL d'une source
 * (pure). Lot 54E (#419 écart 1) : sert UNIQUEMENT à dire si une source est
 * PLAUSIBLE (> 0) — jamais à choisir entre plusieurs sources plausibles
 * (aucun « meilleur score » : ce choix revient à T2 ou à l'utilisateur).
 */
export function sourceScore(s: BusinessSource, terms: readonly string[]): number {
  const mots = new Set(tokensOf(`${s.text} ${s.kindNoun ?? ''}`));
  let n = 0;
  for (const t of terms) if ([...mots].some((w) => correspond(t, w))) n += 1;
  return n;
}

/**
 * CAPACITÉ réelle d'une source à répondre au besoin (#419 écart 2) : elle
 * PORTE la valeur demandée (montant, date de fin, date). Une opération
 * pertinente SANS la valeur n'est plus réputée capable.
 */
export function carriesRequestedValue(s: BusinessSource, need: ValueNeed | null): boolean {
  if (!need) return true;
  if (need === 'amount') return s.amountCents != null;
  // Lot 59 (#419 R02) : une date de FIN n'est portée que par une donnée dont
  // la SIGNIFICATION est une fin (fin contractuelle, échéance) — jamais par
  // la date d'un document (`document_date`) ni par une date d'effet.
  if (need === 'end_date') return Boolean(s.endDate);
  return Boolean(s.endDate ?? s.date);
}

/**
 * L'opération porte-t-elle RÉELLEMENT la valeur demandée (pure) — lot 59
 * (#419 R01) : pour un montant, un montant RÉALISÉ consolidé (un tarif
 * annoncé est prévisionnel : il ne représente pas une facture réelle).
 * Sans détail (`meta.realizedCount`), la capacité générale s'applique.
 */
export function operationCarriesValue(op: BusinessSource, need: ValueNeed | null): boolean {
  if (!need) return true;
  if (need === 'amount') {
    // Lot 75J (#419 R01) : capacité évaluée sur les montants réalisés EXPLOITABLES
    // (montant EUR établi), jamais sur le seul nombre de composantes : une
    // composante réalisée sans montant EUR (devise non convertie, montant absent)
    // ne fait pas de l'Opération une source qui porte le montant.
    const m = (op.meta ?? {}) as { realized?: unknown; realizedCount?: unknown };
    if (Array.isArray(m.realized)) return m.realized.some((r) => typeof (r as { cents?: unknown })?.cents === 'number');
    return typeof m.realizedCount === 'number' ? m.realizedCount > 0 : op.amountCents != null;
  }
  return carriesRequestedValue(op, need);
}

/** Identifiant de fichier d'une source documentaire (`document:<id>`), sinon `null`. */
function fileIdOf(s: BusinessSource): number | null {
  if (s.domain !== 'document') return null;
  const id = Number(s.ref.split(':')[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

const norm = (t: string | null | undefined) => tokensOf(t ?? '').join(' ');

/**
 * Sources COMPLÉMENTAIRES d'une même réalité (pure) — lot 59 (#419 R03) :
 * l'identité métier n'est retenue que sur une preuve EXPLICITE —
 *   · rattachement documentaire effectif (la pièce est une source ACTIVE de
 *     l'opération : `representedFileIds`) ;
 *   · référence contractuelle identique et non vide (`meta.contractReference`) ;
 *   · rattachement déclaré par la source elle-même (`meta.operationId`).
 * Même prestataire + même bien NE SUFFIT PLUS : deux contrats distincts chez
 * le même fournisseur restent deux réalités (T2 arbitre, sinon clarification).
 * Aucun rapprochement propre à un fournisseur ou à un produit.
 */
export function memeRealite(op: BusinessSource, autre: BusinessSource): boolean {
  if (op.assetId != null && autre.assetId != null && op.assetId !== autre.assetId) return false;
  const fid = fileIdOf(autre);
  if (fid != null && (op.representedFileIds ?? []).includes(fid)) return true;
  const mo = (op.meta ?? {}) as { contractReference?: unknown; operationId?: unknown };
  const ma = (autre.meta ?? {}) as { contractReference?: unknown; operationId?: unknown };
  const refOp = typeof mo.contractReference === 'string' ? norm(mo.contractReference) : '';
  const refAutre = typeof ma.contractReference === 'string' ? norm(ma.contractReference) : '';
  if (refOp !== '' && refOp === refAutre) return true;
  return mo.operationId != null && ma.operationId != null && Number(mo.operationId) === Number(ma.operationId);
}

/** Ordre de présentation (pure) : capable, autorité, structuration — jamais un score lexical. */
function rang(s: BusinessSource, need: ValueNeed | null): number {
  const d = sourceDomain(s.domain);
  return (carriesRequestedValue(s, need) ? 100 : 0) + d.authority * 10 + (d.structured ? 1 : 0);
}

interface SemanticSelection {
  /**
   * Interprétations retenues : 1 → réponse directe (preuve structurée
   * unique) ; ≥ 2 → arbitrage T2 ou clarification ; 0 → aucune.
   */
  selected: BusinessSource[];
  /** Domaine de l'interprétation unique, ou `null`. */
  domain: BusinessSourceDomain | null;
  /** Candidats examinés : pertinence (> 0 = plausible), capacité (trace). */
  scored: Array<{ ref: string; domain: BusinessSourceDomain; score: number; capable?: boolean; via?: string }>;
  /** Sources éligibles (compte, période, non représentées), ordonnées — réservoir d'arbitrage. */
  eligible: BusinessSource[];
  /** Lot 59 : candidats ÉCARTÉS avant la sélection, et pourquoi (trace, références seulement). */
  excluded: Array<{ ref: string; reason: 'REPRESENTED_BY_OPERATION' | 'OUT_OF_PERIOD' | 'PAYMENT_NOT_INVOICE' | 'FORECAST_NOT_REALIZED' }>;
  /** Raison de la décision (trace). */
  reason: 'SINGLE_CAPABLE' | 'SINGLE_PLAUSIBLE' | 'COMPLEMENTARY_SAME_REALITY' | 'MULTIPLE_PLAUSIBLE' | 'PLAUSIBLE_WITHOUT_VALUE' | 'NO_PLAUSIBLE'
    | 'PRIMARY_AMOUNT_NATURE';
}

/**
 * Lot 75J (#419 R01) — TOTAL d'une même réalité démontrée (pure) : l'Opération
 * qui ne porte pas le montant et ses pièces RATTACHÉES qui le portent. Seuls
 * les montants principaux (facturés / réalisés) sont comptés, une fois chacun
 * (même montant à la même date : une seule fois) ; un règlement ou un devis
 * n'est jamais additionné. Le serveur calcule ; la réponse dit le total, le
 * nombre de montants et le dernier.
 */
export function aggregateSameReality(pivot: BusinessSource, pieces: readonly BusinessSource[]): BusinessSource {
  const vus = new Set<string>();
  const realized: Array<{ cents: number; date: string | null; ref: string }> = [];
  for (const p of pieces) {
    if (p.amountCents == null || !isPrimaryAmount(p)) continue;
    const cle = `${p.amountCents}|${String(p.date ?? '').slice(0, 10)}`;
    if (vus.has(cle)) continue;
    vus.add(cle);
    realized.push({ cents: p.amountCents, date: p.date ? String(p.date).slice(0, 10) : null, ref: p.ref });
  }
  realized.sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));
  const total = realized.reduce((n, r) => n + r.cents, 0);
  return {
    ...pivot,
    amountCents: realized[0]?.cents ?? null,
    amountNature: 'documented',
    meta: {
      ...(pivot.meta ?? {}), totalCents: total, realizedCount: realized.length, lastDate: realized[0]?.date ?? null,
      realized: realized.map(({ cents, date }) => ({ cents, date })), aggregatedFrom: realized.map((r) => r.ref),
      pieceSources: pieces.map((p) => p.source).filter(Boolean),
    },
  };
}

/**
 * Sélection des interprétations parmi les sources RÉELLES (pure, testée) —
 * lot 54E (#419 écarts 1 et 2), aucune règle lexicale ni priorité absolue :
 *   1. ÉLIMINATION déterministe : pièces représentées par une opération,
 *      pièces / échéances datées hors de la période demandée ;
 *   2. PLAUSIBILITÉ : texte réel répondant à un terme compris, ou champ du
 *      registre demandé par UNDERSTAND et renseigné ;
 *   3. CAPACITÉ : parmi les plausibles, celles qui PORTENT la valeur
 *      demandée l'emportent sur celles qui ne la portent pas (une opération
 *      sans montant ne masque plus la facture qui le porte) ;
 *   4. une opération et les pièces du MÊME prestataire (même bien) sont UNE
 *      réalité : l'opération, plus structurée, la représente ;
 *   5. au-delà d'une interprétation : AUCUN départage par score —
 *      l'arbitrage revient à T2 (candidats prévalidés) ou à l'utilisateur.
 */
export function selectInterpretations(
  sources: readonly BusinessSource[], need: SemanticNeed, opts: { period?: { from: string; to: string } | null } = {},
): SemanticSelection {
  const ops = sources.filter((s) => s.domain === 'operation');
  /** Opération qui REPRÉSENTE effectivement la pièce (rattachement documentaire). */
  const rattachee = (s: BusinessSource) => {
    const fid = fileIdOf(s);
    return fid == null ? null : ops.find((o) => (o.representedFileIds ?? []).includes(fid)) ?? null;
  };
  // Lot 59 (#419 R01) : une pièce n'est masquée par son opération que si
  // l'opération PORTE la valeur demandée (montant réalisé consolidé, date de
  // fin…). Sinon la pièce reste la donnée qui répond — jamais « aucun
  // montant » quand la facture rattachée le porte ; jamais de double
  // comptage quand l'opération consolide déjà ce montant.
  const representee = (s: BusinessSource) => {
    const o = rattachee(s);
    return o != null && operationCarriesValue(o, need.need);
  };
  // Lot 53 (PO D21) : période demandée — une pièce ou une échéance DATÉE hors
  // de la période n'y répond pas (une opération reste plausible : sa réponse
  // ne retient que les montants de la période, ou dit qu'il n'y en a pas).
  const horsPeriode = (s: BusinessSource) => Boolean(opts.period) && s.domain !== 'operation' && s.domain !== 'field'
    && Boolean(s.date) && (String(s.date).slice(0, 10) < opts.period!.from || String(s.date).slice(0, 10) > opts.period!.to);
  const excluded: SemanticSelection['excluded'] = [];
  const utiles = sources.filter((s) => {
    if (representee(s)) { excluded.push({ ref: s.ref, reason: 'REPRESENTED_BY_OPERATION' }); return false; }
    if (horsPeriode(s)) { excluded.push({ ref: s.ref, reason: 'OUT_OF_PERIOD' }); return false; }
    return true;
  });
  // Période demandée : une opération porte des montants DATÉS — la réponse
  // dit ceux de la période (ou leur absence) ; elle reste capable.
  const capable = (s: BusinessSource) => carriesRequestedValue(s, need.need) || (Boolean(opts.period) && s.domain === 'operation')
    // Champ du registre DEMANDÉ par T2 : sa signification a été choisie par la compréhension.
    || (s.fieldKey != null && need.facts.includes(s.fieldKey) && need.need === 'end_date' && carriesRequestedValue(s, 'date'));
  const lexical = new Map(utiles.map((s) => [s, sourceScore(s, need.terms) + (s.fieldKey != null && need.facts.includes(s.fieldKey) ? 1 : 0)]));
  // Une pièce RATTACHÉE à une opération pertinente l'est aussi (lien structuré,
  // pas une proximité de mots) — même si son titre ne reprend pas les termes.
  const scored = utiles.map((s) => {
    const o = rattachee(s);
    const herite = o && (lexical.get(o) ?? 0) > 0 ? 1 : 0;
    return { s, score: Math.max(lexical.get(s) ?? 0, herite), capable: capable(s), via: herite && !(lexical.get(s) ?? 0) ? o!.ref : undefined };
  });
  // Lot 75J : `via` — pièce pertinente par son RATTACHEMENT à une opération pertinente (lien structuré).
  const trace = scored.map((x) => ({ ref: x.s.ref, domain: x.s.domain, score: x.score, capable: x.capable, ...(x.via ? { via: x.via } : {}) }));
  const eligible = [...utiles].sort((a, b) => rang(b, need.need) - rang(a, need.need));
  const fin = (selected: BusinessSource[], reason: SemanticSelection['reason']): SemanticSelection => ({
    selected, domain: selected.length === 1 ? selected[0].domain : null, scored: trace, eligible, excluded, reason,
  });

  const plausibles = scored.filter((x) => x.score > 0);
  if (!plausibles.length) return fin([], 'NO_PLAUSIBLE');
  const capables = plausibles.filter((x) => x.capable).map((x) => x.s);
  if (!capables.length) {
    // Aucune source plausible ne porte la valeur : l'interprétation reste
    // celle des sources qui décrivent l'état métier (opérations), dont la
    // réponse dit explicitement l'absence — jamais une pièce sans valeur.
    const etats = plausibles.map((x) => x.s).filter((s) => sourceDomain(s.domain).authority >= 3 && s.domain !== 'field');
    return fin(etats, 'PLAUSIBLE_WITHOUT_VALUE');
  }
  if (capables.length === 1) return fin(capables, plausibles.length === 1 ? 'SINGLE_PLAUSIBLE' : 'SINGLE_CAPABLE');
  /** Lot 75J (#419 R01) : un TOTAL est demandé (explicitement ou sur une période). */
  const total = need.need === 'amount' && (Boolean(need.aggregate) || Boolean(opts.period));
  // Réalité unique DÉMONTRÉE (rattachement, référence) : UNE opération et ses
  // pièces / échéances. L'opération la représente si elle porte la valeur ;
  // sinon la pièce rattachée la plus récente qui la porte (jamais une somme :
  // aucun double comptage).
  const opsCapables = capables.filter((s) => s.domain === 'operation');
  const pivot = opsCapables.length === 1 ? opsCapables[0]
    : opsCapables.length === 0 ? (() => {
      const liees = [...new Set(capables.map((s) => rattachee(s)).filter((o): o is BusinessSource => o != null))];
      return liees.length === 1 ? liees[0] : null;
    })() : null;
  if (pivot && capables.every((s) => s === pivot || (sourceDomain(s.domain).authority < sourceDomain('operation').authority && memeRealite(pivot, s)))) {
    if (capables.includes(pivot) && operationCarriesValue(pivot, need.need)) return fin([pivot], 'COMPLEMENTARY_SAME_REALITY');
    // Lot 75J (#419 R01) : montant principal (facture) avant règlement ou devis, puis le plus récent.
    const pieces = capables.filter((s) => s !== pivot)
      .sort((a, b) => Number(isPrimaryAmount(b)) - Number(isPrimaryAmount(a)) || String(b.date ?? '').localeCompare(String(a.date ?? '')));
    const principales = pieces.filter((s) => s.amountCents != null && isPrimaryAmount(s));
    // Demande de TOTAL : jamais la seule dernière pièce — total serveur des pièces de cette réalité.
    if (total && principales.length > 1) return fin([aggregateSameReality(pivot, principales)], 'COMPLEMENTARY_SAME_REALITY');
    if (pieces.length) return fin([pieces[0]], 'COMPLEMENTARY_SAME_REALITY');
  }
  // Lot 75J (#419 R01) : NATURE du montant demandé (montant). Une preuve de
  // règlement ou un tarif / devis prévisionnel ne se substitue jamais
  // automatiquement à un montant facturé ou réalisé : présents ensemble, seuls
  // les montants principaux restent des interprétations (écart tracé).
  if (need.need === 'amount') {
    const principaux = capables.filter((s) => isPrimaryAmount(s));
    if (principaux.length && principaux.length < capables.length) {
      for (const s of capables) {
        if (!principaux.includes(s)) excluded.push({ ref: s.ref, reason: amountNatureOf(s) === 'payment' ? 'PAYMENT_NOT_INVOICE' : 'FORECAST_NOT_REALIZED' });
      }
      if (principaux.length === 1) return fin(principaux, 'PRIMARY_AMOUNT_NATURE');
      return fin([...principaux].sort((a, b) => rang(b, need.need) - rang(a, need.need)), 'MULTIPLE_PLAUSIBLE');
    }
  }
  return fin([...capables].sort((a, b) => rang(b, need.need) - rang(a, need.need)), 'MULTIPLE_PLAUSIBLE');
}

/**
 * Lot 59 (#419 R04) — la correspondance lexicale d'une source unique
 * est-elle ÉTABLIE (pure) ? Les sujets compris par T2 sont des formulations
 * ALTERNATIVES d'un même besoin (« internet », « fibre », « box internet ») :
 * la correspondance est établie si la source répond ENTIÈREMENT à au moins
 * un sujet (tous les mots de ce sujet), ou si elle est le champ du registre
 * demandé. Une correspondance PARTIELLE à un sujet composé (« box » retrouvé
 * dans « box internet », « internet » non) n'est qu'un indice : T2 arbitre
 * parmi les lectures concurrentes, sinon l'utilisateur choisit. Sans sujet
 * compris (IA indisponible) : comportement inchangé (un terme suffit).
 */
export function lexicalMatchEstablished(s: BusinessSource, need: SemanticNeed, topics: readonly string[] = []): boolean {
  if (s.fieldKey != null && need.facts.includes(s.fieldKey)) return true;
  const sujets = topics.map((t) => semanticTerms([], [t])).filter((t) => t.length > 0);
  if (!sujets.length) return need.terms.length === 0 || sourceScore(s, need.terms) > 0;
  return sujets.some((mots) => mots.every((m) => sourceScore(s, [m]) > 0));
}

/**
 * Candidats CONTEXTUELS bornés (pure) — lot 59 (#419 R04) : sans
 * correspondance lexicale, T2 reçoit des candidats de TOUS les domaines qui
 * portent la valeur demandée (opérations, champs, agenda, documents…),
 * répartis par domaine (aucun domaine n'évince les autres), dans la limite
 * `max`. Ordre interne d'un domaine : capacité, autorité (jamais un score).
 */
export function diversifiedCandidates(sources: readonly BusinessSource[], max: number): BusinessSource[] {
  const parDomaine = new Map<string, BusinessSource[]>();
  for (const s of sources) parDomaine.set(s.domain, [...(parDomaine.get(s.domain) ?? []), s]);
  const files = [...parDomaine.values()];
  const out: BusinessSource[] = [];
  for (let i = 0; out.length < max && files.some((f) => i < f.length); i += 1) {
    for (const f of files) if (i < f.length && out.length < max) out.push(f[i]);
  }
  return out;
}

/**
 * Lot 59 (#419 R07) — unité d'un DÉCOMPTE de périodes restantes (« combien
 * de mensualités me reste-t-il ? ») : signal générique de calendrier (mois,
 * trimestre, année, semaine), jamais un sujet métier. `null` : la question
 * ne demande pas un tel décompte.
 */
export type PeriodUnit = 'month' | 'quarter' | 'year' | 'week';
export function remainingCountUnit(message: string): PeriodUnit | null {
  const m = plain(message ?? '');
  if (!/\bcombien\b/.test(m) || !/\b(rest\w*|encore)\b/.test(m)) return null;
  const apres = m.slice(m.search(/\bcombien\b/));
  if (/\b(mensualite\w*|mois)\b/.test(apres)) return 'month';
  if (/\b(trimestrialite\w*|trimestre\w*)\b/.test(apres)) return 'quarter';
  if (/\b(annuite\w*|annee\w*|ans)\b/.test(apres)) return 'year';
  if (/\bsemaines?\b/.test(apres)) return 'week';
  return null;
}

/** Nombre de périodes ENTIÈRES de `today` (exclu) à `end` (inclus) — pure, testée. */
export function remainingPeriods(today: string, end: string, unit: PeriodUnit): number {
  const [y, m, d] = today.slice(0, 10).split('-').map(Number);
  const fin = end.slice(0, 10);
  if (fin <= today.slice(0, 10)) return 0;
  const pas = unit === 'month' ? 1 : unit === 'quarter' ? 3 : unit === 'year' ? 12 : 0;
  let n = 0;
  for (let k = 1; k < 2000; k += 1) {
    const dt = pas ? new Date(Date.UTC(y, m - 1 + k * pas, 1)) : new Date(Date.UTC(y, m - 1, d + 7 * k));
    if (pas) {
      const dernier = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
      dt.setUTCDate(Math.min(d, dernier));
    }
    if (dt.toISOString().slice(0, 10) > fin) break;
    n = k;
  }
  return n;
}

// ── Arbitrage par T2 (lot 54E, #419 écart 1) ───────────────────────────────

/** Décision d'arbitrage BRUTE rendue par T2 (avant validation serveur). */
export interface RawSemanticDecision {
  decision: 'SELECT' | 'CLARIFY' | 'NONE';
  selectedCandidateRef?: string | null;
  confidence: 'exact' | 'probable' | 'ambiguous';
  reason?: string;
}

/** Décision VALIDÉE par le serveur. */
type ValidatedSemanticDecision =
  | { kind: 'select'; source: BusinessSource; ref: string }
  | { kind: 'clarify'; failure: string | null }
  | { kind: 'none' };

/**
 * Validation SERVEUR d'une décision T2 (pure, testée) : la référence doit
 * être l'une de celles PRÉSENTÉES (jamais un identifiant inventé), la
 * confiance suffisante (`exact` exigée quand UNDERSTAND avait lui-même
 * signalé une ambiguïté). Tout le reste → clarification (jamais un choix
 * lexical de repli).
 */
export function validateSemanticDecision(
  d: RawSemanticDecision | null, presented: ReadonlyMap<string, BusinessSource>, o: { requireExact?: boolean } = {},
): ValidatedSemanticDecision {
  if (!d) return { kind: 'clarify', failure: 'NO_DECISION' };
  if (d.decision === 'NONE') return { kind: 'none' };
  if (d.decision === 'CLARIFY') return { kind: 'clarify', failure: null };
  const ref = (d.selectedCandidateRef ?? '').trim();
  const s = presented.get(ref);
  if (!s) return { kind: 'clarify', failure: ref ? 'UNKNOWN_CANDIDATE_REF' : 'MISSING_CANDIDATE_REF' };
  if (d.confidence === 'ambiguous' || (o.requireExact && d.confidence !== 'exact')) return { kind: 'clarify', failure: 'INSUFFICIENT_CONFIDENCE' };
  return { kind: 'select', source: s, ref };
}

/** Genre des noms métier (P09) pour la question de clarification. */
const FEMININ = new Set(['intervention', 'vente', 'dépense', 'information', 'échéance']);

/**
 * Question de clarification métier (pure, testée), issue des candidats :
 * « De quel contrat parlez-vous ? » quand tous sont du même type métier.
 */
export function semanticQuestion(cands: readonly BusinessSource[]): string {
  // Lot 59 (#419 R05) : une seule lecture possible mais non prouvée — on la
  // fait CONFIRMER plutôt que de la servir.
  if (cands.length === 1) return `Pour être sûr de bien vous répondre : votre question porte-t-elle sur ${cands[0].label} ?`;
  const noms = [...new Set(cands.map((c) => (c.domain === 'operation' ? c.kindNoun ?? null : c.kindNoun ?? sourceDomain(c.domain).noun)))];
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
  /** Sources envisagées : pertinence (score > 0) et CAPACITÉ à répondre (lot 75J). */
  semanticCandidates: Array<{ ref: string; domain: string; score: number; capable?: boolean }>;
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
  // ── Lot 54E (#419 écart 9) : décision sémantique IA ─────────────────────
  /** Qui a choisi la source servie : preuve structurée (`deterministic`) ou T2 (`ai`). */
  candidateSelectionMode: 'deterministic' | 'ai' | null;
  /** Motif de la sélection déterministe (`selectInterpretations`). */
  selectionReason: string | null;
  semanticDecision: 'SELECT' | 'CLARIFY' | 'NONE' | null;
  semanticDecisionConfidence: string | null;
  /** Références de sources (serveur) présentées à T2 — jamais de contenu. */
  candidateRefsPresentedToAI: string[];
  candidateRefSelectedByAI: string | null;
  candidateRefValidated: boolean | null;
  candidateValidationFailure: string | null;
  // ── Lot 54E (#419 §15) : informations apportées ─────────────────────────
  interactionMode: string | null;
  suppliedFactsCount: number;
  updateCapabilityResolved: boolean | null;
  /** Capacité d'écriture résolue par le serveur (`asset_field`…), jamais une table. */
  updateTargetType: string | null;
  confirmationPlanCreated: boolean;
  // ── Lot 59 (#419 finalisation) : reconstitution de la décision ─────────
  /** Candidats écartés AVANT la sélection et leur motif (références seulement). */
  candidatesExcluded: Array<{ ref: string; reason: string }>;
  /** Correspondance lexicale de la source unique jugée établie (sinon : arbitrage / clarification). */
  lexicalMatchEstablished: boolean | null;
  /** Arbitrage IA impossible : motif (`PROMPT_UNSUPPORTED`, `BUDGET`, `AI_UNAVAILABLE`…). */
  arbitrationUnavailableReason: string | null;
  /** Capacités du prompt maître T2 EFFECTIF (BO) constatées pour cette demande. */
  t2PromptCapabilities: { arbitration: boolean; interaction: boolean; version: string | null; compatible?: boolean | null } | null;
  /** Informations de CONTEXTE (clés du registre) exploitées pour cette seule demande — jamais enregistrées. */
  contextFactsUsed: string[];
  /** Informations de contexte écartées (valeur non relue dans le message, clé inconnue). */
  contextFactsIgnored: number;
  /** Contradiction entre une information de contexte et une donnée du compte (signalée, jamais tranchée). */
  contextContradiction: boolean;
  /** Calcul serveur réalisé (`remaining_periods`) ou refusé faute de données (`remaining_periods:missing`). */
  calculation: string | null;
  /** Modifications proposées dans le plan (toutes les informations validées). */
  updateFactsProposed: number;
  /** Informations NON proposées et motif (aucun abandon silencieux). */
  updateFactsRefused: Array<{ fieldKey: string | null; reason: string }>;
  // ── Lot 75J (#419 résiduels) : reconstitution complète ──────────────────
  /** Candidats éligibles NON présentés à T2 (limite de volume) — jamais choisis. */
  candidatesNotPresented: number;
  /** Informations de contexte écartées, avec leur motif (jamais silencieusement). */
  contextFactsRejected: Array<{ fieldKey: string | null; reason: string }>;
  /** Prompt maître T2 effectif constaté à la COMPRÉHENSION (version, capacités, compatibilité). */
  t2PromptAtUnderstand: { version: string | null; arbitration: boolean; interaction: boolean; compatible: boolean | null } | null;
  /** Informations apportées non comprises faute de prompt compatible (`PROMPT_UNSUPPORTED`). */
  interactionUnavailableReason: string | null;
}

export function emptySemanticTrace(p: Pick<SemanticTrace, 'trigger' | 'deterministicMatch' | 'deterministicConfidence'>): SemanticTrace {
  return {
    ...p, classificationEscalated: false, understandCalled: false, intent: null, understandConfidence: null, resolvedTargets: [],
    requestedFacts: [], requestedTopics: [], semanticScopeResolved: false, semanticAmbiguity: false, semanticResidue: [],
    semanticCandidates: [], sourceDomainsAvailable: [], operationCandidates: [], selectedOperationId: null, selectedSource: null,
    structuredStrategyCandidate: null, structuredStrategyExecuted: false, structuredScopeFallbackPrevented: false,
    clarificationCreated: false, clarificationReason: null, fallbackReason: null,
    candidateSelectionMode: null, selectionReason: null, semanticDecision: null, semanticDecisionConfidence: null,
    candidateRefsPresentedToAI: [], candidateRefSelectedByAI: null, candidateRefValidated: null, candidateValidationFailure: null,
    interactionMode: null, suppliedFactsCount: 0, updateCapabilityResolved: null, updateTargetType: null, confirmationPlanCreated: false,
    candidatesExcluded: [], lexicalMatchEstablished: null, arbitrationUnavailableReason: null, t2PromptCapabilities: null,
    contextFactsUsed: [], contextFactsIgnored: 0, contextContradiction: false, calculation: null, updateFactsProposed: 0, updateFactsRefused: [],
    candidatesNotPresented: 0, contextFactsRejected: [], t2PromptAtUnderstand: null, interactionUnavailableReason: null,
  };
}
