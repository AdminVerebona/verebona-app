/**
 * Lot 107D — diagnostic et réparation DÉTERMINISTE des prix alimentés par le
 * total d'un justificatif à plusieurs articles, et des arbitrages rouverts
 * sans preuve nouvelle (service métier du contrôle COH-PRICE-MULTI-ARTICLE et
 * du rattrapage du stock). Aucun appel IA.
 *
 * Par BIEN (et ses équipements) :
 *   1. preuves actives du prix (`acquisitionPrice`) dont la valeur est un
 *      montant de transaction d'un justificatif à plusieurs articles
 *      (`screenAmountEvidence`) → RETIRÉES (cycle de vie WITHDRAWN : jamais
 *      supprimées, `status` T3 intact), avant / après journalisés ;
 *   2. pour la cible de cette preuve (bien ou équipement) et ce document :
 *      la ligne qui DÉSIGNE l'objet, si elle est démontrable
 *      (`attributeArticle` sur les unités persistées) → preuve de ligne
 *      (PURCHASE_LINE_ATTRIBUTED) écrite par le chemin commun
 *      (`recordEvidence`, empreinte unique : jamais de doublon) ; sinon
 *      abstention motivée (aucun prix inventé) ;
 *   3. cartes « À arbitrer » ouvertes rouvertes après une décision de
 *      l'utilisateur sans preuve nouvelle indépendante et fiable
 *      (`judgeAgainstUserDecision`) → closes OBSOLETE, tracées ;
 *   4. T3 du bien (et des équipements touchés), sans revue IA : la valeur
 *      automatique erronée est remplacée par la preuve de ligne ou retirée
 *      (réconciliation négative T3-04) ; une valeur USER / ADMIN n'est JAMAIS
 *      modifiée (préséance §4.2.5) ; la carte devenue sans objet est close.
 * Idempotent : rejoué, il ne retrouve plus rien (preuves retirées, preuve de
 * ligne déjà présente, cartes closes).
 */
import { createHash } from 'node:crypto';
import { resolveAuthority } from './decision/authority-matrix';
import { normalize } from './decision/normalizers';
import { evidenceCents, isPriceField, loadReceiptProfile, PRICE_FIELD, screenAmountEvidence, type ExcludedAmountEvidence, type ReceiptProfileCache } from './multi-article-evidence';
import { attributeArticle, ATTRIBUTION_REFUSAL_LABELS, type TargetDescriptor } from '@/services/ai/source-analysis/projection/amount-roles';
import { PROJECTION_RULES } from '@/services/ai/source-analysis/projection/rules';
import type { FieldEvidence } from '../evidence/evidence.types';

type Row = Record<string, unknown>;
type Sql = { unsafe: (q: string, p?: never[]) => Promise<unknown> };
const q = async (sql: Sql, text: string, params: unknown[]): Promise<Row[]> => (await sql.unsafe(text, params as never[])) as Row[];

export interface PriceTargetRef { type: 'ASSET' | 'EQUIPMENT'; id: number }

export interface BasketEvidenceFinding extends ExcludedAmountEvidence {
  target: PriceTargetRef;
}

export interface LineAttributionPlan {
  target: PriceTargetRef;
  fileId: number;
  unitId: string | null;
  excerpt: string;
  cents: number;
  basis: string;
  matchedBy: string;
  confidence: 'certain' | 'probable';
  documentType: string | null;
  documentDate: string | null;
}

export interface ReopenedCardFinding {
  actionId: number;
  targetType: string;
  targetId: number;
  fieldKey: string;
  verdict: string;
  decidedActionId: number | null;
}

export interface AssetPriceDiagnosis {
  assetId: number;
  basketEvidence: BasketEvidenceFinding[];
  lineAttributions: LineAttributionPlan[];
  abstentions: Array<{ target: PriceTargetRef; fileId: number; reason: string; label: string }>;
  /** Valeurs en place des cibles concernées (origine : la réparation ne touche jamais USER / ADMIN). */
  currentValues: Array<{ target: PriceTargetRef; value: unknown; origin: string | null; equalsBasket: boolean }>;
  reopenedCards: ReopenedCardFinding[];
  /** Cartes rouvertes LÉGITIMES (nouvelle preuve indépendante) sans motif conservé (stock). */
  reopenReasonMissing: Array<{ actionId: number; reason: Record<string, unknown> }>;
}

