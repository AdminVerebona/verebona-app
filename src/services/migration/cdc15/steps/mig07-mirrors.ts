/**
 * MIG-07 — colonnes historiques ↔ fiche canonique (CDC 15 §14 point 7,
 * D-10 : `keyCharacteristics` fait foi, les colonnes en sont des miroirs) :
 * « uniquement lorsque la valeur canonique est non ambiguë ».
 *
 * RÈGLE EXACTE, par clé du registre ayant des colonnes miroirs dans la
 * famille du bien (`purchase_date`, `purchase_price_cents`, `address`,
 * `registration_number`, `mileage_or_hours`…) :
 *
 *   Valeur de fiche = clé canonique et alias (normalisés, unité du registre).
 *   · plusieurs valeurs DIFFÉRENTES dans la fiche (clé / alias) →
 *     AMBIGUOUS `KC_AMBIGUOUS` (rapport ; la carte est celle de MIG-01) ;
 *   · valeur de fiche non normalisable → AMBIGUOUS `KC_UNNORMALIZABLE` ;
 *   · fiche renseignée, colonne VIDE → APPLIED `MIRROR_FILLED` ;
 *   · fiche renseignée, colonne égale → NO_CHANGE ;
 *   · fiche renseignée, colonne DIFFÉRENTE :
 *       origine humaine PROUVÉE de la fiche (`origin-proof.ts` : USER
 *       structuré préexistant, LEGACY_MANUAL, HUMAN_WRITE_PROVEN, écriture
 *       humaine au journal 0216) → APPLIED `MIRROR_ALIGNED_ON_KC` (D-10) ;
 *       origine AUTOMATIQUE → AMBIGUOUS `COLUMN_DIFFERS_FROM_AUTOMATIC`,
 *       origine humaine seulement PRÉSUMÉE (aucune information, ou USER posé
 *       par MIG-03 au titre de NO_AI_PROOF_PROTECTED) → AMBIGUOUS
 *       `COLUMN_DIFFERS_HUMAN_NOT_PROVEN` — les deux avec carte MIG-REVIEW
 *       (valeur de la fiche / valeur de la colonne) : la colonne peut porter
 *       une saisie de l'utilisateur — jamais écrasée sans lui (MIG-09) ;
 *   · fiche VIDE, colonne renseignée → APPLIED `KC_FILLED_FROM_COLUMN` : la
 *     clé canonique reçoit la valeur de la colonne (convertie : centimes →
 *     euros), origine USER explicite — la vue canonique la lisait déjà comme
 *     telle (colonne sans origine = USER), aucune origine IA n'est prouvée.
 *
 * COPIE RESTAURABLE (relecture lot 17) : toute écriture (colonne remplie ou
 * alignée, clé de fiche remplie depuis une colonne) est copiée, EN CLAIR,
 * dans `cdc15_migration_backups` (accès restreint, jamais au rapport), dans
 * la MÊME transaction (`asset-write.ts`) ; `--restore <runId>` la remet.
 */
import { isEmptyValue, parseKc, sameCanonicalValue, type AssetRowJson } from '@/services/canonical/asset-state';
import { fromMirrorColumn, hasOriginInfo, indexKcAliases, rowFamily } from '@/services/canonical/asset-state/canonical-asset-view';
import { readOrigin, writeOrigin } from '@/services/ai/reconciliation/field-origin';
import { listFields, normalizeValue, toMirrorValue } from '@/services/canonical/registry';
import { applyAssetPlan, type AssetPlan } from '../asset-write';
import { loadHistory, type FieldWriteEvent } from '../history';
import { humanOriginProof } from '../origin-proof';
import { fetchAssetRows, iterateBatches } from '../iterate';
import { emptyCounts, type ReportEntry, type ReviewCardRequest, type StepContext, type StepResult } from '../types';

const STEP = 'MIG-07' as const;

/** Égalité d'une colonne (dates au jour, nombres par valeur). */
export function sameColumnValue(a: unknown, b: unknown): boolean {
  const ea = isEmptyValue(a);
  const eb = isEmptyValue(b);
  if (ea || eb) return ea && eb;
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  const sa = String(a);
  const sb = String(b);
  if (/^\d{4}-\d{2}-\d{2}/.test(sa) && /^\d{4}-\d{2}-\d{2}/.test(sb)) return sa.slice(0, 10) === sb.slice(0, 10);
  return sa === sb;
}

export interface MirrorPlan extends AssetPlan<ReportEntry> {
  cards: ReviewCardRequest[];
  /** Colonnes écrites : valeur avant / après (copie restaurable). */
  backups: Array<{ column: string; old: unknown; next: unknown }>;
}

