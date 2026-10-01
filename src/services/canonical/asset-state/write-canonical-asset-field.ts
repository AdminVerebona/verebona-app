/**
 * writeCanonicalAssetField() — écriture unique d'un champ de bien
 * (CDC 15 §12 SVC-05, T3-01, T3-02, T3-05, T2-38 ; plan lot 11, D-09, D-10).
 *
 * Une écriture, quel que soit l'appelant (fiche, assistant, T3, import,
 * administration) :
 *   1. une transaction, avec `SELECT … FOR UPDATE` sur la ligne du bien
 *      (bornée au compte) — une sauvegarde automatique concurrente attend,
 *      elle ne s'entrelace pas ;
 *   2. la clé est résolue (alias → clé canonique) et la valeur normalisée par
 *      le registre (euros dans la fiche, D-09) ;
 *   3. la préséance des origines est appliquée (`canOverwrite`) : une valeur
 *      USER/ADMIN renseignée n'est jamais remplacée par une origine
 *      automatique ;
 *   4. `keyCharacteristics` (source de vérité, D-10) reçoit la valeur,
 *      `<clé>__origin` et `<clé>__updatedAt` ; les alias déjà présents dans
 *      la fiche sont alignés ; les colonnes miroirs (`purchase_date`,
 *      `purchase_price_cents`, `registration_number`, …) sont recopiées par
 *      `toMirrorValue` dans le MÊME `UPDATE` ;
 *   5. le journal `canonical_field_writes` reçoit une ligne par clé (0216) ;
 *      une origine automatique alimente aussi `ai_field_updates` (accueil,
 *      « Ce que j'ai fait ») ;
 *   6. après validation, ASSET_UPDATED invalide les caches de l'assistant.
 *
 * Modes (`CANONICAL_WRITE_MODE`, voir `rollout.ts`) :
 *   legacy   la primitive ne fait rien (`skipped`) ; le chemin historique écrit ;
 *   shadow   rien n'est écrit dans le bien : la primitive calcule l'état final
 *            et le journalise `dry_run = true` (avec la divergence observée
 *            quand le chemin historique a écrit — `observeLegacyWrite`) ;
 *   enabled  la primitive écrit.
 */
import { pgClient } from '@/db';
import { canOverwrite, isHumanOrigin, writeOrigin } from '@/services/ai/reconciliation/field-origin';
import {
  eurToCents, getField, isExcludedKey, normalizeValue, resolveAlias, toMirrorValue,
  type AssetFamily, type CanonicalFieldDef,
} from '@/services/canonical/registry';
import { canonicalWriteMode, type RolloutMode } from '@/services/canonical/rollout';
import {
  indexKcAliases, isEmptyValue, loadAssetRow, parseKc, readFieldState, rowFamily,
  type AssetRowJson, type SqlRunner,
} from './canonical-asset-view';
import type {
  CanonicalFieldWrite, CanonicalFieldWriteResult, CanonicalOrigin, CanonicalWriteResult,
  CanonicalWriteSource, WriteCanonicalAssetFieldInput, WriteCanonicalAssetFieldsInput,
} from './types';

/* ── Comparaisons ────────────────────────────────────────────────────────── */

const texte = (v: unknown): string | null =>
  v === null || v === undefined ? null : typeof v === 'string' ? v : JSON.stringify(v);

/** Égalité de deux valeurs pour une clé canonique (après normalisation). */
export function sameCanonicalValue(key: string, a: unknown, b: unknown): boolean {
  const ea = isEmptyValue(a);
  const eb = isEmptyValue(b);
  if (ea || eb) return ea && eb;
  const na = normalizeValue(key, a);
  const nb = normalizeValue(key, b);
  return texte(na.ok ? na.value : a) === texte(nb.ok ? nb.value : b);
}

/** Égalité d'une valeur de colonne (dates `AAAA-MM-JJ`, nombres, texte). */
function sameColumnValue(a: unknown, b: unknown): boolean {
  const ea = isEmptyValue(a);
  const eb = isEmptyValue(b);
  if (ea || eb) return ea && eb;
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  const sa = String(a);
  const sb = String(b);
  if (/^\d{4}-\d{2}-\d{2}/.test(sa) && /^\d{4}-\d{2}-\d{2}/.test(sb)) return sa.slice(0, 10) === sb.slice(0, 10);
  return sa === sb;
}

/* ── Plan (fonction pure) ────────────────────────────────────────────────── */

