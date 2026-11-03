/**
 * Lot 107C — date de DÉPART du TCO annuel : date d'achat du bien (ticket P1
 * « TCO — Date d'achat du bien prioritaire pour le calcul annuel »). PUR,
 * sans import serveur (utilisable par le moteur, le diagnostic BO et les
 * tests).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE SOURCE, UN ORDRE DE PRIORITÉ, AUCUN CHOIX PAR ANCIENNETÉ
 *
 * Avant ce lot, `computeTco` prenait la PLUS ANCIENNE date des Opérations
 * ACQUISITION réalisées (`realizedDate ?? startDate`), et seulement à défaut
 * la date de la fiche : une acquisition mal reliée (achat d'un objet, frais,
 * acte citant une vente antérieure…) datée de 2007 l'emportait sur la date
 * d'achat confirmée par l'utilisateur. Désormais :
 *
 *   1. date d'achat CANONIQUE (`acquisitionDate` : clé, alias historique,
 *      colonne `assets.purchase_date` — `readCanonicalValue`) d'origine
 *      HUMAINE (USER / ADMIN ; valeur historique sans origine tracée = USER,
 *      règle commune `readOrigin`) : AUTORITÉ, jamais remplacée. Une
 *      Opération datée autrement est un ÉCART tracé (contradiction résolue
 *      par l'autorité de l'utilisateur), jamais la date retenue ;
 *   2. sinon, l'Opération qui EST l'achat de ce bien, sans ambiguïté :
 *      réalisée, identifiée comme l'achat DU bien par le moteur (achat
 *      consolidé du bien sur identité établie — `achatsDuBien`), ni achat
 *      d'équipement / d'accessoire / d'objet distinct, ni multibiens non
 *      attribuée — datée par sa date de RÉALISATION (jamais `startDate`,
 *      jamais une date planifiée) ;
 *   3. une date canonique AUTOMATIQUE (T1, T3, import) est retenue si
 *      aucune preuve ne la contredit ; contredite par une Opération d'achat
 *      prouvée (justificatif du prix du bien, rattachement par
 *      l'utilisateur) → la preuve l'emporte (réparation proposée, jamais sur
 *      une valeur humaine) ; contredite sans autorité décisive → date
 *      INDÉTERMINÉE ;
 *   4. plusieurs dates candidates incompatibles sans autorité → date
 *      INDÉTERMINÉE : moyenne annuelle non calculée, alerte ciblée,
 *      contradiction tracée — jamais la plus ancienne ;
 *   5. bien sans achat (LLD, LOA, prêt, don : `acquisitionExpected` faux) :
 *      aucune Opération ne fournit de date d'achat ; la date de la fiche
 *      reste le début de la POSSESSION (`kind` POSSESSION, libellé distinct).
 *
 * Chaque candidat (date de la fiche, Opérations ACQUISITION) est restitué
 * avec son statut et son motif (`candidates`) — diagnostic BO : date
 * retenue, source, candidats, rejetés, raisons, contradictions, réparation.
 * `legacyDate` : date que l'ANCIENNE règle aurait retenue (avant / après).
 * ══════════════════════════════════════════════════════════════════════════
 */

/**
 * Écart (jours) en deçà duquel deux dates décrivent le même achat (acte /
 * paiement / livraison) : même fenêtre que la consolidation T3 d'une
 * ACQUISITION (`transactionWindowDays('ACQUISITION')`, testé L107C-U-14).
 */
export const TCO_ACQUISITION_AGREEMENT_WINDOW_DAYS = 180;

/** Origines humaines (correction explicite) — même ensemble que `isHumanOrigin`. */
const HUMAN_ORIGINS: ReadonlySet<string> = new Set(['USER', 'ADMIN']);