/** Plan d'un bien (pur, testé). */
export function planMirrors(row: AssetRowJson, history?: Map<string, FieldWriteEvent[]>): MirrorPlan {
  const family = rowFamily(row.category);
  const kc = parseKc(row.key_characteristics);
  let next: Record<string, unknown> = { ...kc };
  const columns: Record<string, unknown> = {};
  const entries: ReportEntry[] = [];
  const cards: ReviewCardRequest[] = [];
  const backups: MirrorPlan['backups'] = [];
  const aliases = indexKcAliases(kc, family);
  const base = { step: STEP, accountId: Number(row.account_id), assetId: Number(row.id), entityType: 'asset' as const, entityId: Number(row.id) };
  let kcChanged = false;

  for (const def of listFields(family).filter((d) => d.mirrorColumns?.length)) {
    const sources = [{ raw: def.key, unit: undefined as string | undefined }, ...(aliases.get(def.key) ?? []).map((a) => ({ raw: a.rawKey, unit: a.sourceUnit }))]
      .filter((s) => !isEmptyValue(kc[s.raw]));
    const vals: Array<{ raw: string; value: unknown }> = [];
    let illisible = false;
    for (const s of sources) {
      const n = normalizeValue(def.key, kc[s.raw], s.unit ? { sourceUnit: s.unit } : {});
      if (!n.ok) { illisible = true; continue; }
      if (!vals.some((v) => sameCanonicalValue(def.key, v.value, n.value))) vals.push({ raw: s.raw, value: n.value });
    }
    const colonnes = (def.mirrorColumns ?? []).map((c) => ({ c, v: row[c.column] }));

    if (illisible) {
      entries.push({ ...base, fieldKey: def.key, before: Object.fromEntries(sources.map((s) => [s.raw, kc[s.raw]])), after: null, decision: 'AMBIGUOUS', reason: 'KC_UNNORMALIZABLE' });
      continue;
    }
    if (vals.length > 1) {
      entries.push({ ...base, fieldKey: def.key, before: Object.fromEntries(vals.map((v) => [v.raw, v.value])), after: null, decision: 'AMBIGUOUS', reason: 'KC_AMBIGUOUS' });
      continue;
    }
    if (vals.length === 1) {
      const kcVal = vals[0];
      const attendu = toMirrorValue(def.key, kcVal.value);
      const ecarts = colonnes.filter(({ c, v }) => !sameColumnValue(v, attendu[c.column]));
      if (ecarts.length === 0) continue;
      const vides = ecarts.every(({ v }) => isEmptyValue(v));
      const originKey = hasOriginInfo(kc, def.key) || kcVal.raw === def.key ? def.key : kcVal.raw;
      const origin = readOrigin(kc, originKey);
      const preuve = humanOriginProof(kc, originKey, def.key, kcVal.value, history?.get(def.key));
      const avant = Object.fromEntries(ecarts.map(({ c, v }) => [c.column, v ?? null]));
      const apres = Object.fromEntries(ecarts.map(({ c }) => [c.column, attendu[c.column]]));
      if (vides || preuve === 'PROVEN') {
        Object.assign(columns, apres);
        for (const { c, v } of ecarts) backups.push({ column: c.column, old: v ?? null, next: attendu[c.column] });
        entries.push({ ...base, fieldKey: def.key, before: avant, after: apres, decision: 'APPLIED', reason: vides ? 'MIRROR_FILLED' : 'MIRROR_ALIGNED_ON_KC', details: { origin, proof: preuve } });
      } else {
        const motif = preuve === 'AUTOMATIC' ? 'COLUMN_DIFFERS_FROM_AUTOMATIC' : 'COLUMN_DIFFERS_HUMAN_NOT_PROVEN';
        entries.push({ ...base, fieldKey: def.key, before: { ...avant, kc: kcVal.value }, after: null, decision: 'AMBIGUOUS', reason: motif, details: { origin, proof: preuve } });
        const col = ecarts[0];
        const valeurColonne = fromMirrorColumn(col.c, col.v);
        if (!isEmptyValue(valeurColonne)) {
          cards.push({ step: STEP, accountId: base.accountId, assetId: base.assetId, key: def.key, reason: motif,
            current: kcVal.value, candidates: [{ value: valeurColonne, source: col.c.column }] });
        }
      }
      continue;
    }
    // Fiche vide : la colonne renseignée est recopiée dans la fiche (clé canonique).
    const pleine = colonnes.find(({ v }) => !isEmptyValue(v));
    if (!pleine) continue;
    const valeur = fromMirrorColumn(pleine.c, pleine.v);
    const n = normalizeValue(def.key, valeur);
    if (!n.ok || isEmptyValue(n.value)) {
      entries.push({ ...base, fieldKey: def.key, before: { [pleine.c.column]: pleine.v }, after: null, decision: 'AMBIGUOUS', reason: 'COLUMN_UNNORMALIZABLE' });
      continue;
    }
    next[def.key] = n.value;
    next = writeOrigin(next, def.key, 'USER');
    kcChanged = true;
    entries.push({ ...base, fieldKey: def.key, before: { [pleine.c.column]: pleine.v, kc: null }, after: { kc: n.value, origin: 'USER' },
      decision: 'APPLIED', reason: 'KC_FILLED_FROM_COLUMN' });
  }
  return { kc: kcChanged ? next : null, columns, entries, cards, backups };
}

export async function runMig07(ctx: StepContext): Promise<StepResult> {
  const counts = emptyCounts();
  let cards = 0;
  const r = await iterateBatches(ctx, fetchAssetRows(ctx), async (rows) => {
    const history = await loadHistory(ctx.sql, rows.map((x) => x.id));
    const vues = ctx.preview ? await ctx.preview(rows) : rows;
    for (const [i, row] of rows.entries()) {
      let plan = planMirrors(vues[i], history.get(row.id));
      if (ctx.apply && (plan.kc || Object.keys(plan.columns).length)) {
        const applied = await applyAssetPlan(ctx, STEP, { id: row.id, accountId: Number(row.account_id) },
          (x) => planMirrors(x, history.get(row.id)));
        if (applied) plan = applied as MirrorPlan;
      }
      for (const e of plan.entries) { counts[e.decision] += 1; await ctx.report(e); }
      for (const c of plan.cards) if (await ctx.card(c) !== 'SKIPPED') cards += 1;
    }
  });
  return { step: STEP, scanned: r.scanned, counts, cursor: r.cursor, cards, complete: r.exhausted };
}
