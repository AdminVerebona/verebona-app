/**
 * Lot 113AQ (Trello #751, anomalie BO #12) — CONTRAT de diagnostic des
 * contradictions d'attributs d'Opération (pur, sans base, sans IA).
 *
 * Contrat typé et versionné `verebona.operation-attribute-conflicts/1` : une
 * entrée par Opération × attribut × rôle comparé, avec le VRAI compte de
 * l'Opération (jamais déduit de l'ordre de deux listes), les valeurs côte à
 * côte (brute, normalisée, fait, rôle, sources, autorité), la valeur retenue
 * et la valeur persistée, la qualification et sa raison, l'incidence, le
 * dernier contrôle RÉELLEMENT achevé, l'action appliquée, et l'état de la
 * ligne distinct de l'état de l'alerte agrégée.
 *
 * Les données viennent de ce que le PRODUCTEUR (consolidation T3, lot 78A,
 * qualifié par 113AQ) a persisté dans `business_operations.attribute_provenance`
 * et des tables de sources — indépendamment des journaux. Un relevé antérieur
 * aux règles 113AQ (version 1) est affiché tel quel, « non requalifié » : aucune
 * qualification n'est inventée à la lecture.
 *
 * Les occurrences de la Supervision sont lues comme des SIGNALEMENTS : une
 * occurrence n'est pas un conflit (#751 §4). `occurrenceTimeline` distingue
 * première détection, évolution de la population (ex. ajout d'une Opération),
 * changement de détail et simple répétition périodique ; une occurrence sans
 * détail structuré est « détail historique non conservé ».
 */
import { createHash } from 'node:crypto';
import {
  ALERTING_QUALIFICATIONS, ATTRIBUTE_CONFLICT_QUALIFICATIONS, CONFLICT_FIELDS, semanticRoleOf,
  type AttributeConflictQualification, type ConflictField,
} from '../consolidation/attribute-conflicts';
import { SOURCE_ROLES, type SourceRole } from '../model';

export const ATTRIBUTE_CONFLICT_DIAGNOSTIC_CONTRACT = 'verebona.operation-attribute-conflicts';
export const ATTRIBUTE_CONFLICT_DIAGNOSTIC_VERSION = 1;
export const ATTRIBUTE_CONFLICT_DIAGNOSTIC_FORMAT = `${ATTRIBUTE_CONFLICT_DIAGNOSTIC_CONTRACT}/${ATTRIBUTE_CONFLICT_DIAGNOSTIC_VERSION}`;

/** Au-delà, le dernier contrôle n'est plus « récent » (balayage horaire + campagne quotidienne). */
export const CONFLICT_CHECK_FRESH_HOURS = 48;
/** Entrées par page (écran / export) et plafond absolu d'un export. */
export const CONFLICT_DIAGNOSTIC_PAGE_SIZE = 50;
export const CONFLICT_DIAGNOSTIC_EXPORT_MAX = 500;

export const LEGACY_REASON = 'LEGACY_RULES_NOT_RECHECKED';
export const HISTORICAL_DETAIL_NOT_KEPT = 'détail historique non conservé';

export type ConflictLineState = 'ACTIVE' | 'RESOLVED' | 'NON_VERIFIABLE' | 'NOT_A_CONFLICT' | 'HISTORICAL';
export type CheckResult = 'PRESENT' | 'ABSENT' | 'UNKNOWN' | 'FAILED';

// ── Libellés BO (techniques, admin) ───────────────────────────────────────

export const ATTRIBUTE_LABELS: Readonly<Record<ConflictField, { label: string; kind: 'DATE' | 'PARTY' }>> = {
  plannedDate: { label: 'Date prévue', kind: 'DATE' },
  startDate: { label: 'Date de début / d’effet', kind: 'DATE' },
  realizedDate: { label: 'Date de réalisation', kind: 'DATE' },
  endDate: { label: 'Date de fin', kind: 'DATE' },
  provider: { label: 'Prestataire', kind: 'PARTY' },
};