export type AcquisitionStartStatus = 'RESOLVED' | 'MISSING' | 'UNDETERMINED' | 'REJECTED';
export type AcquisitionStartBasis = 'ASSET_USER' | 'ASSET_AUTOMATIC' | 'OPERATION';
/** Achat du bien, ou simple début de possession (location, prêt, don : aucun achat). */
export type AcquisitionStartKind = 'PURCHASE' | 'POSSESSION';

/**
 * Rôle d'une Opération ACQUISITION vis-à-vis de l'achat DU bien (calculé par
 * le moteur TCO, `model.ts`) :
 *   ASSET_PURCHASE  achat du bien identifié sans ambiguïté ;
 *   EQUIPMENT       achat d'un équipement du bien (cible, rattachement) ;
 *   OTHER_PURCHASE  autre achat (accessoire, objet distinct, frais) ou
 *                   identité non établie (montant / preuve discordants) ;
 *   MULTI_ASSET     Opération de plusieurs biens sans acquisition attribuée ;
 *   UNQUALIFIED     aucune composante ni preuve qui en fasse l'achat du bien.
 */
export type AcquisitionOperationRole = 'ASSET_PURCHASE' | 'EQUIPMENT' | 'OTHER_PURCHASE' | 'MULTI_ASSET' | 'UNQUALIFIED';

export type AcquisitionCandidateReason =
  | 'SELECTED'                 // date retenue
  | 'AGREES'                   // concorde avec la date retenue (même achat, fenêtre de l'achat)
  | 'CANONICAL_USER_PRIORITY'  // écartée : la date saisie / corrigée par l'utilisateur prime
  | 'CONTRADICTED_BY_PROOF'    // date automatique de la fiche contredite par l'achat prouvé
  | 'CONFLICTING_CANDIDATES'   // dates incompatibles sans autorité décisive
  | 'EQUIPMENT_PURCHASE'       // achat d'un équipement, jamais celui du bien
  | 'NOT_ASSET_PURCHASE'       // pas l'achat de CE bien (accessoire, objet distinct, preuve insuffisante)
  | 'MULTI_ASSET'              // plusieurs biens, acquisition non attribuée
  | 'NOT_REALIZED'             // prévue, annulée…
  | 'START_DATE_ONLY'          // seule une date de début (contrat, période) : jamais une date d'achat
  | 'NO_DATE'                  // aucune date
  | 'INVALID_DATE'             // jour inexistant ou format invalide
  | 'FUTURE_DATE'              // postérieure à la date de référence
  | 'AFTER_DISPOSAL'           // postérieure à la cession
  | 'NO_PURCHASE_EXPECTED';    // location, LLD / LOA, prêt, don : aucune date d'achat

export const ACQUISITION_CANDIDATE_REASON_LABELS: Readonly<Record<AcquisitionCandidateReason, string>> = {
  SELECTED: 'Date retenue',
  AGREES: 'Concorde avec la date retenue (même achat)',
  CANONICAL_USER_PRIORITY: 'Écartée : la date d’achat saisie ou corrigée sur la fiche prime',
  CONTRADICTED_BY_PROOF: 'Date automatique de la fiche contredite par la preuve de l’achat du bien',
  CONFLICTING_CANDIDATES: 'Dates incompatibles sans autorité décisive : aucune retenue',
  EQUIPMENT_PURCHASE: 'Achat d’un équipement : jamais la date d’achat du bien',
  NOT_ASSET_PURCHASE: 'Pas l’achat de ce bien (accessoire, objet distinct ou preuve insuffisante)',
  MULTI_ASSET: 'Commune à plusieurs biens, acquisition non attribuée',
  NOT_REALIZED: 'Non réalisée (prévue ou annulée)',
  START_DATE_ONLY: 'Seule une date de début (contrat, période) : pas une date d’achat',
  NO_DATE: 'Sans date',
  INVALID_DATE: 'Date impossible ignorée',
  FUTURE_DATE: 'Date postérieure à aujourd’hui',
  AFTER_DISPOSAL: 'Date postérieure à la cession',
  NO_PURCHASE_EXPECTED: 'Bien sans achat (location, prêt, don) : aucune date d’achat',
};

