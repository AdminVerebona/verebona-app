/**
 * writeCanonicalEntityField() — écriture unique d'un champ d'ÉQUIPEMENT ou de
 * PIÈCE (CDC 15 T1-04, T3-01, T3-02, T3-05 ; plan lot 18, volet R3).
 *
 * Mêmes garanties que `writeCanonicalAssetField` (dont elle reprend les
 * règles), sur la fiche de l'entité — jamais sur celle du bien parent :
 *   1. une transaction, `SELECT … FOR UPDATE` sur la ligne de l'entité,
 *      appartenance au compte contrôlée PAR LE BIEN PARENT (non supprimé) ;
 *   2. clé résolue (alias → canonique) ; le champ doit déclarer ce type de
 *      cible dans `targetTypes` (sinon `invalid`, TARGET_NOT_APPLICABLE) ;
 *      valeur normalisée par le registre ;
 *   3. contrôle optimiste (`expectedCurrent`) puis préséance des origines
 *      (`canOverwrite`) : une valeur USER/ADMIN n'est jamais remplacée par une
 *      origine automatique ; une valeur de colonne sans origine est USER ;
 *   4. la fiche de l'entité (0227) reçoit la valeur, `<clé>__origin`,
 *      `<clé>__updatedAt` (et, pour une origine automatique, l'autorité et la
 *      date de la preuve) ; les colonnes réelles sont recopiées dans la même
 *      transaction (`equipments.purchase_price_cents`, `estimated_value_cents`,
 *      `equipment_cil_specs.brand / model / serial_number / power_kw` — ligne
 *      créée au besoin —, `substructures.area` : la pièce est une
 *      sous-structure depuis D-G, migration 0229) ;
 *   5. journal 0216 `canonical_field_writes`, une ligne par clé, avec
 *      `target_type` / `target_id` (0227) et `asset_id` = bien porteur ;
 *   6. après validation, ASSET_UPDATED (bien porteur) invalide les caches de
 *      l'assistant.
 *
 * Pas de ligne `ai_field_updates` : cette table (accueil « Ce que j'ai
 * fait ») ne porte pas de cible et lirait la valeur comme un champ du BIEN.
 *
 * Modes (`CANONICAL_WRITE_MODE`) :
 *   legacy   rien, AUCUNE requête (`skipped`) ;
 *   shadow   lecture sans verrou, journal `dry_run = true`, entité intacte ;
 *   enabled  écriture.
 * Migration 0227 absente : rien (`schemaNotReady`), signalé une fois.
 */
import { pgClient } from '@/db';
import { canOverwrite, isHumanOrigin, writeOrigin } from '@/services/ai/reconciliation/field-origin';
import { eurToCents, normalizeValue } from '@/services/canonical/registry';
import { canonicalWriteMode, type RolloutMode } from '@/services/canonical/rollout';
import {
  sameCanonicalValue,
  type CanonicalFieldWrite, type CanonicalFieldWriteResult, type CanonicalOrigin, type SqlRunner, type TxRunner,
} from '@/services/canonical/asset-state';
import {
  ENTITY_MIRRORS, buildCanonicalEntityState, fieldTargetsEntity, loadEntityRow, mirrorId, readEntityFieldState,
  resolveEntityDef,
} from './entity-view';
import { entityCanonicalColumnsReady } from './entity-schema';
import type {
  CanonicalEntityRow, CanonicalEntityState, CanonicalEntityTarget, CanonicalEntityWriteResult, EntityMirrorColumn,
  WriteCanonicalEntityFieldInput, WriteCanonicalEntityFieldsInput,
} from './types';

/* ── Plan (fonction pure) ────────────────────────────────────────────────── */

export interface EntityWritePlan {
  kc: Record<string, unknown>;
  /** Colonnes miroirs à écrire, indexées `table.colonne`. */
  columns: Record<string, unknown>;
  results: CanonicalFieldWriteResult[];
  changed: boolean;
}

function versColonne(m: EntityMirrorColumn, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  switch (m.transform) {
    case 'eur_to_cents': return eurToCents(Number(value));
    case 'number': return Number(value);
    case 'text_number': return String(value);
    default: return typeof value === 'string' ? value : String(value);
  }
}

/**
 * État final d'une série d'écritures sur une entité, sans rien écrire
 * (mode enabled et shadow). Écritures appliquées dans l'ordre.
 */