export const ROLE_LABELS: Readonly<Record<string, string>> = {
  REALIZATION: 'réalisation (facture, acte, rapport)',
  PAYMENT: 'paiement / remboursement',
  CREDIT: 'avoir',
  QUOTE: 'devis',
  QUOTE_PLANNED: 'date prévue d’un devis',
  ORDER_PLANNED: 'date prévue d’une commande',
  CONTRACT_PLANNED: 'date prévue d’un contrat',
  PLANNED: 'date prévue',
  CONTRACT_EFFECTIVE: 'prise d’effet du contrat',
  CONTRACT_END: 'fin du contrat',
  COVERAGE_START: 'début de couverture',
  COVERAGE_END: 'fin de couverture',
  QUOTE_VALIDITY_START: 'début de validité du devis',
  QUOTE_VALIDITY_END: 'fin de validité du devis',
  BILLING_PERIOD_START: 'début de période facturée',
  BILLING_PERIOD_END: 'fin de période facturée',
  PAYMENT_START: 'début (preuve de paiement)',
  PAYMENT_END: 'fin (preuve de paiement)',
  START: 'début',
  END: 'fin',
  SUPPLIER: 'fournisseur facturant / cocontractant',
  EXECUTANT: 'intervenant (rapport)',
  PAYMENT_INTERMEDIARY: 'intermédiaire de paiement (banque)',
  DEED_ISSUER: 'rédacteur de l’acte (office notarial)',
  CLAIM_PARTY: 'partie au sinistre',
  USER_ENTRY: 'saisie de l’utilisateur',
  UNKNOWN: 'rôle non établi',
  MIXED: 'plusieurs rôles',
};

export const QUALIFICATION_LABELS: Readonly<Record<AttributeConflictQualification, string>> = {
  LEGITIMATE_DIFFERENCE: 'Divergence légitime (pas un conflit)',
  REAL_CONFLICT_RESOLVED: 'Conflit réel tranché',
  REAL_CONFLICT_UNRESOLVED: 'Conflit réel non tranché',
  INSUFFICIENT_EVIDENCE: 'Preuves insuffisantes (non vérifiable)',
  SOURCE_LINK_ERROR_SUSPECTED: 'Rattachement de source douteux',
  CHECK_FAILED: 'Contrôle en échec',
};

/** Raison lisible de chaque motif de qualification (BO — textes à valider par le PO). */
export const REASON_TEXTS: Readonly<Record<string, string>> = {
  ROLES_DIFFER: 'Les valeurs appartiennent à des faits de rôles différents (ex. devis / facture, paiement / réalisation, intervenant / facturant) : aucune contradiction.',
  FORMAT_EQUIVALENT: 'Les valeurs sont équivalentes une fois normalisées (format, désignation équivalente prouvée) : aucune contradiction.',
  QUOTE_REVISION: 'Valeurs de devis différents (révision ou devis concurrent) : un devis n’engage pas la réalisation.',
  SUCCESSIVE_REVISION: 'Révisions successives d’une relation durable (dates d’effet distinctes) : la valeur actuelle n’est pas contredite.',
  USER_VALUE_RETAINED: 'La valeur saisie par l’utilisateur est retenue et protégée : contradiction tranchée.',
  ADMIN_RESTORED_SOURCE: 'Contradiction due à une source rétablie au BO : tranchée par l’administrateur.',
  SAME_REFERENCE: 'Même attribut, même rôle et même référence de document : les valeurs se contredisent et aucune preuve ne permet de trancher sans risque.',
  SINGLE_FACT_OPERATION: 'Fait unique (achat, cession, sinistre) daté différemment par des sources de même rôle : contradiction non tranchée.',
  USER_VALUE_NOT_RETAINED: 'Une valeur saisie par l’utilisateur diffère de la valeur retenue : à examiner (protection utilisateur).',
  FACT_IDENTITY_NOT_ESTABLISHED: 'Même rôle, mais rien ne prouve que les sources décrivent le même fait (aucune référence commune) : non vérifiable.',
  ROLE_UNKNOWN: 'Rôle des sources non établi : les valeurs ne peuvent pas être comparées avec certitude.',
  ROLE_UNKNOWN_NOT_COMPARABLE: 'Une valeur provient d’une source de rôle non établi : non comparée à la valeur retenue.',
  IDENTITY_REVIEW_OPEN: 'Une source porte un doute d’identité ouvert (rattachement 78A) : le rattachement doit être examiné avant toute comparaison.',
  TARGETS_DISJOINT: 'Les sources désignent des biens différents : rattachement probablement erroné.',
  // Lot 114 (#750, issues B et C) — arbitrage par l'utilisateur (carte « À traiter ») et par T3 (preuve citée).
  USER_ARBITRATED: 'Contradiction réelle tranchée par l’utilisateur depuis « À traiter » : la valeur choisie est écrite et protégée.',
  T3_ARBITRATED: 'Contradiction réelle tranchée par l’arbitrage T3 sur preuve citée dans un document qui porte la valeur retenue.',
  T3_DISTINCT_FACTS: 'T3 a établi, preuve citée, que les valeurs portent sur des faits distincts : aucune contradiction.',
  T3_UNDECIDABLE: 'T3 a reconnu le même fait et des preuves de même autorité : aucun arbitrage sûr, la question est posée à l’utilisateur.',
  T3_LINK_ERROR_SUSPECTED: 'T3 signale, preuve citée, qu’un document semble étranger à l’événement : le rattachement doit être examiné avant toute comparaison.',
  NEW_EVIDENCE_AFTER_DECISION: 'Une valeur nouvelle est apparue après une décision : la contradiction est rouverte, la valeur décidée reste en place.',
  DECIDED_VALUE_WITHDRAWN: 'La source de la valeur décidée n’est plus active alors que les autres valeurs se contredisent encore : contradiction rouverte.',
  [LEGACY_REASON]: 'Relevé antérieur aux règles 113AQ : ni rôle ni qualification conservés ; recontrôle requis (reconsolidation de l’Opération).',
  CHECK_FAILED: 'Le dernier contrôle de l’Opération n’a pas pu s’achever (erreur technique T3) : verdict non vérifiable.',
};

