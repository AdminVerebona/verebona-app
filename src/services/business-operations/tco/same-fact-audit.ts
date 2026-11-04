/**
 * Lot 108A — audit PUR des rapprochements d'identité d'un TCO calculé
 * (contrôle COH-TCO-SAME-FACT, diagnostic BO) : faits réunis, rapprochements
 * incertains encore sans décision de l'utilisateur, achat du bien compté deux
 * fois. Ne recalcule rien : lit les lignes produites par `computeTco`.
 */
import type { TcoEconomicLine } from './model';

/** Motifs d'une source reconnue comme le MÊME achat qu'une ligne comptée. */
const MEME_FAIT: ReadonlySet<string> = new Set([
  'SAME_FACT_CROSS_SOURCE', 'SAME_AS_ASSET_PRICE', 'ASSET_PRICE_CONSOLIDATED', 'SAME_AS_EQUIPMENT_DOCUMENT', 'EQUIPMENT_PRICE_CONSOLIDATED',
]);
const RETENUE = (s: string) => s === 'RETAINED_DIRECT' || s === 'RETAINED_CONSOLIDATED';

export interface SameFactAudit {
  merged: Array<{ lineId: string; reason: string; against: string | null; signals: string[] }>;
  uncertain: Array<{ lineId: string; fileId: number | null; operationId: number | null; against: string | null; signals: string[] }>;
  countedTwice: Array<{ eurCents: number; lineIds: string[] }>;
}

export function inspectSameFacts(lines: readonly TcoEconomicLine[]): SameFactAudit {
  const merged = lines.filter((l) => l.reason && MEME_FAIT.has(l.reason)).map((l) => ({
    lineId: l.id, reason: l.reason as string, against: l.duplicateOf ?? l.identity?.against ?? (l.operationId != null ? `op:${l.operationId}` : null), signals: l.identity?.signals ?? [],
  }));
  const uncertain = lines.filter((l) => RETENUE(l.status) && l.uncertain && l.identity?.verdict === 'UNCERTAIN' && !l.userDecision?.applied).map((l) => ({
    lineId: l.id, fileId: l.fileId, operationId: l.operationId, against: l.identity?.against ?? null, signals: l.identity?.signals ?? [],
  }));
  const parMontant = new Map<number, string[]>();
  for (const l of lines) {
    if (!RETENUE(l.status) || l.category !== 'ACQUISITION' || l.includedCents <= 0 || l.eurCents == null || l.userDecision?.applied || l.uncertain) continue;
    parMontant.set(l.eurCents, [...(parMontant.get(l.eurCents) ?? []), l.id]);
  }
  const countedTwice = [...parMontant].filter(([, ids]) => ids.length > 1).map(([eurCents, lineIds]) => ({ eurCents, lineIds }));
  return { merged, uncertain, countedTwice };
}
