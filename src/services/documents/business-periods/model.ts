/**
 * Lot 113W (Trello #724) — PÉRIODES MÉTIER d'un document : règles PURES de
 * qualification depuis la connaissance T1 PERSISTÉE (aucune IA, aucune
 * relecture du fichier, aucune règle par fournisseur ni par titre).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * SOURCES, PAR ORDRE D'AUTORITÉ (pour une nature donnée)
 *
 *   1. Faits de période de T1 (contrat FACULTATIF `t1-business-periods-v1`,
 *      étape 26 du guide des prompts) : faits génériques de `rawKey`
 *      `period.coverage | period.billing | period.validity | period.warranty
 *      | period.service`, valeur « DÉBUT/FIN » en dates PARTIELLES (AAAA,
 *      AAAA-MM, AAAA-MM-JJ ; borne vide = inconnue ; « / » seul = période
 *      pertinente non datée). T1 décide de la NATURE et de la PERTINENCE :
 *      présents pour une nature, ils sont seuls retenus pour elle.
 *   2. Sans eux, lecture déterministe des données T1 déjà persistées :
 *      · COUVERTURE : candidat établi qualifié CONTRACT dont la source établit
 *        des dates CONTRACTUELLES (`contractualDateSource`, règle unique du
 *        lot 86C — jamais une pièce de facturation) : ses dates d'effet et de
 *        fin (`temporalHints.startDate / endDate`). Sans date : pertinente
 *        (« non renseignée ») seulement pour un document CONTRACTUEL
 *        (`CONTRACT_DOCUMENT`) — ailleurs la pertinence est indéterminée et
 *        rien n'est affiché (décision 3) ;
 *      · FACTURATION : pièce de facturation (rôle facture / acompte / avoir,
 *        ou bloc `billingPeriod` de T1) : période facturée UNIQUE de la
 *        règle de nommage existante (`billingBasisFrom`, lot 87D / 99C), à
 *        défaut le mois ÉCRIT sur le document (« Abonnement février 2026 »,
 *        STATED_ON_DOCUMENT) — mois seul, aucune borne inventée. Sans
 *        période sur une échéance d'un contrat : « non renseignée ».
 *      Validité, garantie et prestation : seulement par les faits T1 (1).
 *
 * Jamais : prolonger une couverture (une clause de tacite reconduction
 * n'établit aucune période — décision 5), lire une période dans le titre
 * (décision 11), faire d'une fin de facturation une fin de contrat (les dates
 * contractuelles restent celles de la consolidation T3, inchangées), présumer
 * un statut d'une date passée (décision 6).
 *
 * PÉRIODE PRINCIPALE (décision 1) : la nature désignée par T1 (attribut
 * `principal` d'un fait de période), sinon la première nature présente dans
 * l'ordre couverture → validité → garantie → prestation → facturation
 * (décision PO du 07/11/2026) puis effet contractuel → réalisation (113AA).
 * Les autres restent consultables (détail), jamais écrites dans les notes.
 *
 * LOT 113AA (Trello #725, §2 C) — contrat `t1-business-periods-v2` (bloc 28,
 * `./t1-v2`) : quand T1 a rendu la PERTINENCE des natures (`period.relevance`),
 * c'est elle qui décide, indépendamment de la présence des dates :
 *   · `not_relevant` → aucun champ, aucun repli déterministe ;
 *   · `unknown`      → « Période … : non renseignée » (corrigeable) ;
 *   · `known`        → faits T1, à défaut repli déterministe daté, à défaut
 *                      « non renseignée » ;
 *   · `undetermined` → seulement des faits ou des données datées — jamais une
 *                      obligation fictive ; la couverture n'est alors JAMAIS
 *                      tirée des dates contractuelles (effet contractuel ≠
 *                      couverture).
 * Sans ce fait (bloc absent) : comportement 113W inchangé (pertinence par le
 * rôle T1 de la pièce), documenté comme « dépend du bloc prompt ».
 * Une fin `INDEFINITE` = durée indéterminée ÉTABLIE (≠ fin inconnue).
 *
 * CARTE #766 (pré-MEP) :
 *   · E01 — une couverture et une période facturée de mêmes bornes sont DEUX faits (natures distinctes,
 *     preuves séparées) : la facturation n'est plus retirée ; la période principale reste unique
 *     (`principalKind`), l'autre est secondaire ;
 *   · E10 — deux faits d'une même nature ne sont réunis que s'ils ont les mêmes bornes ET la même
 *     modalité de fin (`samePeriodBounds`) : « fin inconnue » et « durée indéterminée » restent deux
 *     interprétations, conservées toutes les deux ;
 *   · E05 — `planRefresh` protège le FAIT corrigé (et ce qui n'en est pas prouvé distinct), plus la
 *     nature entière : un autre segment prouvé disjoint peut être ajouté, mis à jour ou retiré.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { contractualDateSource } from '@/services/business-operations/consolidation/model';
import {
  BUSINESS_PERIOD_KINDS, boundsProof, chronoKey, isPartialDate, orderedBounds, samePeriodBounds,
  type BusinessPeriodKind, type PartialDate, type PeriodBounds,
} from '@/lib/documents/business-periods';
import { isOpenEndToken, parseRelation, parseRelevance, type DocumentRelation, type PeriodRelevance } from './t1-v2';

/** Préfixe des clés de faits génériques T1 (contrat `t1-business-periods-v1`). */
export const PERIOD_FACT_PREFIX = 'period.';
export const PERIOD_FACT_KEYS: Record<string, BusinessPeriodKind> = {
  'period.coverage': 'COVERAGE',
  'period.billing': 'BILLING',
  'period.validity': 'VALIDITY',
  'period.warranty': 'WARRANTY',
  'period.service': 'SERVICE',
  // Lot 113AA (contrat t1-business-periods-v2, bloc 28).
  'period.contract': 'CONTRACT',
  'period.realization': 'REALIZATION',
};
/** Marqueur du bloc PO (documentation ; aucun code ne le lit). */
export const T1_BUSINESS_PERIODS_CONTRACT = 't1-business-periods-v1';
/** Borne du nombre de segments par nature (contrainte SQL < 50). */
export const MAX_SEGMENTS_PER_KIND = 20;