export function planEntityWrites(
  row: CanonicalEntityRow,
  writes: CanonicalFieldWrite[],
  ctx: { origin: CanonicalOrigin; now: string; confirmUnchanged?: boolean },
): EntityWritePlan {
  let kc = { ...row.kc };
  const columns: Record<string, unknown> = {};
  const results: CanonicalFieldWriteResult[] = [];
  const type = row.target.type;

  for (const w of writes) {
    const base = { requestedKey: w.key, origin: ctx.origin, mirrors: {} as Record<string, unknown> };
    const refuse = (key: string, outcome: CanonicalFieldWriteResult['outcome'], reason: string,
      previousValue: unknown = null, previousOrigin: CanonicalOrigin | null = null): void => {
      results.push({ ...base, key, outcome, reason, previousValue, previousOrigin, nextValue: previousValue });
    };

    const def = resolveEntityDef(w.key);
    if (!def) { refuse(w.key, 'invalid', 'UNKNOWN_KEY'); continue; }
    if (!fieldTargetsEntity(def, type)) { refuse(def.key, 'invalid', 'TARGET_NOT_APPLICABLE'); continue; }

    const unit = w.sourceUnit ?? (w.key !== def.key ? def.aliasUnits?.[w.key] : undefined);
    const norm = normalizeValue(def.key, w.value, unit ? { sourceUnit: unit } : {});
    if (!norm.ok) { refuse(def.key, 'invalid', norm.reason); continue; }
    const next = norm.value;

    const vue: CanonicalEntityRow = { ...row, kc, columns: { ...row.columns, ...columns } };
    const current = readEntityFieldState(def, vue);
    const previousValue = current?.value ?? null;
    const previousOrigin = current?.origin ?? null;

    if (w.expectedCurrent !== undefined && !sameCanonicalValue(def.key, previousValue, w.expectedCurrent)) {
      refuse(def.key, 'conflict', 'CURRENT_VALUE_CHANGED', previousValue, previousOrigin);
      continue;
    }
    const decision = canOverwrite({ origin: previousOrigin ?? 'USER', empty: !current }, ctx.origin);
    if (!decision.allowed) { refuse(def.key, 'protected', decision.reason, previousValue, previousOrigin); continue; }

    if (sameCanonicalValue(def.key, previousValue, next)) {
      const humanConfirms = ctx.confirmUnchanged !== false && isHumanOrigin(ctx.origin) && current !== null
        && (current.origin !== ctx.origin || current.from !== 'key');
      if (!humanConfirms) {
        results.push({ ...base, key: def.key, outcome: 'unchanged', previousValue, previousOrigin, nextValue: previousValue });
        continue;
      }
    }

    const n: Record<string, unknown> = { ...kc };
    if (next === null) delete n[def.key];
    else n[def.key] = next;
    kc = writeOrigin(n, def.key, ctx.origin, { updatedAt: ctx.now });
    if (!isHumanOrigin(ctx.origin)) {
      if (w.trace?.authority !== undefined && w.trace.authority !== null) kc[`${def.key}__authority`] = w.trace.authority;
      if (w.trace?.sourceDate !== undefined) kc[`${def.key}__sourceDate`] = w.trace.sourceDate;
    }

    const mirrors: Record<string, unknown> = {};
    const m = ENTITY_MIRRORS[type][def.key];
    if (m) mirrors[mirrorId(m)] = versColonne(m, next);
    Object.assign(columns, mirrors);
    results.push({ ...base, key: def.key, outcome: 'written', previousValue, previousOrigin, nextValue: next, mirrors });
  }
  return { kc, columns, results, changed: results.some((r) => r.outcome === 'written') };
}

/* ── Persistance ─────────────────────────────────────────────────────────── */

const COLONNES_PERMISES = new Set(
  Object.values(ENTITY_MIRRORS).flatMap((t) => Object.values(t).map(mirrorId)),
);

