/**
 * Lot 111K — ADÉQUATION D'UNE PREUVE À LA QUESTION (ticket « T2 : pertinence
 * des preuves », §3.2 à §3.4). Module PUR, mutualisé : il ne dépend d'aucune
 * famille de question.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * EXTRAIRE ≠ RÉPONDRE
 *
 * La confiance d'EXTRACTION (« certain », « probable » : T1 a bien lu la
 * valeur) ne dit pas si la valeur RÉPOND à la question. Chaque candidat est
 * donc évalué sur les dimensions de la demande, après la validation objet →
 * propriété du lot 101A (`candidate-validation`) :
 *
 *   objet           le fait vise l'objet demandé (101A) ;
 *   propriété       registre, ou terme de TÊTE de la demande dans le
 *                   DESCRIPTEUR du fait (attribut, libellé, clé) — un mot
 *                   trouvé seulement dans la valeur, le titre ou le sujet du
 *                   document ne suffit pas ;
 *   contexte        nature du document : coût documenté, PRÉVU (devis),
 *                   RÉGLÉ (preuve de paiement, acompte) — un coût ne prouve
 *                   pas un règlement, un devis n'est pas une dépense ;
 *   période         bornes de la question, quand elle en porte ;
 *   nature          un montant pour un montant, une date pour une date…
 *
 * Verdicts : KEPT (admissible), UNCERTAIN (correspondance incertaine : seule
 * une validation sémantique BORNÉE à ces sources peut trancher — jamais une
 * réponse déterministe), REJECTED (motif tracé).
 *
 * PLURALITÉ (§3.4) — sur les SEULS candidats retenus, regroupés par
 * information (propriété × objet × qualification) :
 *
 *   SINGLE / CONCORDANT     une valeur (une ou plusieurs sources) ;
 *   SUCCESSIVE_VERSIONS     même information, valeurs à des dates distinctes :
 *                           la plus récente répond, les autres sont tracées ;
 *   DIFFERENT_INFORMATION   plusieurs informations distinctes : jamais un
 *                           conflit ;
 *   REAL_CONFLICT           même information, même objet, contexte temporel
 *                           compatible, valeurs incompatibles : signalé avec
 *                           ses sources, aucune valeur choisie.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { amountRoleOfLabel } from '@/services/ai/source-analysis/projection/amount-roles';
import { isPaymentProofType } from '../canonical/expense-classes';
import { validateFactCandidate, type CandidateObject, type CandidateVerdict } from './candidate-validation';
import { registryLabelRoots, sameRoot, termRoot, type QuestionFocus, type ValueNature } from './question-focus';
import type { FactHit } from './data-answer.service';

export type DocumentQualification = 'DOCUMENTED' | 'FORECAST' | 'SETTLED';
export type PropertyMatch = 'REGISTRY' | 'HEAD' | 'CONTEXT_HEAD' | 'NATURE' | 'PARTIAL' | 'NONE' | 'UNFILTERED';
export type Plurality = 'SINGLE' | 'CONCORDANT' | 'SUCCESSIVE_VERSIONS' | 'DIFFERENT_INFORMATION' | 'REAL_CONFLICT';

/** Motifs de rejet ajoutés au lot 111K (en plus de ceux du lot 101A). */
export type AdequacyRejection =
  | 'PROPERTY_MISMATCH' | 'PROPERTY_UNCERTAIN' | 'VALUE_NATURE_MISMATCH' | 'CONTEXT_MISMATCH' | 'PERIOD_MISMATCH'
  | 'LESS_SPECIFIC' | 'OTHER_QUALIFICATION' | 'SUPERSEDED';

/** Dimensions d'adéquation d'un candidat (tracées, aucun contenu). */
export interface AdequacyDimensions {
  property: PropertyMatch;
  valueNature: ValueNature;
  natureFit: boolean;
  context: DocumentQualification;
  period: 'IN' | 'OUT' | 'UNKNOWN' | 'NOT_ASKED';
  /** Confiance d'EXTRACTION (T1), distincte de la pertinence. */
  extraction: string;
  /** Spécificité de la correspondance à la propriété demandée (comparaison entre candidats). */
  specificity: number;
  /** Part des termes de la demande retrouvés dans le fait (0..1). */
  coverage: number;
}

