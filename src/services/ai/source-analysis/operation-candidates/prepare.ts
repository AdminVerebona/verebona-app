/**
 * Candidats Opération de T1 — ancrage, fusion et barrière serveur
 * (lot 40, CDC Opérations V1 ch. 7, B2, B3, B10, C2.1, C3, C3.1, C12.3).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * T1 EXTRAIT, T3 DÉCIDE — ET LE SERVEUR NE CROIT PAS LE MODÈLE SUR PAROLE
 *
 *   sortie d'un appel ──► ANCRAGE (index de faits → empreinte du fait)
 *        (passe 1, lot de pages)      │
 *                                     ▼
 *                         FUSION des lots (dédoublonnée, clés uniques)
 *                                     │
 *                                     ▼
 *                         BARRIÈRE SERVEUR (règles fermées, pures)
 *                                     │
 *                                     ▼
 *          persistance (`persist.ts`) : empreinte → fait PERSISTÉ
 *
 * ANCRAGE. Le modèle cite les faits par leur index dans `facts`. Cet index
 * n'est valable que dans la sortie qui l'a produit : un lot de débordement,
 * un lot de pages, un fait écarté faute de preuve ou par `hasEvidence`
 * décalent les suivants. Dès la réception (index déjà recalés par la lecture
 * tolérante), chaque fait reçoit son empreinte `factFingerprint` (marque
 * interne `t1FactRef`, portée jusqu'au fait persisté) et chaque preuve de
 * candidat est convertie en empreinte. La fusion des lots dédoublonne les
 * faits par cette même empreinte : une preuve citant un doublon désigne le
 * fait conservé.
 *
 * BARRIÈRE. Le contrat runtime transmet le tableau au modèle même quand le
 * texte actif du prompt (version BO) ne porte pas encore les consignes de
 * gating : les règles qui protègent contre la sur-création (INV-FINAL-002,
 * -015, EXH-003) sont donc appliquées ICI, indépendamment du texte :
 *   · source sans contenu exploitable → aucun candidat ;
 *   · type documentaire non métier (photo, notice, fiche technique,
 *     valorisation, garantie seule, plan) → non établi (3.2, F-004…F-007) ;
 *   · candidat établi sans preuve localisable → non établi (T1-OP-006) ;
 *   · preuves toutes visuelles → non établi (une photo n'établit rien) ;
 *   · preuve de paiement : jamais un coût (PAYMENT), jamais « certain » à
 *     elle seule (C2 : « probable seulement pour enrichir ») ;
 *   · devis / commande : coût PRÉVU seulement, jamais REALIZED ;
 *   · avoir : réduction ; facture d'acompte : portée DEPOSIT ;
 *   · indice financier sans fait localisable → retiré (T1-OP-004) ;
 *   · cible : identifiant non vérifié en base → null (U9) ; pièce /
 *     équipement hors capacités du compte → retirée (U7) ;
 *   · non établi sans motif → omis (T1-OP-002) ; au plus 20 (T1-OP-008).
 * Chaque correction est tracée (`adjustments`) dans le payload persisté.
 *
 * Les passes de RÉPARATION ciblée (lot 34F) ne produisent pas de candidats :
 * elles complètent des faits manquants, pas l'interprétation métier.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { factFingerprint } from '../source-units/merge';
import { plat } from '../source-units/text';
import {
  T1_MAX_OPERATION_CANDIDATES,
  type T1AnalyzeDocumentOutput, type T1Confidence, type T1ExclusionReason, type T1FactWithRef,
  type T1FinancialRole, type T1OperationCandidate, type T1SourceRole,
} from '../master/t1-contract';

type Out = T1AnalyzeDocumentOutput;
export type CandidateOrigin = 'PASS_1' | 'CHUNK';

export interface AnchoredFinancialHint {
  role: T1FinancialRole;
  amountMinor: number;
  currency: string;
  amountScope: 'TOTAL' | 'DEPOSIT' | 'BALANCE' | 'INSTALLMENT' | null;
  economicDate: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  /** Empreinte du fait qui porte le montant. */
  factRef: string;
}

