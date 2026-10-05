/**
 * Application d'une décision — CDC §5.4.3 ; CDC 15 T3-01, T3-05 (lot 13).
 *
 * Toute écriture automatique laisse trois traces indissociables :
 *   1. la nouvelle valeur, avec son origine structurée ;
 *   2. l'autorité et la date de la preuve, pour les arbitrages futurs ;
 *   3. une ligne d'historique rattachée à la preuve et au motif.
 *
 * Sans le point 2, la prochaine exécution comparerait une nouvelle preuve à une
 * valeur d'autorité inconnue et déciderait à l'aveugle.
 *
 * ── ÉCRITURE UNIQUE (T3-01, T3-05) ─────────────────────────────────────────
 * Lot 16b-3 : commutateur `CANONICAL_WRITE_MODE` supprimé (comportement de
 * l'ancien `enabled`). Une clé du REGISTRE passe toujours par
 * `writeCanonicalAssetField` (origine RECONCILIATION, normalisation, colonnes
 * miroirs, journal 0216, `ai_field_updates`, préséance USER/ADMIN sous
 * verrou) : une même valeur écrite par la fiche et par T3 donne le même état,
 * à l'origine près. Une clé HORS registre (fait générique) est écrite dans
 * keyCharacteristics, avec son historique.
 */
import { db, pgClient } from '@/db';
import { assets, aiFieldUpdates } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { writeOrigin } from './field-origin';
import { getField, resolveAlias, isExcludedKey, isInputOnlyKey } from '@/services/canonical/registry';
import {
  writeCanonicalAssetField, type CanonicalFieldWriteResult,
} from '@/services/canonical/asset-state';
import type { ReconciliationDecision, EvidenceCandidate } from './types';

/** Clé écrite par la primitive : clé canonique ou alias connu du registre. */
export function isRegistryKey(fieldKey: string): boolean {
  if (isExcludedKey(fieldKey)) return false;
  return !!getField(fieldKey) || !!resolveAlias(fieldKey);
}

export interface ApplyContext {
  accountId: number;
  assetId: number;
  sourceFileId: number | null;
  provider?: string;
  model?: string;
  promptVersion?: string;
  bestCandidate?: EvidenceCandidate;
  /** Trace du run T3 (journal 0216). */
  traceId?: string | null;
}

/** Résultat d'une application (tests, rapport). */
export type ApplyOutcome = 'written' | 'skipped' | 'protected' | 'conflict' | 'invalid' | 'unchanged';

export async function applyDecision(
  decision: ReconciliationDecision,
  ctx: ApplyContext,
): Promise<ApplyOutcome> {
  if (decision.action !== 'apply' && decision.action !== 'update') return 'skipped';
  // D-D (lot 20) : un champ de saisie seule n'est jamais écrit par T3, dans
  // aucun mode (le chemin historique écrivait toute clé brute).
  if (isInputOnlyKey(decision.fieldKey)) return 'skipped';

  if (isRegistryKey(decision.fieldKey)) {
    const res = await writeCanonicalAssetField({
      assetId: ctx.assetId, accountId: ctx.accountId,
      key: decision.fieldKey, value: decision.proposedValue,
      origin: 'RECONCILIATION',
      expectedCurrent: decision.currentValue ?? null,
      source: ctx.sourceFileId ? { type: 'document', id: ctx.sourceFileId } : { type: 'reconciliation', id: ctx.traceId ?? null },
      traceId: ctx.traceId ?? null,
      trace: {
        evidenceId: decision.evidenceIds[0] ?? null, decisionType: decision.action, reasonCode: decision.reasonCode,
        provider: ctx.provider ?? null, model: ctx.model ?? null, promptVersion: ctx.promptVersion ?? null,
        confidence: decision.confidence, authority: decision.sourcePriority ?? 0,
        sourceDate: ctx.bestCandidate?.documentDate?.toISOString() ?? null,
      },
    });
    return outcomeOf(decision.fieldKey, res.notFound ? null : res.field);
  }

  return applyOutsideRegistry(decision, ctx);
}