export interface PlanContext {
  origin: CanonicalOrigin;
  /** Date ISO posée dans `<clé>__updatedAt`. */
  now: string;
  /**
   * Conserver la clé brute demandée quand c'est un alias (écran qui lit
   * encore cette clé). Faux par défaut : seule la clé canonique est écrite.
   */
  keepRequestedKey?: boolean;
  /**
   * Écriture humaine d'une valeur IDENTIQUE à celle en place : la confirmer
   * (elle devient USER/ADMIN, T3-02) — défaut, pour une écriture ciblée
   * (commande « mets X à … »). Faux pour l'enregistrement d'une SECTION
   * entière de la fiche : le client renvoie toutes les clés, et une valeur
   * non modifiée ne doit pas changer d'origine (relecture lot 13).
   */
  confirmUnchanged?: boolean;
}

export interface CanonicalWritePlan {
  family: AssetFamily;
  /** keyCharacteristics après écriture. */
  kc: Record<string, unknown>;
  /** Colonnes historiques à recopier (nom SQL → valeur). */
  columns: Record<string, unknown>;
  results: CanonicalFieldWriteResult[];
  /** Au moins une clé écrite (valeur ou origine). */
  changed: boolean;
}

/**
 * Définition applicable à la famille : la clé canonique si elle s'y applique,
 * sinon l'alias de cette famille (`generalCondition` : clé canonique en
 * IMMOBILIER, alias de `condition` pour un OBJET). À défaut, la définition
 * directe (→ FIELD_NOT_APPLICABLE).
 */
export function resolveDefForFamily(rawKey: string, family: AssetFamily): CanonicalFieldDef | undefined {
  const direct = getField(rawKey);
  if (direct?.families.includes(family)) return direct;
  const key = resolveAlias(rawKey, family);
  const viaAlias = key ? getField(key) : undefined;
  return viaAlias ?? direct;
}

/** Le champ peut-il viser un BIEN (`targetTypes`, sinon `targetType`, défaut ASSET) ? */
export function fieldTargetsAsset(def: CanonicalFieldDef): boolean {
  const cibles = def.targetTypes ?? [def.targetType ?? 'ASSET'];
  return cibles.includes('ASSET');
}

/**
 * Calcule l'état final d'une série d'écritures sur une ligne de bien, sans
 * rien écrire. Utilisé pour écrire (mode enabled) et pour observer (shadow).
 * Les écritures sont appliquées dans l'ordre, chacune voyant les précédentes.
 */