export interface AnchoredTargetHint {
  type: 'ASSET' | 'EQUIPMENT' | 'ROOM';
  /** Identifiant VÉRIFIÉ en base (après barrière), sinon null. */
  entityId: number | null;
  rawLabel: string | null;
  confidence: T1Confidence;
}

/** Candidat ancré : forme interne entre la réception et la persistance. */
export interface AnchoredOperationCandidate {
  candidateKey: string;
  established: boolean;
  confidence: T1Confidence;
  typeHint: T1OperationCandidate['typeHint'];
  statusHint: T1OperationCandidate['statusHint'];
  summary: string;
  sourceRoleHint: T1SourceRole | null;
  provider: string | null;
  targetHints: AnchoredTargetHint[];
  businessReferences: Array<{ kind: string; value: string }>;
  temporalHints: { plannedDate?: string; startDate?: string; realizedDate?: string; endDate?: string };
  financialHints: AnchoredFinancialHint[];
  /** Empreintes des faits qui motivent le candidat (dédoublonnées). */
  evidenceFactRefs: string[];
  /** Les preuves citées sont toutes des observations visuelles. */
  visualOnlyEvidence: boolean;
  exclusionReason: T1ExclusionReason | null;
  origin: CandidateOrigin;
  /** Corrections serveur appliquées (codes stables, diagnostic). */
  adjustments: string[];
}

/**
 * Pose l'empreinte `t1FactRef` sur chaque fait de la sortie (EN PLACE) et
 * convertit les preuves des candidats (index → empreinte). À appeler sur la
 * sortie d'UN appel, après lecture tolérante et réintégration du débordement.
 */
export function anchorOperationCandidates(out: Out, origin: CandidateOrigin): AnchoredOperationCandidate[] {
  const facts = out.facts as T1FactWithRef[];
  for (const f of facts) f.t1FactRef = factFingerprint(f);
  const refOf = (i: number): string | null => facts[i]?.t1FactRef ?? null;
  return (out.businessOperationCandidates ?? []).map((c) => {
    const refs = [...new Set(c.evidenceFactIndexes.map(refOf).filter((r): r is string => r !== null))];
    const cites = c.evidenceFactIndexes.map((i) => facts[i]).filter(Boolean);
    const financialHints = c.financialHints.flatMap((h): AnchoredFinancialHint[] => {
      const factRef = refOf(h.factIndex);
      return factRef ? [{
        role: h.role, amountMinor: h.amountMinor, currency: h.currency, amountScope: h.amountScope ?? null,
        economicDate: h.economicDate ?? null, periodStart: h.periodStart ?? null, periodEnd: h.periodEnd ?? null, factRef,
      }] : [];
    });
    const temporal: AnchoredOperationCandidate['temporalHints'] = {};
    for (const k of ['plannedDate', 'startDate', 'realizedDate', 'endDate'] as const) {
      const v = c.temporalHints?.[k];
      if (v) temporal[k] = v;
    }
    return {
      candidateKey: c.candidateKey,
      established: c.established,
      confidence: c.confidence,
      typeHint: c.typeHint ?? null,
      statusHint: c.statusHint ?? null,
      summary: c.summary,
      sourceRoleHint: c.sourceRoleHint ?? null,
      provider: c.provider?.trim() || null,
      targetHints: c.targetHints.map((t) => ({ type: t.type, entityId: t.entityId ?? null, rawLabel: t.rawLabel ?? null, confidence: t.confidence })),
      businessReferences: c.businessReferences.map((r) => ({ kind: r.kind, value: r.value })),
      temporalHints: temporal,
      financialHints,
      evidenceFactRefs: refs,
      visualOnlyEvidence: cites.length > 0 && cites.every((f) => f.provenance === 'VISUAL_ANALYSIS'),
      exclusionReason: c.exclusionReason ?? null,
      origin,
      adjustments: [],
    };
  });
}

/** Identité de contenu d'un candidat (dédoublonnage des lots de pages). */
function identity(c: AnchoredOperationCandidate): string {
  const refs = c.businessReferences.map((r) => `${r.kind}:${plat(r.value)}`).sort().join(',');
  return [c.typeHint ?? '', c.statusHint ?? '', c.sourceRoleHint ?? '', refs || plat(c.summary).slice(0, 120)].join('|');
}

