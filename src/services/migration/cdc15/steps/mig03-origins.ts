/**
 * MIG-03 — reconstitution de l'origine des valeurs de la fiche (CDC 15 §14
 * point 3, T3-02, §6.2) : « reconstituer l'origine USER lorsque l'historique
 * permet de l'établir ; en cas de doute, privilégier la protection ».
 *
 * RÈGLE EXACTE, pour chaque clé de la fiche renseignée (clé canonique de la
 * famille du bien, ou alias non encore canonicalisé — l'origine est écrite
 * sur la clé lue). « Prouvée » = la DERNIÈRE écriture connue du champ
 * (`ai_field_updates`, journal 0216 `canonical_field_writes` écrit hors
 * simulation — voir `history.ts`) a produit EXACTEMENT la valeur en place.
 *
 *   1. Origine structurée humaine (`__origin` USER / ADMIN) → NO_CHANGE.
 *      Jamais rétrogradée (MIG-09).
 *   2. Origine structurée automatique :
 *        dernière écriture prouvée HUMAINE → USER (APPLIED
 *        `HUMAN_WRITE_PROVEN`) ; sinon → NO_CHANGE (l'origine structurée est
 *        elle-même la trace du pipeline qui l'a posée).
 *   3. Ancien format `_origin = manual` → USER (`LEGACY_MANUAL`).
 *   4. Ancien format `_origin = auto`, ou AUCUNE information d'origine :
 *        dernière écriture prouvée humaine → USER (`HUMAN_WRITE_PROVEN`) ;
 *        dernière écriture prouvée automatique → cette origine
 *        (`AI_WRITE_PROVEN` : RECONCILIATION pour `ai_field_updates`,
 *        l'origine journalisée pour 0216) ;
 *        sinon → USER (`NO_AI_PROOF_PROTECTED`) : aucune origine IA n'est
 *        prouvée pour la valeur en place — l'ancien drapeau `auto` seul ne
 *        prouve rien (la valeur a pu être corrigée à la main depuis).
 *
 * L'écriture pose `<clé>__origin` au format structuré (et retire l'ancien
 * `<clé>_origin`) et le motif dans `<clé>__originBasis` (relecture lot 17 :
 * un USER posé au titre de NO_AI_PROOF_PROTECTED est une PRÉSOMPTION, qui
 * protège la valeur mais ne prouve rien — voir `origin-proof.ts`) ; la
 * valeur n'est JAMAIS modifiée. La date `__updatedAt` n'est pas inventée.
 */
import { isEmptyValue, parseKc, type AssetRowJson } from '@/services/canonical/asset-state';
import { indexKcAliases, isMetaKey, rowFamily } from '@/services/canonical/asset-state/canonical-asset-view';
import { FIELD_ORIGINS, isHumanOrigin, writeOrigin } from '@/services/ai/reconciliation/field-origin';
import type { FieldOrigin } from '@/services/ai/evidence/evidence.types';
import { getField } from '@/services/canonical/registry';
import { applyAssetPlan, type AssetPlan } from '../asset-write';
import { ORIGIN_BASIS } from '../origin-proof';
import { loadHistory, provenOrigin, type AssetHistory, type FieldWriteEvent } from '../history';
import { fetchAssetRows, iterateBatches } from '../iterate';
import { emptyCounts, type ReportEntry, type StepContext, type StepResult } from '../types';

const STEP = 'MIG-03' as const;

type Info = { kind: 'structured'; origin: FieldOrigin } | { kind: 'legacy'; flag: string } | { kind: 'none' };

function originInfo(kc: Record<string, unknown>, k: string): Info {
  const s = kc[`${k}__origin`];
  if (typeof s === 'string' && (FIELD_ORIGINS as string[]).includes(s)) return { kind: 'structured', origin: s as FieldOrigin };
  const l = kc[`${k}_origin`];
  if (typeof l === 'string') return { kind: 'legacy', flag: l };
  return { kind: 'none' };
}

