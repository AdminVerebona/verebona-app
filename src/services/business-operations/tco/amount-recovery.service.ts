/**
 * Lot 108B — récupération automatique des montants inconnus : LECTURES des
 * sources persistées, ÉCRITURES déléguées (montant du document, état de la
 * récupération, relance T1 par la file existante) et VUE du TCO.
 *
 * Appelé par le contrôle de cohérence `COH-TCO-AMOUNT-RECOVERY` (campagne
 * quotidienne et contrôle ciblé à chaque analyse / modification du document,
 * comptes ÉLIGIBLES uniquement) — JAMAIS à la consultation : `readAssetTco`
 * ne fait que LIRE l'état persisté (`attachAmountRecovery`), sans IA, sans
 * relecture de fichier, sans écriture.
 *
 * Règles de décision : `amount-recovery.ts` (pures). Moteur financier : le
 * même (`qualifyDocumentLines` décide qu'un montant est inconnu ; le TCO,
 * recalculé à la lecture, compte le montant retrouvé UNE fois — aucun second
 * moteur, aucune Opération créée).
 */
import { sql as dsql, type SQL } from 'drizzle-orm';
import type postgres from 'postgres';
import {
  AMOUNT_RECOVERY_PENDING_STATES, AMOUNT_RECOVERY_RULES_VERSION, amountRecoveryLimits, planAmountRecovery, roleOfHint, textTotalsOfProfile, viewStateOf,
  warningsAfterRecovery,
  type AmountRecoveryAction, type AmountRecoveryLimits, type AmountRecoveryLiveJob, type AmountRecoveryRow, type AmountRecoveryStatus, type AmountRecoveryViewItem,
  type AmountSourceCandidate, type TcoAmountRecoveryView,
} from './amount-recovery';
import type { TcoResult } from './model';

type Sql = postgres.Sql;
type Row = Record<string, unknown>;

/** Origine des relances T1 (traces d'exécution, file T1). */
export const AMOUNT_RECOVERY_T1_ORIGIN = 'tco-amount-recovery';
/** Service journalisé par le contrôle (compté dans le budget commun des relances IA de la cohérence). */
export const AMOUNT_RECOVERY_T1_SERVICE = 'requestAmountRecoveryT1';
/** Écriture déterministe du montant retrouvé (aucun appel IA). */
export const AMOUNT_RECOVERY_APPLY_SERVICE = 'applyRecoveredDocumentAmount';

const q = async (sql: Sql, text: string, params: readonly unknown[] = []): Promise<Row[]> =>
  (await sql.unsafe(text, params.map((v) => (v instanceof Date ? v.toISOString() : v)) as never[])) as unknown as Row[];
const n = (v: unknown): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const txt = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));
const ints = (ids: readonly number[]): number[] => [...new Set(ids.filter((x) => Number.isSafeInteger(x) && x > 0))];
const asObj = (v: unknown): Record<string, unknown> => {
  if (typeof v === 'string') { try { return JSON.parse(v) as Record<string, unknown>; } catch { return {}; } }
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
};

export async function amountRecoveryTableReady(sql: Sql): Promise<boolean> {
  const [r] = await q(sql, `SELECT to_regclass('public.document_amount_recoveries') IS NOT NULL AS ok`);
  return r?.ok === true;
}

// ── Détection : justificatifs financiers sans montant exploitable ───────────

/**
 * SQL des documents CANDIDATS du compte (préfiltre ; la décision « montant
 * inconnu » reste celle du moteur TCO) : vivants, rattachés à un bien vivant,
 * sans montant et de type financier (même filtre que la lecture du TCO), ou
 * dont une récupération est encore ouverte.
 */