function outcomeOf(fieldKey: string, f: CanonicalFieldWriteResult | null): ApplyOutcome {
  if (!f) return 'skipped';
  if (f.outcome === 'conflict') {
    console.info(`[reconciliation] ${fieldKey} modifié entre-temps — application annulée`);
  } else if (f.outcome === 'protected') {
    console.info(`[reconciliation] ${fieldKey} : valeur humaine protégée — rien n'est écrit`);
  } else if (f.outcome === 'invalid') {
    console.warn(`[reconciliation] ${fieldKey} : valeur refusée par le registre (${f.reason ?? '?'})`);
  }
  return f.outcome;
}

/** Clé hors registre (fait générique) : keyCharacteristics et historique. */
async function applyOutsideRegistry(
  decision: ReconciliationDecision,
  ctx: ApplyContext,
): Promise<ApplyOutcome> {
  const [asset] = await db
    .select({ keyCharacteristics: assets.keyCharacteristics })
    .from(assets)
    .where(and(eq(assets.id, ctx.assetId), eq(assets.accountId, ctx.accountId)))
    .limit(1);

  if (!asset) return 'skipped';

  const kc = parseKc(asset.keyCharacteristics);

  // Relecture de sécurité : entre la décision et son application, l'utilisateur
  // a pu saisir une valeur. On ne recouvre jamais une écriture concurrente.
  const currentNow = kc[decision.fieldKey];
  if (!isSameAsDecided(currentNow, decision.currentValue)) {
    console.info(
      `[reconciliation] ${decision.fieldKey} modifié entre-temps — application annulée`,
    );
    return 'conflict';
  }

  let next = { ...kc, [decision.fieldKey]: decision.proposedValue };
  next = writeOrigin(next, decision.fieldKey, 'RECONCILIATION');
  next[`${decision.fieldKey}__updatedAt`] = new Date().toISOString();
  next[`${decision.fieldKey}__authority`] = decision.sourcePriority ?? 0;
  next[`${decision.fieldKey}__sourceDate`] =
    ctx.bestCandidate?.documentDate?.toISOString() ?? null;

  await db.update(assets)
    .set({ keyCharacteristics: JSON.stringify(next), updatedAt: new Date() } as never)
    .where(and(eq(assets.id, ctx.assetId), eq(assets.accountId, ctx.accountId)));

  await db.insert(aiFieldUpdates).values({
    accountId: ctx.accountId,
    assetId: ctx.assetId,
    assetFileId: ctx.sourceFileId ?? undefined,
    fieldKey: decision.fieldKey,
    oldValue: toText(decision.currentValue),
    newValue: toText(decision.proposedValue) ?? '',
    // Colonnes ajoutées par la migration 0103.
    evidenceId: decision.evidenceIds[0] ?? null,
    decisionType: decision.action,
    reasonCode: decision.reasonCode,
    provider: ctx.provider ?? null,
    model: ctx.model ?? null,
    promptVersion: ctx.promptVersion ?? null,
    confidence: decision.confidence,
  } as never);
  return 'written';
}

/**
 * ══════════════════════════════════════════════════════════════════════════
 * ANNULATION D'UNE MODIFICATION AUTOMATIQUE — NON IMPLÉMENTÉE
 *
 * Décision métier du 28/07/2026, question 5, option C : « Non. L'utilisateur
 * modifie la valeur à la main s'il n'est pas d'accord. »
 *
 * Les colonnes `reverted_at` et `reverted_by` de `ai_field_updates`
 * (migration 0103) sont conservées : elles ne coûtent rien et rouvrent la
 * possibilité sans migration si la décision évolue.
 *
 * ⚠️ CONSÉQUENCE À VALIDER : la route `/api/ai-history/[id]/revert` existe déjà
 * dans le dépôt et est exposée aux utilisateurs. Retenir l'option C revient
 * donc à SUPPRIMER une capacité existante, et non à s'abstenir d'en ajouter
 * une. Voir la note du README du lot 3.
 * ══════════════════════════════════════════════════════════════════════════
 */

function parseKc(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  try { return JSON.parse(String(raw)) as Record<string, unknown>; } catch { return {}; }
}

function toText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return typeof v === 'string' ? v : JSON.stringify(v);
}

function isSameAsDecided(actual: unknown, decided: unknown): boolean {
  return toText(actual) === toText(decided);
}

// ── Réconciliation négative (CDC 15 T3-04) ──────────────────────────────────