// ── Entrées ───────────────────────────────────────────────────────────────

export interface DiagnosticSourceInfo {
  sourceId: number;
  kind: string | null;
  fileId: number | null;
  documentType: string | null;
  documentRole: string | null;
  authority: string | null;
  active: boolean | null;
  /** EXISTING / INACTIVE / DELETED / MISSING (source introuvable). */
  availability: 'EXISTING' | 'INACTIVE' | 'DELETED' | 'MISSING';
  version: string | null;
}

export interface OperationConflictInput {
  accountId: number;
  operationId: number;
  typeCode: string | null;
  status: string | null;
  technicalLabel: string | null;
  invalidated: boolean;
  mergedInto: number | null;
  current: Partial<Record<ConflictField, string | null>>;
  lastReconciledAt: string | null;
  provenance: unknown;
  sources: ReadonlyMap<number, DiagnosticSourceInfo>;
  /** Candidat T3 de l'Opération en erreur technique (contrôle non achevé). */
  technicalError: string | null;
  /**
   * Cartes « À traiter » d'arbitrage : date de l'événement principal (lot 83A, sans `subject`) et, lot 114 (#750),
   * contradiction réelle d'un attribut (`subject` = `attribut:rôle`).
   */
  arbitrations: ReadonlyArray<{ actionId: number; state: 'OPEN' | 'RESOLVED'; kind: string; subject?: string | null }>;
  /** Lot 114 (#750, issue B) : examens T3 de l'Opération (table 1690), le plus récent par sujet `attribut:rôle`. */
  t3Reviews?: ReadonlyMap<string, T3ReviewInfo>;
}

/** Lot 114 (#750, issue B) — examen T3 d'une ligne, tel que persisté (aucune valeur reconstruite). */
export interface T3ReviewInfo {
  reviewId: number;
  status: string;
  outcome: string | null;
  confidence: string | null;
  reason: string | null;
  retainedValue: string | null;
  valueBefore: string | null;
  valueAfter: string | null;
  applied: boolean;
  evidence: Array<{ fileId: number | null; excerpt: string }>;
  requestedAt: string | null;
  decidedAt: string | null;
  promptVersion: string | null;
  traceId: string | null;
  aiCalls: number;
  error: string | null;
}