/** Rôles d'une pièce de facturation (période facturée pertinente). */
const BILLING_ROLES = new Set(['INVOICE', 'DEPOSIT_INVOICE', 'CREDIT_NOTE']);

export type PeriodBasis =
  | 'T1_PERIOD_FACT' | 'T1_CONTRACT_DATES' | 'T1_CONTRACT_UNDATED'
  | 'T1_INSTALLMENT' | 'T1_COST_PERIOD' | 'T1_BILLING_PERIOD' | 'T1_STATED_MONTH' | 'T1_BILLING_UNDATED'
  /** Lot 113AA : pertinence rendue par T1 (`period.relevance`), sans date. */
  | 'T1_RELEVANT_UNKNOWN'
  | 'USER';

export interface PeriodEvidence {
  quote?: string | null;
  page?: number | null;
  factIds?: number[];
  candidateKeys?: string[];
  /** Lot 113AA : le document a été qualifié sous le contrat v2 (pertinence rendue par T1). */
  qualified?: true;
  /** Lot 113AA : relation que le document déclare (avenant, rectificatif, renouvellement) — résolution D11. */
  relation?: DocumentRelation;
  relationQuote?: string | null;
}

/** Fait de période voulu (sortie du modèle, avant persistance). */
export interface DesiredPeriod {
  kind: BusinessPeriodKind;
  segment: number;
  start: PartialDate | null;
  end: PartialDate | null;
  principalHint: boolean;
  basis: PeriodBasis;
  evidence: PeriodEvidence;
  /** Lot 113AA : durée indéterminée ÉTABLIE (fin inexistante, ≠ fin inconnue). */
  openEnded?: boolean;
}

/** Candidat Opération ACTIF du document (`document_operation_candidates`). */
export interface PeriodCandidateInput {
  candidateKey: string;
  established: boolean;
  confidence: string;
  typeHint: string | null;
  payload: unknown;
}

/** Fait générique de période T1 persisté (`document_facts`, `raw_key` = `period.*`). */
export interface PeriodFactInput {
  factId: number;
  rawKey: string | null;
  normalizedValue: string | null;
  rawValue?: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  attribute: string | null;
  confidence: string | null;
  excerpt: string | null;
  page: number | null;
}

