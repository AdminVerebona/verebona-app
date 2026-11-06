/**
 * Lot 111X — seconde chance T3 des COORDONNÉES d'un fournisseur (ticket
 * « Fournisseurs — coordonnées documentaires »). Prolonge 88B (#576) au sujet
 * SUPPLIER sans second moteur : même journal (`property_recovery_runs` /
 * `property_recovery_decisions`, sujet SUPPLIER, migration 1335), même branche
 * T3 KNOWLEDGE_QUERY pour le seul découpage d'une unité à plusieurs champs,
 * même budget partagé (`T3_KNOWLEDGE_QUERY_DAILY_MAX`).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CHAÎNE
 *   1. fiche ACTIVE du compte (archivée / fusionnée / absente : GONE) ;
 *   2. connaissance documentaire ACTIVE (`collectSupplierKnowledge`) —
 *      jamais le fichier, jamais une relance T1 / OCR / S3 ;
 *   3. empreinte du contexte : déjà décidé dans CE contexte → rien (aucune
 *      écriture, aucun appel IA) ;
 *   4. décision DÉTERMINISTE par champ (`supplier.ts`) ;
 *   5. champ vide sans valeur lisible mais annoncé par une unité de
 *      l'émetteur (découpage nécessaire) : T3 KNOWLEDGE_QUERY SEULEMENT si le
 *      prompt actif porte `t3-knowledge-query-v3` — sinon issue
 *      CONTRACT_PENDING persistée (jamais un faux succès) ;
 *   6. écriture par le SEUL writer des fiches, `consolidateCoordinates`
 *      (champs vides seulement, protection PAR CHAMP — saisie / effacement de
 *      l'utilisateur —, valeur différente = conflit sourcé
 *      `supplier_contact_observations` + `supplier_review_items`
 *      `contact_conflict`, distinct du doute d'identité #706) ;
 *   7. historique par champ dans `property_recovery_decisions` (source,
 *      unité / fait, valeur — IBAN masqué —, confiance, décision, motif,
 *      avant / après) ; issue du lot dans `property_recovery_runs`.
 * Un devis ne prouve aucun paiement : seules des coordonnées sont lues.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'node:crypto';
import { pgClient } from '@/db';
import { maskIban, readContactValues, readPostalAddresses, type SupplierCoordinateField } from '@/services/suppliers/supplier-contact-reading';
import type { ExtractedSupplierData } from '@/services/suppliers/supplier-service';
import type { KnowledgeCall, KnowledgeCallResult, KnowledgeCapability } from '../knowledge-query/model';
import { collectSupplierKnowledge, loadSupplierRow, type SupplierKnowledge, type SupplierKnowledgeItem, type SupplierRow } from './collect';
import {
  SUPPLIER_COORDINATES_CONTRACT_VERSION, SUPPLIER_COORDINATES_PENDING_CONTRACT, contractStateOf,
} from './contract';
import { currentCoordinates, decideSupplierCoordinates, supplierContextFingerprint, type CoordinateFinding } from './supplier';

type Row = Record<string, unknown>;
const q = async <T = Row>(sql: string, params: unknown[]): Promise<T[]> =>
  (await pgClient.unsafe(sql, params as never[])) as unknown as T[];
const sha = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 24);

/** Motifs d'abstention par champ (historique, constats). */
export type SupplierAbstention =
  | 'NO_EVIDENCE' | 'UNCERTAIN_ONLY' | 'EVIDENCE_CONFLICT' | 'USER_CLEARED' | 'VALUE_CONFLICT_REVIEW' | 'ALREADY_CONSISTENT'
  | 'ADDRESS_MIXED' | 'CONTRACT_PENDING' | 'AI_NOT_FOUND' | 'BUDGET_EXHAUSTED' | 'AI_FAILED';