async function persist(t: SqlRunner, row: CanonicalEntityRow, plan: EntityWritePlan): Promise<void> {
  const parTable = new Map<string, Array<[string, unknown]>>();
  for (const [id, v] of Object.entries(plan.columns)) {
    if (!COLONNES_PERMISES.has(id)) throw new Error(`colonne non autorisée : ${id}`);
    const [table, col] = id.split('.');
    parTable.set(table, [...(parTable.get(table) ?? []), [col, v]]);
  }
  const principale = row.target.type === 'EQUIPMENT' ? 'equipments' : 'substructures';
  const sets = ['key_characteristics = $2::jsonb', 'updated_at = now()'];
  const params: unknown[] = [row.target.id, JSON.stringify(plan.kc)];
  for (const [col, v] of parTable.get(principale) ?? []) { params.push(v); sets.push(`${col} = $${params.length}`); }
  await t.unsafe(`UPDATE ${principale} SET ${sets.join(', ')} WHERE id = $1`, params as never[]);

  const specs = parTable.get('equipment_cil_specs') ?? [];
  // Aucune ligne de caractéristiques à créer pour n'y mettre que des NULL.
  if (specs.length && (row.hasSpecs || specs.some(([, v]) => v !== null))) {
    const cols = specs.map(([c]) => c);
    const p: unknown[] = [row.target.id, ...specs.map(([, v]) => v)];
    await t.unsafe(
      `INSERT INTO equipment_cil_specs (equipment_id, ${cols.join(', ')}, created_at, updated_at)
       VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}, now(), now())
       ON CONFLICT (equipment_id) DO UPDATE SET ${cols.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}, updated_at = now()`,
      p as never[],
    );
  }
}

const jsonb = (v: unknown) => (v === undefined ? null : JSON.stringify(v));

/** Journal 0216 (avec cible 0227) ; écritures sans effet non journalisées. */
async function journal(
  t: SqlRunner,
  input: WriteCanonicalEntityFieldsInput,
  assetId: number,
  results: CanonicalFieldWriteResult[],
  dryRun: boolean,
): Promise<void> {
  const retenues = results.filter((r) => r.outcome !== 'unchanged');
  if (retenues.length === 0) return;
  const params: unknown[] = [];
  const casts = ['', '', '', '', '', '::jsonb', '::jsonb', '', '', '', '', '', '', '', '::jsonb'];
  const tuples = retenues.map((r) => {
    const v = [
      input.accountId, assetId, input.target.type, input.target.id, r.key, jsonb(r.previousValue), jsonb(r.nextValue),
      input.origin, input.actorUserId ?? null, input.source?.type ?? null,
      input.source?.id === undefined || input.source?.id === null ? null : String(input.source.id),
      input.traceId ?? null, r.outcome, dryRun,
      Object.keys(r.mirrors).length ? JSON.stringify(r.mirrors) : null,
    ];
    return `(${v.map((x, i) => { params.push(x); return `$${params.length}${casts[i]}`; }).join(', ')})`;
  });
  await t.unsafe(
    `INSERT INTO canonical_field_writes
       (account_id, asset_id, target_type, target_id, canonical_key, old_value, new_value, origin, actor_user_id,
        source_type, source_id, trace_id, outcome, dry_run, mirror_columns)
     VALUES ${tuples.join(', ')}`,
    params as never[],
  );
}

/* ── API ─────────────────────────────────────────────────────────────────── */

const vide = (
  mode: RolloutMode, target: CanonicalEntityTarget, extra: Partial<CanonicalEntityWriteResult> = {},
): CanonicalEntityWriteResult => ({ mode, target, assetId: null, dryRun: true, skipped: false, notFound: false, fields: [], ...extra });

async function emettre(accountId: number, assetId: number): Promise<void> {
  try {
    const { emitBusinessEvent } = await import('@/services/verebona-assistant/events/business-events');
    await emitBusinessEvent({ type: 'ASSET_UPDATED', accountId, entityId: assetId });
  } catch (e) {
    console.warn('[canonical] ASSET_UPDATED non publié :', (e as Error).message);
  }
}