/** Données de facturation déjà calculées par le nommage (`billingBasisFrom` + `periodFactsOf`). */
export interface PeriodBillingInput {
  billedPeriod: { start: string; end: string; source: 'T1_INSTALLMENT' | 'T1_COST_PERIOD' | 'T1_FACT' | 'T1_BILLING_PERIOD' } | null;
  statedMonth: { value: string; quote: string | null } | null;
  /** Le run T1 de référence porte un bloc `document.billingPeriod`. */
  hasBillingBlock: boolean;
}

export interface PeriodInputs {
  candidates: readonly PeriodCandidateInput[];
  facts: readonly PeriodFactInput[];
  billing: PeriodBillingInput;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {});
const day = (v: unknown): string | null => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.slice(0, 10)) && isPartialDate(v.slice(0, 10)) ? v.slice(0, 10) : null);

/**
 * Valeur « DÉBUT/FIN » d'un fait de période (pure) : dates partielles,
 * bornes vides permises (« 2025-01-15/ », « /2026-06-30 », « / »), ou une
 * date partielle seule (« 2026-03 » : ce mois-là). Repli : `periodStart /
 * periodEnd` du fait. Illisible → undefined (fait ignoré, jamais deviné).
 */
export function parsePeriodValue(f: Pick<PeriodFactInput, 'normalizedValue' | 'rawValue' | 'periodStart' | 'periodEnd'>):
  { start: PartialDate | null; end: PartialDate | null; openEnded?: true } | undefined {
  const brut = typeof f.normalizedValue === 'string' && f.normalizedValue.trim() ? f.normalizedValue.trim() : null;
  if (brut !== null) {
    if (brut.includes('/')) {
      const parts = brut.split('/');
      if (parts.length !== 2) return undefined;
      const [a, b] = parts.map((x) => x.trim());
      const start = a ? (isPartialDate(a) ? a : undefined) : null;
      // Lot 113AA : « DÉBUT/INDEFINITE » = durée indéterminée établie (jamais une fin inventée).
      if (isOpenEndToken(b)) return start === undefined ? undefined : { start, end: null, openEnded: true };
      const end = b ? (isPartialDate(b) ? b : undefined) : null;
      if (start === undefined || end === undefined) return undefined;
      return orderedBounds(start, end) ? { start, end } : undefined;
    }
    if (isPartialDate(brut)) return precisionPair(brut);
  }
  const start = day(f.periodStart);
  const end = day(f.periodEnd);
  if (!start && !end) return brut === null ? { start: null, end: null } : undefined;
  return orderedBounds(start, end) ? { start, end } : undefined;
}
/** « 2026-03 » seul = ce mois-là ; « 2026-03-05 » seul = ce jour-là. */
const precisionPair = (v: PartialDate) => ({ start: v, end: v });