/** Plan par champ (pure) : ce que la consolidation fera de chaque valeur établie. */
export interface FieldPlan {
  field: SupplierCoordinateField;
  action: 'FILL' | 'CONFLICT' | 'ABSTAIN';
  cause: SupplierAbstention | null;
  value: string | null;
  before: string | null;
  finding: CoordinateFinding;
}

export function planSupplierFields(s: SupplierRow, findings: readonly CoordinateFinding[]): FieldPlan[] {
  const cur = currentCoordinates(s);
  const norm = (f: SupplierCoordinateField, v: string) => {
    const x = v.toLowerCase().replace(/[\s.\-()]/g, '');
    return f === 'phone' ? x.replace(/^\+33/, '0').replace(/^0033/, '0') : f === 'website' ? x.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '') : x;
  };
  return findings.map((finding): FieldPlan => {
    const before = cur[finding.field] ?? null;
    const base = { field: finding.field, before, finding, value: finding.value };
    if (finding.status !== 'ESTABLISHED' || !finding.value) {
      const cause: SupplierAbstention = finding.status === 'NEEDS_SPLIT' ? 'CONTRACT_PENDING' : (finding.status as SupplierAbstention);
      return { ...base, action: 'ABSTAIN', cause: before ? 'ALREADY_CONSISTENT' : cause };
    }
    if (!before) {
      if (s.userFieldDecisions?.[finding.field]?.action === 'CLEARED') return { ...base, action: 'ABSTAIN', cause: 'USER_CLEARED' };
      return { ...base, action: 'FILL', cause: null };
    }
    if (norm(finding.field, before) === norm(finding.field, finding.value)) return { ...base, action: 'ABSTAIN', cause: 'ALREADY_CONSISTENT' };
    return { ...base, action: 'CONFLICT', cause: 'VALUE_CONFLICT_REVIEW' };
  });
}

/** Dépendances injectables (tests). */
export interface SupplierRecoveryDeps {
  capability?: () => Promise<KnowledgeCapability>;
  call?: (c: KnowledgeCall) => Promise<KnowledgeCallResult>;
  dailyMax?: number;
  now?: () => Date;
}

export interface SupplierCoordinatesState {
  supplier: SupplierRow;
  knowledge: SupplierKnowledge;
  findings: CoordinateFinding[];
  plan: FieldPlan[];
  contextFp: string;
  /** Contexte déjà décidé (journal) ? */
  recorded: boolean;
  /** Revues de conflit de valeur encore ouvertes. */
  openConflicts: number;
  /** Découpage IA nécessaire (champ vide annoncé, aucune valeur lisible). */
  needsSplit: SupplierCoordinateField[];
  contract: KnowledgeCapability & { contractCarried: boolean };
}

async function capabilityOf(deps: SupplierRecoveryDeps) {
  const cap = deps.capability ? await deps.capability() : await (await import('../knowledge-query/model')).knowledgeQueryCapability();
  return { ...cap, contractCarried: cap.available && (cap.contracts ?? []).includes(SUPPLIER_COORDINATES_CONTRACT_VERSION) };
}

let journalPret: { ok: boolean; at: number } | null = null;
/** Journal 0770 + sujet SUPPLIER (1335) présents ? Ne lève jamais. */
export async function supplierRecoveryReady(): Promise<boolean> {
  if (journalPret && (journalPret.ok || Date.now() - journalPret.at < 300_000)) return journalPret.ok;
  let ok = false;
  try {
    const [r] = await q<{ ok: boolean }>(
      `SELECT to_regclass('property_recovery_runs') IS NOT NULL
          AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'suppliers' AND column_name = 'user_field_decisions')
          AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'property_recovery_runs'
                       AND column_name = 'asset_id' AND is_nullable = 'YES') AS ok`, []);
    ok = r?.ok === true;
  } catch { ok = false; }
  journalPret = { ok, at: Date.now() };
  return ok;
}
/** Réservé aux tests. */
export function __resetSupplierRecoveryCacheForTests(): void { journalPret = null; }