export function planCanonicalWrites(
  row: AssetRowJson,
  writes: CanonicalFieldWrite[],
  ctx: PlanContext,
): CanonicalWritePlan {
  const family = rowFamily(row.category);
  let kc = parseKc(row.key_characteristics);
  const columns: Record<string, unknown> = {};
  const results: CanonicalFieldWriteResult[] = [];
  const vueCourante = () => ({ ...row, ...columns });

  for (const w of writes) {
    const base = {
      requestedKey: w.key, origin: ctx.origin, mirrors: {} as Record<string, unknown>,
    };
    const refuse = (key: string, outcome: CanonicalFieldWriteResult['outcome'], reason: string,
      previousValue: unknown = null, previousOrigin: CanonicalOrigin | null = null): void => {
      results.push({ ...base, key, outcome, reason, previousValue, previousOrigin, nextValue: previousValue });
    };

    if (isExcludedKey(w.key)) { refuse(w.key, 'invalid', 'EXCLUDED_KEY'); continue; }
    const def = resolveDefForFamily(w.key, family);
    if (!def) { refuse(w.key, 'invalid', 'UNKNOWN_KEY'); continue; }
    if (!def.families.includes(family)) { refuse(def.key, 'invalid', 'FIELD_NOT_APPLICABLE'); continue; }
    // Champ d'une autre cible (pièce, équipement, document…) : jamais écrit
    // dans la fiche du BIEN (CDC 15 T1-04, relecture lot 13) — ex. `roomArea`.
    if (!fieldTargetsAsset(def)) { refuse(def.key, 'invalid', 'TARGET_NOT_ASSET'); continue; }

    // Unité : celle déclarée par l'appelant, sinon celle portée par l'alias.
    const unit = w.sourceUnit ?? (w.key !== def.key ? def.aliasUnits?.[w.key] : undefined);
    const norm = normalizeValue(def.key, w.value, unit ? { sourceUnit: unit } : {});
    if (!norm.ok) { refuse(def.key, 'invalid', norm.reason); continue; }
    const next = norm.value;

    const aliases = indexKcAliases(kc, family).get(def.key) ?? [];
    const current = readFieldState(def, kc, vueCourante(), aliases);
    const previousValue = current?.value ?? null;
    const previousOrigin = current?.origin ?? null;

    // Contrôle optimiste : la valeur en place n'est plus celle attendue.
    if (w.expectedCurrent !== undefined && !sameCanonicalValue(def.key, previousValue, w.expectedCurrent)) {
      refuse(def.key, 'conflict', 'CURRENT_VALUE_CHANGED', previousValue, previousOrigin);
      continue;
    }

    // Préséance : une valeur humaine renseignée n'est jamais remplacée par
    // une origine automatique (même valeur comprise : l'origine reste USER).
    const decision = canOverwrite({ origin: previousOrigin ?? 'USER', empty: !current }, ctx.origin);
    if (!decision.allowed) {
      refuse(def.key, 'protected', decision.reason, previousValue, previousOrigin);
      continue;
    }

    // Même valeur : rien à écrire, SAUF écriture humaine sur une valeur
    // d'une autre origine (elle devient USER/ADMIN, T3-02) ou lue en repli
    // (alias, colonne : elle est matérialisée sous la clé canonique).
    if (sameCanonicalValue(def.key, previousValue, next)) {
      const humanConfirms = ctx.confirmUnchanged !== false && isHumanOrigin(ctx.origin) && current !== null
        && (current.origin !== ctx.origin || current.from !== 'key');
      if (!humanConfirms) {
        results.push({ ...base, key: def.key, outcome: 'unchanged', previousValue, previousOrigin, nextValue: previousValue });
        continue;
      }
    }

    // ── Fiche (D-10) ──
    const n: Record<string, unknown> = { ...kc };
    if (next === null) delete n[def.key];
    else n[def.key] = next;
    kc = writeOrigin(n, def.key, ctx.origin, { updatedAt: ctx.now });
    if (!isHumanOrigin(ctx.origin)) {
      if (w.trace?.authority !== undefined && w.trace.authority !== null) kc[`${def.key}__authority`] = w.trace.authority;
      if (w.trace?.sourceDate !== undefined) kc[`${def.key}__sourceDate`] = w.trace.sourceDate;
    }

    // Alias déjà présents (et clé brute demandée si l'écran la lit encore) :
    // alignés sur la même valeur, dans leur unité, jusqu'au rattrapage MIG-01.
    const aSynchroniser = new Map(aliases.map((a) => [a.rawKey, a.sourceUnit]));
    if (ctx.keepRequestedKey && w.key !== def.key) aSynchroniser.set(w.key, def.aliasUnits?.[w.key]);
    for (const [alias, aliasUnit] of aSynchroniser) {
      if (next === null) delete kc[alias];
      else kc[alias] = aliasUnit === 'cents' && typeof next === 'number' ? eurToCents(next) : next;
      delete kc[`${alias}__origin`];
      delete kc[`${alias}_origin`];
      delete kc[`${alias}__updatedAt`];
    }

    // ── Colonnes miroirs (D-10) ──
    const mirrors: Record<string, unknown> = {};
    if (next === null) for (const col of def.mirrorColumns ?? []) mirrors[col.column] = null;
    else Object.assign(mirrors, toMirrorValue(def.key, next));
    Object.assign(columns, mirrors);

    results.push({
      ...base, key: def.key, outcome: 'written', previousValue, previousOrigin, nextValue: next, mirrors,
    });
  }

  return { family, kc, columns, results, changed: results.some((r) => r.outcome === 'written') };
}

/* ── Divergence (mode shadow) ────────────────────────────────────────────── */

export interface WriteDivergence {
  value?: { legacy: unknown; canonical: unknown };
  origin?: { legacy: CanonicalOrigin | null; canonical: CanonicalOrigin };
  mirrors?: Record<string, { legacy: unknown; canonical: unknown }>;
}

/**
 * Écart entre l'état écrit par le chemin historique (`after`) et l'état que
 * la primitive aurait produit pour une clé. `null` : aucun écart.
 */
