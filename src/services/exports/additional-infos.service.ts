/**
 * Informations complémentaires de la fiche bien — persistance
 * (CDC Exports V12 §4.3, DEC-007, IC-GEN-003/009/010, EXP-002).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * FUSION ATOMIQUE, CHAMP PAR CHAMP
 *
 * Contrat §4.3 : PATCH = « merge patch », conflit = dernier écrit gagne PAR
 * CHAMP. Deux onglets (ou le titulaire et son co-titulaire Duo) qui
 * enregistrent chacun un champ différent ne doivent pas s'écraser : la fusion
 * est donc faite PAR POSTGRES, dans un seul `INSERT … ON CONFLICT DO UPDATE`
 * (`colonne || valeurs - clés_retirées`), et non en « lire, fusionner en JS,
 * réécrire » qui perdrait l'écriture concurrente.
 *
 * Portée compte : toutes les lectures et écritures filtrent sur le bien ET le
 * compte. L'appelant a déjà vérifié l'accès (route) ; ce filtre est une
 * seconde barrière, pas la seule.
 *
 * Le moteur de dossiers lit `getAssetAdditionalInfos` pour son snapshot
 * (IC-GEN-010) : les valeurs figées sont celles lues au moment de la
 * génération, jamais une valeur temporaire de préparation (IC-GEN-009).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { db } from '@/db';
import { assetAdditionalInfos } from '@/db/schema';
import {
  ADDITIONAL_INFO_SECTIONS,
  sanitizeSection,
  type AdditionalInfoSectionData,
  type AdditionalInfoSectionKey,
  type NormalizedPatch,
} from '@/lib/assets/additional-infos';

export interface AssetAdditionalInfos {
  assetId: number;
  commercial: AdditionalInfoSectionData;
  rental: AdditionalInfoSectionData;
  insurance: AdditionalInfoSectionData;
  claim: AdditionalInfoSectionData;
  /** ISO ; `null` tant que rien n'a été enregistré. */
  updatedAt: string | null;
  /** Utilisateur auteur de la dernière modification ; `null` si aucun / supprimé. */
  updatedBy: number | null;
  /** Compteur de versions (§26 « additionalInfo + version ») ; 0 si aucune ligne. */
  version: number;
}

type Row = typeof assetAdditionalInfos.$inferSelect;

function toDto(assetId: number, row: Row | undefined): AssetAdditionalInfos {
  if (!row) {
    return { assetId, commercial: {}, rental: {}, insurance: {}, claim: {}, updatedAt: null, updatedBy: null, version: 0 };
  }
  return {
    assetId,
    commercial: sanitizeSection('commercial', row.commercial),
    rental: sanitizeSection('rental', row.rental),
    insurance: sanitizeSection('insurance', row.insurance),
    claim: sanitizeSection('claim', row.claim),
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : (row.updatedAt ? String(row.updatedAt) : null),
    updatedBy: row.updatedBy ?? null,
    version: row.version ?? 1,
  };
}

/**
 * Informations complémentaires d'un bien du compte. Sous-rubriques vides
 * (`{}`) si rien n'a été saisi — jamais `null`.
 */
export async function getAssetAdditionalInfos(assetId: number, accountId: number): Promise<AssetAdditionalInfos> {
  const [row] = await db
    .select()
    .from(assetAdditionalInfos)
    .where(and(eq(assetAdditionalInfos.assetId, assetId), eq(assetAdditionalInfos.accountId, accountId)))
    .limit(1);
  return toDto(assetId, row);
}

const COLUMN_BY_SECTION = {
  commercial: assetAdditionalInfos.commercial,
  rental: assetAdditionalInfos.rental,
  insurance: assetAdditionalInfos.insurance,
  claim: assetAdditionalInfos.claim,
} as const;

/** `colonne || '{...}'::jsonb - ARRAY[...]::text[]` — fusion côté base. */
export function mergeExpression(section: AdditionalInfoSectionKey, patch: NormalizedPatch): SQL | null {
  const set = patch.set[section];
  const unset = patch.unset[section];
  const hasSet = !!set && Object.keys(set).length > 0;
  const hasUnset = !!unset && unset.length > 0;
  if (!hasSet && !hasUnset) return null;
  let expr: SQL = sql`coalesce(${COLUMN_BY_SECTION[section]}, '{}'::jsonb)`;
  if (hasSet) expr = sql`(${expr} || ${JSON.stringify(set)}::jsonb)`;
  if (hasUnset) {
    const keys = sql.join(unset!.map((k) => sql`${k}`), sql`, `);
    expr = sql`(${expr} - ARRAY[${keys}]::text[])`;
  }
  return expr;
}

/**
 * Applique un correctif DÉJÀ VALIDÉ (`validateAdditionalInfosPatch`) et rend
 * l'état complet après écriture. `accountId` est le compte du bien (vérifié
 * par l'appelant) ; `userId` l'auteur (titulaire ou co-titulaire Duo).
 */
export async function updateAssetAdditionalInfos(
  assetId: number,
  accountId: number,
  userId: number,
  patch: NormalizedPatch,
): Promise<AssetAdditionalInfos> {
  const now = new Date();
  // Valeurs d'une première insertion : uniquement les champs posés.
  const initial = Object.fromEntries(
    ADDITIONAL_INFO_SECTIONS.map((s) => [s, { ...(patch.set[s] ?? {}) }]),
  ) as Record<AdditionalInfoSectionKey, AdditionalInfoSectionData>;

  const updates: Record<string, SQL | Date | number> = {};
  for (const s of ADDITIONAL_INFO_SECTIONS) {
    const expr = mergeExpression(s, patch);
    if (expr) updates[s] = expr;
  }

  const [row] = await db
    .insert(assetAdditionalInfos)
    .values({
      assetId,
      accountId,
      commercial: initial.commercial,
      rental: initial.rental,
      insurance: initial.insurance,
      claim: initial.claim,
      version: 1,
      createdAt: now,
      updatedAt: now,
      updatedBy: userId,
    })
    .onConflictDoUpdate({
      target: assetAdditionalInfos.assetId,
      set: {
        ...updates,
        accountId,
        version: sql`${assetAdditionalInfos.version} + 1`,
        updatedAt: now,
        updatedBy: userId,
      },
    })
    .returning();

  return toDto(assetId, row);
}