/** État en LECTURE SEULE (contrôle de cohérence, mode à blanc). null : fiche absente ou inactive. */
export async function supplierCoordinatesState(accountId: number, supplierId: number, deps: SupplierRecoveryDeps = {}): Promise<SupplierCoordinatesState | null> {
  const supplier = await loadSupplierRow(accountId, supplierId);
  if (!supplier || supplier.status !== 'active') return null;
  const knowledge = await collectSupplierKnowledge(accountId, supplier);
  const findings = decideSupplierCoordinates(knowledge);
  const plan = planSupplierFields(supplier, findings);
  const contextFp = supplierContextFingerprint(knowledge);
  const [rec] = await q<{ n: number }>(
    // Panne IA : contexte NON décidé tant qu'une nouvelle tentative est due (au plus 3, délai d'une heure).
    `SELECT count(*)::int AS n FROM property_recovery_runs WHERE account_id = $1 AND object_type = 'SUPPLIER' AND object_id = $2 AND context_fp = $3
        AND NOT (status = 'AI_FAILED' AND attempts < 3 AND (retry_at IS NULL OR retry_at <= now()))`,
    [accountId, supplierId, contextFp]);
  const [conf] = await q<{ n: number }>(
    `SELECT count(*)::int AS n FROM supplier_review_items WHERE account_id = $1 AND supplier_id = $2 AND item_type = 'contact_conflict' AND status = 'open'`,
    [accountId, supplierId]);
  const needsSplit = plan.filter((p) => p.finding.status === 'NEEDS_SPLIT' && !p.before && supplier.userFieldDecisions?.[p.field]?.action !== 'CLEARED').map((p) => p.field);
  return {
    supplier, knowledge, findings, plan, contextFp, recorded: Number(rec?.n ?? 0) > 0, openConflicts: Number(conf?.n ?? 0),
    needsSplit, contract: await capabilityOf(deps),
  };
}

export interface SupplierRecoveryResult {
  status: 'GONE' | 'NOT_READY' | 'UNCHANGED_CONTEXT' | 'APPLIED' | 'DRY_RUN';
  supplierId: number;
  contextFp: string | null;
  written: string[];
  conflicts: number;
  abstentions: Record<string, SupplierAbstention>;
  contractPending: boolean;
  aiCalls: number;
  runId: number | null;
}

/** Variables KNOWLEDGE_QUERY (contrat d'entrée v3, sujet SUPPLIER) : monde fermé, éléments de l'émetteur seulement. Pure. */
export function supplierKnowledgeVariables(s: SupplierRow, fields: readonly SupplierCoordinateField[], items: readonly SupplierKnowledgeItem[]): Record<string, unknown> {
  return {
    FIELD: { contractVersion: SUPPLIER_COORDINATES_CONTRACT_VERSION, mode: 'SUPPLIER_COORDINATES', subject: { ref: 'S', type: 'SUPPLIER', name: s.name }, key: null, label: null, valueType: null },
    CURRENT_STATE: { properties: fields.map((f) => ({ key: f, value: null, protectedByUser: false })) },
    EVIDENCES: items.map((i) => ({ ref: i.ref, document: `D${i.fileId}`, layer: i.layer, kind: i.kind, label: i.label, value: null, text: i.text, confidence: i.confidence, page: i.page })),
    SUBJECT_CONTEXT: { closedWorld: true, subject: 'S', documents: [...new Set(items.map((i) => i.fileId))].map((id) => ({ ref: `D${id}`, relation: 'LINKED' })) },
    CANDIDATES: fields.map((f) => ({ role: f, key: f, label: f, valueType: 'text' })),
    RELATION_TYPE: 'KNOWLEDGE_QUERY',
  };
}

/**
 * Constats IA VALIDÉS (pure) : champ demandé, confiance certaine, références
 * citées parmi les éléments transmis, valeur recopiée dans l'élément cité ET
 * lisible au format du champ. Tout autre constat est refusé (motif rendu).
 */
