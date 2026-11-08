/**
 * Lot 113AA (Trello #725, §2 C et §3 T4) — contrat T1 `t1-business-periods-v2`
 * (bloc 28 du guide du PO) : lecture PURE des sorties T1 structurées qui
 * qualifient le SENS des périodes d'un document. Aucune IA ici, aucune
 * relecture du fichier, aucun libellé, titre, type ni fournisseur : tout vient
 * des faits génériques que T1 a rendus (`document_facts`, `raw_key` `period.*`).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUE LE BLOC 28 AJOUTE AU BLOC 26 (v1)
 *
 *   · deux natures : `period.contract` (EFFET CONTRACTUEL : date d'effet,
 *     fin contractuelle — jamais une couverture) et `period.realization`
 *     (travaux / prestation réellement EXÉCUTÉS — jamais un devis) ;
 *   · une borne de fin `INDEFINITE` : durée indéterminée ÉTABLIE par le
 *     document (≠ fin inconnue, borne vide) ;
 *   · `period.relevance` : la PERTINENCE de chaque nature, décidée par T1,
 *     indépendamment de la présence des dates — `known` (pertinente, datée),
 *     `unknown` (pertinente, non datée → « non renseignée »), `not_relevant`
 *     (aucun champ), `undetermined` (aucune obligation fictive). Sa présence
 *     prouve que le document a été qualifié sous le contrat v2 ;
 *   · `period.relation` : la relation que le document DÉCLARE avec un autre
 *     (`amendment` avenant, `rectification` rectificatif / « annule et
 *     remplace », `renewal` nouvelle période, `none`) — lue par la
 *     résolution contextuelle T3 (D11, `resolution.ts`).
 *
 * Sans ces faits (bloc absent, document analysé avant le bloc) : rien n'est
 * déduit ici (`evaluated: false`) et les consommateurs gardent leur règle
 * prudente documentée (113W / 113W2 / 86C) — jamais une fausse qualification.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { BUSINESS_PERIOD_KINDS, isPartialDate, lowerBound, upperBound, type BusinessPeriodKind, type PartialDate } from '@/lib/documents/business-periods';

/** Marqueur exact du bloc 28 dans le prompt maître T1 (détection de la configuration, BO). */
export const T1_BUSINESS_PERIODS_V2_CONTRACT = 't1-business-periods-v2';
/** Étape du guide du PO (`docs/exploitation/prompts-a-appliquer-par-le-po.md`). */
export const T1_BUSINESS_PERIODS_V2_GUIDE_STEP = 28;

/**
 * Le texte du prompt maître T1 porte-t-il le contrat v2 ? (pure, recherche du marqueur — même règle
 * pour le diagnostic BO « configuration incomplète » et la recette). Le code n'en dépend pas pour
 * rester correct : sans le bloc, aucune qualification v2 n'existe et les règles prudentes s'appliquent.
 */
export function promptCarriesBusinessPeriodsV2(text: string | null | undefined): boolean {
  return typeof text === 'string' && text.includes(T1_BUSINESS_PERIODS_V2_CONTRACT);
}
export const RELEVANCE_FACT_KEY = 'period.relevance';
export const RELATION_FACT_KEY = 'period.relation';
/** Borne de fin « durée indéterminée établie ». */
export const OPEN_END_TOKEN = 'INDEFINITE';

export type PeriodRelevance = 'KNOWN' | 'UNKNOWN' | 'NOT_RELEVANT' | 'UNDETERMINED';
export type DocumentRelation = 'AMENDMENT' | 'RECTIFICATION' | 'RENEWAL';

/** Nom de nature dans les faits (`period.<nom>`). */
export const KIND_FACT_NAMES: Record<BusinessPeriodKind, string> = {
  COVERAGE: 'coverage', BILLING: 'billing', VALIDITY: 'validity', WARRANTY: 'warranty', SERVICE: 'service',
  CONTRACT: 'contract', REALIZATION: 'realization',
};
const KIND_OF_NAME = new Map(Object.entries(KIND_FACT_NAMES).map(([k, v]) => [v, k as BusinessPeriodKind]));
const RELEVANCE_VALUES: Record<string, PeriodRelevance> = {
  known: 'KNOWN', unknown: 'UNKNOWN', not_relevant: 'NOT_RELEVANT', undetermined: 'UNDETERMINED',
};
const RELATION_VALUES: Record<string, DocumentRelation | 'NONE'> = {
  amendment: 'AMENDMENT', rectification: 'RECTIFICATION', renewal: 'RENEWAL', none: 'NONE',
};

export interface QualificationFact {
  rawKey: string | null;
  normalizedValue: string | null;
  rawValue?: string | null;
  confidence: string | null;
  excerpt?: string | null;
}

const key = (f: QualificationFact) => (f.rawKey ?? '').trim().toLowerCase();
const usable = (f: QualificationFact) => f.confidence !== 'conflictual' && typeof f.normalizedValue === 'string';