/** États lisibles d'un examen T3 (BO — textes à valider par le PO). */
export const T3_REVIEW_LABELS: Readonly<Record<string, string>> = {
  PENDING: 'Arbitrage T3 demandé, en attente du prochain passage',
  DECIDED: 'Arbitrage T3 rendu',
  ABSTAINED: 'T3 s’est abstenu (preuves insuffisantes)',
  NOT_CERTAIN: 'T3 n’est pas certain : aucun effet',
  REJECTED: 'Sortie T3 refusée par la validation : vaut abstention',
  AI_FAILED: 'Appel T3 en échec technique (nouvel essai borné)',
  OBSOLETE: 'Constat disparu avant l’examen',
  UNAVAILABLE: 'Arbitrage T3 indisponible (bloc 38 absent du prompt actif)',
};

export interface DiagnosticValue {
  raw: string;
  normalized: string | null;
  fact: string;
  role: string;
  roleLabel: string;
  period: null;
  retained: boolean;
  sources: Array<DiagnosticSourceInfo & { semanticRole: string; boLink: string | null }>;
  authority: string | null;
}

export interface ConflictDiagnosticEntry {
  accountId: number;
  operationId: number;
  operation: { type: string | null; label: string | null; status: string | null; availability: 'EXISTING' | 'INVALIDATED' | 'MERGED'; boLink: string };
  attribute: { key: ConflictField; label: string; kind: 'DATE' | 'PARTY' };
  role: { code: string; label: string; known: boolean };
  values: DiagnosticValue[];
  retainedValue: string | null;
  persistedValue: string | null;
  qualification: AttributeConflictQualification;
  qualificationLabel: string;
  reasonCode: string;
  reason: string;
  /** Liste conservée par le producteur : conflit (alerte), divergence, arbitrage BO. */
  origin: 'conflicts' | 'divergences' | 'arbitratedConflicts';
  impact: { scopes: string[]; status: 'TO_VERIFY' | 'NONE' | 'NOT_ESTABLISHED' };
  lastCheck: { at: string | null; rules: string; rulesVersion: number; result: CheckResult; scope: 'OPERATION'; fresh: boolean; ageHours: number | null };
  appliedAction: {
    kind: 'NONE' | 'VALUES_KEPT' | 'USER_DECISION' | 'ADMIN_RESTORE' | 'AWAITING_RECHECK' | 'T3_ARBITRATION' | 'T3_PENDING' | 'USER_ARBITRATION_OPEN';
    detail: string;
  };
  arbitration: { actionId: number; state: 'OPEN' | 'RESOLVED' } | null;
  /** Lot 114 (#750, issue B) : dernier examen T3 de cette ligne (null : jamais examinée). */
  t3: (T3ReviewInfo & { label: string }) | null;
  protection: string | null;
  lineState: ConflictLineState;
  lineStateReason: string;
}

type Row = Record<string, unknown>;
const isQualification = (v: unknown): v is AttributeConflictQualification =>
  typeof v === 'string' && (ATTRIBUTE_CONFLICT_QUALIFICATIONS as readonly string[]).includes(v);
const isField = (v: unknown): v is ConflictField => typeof v === 'string' && (CONFLICT_FIELDS as readonly string[]).includes(v);
const asRole = (v: unknown): SourceRole | null => (typeof v === 'string' && (SOURCE_ROLES as readonly string[]).includes(v) ? v as SourceRole : null);

function hoursBetween(from: string | null, now: Date): number | null {
  if (!from) return null;
  const t = Date.parse(from);
  return Number.isNaN(t) ? null : Math.max(0, Math.round((now.getTime() - t) / 3_600_000));
}