/** Périodes voulues d'un document (pure, déterministe, ordre stable). */
export function deriveDocumentPeriods(inp: PeriodInputs): DesiredPeriod[] {
  const parNature = new Map<BusinessPeriodKind, Omit<DesiredPeriod, 'segment'>[]>();
  const ajouter = (p: Omit<DesiredPeriod, 'segment'>) => {
    const l = parNature.get(p.kind) ?? [];
    // Carte #766 (E10) : même fait = mêmes bornes ET même modalité de fin (inconnue ≠ durée indéterminée).
    const x = l.find((y) => samePeriodBounds(y, p));
    if (x) {
      // Même période citée deux fois : une seule ligne, preuves réunies.
      x.evidence = mergeEvidence(x.evidence, p.evidence);
      x.principalHint = x.principalHint || p.principalHint;
    } else l.push(p);
    parNature.set(p.kind, l);
  };

  // Lot 113AA : pertinence et relation décidées par T1 (contrat v2) ; absentes → règles 113W.
  const pertinence = parseRelevance(inp.facts);
  const rel = parseRelation(inp.facts);
  const qualif: PeriodEvidence = pertinence ? { qualified: true, ...(rel ? { relation: rel.relation, relationQuote: rel.quote } : {}) } : {};
  const rv = (k: BusinessPeriodKind): PeriodRelevance | null => pertinence?.get(k) ?? null;

  // 1. Faits de période T1 (nature et pertinence décidées par T1).
  const naturesT1 = new Set<BusinessPeriodKind>();
  for (const f of [...inp.facts].sort((a, b) => a.factId - b.factId)) {
    const kind = f.rawKey ? PERIOD_FACT_KEYS[f.rawKey.trim().toLowerCase()] : undefined;
    if (!kind || f.confidence === 'conflictual') continue;
    // Lot 113AA : une nature que T1 déclare non pertinente n'a aucun champ (cohérence de sa propre sortie).
    if (rv(kind) === 'NOT_RELEVANT') continue;
    const v = parsePeriodValue(f);
    if (!v) continue;
    naturesT1.add(kind);
    ajouter({
      kind, start: v.start, end: v.end, principalHint: (f.attribute ?? '').trim().toLowerCase() === 'principal',
      basis: 'T1_PERIOD_FACT', evidence: { quote: f.excerpt?.slice(0, 200) ?? null, page: f.page ?? null, factIds: [f.factId], ...qualif },
      ...(v.openEnded ? { openEnded: true } : {}),
    });
  }

  // 2a. Couverture : dates contractuelles des candidats établis qualifiés CONTRACT (règle 86C).
  // Lot 113AA : sous le contrat v2, seulement si T1 tient la couverture pour pertinente et connue
  // (jamais une date d'effet contractuel transformée en couverture sans ce rôle).
  const couvertureParRepli = pertinence ? rv('COVERAGE') === 'KNOWN' : true;
  if (!naturesT1.has('COVERAGE') && couvertureParRepli) {
    let sansDate: string[] = [];
    for (const c of inp.candidates) {
      if (!c.established || c.confidence === 'conflictual' || c.typeHint !== 'CONTRACT') continue;
      const p = obj(c.payload);
      const role = typeof p.sourceRoleHint === 'string' ? p.sourceRoleHint : null;
      const hints = (Array.isArray(p.financialHints) ? p.financialHints : []).map(obj);
      if (!contractualDateSource({ role: role as never, hints: hints as never })) continue;
      const t = obj(p.temporalHints);
      const start = day(t.startDate);
      const end = day(t.endDate);
      if (start || end) {
        if (!orderedBounds(start, end)) continue;
        ajouter({ kind: 'COVERAGE', start, end, principalHint: false, basis: 'T1_CONTRACT_DATES', evidence: { candidateKeys: [c.candidateKey], ...qualif } });
      } else if (role === 'CONTRACT_DOCUMENT') sansDate = [...sansDate, c.candidateKey];
    }
    // Sans pertinence T1 (113W) : pièce contractuelle sans date → « non renseignée » ; sous v2, c'est T1 qui le dit (ci-dessous).
    if (!pertinence && !parNature.has('COVERAGE') && sansDate.length) {
      ajouter({ kind: 'COVERAGE', start: null, end: null, principalHint: false, basis: 'T1_CONTRACT_UNDATED', evidence: { candidateKeys: sansDate } });
    }
  }

  // 2b. Facturation : pièce de facturation → période facturée unique (règle de nommage existante).
  if (!naturesT1.has('BILLING') && rv('BILLING') !== 'NOT_RELEVANT' && rv('BILLING') !== 'UNKNOWN') {
    const factures = inp.candidates.filter((c) => {
      const role = obj(c.payload).sourceRoleHint;
      return c.established && c.confidence !== 'conflictual' && typeof role === 'string' && BILLING_ROLES.has(role);
    });
    const pertinente = factures.length > 0 || inp.billing.hasBillingBlock || rv('BILLING') === 'KNOWN';
    const bp = inp.billing.billedPeriod;
    if (pertinente && bp && bp.source !== 'T1_FACT' && orderedBounds(bp.start, bp.end)) {
      ajouter({
        kind: 'BILLING', start: bp.start, end: bp.end, principalHint: false,
        basis: bp.source as PeriodBasis, evidence: { candidateKeys: factures.map((c) => c.candidateKey), ...qualif },
      });
    } else if (pertinente && inp.billing.statedMonth && /^\d{4}-(0[1-9]|1[0-2])$/.test(inp.billing.statedMonth.value)) {
      const m = inp.billing.statedMonth.value;
      ajouter({ kind: 'BILLING', start: m, end: m, principalHint: false, basis: 'T1_STATED_MONTH', evidence: { quote: inp.billing.statedMonth.quote ?? null, ...qualif } });
    } else if (!pertinence && factures.some((c) => c.typeHint === 'CONTRACT')) {
      // Échéance d'une relation contractuelle sans période lisible : pertinente, non renseignée.
      ajouter({ kind: 'BILLING', start: null, end: null, principalHint: false, basis: 'T1_BILLING_UNDATED', evidence: { candidateKeys: factures.map((c) => c.candidateKey) } });
    }
  }

  // 2c. Lot 113AA : nature pertinente selon T1 mais sans date (« unknown », ou « known » sans valeur lisible)
  // → une ligne « non renseignée », corrigeable. « undetermined » : aucune obligation fictive.
  if (pertinence) {
    for (const kind of BUSINESS_PERIOD_KINDS) {
      const r = rv(kind);
      if ((r === 'UNKNOWN' || r === 'KNOWN') && !parNature.has(kind)) {
        ajouter({ kind, start: null, end: null, principalHint: false, basis: 'T1_RELEVANT_UNKNOWN', evidence: { ...qualif } });
      }
    }
  }

  // Carte #766 (E01) — règle remplacée : une couverture et une période facturée de mêmes bornes restent
  // DEUX faits (natures distinctes, preuves et provenances séparées). Rien n'est retiré ici : la période
  // principale reste unique (`principalKind`), la facturation est secondaire, et la dépense comme
  // l'Assistant retrouvent le fait BILLING.

  const out: DesiredPeriod[] = [];
  for (const kind of BUSINESS_PERIOD_KINDS) {
    const l = (parNature.get(kind) ?? []).slice()
      // Une période datée rend inutile une ligne « non renseignée » de la même nature.
      .filter((p, _i, all) => p.start !== null || p.end !== null || p.openEnded || all.every((x) => x.start === null && x.end === null && !x.openEnded))
      // Carte #766 (E10) : à bornes égales, la fin inconnue précède la durée indéterminée (ordre stable).
      .sort((a, b) => chronoKey(a).localeCompare(chronoKey(b)) || Number(a.openEnded === true) - Number(b.openEnded === true));
    l.slice(0, MAX_SEGMENTS_PER_KIND).forEach((p, i) => out.push({ ...p, segment: i }));
  }
  return out;
}