/**
 * Fusionne les candidats d'un lot de pages dans ceux déjà retenus : un
 * candidat de même identité enrichit l'existant (preuves, montants), un
 * nouveau est ajouté avec une clé rendue unique. Pure.
 */
export function mergeOperationCandidates(
  base: readonly AnchoredOperationCandidate[], incoming: readonly AnchoredOperationCandidate[],
): AnchoredOperationCandidate[] {
  const out = base.map((c) => ({ ...c }));
  const cles = new Set(out.map((c) => c.candidateKey));
  for (const c of incoming) {
    const existant = out.find((x) => identity(x) === identity(c));
    if (existant) {
      existant.evidenceFactRefs = [...new Set([...existant.evidenceFactRefs, ...c.evidenceFactRefs])];
      const vus = new Set(existant.financialHints.map((h) => `${h.role}:${h.amountMinor}:${h.currency}:${h.factRef}`));
      for (const h of c.financialHints) if (!vus.has(`${h.role}:${h.amountMinor}:${h.currency}:${h.factRef}`)) existant.financialHints.push(h);
      continue;
    }
    let cle = c.candidateKey;
    for (let k = 2; cles.has(cle); k++) cle = `${c.candidateKey}~${k}`;
    cles.add(cle);
    out.push({ ...c, candidateKey: cle });
  }
  return out;
}

/**
 * Types documentaires (référentiel V2) qui n'établissent JAMAIS seuls une
 * réalité métier (3.2, B2, F-004 à F-007, F-009) : photo, vidéo, notice,
 * fiche technique, déclaration CE, plans, valorisation, garantie seule.
 */
export const NON_BUSINESS_DOCUMENT_TYPES: ReadonlySet<string> = new Set([
  'PHOTO', 'VIDEO', 'USER_MANUAL', 'TECHNICAL_SHEET', 'CE_DECLARATION', 'ASSET_REFERENCE_PLAN', 'CADASTRAL_PLAN',
  'WORKS_PLAN', 'VALUE_APPRAISAL', 'VALUE_ESTIMATE', 'WARRANTY_CERTIFICATE',
]);

const COUTS: ReadonlySet<T1FinancialRole> = new Set(['FORECAST_COST', 'REALIZED_COST']);

export interface CandidateGateContext {
  hasExploitableContent: boolean;
  /** Type documentaire V2 retenu (`documentTypeCode`), sinon null. */
  documentTypeCode: string | null;
  /** Identifiants vérifiés en base pour le compte (U9). */
  verifiedIds: { ASSET: ReadonlySet<number>; EQUIPMENT: ReadonlySet<number>; ROOM: ReadonlySet<number> };
  capabilities: { rooms: boolean; equipments: boolean };
  /** Empreintes des faits encore présents après contrôle de preuve. */
  keptFactRefs: ReadonlySet<string>;
  /**
   * Nature du justificatif établie par le serveur (lot 38, `transactionNature`) :
   * un document classé preuve de paiement l'est quel que soit le rôle proposé.
   */
  transactionNature?: 'PURCHASE' | 'PAYMENT_PROOF' | 'DEPOSIT_OR_CREDIT_NOTE';
}

export interface CandidateGateResult {
  candidates: AnchoredOperationCandidate[];
  /** Non établis sans motif, omis (T1-OP-002). */
  omitted: number;
  /** Au-delà de 20 après fusion (T1-OP-008). */
  truncated: number;
}

const exclure = (c: AnchoredOperationCandidate, reason: T1ExclusionReason, code: string) => {
  c.established = false;
  c.exclusionReason = c.exclusionReason ?? reason;
  c.adjustments.push(code);
};