export function divergenceOf(result: CanonicalFieldWriteResult, after: AssetRowJson): WriteDivergence | null {
  const def = getField(result.key);
  if (!def) return null;
  const kc = parseKc(after.key_characteristics);
  const st = readFieldState(def, kc, after, indexKcAliases(kc, rowFamily(after.category)).get(def.key));
  const d: WriteDivergence = {};
  if (!sameCanonicalValue(def.key, st?.value ?? null, result.nextValue)) {
    d.value = { legacy: st?.value ?? null, canonical: result.nextValue };
  }
  if (result.outcome === 'written' && !isEmptyValue(result.nextValue) && st && st.origin !== result.origin) {
    d.origin = { legacy: st.origin, canonical: result.origin };
  }
  for (const [col, v] of Object.entries(result.mirrors)) {
    if (!sameColumnValue(after[col], v)) (d.mirrors ??= {})[col] = { legacy: after[col] ?? null, canonical: v };
  }
  return Object.keys(d).length ? d : null;
}

/* ── Persistance ─────────────────────────────────────────────────────────── */

const COLONNE_SQL = /^[a-z_][a-z0-9_]*$/;
/** Colonnes que la primitive (ou son hook) peut écrire en plus des miroirs. */
const COLONNES_INTERDITES = new Set(['id', 'account_id', 'user_id', 'public_id', 'deleted_at', 'key_characteristics', 'updated_at', 'created_at']);

async function updateAssetRow(
  t: SqlRunner, assetId: number, accountId: number, kc: Record<string, unknown>, columns: Record<string, unknown>,
): Promise<void> {
  const sets = ['key_characteristics = $3', 'updated_at = now()'];
  const params: unknown[] = [assetId, accountId, JSON.stringify(kc)];
  for (const [col, v] of Object.entries(columns)) {
    if (!COLONNE_SQL.test(col) || COLONNES_INTERDITES.has(col)) throw new Error(`colonne non autorisée : ${col}`);
    params.push(v === undefined ? null : v);
    sets.push(`${col} = $${params.length}`);
  }
  await t.unsafe(
    `UPDATE assets SET ${sets.join(', ')} WHERE id = $1 AND account_id = $2`,
    params as never[],
  );
}

interface JournalContext {
  accountId: number;
  assetId: number;
  origin: CanonicalOrigin;
  actorUserId?: number | null;
  source?: CanonicalWriteSource;
  traceId?: string | null;
  dryRun: boolean;
}

const jsonb = (v: unknown) => (v === undefined ? null : JSON.stringify(v));

/** Lignes du journal 0216 ; les écritures sans effet ne sont pas journalisées (sauf divergence). Un seul INSERT. */
async function journal(
  t: SqlRunner,
  ctx: JournalContext,
  rows: Array<{ r: CanonicalFieldWriteResult; divergence?: WriteDivergence | null }>,
): Promise<void> {
  const retenues = rows.filter(({ r, divergence }) => r.outcome !== 'unchanged' || divergence);
  if (retenues.length === 0) return;
  const params: unknown[] = [];
  const tuples = retenues.map(({ r, divergence }) => {
    const v = [
      ctx.accountId, ctx.assetId, r.key, jsonb(r.previousValue), jsonb(r.nextValue), ctx.origin,
      ctx.actorUserId ?? null, ctx.source?.type ?? null,
      ctx.source?.id === undefined || ctx.source?.id === null ? null : String(ctx.source.id),
      ctx.traceId ?? null, r.outcome, ctx.dryRun,
      divergence ? JSON.stringify(divergence) : null,
      Object.keys(r.mirrors).length ? JSON.stringify(r.mirrors) : null,
    ];
    const casts = ['', '', '', '::jsonb', '::jsonb', '', '', '', '', '', '', '', '::jsonb', '::jsonb'];
    const ph = v.map((x, i) => { params.push(x); return `$${params.length}${casts[i]}`; });
    return `(${ph.join(', ')})`;
  });
  await t.unsafe(
    `INSERT INTO canonical_field_writes
       (account_id, asset_id, canonical_key, old_value, new_value, origin, actor_user_id,
        source_type, source_id, trace_id, outcome, dry_run, divergence, mirror_columns)
     VALUES ${tuples.join(', ')}`,
    params as never[],
  );
}

/**
 * Écriture automatique appliquée : ligne `ai_field_updates` (même forme que
 * `applyDecision` — l'accueil « Ce que j'ai fait » la lit par `field_key`).
 */