/**
 * Pertinence par nature (pure) : `null` quand aucun fait `period.relevance`
 * lisible (document non qualifié sous le contrat v2). Deux faits
 * contradictoires pour une nature → `UNDETERMINED` (jamais une obligation).
 * Une nature absente du fait → `UNDETERMINED`.
 */
export function parseRelevance(facts: readonly QualificationFact[]): Map<BusinessPeriodKind, PeriodRelevance> | null {
  const lus = facts.filter((f) => key(f) === RELEVANCE_FACT_KEY && usable(f));
  if (!lus.length) return null;
  const out = new Map<BusinessPeriodKind, PeriodRelevance>();
  let lisible = false;
  for (const f of lus) {
    for (const part of String(f.normalizedValue).split(/[;,]/)) {
      const [n, v] = part.split('=').map((x) => (x ?? '').trim().toLowerCase());
      const kind = KIND_OF_NAME.get(n);
      const rel = RELEVANCE_VALUES[v];
      if (!kind || !rel) continue;
      lisible = true;
      const avant = out.get(kind);
      out.set(kind, avant && avant !== rel ? 'UNDETERMINED' : rel);
    }
  }
  if (!lisible) return null;
  for (const k of BUSINESS_PERIOD_KINDS) if (!out.has(k)) out.set(k, 'UNDETERMINED');
  return out;
}

/** Relation déclarée par le document (pure) : contradictoire ou illisible → null (jamais devinée). */
export function parseRelation(facts: readonly QualificationFact[]): { relation: DocumentRelation; quote: string | null } | null {
  const vals = facts.filter((f) => key(f) === RELATION_FACT_KEY && usable(f))
    .map((f) => ({ v: RELATION_VALUES[String(f.normalizedValue).trim().toLowerCase()], quote: (f.rawValue ?? f.excerpt ?? null)?.slice(0, 200) ?? null }))
    .filter((x) => x.v !== undefined);
  const reelles = [...new Set(vals.map((x) => x.v).filter((v): v is DocumentRelation => v !== 'NONE'))];
  if (reelles.length !== 1) return null;
  return { relation: reelles[0], quote: vals.find((x) => x.v === reelles[0])!.quote };
}

/** Fin « durée indéterminée » (pure). */
export const isOpenEndToken = (v: string | null | undefined): boolean => typeof v === 'string' && v.trim().toUpperCase() === OPEN_END_TOKEN;

/**
 * Lot 113AA (§3 T4) — QUALIFICATION DU SENS DES DATES d'un document pour la
 * consolidation T3 : une date de fin écrite n'est une fin de CONTRAT que si T1
 * l'a qualifiée comme telle (borne de fin d'un fait `period.contract`) ; une
 * fin de couverture, de facturation, de validité ou de garantie ne l'est
 * jamais. De même, une date d'effet n'est contractuelle que si elle est le
 * début d'un fait `period.contract` (aucun transfert mécanique d'une date
 * d'effet d'attestation). `evaluated: false` : document non qualifié — le
 * consolidateur garde sa règle prudente (113W2 puis 86C).
 */
export interface TermQualification {
  evaluated: boolean;
  /** Périodes contractuelles rendues par T1 (bornes partielles ; `openEnded` : durée indéterminée établie). */
  contractTerms: Array<{ start: PartialDate | null; end: PartialDate | null; openEnded: boolean }>;
}

export const NOT_EVALUATED: TermQualification = Object.freeze({ evaluated: false, contractTerms: [] }) as TermQualification;

/** Bornes d'un fait de période v1/v2 (« DÉBUT/FIN », borne vide, `INDEFINITE`) — pure ; illisible → undefined. */
export function parseTermValue(v: string | null): { start: PartialDate | null; end: PartialDate | null; openEnded: boolean } | undefined {
  const brut = (v ?? '').trim();
  if (!brut) return { start: null, end: null, openEnded: false };
  const parts = brut.includes('/') ? brut.split('/') : [brut, brut];
  if (parts.length !== 2) return undefined;
  const [a, b] = parts.map((x) => x.trim());
  const start = a ? (isPartialDate(a) ? a : undefined) : null;
  const openEnded = isOpenEndToken(b);
  const end = openEnded ? null : b ? (isPartialDate(b) ? b : undefined) : null;
  if (start === undefined || end === undefined) return undefined;
  if (start && end && lowerBound(start) > upperBound(end)) return undefined;
  return { start, end, openEnded };
}

export function termQualificationOf(facts: readonly QualificationFact[]): TermQualification {
  if (!parseRelevance(facts)) return NOT_EVALUATED;
  const contractTerms = facts.filter((f) => key(f) === 'period.contract' && usable(f))
    .map((f) => parseTermValue(f.normalizedValue))
    .filter((x): x is NonNullable<typeof x> => !!x);
  return { evaluated: true, contractTerms };
}

/** Une date du jour (AAAA-MM-JJ) correspond-elle à une borne partielle (même jour, mois ou année) ? Pure. */
export const dayMatchesBound = (day: string | null, bound: PartialDate | null): boolean =>
  !!day && !!bound && day.slice(0, bound.length) === bound;
