/**
 * Application d'une décision — CDC §5.4.3.
 *
 * Toute écriture automatique laisse trois traces indissociables :
 *   1. la nouvelle valeur, avec son origine structurée ;
 *   2. l'autorité et la date de la preuve, pour les arbitrages futurs ;
 *   3. une ligne d'historique rattachée à la preuve et au motif.
 *
 * Sans le point 2, la prochaine exécution comparerait une nouvelle preuve à une
 * valeur d'autorité inconnue et déciderait à l'aveugle.
 */
import { db } from '@/db';
import { assets, aiFieldUpdates } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { writeOrigin } from './field-origin';
import type { ReconciliationDecision, EvidenceCandidate } from './types';

export interface ApplyContext {
  accountId: number;
  assetId: number;
  sourceFileId: number | null;
  provider?: string;
  model?: string;
  promptVersion?: string;
  bestCandidate?: EvidenceCandidate;
}

export async function applyDecision(
  decision: ReconciliationDecision,
  ctx: ApplyContext,
): Promise<void> {
  if (decision.action !== 'apply' && decision.action !== 'update') return;

  const [asset] = await db
    .select({ keyCharacteristics: assets.keyCharacteristics })
    .from(assets)
    .where(and(eq(assets.id, ctx.assetId), eq(assets.accountId, ctx.accountId)))
    .limit(1);

  if (!asset) return;

  const kc = parseKc(asset.keyCharacteristics);

  // Relecture de sécurité : entre la décision et son application, l'utilisateur
  // a pu saisir une valeur. On ne recouvre jamais une écriture concurrente.
  const currentNow = kc[decision.fieldKey];
  if (!isSameAsDecided(currentNow, decision.currentValue)) {
    console.info(
      `[reconciliation] ${decision.fieldKey} modifié entre-temps — application annulée`,
    );
    return;
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