export interface AssessedCandidate {
  fact: FactHit;
  verdict: CandidateVerdict;
  dims: AdequacyDimensions | null;
  /** Identité de l'information : propriété × objet × qualification. */
  infoKey: string;
  /** Date utile (fin de période, début, date du document). */
  date: string | null;
}

export interface PluralityGroup {
  infoKey: string;
  kind: Exclude<Plurality, 'DIFFERENT_INFORMATION'>;
  /** Faits de la valeur retenue (vide : conflit réel, aucune valeur choisie). */
  retained: FactHit[];
  /** Un fait par valeur distincte (conflit : toutes ; versions : de la plus récente à la plus ancienne). */
  values: FactHit[];
}

export interface AdequacyResult {
  assessed: AssessedCandidate[];
  /** Candidats retenus pour répondre (après sélection et versions). */
  selected: FactHit[];
  /** Correspondance incertaine : validation sémantique bornée seulement. */
  uncertain: FactHit[];
  groups: PluralityGroup[];
  plurality: Plurality | null;
}

const plat = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’`]/g, "'");
const racines = (s: string | null | undefined) => (s ? plat(s).replace(/'/g, ' ').split(/[^a-z0-9]+/).filter((w) => w.length >= 2).map(termRoot) : []);
const contient = (xs: readonly string[], r: string) => xs.some((x) => sameRoot(x, r));
/** Descripteurs d'une date de FIN ou de DÉBUT (mots de structure). */
const ROLE_DATE = { END: /\b(fin|echeance|expiration|expire|terme|jusqu|validite|limite)\b/, START: /\b(debut|effet|depuis|souscription|commencement)\b/ };

const MONETAIRE = /^(eur|€|euros?|cents?)$/i;
const DUREE = /^(mois|ans?|annees?|jours?|semaines?|heures?|months?|years?|days?|weeks?)$/i;
const DATE_TEXTE = /^\s*(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}(er)? (janvier|fevrier|février|mars|avril|mai|juin|juillet|aout|août|septembre|octobre|novembre|decembre|décembre) \d{4})\s*$/i;

/** Nature de la valeur d'un fait (pure, testée). */
export function factValueNature(f: Pick<FactHit, 'valueText' | 'valueNumber' | 'valueUnit' | 'valueType'>): ValueNature {
  const unite = (f.valueUnit ?? '').trim();
  if ((unite && MONETAIRE.test(unite)) || /^money/.test(f.valueType ?? '') || /€|\beur\b/i.test(f.valueText ?? '') && /\d/.test(f.valueText ?? '')) return 'AMOUNT';
  if (/^date/.test(f.valueType ?? '') || DATE_TEXTE.test(f.valueText ?? '')) return 'DATE';
  if (unite && DUREE.test(unite)) return 'DURATION';
  if (f.valueNumber != null || /^(number|integer|decimal)/.test(f.valueType ?? '')) return 'QUANTITY';
  return 'TEXT';
}

/** Une valeur de cette nature peut-elle répondre à la nature demandée (pure) ? */
export function natureFits(asked: ValueNature | null, got: ValueNature): boolean {
  if (!asked || asked === 'TEXT' || asked === 'STATUS') return true;
  if (asked === 'QUANTITY') return got === 'QUANTITY' || got === 'DURATION' || got === 'TEXT';
  if (got === 'TEXT') return false;
  return asked === got;
}

const DEVIS_TYPE = /_QUOTE$|^DEVIS/;
const DEVIS_LIBELLE = /\b(devis|estimation|estime\w*|previsionnel\w*|prevu\w*)\b/;

/** Qualification documentaire d'un fait : coût documenté, prévu, réglé (pure, testée). */
export function documentQualification(f: Pick<FactHit, 'documentTypeCode' | 'attribute' | 'label' | 'factKey' | 'documentTitle'>): DocumentQualification {
  const libelle = [f.attribute, f.label].filter(Boolean).join(' ');
  const role = amountRoleOfLabel(libelle);
  if (isPaymentProofType(f.documentTypeCode) || role === 'PAYMENT' || role === 'DEPOSIT') return 'SETTLED';
  if (DEVIS_TYPE.test((f.documentTypeCode ?? '').toUpperCase()) || DEVIS_LIBELLE.test(plat(libelle))) return 'FORECAST';
  return 'DOCUMENTED';
}

function preferredQualification(focus: QuestionFocus): DocumentQualification {
  if (focus.asksSettlement || focus.qualification === 'SETTLED') return 'SETTLED';
  if (focus.qualification === 'FORECAST' || focus.qualification === 'ESTIMATED') return 'FORECAST';
  return 'DOCUMENTED';
}

const descripteur = (f: FactHit) => [f.attribute, f.label, f.rawKey, f.factKey && !/^(fact|fait|value|valeur|f\d+)$/i.test(f.factKey) ? f.factKey.replace(/[_.-]+/g, ' ') : null];
const dateUtile = (f: FactHit): string | null => (f.periodEnd ?? f.periodStart ?? f.documentDate ?? null)?.slice(0, 10) ?? null;

function periodeDe(f: FactHit, p: QuestionFocus['period']): AdequacyDimensions['period'] {
  if (!p) return 'NOT_ASKED';
  const debut = f.periodStart?.slice(0, 10) ?? null;
  const fin = f.periodEnd?.slice(0, 10) ?? null;
  if (debut || fin) return (fin ?? debut)! < p.from || (debut ?? fin)! > p.to ? 'OUT' : 'IN';
  const d = f.documentDate?.slice(0, 10) ?? null;
  if (!d) return 'UNKNOWN';
  return d < p.from || d > p.to ? 'OUT' : 'IN';
}

function comparable(f: FactHit): string {
  if (f.valueNumber !== null && f.valueNumber !== undefined && (f.valueUnit || !f.valueText)) return `${Number(f.valueNumber)}|${(f.valueUnit ?? '').toLowerCase()}`;
  return plat(f.valueText ?? '').trim();
}
export { comparable as comparableValue };

/** Correspondance d'un fait à la propriété demandée (pure). */
function proprieteDe(f: FactHit, focus: QuestionFocus, base: CandidateVerdict, nature: ValueNature): { match: PropertyMatch; specificity: number } {
  const desc = descripteur(f).flatMap(racines);
  // Contexte du fait : son sujet et le titre de son document (« Révision », « Facture plomberie »).
  const sujet = [...racines(f.subject), ...racines(f.documentTitle)];
  const autres = focus.propertyTerms.slice(1).filter((t) => contient(desc, t)).length;
  const fit = natureFits(focus.valueNature, nature);
  if (focus.registryKeys.length) {
    if (base.sourceProperty.length) return { match: 'REGISTRY', specificity: 10 };
    const libelles = focus.registryKeys.flatMap(registryLabelRoots);
    if (libelles.length && libelles.every((r) => contient(desc, r))) return { match: 'HEAD', specificity: 3 + autres };
    if (focus.headTerm && contient(desc, focus.headTerm)) return { match: 'HEAD', specificity: 3 + autres };
    return { match: desc.length && !fit ? 'NONE' : 'PARTIAL', specificity: 0 };
  }
  const tetes = [focus.headTerm, ...focus.topics].filter((x): x is string => !!x);
  if (tetes.length) {
    if (tetes.some((t) => contient(desc, t))) return { match: 'HEAD', specificity: 3 + autres };
    // Tête portée par le SUJET du fait (« Révision » → « Montant TTC ») : la
    // nature de la valeur doit alors répondre à la nature demandée.
    // Question de règlement (« la révision a-t-elle été réglée ? ») : le sujet suffit,
    // le contexte documentaire (preuve de paiement) est vérifié ensuite.
    const natureDemandee = (focus.valueNature && focus.valueNature !== 'STATUS' && focus.valueNature !== 'TEXT' && fit) || focus.asksSettlement;
    if (natureDemandee && tetes.some((t) => contient(sujet, t))) {
      return { match: 'CONTEXT_HEAD', specificity: 1 + autres };
    }
    if (!desc.length || focus.propertyTerms.some((t) => contient(desc, t))) return { match: 'PARTIAL', specificity: 0 };
    return { match: 'NONE', specificity: 0 };
  }
  if (focus.valueNature && focus.valueNature !== 'STATUS' && focus.valueNature !== 'TEXT') return { match: fit ? 'NATURE' : 'NONE', specificity: fit ? 0.5 : 0 };
  return { match: 'UNFILTERED', specificity: 0 };
}

/**
 * Part des termes de la demande retrouvés dans le fait (descripteur, sujet,
 * valeur, titre). Quand la propriété est ÉTABLIE par le descripteur (tête ou
 * registre), elle compte pour moitié ; les termes de contexte (objet décrit,
 * document) pour l'autre moitié — un contexte absent du fait abaisse la
 * pertinence sans l'annuler (le périmètre de l'objet est borné ailleurs).
 */
function couverture(f: FactHit, focus: QuestionFocus, match: PropertyMatch): number {
  if (!focus.propertyTerms.length) return 1;
  const tout = [...descripteur(f), f.subject, f.valueText, f.documentTitle].flatMap(racines);
  if (match === 'HEAD' || match === 'REGISTRY') {
    const contexte = focus.propertyTerms.filter((t) => !focus.headTerm || !sameRoot(t, focus.headTerm));
    return contexte.length ? 0.5 + 0.5 * (contexte.filter((t) => contient(tout, t)).length / contexte.length) : 1;
  }
  return focus.propertyTerms.filter((t) => contient(tout, t)).length / focus.propertyTerms.length;
}

/**
 * Évaluation de tous les candidats d'une question (pure, testée) : verdict
 * de chacun, sélection, versions et pluralité.
 */
export function assessFactCandidates(
  facts: readonly FactHit[],
  focus: QuestionFocus,
  ctx: { object: CandidateObject | null; requestedFacts: readonly string[] },
): AdequacyResult {
  const assessed: AssessedCandidate[] = facts.map((f) => {
    const base = validateFactCandidate(f, { object: ctx.object, requestedFacts: ctx.requestedFacts });
    const nature = factValueNature(f);
    const qualif = documentQualification(f);
    const objet = f.targetType && f.targetEntityId != null ? `${f.targetType}:${f.targetEntityId}` : f.assetId != null ? `ASSET:${f.assetId}` : 'SCOPE';
    const prop = base.sourceProperty[0] ?? plat(f.attribute ?? f.label ?? f.factKey ?? '').trim();
    const infoKey = `${prop}|${objet}|${qualif}`;
    if (base.decision === 'REJECTED') return { fact: f, verdict: base, dims: null, infoKey, date: dateUtile(f) };
    const { match, specificity } = proprieteDe(f, focus, base, nature);
    const fit = natureFits(focus.valueNature, nature);
    const periode = periodeDe(f, focus.period);
    // Valeur PRINCIPALE de la nature demandée quand la tête ne désigne pas le
    // descripteur : le total pour un montant, la fin ou le début pour une date.
    const libelle = plat([f.attribute, f.label].filter(Boolean).join(' '));
    const indirect = match === 'CONTEXT_HEAD' || match === 'NATURE';
    const role = nature === 'AMOUNT' && indirect ? amountRoleOfLabel(libelle) : null;
    const roleDate = nature === 'DATE' && indirect && focus.dateRole ? ROLE_DATE[focus.dateRole].test(libelle) : false;
    const dims: AdequacyDimensions = {
      property: match, valueNature: nature, natureFit: fit, context: qualif, period: periode, extraction: f.confidence,
      specificity: specificity + (role === 'TOTAL_PAID' || roleDate ? 0.5 : 0), coverage: couverture(f, focus, match),
    };
    const verdict = (decision: CandidateVerdict['decision'], reason: string): AssessedCandidate =>
      ({ fact: f, verdict: { ...base, decision, reason, adequacy: dims }, dims, infoKey, date: dateUtile(f) });
    if (match === 'NONE') return verdict('REJECTED', fit ? 'PROPERTY_MISMATCH' : 'VALUE_NATURE_MISMATCH');
    if (match === 'PARTIAL') return verdict(fit ? 'UNCERTAIN' : 'REJECTED', fit ? 'PROPERTY_UNCERTAIN' : 'VALUE_NATURE_MISMATCH');
    // Bonne propriété, autre nature (« quand expire » → « durée 2 ans ») : seule une
    // interprétation bornée peut relier les deux, jamais une réponse directe.
    if (!fit) return verdict('UNCERTAIN', 'VALUE_NATURE_MISMATCH');
    if (focus.asksSettlement && qualif !== 'SETTLED') return verdict('REJECTED', 'CONTEXT_MISMATCH');
    if ((focus.qualification === 'FORECAST' || focus.qualification === 'ESTIMATED') && qualif === 'SETTLED') return verdict('REJECTED', 'CONTEXT_MISMATCH');
    if (periode === 'OUT') return verdict('REJECTED', 'PERIOD_MISMATCH');
    return { fact: f, verdict: { ...base, adequacy: dims }, dims, infoKey, date: dateUtile(f) };
  });

  // ── Sélection : qualification demandée, puis spécificité ────────────────
  let admis = assessed.filter((a) => a.verdict.decision === 'KEPT');
  const voulue = preferredQualification(focus);
  if (admis.some((a) => a.dims?.context === voulue)) {
    for (const a of admis) if (a.dims && a.dims.context !== voulue) a.verdict = { ...a.verdict, decision: 'REJECTED', reason: 'OTHER_QUALIFICATION' };
    admis = admis.filter((a) => a.verdict.decision === 'KEPT');
  }
  const meilleure = Math.max(0, ...admis.map((a) => a.dims?.specificity ?? 0));
  for (const a of admis) if ((a.dims?.specificity ?? 0) < meilleure) a.verdict = { ...a.verdict, decision: 'REJECTED', reason: 'LESS_SPECIFIC' };
  admis = admis.filter((a) => a.verdict.decision === 'KEPT');

  // ── Pluralité : par information, puis par valeur ────────────────────────
  const parInfo = new Map<string, AssessedCandidate[]>();
  for (const a of admis) parInfo.set(a.infoKey, [...(parInfo.get(a.infoKey) ?? []), a]);
  const groups: PluralityGroup[] = [];
  for (const [infoKey, membres] of parInfo) {
    const parValeur = new Map<string, AssessedCandidate[]>();
    for (const a of membres) parValeur.set(comparable(a.fact), [...(parValeur.get(comparable(a.fact)) ?? []), a]);
    const valeurs = [...parValeur.values()];
    if (valeurs.length === 1) {
      groups.push({ infoKey, kind: membres.length > 1 ? 'CONCORDANT' : 'SINGLE', retained: membres.map((a) => a.fact), values: [membres[0].fact] });
      continue;
    }
    // Même information, valeurs différentes : versions successives seulement
    // si CHAQUE valeur est datée et que la plus récente l'est strictement.
    const datees = valeurs.map((v) => ({ v, d: v.map((a) => a.date).filter((x): x is string => !!x).sort().pop() ?? null }));
    const toutesDatees = datees.every((x) => x.d);
    const tri = [...datees].sort((a, b) => (b.d ?? '').localeCompare(a.d ?? ''));
    if (toutesDatees && tri[0].d! > tri[1].d!) {
      for (const x of tri.slice(1)) for (const a of x.v) a.verdict = { ...a.verdict, decision: 'REJECTED', reason: 'SUPERSEDED' };
      groups.push({ infoKey, kind: 'SUCCESSIVE_VERSIONS', retained: tri[0].v.map((a) => a.fact), values: tri.map((x) => x.v[0].fact) });
    } else {
      groups.push({ infoKey, kind: 'REAL_CONFLICT', retained: [], values: valeurs.map((v) => v[0].fact) });
    }
  }
  const selected = assessed.filter((a) => a.verdict.decision === 'KEPT').map((a) => a.fact);
  const plurality: Plurality | null = groups.length === 0 ? null : groups.length > 1 ? 'DIFFERENT_INFORMATION' : groups[0].kind;
  return { assessed, selected, uncertain: assessed.filter((a) => a.verdict.decision === 'UNCERTAIN').map((a) => a.fact), groups, plurality };
}
