/**
 * Lot 109K (ticket « T1 couverture PDF + propagation », COR-02) — propagation
 * des ENRICHISSEMENTS d'une réparation T1 vers les candidats « événement de
 * référence » du document (fonctions PURES ; écriture : `repair-propagation.store.ts`).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * T1 EXTRAIT, T3 DÉCIDE — UNE RÉPARATION N'EST PAS UNE RÉANALYSE
 *
 * Une réparation ciblée ajoute des faits sans réécrire l'existant ; jusqu'ici
 * elle ne touchait jamais les candidats (`persist.ts`) : un montant, une date
 * ou une référence récupérés APRÈS l'analyse ne parvenaient pas à T3.
 *
 *   1. DIFF : faits réellement AJOUTÉS (ou RECTIFIANT une valeur existante)
 *      depuis la réparation, classés par incidence métier : AMOUNT, DATE,
 *      REFERENCE, PROVIDER, TARGET, NATURE, REALIZATION_PROOF. Une valeur déjà
 *      connue du document, un texte sans incidence : rien à propager.
 *   2. RÉÉVALUATION CIBLÉE, déterministe (aucun appel IA, aucun prompt) : le
 *      candidat persisté est complété SANS écraser une contribution établie
 *      (un montant, un prestataire, une date déjà présents sont conservés ;
 *      une valeur différente est tracée comme conflit, jamais substituée),
 *      puis repasse la BARRIÈRE SERVEUR existante (`gateOperationCandidates` :
 *      devis / commande = coût PRÉVU, jamais réalisé ; preuve de paiement ≠
 *      coût ; avoir = réduction ; cibles vérifiées ; devises établies).
 *      Rôle d'un montant récupéré : déduit du rôle de la SOURCE seulement
 *      (`AMOUNT_ROLE_BY_SOURCE`) ; rôle indéterminé ou plusieurs montants
 *      nouveaux : aucun indice financier (qualification laissée à la chaîne
 *      montants existante), le fait reste preuve du candidat.
 *   3. ATTRIBUTION : un seul candidat établi → il reçoit les faits ; plusieurs
 *      → seulement les faits rattachés à SES unités source ou à SA cible ;
 *      sinon aucune mutation (ambiguïté tracée).
 *   4. ÉTAT PERTINENT : empreinte du contenu métier du candidat
 *      (`candidateStateFingerprint`). Inchangée → aucune écriture, aucun
 *      signal T3 (convergence) ; changée → nouvelle version (supersession).
 *
 * Jamais d'événement de référence créé par T1, jamais de nouveau candidat
 * inventé à partir d'un fait : seuls les candidats existants sont réévalués.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'node:crypto';
import { allSignificantValues, compactIdentifier, cueIdentifiers, plat, significantValues } from '../source-units/text';
import {
  gateOperationCandidates, type AnchoredFinancialHint, type AnchoredOperationCandidate, type CandidateGateContext,
} from './prepare';
import type { T1FactWithRef, T1FinancialRole, T1SourceRole } from '../master/t1-contract';
import { currenciesNextToAmount, detectDocumentCurrency, isCurrencyEstablished, UNDETERMINED_CURRENCY } from '@/lib/document-currency';

/**
 * Devise d'un montant récupéré, ÉTABLIE sur le fait (valeur lue, extrait) —
 * mêmes règles que la barrière (lot 53D, D2) : jamais présumée ; sinon « XXX »
 * avec les devises plausibles (pure).
 */
export function factCurrency(f: Pick<PersistedFactRow, 'rawValue' | 'valueText' | 'excerpt' | 'valueUnit'>, amountMinor: number):
  Pick<AnchoredFinancialHint, 'currency' | 'currencyCandidates' | 'currencyBasis'> {
  const textes = [f.rawValue, f.valueText, f.excerpt];
  const proches = currenciesNextToAmount(textes, amountMinor);
  if (proches.length === 1) return { currency: proches[0] };
  const d = detectDocumentCurrency({ rawValue: f.rawValue ?? f.valueText, amountExcerpt: f.excerpt, transcription: null });
  if (proches.length === 0 && isCurrencyEstablished(d) && d.code) return { currency: d.code };
  if (proches.length === 0 && /^[A-Z]{3}$/.test(f.valueUnit ?? '')) return { currency: f.valueUnit as string };
  return {
    currency: UNDETERMINED_CURRENCY, currencyCandidates: [...new Set([...proches, ...d.seen, 'EUR'])].slice(0, 3),
    currencyBasis: proches.length > 1 || d.basis === 'ambiguous' ? 'AMBIGUOUS' : 'PRESUMED',
  };
}