export const RETRACTION_REASON = 'NO_REMAINING_EVIDENCE';

export interface RetractInput {
  accountId: number;
  assetId: number;
  fieldKey: string;
  /** Valeur lue par la décision : rien n'est retiré si elle a changé entre-temps. */
  currentValue: unknown;
  traceId?: string | null;
}

/**
 * Retire une valeur AUTOMATIQUE qui n'a plus aucune preuve active.
 *
 * Clé du registre : `writeCanonicalAssetField` (valeur null, origine
 * RECONCILIATION) — suppression dans la fiche, colonnes miroirs remises à
 * NULL, journal 0216 et `ai_field_updates` (motif NO_REMAINING_EVIDENCE),
 * contrôle optimiste et préséance USER/ADMIN SOUS VERROU : une valeur
 * humaine n'est jamais retirée, même si l'origine a changé entre la décision
 * et l'écriture ; la colonne miroir suit la fiche.
 *
 * Clé hors registre : suppression dans keyCharacteristics + historique.
 */
export async function retractAutomaticValue(p: RetractInput): Promise<ApplyOutcome> {
  if (isRegistryKey(p.fieldKey)) {
    const res = await writeCanonicalAssetField({
      assetId: p.assetId, accountId: p.accountId, key: p.fieldKey, value: null,
      origin: 'RECONCILIATION', expectedCurrent: p.currentValue,
      source: { type: 'reconciliation', id: p.traceId ?? null }, traceId: p.traceId ?? null,
      trace: { decisionType: 'update', reasonCode: RETRACTION_REASON, confidence: 'certain', authority: null, sourceDate: null },
    });
    return outcomeOf(p.fieldKey, res.notFound ? null : res.field);
  }

  // Mise à jour CIBLÉE et atomique (relecture lot 13) : seule la clé et ses
  // métadonnées changent, sous condition — valeur toujours celle décidée et
  // origine toujours automatique — évaluée par PostgreSQL au moment de
  // l'écriture (aucune fenêtre lecture → réécriture du JSON entier).
  const maintenant = new Date().toISOString();
  const rows = (await pgClient.unsafe(
    `UPDATE assets
        SET key_characteristics = ((COALESCE(NULLIF(key_characteristics, ''), '{}')::jsonb
              - $3::text - ($3::text || '__authority') - ($3::text || '__sourceDate') - ($3::text || '_origin'))
              || jsonb_build_object($3::text || '__origin', 'RECONCILIATION', $3::text || '__updatedAt', $5::text))::text,
            updated_at = now()
      WHERE id = $1 AND account_id = $2
        AND (COALESCE(NULLIF(key_characteristics, ''), '{}')::jsonb -> $3::text) = $4::jsonb
        AND (
          (COALESCE(NULLIF(key_characteristics, ''), '{}')::jsonb ->> ($3::text || '__origin')) IN ('DOCUMENT_EXTRACTION', 'RECONCILIATION')
          OR ((COALESCE(NULLIF(key_characteristics, ''), '{}')::jsonb ->> ($3::text || '__origin')) IS NULL
              AND (COALESCE(NULLIF(key_characteristics, ''), '{}')::jsonb ->> ($3::text || '_origin')) = 'auto'))
      RETURNING id`,
    [p.assetId, p.accountId, p.fieldKey, JSON.stringify(p.currentValue), maintenant] as never[],
  )) as unknown as unknown[];
  if (rows.length === 0) {
    // Rien retiré : dire pourquoi (lecture seule).
    const [asset] = await db
      .select({ keyCharacteristics: assets.keyCharacteristics })
      .from(assets)
      .where(and(eq(assets.id, p.assetId), eq(assets.accountId, p.accountId)))
      .limit(1);
    if (!asset) return 'skipped';
    const kc = parseKc(asset.keyCharacteristics);
    if (!isSameAsDecided(kc[p.fieldKey], p.currentValue)) return 'conflict';
    return 'protected';
  }
  await db.insert(aiFieldUpdates).values({
    accountId: p.accountId, assetId: p.assetId, fieldKey: p.fieldKey,
    oldValue: toText(p.currentValue), newValue: '',
    decisionType: 'update', reasonCode: RETRACTION_REASON, confidence: 'certain',
  } as never);
  return 'written';
}
