/**
 * MIG-01 — canonicalisation des alias connus (CDC 15 §14 point 1, T1-03,
 * D-10) dans `keyCharacteristics`, `document_facts` et `field_evidence`,
 * sans perdre la valeur brute ni la provenance.
 *
 * RÈGLES EXACTES
 *
 * A. `keyCharacteristics` (par bien, famille du bien) — alias résolu par le
 *    registre (`indexKcAliases`) :
 *    · clé canonique VIDE, un seul alias renseigné (ou plusieurs de même
 *      valeur normalisée) → APPLIED : la clé canonique reçoit la valeur
 *      NORMALISÉE (unité du registre : `purchasePriceCents` → euros) ; la
 *      provenance de l'alias est recopiée (`__origin` — ou l'ancien
 *      `_origin` converti —, `__updatedAt`, `__source`, `__authority`,
 *      `__sourceDate`) ; l'alias et sa valeur brute sont CONSERVÉS ;
 *    · clé canonique renseignée, alias de même valeur → NO_CHANGE ;
 *    · clé canonique renseignée, alias de valeur DIFFÉRENTE → AMBIGUOUS
 *      `ALIAS_CONFLICT` + carte MIG-REVIEW (valeur en place / valeur de
 *      l'alias) — rien n'est tranché ;
 *    · clé vide, alias de valeurs différentes → AMBIGUOUS `ALIASES_DISAGREE`
 *      + carte ;
 *    · valeur d'alias non normalisable → AMBIGUOUS `ALIAS_UNNORMALIZABLE`
 *      (rapport seul : aucune valeur proposable).
 *    MIG-09 : seule une clé canonique VIDE est écrite — jamais une valeur en
 *    place, quelle que soit son origine.
 *
 * B. `document_facts` sans `canonical_key` : famille = bien ciblé
 *    (`target_type = ASSET`), sinon bien du document. `fact_key` canonique ou
 *    alias résolu → APPLIED : `canonical_key` renseignée, `raw_key` /
 *    `raw_value` = clé et valeur brutes (si absentes) ; `fact_key` et les
 *    valeurs d'origine ne changent pas. AMBIGUOUS (rapport) : alias résolu
 *    différemment selon la famille et famille inconnue
 *    (`ALIAS_FAMILY_UNKNOWN`) ; alias exprimé dans une autre unité
 *    (`purchasePriceCents`…) — la valeur stockée n'est pas dans l'unité de la
 *    clé canonique (`UNIT_CONVERSION_REQUIRED`) ; fait de même extraction
 *    portant la même clé APRÈS résolution des alias (clé canonique, ou autre
 *    alias de la même clé) avec une autre valeur (`FACT_CONFLICT`) — aucun
 *    des faits n'est canonicalisé, et une carte MIG-REVIEW propose les
 *    valeurs du document face à la valeur en place sur le bien.
 *    Clé hors registre (connaissance générique) : ignorée.
 *
 * Copie restaurable de toute écriture (fiche, faits, preuves) dans la même
 * transaction (`backup.ts`).
 *
 * C. `field_evidence` sans `canonical_key` : même résolution (famille du
 *    bien de la preuve), `canonical_key` et `raw_value` renseignées ;
 *    `field_key` inchangée. Mêmes cas AMBIGUOUS (unité, famille).
 */
import { buildCanonicalAssetState, isEmptyValue, loadAssetRow, parseKc, sameCanonicalValue, type AssetRowJson } from '@/services/canonical/asset-state';
import { indexKcAliases, rowFamily } from '@/services/canonical/asset-state/canonical-asset-view';
import { readOrigin, writeOrigin } from '@/services/ai/reconciliation/field-origin';
import {
  getField, normalizeValue, resolveAliasDetailed, toAssetFamily, type AssetFamily,
} from '@/services/canonical/registry';
import { applyAssetPlan, type AssetPlan } from '../asset-write';
import { writeBackups, type BackupRow } from '../backup';
import { fetchAssetRows, iterateBatches } from '../iterate';
import { emptyCounts, type ReportEntry, type ReviewCardRequest, type StepContext, type StepResult } from '../types';

const STEP = 'MIG-01' as const;
const PROVENANCE_SUFFIXES = ['__updatedAt', '__source', '__authority', '__sourceDate'] as const;

export interface KcAliasPlan extends AssetPlan<ReportEntry> {
  cards: ReviewCardRequest[];
}

