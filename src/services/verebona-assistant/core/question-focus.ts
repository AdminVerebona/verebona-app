/**
 * Lot 111K — CE QUE LA QUESTION DEMANDE (ticket « T2 : pertinence des
 * preuves », §3.1). Module PUR, partagé par la recherche des faits
 * (`evidence-adequacy`), la lecture canonique (`canonical/structured-answers`),
 * le contrôle final commun (`final-answer-control`), le corpus et le
 * diagnostic T2.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LA QUESTION, PAS SES MOTS
 *
 * La recherche T2 trouve des faits par leurs MOTS. Ce module décrit ce que la
 * question DEMANDE, indépendamment du registre canonique :
 *
 *   · propriétés du registre (`registryKeys`, quand elles existent) ;
 *   · propriété hors registre : terme de TÊTE de la demande (« la franchise
 *     de l'assurance » → `franchise`), termes de contexte (« assurance »),
 *     sujets rendus par UNDERSTAND (`requestedTopics`) ;
 *   · NATURE de la valeur attendue (montant, date, durée, quantité, statut
 *     oui / non), lue dans la FORME de la question (« combien coûte »,
 *     « quand », « a-t-il été… ? ») ;
 *   · qualification métier explicitement demandée (prévu, réalisé, facturé,
 *     RÉGLÉ, estimé) — « combien ai-je payé ? » demande un MONTANT ; « est-ce
 *     réglé ? », « reste-t-il à payer ? », « preuve de paiement » demandent
 *     l'état du RÈGLEMENT ;
 *   · période (`query-period`, bornes résolues seulement) ;
 *   · demande composite (« la date ET le montant »).
 *
 * Aucune catégorie de bien, de document ou de propriété n'est codée ici :
 * seuls des mots de STRUCTURE de la question (interrogatifs, mesures,
 * verbes de règlement) et le registre canonique servent.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { getField } from '@/services/canonical/registry';
import { assetDesignationsIn, withoutAssetDesignations } from '@/lib/asset-taxonomy';
import { analyserPeriode } from './query-period';
import { editDistance, stemFr } from './query-terms';
import { DOCUMENT_TYPE_QUERY_WORDS } from '@/lib/referential/document-codes';

export type ValueNature = 'AMOUNT' | 'DATE' | 'DURATION' | 'QUANTITY' | 'TEXT' | 'STATUS';
export type BusinessQualification = 'SETTLED' | 'FORECAST' | 'REALIZED' | 'INVOICED' | 'ESTIMATED';

export interface QuestionFocus {
  version: 1;
  /** Propriétés normalisées du registre demandées (vide : hors registre ou non comprise). */
  registryKeys: string[];
  /** Terme de TÊTE de la propriété demandée (racine, sans accent), hors mots de nature. */
  headTerm: string | null;
  /** Termes de la propriété et de son contexte (racines), tête en premier ; ni objet, ni nature. */
  propertyTerms: string[];
  /** Sujets hors registre rendus par UNDERSTAND (racines). */
  topics: string[];
  /** Nature de la valeur attendue, si la forme de la question la dit. */
  valueNature: ValueNature | null;
  /** Qualification métier explicitement demandée (null : non précisée). */
  qualification: BusinessQualification | null;
  /** La question porte sur l'état du RÈGLEMENT (oui / non, reste à payer, preuve de paiement). */
  asksSettlement: boolean;
  /** Question fermée (oui / non). */
  yesNo: boolean;
  /** Période résolue de la question. */
  period: { from: string; to: string; label: string } | null;
  /** Plusieurs informations demandées (« la date et le montant »). */
  composite: boolean;
  /** Date demandée : fin (« expire », « jusqu'à quand ») ou début (« depuis quand »). */
  dateRole: DateRole;
}