/** Incidences métier d'un fait (ticket COR-02). */
export const REPAIR_ENRICHMENT_KINDS = ['AMOUNT', 'DATE', 'REFERENCE', 'PROVIDER', 'TARGET', 'NATURE', 'REALIZATION_PROOF'] as const;
export type RepairEnrichmentKind = (typeof REPAIR_ENRICHMENT_KINDS)[number];

/** Fait persisté (`document_facts`), sous-ensemble lu ici. */
export interface PersistedFactRow {
  id: number;
  factKey: string | null;
  canonicalKey: string | null;
  rawKey: string | null;
  label: string | null;
  attribute: string | null;
  valueText: string | null;
  valueNumber: number | null;
  valueUnit: string | null;
  rawValue: string | null;
  valueType: string | null;
  excerpt: string | null;
  page: number | null;
  evidenceOrigin: string | null;
  confidence: string | null;
  targetType: string | null;
  targetEntityId: number | null;
  targetEntityLabel: string | null;
  semanticEventType: string | null;
  semanticEventNature: string | null;
  sourceUnitIds: string[];
}

/**
 * Libellés qui désignent le prestataire / la preuve de réalisation (paramètres
 * centralisés, lecture STRUCTURELLE d'un libellé de fait — jamais un
 * fournisseur, un montant ou un document d'exemple).
 */
export const PROVIDER_CUES: readonly string[] = ['fournisseur', 'prestataire', 'entreprise', 'artisan', 'vendeur', 'emetteur', 'societe', 'raison sociale', 'installateur', 'intervenant'];
export const REALIZATION_CUES: readonly string[] = [
  'realise', 'effectue', 'execute', 'installe', 'pose le', 'date d intervention', 'date de realisation', 'date des travaux', 'fin des travaux',
  'proces verbal de reception', 'reception des travaux', 'acquitte', 'paye le', 'regle le', 'date de paiement',
];

/** Rôle d'un montant récupéré selon le rôle de la SOURCE (jamais REALIZED_COST pour un devis / une commande). */
export const AMOUNT_ROLE_BY_SOURCE: Readonly<Partial<Record<T1SourceRole, { role: T1FinancialRole; scope: AnchoredFinancialHint['amountScope'] }>>> = {
  QUOTE: { role: 'FORECAST_COST', scope: 'TOTAL' },
  ORDER: { role: 'FORECAST_COST', scope: 'TOTAL' },
  INVOICE: { role: 'REALIZED_COST', scope: 'TOTAL' },
  DEPOSIT_INVOICE: { role: 'REALIZED_COST', scope: 'DEPOSIT' },
  CREDIT_NOTE: { role: 'REDUCTION', scope: 'TOTAL' },
  PAYMENT_PROOF: { role: 'PAYMENT', scope: 'TOTAL' },
  REFUND_PROOF: { role: 'REFUND', scope: 'TOTAL' },
};

/** Référence métier selon le rôle de la source. */
const REFERENCE_KIND_BY_SOURCE: Readonly<Partial<Record<T1SourceRole, string>>> = {
  QUOTE: 'QUOTE', ORDER: 'ORDER', INVOICE: 'INVOICE', DEPOSIT_INVOICE: 'INVOICE', CREDIT_NOTE: 'INVOICE',
  CONTRACT_DOCUMENT: 'CONTRACT', CLAIM_DOCUMENT: 'CLAIM',
};