/** Entrées de diagnostic d'UNE Opération (lecture de la provenance persistée). */
export function buildConflictEntries(op: OperationConflictInput, now: Date = new Date()): ConflictDiagnosticEntry[] {
  const p = (op.provenance && typeof op.provenance === 'object' ? op.provenance : {}) as Row;
  const version = Number(p.version ?? 1);
  const legacy = !(version >= 2);
  const rules = typeof p.rules === 'string' ? p.rules : legacy ? 'l78a-v1' : `v${version}`;
  const ageHours = hoursBetween(op.lastReconciledAt, now);
  const fresh = ageHours !== null && ageHours <= CONFLICT_CHECK_FRESH_HOURS;
  const availability = op.mergedInto !== null ? 'MERGED' : op.invalidated ? 'INVALIDATED' : 'EXISTING';
  const lists: Array<ConflictDiagnosticEntry['origin']> = ['conflicts', 'arbitratedConflicts', 'divergences'];
  const out: ConflictDiagnosticEntry[] = [];
  for (const origin of lists) {
    const list = Array.isArray(p[origin]) ? (p[origin] as Row[]) : [];
    for (const c of list) {
      if (!isField(c.field)) continue;
      const field = c.field;
      const retained = typeof c.retained === 'string' ? c.retained : null;
      const qualified = !legacy && isQualification(c.qualification);
      let qualification: AttributeConflictQualification = qualified ? c.qualification as AttributeConflictQualification
        : origin === 'arbitratedConflicts' ? 'REAL_CONFLICT_RESOLVED' : 'INSUFFICIENT_EVIDENCE';
      let reasonCode = qualified && typeof c.reasonCode === 'string' ? c.reasonCode
        : origin === 'arbitratedConflicts' ? 'ADMIN_RESTORED_SOURCE' : LEGACY_REASON;
      const failed = op.technicalError !== null && ALERTING_QUALIFICATIONS.includes(qualification);
      if (failed) { qualification = 'CHECK_FAILED'; reasonCode = 'CHECK_FAILED'; }
      const values: DiagnosticValue[] = (Array.isArray(c.values) ? (c.values as Row[]) : []).map((v) => {
        const raw = String(v.value ?? '');
        const stored = Array.isArray(v.sources) ? (v.sources as Row[]) : [];
        const ids = Array.isArray(v.sourceIds) ? (v.sourceIds as unknown[]).map(Number).filter(Number.isFinite) : stored.map((s) => Number(s.id));
        const sources = ids.map((id) => {
          const info = op.sources.get(id) ?? { sourceId: id, kind: null, fileId: null, documentType: null, documentRole: null, authority: null, active: null, availability: 'MISSING' as const, version: null };
          const st = stored.find((s) => Number(s.id) === id);
          const semanticRole = typeof st?.role === 'string' ? st.role
            : semanticRoleOf(field, { role: asRole(info.documentRole), agenda: info.kind === 'AGENDA' ? { itemId: 0, realizedDate: null, realizationRecord: false } : undefined }, info.authority);
          return { ...info, semanticRole, boLink: info.fileId ? `/admin/operations/${op.operationId}?accountId=${op.accountId}#document-${info.fileId}` : null };
        });
        const roles = [...new Set(sources.map((s) => s.semanticRole))];
        const role = roles.length === 1 ? roles[0] : roles.length ? 'MIXED' : 'UNKNOWN';
        return {
          raw, normalized: typeof v.normalized === 'string' ? v.normalized : null, fact: `${field}:${role}`, role,
          roleLabel: ROLE_LABELS[role] ?? role, period: null, retained: retained !== null && raw === retained, sources,
          authority: sources.map((s) => s.authority).find((a) => !!a) ?? null,
        };
      });
      const roleCode = qualified && typeof c.role === 'string' ? c.role : 'UNKNOWN';
      const impactScopes = Array.isArray(c.impact) ? (c.impact as unknown[]).map(String) : [];
      // Lot 114 (#750) : carte de la contradiction (même attribut, même rôle), la plus récente ; à défaut, carte de date 83A.
      const sujet = `${field}:${roleCode}`;
      const duSujet = op.arbitrations.filter((a) => a.subject === sujet).sort((a, b) => b.actionId - a.actionId);
      const arbitration = duSujet.find((a) => a.state === 'OPEN') ?? duSujet[0]
        ?? (field === 'realizedDate' ? op.arbitrations.find((a) => a.kind === 'ARBITRATE' && !a.subject) ?? null : null);
      const examen = op.t3Reviews?.get(sujet) ?? null;
      const resolution = (c.resolution && typeof c.resolution === 'object' ? c.resolution : null) as Row | null;
      const lineState: ConflictLineState = availability !== 'EXISTING' ? 'HISTORICAL'
        : qualification === 'LEGITIMATE_DIFFERENCE' ? 'NOT_A_CONFLICT'
          : qualification === 'REAL_CONFLICT_RESOLVED' ? 'RESOLVED'
            : (qualification === 'REAL_CONFLICT_UNRESOLVED' || qualification === 'SOURCE_LINK_ERROR_SUSPECTED') && fresh ? 'ACTIVE'
              : 'NON_VERIFIABLE';
      const lineStateReason = lineState === 'HISTORICAL' ? `Opération ${availability === 'MERGED' ? `fusionnée dans #${op.mergedInto}` : 'invalidée'} : ligne conservée pour l’historique.`
        : lineState === 'ACTIVE' ? 'Conflit actif au dernier contrôle achevé.'
          : lineState === 'RESOLVED' ? 'Contradiction tranchée : conservée pour traçabilité.'
            : lineState === 'NOT_A_CONFLICT' ? 'Pas un conflit : faits conservés et consultables.'
              : failed ? `Contrôle non achevé : ${op.technicalError}.`
                : legacy ? REASON_TEXTS[LEGACY_REASON]
                  : !fresh ? `Dernier contrôle ${ageHours === null ? 'inconnu' : `vieux de ${ageHours} h`} : verdict à reconfirmer.`
                    : REASON_TEXTS[reasonCode] ?? reasonCode;
      out.push({
        accountId: op.accountId,
        operationId: op.operationId,
        operation: { type: op.typeCode, label: op.technicalLabel, status: op.status, availability, boLink: `/admin/operations/${op.operationId}?accountId=${op.accountId}` },
        attribute: { key: field, ...ATTRIBUTE_LABELS[field] },
        role: { code: roleCode, label: ROLE_LABELS[roleCode] ?? roleCode, known: qualified && roleCode !== 'UNKNOWN' },
        values,
        retainedValue: retained,
        persistedValue: field in op.current ? op.current[field] ?? null : (typeof c.current === 'string' ? c.current : null),
        qualification,
        qualificationLabel: QUALIFICATION_LABELS[qualification],
        reasonCode,
        reason: REASON_TEXTS[reasonCode] ?? reasonCode,
        origin,
        impact: legacy ? { scopes: [], status: 'NOT_ESTABLISHED' }
          : impactScopes.length ? { scopes: impactScopes, status: 'TO_VERIFY' } : { scopes: [], status: 'NONE' },
        lastCheck: {
          at: op.lastReconciledAt, rules, rulesVersion: legacy ? 1 : version,
          result: failed ? 'FAILED' : legacy || op.lastReconciledAt === null ? 'UNKNOWN' : ALERTING_QUALIFICATIONS.includes(qualification) ? 'PRESENT' : 'ABSENT',
          scope: 'OPERATION', fresh, ageHours,
        },
        appliedAction: resolution?.by === 'T3' && qualification === 'REAL_CONFLICT_RESOLVED'
          ? { kind: 'T3_ARBITRATION', detail: `Valeur retenue par l’arbitrage T3 sur preuve citée${examen ? ` (examen #${examen.reviewId} : ${examen.valueBefore ?? 'aucune'} → ${examen.valueAfter ?? 'aucune'}${examen.applied ? '' : ', non écrite : valeur protégée ou saisie non gérée'})` : ''}.` }
          : resolution?.by === 'USER' && reasonCode === 'USER_ARBITRATED' ? { kind: 'USER_DECISION', detail: 'Valeur choisie par l’utilisateur depuis « À traiter », écrite et protégée.' }
          : arbitration?.state === 'OPEN' && qualification === 'REAL_CONFLICT_UNRESOLVED' ? { kind: 'USER_ARBITRATION_OPEN', detail: 'Arbitrage demandé à l’utilisateur (« À traiter ») ; valeur en place conservée d’ici là.' }
          : examen?.status === 'PENDING' && ALERTING_QUALIFICATIONS.includes(qualification) ? { kind: 'T3_PENDING', detail: 'Arbitrage T3 demandé : aucune valeur modifiée, carte « À traiter » différée.' }
          : resolution?.by === 'USER' ? { kind: 'USER_DECISION', detail: 'Valeur de l’utilisateur retenue (protégée), aucune écriture par T3.' }
          : resolution?.by === 'ADMIN' || origin === 'arbitratedConflicts' ? { kind: 'ADMIN_RESTORE', detail: 'Source rétablie au BO (rétablissement tracé).' }
            : legacy ? { kind: 'AWAITING_RECHECK', detail: 'Reconsolidation de l’Opération attendue (règles 113AQ).' }
              : ALERTING_QUALIFICATIONS.includes(qualification) ? { kind: 'VALUES_KEPT', detail: 'Valeurs conservées, aucune écrasée ; valeur retenue inchangée.' }
                : { kind: 'NONE', detail: 'Aucune action nécessaire.' },
        arbitration: arbitration ? { actionId: arbitration.actionId, state: arbitration.state } : null,
        t3: examen ? { ...examen, label: T3_REVIEW_LABELS[examen.status] ?? examen.status } : null,
        protection: typeof c.protection === 'string' ? c.protection : null,
        lineState,
        lineStateReason,
      });
    }
  }
  return out;
}

// ── Occurrences (signalements) ────────────────────────────────────────────

export interface OccurrenceInput { id: number; occurredAt: string; technicalDetail: Record<string, unknown> | null }
export interface OccurrenceTimelineItem {
  id: number;
  at: string;
  kind: 'FIRST' | 'POPULATION_CHANGE' | 'DETAIL_CHANGE' | 'PERIODIC_REPEAT';
  operationIds: string[];
  added: string[];
  removed: string[];
  detail: 'STRUCTURED' | typeof HISTORICAL_DETAIL_NOT_KEPT;
}

const opsOf = (d: Record<string, unknown> | null): string[] => {
  if (!d) return [];
  if (Array.isArray(d.conflicts)) {
    return [...new Set((d.conflicts as unknown[]).map((c) => (typeof c === 'string' ? c.split(':').slice(0, 2).join(':')
      : `${(c as Row).accountId}:${(c as Row).operationId}`)))].sort();
  }
  return String(d.operationIds ?? '').split(',').map((x) => x.trim()).filter(Boolean).sort((a, b) => Number(a) - Number(b));
};

/** Lecture chronologique des signalements : première détection, évolution de population, répétition. */
export function occurrenceTimeline(occurrences: readonly OccurrenceInput[]): {
  items: OccurrenceTimelineItem[]; counters: { total: number; material: number; periodic: number; withoutDetail: number };
} {
  const asc = [...occurrences].sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : a.id - b.id));
  const items: OccurrenceTimelineItem[] = [];
  let prevOps: string[] | null = null;
  let prevKey: string | null = null;
  for (const o of asc) {
    const d = o.technicalDetail;
    const ops = opsOf(d);
    const structured = !!d && Array.isArray(d.conflicts);
    // Forme « compte:opération » pour une occurrence structurée ; identifiants seuls sinon (historique).
    const bare = (xs: string[]) => xs.map((x) => (x.includes(':') ? x.split(':')[1] : x));
    const cur = bare(ops);
    const prev = prevOps === null ? null : bare(prevOps);
    const added = prev === null ? [] : cur.filter((x) => !prev.includes(x));
    const removed = prev === null ? [] : prev.filter((x) => !cur.includes(x));
    const key = typeof d?.materialKey === 'string' ? d.materialKey : null;
    const kind: OccurrenceTimelineItem['kind'] = prev === null ? 'FIRST'
      : added.length || removed.length ? 'POPULATION_CHANGE'
        : key !== null && prevKey !== null && key !== prevKey ? 'DETAIL_CHANGE' : 'PERIODIC_REPEAT';
    items.push({ id: o.id, at: o.occurredAt, kind, operationIds: cur, added, removed, detail: structured ? 'STRUCTURED' : HISTORICAL_DETAIL_NOT_KEPT });
    prevOps = ops;
    prevKey = key;
  }
  return {
    items: items.reverse(),
    counters: {
      total: items.length,
      material: items.filter((i) => i.kind !== 'PERIODIC_REPEAT').length,
      periodic: items.filter((i) => i.kind === 'PERIODIC_REPEAT').length,
      withoutDetail: items.filter((i) => i.detail !== 'STRUCTURED').length,
    },
  };
}