const plat = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’`]/g, "'");
const motsDe = (s: string) => plat(s).replace(/'/g, ' ').split(/[^a-z0-9]+/).filter((w) => w.length >= 2);

/** Mots outils, interrogatifs et verbes de question : jamais une propriété. */
const OUTILS = new Set([
  'mon', 'ma', 'mes', 'ton', 'ta', 'tes', 'notre', 'nos', 'votre', 'vos', 'son', 'sa', 'ses', 'leur', 'leurs',
  'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'au', 'aux', 'et', 'ou', 'ni', 'mais', 'en', 'y', 'on',
  'ce', 'cet', 'cette', 'ces', 'ci', 'ca', 'cela', 'ici', 'je', 'tu', 'il', 'elle', 'nous', 'vous', 'ils', 'elles', 'me', 'moi', 'se',
  'ai', 'as', 'avons', 'avez', 'ont', 'avait', 'avais', 'eu', 'suis', 'es', 'est', 'sont', 'ete', 'etait', 'etaient', 'sera', 'seront',
  'qu', 'que', 'quoi', 'qui', 'quel', 'quelle', 'quels', 'quelles', 'lequel', 'laquelle', 'comment', 'pourquoi', 'ou',
  'pour', 'par', 'sur', 'sous', 'dans', 'avec', 'sans', 'chez', 'vers', 'depuis', 'entre', 'avant', 'apres', 'pendant', 'selon',
  'tout', 'tous', 'toute', 'toutes', 'plus', 'moins', 'tres', 'deja', 'encore', 'bien', 'actuel', 'actuelle', 'actuellement',
  'peux', 'peut', 'pouvez', 'sais', 'savoir', 'voudrais', 'veux', 'faut', 'fait', 'faire', 'dis', 'dire', 'donne', 'donner', 'indique',
  'indiquer', 'rappelle', 'rappeler', 'svp', 'stp', 'merci', 'bonjour', 'connaitre', 'trouve', 'trouver', 'retrouve', 'montre', 'affiche',
  'est-ce', 'ai-je', 'a-t-il', 'a-t-elle', 'ont-ils', 'est-il', 'est-elle', 'sont-ils', 'il-y', 'combien', 'nombre', 'reste', 'restait',
  'document', 'documents', 'enregistre', 'enregistree', 'indiquee', 'indique', 'inscrit', 'inscrite', 'mentionne', 'mentionnee', 'ecrit', 'ecrite',
  'quand', 'jour', 'annee', 'an', 'ans', 'mois', 'jusqu', 'jusque', 'jusqua', 'partir',
  'dit', 'disent', 'contient', 'parle', 'concerne', 'compare', 'comparer', 'explique', 'expliquer', 'resume', 'resumer', 'liste', 'lister',
  'cherche', 'chercher', 'voir', 'ouvre', 'ouvrir', 'aide', 'aider',
]);

/**
 * Mots de CONTENANT documentaire (« le montant de la FACTURE du plombier ») :
 * ils désignent où chercher, jamais la propriété. En tête de demande, la
 * propriété est alors la valeur principale de la nature demandée.
 */
const CONTENANTS = new Set(DOCUMENT_TYPE_QUERY_WORDS.filter((w) => !['garantie', 'assurance', 'bail', 'contrat', 'avenant', 'dpe', 'diagnostic'].includes(w)).map((w) => stemFr(w)));

/** Rôle d'une date demandée, lu dans la forme de la question (fin / début). */
export type DateRole = 'END' | 'START' | null;

/**
 * Mots de NATURE : ils disent quelle forme de valeur est attendue, jamais
 * quelle propriété (« le PRIX de la révision » demande un montant ; la
 * propriété est désignée par le reste de la phrase).
 */
const NATURE: ReadonlyArray<{ nature: ValueNature; mots: RegExp }> = [
  { nature: 'AMOUNT', mots: /^(prix|montant|montants|cout|couts|coute|coutent|coutera|tarif|tarifs|somme|sommes|total|paye|payee|payes|payees|payer|depense|depenses|depensee|depensees|regle|reglee|regles|reglees|regler|verse|versee|euros?|eur)$/ },
  { nature: 'DATE', mots: /^(date|dates|quand|expire|expirera|expiration|termine|terminera|finit|commence|debute|echoit)$/ },
  { nature: 'DURATION', mots: /^(duree|durees|longtemps)$/ },
];
const natureDuMot = (w: string): ValueNature | null => NATURE.find((n) => n.mots.test(w))?.nature ?? null;

/** Verbes de règlement (forme de la question, pas une catégorie). */
const REGLEMENT = /\b(paye|payee|payes|payees|payer|regle|reglee|regles|reglees|regler|acquitte|acquittee|verse|versee|solde|soldee)\b/;
/** Interrogatif OUVERT : la question n'est pas fermée malgré une inversion (« quand est-il… »). */
const OUVERTE = /\b(quand|combien|quel|quelle|quels|quelles|comment|pourquoi|jusqu|lequel|laquelle|quoi)\b/;
/** Question FERMÉE : inversion, « est-ce que », « déjà ». */
const FERMEE = /^(est-ce|est ce)\b|\b(a-t-(il|elle)|ont-(ils|elles)|est-(il|elle)|sont-(ils|elles)|ai-je|avons-nous|suis-je)\b|\b(deja|bien) (ete )?(paye|regle|verse|acquitte)/;
/** Demandes explicites sur le règlement, quelle que soit la forme. */
const REGLEMENT_NOMS = /\b(preuves? de (paiement|reglement|virement)|justificatifs? de (paiement|reglement)|reste(-t-il| t il)? (a|à) (payer|regler)|impaye\w*|non (paye|regle)\w*|deja (paye|regle|verse)\w*|etat du (paiement|reglement)|(paiement|reglement) (effectue|confirme|recu))\b/;

/** La question porte-t-elle sur l'état du RÈGLEMENT (pure, testée) ? */
export function asksSettlement(message: string): boolean {
  const m = plat(message).replace(/\s+/g, ' ').trim();
  if (REGLEMENT_NOMS.test(m)) return true;
  // « Combien ai-je payé ? » demande un montant ; « Ai-je payé ? » l'état du règlement.
  if (/\bcombien\b/.test(m)) return false;
  // « Ai-je payé… ? », « Est-ce réglé ? » ; « Quand ai-je payé… ? » (date du règlement).
  return REGLEMENT.test(m) && (/\bquand\b/.test(m) || (FERMEE.test(m) && !OUVERTE.test(m)));
}

function qualificationDe(m: string, settlement: boolean): BusinessQualification | null {
  if (settlement) return 'SETTLED';
  if (/\b(prevue?s?|devis|budget\w*|a prevoir|planifie\w*)\b/.test(m)) return 'FORECAST';
  if (/\b(estime\w*|estimation|approximati\w*)\b/.test(m)) return 'ESTIMATED';
  if (/\b(facture(e|es|s)? (pour|par|a)|montant facture|a ete facture)\b/.test(m)) return 'INVOICED';
  if (/\b(realise\w*|effectue\w*)\b/.test(m)) return 'REALIZED';
  return null;
}

/** Racine de comparaison d'un mot (pure) : accents, pluriel simple. */
export function termRoot(w: string): string {
  return stemFr(plat(w));
}

/**
 * Analyse d'une question (pure, testée). `objectNames` : noms des biens /
 * objets RÉSOLUS (leurs mots désignent l'objet, jamais la propriété).
 */
export function analyzeQuestionFocus(
  message: string,
  opts: { requestedFacts?: readonly string[]; requestedTopics?: readonly string[]; objectNames?: readonly string[]; today?: string } = {},
): QuestionFocus {
  const m = plat(message).replace(/\s+/g, ' ').trim();
  const settlement = asksSettlement(message);
  const yesNo = FERMEE.test(m) && !OUVERTE.test(m);
  // Désignations propres (« la Polo », « l'assurance MAIF ») : un mot à
  // majuscule hors début de phrase nomme un objet ou un émetteur, jamais la
  // propriété demandée (règle de la langue, pas une liste).
  const propres = (message.match(/(?<=\S\s+)[A-ZÀ-Ý][\p{L}\d-]*/gu) ?? []).flatMap((w) => motsDe(w));
  const objet = new Set([...(opts.objectNames ?? []).flatMap((n) => motsDe(n)), ...propres].map(termRoot));
  const designations = new Set(assetDesignationsIn(message).flatMap((d) => motsDe(d.matched)).map(termRoot));
  const restant = new Set(motsDe(withoutAssetDesignations(message)).map(termRoot));

  let nature: ValueNature | null = null;
  const proprietes: string[] = [];
  const mots = motsDe(message);
  for (let i = 0; i < mots.length; i += 1) {
    const w = mots[i];
    if (/^\d+$/.test(w)) continue;
    const n = natureDuMot(w);
    if (n) { nature ??= n; continue; }
    if (OUTILS.has(w)) continue;
    const r = termRoot(w);
    if (objet.has(r) || (designations.has(r) && !restant.has(r))) continue;
    if (r.length < 3 || proprietes.includes(r)) continue;
    proprietes.push(r);
  }
  // « Combien de chevaux… » : quantité ; « combien » + verbe de coût : montant (déjà lu).
  if (!nature && /\bcombien de (temps)\b/.test(m)) nature = 'DURATION';
  else if (!nature && /\bcombien d[e']/.test(m)) nature = 'QUANTITY';
  else if (!nature && /\bcombien\b/.test(m)) nature = 'AMOUNT';
  if (yesNo && !nature) nature = 'STATUS';
  if (settlement) nature = yesNo ? 'STATUS' : nature ?? 'AMOUNT';

  const registryKeys = [...new Set((opts.requestedFacts ?? []).filter((k) => !!getField(k)))];
  const topics = [...new Set((opts.requestedTopics ?? []).flatMap((t) => motsDe(t)).filter((w) => !OUTILS.has(w) && !natureDuMot(w)).map(termRoot))]
    .filter((r) => r.length >= 3 && !objet.has(r));
  const periode = opts.today ? analyserPeriode(message, opts.today) : null;
  const sousDemandes = m.split(/\s(?:et|ainsi que|puis)\s/).filter((p) => /\b(quel\w*|quand|combien|date|montant|prix|duree)\b/.test(p));
  // Contenant documentaire en tête : la propriété est la valeur principale de la nature.
  const tete = proprietes[0] && CONTENANTS.has(proprietes[0]) && nature && nature !== 'STATUS' ? null : proprietes[0] ?? null;
  const dateRole: DateRole = nature !== 'DATE' ? null
    : /\b(expire\w*|expiration|termine\w*|finit|fin|echeance|echoit|jusqu)/.test(m) ? 'END'
      : /\b(commence\w*|debut\w*|depuis quand|effet)\b/.test(m) ? 'START' : null;
  return {
    version: 1,
    registryKeys,
    headTerm: tete ?? topics[0] ?? null,
    dateRole,
    propertyTerms: proprietes,
    topics,
    valueNature: nature,
    qualification: qualificationDe(m, settlement),
    asksSettlement: settlement,
    yesNo,
    period: periode && periode.kind === 'resolved' ? { from: periode.from, to: periode.to, label: periode.label } : null,
    composite: registryKeys.length > 1 || sousDemandes.length > 1,
  };
}

/**
 * Deux racines désignent-elles le même mot (pure) ? Égalité, préfixe (≥ 5
 * lettres), pluriel en -aux, ou une seule lettre d'écart sur un mot long
 * (« achat » / « achet(é) », « garanti » / « garantie »).
 */
export function sameRoot(a: string, b: string): boolean {
  if (a === b) return true;
  const n = (x: string) => x.replace(/aux$/, 'al').replace(/(ee|es|e)$/, '');
  const x = n(a); const y = n(b);
  if (x === y) return true;
  if (x.length >= 5 && y.length >= 5 && (x.startsWith(y) || y.startsWith(x))) return true;
  // Même famille de mots longs (« plombier » / « plomberie », « assurance » / « assureur »).
  if (x.length >= 7 && y.length >= 7 && x.slice(0, 5) === y.slice(0, 5)) return true;
  return x.length >= 5 && y.length >= 5 && editDistance(x, y, 1) <= 1;
}

/** Libellés (racines) d'une propriété du registre, pour une comparaison de descripteurs. */
export function registryLabelRoots(key: string): string[] {
  const def = getField(key);
  return def ? motsDe(def.label).filter((w) => !OUTILS.has(w)).map(termRoot) : [];
}