/** Barrière serveur (règles fermées, voir l'en-tête). Pure ; ne modifie pas l'entrée. */
export function gateOperationCandidates(
  input: readonly AnchoredOperationCandidate[], ctx: CandidateGateContext,
): CandidateGateResult {
  if (!ctx.hasExploitableContent) return { candidates: [], omitted: input.length, truncated: 0 };
  const out: AnchoredOperationCandidate[] = [];
  let omitted = 0;
  for (const brut of input) {
    const c: AnchoredOperationCandidate = {
      ...brut,
      adjustments: [...brut.adjustments],
      financialHints: brut.financialHints.map((h) => ({ ...h })),
      targetHints: brut.targetHints.map((t) => ({ ...t })),
    };
    // Preuves : seulement des faits réellement conservés (contrôle U2).
    const avant = c.evidenceFactRefs.length;
    c.evidenceFactRefs = c.evidenceFactRefs.filter((r) => ctx.keptFactRefs.has(r));
    if (c.evidenceFactRefs.length < avant) c.adjustments.push('EVIDENCE_FACT_NOT_KEPT');
    const hints = c.financialHints.filter((h) => ctx.keptFactRefs.has(h.factRef));
    if (hints.length < c.financialHints.length) c.adjustments.push('FINANCIAL_HINT_WITHOUT_FACT');
    c.financialHints = hints;

    if (c.established && ctx.documentTypeCode && NON_BUSINESS_DOCUMENT_TYPES.has(ctx.documentTypeCode)) {
      exclure(c, 'DOCUMENT_TYPE_NOT_BUSINESS', 'NON_BUSINESS_DOCUMENT_TYPE');
    }
    if (c.established && c.evidenceFactRefs.length === 0) exclure(c, 'NO_EVIDENCE', 'NO_EVIDENCE');
    if (c.established && c.visualOnlyEvidence) exclure(c, 'VISUAL_ONLY', 'VISUAL_ONLY_EVIDENCE');

    // Rôles de source (C2.1, B10) : effet financier par défaut imposé.
    if (ctx.transactionNature === 'PAYMENT_PROOF' && c.sourceRoleHint !== 'PAYMENT_PROOF') {
      c.sourceRoleHint = 'PAYMENT_PROOF';
      c.adjustments.push('PAYMENT_PROOF_DOCUMENT_TYPE');
    }
    const role = c.sourceRoleHint;
    for (const h of c.financialHints) {
      if (role === 'PAYMENT_PROOF' && COUTS.has(h.role)) { h.role = 'PAYMENT'; c.adjustments.push('PAYMENT_PROOF_NOT_A_COST'); }
      if ((role === 'QUOTE' || role === 'ORDER') && h.role === 'REALIZED_COST') { h.role = 'FORECAST_COST'; c.adjustments.push('QUOTE_FORECAST_ONLY'); }
      if (role === 'CREDIT_NOTE' && COUTS.has(h.role)) { h.role = 'REDUCTION'; c.adjustments.push('CREDIT_NOTE_REDUCTION'); }
      if (role === 'DEPOSIT_INVOICE' && h.role === 'REALIZED_COST' && h.amountScope === null) { h.amountScope = 'DEPOSIT'; c.adjustments.push('DEPOSIT_SCOPE'); }
    }
    if (role === 'PAYMENT_PROOF' && c.confidence === 'certain') { c.confidence = 'probable'; c.adjustments.push('PAYMENT_PROOF_ENRICH_ONLY'); }
    if ((role === 'QUOTE' || role === 'ORDER') && c.statusHint === 'REALIZED') { c.statusHint = 'ENVISAGED'; c.adjustments.push('QUOTE_NOT_REALIZED'); }

    // Cibles : monde fermé (U9) et capacités du compte (U7).
    c.targetHints = c.targetHints.flatMap((t) => {
      if ((t.type === 'ROOM' && !ctx.capabilities.rooms) || (t.type === 'EQUIPMENT' && !ctx.capabilities.equipments)) {
        c.adjustments.push('TARGET_TYPE_NOT_ALLOWED');
        return [];
      }
      if (t.entityId !== null && !ctx.verifiedIds[t.type].has(t.entityId)) {
        c.adjustments.push('TARGET_UNVERIFIED');
        return [{ ...t, entityId: null }];
      }
      return [t];
    });

    if (!c.established && !c.exclusionReason) { omitted++; continue; }
    c.adjustments = [...new Set(c.adjustments)];
    out.push(c);
  }
  const truncated = Math.max(0, out.length - T1_MAX_OPERATION_CANDIDATES);
  return { candidates: out.slice(0, T1_MAX_OPERATION_CANDIDATES), omitted, truncated };
}