function mergeEvidence(a: PeriodEvidence, b: PeriodEvidence): PeriodEvidence {
  const ids = [...new Set([...(a.factIds ?? []), ...(b.factIds ?? [])])];
  const keys = [...new Set([...(a.candidateKeys ?? []), ...(b.candidateKeys ?? [])])];
  return {
    ...(a.quote ?? b.quote ? { quote: a.quote ?? b.quote ?? null } : {}),
    ...(a.page ?? b.page ? { page: a.page ?? b.page ?? null } : {}),
    ...(ids.length ? { factIds: ids } : {}),
    ...(keys.length ? { candidateKeys: keys } : {}),
    ...(a.qualified || b.qualified ? { qualified: true as const } : {}),
    ...(a.relation ?? b.relation ? { relation: (a.relation ?? b.relation)!, relationQuote: a.relationQuote ?? b.relationQuote ?? null } : {}),
  };
}

/** Période (fait) telle qu'elle est lue en base. */
export interface StoredPeriod {
  id: number;
  kind: BusinessPeriodKind;
  segment: number;
  start: PartialDate | null;
  end: PartialDate | null;
  principalHint: boolean;
  origin: 'T1' | 'T3' | 'USER';
  basis: string;
  evidence: PeriodEvidence;
  userLocked: boolean;
  /** Lot 113AA : durée indéterminée établie (colonne `end_open`, migration 1590). */
  openEnded?: boolean;
  /**
   * Carte #766 (E05, E08) — fait corrigé par l'utilisateur : bornes du fait automatique qu'il a remplacé
   * (`before_correction`) ; null : fait saisi sans fait antérieur de cette nature.
   */
  lockedBefore?: PeriodBounds | null;
}

/** Nature principale (pure) : désignée par T1, sinon priorité de la décision 1. */
export function principalKind(periods: ReadonlyArray<Pick<StoredPeriod, 'kind' | 'principalHint'>>): BusinessPeriodKind | null {
  const designee = periods.find((p) => p.principalHint);
  if (designee) return designee.kind;
  for (const k of BUSINESS_PERIOD_KINDS) if (periods.some((p) => p.kind === k)) return k;
  return null;
}