export function validateSupplierFindings(
  out: KnowledgeCallResult['output'], fields: readonly SupplierCoordinateField[], items: readonly SupplierKnowledgeItem[],
): { accepted: Array<{ field: SupplierCoordinateField; value: string; refs: string[] }>; rejected: Array<{ target: string; reason: string }> } {
  const accepted: Array<{ field: SupplierCoordinateField; value: string; refs: string[] }> = [];
  const rejected: Array<{ target: string; reason: string }> = [];
  const parRef = new Map(items.map((i) => [i.ref, i]));
  for (const f of out.findings ?? []) {
    const field = f.target as SupplierCoordinateField;
    if (!fields.includes(field)) { rejected.push({ target: f.target, reason: 'TARGET_NOT_REQUESTED' }); continue; }
    if (f.confidence !== 'certain') { rejected.push({ target: f.target, reason: 'NOT_CERTAIN' }); continue; }
    const cites = f.evidenceRefs.map((r) => parRef.get(r));
    if (cites.some((c) => !c)) { rejected.push({ target: f.target, reason: 'UNKNOWN_REF' }); continue; }
    if (!cites.some((c) => c!.text.includes(f.rawValue))) { rejected.push({ target: f.target, reason: 'VALUE_NOT_IN_EVIDENCE' }); continue; }
    if (cites.every((c) => c!.coverage === 'UNCERTAIN')) { rejected.push({ target: f.target, reason: 'UNCERTAIN_ONLY' }); continue; }
    const lu = readContactValues(f.rawValue).find((v) => v.field === field && !v.excluded);
    const adresse = field === 'addressLine1' ? readPostalAddresses(f.rawValue)[0] : null;
    const valeur = lu?.value ?? (adresse ? adresse.addressLine1 : null);
    if (!valeur) { rejected.push({ target: f.target, reason: 'FORMAT_INVALID' }); continue; }
    accepted.push({ field, value: valeur, refs: f.evidenceRefs });
  }
  return { accepted, rejected };
}

const masque = (field: string, v: string | null) => (v && field === 'iban' ? maskIban(v) : v);

/**
 * Seconde chance d'UNE fiche (voir l'en-tête). `dryRun` : rien n'est écrit
 * (ni fiche, ni revue, ni journal). Lève sur une panne de lecture ; l'appelant
 * (abonné T1, contrôle de cohérence) l'absorbe ou la trace.
 */