export const ACQUISITION_START_BASIS_LABELS: Readonly<Record<AcquisitionStartBasis, string>> = {
  ASSET_USER: 'Date d’achat de la fiche (saisie ou corrigée par l’utilisateur)',
  ASSET_AUTOMATIC: 'Date d’achat de la fiche (renseignée automatiquement, non contredite)',
  OPERATION: 'Date de réalisation de l’achat du bien (événement de référence)',
};

/** Date d'achat canonique lue sur la fiche (`readCanonicalValue`), brute. */
export interface CanonicalAcquisitionDateInput {
  /** Valeur brute (validation stricte ici, jamais normalisée). */
  raw: string;
  /** Origine canonique (USER, ADMIN, DOCUMENT_EXTRACTION, RECONCILIATION…) ; absente : USER (`readOrigin`). */
  origin?: string | null;
  /** Clé lue : canonique, alias historique ou colonne historique. */
  from?: 'key' | 'alias' | 'column' | null;
  fromName?: string | null;
  source?: string | null;
  updatedAt?: string | null;
  /** Dernière écriture journalisée de la clé (`canonical_field_writes`) : provenance pour le diagnostic. */
  lastWrite?: { value: string | null; origin: string; sourceType: string | null; sourceId: string | null; at: string } | null;
}

export interface AcquisitionOperationInput {
  id: number;
  label: string;
  status: string;
  realizedDate: string | null;
  startDate: string | null;
  role: AcquisitionOperationRole;
  /** Achat du bien PROUVÉ (justificatif du prix du bien, rattachement par l'utilisateur). */
  strongProof: boolean;
  /** Retenue par l'ancienne règle (`earliest()` du lot 81D) — diagnostic avant / après seulement. */
  legacyEligible: boolean;
}

export interface AcquisitionStartCandidate {
  kind: 'CANONICAL' | 'OPERATION';
  operationId: number | null;
  label: string | null;
  /** Date valide considérée (null : aucune date exploitable). */
  date: string | null;
  /** Valeur brute (date invalide, `startDate` seule…). */
  rawDate: string | null;
  dateField: 'acquisitionDate' | 'realizedDate' | 'startDate' | null;
  origin: string | null;
  from?: string | null;
  fromName?: string | null;
  role?: AcquisitionOperationRole;
  strongProof?: boolean;
  accepted: boolean;
  reason: AcquisitionCandidateReason;
}

export interface AcquisitionStartContradiction {
  code: 'OPERATION_VS_USER_DATE' | 'OPERATION_VS_AUTOMATIC_DATE' | 'OPERATIONS_DISAGREE';
  dates: string[];
  operationIds: number[];
  /** Autorité qui tranche (null : aucune — date indéterminée). */
  resolvedBy: 'USER_AUTHORITY' | 'PROOF' | null;
}

/** Réparation DÉTERMINISTE proposée (appliquée par le contrôle de cohérence, jamais ici). */
export interface AcquisitionStartRepair {
  /** ENRICH : date canonique absente ; CORRECT : date AUTOMATIQUE contredite par la preuve (jamais une valeur humaine). */
  kind: 'ENRICH_CANONICAL' | 'CORRECT_AUTOMATIC_CANONICAL';
  value: string;
  operationId: number;
  /** Valeur actuelle attendue (conflit optimiste) : null pour un enrichissement. */
  expectedCurrent: string | null;
}