/** Empreinte comparable d'un fait (idempotence de la reprise). */
// Lot 113AA : `openEnded` et les marques v2 n'entrent dans l'empreinte QUE lorsqu'elles sont présentes —
// les faits enregistrés avant le lot gardent exactement leur empreinte (aucune réécriture du stock).
export const periodSignature = (p: Pick<DesiredPeriod, 'kind' | 'segment' | 'start' | 'end' | 'principalHint' | 'evidence' | 'openEnded'> & { basis: string }): string =>
  JSON.stringify([p.kind, p.segment, p.start, p.end, p.principalHint, p.basis, normalizeEvidence(p.evidence), ...(p.openEnded ? ['OPEN_ENDED'] : [])]);

function normalizeEvidence(e: PeriodEvidence): PeriodEvidence {
  return {
    quote: e.quote ?? null, page: e.page ?? null,
    factIds: [...(e.factIds ?? [])].sort((a, b) => a - b),
    candidateKeys: [...(e.candidateKeys ?? [])].sort(),
    ...(e.qualified ? { qualified: true as const } : {}),
    ...(e.relation ? { relation: e.relation, relationQuote: e.relationQuote ?? null } : {}),
  };
}

/** Borne du rang d'un segment (contrainte SQL `segment_index < 50`). */
const SEGMENT_INDEX_LIMIT = 50;

/**
 * Plan de mise à jour (pure). Carte #766 (E05) — règle remplacée : ce n'est plus la NATURE entière qui
 * appartient à l'utilisateur dès qu'un fait y est corrigé, mais le FAIT corrigé et sa continuité :
 *   · un fait verrouillé n'est jamais retiré ni réécrit (décision 9) ;
 *   · un fait voulu de la même nature est ÉCARTÉ s'il n'est pas PROUVÉ disjoint du fait corrigé, de sa
 *     valeur d'avant correction (le même fait relu par T1), ou si l'une de ces étendues est inconnue
 *     (« non renseignée », borne manquante) — jamais un doublon du fait corrigé, jamais une fusion ;
 *   · un fait voulu prouvé disjoint (autre segment, autre justificatif) est ajouté, conservé ou remplacé
 *     comme partout ailleurs, sur un rang de segment laissé libre par les faits corrigés (rangs
 *     attribués dans l'ordre chronologique : déterministe, donc stable d'une reprise à l'autre).
 * Natures sans fait corrigé : faits identiques conservés, autres remplacés (inchangé).
 */
export function planRefresh(stored: readonly StoredPeriod[], desired: readonly DesiredPeriod[]): {
  keep: number[]; supersede: number[]; insert: DesiredPeriod[];
} {
  const verrous = stored.filter((s) => s.userLocked);
  const auto = stored.filter((s) => !s.userLocked);
  const distinct = (d: DesiredPeriod, b: PeriodBounds) => boundsProof(d, b).proof === 'DISJOINT';
  const protege = (d: DesiredPeriod) => verrous.some((v) => v.kind === d.kind
    && (!distinct(d, v) || (v.lockedBefore != null && !distinct(d, v.lockedBefore))));
  const reserves = new Map<BusinessPeriodKind, Set<number>>();
  for (const v of verrous) reserves.set(v.kind, (reserves.get(v.kind) ?? new Set<number>()).add(v.segment));
  const prochain = new Map<BusinessPeriodKind, number>();
  const voulus: DesiredPeriod[] = [];
  for (const d of desired) {
    if (protege(d)) continue;
    const pris = reserves.get(d.kind);
    if (!pris) { voulus.push(d); continue; }
    let rang = prochain.get(d.kind) ?? 0;
    while (pris.has(rang)) rang++;
    prochain.set(d.kind, rang + 1);
    if (rang < SEGMENT_INDEX_LIMIT) voulus.push(rang === d.segment ? d : { ...d, segment: rang });
  }
  const parSig = new Map(auto.map((s) => [periodSignature(s), s.id]));
  const keep: number[] = [];
  const insert: DesiredPeriod[] = [];
  for (const d of voulus) {
    const id = parSig.get(periodSignature(d));
    if (id !== undefined) { keep.push(id); parSig.delete(periodSignature(d)); } else insert.push(d);
  }
  return { keep, supersede: [...parSig.values()], insert };
}