export async function recoverSupplierCoordinates(p: {
  accountId: number; supplierId: number; trigger: string; campaignId?: number | null; runRef?: string | null;
  dryRun?: boolean; deps?: SupplierRecoveryDeps;
  /** Interne : passage de confirmation après écriture (une fois). */
  confirmation?: boolean;
}): Promise<SupplierRecoveryResult> {
  const deps = p.deps ?? {};
  const vide = (status: SupplierRecoveryResult['status'], contextFp: string | null = null): SupplierRecoveryResult =>
    ({ status, supplierId: p.supplierId, contextFp, written: [], conflicts: 0, abstentions: {}, contractPending: false, aiCalls: 0, runId: null });
  if (!(await supplierRecoveryReady())) return vide('NOT_READY');
  const st = await supplierCoordinatesState(p.accountId, p.supplierId, deps);
  if (!st) return vide('GONE');
  if (st.recorded) return vide('UNCHANGED_CONTEXT', st.contextFp);

  const plan = st.plan.map((x) => ({ ...x }));
  let aiCalls = 0;
  const traces: string[] = [];
  let contractPending = false;
  let rejected: Array<{ target: string; reason: string }> = [];
  let aiFailed: string | null = null;
  // 5. Découpage IA (KNOWLEDGE_QUERY) — seulement si nécessaire et si le contrat est porté.
  if (st.needsSplit.length) {
    if (!st.contract.contractCarried) {
      contractPending = true;
    } else if (p.confirmation) {
      // Passage de confirmation : le découpage vient d'être tenté sur ce même document.
      for (const x of plan) if (st.needsSplit.includes(x.field)) x.cause = 'AI_NOT_FOUND';
    } else if (!p.dryRun) {
      const max = deps.dailyMax ?? (await import('../knowledge-query/store')).knowledgeQueryDailyMax();
      const { sharedKnowledgeCallsLastDay } = await import('./store');
      const now = deps.now?.() ?? new Date();
      const refs = new Set(st.needsSplit.flatMap((f) => st.findings.find((x) => x.field === f)?.splitRefs ?? []));
      const items = st.knowledge.items.filter((i) => refs.has(i.ref));
      if ((await sharedKnowledgeCallsLastDay(p.accountId, now)) >= max) {
        for (const x of plan) if (st.needsSplit.includes(x.field)) x.cause = 'BUDGET_EXHAUSTED';
      } else {
        try {
          const call = deps.call ?? (await import('../knowledge-query/model')).callKnowledgeQueryModel;
          const r = await call({ accountId: p.accountId, sourceIds: [...new Set(items.map((i) => i.fileId))], variables: supplierKnowledgeVariables(st.supplier, st.needsSplit, items) });
          aiCalls += 1;
          if (r.traceId) traces.push(r.traceId);
          const v = validateSupplierFindings(r.output, st.needsSplit, items);
          rejected = v.rejected;
          for (const x of plan) {
            if (!st.needsSplit.includes(x.field)) continue;
            const a = v.accepted.filter((y) => y.field === x.field);
            const distinct = new Set(a.map((y) => y.value.toLowerCase()));
            if (distinct.size === 1) {
              x.value = a[0].value;
              x.action = 'FILL';
              x.cause = null;
              x.finding = { ...x.finding, status: 'ESTABLISHED', value: a[0].value, evidence: items.filter((i) => a[0].refs.includes(i.ref)).map((i) => ({
                ref: i.ref, fileId: i.fileId, layer: i.layer, sourceId: i.sourceId, unitId: i.unitId, extractionId: i.extractionId, page: i.page,
                confidence: i.confidence, attribution: 'ANCHORED_UNIT' as const,
              })) };
            } else x.cause = distinct.size > 1 ? 'EVIDENCE_CONFLICT' : 'AI_NOT_FOUND';
          }
        } catch (e) {
          aiFailed = (e as Error).message.slice(0, 300);
          console.error(`[111X] découpage T3 du fournisseur ${p.supplierId} en échec :`, (e as Error).message);
          for (const x of plan) if (st.needsSplit.includes(x.field)) x.cause = 'AI_FAILED';
        }
      }
    }
  }

  const abstentions: Record<string, SupplierAbstention> = {};
  for (const x of plan) if (x.action === 'ABSTAIN' && x.cause && !x.before) abstentions[x.field] = x.cause;
  const aEcrire = plan.filter((x) => x.action === 'FILL' || x.action === 'CONFLICT');
  if (p.dryRun) {
    return { status: 'DRY_RUN', supplierId: p.supplierId, contextFp: st.contextFp, written: aEcrire.filter((x) => x.action === 'FILL').map((x) => x.field),
      conflicts: aEcrire.filter((x) => x.action === 'CONFLICT').length, abstentions, contractPending, aiCalls: 0, runId: null };
  }

  // 6. Écriture par le writer des fiches (transaction, verrou du référentiel, fiche relue).
  const { db } = await import('@/db');
  const { sql } = await import('drizzle-orm');
  const { supplierContactObservations } = await import('@/db/schema');
  const { consolidateCoordinates, openContactConflicts } = await import('@/services/suppliers/supplier-service');
  const { SUPPLIER_REFERENTIAL_LOCK } = await import('@/services/suppliers/supplier-from-analysis');
  const written: string[] = [];
  let conflicts = 0;
  const outcomes = new Map<string, { decision: string; before: string | null; after: string | null }>();
  if (aEcrire.length) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${SUPPLIER_REFERENTIAL_LOCK}, ${p.accountId})`);
      const [vivant] = (await tx.execute(sql`SELECT id FROM suppliers WHERE id = ${p.supplierId} AND account_id = ${p.accountId} AND status = 'active' FOR UPDATE`)) as unknown as Row[];
      if (!vivant) return;
      const observation: Record<string, string> = {};
      for (const x of aEcrire) if (x.value) observation[x.field] = x.value;
      // Document principal de la preuve (conflit sourcé) : premier document cité.
      const preuve = aEcrire.flatMap((x) => x.finding.evidence)[0] ?? null;
      const [obs] = await tx.insert(supplierContactObservations).values({
        supplierId: p.supplierId, documentId: preuve?.fileId ?? null, observedName: st.supplier.name,
        observedEmail: observation.email ?? null, observedPhone: observation.phone ?? null, observedWebsite: observation.website ?? null,
        observedAddressLine1: observation.addressLine1 ?? null, observedPostalCode: observation.postalCode ?? null, observedCity: observation.city ?? null,
        observedVatNumber: observation.vatNumber ?? null, observedIban: maskIban(observation.iban ?? null),
        origin: 'T3_SECOND_CHANCE',
        evidence: Object.fromEntries(aEcrire.map((x) => [x.field, x.finding.evidence.slice(0, 5)])),
        createdAt: new Date(),
      }).returning({ id: supplierContactObservations.id });
      const r = await consolidateCoordinates(p.supplierId, { name: st.supplier.name, ...observation } as ExtractedSupplierData, {
        q: tx as never,
        provenance: (field) => {
          const x = aEcrire.find((y) => y.field === field);
          const e = x?.finding.evidence[0];
          return e ? { source: 'DOCUMENT', rule: 'T3_SECOND_CHANCE', documentId: e.fileId, extractionId: e.extractionId, ref: e.ref, unitId: e.unitId,
            layer: e.layer, confidence: e.confidence, observationId: obs.id, at: new Date().toISOString() } : null;
        },
      });
      for (const o of r.outcomes) {
        outcomes.set(o.field, { decision: o.decision, before: o.before, after: o.after });
        if (o.decision === 'FILLED') written.push(o.field);
      }
      conflicts = await openContactConflicts(tx as never, {
        accountId: p.accountId, supplierId: p.supplierId, documentId: preuve?.fileId ?? null, observationId: obs.id, conflicts: r.conflicts,
      });
    });
  }

  // 7. Journal : issue du lot puis une décision par champ.
  const store = await import('./store');
  const traceabilite = { contractState: contractStateOf(st.contract), campaignId: p.campaignId ?? null };
  let runId: number | null = null;
  try {
    if (contractPending) {
      await store.saveOutcome({
        accountId: p.accountId, assetId: null, objectType: 'SUPPLIER', objectId: p.supplierId, contextFp: st.contextFp,
        promptVersion: st.contract.version ?? '', contractVersion: SUPPLIER_COORDINATES_CONTRACT_VERSION, batchFp: sha(st.needsSplit),
        properties: st.needsSplit, status: 'CONTRACT_PENDING', trigger: p.trigger, runRef: p.runRef ?? null, ...traceabilite,
        cause: `${contractStateOf(st.contract)}: le prompt T3 actif ne porte pas le contrat ${SUPPLIER_COORDINATES_CONTRACT_VERSION} (demande ${SUPPLIER_COORDINATES_PENDING_CONTRACT}) — découpage d'une unité à plusieurs champs`,
        contextSummary: { documents: st.knowledge.documents.length, items: st.knowledge.items.length, splitRefs: st.findings.flatMap((f) => f.splitRefs ?? []).slice(0, 20) },
      });
    }
    runId = await store.saveRun({
      accountId: p.accountId, assetId: null, objectType: 'SUPPLIER', objectId: p.supplierId, contextFp: st.contextFp,
      promptVersion: '', contractVersion: SUPPLIER_COORDINATES_CONTRACT_VERSION, batchFp: 'deterministic',
      properties: plan.map((x) => x.field), status: aiFailed ? 'AI_FAILED' : written.length || conflicts || aiCalls ? 'ANSWERED' : 'NO_EVIDENCE',
      error: aiFailed, retryAt: aiFailed ? new Date((deps.now?.() ?? new Date()).getTime() + 3_600_000).toISOString() : null,
      pagesTotal: aiCalls, pagesExamined: aiCalls, calls: aiCalls, traceIds: traces,
      contextSummary: {
        documents: st.knowledge.documents.map((d) => d.fileId), items: st.knowledge.items.length, dropped: st.knowledge.dropped,
        written, conflicts, abstentions, contractPending,
      },
      trigger: p.trigger, runRef: p.runRef ?? null, cause: contractPending ? 'CONTRACT_PENDING' : null, ...traceabilite,
    });
    for (const x of plan) {
      const o = outcomes.get(x.field);
      const ecrit = o?.decision === 'FILLED';
      const cause = ecrit ? null : o?.decision === 'CONFLICT' ? 'VALUE_CONFLICT_REVIEW' : o?.decision === 'USER_CLEARED' ? 'USER_CLEARED'
        : o?.decision === 'ADDRESS_MIXED' ? 'ADDRESS_MIXED' : o?.decision === 'SAME' ? 'ALREADY_CONSISTENT' : (x.cause ?? 'NO_EVIDENCE');
      await store.saveDecision({
        runId, accountId: p.accountId, assetId: null, objectType: 'SUPPLIER', objectId: p.supplierId, fieldKey: x.field,
        questionFp: sha([x.field, SUPPLIER_COORDINATES_CONTRACT_VERSION]), contextFp: st.contextFp, promptVersion: '',
        decision: ecrit ? 'WRITTEN' : 'ABSTAINED', cause,
        valueBefore: masque(x.field, o?.before ?? x.before), valueAfter: masque(x.field, o?.after ?? x.before), proposedValue: masque(x.field, x.value),
        findings: x.finding.evidence.slice(0, 10).map((e) => ({ ...e, value: masque(x.field, x.value) })),
        rejected: rejected.filter((y) => y.target === x.field),
        evidenceIds: [], provenance: { status: x.finding.status, candidates: x.finding.candidates, documents: [...new Set(x.finding.evidence.map((e) => e.fileId))] },
        writeOutcome: o?.decision ?? null,
      });
    }
  } catch (e) {
    await store.reportRecoveryStorageUnavailable({ accountId: p.accountId, objectType: 'SUPPLIER', objectId: p.supplierId, status: 'JOURNAL', error: (e as Error).message });
    throw e;
  }

  if (written.length || conflicts) {
    try {
      const { emitBusinessEvent } = await import('@/services/verebona-assistant/events/business-events');
      await emitBusinessEvent({ type: 'SUPPLIER_CHANGED', accountId: p.accountId, entityId: p.supplierId });
    } catch { /* non bloquant */ }
  }
  // Les écritures changent l'empreinte (valeurs actuelles) : un passage de CONFIRMATION, sans IA ni écriture attendue,
  // consigne le nouveau contexte — le contrôle suivant le trouve décidé (aucune relecture sans fin).
  if (!p.confirmation && (written.length || conflicts)) {
    await recoverSupplierCoordinates({ ...p, confirmation: true });
  }
  return { status: 'APPLIED', supplierId: p.supplierId, contextFp: st.contextFp, written, conflicts, abstentions, contractPending, aiCalls, runId };
}