async function traceAutomatic(
  t: SqlRunner,
  input: WriteCanonicalAssetFieldsInput,
  plan: CanonicalWritePlan,
): Promise<void> {
  if (isHumanOrigin(input.origin)) return;
  const ecrites = plan.results.filter((r) => r.outcome === 'written');
  if (ecrites.length === 0) return;
  const docId = input.source?.type === 'document' && Number.isInteger(Number(input.source.id)) ? Number(input.source.id) : null;
  const lignes = ecrites.map((r) => {
    const tr = input.writes.find((w) => w.key === r.requestedKey)?.trace;
    const extra: Record<string, unknown> = {
      evidence_id: tr?.evidenceId, decision_type: tr?.decisionType, reason_code: tr?.reasonCode,
      provider: tr?.provider, model: tr?.model, prompt_version: tr?.promptVersion, confidence: tr?.confidence,
    };
    return {
      base: [input.accountId, input.assetId, docId, r.key, texte(r.previousValue), texte(r.nextValue) ?? ''],
      extra,
    };
  });
  // Colonnes de la migration 0103 : seulement celles qu'un appelant renseigne.
  const extraCols = ['evidence_id', 'decision_type', 'reason_code', 'provider', 'model', 'prompt_version', 'confidence']
    .filter((c) => lignes.some((l) => l.extra[c] !== undefined && l.extra[c] !== null));
  const cols = ['account_id', 'asset_id', 'asset_file_id', 'field_key', 'old_value', 'new_value', ...extraCols];
  const params: unknown[] = [];
  const tuples = lignes.map((l) => {
    const v = [...l.base, ...extraCols.map((c) => l.extra[c] ?? null)];
    return `(${v.map((x) => { params.push(x); return `$${params.length}`; }).join(', ')})`;
  });
  await t.unsafe(`INSERT INTO ai_field_updates (${cols.join(', ')}) VALUES ${tuples.join(', ')}`, params as never[]);
}

/* ── API ─────────────────────────────────────────────────────────────────── */

export interface WriteHookContext {
  row: AssetRowJson;
  /** keyCharacteristics après les écritures canoniques — modifiable en place. */
  kc: Record<string, unknown>;
  results: CanonicalFieldWriteResult[];
  /**
   * Transaction en cours (ligne verrouillée) : écritures annexes ATOMIQUES
   * avec la mise à jour du bien (ex. copie de sauvegarde des rattrapages
   * CDC 15, lot 17).
   */
  tx: SqlRunner;
}

export interface WriteHooks {
  /** Conserver la clé brute demandée quand c'est un alias (fiche). */
  keepRequestedKey?: boolean;
  /** Voir `PlanContext.confirmUnchanged` (faux : section entière de la fiche). */
  confirmUnchanged?: boolean;
  /**
   * Appelé dans la transaction, ligne verrouillée, avant l'`UPDATE` : peut
   * lever (tout est annulé), modifier `kc` en place et renvoyer des colonnes
   * supplémentaires (`name`, `status`, `subtype`…). Sa présence force
   * l'écriture de la ligne même sans champ canonique modifié.
   */
  mutate?: (ctx: WriteHookContext) => Record<string, unknown> | void | Promise<Record<string, unknown> | void>;
}

const vide = (mode: RolloutMode, extra: Partial<CanonicalWriteResult> = {}): CanonicalWriteResult =>
  ({ mode, dryRun: true, skipped: false, notFound: false, fields: [], ...extra });

async function emettre(accountId: number, assetId: number): Promise<void> {
  try {
    const { emitBusinessEvent } = await import('@/services/verebona-assistant/events/business-events');
    await emitBusinessEvent({ type: 'ASSET_UPDATED', accountId, entityId: assetId });
  } catch (e) {
    console.warn('[canonical] ASSET_UPDATED non publié :', (e as Error).message);
  }
}

/**
 * Écrit plusieurs clés d'un même bien en UNE transaction (une section de la
 * fiche, un lot T3). Voir l'en-tête du module.
 */
/** Client capable d'ouvrir une transaction (pgClient, ou double de test). */
export type TxRunner = SqlRunner & { begin: (fn: (t: SqlRunner) => Promise<unknown>) => Promise<unknown> };