export interface AcquisitionStartResolution {
  status: AcquisitionStartStatus;
  basis: AcquisitionStartBasis | null;
  kind: AcquisitionStartKind;
  /** Date retenue (null : absente, indéterminée ou rejetée). */
  date: string | null;
  /** Opération qui fonde la date (basis OPERATION). */
  operationId: number | null;
  /** Valeur brute rejetée (date de la fiche impossible). */
  rejected: string | null;
  canonical: (Omit<CanonicalAcquisitionDateInput, 'origin'> & { origin: string; human: boolean; valid: boolean }) | null;
  candidates: AcquisitionStartCandidate[];
  contradictions: AcquisitionStartContradiction[];
  /** Date que l'ancienne règle (plus ancienne ACQUISITION, sinon fiche) aurait retenue. */
  legacyDate: string | null;
  repair: AcquisitionStartRepair | null;
}

/** Jour civil réellement existant, format strict AAAA-MM-JJ (les horodatages ISO sont tronqués au jour). */
export function strictAcquisitionDay(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/.exec(v.trim());
  if (!m) return null;
  const d = `${m[1]}-${m[2]}-${m[3]}`;
  const t = Date.parse(`${d}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === d && Number(m[1]) >= 1 ? d : null;
}

const ecartJours = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
const memeAchat = (a: string, b: string) => ecartJours(a, b) <= TCO_ACQUISITION_AGREEMENT_WINDOW_DAYS;

/**
 * Résolution de la date de départ du TCO (pure, testée L107C-U-*). Voir
 * l'en-tête du module pour l'ordre de priorité.
 */
export function resolveAcquisitionStart(input: {
  today: string;
  /** Date de cession effective (Opération, sinon fiche), si cédé. */
  disposalDate: string | null;
  /** Faux : location, LLD / LOA, prêt, don (aucun achat). */
  acquisitionExpected: boolean;
  canonical: CanonicalAcquisitionDateInput | null;
  /** Opérations ACQUISITION du bien (toutes, statut compris). */
  operations: readonly AcquisitionOperationInput[];
}): AcquisitionStartResolution {
  const today = input.today.slice(0, 10);
  const kind: AcquisitionStartKind = input.acquisitionExpected ? 'PURCHASE' : 'POSSESSION';
  const c = input.canonical && typeof input.canonical.raw === 'string' && input.canonical.raw.trim() ? input.canonical : null;
  const cDate = c ? strictAcquisitionDay(c.raw) : null;
  const cOrigin = c ? String(c.origin ?? 'USER') : null;
  const cHuman = !!c && HUMAN_ORIGINS.has(cOrigin!);
  const canonical: AcquisitionStartResolution['canonical'] = c ? { ...c, origin: cOrigin!, human: cHuman, valid: !!cDate } : null;

  // ── Candidats Opérations : admissibilité propre (sans encore confronter la fiche) ──
  const ops: AcquisitionStartCandidate[] = input.operations.map((o) => {
    const realized = strictAcquisitionDay(o.realizedDate);
    const base: AcquisitionStartCandidate = {
      kind: 'OPERATION', operationId: o.id, label: o.label, date: realized,
      rawDate: o.realizedDate ?? o.startDate ?? null, dateField: o.realizedDate ? 'realizedDate' : o.startDate ? 'startDate' : null,
      origin: null, role: o.role, strongProof: o.strongProof, accepted: false, reason: 'SELECTED',
    };
    const rejet = (reason: AcquisitionCandidateReason): AcquisitionStartCandidate => ({ ...base, reason });
    if (o.status !== 'REALIZED') return rejet('NOT_REALIZED');
    if (!input.acquisitionExpected) return rejet('NO_PURCHASE_EXPECTED');
    if (o.role === 'EQUIPMENT') return rejet('EQUIPMENT_PURCHASE');
    if (o.role === 'MULTI_ASSET') return rejet('MULTI_ASSET');
    if (o.role !== 'ASSET_PURCHASE') return rejet('NOT_ASSET_PURCHASE');
    if (!o.realizedDate) return rejet(o.startDate ? 'START_DATE_ONLY' : 'NO_DATE');
    if (!realized) return rejet('INVALID_DATE');
    if (realized > today) return rejet('FUTURE_DATE');
    if (input.disposalDate && realized > input.disposalDate) return rejet('AFTER_DISPOSAL');
    return { ...base, accepted: true };
  });
  const admissibles = ops.filter((x) => x.accepted);
  const datesOps = [...new Set(admissibles.map((x) => x.date!))].sort();
  const canonCand = (accepted: boolean, reason: AcquisitionCandidateReason): AcquisitionStartCandidate | null => (c ? {
    kind: 'CANONICAL', operationId: null, label: 'Date d’achat de la fiche', date: cDate, rawDate: c.raw, dateField: 'acquisitionDate',
    origin: cOrigin, from: c.from ?? null, fromName: c.fromName ?? null, accepted, reason,
  } : null);

  // Ancienne règle (diagnostic avant / après) : plus ancienne ACQUISITION admissible au sens du lot 81D, sinon la fiche.
  const legacyOps = input.operations.filter((o) => o.legacyEligible && o.status === 'REALIZED')
    .map((o) => strictAcquisitionDay(o.realizedDate ?? o.startDate)).filter((d): d is string => !!d).sort();
  const legacyDate = legacyOps[0] ?? cDate;

  const contradictions: AcquisitionStartContradiction[] = [];
  const out = (r: Omit<AcquisitionStartResolution, 'kind' | 'canonical' | 'legacyDate' | 'contradictions'>): AcquisitionStartResolution =>
    ({ ...r, kind, canonical, legacyDate, contradictions });
  const marquer = (pred: (x: AcquisitionStartCandidate) => boolean, accepted: boolean, reason: AcquisitionCandidateReason) => {
    for (const x of admissibles) if (pred(x)) { x.accepted = accepted; x.reason = reason; }
  };

  // ── 1. Date humaine de la fiche : autorité ─────────────────────────────
  if (c && cHuman) {
    if (!cDate) {
      marquer(() => true, false, 'CANONICAL_USER_PRIORITY');
      return out({ status: 'REJECTED', basis: null, date: null, operationId: null, rejected: c.raw, candidates: [canonCand(false, 'INVALID_DATE')!, ...ops], repair: null });
    }
    const ecarts = admissibles.filter((x) => !memeAchat(x.date!, cDate));
    marquer((x) => memeAchat(x.date!, cDate), false, 'AGREES');
    marquer((x) => !memeAchat(x.date!, cDate), false, 'CANONICAL_USER_PRIORITY');
    if (ecarts.length) {
      contradictions.push({ code: 'OPERATION_VS_USER_DATE', dates: [cDate, ...new Set(ecarts.map((x) => x.date!))], operationIds: ecarts.map((x) => x.operationId!), resolvedBy: 'USER_AUTHORITY' });
    }
    return out({ status: 'RESOLVED', basis: 'ASSET_USER', date: cDate, operationId: null, rejected: null, candidates: [canonCand(true, 'SELECTED')!, ...ops], repair: null });
  }

  // ── 2. Plusieurs dates d'achat du bien incompatibles : indéterminée ─────
  if (datesOps.length > 1) {
    marquer(() => true, false, 'CONFLICTING_CANDIDATES');
    contradictions.push({ code: 'OPERATIONS_DISAGREE', dates: datesOps, operationIds: admissibles.map((x) => x.operationId!), resolvedBy: null });
    const cc = canonCand(false, cDate ? 'CONFLICTING_CANDIDATES' : 'INVALID_DATE');
    return out({ status: 'UNDETERMINED', basis: null, date: null, operationId: null, rejected: null, candidates: [...(cc ? [cc] : []), ...ops], repair: null });
  }

  // ── 3. Une date d'achat du bien (une ou plusieurs Opérations concordantes) ──
  if (datesOps.length === 1) {
    const d = datesOps[0];
    const porteuse = admissibles.find((x) => x.strongProof) ?? admissibles[0];
    if (cDate && memeAchat(cDate, d)) {
      // Date automatique non contredite (même achat) : la fiche reste la source.
      marquer(() => true, false, 'AGREES');
      return out({ status: 'RESOLVED', basis: 'ASSET_AUTOMATIC', date: cDate, operationId: null, rejected: null, candidates: [canonCand(true, 'SELECTED')!, ...ops], repair: null });
    }
    if (cDate && !admissibles.some((x) => x.strongProof)) {
      // Date automatique ≠ achat non prouvé : aucune autorité décisive.
      marquer(() => true, false, 'CONFLICTING_CANDIDATES');
      contradictions.push({ code: 'OPERATION_VS_AUTOMATIC_DATE', dates: [cDate, d], operationIds: admissibles.map((x) => x.operationId!), resolvedBy: null });
      return out({ status: 'UNDETERMINED', basis: null, date: null, operationId: null, rejected: null, candidates: [canonCand(false, 'CONFLICTING_CANDIDATES')!, ...ops], repair: null });
    }
    marquer((x) => x === porteuse, true, 'SELECTED');
    marquer((x) => x !== porteuse, false, 'AGREES');
    if (cDate) contradictions.push({ code: 'OPERATION_VS_AUTOMATIC_DATE', dates: [cDate, d], operationIds: [porteuse.operationId!], resolvedBy: 'PROOF' });
    const cc = canonCand(false, cDate ? 'CONTRADICTED_BY_PROOF' : 'INVALID_DATE');
    // Réparation de la fiche : enrichissement (absente) ou correction d'une valeur AUTOMATIQUE (contredite par la preuve,
    // ou impossible) — jamais une valeur humaine (cas 1).
    const repair: AcquisitionStartRepair = { kind: c ? 'CORRECT_AUTOMATIC_CANONICAL' : 'ENRICH_CANONICAL', value: d, operationId: porteuse.operationId!, expectedCurrent: c ? c.raw : null };
    return out({ status: 'RESOLVED', basis: 'OPERATION', date: d, operationId: porteuse.operationId, rejected: null, candidates: [...(cc ? [cc] : []), ...ops], repair });
  }

  // ── 4. Aucune Opération d'achat du bien datée ───────────────────────────
  if (cDate) return out({ status: 'RESOLVED', basis: 'ASSET_AUTOMATIC', date: cDate, operationId: null, rejected: null, candidates: [canonCand(true, 'SELECTED')!, ...ops], repair: null });
  if (c) return out({ status: 'REJECTED', basis: null, date: null, operationId: null, rejected: c.raw, candidates: [canonCand(false, 'INVALID_DATE')!, ...ops], repair: null });
  // Des achats possibles existent (datés) sans être attribuables avec certitude à ce bien : date indéterminée, alerte
  // ciblée (jamais « la plus ancienne »). Équipements, achats non réalisés, sans achat attendu : simplement absente.
  // L'achat du bien identifié mais non daté : date simplement absente (les autres achats ne sont pas le sien).
  const achatIdentifie = input.operations.some((o) => o.role === 'ASSET_PURCHASE' && o.status === 'REALIZED');
  const possibles = achatIdentifie ? [] : ops.filter((x) => (x.reason === 'NOT_ASSET_PURCHASE' || x.reason === 'MULTI_ASSET') && strictAcquisitionDay(x.rawDate) && x.dateField === 'realizedDate');
  if (possibles.length) {
    contradictions.push({ code: 'OPERATIONS_DISAGREE', dates: [...new Set(possibles.map((x) => strictAcquisitionDay(x.rawDate)!))].sort(), operationIds: possibles.map((x) => x.operationId!), resolvedBy: null });
    return out({ status: 'UNDETERMINED', basis: null, date: null, operationId: null, rejected: null, candidates: ops, repair: null });
  }
  return out({ status: 'MISSING', basis: null, date: null, operationId: null, rejected: null, candidates: ops, repair: null });
}