export const AMOUNT_RECOVERY_CANDIDATES_SQL = (expenseCodes: string, invoiceLike: string, extra: string, tail = '') => `
  SELECT f.id FROM asset_files f
   WHERE f.account_id = $1 AND f.deleted_at IS NULL AND f.grouped_into_file_id IS NULL ${extra}
     AND EXISTS (SELECT 1 FROM assets a WHERE a.account_id = f.account_id AND a.deleted_at IS NULL
                  AND (a.id = f.asset_id OR a.id = f.linked_asset_id
                       OR a.id IN (SELECT l.asset_id FROM document_asset_links l WHERE l.account_id = f.account_id AND l.file_id = f.id AND l.status = 'ACTIVE')))
     AND ((f.amount_cents IS NULL AND (f.document_type_code = ANY('${expenseCodes}'::text[]) OR concat_ws(' ', f.document_type_code, f.document_type) ~* '${invoiceLike}'))
          OR EXISTS (SELECT 1 FROM document_amount_recoveries r WHERE r.file_id = f.id AND r.account_id = f.account_id AND r.status IN ('PENDING', 'T1_PENDING', 'TECHNICAL_FAILURE')))
   ${tail}`;

/** Arguments SQL des types financiers (codes V2 de dépense, motif facture / ticket du moteur). */
export async function expenseTypeFilters(): Promise<{ codes: string; invoiceLike: string }> {
  // Lot 111V (§D) : seuls les types qui portent un montant par nature (jamais un contrat, une attestation, un PV).
  const { AMOUNT_EXPECTED_V2_CODES } = await import('@/services/verebona-assistant/canonical/expense-classes');
  return { codes: `{${AMOUNT_EXPECTED_V2_CODES.map((c) => `"${c.replace(/["\\']/g, '')}"`).join(',')}}`, invoiceLike: '(INVOICE|FACTURE|TICKET)' };
}

interface DocumentState {
  fileId: number;
  title: string;
  amountCents: number | null;
  userEditedAmount: boolean;
  analysisState: string | null;
  hash: string | null;
  currency: string | null;
  amountUnknown: boolean;
  /** Lot 111V : le moteur produit une ligne économique pour ce document (faux : plus aucun montant attendu). */
  financialDocument: boolean;
}

/** Documents du compte et décision du MOTEUR TCO (`AMOUNT_UNKNOWN`), sans aucune seconde règle. */
async function documentStates(sql: Sql, accountId: number, ids: readonly number[], today: string): Promise<Map<number, DocumentState>> {
  const out = new Map<number, DocumentState>();
  const base = await q(sql, `
    SELECT f.id, f.amount_cents, f.analysis_state, f.sha256_hash,
           COALESCE(f.user_edited_fields->>'amountCents', 'false') = 'true' AS user_amount,
           (SELECT upper(trim(x.currency)) FROM document_extractions x WHERE x.file_id = f.id AND x.account_id = f.account_id ORDER BY x.id DESC LIMIT 1) AS currency
      FROM asset_files f WHERE f.account_id = $1 AND f.id = ANY($2::int[]) AND f.deleted_at IS NULL`, [accountId, ints(ids)]);
  if (!base.length) return out;
  const [{ readEconomicDocuments }, { qualifyDocumentLines }, { db }] = await Promise.all([
    import('./service'), import('../finance/economic-lines'), import('@/db'),
  ]);
  const { documents } = await readEconomicDocuments(db, accountId, { fileIds: base.map((b) => Number(b.id)) });
  const titres = new Map(documents.map((d) => [d.fileId, d.title]));
  const lignes = qualifyDocumentLines(documents, { today });
  // Lot 111V (§D) : « aucune dépense sur ce document » confirmé par l'utilisateur (clé du montant inconnu) — plus
  // aucun montant attendu : jamais de relecture (décision prioritaire, réversible depuis la fiche).
  const confirmes = new Set((await q(sql, `
    SELECT DISTINCT file_id FROM asset_cost_line_decisions
     WHERE account_id = $1 AND file_id = ANY($2::int[]) AND decision = 'CONFIRM_EXCLUSION' AND line_key ~ '^f:[0-9]+:[A-Z_]+:0:'`,
  [accountId, base.map((b) => Number(b.id))]).catch(() => [] as Row[])).map((r) => Number(r.file_id)));
  const inconnus = new Set(lignes.filter((d) => d.reason === 'AMOUNT_UNKNOWN' && !confirmes.has(d.fileId)).map((d) => d.fileId));
  const financiers = new Set(lignes.filter((d) => !(d.reason === 'AMOUNT_UNKNOWN' && confirmes.has(d.fileId))).map((d) => d.fileId));
  for (const b of base) {
    const id = Number(b.id);
    out.set(id, {
      fileId: id, title: titres.get(id) ?? 'Document', amountCents: n(b.amount_cents), userEditedAmount: b.user_amount === true,
      analysisState: txt(b.analysis_state), hash: txt(b.sha256_hash), currency: txt(b.currency), amountUnknown: inconnus.has(id),
      financialDocument: financiers.has(id),
    });
  }
  return out;
}

// ── Sources persistées (aucune IA, aucune relecture du fichier) ─────────────

/**
 * Montants candidats d'un document, avec rôle, confiance et preuve :
 * extraction T1, unité « montant » de la couche A, candidats T1 ACTIFS non
 * établis (propositions), composante d'un événement de référence qui ne cite
 * QUE ce document, totaux de la transcription persistée (rôles du lot 107).
 */
export async function persistedAmountSources(sql: Sql, accountId: number, fileId: number, currency: string | null): Promise<AmountSourceCandidate[]> {
  const out: AmountSourceCandidate[] = [];
  // Unité « montant » (couche A) : porte la confiance T1 du montant du document.
  const meta = await q(sql, `
    SELECT u.source_unit_id, u.payload FROM document_source_units u
     WHERE u.account_id = $1 AND u.file_id = $2 AND u.kind = 'DOCUMENT_METADATA' AND u.payload->>'field' = 'amount'
     ORDER BY u.ordinal LIMIT 5`, [accountId, fileId]).catch(() => [] as Row[]);
  let confianceT1: AmountSourceCandidate['confidence'] = 'probable';
  for (const m of meta) {
    const p = asObj(m.payload);
    const cents = n(p.cents);
    if (cents === null || cents === 0) continue;
    const conf = p.confidence === 'certain' || p.confidence === 'conflictual' ? p.confidence : 'probable';
    confianceT1 = conf as AmountSourceCandidate['confidence'];
    out.push({ kind: 'T1_METADATA_UNIT', cents: Math.abs(cents), currency, role: cents < 0 ? 'CREDIT_NOTE' : 'DOCUMENT_TOTAL', confidence: confianceT1, ref: `unit:${String(m.source_unit_id)}` });
  }
  const [x] = await q(sql, `SELECT id, amount_cents FROM document_extractions WHERE account_id = $1 AND file_id = $2 ORDER BY id DESC LIMIT 1`, [accountId, fileId]);
  const ex = n(x?.amount_cents);
  if (x && ex !== null && ex !== 0) {
    out.push({ kind: 'T1_EXTRACTION', cents: Math.abs(ex), currency, role: ex < 0 ? 'CREDIT_NOTE' : 'DOCUMENT_TOTAL', confidence: confianceT1, ref: `extraction:${String(x.id)}` });
  }
  // Candidats T1 ACTIFS non établis : indices de montant (propositions — la barrière T1 ne les a pas qualifiés).
  for (const c of await q(sql, `
    SELECT c.id, c.payload FROM document_operation_candidates c
     WHERE c.account_id = $1 AND c.file_id = $2 AND c.status = 'ACTIVE' ORDER BY c.id LIMIT 20`, [accountId, fileId])) {
    const hints = asObj(c.payload).financialHints;
    if (!Array.isArray(hints)) continue;
    hints.forEach((h, i) => {
      const o = asObj(h);
      const cents = n(o.amountMinor);
      const role = roleOfHint(String(o.role ?? ''), txt(o.amountScope));
      if (cents === null || cents <= 0 || !role) return;
      out.push({ kind: 'T1_CANDIDATE', cents, currency: txt(o.currency) ?? currency, role, confidence: 'uncorroborated', ref: `candidate:${String(c.id)}:${i}` });
    });
  }
  // Composante d'un événement de référence actif qui ne cite QUE ce justificatif (montant consolidé par T3 depuis lui).
  for (const c of await q(sql, `
    SELECT c.id, c.kind, c.amount_minor, trim(c.currency) AS currency FROM business_operation_financial_components c
      JOIN business_operations o ON o.id = c.operation_id AND o.account_id = c.account_id AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
     WHERE c.account_id = $1 AND c.active AND c.kind IN ('REALIZED_COST', 'REDUCTION') AND c.amount_minor > 0
       AND EXISTS (SELECT 1 FROM business_operation_financial_component_sources cs JOIN business_operation_sources s ON s.id = cs.operation_source_id AND s.active
                    WHERE cs.component_id = c.id AND s.source_kind = 'DOCUMENT' AND s.source_entity_key = $2::text)
       AND NOT EXISTS (SELECT 1 FROM business_operation_financial_component_sources cs JOIN business_operation_sources s ON s.id = cs.operation_source_id AND s.active
                        WHERE cs.component_id = c.id AND (s.source_kind <> 'DOCUMENT' OR s.source_entity_key <> $2::text))
     ORDER BY c.id LIMIT 20`, [accountId, String(fileId)])) {
    out.push({ kind: 'OPERATION_COMPONENT', cents: Number(c.amount_minor), currency: txt(c.currency), role: c.kind === 'REDUCTION' ? 'CREDIT_NOTE' : 'TOTAL_TTC', confidence: 'probable', ref: `component:${String(c.id)}` });
  }
  // Transcription persistée : total TTC (recoupé), HT, TVA, acompte, paiement — rôles du lot 107.
  try {
    const { loadReceiptProfile } = await import('@/services/ai/reconciliation/multi-article-evidence');
    out.push(...textTotalsOfProfile(await loadReceiptProfile(accountId, fileId), currency));
  } catch { /* profil illisible : aucune source texte (prudence) */ }
  return out;
}

// ── État persisté, empreinte, file T1 ──────────────────────────────────────

const rowOf = (r: Row): AmountRecoveryRow & { fileId: number } => ({
  fileId: Number(r.file_id), status: String(r.status) as AmountRecoveryStatus, fingerprint: txt(r.fingerprint),
  fingerprintAttempts: Number(r.fingerprint_attempts ?? 0), totalAttempts: Number(r.total_attempts ?? 0),
  technicalFailures: Number(r.technical_failures ?? 0),
  lastRequestedAt: r.last_requested_at ? new Date(r.last_requested_at as string).toISOString() : null,
});

async function recoveryRows(sql: Sql, accountId: number, ids: readonly number[]): Promise<Map<number, AmountRecoveryRow>> {
  const out = new Map<number, AmountRecoveryRow>();
  for (const r of await q(sql, `SELECT * FROM document_amount_recoveries WHERE account_id = $1 AND file_id = ANY($2::int[])`, [accountId, ints(ids)])) {
    out.set(Number(r.file_id), rowOf(r));
  }
  return out;
}

/** Signature de la configuration T1 effective (prompt maître, modèle) : une évolution rouvre une tentative. */
export async function t1TreatmentSignature(): Promise<string> {
  try {
    const { effectiveMasterPromptInfo, resolveTreatmentConfig } = await import('@/services/ai/config/config-resolver');
    const [p, c] = await Promise.all([effectiveMasterPromptInfo('T1'), resolveTreatmentConfig('T1')]);
    return `${p.version}|${c?.primaryModel ?? 'défaut'}`;
  } catch {
    return 'inconnue';
  }
}

export function recoveryFingerprint(hash: string | null, t1Signature: string, hashOf: (v: unknown) => string): string {
  return hashOf({ file: hash ?? 'sans-empreinte', t1: t1Signature, rules: AMOUNT_RECOVERY_RULES_VERSION });
}

async function liveT1Jobs(sql: Sql, ids: readonly number[]): Promise<Set<number>> {
  const r = await q(sql, `
    SELECT DISTINCT target_id FROM ai_job_queue WHERE treatment = 'T1' AND target_type = 'asset_file'
       AND target_id = ANY($1::text[]) AND status IN ('PENDING', 'RUNNING')`, [ints(ids).map(String)]).catch(() => [] as Row[]);
  return new Set(r.map((x) => Number(x.target_id)));
}

// ── Diagnostic (lecture seule) ─────────────────────────────────────────────

export interface AmountRecoveryDiagnosis {
  fileId: number;
  document: DocumentState | null;
  row: AmountRecoveryRow | null;
  sources: AmountSourceCandidate[];
  fingerprint: string;
  action: AmountRecoveryAction;
}

/**
 * Diagnostic de documents du compte (LECTURE SEULE). `t1Allowed` : droits du
 * compte (le TCO y est visible) ; `budgetLeft` : budget commun des relances
 * IA de la cohérence.
 */
export async function diagnoseAmountRecovery(sql: Sql, accountId: number, ids: readonly number[], o: {
  now: Date; today: string; t1Allowed: boolean; budgetLeft: boolean; hashOf: (v: unknown) => string; limits?: AmountRecoveryLimits;
}): Promise<Map<number, AmountRecoveryDiagnosis>> {
  const out = new Map<number, AmountRecoveryDiagnosis>();
  const limits = o.limits ?? amountRecoveryLimits();
  const docs = await documentStates(sql, accountId, ids, o.today);
  const etats = await recoveryRows(sql, accountId, ids);
  const vivants = await liveT1Jobs(sql, ids);
  const signature = await t1TreatmentSignature();
  for (const id of ints(ids)) {
    const d = docs.get(id) ?? null;
    const row = etats.get(id) ?? null;
    const fingerprint = recoveryFingerprint(d?.hash ?? null, signature, o.hashOf);
    if (!d) { out.set(id, { fileId: id, document: null, row, sources: [], fingerprint, action: { kind: 'NONE', state: row?.status ?? null } }); continue; }
    const sources = d.amountUnknown && !d.userEditedAmount ? await persistedAmountSources(sql, accountId, id, d.currency) : [];
    const action = planAmountRecovery({
      fileId: id, amountUnknown: d.amountUnknown, financialDocument: d.financialDocument, amountCents: d.amountCents, userEditedAmount: d.userEditedAmount,
      analysisState: d.analysisState, t1JobLive: vivants.has(id), sources, row, fingerprint,
      t1Allowed: o.t1Allowed, budgetLeft: o.budgetLeft, now: o.now, limits,
    });
    out.set(id, { fileId: id, document: d, row, sources, fingerprint, action });
  }
  return out;
}

// ── Écritures (mode correctif du contrôle, ou journal de son issue) ────────

const MAX_PROPOSALS = 10;
const propositions = (l: readonly AmountSourceCandidate[]) => JSON.stringify(l.slice(0, MAX_PROPOSALS).map((s) => ({ cents: s.cents, currency: s.currency, role: s.role, kind: s.kind, confidence: s.confidence, ref: s.ref })));

async function upsertState(sql: Sql, accountId: number, fileId: number, set: {
  status: AmountRecoveryStatus; amountCents?: number | null; currency?: string | null; role?: string | null; sourceKind?: string | null; sourceRef?: string | null;
  previousAmountCents?: number | null; proposals?: string; fingerprint?: string | null; resolved?: boolean; errorCode?: string | null; detail?: Record<string, unknown>;
  /** Relance demandée : tentative comptée (`metier` : tentative sur l'empreinte et au total ; sinon reprise technique). */
  relaunch?: { metier: boolean };
  /** Échec technique constaté (compté une seule fois : transition depuis T1_PENDING). */
  technicalFailure?: boolean;
}): Promise<void> {
  await q(sql, `
    INSERT INTO document_amount_recoveries AS t (account_id, file_id, status, amount_cents, currency, amount_role, source_kind, source_ref, previous_amount_cents,
                                            proposals, fingerprint, fingerprint_attempts, total_attempts, technical_failures, last_error_code,
                                            last_requested_at, resolved_at, detail)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10::jsonb, '[]'::jsonb), $11,
            CASE WHEN $12::boolean THEN 1 ELSE 0 END, CASE WHEN $12::boolean THEN 1 ELSE 0 END,
            CASE WHEN $14::boolean THEN 1 ELSE 0 END, $15,
            CASE WHEN $13::boolean THEN NOW() END, CASE WHEN $16::boolean THEN NOW() END, COALESCE($17::jsonb, '{}'::jsonb))
    ON CONFLICT (file_id) DO UPDATE SET
      account_id = EXCLUDED.account_id,
      status = EXCLUDED.status,
      amount_cents = COALESCE(EXCLUDED.amount_cents, CASE WHEN EXCLUDED.status = 'RECOVERED' THEN t.amount_cents END),
      currency = COALESCE(EXCLUDED.currency, t.currency),
      amount_role = COALESCE(EXCLUDED.amount_role, t.amount_role),
      source_kind = COALESCE(EXCLUDED.source_kind, t.source_kind),
      source_ref = COALESCE(EXCLUDED.source_ref, t.source_ref),
      previous_amount_cents = COALESCE(EXCLUDED.previous_amount_cents, t.previous_amount_cents),
      proposals = CASE WHEN $10::jsonb IS NULL THEN t.proposals ELSE EXCLUDED.proposals END,
      -- Tentatives : une nouvelle empreinte remet le compteur de l'empreinte à zéro (source / modèle / traitement changés).
      fingerprint_attempts = CASE WHEN NOT $13::boolean THEN t.fingerprint_attempts
                                  WHEN NOT $12::boolean THEN t.fingerprint_attempts
                                  WHEN t.fingerprint IS DISTINCT FROM EXCLUDED.fingerprint THEN 1 ELSE t.fingerprint_attempts + 1 END,
      total_attempts = t.total_attempts + CASE WHEN $13::boolean AND $12::boolean THEN 1 ELSE 0 END,
      fingerprint = COALESCE(EXCLUDED.fingerprint, t.fingerprint),
      technical_failures = t.technical_failures + CASE WHEN $14::boolean AND t.status = 'T1_PENDING' THEN 1 ELSE 0 END,
      last_error_code = CASE WHEN EXCLUDED.status = 'RECOVERED' THEN NULL ELSE COALESCE(EXCLUDED.last_error_code, t.last_error_code) END,
      last_requested_at = CASE WHEN $13::boolean THEN NOW() ELSE t.last_requested_at END,
      resolved_at = CASE WHEN $16::boolean THEN NOW() WHEN EXCLUDED.status IN ('PENDING', 'T1_PENDING') THEN NULL ELSE t.resolved_at END,
      detail = t.detail || COALESCE($17::jsonb, '{}'::jsonb),
      updated_at = NOW()`,
  [accountId, fileId, set.status, set.amountCents ?? null, set.currency ?? null, set.role ?? null, set.sourceKind ?? null, set.sourceRef ?? null,
    set.previousAmountCents ?? null, set.proposals ?? null, set.fingerprint ?? null, set.relaunch?.metier ?? false, !!set.relaunch,
    !!set.technicalFailure, set.errorCode ?? null, !!set.resolved, set.detail ? JSON.stringify(set.detail) : null]);
}

/**
 * Montant ÉTABLI → posé sur le document (seulement s'il est encore inconnu et
 * jamais sur une saisie de l'utilisateur), preuve et provenance consignées,
 * événement « document modifié » (TCO, T2, contrôles dépendants recalculés).
 * Rend `false` si le document a changé entre-temps (aucune écriture).
 */
export async function applyRecoveredAmount(sql: Sql, accountId: number, d: AmountRecoveryDiagnosis): Promise<{ applied: boolean; amountCents: number | null }> {
  if (d.action.kind !== 'APPLY') return { applied: false, amountCents: null };
  const c = d.action.candidate;
  // Avoir : montant documentaire négatif (convention T1), lu en valeur absolue par le moteur avec le rôle « avoir ».
  const valeur = c.role === 'CREDIT_NOTE' ? -c.cents : c.cents;
  const maj = await q(sql, `
    UPDATE asset_files SET amount_cents = $3, updated_at = NOW()
     WHERE id = $2 AND account_id = $1 AND deleted_at IS NULL AND amount_cents IS NULL
       AND COALESCE(user_edited_fields->>'amountCents', 'false') <> 'true'
     RETURNING id`, [accountId, d.fileId, valeur]);
  if (!maj.length) return { applied: false, amountCents: null };
  await upsertState(sql, accountId, d.fileId, {
    status: 'RECOVERED', amountCents: valeur, currency: c.currency, role: c.role, sourceKind: c.kind, sourceRef: c.ref, resolved: true,
    proposals: propositions(d.action.corroboratedBy), fingerprint: d.fingerprint,
    detail: { appliedBy: AMOUNT_RECOVERY_APPLY_SERVICE, rules: AMOUNT_RECOVERY_RULES_VERSION, corroboratedBy: d.action.corroboratedBy.map((s) => `${s.kind}:${s.ref}`).slice(0, MAX_PROPOSALS) },
  });
  const { emitBusinessEvent } = await import('@/services/verebona-assistant/events/business-events');
  await emitBusinessEvent({ type: 'DOCUMENT_UPDATED', accountId, entityId: d.fileId }).catch(() => undefined);
  return { applied: true, amountCents: valeur };
}

/** Montant apparu après la relance T1 (ou saisi) : provenance consignée, aucune écriture du document. */
export async function recordRecoveryResult(sql: Sql, accountId: number, d: AmountRecoveryDiagnosis): Promise<void> {
  if (d.action.kind !== 'RECORD_RESULT') return;
  const parT1 = d.row?.status === 'T1_PENDING' || d.row?.status === 'TECHNICAL_FAILURE' || (d.row?.totalAttempts ?? 0) > 0;
  if (d.action.state === 'NOT_APPLICABLE') {
    // Lot 111V : récupération close sans objet (document descriptif, ou aucune dépense confirmée par l'utilisateur).
    await upsertState(sql, accountId, d.fileId, { status: 'NOT_APPLICABLE', sourceKind: 'DOCUMENT', sourceRef: `file:${d.fileId}`, resolved: true, errorCode: 'NO_AMOUNT_EXPECTED' });
    return;
  }
  await upsertState(sql, accountId, d.fileId, {
    status: d.action.state, amountCents: d.action.amountCents, currency: d.document?.currency ?? null,
    role: d.action.amountCents == null ? 'T1_FINANCIAL_HINTS' : d.action.amountCents < 0 ? 'CREDIT_NOTE' : 'DOCUMENT_TOTAL',
    sourceKind: d.action.state === 'USER_OWNED' ? 'USER' : parT1 ? 'T1_RELAUNCH' : 'DOCUMENT', sourceRef: `file:${d.fileId}`, resolved: true,
  });
}

/** Relance T1 du document ORIGINAL par la file existante (traitement technique, non facturé, reprise de l'exécution). */
export async function requestT1Relaunch(sql: Sql, accountId: number, d: AmountRecoveryDiagnosis): Promise<{ queued: boolean }> {
  if (d.action.kind !== 'RELAUNCH_T1') return { queued: false };
  const { enqueueFileAnalyses } = await import('@/services/ai/source-analysis/queue/t1-handler');
  const acceptes = await enqueueFileAnalyses([d.fileId], accountId, {
    origin: AMOUNT_RECOVERY_T1_ORIGIN, billable: false, processingVisibility: 'TECHNICAL', resume: true,
  });
  // Refus de mise en file (déjà en file : la déduplication du WF-10 l'a écartée) — vérifié, jamais présumé.
  const vivant = acceptes.includes(d.fileId) || (await liveT1Jobs(sql, [d.fileId])).has(d.fileId);
  if (!vivant) throw new Error('relance T1 refusée par la file');
  await upsertState(sql, accountId, d.fileId, {
    status: 'T1_PENDING', fingerprint: d.fingerprint, relaunch: { metier: !d.action.retryAfterTechnical },
    proposals: propositions(d.sources), detail: { lastRelaunch: { attempt: d.action.attempt, technicalRetry: d.action.retryAfterTechnical, rules: AMOUNT_RECOVERY_RULES_VERSION } },
  });
  return { queued: acceptes.includes(d.fileId) };
}

/** Issue non réparée (attente, échec réel ou technique) consignée — idempotent (compteurs sur transition). */
export async function recordRecoveryOutcome(sql: Sql, accountId: number, d: AmountRecoveryDiagnosis, o: { dryRun: boolean }): Promise<void> {
  const a = d.action;
  if (a.kind === 'WAIT') {
    // Relance en cours : l'état T1_PENDING est conservé ; sinon « en attente » (recherche ou budget).
    await upsertState(sql, accountId, d.fileId, { status: a.state, errorCode: a.reason });
    return;
  }
  if (a.kind === 'FAIL') {
    await upsertState(sql, accountId, d.fileId, {
      status: a.state, errorCode: a.reason, proposals: propositions(a.proposals), technicalFailure: a.reason === 'T1_RELAUNCH_FAILED' || a.reason === 'TECHNICAL_FAILURES_EXHAUSTED',
      resolved: a.state !== 'TECHNICAL_FAILURE',
    });
    return;
  }
  // Mode à blanc : la récupération est prévue, rien n'est écrit sur le document.
  if (o.dryRun && (a.kind === 'APPLY' || a.kind === 'RELAUNCH_T1')) {
    await upsertState(sql, accountId, d.fileId, { status: d.row?.status === 'T1_PENDING' ? 'T1_PENDING' : 'PENDING', errorCode: 'DRY_RUN' });
  }
}

// ── Vue du TCO (lecture seule, à la consultation) ──────────────────────────

interface Runner { execute: (q: SQL) => Promise<unknown> }

/**
 * Lecture seule de l'état persisté des justificatifs sans montant du TCO —
 * aucune IA, aucune relecture, aucune écriture (consultation). Remplace
 * l'alerte « montant illisible » par un état neutre tant que la
 * récupération n'a pas réellement échoué (`warningsAfterRecovery`).
 */
export async function attachAmountRecovery<T extends TcoResult>(r: Runner, accountId: number, t: T, limits: AmountRecoveryLimits = amountRecoveryLimits()): Promise<T> {
  const inconnus = new Map<number, string>();
  // Lot 111V : une ligne dont l'utilisateur a confirmé qu'elle ne porte aucune dépense n'attend plus de montant.
  for (const l of t.lines) {
    if (!l.amountUnknown || l.fileId == null || inconnus.has(l.fileId)) continue;
    if (l.userDecision?.applied && l.userDecision.decision === 'CONFIRM_EXCLUSION') continue;
    inconnus.set(l.fileId, l.label);
  }
  if (!inconnus.size) return t;
  const ids = `{${[...inconnus.keys()].join(',')}}`;
  let etats = new Map<number, Pick<AmountRecoveryRow, 'status' | 'technicalFailures' | 'lastRequestedAt'>>();
  try {
    const lus = (await r.execute(dsql`
      SELECT file_id, status, technical_failures, last_requested_at FROM document_amount_recoveries
       WHERE account_id = ${accountId} AND file_id = ANY(${ids}::int[])`)) as unknown as Row[];
    etats = new Map(lus.map((x) => [Number(x.file_id), {
      status: String(x.status) as AmountRecoveryStatus, technicalFailures: Number(x.technical_failures ?? 0),
      lastRequestedAt: x.last_requested_at ? new Date(x.last_requested_at as string).toISOString() : null,
    }]));
  } catch {
    // Table absente (déploiement en cours) : comportement antérieur, alerte inchangée.
    return t;
  }
  // Lot 111V (§D) : file RÉELLE — un travail T1 vivant pour ce document (lecture seule, aucune mise en file ici).
  const travaux = new Map<number, AmountRecoveryLiveJob>();
  try {
    const lus = (await r.execute(dsql`
      SELECT DISTINCT ON (target_id) target_id, status, available_at FROM ai_job_queue
       WHERE treatment = 'T1' AND target_type = 'asset_file' AND account_id = ${accountId}
         AND target_id = ANY(${`{${[...inconnus.keys()].map(String).join(',')}}`}::text[]) AND status IN ('PENDING', 'RUNNING')
       ORDER BY target_id, (status = 'RUNNING') DESC, id DESC`)) as unknown as Row[];
    for (const x of lus) {
      travaux.set(Number(x.target_id), { status: String(x.status) as AmountRecoveryLiveJob['status'], availableAt: x.available_at ? new Date(x.available_at as string).toISOString() : null });
    }
  } catch { /* file illisible : aucun travail présumé (jamais « en cours » par défaut) */ }
  const items: AmountRecoveryViewItem[] = [...inconnus].map(([fileId, title]) => {
    const v = viewStateOf(etats.get(fileId) ?? null, limits, travaux.get(fileId) ?? null);
    return { fileId, title, state: v.state, ...(v.nextAttemptAt ? { nextAttemptAt: v.nextAttemptAt } : {}) };
  });
  const view: TcoAmountRecoveryView = {
    items, inProgress: items.filter((i) => AMOUNT_RECOVERY_PENDING_STATES.has(i.state)).length,
    toConfirm: items.filter((i) => i.state === 'TO_CONFIRM').length, notFound: items.filter((i) => i.state === 'NOT_FOUND').length,
  };
  return { ...t, amountRecovery: view, reliability: { ...t.reliability, warnings: warningsAfterRecovery(t.reliability.warnings, view) } };
}