/** Décision pour UNE clé (pure, testée). null : rien à faire. */
export function decideOrigin(
  info: Info, proof: FieldWriteEvent | null,
): { origin: FieldOrigin; reason: string } | null {
  if (info.kind === 'structured') {
    if (isHumanOrigin(info.origin)) return null;
    return proof && isHumanOrigin(proof.origin) ? { origin: 'USER', reason: 'HUMAN_WRITE_PROVEN' } : null;
  }
  if (info.kind === 'legacy' && info.flag === 'manual') return { origin: 'USER', reason: 'LEGACY_MANUAL' };
  if (proof && isHumanOrigin(proof.origin)) return { origin: 'USER', reason: 'HUMAN_WRITE_PROVEN' };
  if (proof) return { origin: proof.origin, reason: 'AI_WRITE_PROVEN' };
  return { origin: 'USER', reason: 'NO_AI_PROOF_PROTECTED' };
}

/** Plan de la fiche d'un bien (pur, testé). */
export function planOrigins(row: AssetRowJson, history: Map<string, FieldWriteEvent[]> | undefined): AssetPlan<ReportEntry> {
  const family = rowFamily(row.category);
  const kc = parseKc(row.key_characteristics);
  let next: Record<string, unknown> = { ...kc };
  const entries: ReportEntry[] = [];
  const base = { step: STEP, accountId: Number(row.account_id), assetId: Number(row.id), entityType: 'asset' as const, entityId: Number(row.id) };
  // Clés lues : canoniques de la famille, et alias (origine portée par l'alias).
  const aliasOf = new Map<string, string>();
  for (const [key, list] of indexKcAliases(kc, family)) for (const a of list) aliasOf.set(a.rawKey, key);
  for (const k of Object.keys(kc)) {
    if (isMetaKey(k) || isEmptyValue(kc[k])) continue;
    const canonical = getField(k)?.families.includes(family) ? k : aliasOf.get(k);
    if (!canonical) continue;
    const info = originInfo(kc, k);
    const d = decideOrigin(info, provenOrigin(history?.get(canonical), canonical, kc[k]));
    const avant = info.kind === 'structured' ? info.origin : info.kind === 'legacy' ? `_origin=${info.flag}` : null;
    if (!d) {
      if (info.kind === 'structured' && isHumanOrigin(info.origin)) {
        entries.push({ ...base, fieldKey: k, before: avant, after: avant, decision: 'NO_CHANGE', reason: 'HUMAN_ORIGIN_KEPT' });
      }
      continue;
    }
    next = writeOrigin(next, k, d.origin);
    next[`${k}${ORIGIN_BASIS}`] = d.reason;
    entries.push({ ...base, fieldKey: k, before: { origin: avant }, after: { origin: d.origin }, decision: 'APPLIED', reason: d.reason,
      details: { canonicalKey: canonical } });
  }
  const changed = entries.some((e) => e.decision === 'APPLIED');
  return { kc: changed ? next : null, columns: {}, entries };
}

export async function runMig03(ctx: StepContext): Promise<StepResult> {
  const counts = emptyCounts();
  const r = await iterateBatches(ctx, fetchAssetRows(ctx), async (rows) => {
    const history: AssetHistory = await loadHistory(ctx.sql, rows.map((x) => x.id));
    // Simulation : fiche telle que MIG-01 la laisserait (même rapport qu'à l'application).
    const vues = ctx.preview ? await ctx.preview(rows) : rows;
    for (const [i, row] of rows.entries()) {
      let plan = planOrigins(vues[i], history.get(row.id));
      if (ctx.apply && plan.kc) {
        const applied = await applyAssetPlan(ctx, STEP, { id: row.id, accountId: Number(row.account_id) }, (x) => planOrigins(x, history.get(row.id)));
        if (applied) plan = applied;
      }
      for (const e of plan.entries) {
        counts[e.decision] += 1;
        if (e.decision !== 'NO_CHANGE') await ctx.report(e);
      }
    }
  });
  return { step: STEP, scanned: r.scanned, counts, cursor: r.cursor, cards: 0, complete: r.exhausted };
}
