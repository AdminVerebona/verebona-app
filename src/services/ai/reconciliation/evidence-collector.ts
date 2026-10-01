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
import { getActiveEvidence, evidenceReadFilter } from '../evidence/field-evidence.service';
import { resolveAuthority } from './decision/authority-matrix';
import { normalize } from './decision/normalizers';
import { readOrigin } from './field-origin';
import { isCriticalField } from './decision/critical-fields';
import { EVIDENCE_BASED_ORIGINS } from './negative-reconciliation';
import type { DecisionInput, EvidenceCandidate, CurrentValue } from './types';
import type { FieldEvidence } from '../evidence/evidence.types';

export interface CollectedField {
  fieldKey: string;
  input: DecisionInput;
  /**
   * Valeur en place AUTOMATIQUE qu'aucune preuve active ne soutient plus
   * (sa preuve a été retirée ou remplacée) — CDC 15 T3-04 : l'autorité
   * mémorisée de la preuve disparue ne doit plus la protéger.
   */
  unproven: boolean;
}

/** Rassemble, pour chaque champ disposant d'au moins une preuve, l'entrée du moteur. */
export async function collectFields(
  accountId: number,
  assetId: number,
): Promise<CollectedField[]> {
  return (await collectAssetEvidenceState(accountId, assetId)).fields;
}

/**
 * Fiche du bien et champs à décider. `kc` sert la phase négative (T3-04) :
 * les valeurs automatiques SANS aucune preuve active n'apparaissent pas dans
 * `fields`. Preuves retenues : ACTIVE, du bien lui-même (cible nulle ou ce
 * bien — T1-04) ; un fait ciblé ailleurs ne produit rien ici.
 */
export async function collectAssetEvidenceState(
  accountId: number,
  assetId: number,
): Promise<{ kc: Record<string, unknown> | null; fields: CollectedField[] }> {
  const [asset] = await db
    .select({ keyCharacteristics: assets.keyCharacteristics })
    .from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.accountId, accountId)))
    .limit(1);

  if (!asset) return { kc: null, fields: [] };

  const kc = parseKeyCharacteristics(asset.keyCharacteristics);
  const fieldKeys = await listFieldsWithEvidence(accountId, assetId);
  const collected: CollectedField[] = [];

  for (const fieldKey of fieldKeys) {
    const evidences = await getActiveEvidence(accountId, assetId, fieldKey);

    const candidates = toEvidenceCandidates(fieldKey, evidences);

    const current = buildCurrentValue(fieldKey, kc);
    collected.push({
      fieldKey,
      input: {
        fieldKey,
        current,
        candidates,
        isCritical: isCriticalField(fieldKey),
      },
      unproven: isUnprovenAutomaticValue(current, candidates),
    });
  }

  return { kc, fields: collected };
}

/**
 * Preuves actives → candidats normalisés du moteur (bien, équipement ou
 * pièce : même règle, lot 18).
 */
export function toEvidenceCandidates(fieldKey: string, evidences: FieldEvidence[]): EvidenceCandidate[] {
  return evidences.map((e) => ({
    evidenceId: e.id,
    value: e.value,
    normalized: normalize(fieldKey, e.value),
    // ══════════════════════════════════════════════════════════════════
    // UNE OBSERVATION VISUELLE NE S'APPLIQUE JAMAIS SEULE
    //
    // Elle suit les mêmes règles d'arbitrage que les autres preuves, mais
    // plafonnée à « probable » : ce que le modèle croit voir sur une photo
    // est proposé ou arbitré, pas écrit d'office dans la fiche. Elle ne
    // franchit pas non plus la barrière des champs critiques, qui exige un
    // extrait littéral.
    // ══════════════════════════════════════════════════════════════════
    confidence: e.evidenceOrigin === 'VISUAL_ANALYSIS' && e.confidence === 'certain' ? 'probable' : e.confidence,
    evidenceOrigin: e.evidenceOrigin ?? 'TEXT_EXTRACTION',
    visualDescription: e.evidenceOrigin === 'VISUAL_ANALYSIS'
      ? String((e.visualEvidence as { description?: unknown } | null)?.description ?? '') || null
      : null,
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
    excerpt: e.excerpt ?? '',
  }));
}

/**
 * Valeur automatique (extraction ou réconciliation) renseignée qu'aucune
 * preuve candidate (normalisée) ne reproduit : elle ne tient plus que par
 * l'autorité mémorisée d'une preuve retirée ou remplacée (T3-04).
 */
export function isUnprovenAutomaticValue(current: CurrentValue | null, candidates: EvidenceCandidate[]): boolean {
  if (!current || current.normalized === null || current.normalized === '') return false;
  // Seules les origines fondées sur une preuve documentaire (comme
  // `planRetractions`) : USER/ADMIN, IMPORT et SYSTEM_RULE ne perdent jamais
  // leur autorité (relecture lot 13).
  if (!EVIDENCE_BASED_ORIGINS.includes(current.origin)) return false;
  const utilisables = candidates.filter((c) => c.normalized !== null && c.normalized !== '');
  if (utilisables.length === 0) return false;
  return !utilisables.some((c) => c.normalized === current.normalized);
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
  // CDC 15 §14.4, T1-04 : preuves ACTIVE du bien lui-même (même filtre que
  // `getActiveEvidence`) — ni les preuves remplacées, ni celles d'un
  // équipement ou d'une pièce portés par le bien.
  const filtre = await evidenceReadFilter({ assetLevel: true });
  const rows = await pgClient.unsafe(
    `SELECT DISTINCT field_key FROM field_evidence
      WHERE account_id = $1 AND asset_id = $2 AND status = 'active'${filtre}`,
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