/** A. Plan de canonicalisation de la fiche d'un bien (pur, testé). */
export function planKcAliases(row: AssetRowJson): KcAliasPlan {
  const family = rowFamily(row.category);
  const kc = parseKc(row.key_characteristics);
  const next: Record<string, unknown> = { ...kc };
  const entries: ReportEntry[] = [];
  const cards: ReviewCardRequest[] = [];
  const base = { step: STEP, accountId: Number(row.account_id), assetId: Number(row.id), entityType: 'asset' as const, entityId: Number(row.id) };
  let changed = false;

  for (const [key, aliases] of indexKcAliases(kc, family)) {
    const vals: Array<{ raw: string; value: unknown }> = [];
    let illisible: string | null = null;
    for (const a of aliases) {
      if (isEmptyValue(kc[a.rawKey])) continue;
      const n = normalizeValue(key, kc[a.rawKey], a.sourceUnit ? { sourceUnit: a.sourceUnit } : {});
      if (!n.ok) { illisible = a.rawKey; continue; }
      vals.push({ raw: a.rawKey, value: n.value });
    }
    if (illisible) {
      entries.push({ ...base, fieldKey: key, before: { [illisible]: kc[illisible] }, after: null, decision: 'AMBIGUOUS', reason: 'ALIAS_UNNORMALIZABLE', details: { alias: illisible } });
    }
    if (vals.length === 0) continue;
    const current = kc[key];
    if (!isEmptyValue(current)) {
      const conflits: typeof vals = [];
      for (const v of vals) {
        if (sameCanonicalValue(key, current, v.value)) {
          entries.push({ ...base, fieldKey: key, before: current, after: current, decision: 'NO_CHANGE', reason: 'ALIAS_SAME_VALUE', details: { alias: v.raw } });
        } else {
          entries.push({ ...base, fieldKey: key, before: { [key]: current, [v.raw]: kc[v.raw] }, after: null, decision: 'AMBIGUOUS', reason: 'ALIAS_CONFLICT', details: { alias: v.raw } });
          if (!conflits.some((w) => sameCanonicalValue(key, w.value, v.value))) conflits.push(v);
        }
      }
      if (conflits.length) {
        cards.push({ step: STEP, accountId: base.accountId, assetId: base.assetId, key, reason: 'ALIAS_CONFLICT', current,
          candidates: conflits.map((v) => ({ value: v.value, source: v.raw })) });
      }
      continue;
    }
    const distincts = vals.filter((v, i) => vals.findIndex((w) => sameCanonicalValue(key, w.value, v.value)) === i);
    if (distincts.length > 1) {
      entries.push({ ...base, fieldKey: key, before: Object.fromEntries(vals.map((v) => [v.raw, kc[v.raw]])), after: null, decision: 'AMBIGUOUS', reason: 'ALIASES_DISAGREE' });
      cards.push({ step: STEP, accountId: base.accountId, assetId: base.assetId, key, reason: 'ALIASES_DISAGREE', current: null,
        candidates: distincts.map((v) => ({ value: v.value, source: v.raw })) });
      continue;
    }
    // Une seule valeur : la clé canonique est renseignée, provenance recopiée.
    const src = vals[0];
    next[key] = src.value;
    const hasOrigin = next[`${src.raw}__origin`] !== undefined || next[`${src.raw}_origin`] !== undefined;
    if (hasOrigin) Object.assign(next, writeOrigin({ ...next }, key, readOrigin(kc, src.raw)));
    for (const suf of PROVENANCE_SUFFIXES) {
      if (kc[`${src.raw}${suf}`] !== undefined && next[`${key}${suf}`] === undefined) next[`${key}${suf}`] = kc[`${src.raw}${suf}`];
    }
    changed = true;
    entries.push({
      ...base, fieldKey: key, before: { [src.raw]: kc[src.raw] }, after: { [key]: src.value, [`${key}__origin`]: next[`${key}__origin`] ?? null },
      decision: 'APPLIED', reason: 'ALIAS_CANONICALIZED', details: { alias: src.raw, aliasKept: true },
    });
  }
  return { kc: changed ? next : null, columns: {}, entries, cards };
}