// ── Compteurs et état agrégé ──────────────────────────────────────────────

export interface ConflictCounters {
  occurrences: number | null;
  materialOccurrences: number | null;
  periodicReports: number | null;
  operations: number;
  attributes: number;
  activeConflicts: number;
  nonVerifiable: number;
  legitimateDifferences: number;
  resolved: number;
  openArbitrations: number;
  resolvedArbitrations: number;
  checksFailed: number;
  linkErrorsSuspected: number;
  /** Non mesuré par ce diagnostic (les réparations sont dans le journal de cohérence / rattrapage). */
  effectiveRepairs: null;
}

export function conflictCounters(entries: readonly ConflictDiagnosticEntry[], occ?: { total: number; material: number; periodic: number }): ConflictCounters {
  const alert = entries.filter((e) => e.lineState === 'ACTIVE' || e.lineState === 'NON_VERIFIABLE');
  const arbit = new Map<number, 'OPEN' | 'RESOLVED'>();
  for (const e of entries) if (e.arbitration) arbit.set(e.arbitration.actionId, e.arbitration.state);
  return {
    occurrences: occ?.total ?? null,
    materialOccurrences: occ?.material ?? null,
    periodicReports: occ?.periodic ?? null,
    operations: new Set(alert.map((e) => `${e.accountId}:${e.operationId}`)).size,
    attributes: new Set(alert.map((e) => `${e.accountId}:${e.operationId}:${e.attribute.key}`)).size,
    activeConflicts: entries.filter((e) => e.lineState === 'ACTIVE').length,
    nonVerifiable: entries.filter((e) => e.lineState === 'NON_VERIFIABLE').length,
    legitimateDifferences: entries.filter((e) => e.qualification === 'LEGITIMATE_DIFFERENCE').length,
    resolved: entries.filter((e) => e.qualification === 'REAL_CONFLICT_RESOLVED').length,
    openArbitrations: [...arbit.values()].filter((s) => s === 'OPEN').length,
    resolvedArbitrations: [...arbit.values()].filter((s) => s === 'RESOLVED').length,
    checksFailed: entries.filter((e) => e.qualification === 'CHECK_FAILED').length,
    linkErrorsSuspected: entries.filter((e) => e.qualification === 'SOURCE_LINK_ERROR_SUSPECTED').length,
    effectiveRepairs: null,
  };
}

