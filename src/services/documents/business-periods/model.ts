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
 * l'ordre couverture → facturation → validité → garantie → prestation. Les
 * autres restent consultables (détail), jamais écrites dans les notes.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { contractualDateSource } from '@/services/business-operations/consolidation/model';
import {
  BUSINESS_PERIOD_KINDS, chronoKey, isPartialDate, orderedBounds,
  type BusinessPeriodKind, type PartialDate,
} from '@/lib/documents/business-periods';

/** Préfixe des clés de faits génériques T1 (contrat `t1-business-periods-v1`). */
export const PERIOD_FACT_PREFIX = 'period.';
export const PERIOD_FACT_KEYS: Record<string, BusinessPeriodKind> = {
  'period.coverage': 'COVERAGE',
  'period.billing': 'BILLING',
  'period.validity': 'VALIDITY',
  'period.warranty': 'WARRANTY',
  'period.service': 'SERVICE',
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
  | 'USER';

export interface PeriodEvidence {
  quote?: string | null;
  page?: number | null;
  factIds?: number[];
  candidateKeys?: string[];
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
  { start: PartialDate | null; end: PartialDate | null } | undefined {
  const brut = typeof f.normalizedValue === 'string' && f.normalizedValue.trim() ? f.normalizedValue.trim() : null;
  if (brut !== null) {
    if (brut.includes('/')) {
      const parts = brut.split('/');
      if (parts.length !== 2) return undefined;
      const [a, b] = parts.map((x) => x.trim());
      const start = a ? (isPartialDate(a) ? a : undefined) : null;
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
    if (l.some((x) => x.start === p.start && x.end === p.end)) {
      // Même période citée deux fois : une seule ligne, preuves réunies.
      const x = l.find((y) => y.start === p.start && y.end === p.end)!;
      x.evidence = mergeEvidence(x.evidence, p.evidence);
      x.principalHint = x.principalHint || p.principalHint;
    } else l.push(p);
    parNature.set(p.kind, l);
  };

  // 1. Faits de période T1 (nature et pertinence décidées par T1).
  const naturesT1 = new Set<BusinessPeriodKind>();
  for (const f of [...inp.facts].sort((a, b) => a.factId - b.factId)) {
    const kind = f.rawKey ? PERIOD_FACT_KEYS[f.rawKey.trim().toLowerCase()] : undefined;
    if (!kind || f.confidence === 'conflictual') continue;
    const v = parsePeriodValue(f);
    if (!v) continue;
    naturesT1.add(kind);
    ajouter({
      kind, start: v.start, end: v.end, principalHint: (f.attribute ?? '').trim().toLowerCase() === 'principal',
      basis: 'T1_PERIOD_FACT', evidence: { quote: f.excerpt?.slice(0, 200) ?? null, page: f.page ?? null, factIds: [f.factId] },
    });
  }

  // 2a. Couverture : dates contractuelles des candidats établis qualifiés CONTRACT (règle 86C).
  if (!naturesT1.has('COVERAGE')) {
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
        ajouter({ kind: 'COVERAGE', start, end, principalHint: false, basis: 'T1_CONTRACT_DATES', evidence: { candidateKeys: [c.candidateKey] } });
      } else if (role === 'CONTRACT_DOCUMENT') sansDate = [...sansDate, c.candidateKey];
    }
    if (!parNature.has('COVERAGE') && sansDate.length) {
      ajouter({ kind: 'COVERAGE', start: null, end: null, principalHint: false, basis: 'T1_CONTRACT_UNDATED', evidence: { candidateKeys: sansDate } });
    }
  }

  // 2b. Facturation : pièce de facturation → période facturée unique (règle de nommage existante).
  if (!naturesT1.has('BILLING')) {
    const factures = inp.candidates.filter((c) => {
      const role = obj(c.payload).sourceRoleHint;
      return c.established && c.confidence !== 'conflictual' && typeof role === 'string' && BILLING_ROLES.has(role);
    });
    const pertinente = factures.length > 0 || inp.billing.hasBillingBlock;
    const bp = inp.billing.billedPeriod;
    if (pertinente && bp && bp.source !== 'T1_FACT' && orderedBounds(bp.start, bp.end)) {
      ajouter({
        kind: 'BILLING', start: bp.start, end: bp.end, principalHint: false,
        basis: bp.source as PeriodBasis, evidence: { candidateKeys: factures.map((c) => c.candidateKey) },
      });
    } else if (pertinente && inp.billing.statedMonth && /^\d{4}-(0[1-9]|1[0-2])$/.test(inp.billing.statedMonth.value)) {
      const m = inp.billing.statedMonth.value;
      ajouter({ kind: 'BILLING', start: m, end: m, principalHint: false, basis: 'T1_STATED_MONTH', evidence: { quote: inp.billing.statedMonth.quote ?? null } });
    } else if (factures.some((c) => c.typeHint === 'CONTRACT')) {
      // Échéance d'une relation contractuelle sans période lisible : pertinente, non renseignée.
      ajouter({ kind: 'BILLING', start: null, end: null, principalHint: false, basis: 'T1_BILLING_UNDATED', evidence: { candidateKeys: factures.map((c) => c.candidateKey) } });
    }
  }

  // Une couverture et une période facturée identiques : la couverture seule (pas de doublon visible).
  const couv = parNature.get('COVERAGE') ?? [];
  const fact = parNature.get('BILLING');
  if (fact && couv.length) {
    const restantes = fact.filter((b) => !(b.start !== null && couv.some((c) => c.start === b.start && c.end === b.end)));
    if (restantes.length) parNature.set('BILLING', restantes); else parNature.delete('BILLING');
  }

  const out: DesiredPeriod[] = [];
  for (const kind of BUSINESS_PERIOD_KINDS) {
    const l = (parNature.get(kind) ?? []).slice()
      // Une période datée rend inutile une ligne « non renseignée » de la même nature.
      .filter((p, _i, all) => p.start !== null || p.end !== null || all.every((x) => x.start === null && x.end === null))
      .sort((a, b) => chronoKey(a).localeCompare(chronoKey(b)));
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
}

/** Nature principale (pure) : désignée par T1, sinon priorité de la décision 1. */
export function principalKind(periods: ReadonlyArray<Pick<StoredPeriod, 'kind' | 'principalHint'>>): BusinessPeriodKind | null {
  const designee = periods.find((p) => p.principalHint);
  if (designee) return designee.kind;
  for (const k of BUSINESS_PERIOD_KINDS) if (periods.some((p) => p.kind === k)) return k;
  return null;
}

/** Empreinte comparable d'un fait (idempotence de la reprise). */
export const periodSignature = (p: Pick<DesiredPeriod, 'kind' | 'segment' | 'start' | 'end' | 'principalHint' | 'evidence'> & { basis: string }): string =>
  JSON.stringify([p.kind, p.segment, p.start, p.end, p.principalHint, p.basis, normalizeEvidence(p.evidence)]);

function normalizeEvidence(e: PeriodEvidence): PeriodEvidence {
  return {
    quote: e.quote ?? null, page: e.page ?? null,
    factIds: [...(e.factIds ?? [])].sort((a, b) => a - b),
    candidateKeys: [...(e.candidateKeys ?? [])].sort(),
  };
}

/**
 * Plan de mise à jour (pure) : les natures CORRIGÉES par l'utilisateur
 * (au moins un fait verrouillé) lui appartiennent entièrement — aucun fait
 * automatique n'y est écrit ni retiré (décision 9). Ailleurs : faits
 * identiques conservés, autres remplacés.
 */
export function planRefresh(stored: readonly StoredPeriod[], desired: readonly DesiredPeriod[]): {
  keep: number[]; supersede: number[]; insert: DesiredPeriod[];
} {
  const verrouillees = new Set(stored.filter((s) => s.userLocked).map((s) => s.kind));
  const auto = stored.filter((s) => !verrouillees.has(s.kind));
  const voulus = desired.filter((d) => !verrouillees.has(d.kind));
  const parSig = new Map(auto.map((s) => [periodSignature(s), s.id]));
  const keep: number[] = [];
  const insert: DesiredPeriod[] = [];
  for (const d of voulus) {
    const id = parSig.get(periodSignature(d));
    if (id !== undefined) { keep.push(id); parSig.delete(periodSignature(d)); } else insert.push(d);
  }
  return { keep, supersede: [...parSig.values()], insert };
}