/** Résolution d'une clé brute de fait ou de preuve (pure, testée). */
export function resolveRawKey(rawKey: string, family: AssetFamily | null):
  | { kind: 'canonical'; key: string }
  | { kind: 'alias'; key: string; sourceUnit?: string }
  | { kind: 'ambiguous'; reason: 'ALIAS_FAMILY_UNKNOWN' | 'UNIT_CONVERSION_REQUIRED'; key?: string }
  | { kind: 'generic' } {
  if (getField(rawKey)) return { kind: 'canonical', key: rawKey };
  const r = resolveAliasDetailed(rawKey, family ?? undefined);
  if (!r) {
    if (!family && (['IMMOBILIER', 'VEHICULE', 'OBJECT'] as AssetFamily[]).some((f) => resolveAliasDetailed(rawKey, f))) {
      return { kind: 'ambiguous', reason: 'ALIAS_FAMILY_UNKNOWN' };
    }
    return { kind: 'generic' };
  }
  if (r.sourceUnit) return { kind: 'ambiguous', reason: 'UNIT_CONVERSION_REQUIRED', key: r.key };
  return r.canonical ? { kind: 'canonical', key: r.key } : { kind: 'alias', key: r.key };
}

const rawOf = (text: string | null, num: string | number | null): string | null =>
  text ?? (num === null || num === undefined ? null : String(num));

/**
 * Mise à jour ensembliste d'un lot, dans UNE transaction avec la copie
 * restaurable des colonnes modifiées (valeurs d'avant lues sous verrou).
 */
async function majLot(
  ctx: StepContext, table: 'document_facts' | 'field_evidence', maj: Array<{ id: number; k: string; accountId: number; assetId: number | null }>,
): Promise<void> {
  if (!ctx.apply || maj.length === 0) return;
  const cols = table === 'document_facts' ? ['canonical_key', 'raw_key', 'raw_value'] : ['canonical_key', 'raw_value'];
  const set = table === 'document_facts'
    ? `canonical_key = m.k, raw_key = coalesce(t.raw_key, t.fact_key), raw_value = coalesce(t.raw_value, t.value_text, t.value_number::text)`
    : `canonical_key = m.k, raw_value = coalesce(t.raw_value, t.value_json #>> '{}')`;
  const lecture = cols.map((c) => `t.${c}::text AS ${c}`).join(', ');
  await ctx.sql.begin(async (tx) => {
    const ids = maj.map((m) => m.id).join(',');
    const avant = (await tx.unsafe(
      `SELECT t.id::bigint::text AS id, ${lecture} FROM ${table} t WHERE t.id = ANY(string_to_array($1, ',')::bigint[]) AND t.canonical_key IS NULL FOR UPDATE`,
      [ids] as never[],
    )) as unknown as Array<Record<string, string | null>>;
    const apres = (await tx.unsafe(
      `UPDATE ${table} t SET ${set}
         FROM jsonb_to_recordset($1::jsonb) AS m(id bigint, k text)
        WHERE t.id = m.id AND t.canonical_key IS NULL
       RETURNING t.id::bigint::text AS id, ${lecture}`,
      [JSON.stringify(maj.map((m) => ({ id: m.id, k: m.k })))] as never[],
    )) as unknown as Array<Record<string, string | null>>;
    const parId = new Map(avant.map((r) => [r.id, r]));
    const parCompte = new Map<number, BackupRow[]>();
    for (const n of apres) {
      const o = parId.get(n.id!);
      const m = maj.find((x) => String(x.id) === n.id)!;
      for (const c of cols) {
        if (!o || o[c] === n[c]) continue;
        const l = parCompte.get(m.accountId) ?? [];
        l.push({ targetType: table === 'document_facts' ? 'document_fact' : 'field_evidence', targetId: Number(n.id), assetId: m.assetId,
          name: c, old: { v: o[c] }, next: { v: n[c] } });
        parCompte.set(m.accountId, l);
      }
    }
    for (const [accountId, rows] of parCompte) await writeBackups(tx as never, { runId: ctx.runId, step: STEP, accountId }, rows);
  });
}

/**
 * Trois parties, chacune avec SON curseur de reprise (`MIG-01`,
 * `MIG-01:facts`, `MIG-01:evidence`) et SA limite (`--limit` par partie) ;
 * requêtes ensemblistes par lot (lecture des faits concurrents de tout le
 * lot en une requête, une mise à jour par lot).
 */