/** Raison du maintien de l'alerte agrégée et règle de clôture. */
export function alertState(c: Pick<ConflictCounters, 'activeConflicts' | 'nonVerifiable'>, anomalyStatus: 'open' | 'resolved' | null): {
  anomalyStatus: 'open' | 'resolved' | null; maintainedBy: 'ACTIVE_CONFLICTS' | 'NON_VERIFIABLE' | 'BOTH' | 'NONE'; closingRule: string;
} {
  const maintainedBy = c.activeConflicts && c.nonVerifiable ? 'BOTH' : c.activeConflicts ? 'ACTIVE_CONFLICTS' : c.nonVerifiable ? 'NON_VERIFIABLE' : 'NONE';
  return {
    anomalyStatus, maintainedBy,
    closingRule: 'L’alerte se résout d’elle-même au contrôle quotidien quand plus aucune Opération ne garde de ligne active ou non vérifiable '
      + '(recontrôle complet par reconsolidation) ; elle n’est jamais close sur un balayage partiel ni par masquage.',
  };
}

/** Longueur JSON maximale du relevé compact d'une occurrence (le détail de Supervision est borné à 2 000 caractères par clé). */
const OCCURRENCE_LINES_MAX_JSON = 1900;

/**
 * Relevé COMPACT d'une occurrence : « compte:opération:attribut:qualification », trié, borné
 * (association compte ↔ Opération explicite, jamais deux listes parallèles).
 */
export function occurrenceLines(lines: ReadonlyArray<{ accountId: number; operationId: number; field: string; qualification: string }>): {
  conflicts: string[]; truncated: boolean;
} {
  const all = [...new Set(lines.map((l) => `${l.accountId}:${l.operationId}:${l.field}:${l.qualification}`))]
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const out: string[] = [];
  let size = 2;
  for (const l of all) {
    if (size + l.length + 3 > OCCURRENCE_LINES_MAX_JSON) return { conflicts: out, truncated: true };
    out.push(l);
    size += l.length + 3;
  }
  return { conflicts: out, truncated: false };
}

/** Empreinte MATÉRIELLE d'un relevé (population, attributs, valeurs, qualifications) : deux balayages identiques ont la même. */
export function materialKeyOf(lines: ReadonlyArray<{ accountId: number; operationId: number; field: string; qualification: string; values: readonly string[] }>): string {
  const sig = lines.map((l) => `${l.accountId}:${l.operationId}:${l.field}:${l.qualification}:${[...l.values].sort().join(',')}`).sort().join('|');
  return createHash('sha256').update(sig).digest('hex').slice(0, 24);
}