export const hasRepair = (d: AssetPriceDiagnosis): boolean =>
  d.basketEvidence.length > 0 || d.lineAttributions.length > 0 || d.reopenedCards.length > 0 || d.reopenReasonMissing.length > 0;

/** Empreinte des entrées (anti-boucle du registre). */
export function diagnosisFingerprint(d: AssetPriceDiagnosis): string {
  return createHash('sha256').update(JSON.stringify({
    e: d.basketEvidence.map((x) => x.evidenceId).sort(), l: d.lineAttributions.map((x) => `${x.target.type}:${x.target.id}:${x.fileId}:${x.cents}`).sort(),
    c: d.reopenedCards.map((x) => x.actionId).sort(), r: d.reopenReasonMissing.map((x) => x.actionId).sort(),
  })).digest('hex').slice(0, 24);
}

const PRICE_KEYS_SQL = `COALESCE(to_jsonb(fe) ->> 'canonical_key', fe.field_key) IN ('acquisitionPrice')`;

async function priceEvidence(sql: Sql, accountId: number, assetId: number): Promise<Array<FieldEvidence & { target: PriceTargetRef }>> {
  const r = await q(sql, `
    SELECT fe.id, fe.field_key, fe.value_json, fe.source_type, fe.source_id, fe.confidence, fe.document_type, fe.document_date,
           to_jsonb(fe) ->> 'projection_rule' AS projection_rule, to_jsonb(fe) ->> 'target_type' AS target_type,
           (to_jsonb(fe) ->> 'target_entity_id')::bigint AS target_entity_id
      FROM field_evidence fe
     WHERE fe.account_id = $1 AND fe.asset_id = $2 AND fe.status = 'active' AND fe.source_type = 'document'
       AND COALESCE(to_jsonb(fe) ->> 'lifecycle_status', 'ACTIVE') = 'ACTIVE' AND ${PRICE_KEYS_SQL}
     ORDER BY fe.id`, [accountId, assetId]);
  return r.filter((x) => isPriceField(String(x.field_key))).map((x) => {
    const tt = (x.target_type as string | null) ?? 'ASSET';
    const target: PriceTargetRef = tt === 'EQUIPMENT' && x.target_entity_id != null ? { type: 'EQUIPMENT', id: Number(x.target_entity_id) } : { type: 'ASSET', id: assetId };
    return {
      id: Number(x.id), accountId, assetId, fieldKey: PRICE_FIELD, value: x.value_json, sourceType: 'document', sourceId: Number(x.source_id),
      location: {}, excerpt: null, confidence: x.confidence as FieldEvidence['confidence'], authorityScore: 0, status: 'active', extractedAt: new Date(),
      documentType: (x.document_type as string | null) ?? undefined, documentDate: x.document_date ? new Date(String(x.document_date)) : null,
      ...(x.projection_rule ? { projectionRule: String(x.projection_rule) } : {}), target,
    } as FieldEvidence & { target: PriceTargetRef };
  });
}