export async function runMig01(ctx: StepContext): Promise<StepResult> {
  const counts = emptyCounts();
  let cards = 0;
  const rep = async (e: ReportEntry) => { counts[e.decision] += 1; if (e.decision !== 'NO_CHANGE') await ctx.report(e); };

  // A. Fiches des biens.
  const a = await iterateBatches(ctx, fetchAssetRows(ctx), async (rows) => {
    for (const row of rows) {
      let plan = planKcAliases(row);
      if (ctx.apply && plan.kc) {
        const applied = await applyAssetPlan(ctx, STEP, { id: row.id, accountId: Number(row.account_id) }, (r) => planKcAliases(r));
        if (applied) plan = applied as KcAliasPlan;
      }
      for (const e of plan.entries) await rep(e);
      for (const c of plan.cards) if (await ctx.card(c) !== 'SKIPPED') cards += 1;
    }
  });

  // B. Faits documentaires.
  const b = await iterateBatches(ctx, async (after, limit) => ctx.sql<Array<{
    id: number; accountId: number; fileId: number; extractionId: number; factKey: string; valueText: string | null; valueNumber: string | null;
    rawKey: string | null; rawValue: string | null; category: string | null; assetId: number | null;
  }>>`
    SELECT f.id::int AS id, f.account_id AS "accountId", f.file_id AS "fileId", f.extraction_id AS "extractionId", f.fact_key AS "factKey",
           f.value_text AS "valueText", f.value_number::text AS "valueNumber",
           f.raw_key AS "rawKey", f.raw_value AS "rawValue", a.category, a.id AS "assetId"
      FROM document_facts f
      LEFT JOIN asset_files af ON af.id = f.file_id
      LEFT JOIN assets a ON a.id = CASE WHEN f.target_type = 'ASSET' THEN f.target_entity_id ELSE af.asset_id END
                        AND a.account_id = f.account_id
     WHERE f.canonical_key IS NULL AND f.status = 'active' AND f.id > ${after}
       AND (${ctx.accountId}::int IS NULL OR f.account_id = ${ctx.accountId})
     ORDER BY f.id LIMIT ${limit}`, async (rows) => {
    // Faits concurrents des extractions du lot : UNE requête.
    const extractions = [...new Set(rows.map((f) => Number(f.extractionId)))];
    const bruts = await ctx.sql<Array<{ id: number; extractionId: number; key: string; v: string | null; category: string | null }>>`
      SELECT f.id::int AS id, f.extraction_id AS "extractionId", coalesce(f.canonical_key, f.fact_key) AS key,
             coalesce(f.value_text, f.value_number::text) AS v, a.category
        FROM document_facts f
        LEFT JOIN asset_files af ON af.id = f.file_id
        LEFT JOIN assets a ON a.id = CASE WHEN f.target_type = 'ASSET' THEN f.target_entity_id ELSE af.asset_id END
                          AND a.account_id = f.account_id
       WHERE f.extraction_id = ANY(string_to_array(${extractions.join(',')}, ',')::int[]) AND f.status = 'active'`;
    // Clés des faits voisins APRÈS résolution des alias (même famille) : deux
    // alias d'une même extraction de valeurs différentes sont un conflit.
    const voisins = bruts.map((o) => {
      const r = resolveRawKey(o.key, o.category ? toAssetFamily(o.category) ?? 'OBJECT' : null);
      return { ...o, key: r.kind === 'canonical' || r.kind === 'alias' ? r.key : o.key };
    });
    const cartesLot = new Set<string>();
    const maj: Array<{ id: number; k: string; accountId: number; assetId: number | null }> = [];
    for (const f of rows) {
      const fam = f.category ? toAssetFamily(f.category) ?? 'OBJECT' : null;
      const r = resolveRawKey(f.factKey, fam);
      if (r.kind === 'generic') continue;
      const base = { step: STEP, accountId: f.accountId, assetId: f.assetId, entityType: 'document_fact' as const, entityId: f.id, fieldKey: r.kind === 'ambiguous' ? f.factKey : r.key };
      const brute = rawOf(f.valueText, f.valueNumber);
      if (r.kind === 'ambiguous') {
        await rep({ ...base, before: { factKey: f.factKey, value: brute }, after: null, decision: 'AMBIGUOUS', reason: r.reason });
        continue;
      }
      const memeCle = voisins.filter((o) => Number(o.extractionId) === Number(f.extractionId) && o.key === r.key);
      if (memeCle.some((o) => Number(o.id) !== f.id && !sameCanonicalValue(r.key, o.v, brute))) {
        await rep({ ...base, before: { factKey: f.factKey, value: brute }, after: null, decision: 'AMBIGUOUS', reason: 'FACT_CONFLICT',
          details: { extractionId: f.extractionId } });
        // Carte : la valeur du bien à retenir parmi celles du document (une par bien et par clé).
        const cle = `${f.assetId}:${r.key}`;
        if (f.assetId && !cartesLot.has(cle)) {
          cartesLot.add(cle);
          const valeurs: unknown[] = [];
          for (const o of memeCle) {
            const n = normalizeValue(r.key, o.v);
            if (n.ok && n.value !== null && !valeurs.some((x) => sameCanonicalValue(r.key, x, n.value))) valeurs.push(n.value);
          }
          // Valeur en place sur le bien : proposée comme « valeur actuelle » (contrôle optimiste de la carte).
          const ligne = await loadAssetRow(ctx.sql as never, f.assetId, f.accountId);
          const enPlace = ligne ? buildCanonicalAssetState(ligne).fields[r.key]?.value ?? null : null;
          if (valeurs.length > 1 && await ctx.card({ step: STEP, accountId: f.accountId, assetId: f.assetId, key: r.key, reason: 'FACT_CONFLICT',
            current: enPlace, candidates: valeurs.map((v) => ({ value: v, source: `document ${f.fileId}` })) }) !== 'SKIPPED') cards += 1;
        }
        continue;
      }
      maj.push({ id: f.id, k: r.key, accountId: f.accountId, assetId: f.assetId });
      await rep({ ...base, before: { factKey: f.factKey, canonicalKey: null }, after: { canonicalKey: r.key, rawKey: f.rawKey ?? f.factKey, rawValue: f.rawValue ?? brute },
        decision: 'APPLIED', reason: r.kind === 'alias' ? 'FACT_ALIAS_CANONICALIZED' : 'FACT_CANONICAL_KEY_FILLED' });
    }
    await majLot(ctx, 'document_facts', maj);
  }, `${STEP}:facts`);

  // C. Preuves.
  const c = await iterateBatches(ctx, async (after, limit) => ctx.sql<Array<{
    id: number; accountId: number; assetId: number; fieldKey: string; value: string | null; rawValue: string | null; category: string | null;
  }>>`
    SELECT e.id, e.account_id AS "accountId", e.asset_id AS "assetId", e.field_key AS "fieldKey", e.value_json #>> '{}' AS value,
           e.raw_value AS "rawValue", a.category
      FROM field_evidence e LEFT JOIN assets a ON a.id = e.asset_id AND a.account_id = e.account_id
     WHERE e.canonical_key IS NULL AND e.id > ${after}
       AND (${ctx.accountId}::int IS NULL OR e.account_id = ${ctx.accountId})
     ORDER BY e.id LIMIT ${limit}`, async (rows) => {
    const maj: Array<{ id: number; k: string; accountId: number; assetId: number | null }> = [];
    for (const e of rows) {
      const r = resolveRawKey(e.fieldKey, e.category ? toAssetFamily(e.category) ?? 'OBJECT' : null);
      if (r.kind === 'generic') continue;
      const base = { step: STEP, accountId: e.accountId, assetId: e.assetId, entityType: 'field_evidence' as const, entityId: e.id, fieldKey: r.kind === 'ambiguous' ? e.fieldKey : r.key };
      if (r.kind === 'ambiguous') {
        await rep({ ...base, before: { fieldKey: e.fieldKey, value: e.value }, after: null, decision: 'AMBIGUOUS', reason: r.reason });
        continue;
      }
      maj.push({ id: Number(e.id), k: r.key, accountId: e.accountId, assetId: e.assetId });
      await rep({ ...base, before: { fieldKey: e.fieldKey, canonicalKey: null }, after: { canonicalKey: r.key, rawValue: e.rawValue ?? e.value },
        decision: 'APPLIED', reason: r.kind === 'alias' ? 'EVIDENCE_ALIAS_CANONICALIZED' : 'EVIDENCE_CANONICAL_KEY_FILLED' });
    }
    await majLot(ctx, 'field_evidence', maj);
  }, `${STEP}:evidence`);

  return {
    step: STEP, scanned: a.scanned + b.scanned + c.scanned, counts, cursor: a.cursor, cards,
    complete: a.exhausted && b.exhausted && c.exhausted,
  };
}