export async function writeCanonicalAssetFields(
  input: WriteCanonicalAssetFieldsInput,
  hooks: WriteHooks = {},
  run: TxRunner = pgClient as unknown as TxRunner,
): Promise<CanonicalWriteResult> {
  const mode = input.mode ?? canonicalWriteMode();
  if (mode === 'legacy') return vide(mode, { skipped: true });
  const ctxPlan: PlanContext = {
    origin: input.origin, now: new Date().toISOString(), keepRequestedKey: hooks.keepRequestedKey,
    confirmUnchanged: hooks.confirmUnchanged,
  };
  const jctx: JournalContext = {
    accountId: input.accountId, assetId: input.assetId, origin: input.origin,
    actorUserId: input.actorUserId, source: input.source, traceId: input.traceId, dryRun: mode !== 'enabled',
  };

  if (mode === 'shadow') {
    // Observation : lecture sans verrou, journal `dry_run`, bien intact.
    const row = await loadAssetRow(run, input.assetId, input.accountId);
    if (!row) return vide(mode, { notFound: true });
    const plan = planCanonicalWrites(row, input.writes, ctxPlan);
    await journal(run, jctx, plan.results.map((r) => ({ r })));
    return vide(mode, { fields: plan.results });
  }

  let out: CanonicalWriteResult = vide(mode, { dryRun: false });
  await run.begin(async (t) => {
    const row = await loadAssetRow(t, input.assetId, input.accountId, true);
    if (!row) { out = vide(mode, { dryRun: false, notFound: true }); return; }
    const plan = planCanonicalWrites(row, input.writes, ctxPlan);
    let extra: Record<string, unknown> = {};
    if (hooks.mutate) extra = (await hooks.mutate({ row, kc: plan.kc, results: plan.results, tx: t })) ?? {};
    if (plan.changed || hooks.mutate) {
      await updateAssetRow(t, input.assetId, input.accountId, plan.kc, { ...plan.columns, ...extra });
    }
    await journal(t, jctx, plan.results.map((r) => ({ r })));
    await traceAutomatic(t, input, plan);
    out = { mode, dryRun: false, skipped: false, notFound: false, fields: plan.results };
  });

  const ecrit = out.fields.some((f) => f.outcome === 'written') || (!!hooks.mutate && !out.notFound);
  if (ecrit && input.emitEvent !== false) await emettre(input.accountId, input.assetId);
  return out;
}

/** Écrit UNE clé canonique d'un bien. Voir l'en-tête du module. */
export async function writeCanonicalAssetField(
  input: WriteCanonicalAssetFieldInput,
  run?: TxRunner,
): Promise<CanonicalWriteResult & { field: CanonicalFieldWriteResult | null }> {
  const { key, value, expectedCurrent, sourceUnit, trace, ...rest } = input;
  const res = await writeCanonicalAssetFields({ ...rest, writes: [{ key, value, expectedCurrent, sourceUnit, trace }] }, {}, run);
  return { ...res, field: res.fields[0] ?? null };
}

/**
 * Mode shadow : le chemin historique vient d'écrire (`before` → `after`).
 * Calcule ce que la primitive aurait écrit à partir de `before`, et
 * journalise `dry_run = true` avec l'écart constaté. Ne lève jamais :
 * l'observation ne doit pas faire échouer l'écriture de l'utilisateur.
 */
export async function observeLegacyWrite(
  p: Omit<WriteCanonicalAssetFieldsInput, 'mode' | 'emitEvent'> & {
    before: AssetRowJson;
    after: AssetRowJson;
    keepRequestedKey?: boolean;
  },
  run: SqlRunner = pgClient as unknown as SqlRunner,
): Promise<Array<{ result: CanonicalFieldWriteResult; divergence: WriteDivergence | null }>> {
  try {
    const plan = planCanonicalWrites(p.before, p.writes, {
      origin: p.origin, now: new Date().toISOString(), keepRequestedKey: p.keepRequestedKey,
    });
    const rows = plan.results.map((r) => ({ r, divergence: divergenceOf(r, p.after) }));
    await journal(run, {
      accountId: p.accountId, assetId: p.assetId, origin: p.origin, actorUserId: p.actorUserId,
      source: p.source, traceId: p.traceId, dryRun: true,
    }, rows);
    const divergents = rows.filter((x) => x.divergence).length;
    if (divergents) console.info(`[canonical][shadow] bien ${p.assetId} : ${divergents} divergence(s) journalisée(s)`);
    return rows.map(({ r, divergence }) => ({ result: r, divergence: divergence ?? null }));
  } catch (e) {
    console.warn('[canonical][shadow] observation impossible (non bloquant) :', (e as Error).message);
    return [];
  }
}
