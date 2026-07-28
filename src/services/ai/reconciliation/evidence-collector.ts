/**
 * Collecte des preuves par champ — opération `collect_evidence`, déterministe.
 *
 * Prépare l'entrée du moteur de décision : valeur actuelle avec son origine et
 * l'autorité de sa source, et preuves candidates normalisées.
 *
 * CDC §5.6 : le document n'est jamais renvoyé au modèle. Tout part des preuves
 * déjà produites par l'analyse (usage 1).
 */
import { db, pgClient } from '@/db';
import { assets } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { getActiveEvidence } from '../evidence/field-evidence.service';
import { resolveAuthority } from './decision/authority-matrix';
import { normalize } from './decision/normalizers';
import { readOrigin } from './field-origin';
import { isCriticalField } from './decision/critical-fields';
import type { DecisionInput, EvidenceCandidate, CurrentValue } from './types';

export interface CollectedField {
  fieldKey: string;
  input: DecisionInput;
}

/** Rassemble, pour chaque champ disposant d'au moins une preuve, l'entrée du moteur. */
export async function collectFields(
  accountId: number,
  assetId: number,
): Promise<CollectedField[]> {
  const [asset] = await db
    .select({ keyCharacteristics: assets.keyCharacteristics })
    .from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.accountId, accountId)))
    .limit(1);

  if (!asset) return [];

  const kc = parseKeyCharacteristics(asset.keyCharacteristics);
  const fieldKeys = await listFieldsWithEvidence(accountId, assetId);
  const collected: CollectedField[] = [];

  for (const fieldKey of fieldKeys) {
    const evidences = await getActiveEvidence(accountId, assetId, fieldKey);

    const candidates: EvidenceCandidate[] = evidences.map((e) => ({
      evidenceId: e.id,
      value: e.value,
      normalized: normalize(fieldKey, e.value),
      confidence: e.confidence,
      // L'autorité est recalculée à chaque exécution : une évolution de la
      // matrice doit se refléter immédiatement, sans réanalyser les documents.
      authorityScore: resolveAuthority({
        fieldKey,
        documentType: e.documentType ?? null,
        isWebLink: e.sourceType === 'web_link',
      }).score,
      documentType: e.documentType ?? null,
      documentDate: e.documentDate ?? null,
      sourceId: e.sourceId,
      excerpt: e.excerpt,
    }));

    collected.push({
      fieldKey,
      input: {
        fieldKey,
        current: buildCurrentValue(fieldKey, kc),
        candidates,
        isCritical: isCriticalField(fieldKey),
      },
    });
  }

  return collected;
}

function buildCurrentValue(
  fieldKey: string,
  kc: Record<string, unknown>,
): CurrentValue | null {
  const raw = kc[fieldKey];
  if (raw === undefined) return null;

  return {
    value: raw,
    normalized: normalize(fieldKey, raw),
    origin: readOrigin(kc, fieldKey),
    updatedAt: parseDate(kc[`${fieldKey}__updatedAt`]),
    // Autorité de la preuve ayant produit la valeur, mémorisée lors de
    // l'application précédente. Absente pour une saisie utilisateur.
    authorityScore: typeof kc[`${fieldKey}__authority`] === 'number'
      ? (kc[`${fieldKey}__authority`] as number)
      : undefined,
    sourceDate: parseDate(kc[`${fieldKey}__sourceDate`]),
  };
}

async function listFieldsWithEvidence(accountId: number, assetId: number): Promise<string[]> {
  const rows = await pgClient.unsafe(
    `SELECT DISTINCT field_key FROM field_evidence
      WHERE account_id = $1 AND asset_id = $2 AND status = 'active'`,
    [accountId, assetId] as never[],
  );
  return (rows as unknown as Array<{ field_key: string }>).map((r) => r.field_key);
}

function parseKeyCharacteristics(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  try {
    return JSON.parse(String(raw)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function parseDate(v: unknown): Date | null {
  if (!v) return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}