/** Écrit plusieurs clés d'UNE entité en une transaction. Voir l'en-tête. */
export async function writeCanonicalEntityFields(
  input: WriteCanonicalEntityFieldsInput,
  run: TxRunner = pgClient as unknown as TxRunner,
): Promise<CanonicalEntityWriteResult> {
  const mode = input.mode ?? canonicalWriteMode();
  if (mode === 'legacy') return vide(mode, input.target, { skipped: true });
  if (!(await entityCanonicalColumnsReady())) return vide(mode, input.target, { skipped: true, schemaNotReady: true });
  const ctx = { origin: input.origin, now: new Date().toISOString() };

  if (mode === 'shadow') {
    const row = await loadEntityRow(run, input.target, input.accountId);
    if (!row) return vide(mode, input.target, { notFound: true });
    const plan = planEntityWrites(row, input.writes, ctx);
    await journal(run, input, row.assetId, plan.results, true);
    return vide(mode, input.target, { assetId: row.assetId, fields: plan.results });
  }

  let out = vide(mode, input.target, { dryRun: false });
  await run.begin(async (t) => {
    const row = await loadEntityRow(t, input.target, input.accountId, true);
    if (!row) { out = vide(mode, input.target, { dryRun: false, notFound: true }); return; }
    const plan = planEntityWrites(row, input.writes, ctx);
    if (plan.changed) await persist(t, row, plan);
    await journal(t, input, row.assetId, plan.results, false);
    out = { mode, target: input.target, assetId: row.assetId, dryRun: false, skipped: false, notFound: false, fields: plan.results };
  });
  if (out.assetId && input.emitEvent !== false && out.fields.some((f) => f.outcome === 'written')) {
    await emettre(input.accountId, out.assetId);
  }
  return out;
}

/** Écrit UNE clé canonique d'un équipement ou d'une pièce. */
export async function writeCanonicalEntityField(
  input: WriteCanonicalEntityFieldInput,
  run?: TxRunner,
): Promise<CanonicalEntityWriteResult & { field: CanonicalFieldWriteResult | null }> {
  const { key, value, expectedCurrent, sourceUnit, trace, ...rest } = input;
  const res = await writeCanonicalEntityFields({ ...rest, writes: [{ key, value, expectedCurrent, sourceUnit, trace }] }, run);
  return { ...res, field: res.fields[0] ?? null };
}

/**
 * Édition MANUELLE d'un équipement ou d'une pièce par l'écran (hors
 * commutateur, lot 18) : les clés dont la nouvelle valeur DIFFÈRE de la vue
 * de l'entité AVANT l'édition (fiche 0227, puis colonne — relecture lot 18 :
 * pas seulement la colonne) reçoivent dans la fiche la nouvelle valeur et
 * l'origine USER (`__updatedAt`, autorité et date de preuve retirées) —
 * sinon une valeur automatique de la fiche masquerait la saisie, et T3
 * pourrait la remplacer. Journal 0216 (`asset_details`).
 *
 * `before` : vue lue AVANT que le chemin historique n'écrive les colonnes
 * (la route la lit, puis écrit) ; absente, elle est lue ici (appelant qui
 * n'a encore rien écrit). Ne lève jamais ; sans 0227 : rien.
 */
export async function recordManualEntityEdit(
  p: {
    target: CanonicalEntityTarget; accountId: number; actorUserId?: number | null;
    /** Nouvelles valeurs canoniques, par clé (ex. `acquisitionPrice` en euros). */
    after: Record<string, unknown>;
    before?: CanonicalEntityState | null;
  },
  run: TxRunner = pgClient as unknown as TxRunner,
): Promise<string[]> {
  try {
    if (Object.keys(p.after).length === 0 || !(await entityCanonicalColumnsReady())) return [];
    let vue = p.before;
    if (vue === undefined) {
      const row = await loadEntityRow(run, p.target, p.accountId);
      vue = row ? buildCanonicalEntityState(row) : null;
    }
    if (!vue) return [];
    const etat = vue;
    const cles = Object.keys(p.after).filter((k) => {
      const def = resolveEntityDef(k);
      const courant = def ? etat.fields[def.key]?.value ?? null : null;
      return !sameCanonicalValue(def?.key ?? k, courant, p.after[k] ?? null);
    });
    if (cles.length === 0) return [];
    const res = await writeCanonicalEntityFields({
      target: p.target, accountId: p.accountId, origin: 'USER', actorUserId: p.actorUserId ?? null,
      source: { type: 'asset_details', id: null }, mode: 'enabled', emitEvent: false,
      writes: cles.map((k) => ({ key: k, value: p.after[k] ?? null })),
    }, run);
    return res.fields.filter((f) => f.outcome === 'written').map((f) => f.key);
  } catch (e) {
    console.warn('[canonical] origine USER de l’entité non posée (non bloquant) :', (e as Error).message);
    return [];
  }
}