const contient = (texte: string, cues: readonly string[]) => {
  const t = ` ${texte.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  return cues.some((c) => t.includes(` ${c} `) || t.includes(` ${c}`));
};
const libelle = (f: PersistedFactRow) => [f.label, f.rawKey, f.attribute, f.factKey, f.canonicalKey].filter(Boolean).join(' ');
const valeur = (f: PersistedFactRow) => f.rawValue ?? f.valueText ?? (f.valueNumber === null ? null : String(f.valueNumber));

/** Montant d'un fait en centimes (devise écrite, ou type monétaire déclaré), sinon null (pure). */
export function factAmountMinor(f: PersistedFactRow): number | null {
  const lus = significantValues(valeur(f)).filter((v) => v.kind === 'AMOUNT');
  if (lus.length === 1) return Number(lus[0].normalized);
  if (lus.length > 1) return null;
  const type = (f.valueType ?? '').toLowerCase();
  const unite = (f.valueUnit ?? '').toLowerCase();
  if (f.valueNumber !== null && Number.isFinite(f.valueNumber)) {
    if (type === 'money_cents' || unite === 'cents') return Number.isSafeInteger(f.valueNumber) && f.valueNumber > 0 ? f.valueNumber : null;
    if (type === 'money_eur' || type === 'amount' || unite === 'eur') {
      const c = Math.round(f.valueNumber * 100);
      return Math.abs(c - f.valueNumber * 100) < 1e-6 && c > 0 ? c : null;
    }
  }
  return null;
}

/** Date ISO portée par un fait, sinon null (pure). */
export function factDate(f: PersistedFactRow): string | null {
  const v = valeur(f);
  if (v && /^\d{4}-\d{2}-\d{2}$/.test(v.trim())) return v.trim();
  const d = significantValues(v).filter((x) => x.kind === 'DATE');
  return d.length === 1 ? d[0].normalized : null;
}

/** Référence (identifiant désigné par son libellé) portée par un fait, sinon null (pure). */
export function factReference(f: PersistedFactRow): string | null {
  const v = valeur(f);
  if (!v) return null;
  const designe = cueIdentifiers(`${libelle(f)} : ${v}`);
  if (designe.length === 1) return designe[0].normalized;
  if (/(^|[^\p{L}])(num[ée]ro|r[ée]f[ée]rence|r[ée]f\.?|n[°o])([^\p{L}]|$)/iu.test(libelle(f))) {
    const ids = allSignificantValues(v).filter((x) => x.kind === 'IDENTIFIER');
    if (ids.length === 1) return ids[0].normalized;
    const c = compactIdentifier(v);
    if (/^[A-Z0-9]{6,40}$/.test(c) && /\d/.test(c)) return c;
  }
  return null;
}

/** Incidences métier d'un fait (pure, déterministe). */
export function classifyFact(f: PersistedFactRow): RepairEnrichmentKind[] {
  const k = new Set<RepairEnrichmentKind>();
  const lib = libelle(f);
  if (factAmountMinor(f) !== null) k.add('AMOUNT');
  if (f.valueType === 'date' || factDate(f) !== null) k.add('DATE');
  if (factReference(f) !== null) k.add('REFERENCE');
  if (f.targetType === 'SUPPLIER' || f.canonicalKey === 'supplier' || (contient(lib, PROVIDER_CUES) && !!valeur(f) && factAmountMinor(f) === null)) k.add('PROVIDER');
  if ((f.targetType === 'ASSET' || f.targetType === 'EQUIPMENT' || f.targetType === 'ROOM') && f.targetEntityId !== null) k.add('TARGET');
  if (f.semanticEventType) k.add('NATURE');
  if (f.semanticEventNature === 'HISTORICAL' || contient(lib, REALIZATION_CUES)) k.add('REALIZATION_PROOF');
  return REPAIR_ENRICHMENT_KINDS.filter((x) => k.has(x));
}

/** Valeur métier comparable d'un fait pour une incidence (déjà connue ?). */
function knownValue(f: PersistedFactRow, kind: RepairEnrichmentKind): string | null {
  switch (kind) {
    case 'AMOUNT': { const a = factAmountMinor(f); return a === null ? null : String(a); }
    case 'DATE': return factDate(f);
    case 'REFERENCE': return factReference(f);
    case 'PROVIDER': { const v = plat(f.targetEntityLabel ?? valeur(f) ?? ''); return v || null; }
    case 'TARGET': return f.targetEntityId === null ? null : `${f.targetType}:${f.targetEntityId}`;
    case 'NATURE': return f.semanticEventType ? `${f.semanticEventType}:${f.semanticEventNature ?? ''}` : null;
    case 'REALIZATION_PROOF': return `${plat(libelle(f))}:${factDate(f) ?? plat(valeur(f) ?? '')}`;
  }
}

export interface ClassifiedRepairFact {
  fact: PersistedFactRow;
  /** Empreinte d'ancrage (analyse en cours : `t1FactRef`) ; absente : fait persisté (`db:<id>`). */
  ref?: string;
  kinds: RepairEnrichmentKind[];
  /** Le fait rectifie une valeur existante de même clé (l'existant n'est jamais réécrit). */
  rectifies: boolean;
}

export interface RepairFactsDiff {
  added: ClassifiedRepairFact[];
  /** Faits nouveaux porteurs d'une incidence métier NOUVELLE pour le document. */
  significant: ClassifiedRepairFact[];
  /** Catégories significatives (union). */
  categories: RepairEnrichmentKind[];
}

/**
 * Diff avant / après une réparation (pure) : faits AJOUTÉS (absents avant),
 * leurs incidences, et celles qui apportent une valeur NOUVELLE au document
 * (un montant, une date, une référence déjà lus ailleurs ne changent rien).
 */
export function diffRepairFacts(before: readonly PersistedFactRow[], after: readonly PersistedFactRow[]): RepairFactsDiff {
  const avant = new Set(before.map((f) => f.id));
  const ajoutes = after.filter((f) => !avant.has(f.id));
  const connus = new Map<RepairEnrichmentKind, Set<string>>();
  const cle = (f: PersistedFactRow) => f.canonicalKey ?? plat(libelle(f));
  const valeursParCle = new Map<string, Set<string>>();
  for (const f of before) {
    for (const k of classifyFact(f)) {
      const v = knownValue(f, k);
      if (v !== null) (connus.get(k) ?? connus.set(k, new Set()).get(k)!).add(v);
    }
    (valeursParCle.get(cle(f)) ?? valeursParCle.set(cle(f), new Set()).get(cle(f))!).add(plat(valeur(f) ?? ''));
  }
  const added: ClassifiedRepairFact[] = ajoutes.map((fact) => {
    const vus = valeursParCle.get(cle(fact));
    return { fact, kinds: classifyFact(fact), rectifies: !!vus && vus.size > 0 && !vus.has(plat(valeur(fact) ?? '')) };
  });
  const significant: ClassifiedRepairFact[] = [];
  const categories = new Set<RepairEnrichmentKind>();
  for (const a of added) {
    const nouvelles = a.kinds.filter((k) => {
      const v = knownValue(a.fact, k);
      return v === null || !(connus.get(k)?.has(v));
    });
    if (nouvelles.length === 0) continue;
    significant.push({ ...a, kinds: nouvelles });
    for (const k of nouvelles) categories.add(k);
  }
  return { added, significant, categories: REPAIR_ENRICHMENT_KINDS.filter((k) => categories.has(k)) };
}

/** Candidat ACTIF persisté (`document_operation_candidates`), sous-ensemble lu ici. */
export interface StoredCandidateRow {
  id: number;
  candidateKey: string;
  established: boolean;
  confidence: AnchoredOperationCandidate['confidence'];
  typeHint: AnchoredOperationCandidate['typeHint'];
  statusHint: AnchoredOperationCandidate['statusHint'];
  summary: string;
  payload: Record<string, unknown>;
}

type Anchor = { factId: number | null; fingerprint: string; sourceUnitIds: string[] };
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const anchorsOf = (p: Record<string, unknown>): Anchor[] => (Array.isArray(p.evidence) ? p.evidence : []).filter(isObj).map((e) => ({
  factId: typeof e.factId === 'number' ? e.factId : null,
  fingerprint: typeof e.fingerprint === 'string' ? e.fingerprint : `db:${String(e.factId)}`,
  sourceUnitIds: Array.isArray(e.sourceUnitIds) ? e.sourceUnitIds.map(String) : [],
}));

/** Empreinte d'ancre d'un fait persisté ajouté par une réparation (stable, sans index de sortie modèle). */
export const repairFactRef = (factId: number) => `db:${factId}`;

/** Candidat persisté → forme ancrée (pure). `anchors` : empreinte → ancre persistée. */
export function storedToAnchored(c: StoredCandidateRow): { candidate: AnchoredOperationCandidate; anchors: Map<string, Anchor> } {
  const p = c.payload ?? {};
  const anchors = new Map<string, Anchor>();
  for (const a of anchorsOf(p)) anchors.set(a.fingerprint, a);
  const hints = (Array.isArray(p.financialHints) ? p.financialHints : []).filter(isObj).map((h): AnchoredFinancialHint => {
    const ev = isObj(h.evidence) ? h.evidence : {};
    const ref = typeof ev.fingerprint === 'string' ? ev.fingerprint : `db:${String(ev.factId)}`;
    if (!anchors.has(ref)) anchors.set(ref, { factId: typeof ev.factId === 'number' ? ev.factId : null, fingerprint: ref, sourceUnitIds: Array.isArray(ev.sourceUnitIds) ? ev.sourceUnitIds.map(String) : [] });
    return {
      role: h.role as T1FinancialRole, amountMinor: Number(h.amountMinor), currency: String(h.currency ?? 'XXX'),
      ...(typeof h.amountEurMinor === 'number' ? { amountEurMinor: h.amountEurMinor } : {}),
      ...(Array.isArray(h.currencyCandidates) ? { currencyCandidates: h.currencyCandidates.map(String) } : {}),
      ...(typeof h.currencyBasis === 'string' ? { currencyBasis: h.currencyBasis as AnchoredFinancialHint['currencyBasis'] } : {}),
      amountScope: (h.amountScope ?? null) as AnchoredFinancialHint['amountScope'],
      economicDate: (h.economicDate as string | null) ?? null, periodStart: (h.periodStart as string | null) ?? null, periodEnd: (h.periodEnd as string | null) ?? null,
      factRef: ref,
    };
  });
  const temporal = isObj(p.temporalHints) ? p.temporalHints as AnchoredOperationCandidate['temporalHints'] : {};
  return {
    anchors,
    candidate: {
      candidateKey: c.candidateKey, established: c.established, confidence: c.confidence, typeHint: c.typeHint ?? null, statusHint: c.statusHint ?? null,
      summary: c.summary, sourceRoleHint: (p.sourceRoleHint as T1SourceRole | null) ?? null, provider: (p.provider as string | null) ?? null,
      targetHints: (Array.isArray(p.targetHints) ? p.targetHints : []).filter(isObj).map((t) => ({
        type: t.type as 'ASSET' | 'EQUIPMENT' | 'ROOM', entityId: typeof t.entityId === 'number' ? t.entityId : null,
        rawLabel: (t.rawLabel as string | null) ?? null, confidence: (t.confidence as AnchoredOperationCandidate['confidence']) ?? 'probable',
      })),
      businessReferences: (Array.isArray(p.businessReferences) ? p.businessReferences : []).filter(isObj).map((r) => ({ kind: String(r.kind), value: String(r.value) })),
      temporalHints: { ...temporal },
      financialHints: hints,
      evidenceFactRefs: anchorsOf(p).map((a) => a.fingerprint),
      visualOnlyEvidence: false,
      exclusionReason: (p.exclusionReason as AnchoredOperationCandidate['exclusionReason']) ?? null,
      origin: (p.origin as AnchoredOperationCandidate['origin']) ?? 'PASS_1',
      adjustments: Array.isArray(p.adjustments) ? p.adjustments.map(String) : [],
    },
  };
}

/** Contenu métier comparable d'un candidat → empreinte (pure). Mêmes faits, même état : même empreinte. */
export function candidateStateFingerprint(c: AnchoredOperationCandidate, anchors: ReadonlyMap<string, Anchor>): string {
  const factId = (ref: string) => anchors.get(ref)?.factId ?? ref;
  const etat = {
    e: c.established, c: c.confidence, t: c.typeHint, s: c.statusHint, r: c.sourceRoleHint, x: c.exclusionReason,
    p: c.provider ? plat(c.provider) : null,
    g: c.targetHints.map((t) => `${t.type}:${t.entityId ?? plat(t.rawLabel ?? '')}:${t.confidence}`).sort(),
    b: c.businessReferences.map((r) => `${r.kind}:${compactIdentifier(r.value)}`).sort(),
    d: Object.entries(c.temporalHints).filter(([, v]) => !!v).map(([k, v]) => `${k}=${v}`).sort(),
    f: c.financialHints.map((h) => `${h.role}:${h.amountMinor}:${h.currency}:${h.amountScope ?? ''}:${h.economicDate ?? ''}:${String(factId(h.factRef))}`).sort(),
    v: [...new Set(c.evidenceFactRefs.map((r) => String(factId(r))))].sort(),
  };
  return createHash('sha256').update(JSON.stringify(etat)).digest('hex').slice(0, 32);
}

export interface CandidateReevaluation {
  candidateKey: string;
  /** Candidat réévalué (après barrière), ou null si la barrière l'écarte (aucune mutation). */
  candidate: AnchoredOperationCandidate | null;
  anchors: Map<string, Anchor>;
  before: string;
  after: string | null;
  /** Mutations appliquées et contributions conservées (codes stables). */
  changes: string[];
  /** Faits rattachés à ce candidat. */
  factIds: number[];
}

/**
 * Faits nouveaux d'UN candidat (pure) : tous s'il est le seul établi ;
 * sinon ceux rattachés à ses unités source ou à sa cible.
 */
export function attributeFacts(candidates: readonly StoredCandidateRow[], facts: readonly ClassifiedRepairFact[]): Map<string, ClassifiedRepairFact[]> {
  const etablis = candidates.filter((c) => c.established);
  const out = new Map<string, ClassifiedRepairFact[]>();
  if (etablis.length === 1) { out.set(etablis[0].candidateKey, [...facts]); return out; }
  for (const c of etablis) {
    const { candidate, anchors } = storedToAnchored(c);
    const unites = new Set([...anchors.values()].flatMap((a) => a.sourceUnitIds.map((u) => u.replace(/:cell:\d+$/, ''))));
    const cibles = new Set(candidate.targetHints.filter((t) => t.entityId !== null).map((t) => `${t.type}:${t.entityId}`));
    const siens = facts.filter((f) => f.fact.sourceUnitIds.some((u) => unites.has(u.replace(/:cell:\d+$/, '')))
      || (f.fact.targetEntityId !== null && cibles.has(`${f.fact.targetType}:${f.fact.targetEntityId}`)));
    if (siens.length) out.set(c.candidateKey, siens);
  }
  return out;
}

/**
 * Réévaluation CIBLÉE d'un candidat avec les faits nouveaux qui lui sont
 * attribués (pure ; voir l'en-tête). `gate` : contexte de la barrière serveur
 * (identifiants vérifiés, type documentaire, nature du justificatif).
 */
export function reevaluateCandidate(
  stored: StoredCandidateRow, facts: readonly ClassifiedRepairFact[],
  gate: Omit<CandidateGateContext, 'keptFactRefs' | 'hasExploitableContent'>,
): CandidateReevaluation {
  const { candidate: c0, anchors } = storedToAnchored(stored);
  const before = candidateStateFingerprint(c0, anchors);
  const c: AnchoredOperationCandidate = {
    ...c0, adjustments: [...c0.adjustments], evidenceFactRefs: [...c0.evidenceFactRefs],
    financialHints: c0.financialHints.map((h) => ({ ...h })), targetHints: c0.targetHints.map((t) => ({ ...t })),
    businessReferences: c0.businessReferences.map((r) => ({ ...r })), temporalHints: { ...c0.temporalHints },
  };
  const changes: string[] = [];
  const role = c.sourceRoleHint;
  const montants = facts.filter((f) => f.kinds.includes('AMOUNT'));
  const principal = (h: AnchoredFinancialHint) => (h.amountScope === null || h.amountScope === 'TOTAL');
  for (const f of facts) {
    const ref = f.ref ?? repairFactRef(f.fact.id);
    if (!anchors.has(ref)) anchors.set(ref, { factId: f.ref ? null : f.fact.id, fingerprint: ref, sourceUnitIds: f.fact.sourceUnitIds });
    if (!c.evidenceFactRefs.includes(ref)) { c.evidenceFactRefs.push(ref); changes.push(`EVIDENCE_ADDED:${f.fact.id}`); }
    const date = factDate(f.fact);
    for (const k of f.kinds) {
      if (k === 'AMOUNT') {
        const cents = factAmountMinor(f.fact);
        const regle = role ? AMOUNT_ROLE_BY_SOURCE[role] : undefined;
        if (cents === null) continue;
        if (!regle) { changes.push('AMOUNT_ROLE_UNDETERMINED'); continue; }
        if (montants.length > 1) { changes.push('AMOUNT_AMBIGUOUS'); continue; }
        const existant = c.financialHints.find((h) => h.role === regle.role && principal(h) === (regle.scope === 'TOTAL'));
        if (existant) {
          changes.push(existant.amountMinor === cents ? 'AMOUNT_ALREADY_PRESENT' : 'AMOUNT_CONFLICT_KEPT');
          continue;
        }
        c.financialHints.push({
          role: regle.role, amountMinor: cents, ...factCurrency(f.fact, cents), amountScope: regle.scope,
          economicDate: null, periodStart: null, periodEnd: null, factRef: ref,
        });
        changes.push(`FINANCIAL_HINT_ADDED:${regle.role}`);
      } else if (k === 'REFERENCE') {
        const v = factReference(f.fact);
        if (!v) continue;
        if (c.businessReferences.some((r) => compactIdentifier(r.value) === v)) { changes.push('REFERENCE_ALREADY_PRESENT'); continue; }
        c.businessReferences.push({ kind: (role && REFERENCE_KIND_BY_SOURCE[role]) ?? 'OTHER', value: v });
        changes.push('REFERENCE_ADDED');
      } else if (k === 'PROVIDER') {
        const v = (f.fact.targetEntityLabel ?? valeur(f.fact) ?? '').trim().slice(0, 200);
        if (!v) continue;
        if (!c.provider) { c.provider = v; changes.push('PROVIDER_ADDED'); } else if (plat(c.provider) !== plat(v)) changes.push('PROVIDER_CONFLICT_KEPT');
      } else if (k === 'TARGET') {
        const type = f.fact.targetType as 'ASSET' | 'EQUIPMENT' | 'ROOM';
        if (c.targetHints.some((t) => t.type === type && t.entityId === f.fact.targetEntityId)) continue;
        c.targetHints.push({ type, entityId: f.fact.targetEntityId, rawLabel: f.fact.targetEntityLabel, confidence: f.fact.confidence === 'certain' ? 'certain' : 'probable' });
        changes.push(`TARGET_ADDED:${type}`);
      } else if (k === 'REALIZATION_PROOF') {
        // Un devis / une commande ne devient JAMAIS réalisé par une réparation : la preuve est jointe, T3 décide.
        if (role === 'QUOTE' || role === 'ORDER') { changes.push('REALIZATION_PROOF_ON_FORECAST_SOURCE'); continue; }
        if (date && !c.temporalHints.realizedDate) { c.temporalHints.realizedDate = date; changes.push('REALIZED_DATE_ADDED'); }
      } else if (k === 'DATE') {
        if (f.kinds.includes('REALIZATION_PROOF')) continue;
        if (date && f.fact.semanticEventNature === 'DEADLINE' && !c.temporalHints.plannedDate) { c.temporalHints.plannedDate = date; changes.push('PLANNED_DATE_ADDED'); }
        else changes.push('DATE_EVIDENCE_ONLY');
      } else if (k === 'NATURE') {
        changes.push('NATURE_EVIDENCE_ONLY');
      }
    }
  }
  // Barrière serveur EXISTANTE (règles fermées) : rôles, devises, cibles, preuves.
  const kept = new Set([...c.evidenceFactRefs, ...c.financialHints.map((h) => h.factRef)]);
  const passe = gateOperationCandidates([c], { ...gate, hasExploitableContent: true, keptFactRefs: kept });
  const apres = passe.candidates[0] ?? null;
  if (apres) for (const a of apres.adjustments) if (!c0.adjustments.includes(a)) changes.push(`GATE:${a}`);
  return {
    candidateKey: stored.candidateKey, candidate: apres, anchors, before,
    after: apres ? candidateStateFingerprint(apres, anchors) : null,
    changes: [...new Set(changes)], factIds: facts.map((f) => f.fact.id),
  };
}

/** Payload persisté d'une nouvelle version (pure) : même forme que `candidatePayload`, ancres conservées. */
export function reevaluatedPayload(previous: Record<string, unknown>, r: CandidateReevaluation, meta: Record<string, unknown>): Record<string, unknown> {
  const c = r.candidate!;
  const anchor = (ref: string) => r.anchors.get(ref) ?? { factId: null, fingerprint: ref, sourceUnitIds: [] };
  const evidence = [...new Set(c.evidenceFactRefs)].map(anchor);
  return {
    ...previous,
    sourceRoleHint: c.sourceRoleHint,
    provider: c.provider,
    targetHints: c.targetHints,
    businessReferences: c.businessReferences,
    temporalHints: c.temporalHints,
    financialHints: c.financialHints.map(({ factRef, ...h }) => ({ ...h, evidence: anchor(factRef) })),
    evidence,
    evidenceFactIds: evidence.flatMap((e) => (e.factId !== null ? [e.factId] : [])),
    unresolvedEvidence: evidence.filter((e) => e.factId === null).length,
    exclusionReason: c.exclusionReason,
    adjustments: c.adjustments,
    repairPropagation: { ...meta, changes: r.changes, newFactIds: r.factIds, stateFingerprint: r.after, previousStateFingerprint: r.before },
  };
}

// ── Réparation PENDANT l'analyse (complete-extraction) : avant la persistance ──

/** Fait du contrat T1 → forme comparable (pure). Cible retenue seulement si VÉRIFIÉE (U9). */
export function t1FactRow(f: T1FactWithRef, id: number, verified?: CandidateGateContext['verifiedIds']): PersistedFactRow {
  const s = (v: unknown) => (v === null || v === undefined ? null : String(v));
  const t = f.target?.type ?? null;
  const cible = (t === 'ASSET' || t === 'EQUIPMENT' || t === 'ROOM') && f.target.entityId !== null && verified?.[t].has(f.target.entityId) ? f.target.entityId : null;
  return {
    id, factKey: s(f.rawKey ?? f.label), canonicalKey: f.canonicalKey ?? null, rawKey: s(f.rawKey), label: s(f.label), attribute: s(f.attribute),
    valueText: s(f.normalizedValue), valueNumber: typeof f.normalizedValue === 'number' ? f.normalizedValue : null, valueUnit: s(f.canonicalUnit),
    rawValue: s(f.rawValue), valueType: s(f.valueType), excerpt: s(f.evidence?.excerpt), page: f.evidence?.page ?? null, evidenceOrigin: f.provenance,
    confidence: f.confidence, targetType: t, targetEntityId: cible, targetEntityLabel: s(f.target?.rawLabel),
    semanticEventType: s(f.semanticEvent?.type), semanticEventNature: s(f.semanticEvent?.nature), sourceUnitIds: [],
  };
}

/** Candidat ancré (analyse en cours) → forme persistée équivalente (pure), pour la même réévaluation. */
function anchoredToStored(c: AnchoredOperationCandidate, i: number): StoredCandidateRow {
  return {
    id: -(i + 1), candidateKey: c.candidateKey, established: c.established, confidence: c.confidence, typeHint: c.typeHint, statusHint: c.statusHint, summary: c.summary,
    payload: {
      sourceRoleHint: c.sourceRoleHint, provider: c.provider, targetHints: c.targetHints, businessReferences: c.businessReferences, temporalHints: c.temporalHints,
      financialHints: c.financialHints.map(({ factRef, ...h }) => ({ ...h, evidence: { factId: null, fingerprint: factRef, sourceUnitIds: [] } })),
      evidence: c.evidenceFactRefs.map((r) => ({ factId: null, fingerprint: r, sourceUnitIds: [] })),
      exclusionReason: c.exclusionReason, adjustments: c.adjustments, origin: c.origin,
    },
  };
}

/**
 * Lot 109K (COR-02) — faits apportés par la réparation ciblée PENDANT
 * l'analyse : même diff, même réévaluation, même barrière que la propagation
 * différée, appliqués aux candidats AVANT leur persistance (aucune version
 * intermédiaire, aucun signal T3 supplémentaire : la persistance de l'analyse
 * signale T3 une seule fois). Pure.
 */
export function enrichCandidatesWithRepairFacts(candidates: readonly AnchoredOperationCandidate[], p: {
  baseFacts: readonly T1FactWithRef[];
  repairFacts: readonly T1FactWithRef[];
  gate: Omit<CandidateGateContext, 'keptFactRefs' | 'hasExploitableContent'>;
}): { candidates: AnchoredOperationCandidate[]; report: Array<{ candidateKey: string; changes: string[] }>; categories: RepairEnrichmentKind[] } {
  if (p.repairFacts.length === 0 || candidates.length === 0) return { candidates: [...candidates], report: [], categories: [] };
  const base = p.baseFacts.map((f, i) => t1FactRow(f, i + 1, p.gate.verifiedIds));
  const rep = p.repairFacts.map((f, i) => t1FactRow(f, base.length + i + 1, p.gate.verifiedIds));
  const refs = new Map(rep.map((r, i) => [r.id, p.repairFacts[i].t1FactRef]));
  const diff = diffRepairFacts(base, [...base, ...rep]);
  const significatifs = diff.significant.flatMap((x) => (refs.get(x.fact.id) ? [{ ...x, ref: refs.get(x.fact.id)! }] : []));
  if (significatifs.length === 0) return { candidates: [...candidates], report: [], categories: diff.categories };
  const stored = candidates.map(anchoredToStored);
  const attribues = attributeFacts(stored, significatifs);
  const report: Array<{ candidateKey: string; changes: string[] }> = [];
  const out = candidates.map((c, i) => {
    const faits = attribues.get(c.candidateKey);
    if (!c.established || !faits?.length) return c;
    const r = reevaluateCandidate(stored[i], faits, p.gate);
    if (!r.candidate || r.after === r.before) return c;
    report.push({ candidateKey: c.candidateKey, changes: r.changes });
    return { ...r.candidate, origin: c.origin, visualOnlyEvidence: c.visualOnlyEvidence, adjustments: [...new Set([...r.candidate.adjustments, 'REPAIR_ENRICHED'])] };
  });
  return { candidates: out, report, categories: diff.categories };
}