async function descriptorOf(sql: Sql, accountId: number, t: PriceTargetRef): Promise<TargetDescriptor | null> {
  const r = t.type === 'ASSET'
    ? await q(sql, `SELECT name, key_characteristics AS kc FROM assets WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL`, [t.id, accountId])
    : await q(sql, `SELECT e.name, to_jsonb(e) -> 'key_characteristics' AS kc FROM equipments e JOIN assets a ON a.id = e.asset_id
                     WHERE e.id = $1 AND a.account_id = $2 AND e.archived_at IS NULL`, [t.id, accountId]);
  if (!r[0]) return null;
  const kc = (typeof r[0].kc === 'string' ? JSON.parse(r[0].kc as string) : r[0].kc ?? {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
  return { name: s(r[0].name), brand: s(kc.brand), model: s(kc.modelName) ?? s(kc.model), reference: s(kc.reference) ?? s(kc.productReference), serialNumber: s(kc.serialNumber) };
}

async function currentPrice(sql: Sql, accountId: number, t: PriceTargetRef): Promise<{ value: unknown; origin: string | null }> {
  const r = t.type === 'ASSET'
    ? await q(sql, `SELECT key_characteristics AS kc, purchase_price_cents AS col FROM assets WHERE id = $1 AND account_id = $2`, [t.id, accountId]).catch(() => [])
    : await q(sql, `SELECT to_jsonb(e) -> 'key_characteristics' AS kc, e.purchase_price_cents AS col FROM equipments e WHERE e.id = $1`, [t.id]);
  if (!r[0]) return { value: null, origin: null };
  const kc = (typeof r[0].kc === 'string' ? JSON.parse(r[0].kc as string) : r[0].kc ?? {}) as Record<string, unknown>;
  if (kc[PRICE_FIELD] !== undefined && kc[PRICE_FIELD] !== null && kc[PRICE_FIELD] !== '') {
    return { value: kc[PRICE_FIELD], origin: (kc[`${PRICE_FIELD}__origin`] as string | undefined) ?? 'USER' };
  }
  if (r[0].col != null) return { value: Number(r[0].col) / 100, origin: 'USER' };
  return { value: null, origin: null };
}

/** Diagnostic en LECTURE SEULE d'un bien (et de ses équipements). */
export async function diagnoseAssetPrices(sql: Sql, accountId: number, assetId: number, cache: ReceiptProfileCache = new Map()): Promise<AssetPriceDiagnosis> {
  const d: AssetPriceDiagnosis = { assetId, basketEvidence: [], lineAttributions: [], abstentions: [], currentValues: [], reopenedCards: [], reopenReasonMissing: [] };
  const all = await priceEvidence(sql, accountId, assetId);
  const parCible = new Map<string, Array<FieldEvidence & { target: PriceTargetRef }>>();
  for (const e of all) {
    const k = `${e.target.type}:${e.target.id}`;
    parCible.set(k, [...(parCible.get(k) ?? []), e]);
  }
  for (const evidences of parCible.values()) {
    const target = evidences[0].target;
    const { kept, excluded } = await screenAmountEvidence(accountId, PRICE_FIELD, evidences, cache);
    if (excluded.length === 0) continue;
    d.basketEvidence.push(...excluded.map((x) => ({ ...x, target })));
    const courant = await currentPrice(sql, accountId, target);
    const cents = evidenceCents(courant.value);
    d.currentValues.push({ target, value: courant.value, origin: courant.origin, equalsBasket: cents !== null && excluded.some((x) => x.cents === cents) });
    // Ligne de l'objet, document par document, si aucune preuve retenue ne vient déjà de ce document.
    const descripteur = await descriptorOf(sql, accountId, target);
    for (const fileId of [...new Set(excluded.map((x) => x.sourceId))]) {
      if (kept.some((k) => k.sourceId === fileId)) continue;
      const profil = await loadReceiptProfile(accountId, fileId, cache);
      if (!profil) continue;
      const a = attributeArticle(profil, descripteur);
      if (!a.ok) { d.abstentions.push({ target, fileId, reason: a.reason, label: ATTRIBUTION_REFUSAL_LABELS[a.reason] }); continue; }
      const src = evidences.find((e) => e.sourceId === fileId);
      d.lineAttributions.push({
        target, fileId, unitId: a.article.unitId, excerpt: a.article.text.slice(0, 2000), cents: a.cents, basis: a.basis, matchedBy: a.matchedBy,
        confidence: a.confidence, documentType: src?.documentType ?? null, documentDate: src?.documentDate ? src.documentDate.toISOString() : null,
      });
    }
  }

  // Cartes « À arbitrer » ouvertes du bien et de ses équipements, rouvertes après une décision de l'utilisateur.
  const { PROCESSING_RULES } = await import('@/services/to-process/rules-catalog');
  const reglesT3 = PROCESSING_RULES.filter((r) => r.producer === 'RECONCILIATION_BRIDGE' || r.producer === 'T3_ENTITY_FIELDS').map((r) => r.code);
  const cartes = await q(sql, `
    SELECT t.id, t.target_type, t.target_id, t.field_key, t.proposals_json, to_jsonb(t) -> 'reopen_reason' AS reopen_reason
      FROM to_process_actions t
     WHERE t.account_id = $1 AND t.resolved_at IS NULL AND t.action_kind = 'ARBITRATE' AND t.field_key IS NOT NULL
       AND t.rule_code = ANY($3::text[])
       AND ((t.target_type = 'ASSET' AND t.target_id = $2)
         OR (t.target_type = 'EQUIPMENT' AND t.target_id IN (SELECT e.id FROM equipments e WHERE e.asset_id = $2)))
       AND EXISTS (SELECT 1 FROM to_process_actions p WHERE p.account_id = t.account_id AND p.target_type = t.target_type
                    AND p.target_id = t.target_id AND p.field_key = t.field_key AND p.action_kind = 'ARBITRATE'
                    AND p.resolution_reason IN ('USER_ARBITRATED', 'USER_COMPLETED'))
     ORDER BY t.id`, [accountId, assetId, reglesT3]);
  if (cartes.length) {
    const m = await import('@/services/to-process/arbitration-memory');
    for (const c of cartes) {
      const proposals = (typeof c.proposals_json === 'string' ? JSON.parse(c.proposals_json as string) : c.proposals_json ?? []) as import('@/services/to-process/action-model').ActionProposal[];
      const memoire = await m.loadUserDecisionMemory(accountId, String(c.target_type), Number(c.target_id), String(c.field_key), sql);
      const verdict = m.judgeAgainstUserDecision(memoire, await m.evidenceKeyInfos(accountId, m.proposalEvidenceIds(proposals), sql));
      if (!verdict.reopen && verdict.code !== 'NO_USER_DECISION') {
        d.reopenedCards.push({ actionId: Number(c.id), targetType: String(c.target_type), targetId: Number(c.target_id), fieldKey: String(c.field_key), verdict: verdict.code, decidedActionId: verdict.decidedActionId });
      } else if (verdict.reopen && !c.reopen_reason) {
        d.reopenReasonMissing.push({ actionId: Number(c.id), reason: { code: verdict.code, decidedActionId: verdict.decidedActionId, sources: verdict.sources, at: new Date().toISOString(), backfilled: true } });
      }
    }
  }
  return d;
}

export interface AssetPriceRepairResult {
  evidenceWithdrawn: number[];
  /** Faits canoniques du montant de panier requalifiés (connaissance générique, règle ACQUISITION_PRICE_BASKET_TOTAL). */
  factsRequalified: number[];
  lineEvidenceRecorded: number[];
  cardsClosed: number[];
  reopenReasonsSet: number[];
  t3: Array<{ target: PriceTargetRef; ok: boolean; error?: string }>;
}

/**
 * Réparation DÉTERMINISTE (mode correctif) : jamais une valeur USER / ADMIN,
 * jamais une suppression. `correlationId` : trace du contrôle.
 */
export async function repairAssetPrices(sql: Sql, accountId: number, d: AssetPriceDiagnosis, o: { correlationId: string }): Promise<AssetPriceRepairResult> {
  const out: AssetPriceRepairResult = { evidenceWithdrawn: [], factsRequalified: [], lineEvidenceRecorded: [], cardsClosed: [], reopenReasonsSet: [], t3: [] };
  const touchees = new Map<string, PriceTargetRef>();

  if (d.basketEvidence.length) {
    const r = await q(sql, `
      UPDATE field_evidence SET lifecycle_status = 'WITHDRAWN', superseded_at = now()
       WHERE account_id = $1 AND id = ANY($2::int[]) AND COALESCE(lifecycle_status, 'ACTIVE') = 'ACTIVE'
      RETURNING id`, [accountId, d.basketEvidence.map((x) => x.evidenceId)]);
    out.evidenceWithdrawn = r.map((x) => Number(x.id));
    for (const x of d.basketEvidence) touchees.set(`${x.target.type}:${x.target.id}`, x.target);
    // Faits canoniques du MÊME montant de panier sur ces documents : requalifiés en connaissance générique (même règle
    // que la projection T1, ACQUISITION_PRICE_BASKET_TOTAL) — une reprojection du document ne les recrée plus.
    for (const fileId of [...new Set(d.basketEvidence.map((x) => x.sourceId))]) {
      const montants = new Set(d.basketEvidence.filter((x) => x.sourceId === fileId).map((x) => x.cents));
      const faits = await q(sql, `SELECT id, value_number, value_text, normalized_value FROM document_facts
                                   WHERE account_id = $1 AND file_id = $2 AND status = 'active' AND canonical_key = 'acquisitionPrice'`, [accountId, fileId]).catch(() => []);
      const ids = faits.filter((f) => {
        const c = evidenceCents(f.value_number != null ? Number(f.value_number) : (f.normalized_value ?? f.value_text));
        return c !== null && montants.has(c);
      }).map((f) => Number(f.id));
      if (!ids.length) continue;
      const u = await q(sql, `UPDATE document_facts SET canonical_key = NULL, projection_origin = 'GENERIC', projection_rule = $3,
                                     semantic_event_type = NULL, semantic_event_nature = NULL
                               WHERE account_id = $1 AND id = ANY($2::bigint[]) AND canonical_key = 'acquisitionPrice' RETURNING id`,
      [accountId, ids, PROJECTION_RULES.ACQUISITION_PRICE_BASKET_TOTAL]).catch(() => []);
      out.factsRequalified.push(...u.map((x) => Number(x.id)));
    }
  }

  if (d.lineAttributions.length) {
    const { recordEvidence } = await import('../evidence/field-evidence.service');
    for (const l of d.lineAttributions) {
      const value = l.cents / 100;
      const id = await recordEvidence({
        accountId, assetId: d.assetId, fieldKey: PRICE_FIELD, value, normalizedValue: normalize(PRICE_FIELD, value) ?? undefined,
        sourceType: 'document', sourceId: l.fileId, location: { section: `receipt-line:${l.unitId ?? 'transcription'}:${l.basis}` }, excerpt: l.excerpt,
        documentType: l.documentType ?? undefined, documentDate: l.documentDate ? new Date(l.documentDate) : null, confidence: l.confidence,
        authorityScore: resolveAuthority({ fieldKey: PRICE_FIELD, documentType: l.documentType }).score,
        canonicalKey: PRICE_FIELD, canonicalUnit: 'EUR', rawValue: String(value),
        projectionOrigin: 'DETERMINISTIC_RULE', projectionRule: PROJECTION_RULES.PURCHASE_LINE_ATTRIBUTED,
        target: { type: l.target.type, entityId: l.target.id, label: null, confidence: 'certain' },
      });
      out.lineEvidenceRecorded.push(id);
      touchees.set(`${l.target.type}:${l.target.id}`, l.target);
    }
  }

  for (const c of d.reopenedCards) {
    const r = await q(sql, `
      WITH f AS (
        UPDATE to_process_actions SET resolved_at = now(), resolution_reason = 'OBSOLETE', updated_at = now()
         WHERE id = $1 AND account_id = $2 AND resolved_at IS NULL RETURNING id, target_type, target_id, field_key)
      INSERT INTO to_process_action_events (action_id, account_id, event, target_type, target_id, field_key, details, created_at)
      SELECT f.id, $2, 'OBSOLETE', f.target_type, f.target_id, f.field_key, $3::jsonb, now() FROM f RETURNING action_id`,
    [c.actionId, accountId, JSON.stringify({ reason: 'ALREADY_DECIDED_SAME_EVIDENCE', memory: c.verdict, decidedActionId: c.decidedActionId, correlationId: o.correlationId })]);
    if (r.length) out.cardsClosed.push(c.actionId);
  }

  for (const c of d.reopenReasonMissing) {
    const r = await q(sql, `UPDATE to_process_actions SET reopen_reason = $3::jsonb WHERE id = $1 AND account_id = $2 AND reopen_reason IS NULL RETURNING id`,
      [c.actionId, accountId, JSON.stringify(c.reason)]);
    if (r.length) out.reopenReasonsSet.push(c.actionId);
  }

  // T3 des cibles touchées (sans revue IA) : préséance USER / ADMIN, réconciliation négative, cartes closes.
  for (const t of touchees.values()) {
    try {
      if (t.type === 'ASSET') {
        const { reconcileAsset } = await import('./reconciliation-engine');
        await reconcileAsset({ accountId, assetId: t.id, triggeredBy: 'manual', aiReview: false });
      } else {
        const { reconcileEntity } = await import('./entity-reconciliation');
        await reconcileEntity({ accountId, target: { type: 'EQUIPMENT', id: t.id }, triggeredBy: 'manual', sourceFileId: null });
      }
      out.t3.push({ target: t, ok: true });
    } catch (e) {
      const { isExecutionCancelled } = await import('../queue/execution-control');
      if (isExecutionCancelled(e)) throw e;
      out.t3.push({ target: t, ok: false, error: (e as Error).message.slice(0, 300) });
    }
  }
  return out;
}
