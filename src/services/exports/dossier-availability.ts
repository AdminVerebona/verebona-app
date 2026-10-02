/**
 * Disponibilité des dossiers prêts à l'emploi — BO « Modèles d'export ».
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ACTIVER / DÉSACTIVER UN MODÈLE
 *
 * Les modèles sont les six dossiers V12 du code (catalog.ts). Un dossier
 * désactivé depuis le back-office :
 *   - disparaît du catalogue des biens (export-catalog.service) ;
 *   - est refusé à la mise en file (enqueue, 409 `DOSSIER_UNAVAILABLE`) ;
 *   - reste prévisualisable par l'administrateur (contrôle avant réactivation).
 * Les exports déjà produits ne sont pas touchés.
 *
 * Table `export_dossier_availability` (0240) : une ligne par dossier dont
 * l'état a été changé ; sans ligne, actif. Lecture mise en cache 30 s par
 * instance (vidée localement à chaque changement) : les autres instances
 * suivent au plus tard 30 s après.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';
import { DOSSIER_CODES, isDossierCode, type DossierCode } from './catalog';

const CACHE_MS = 30_000;
let cache: { at: number; inactive: ReadonlySet<DossierCode> } | null = null;

export interface DossierAvailabilityRow {
  code: DossierCode;
  isActive: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** Dossiers désactivés. En cas d'erreur de lecture : aucun (le service continue). */
export async function loadInactiveDossiers(now = Date.now()): Promise<ReadonlySet<DossierCode>> {
  if (cache && now - cache.at < CACHE_MS) return cache.inactive;
  try {
    const rows = await pgClient.unsafe<{ code: string }[]>(
      `SELECT code FROM export_dossier_availability WHERE is_active = false`,
    );
    const inactive = new Set(rows.map((r) => r.code).filter(isDossierCode));
    cache = { at: now, inactive };
    return inactive;
  } catch (error) {
    // Table absente (migration pas encore jouée) ou base indisponible : on ne
    // bloque pas la génération pour autant.
    console.error('[exports] disponibilité des dossiers illisible :', (error as Error).message);
    return new Set();
  }
}

/** État de chaque dossier, dans l'ordre du catalogue (back-office). */
export async function listDossierAvailability(): Promise<DossierAvailabilityRow[]> {
  const rows = await pgClient.unsafe<{ code: string; is_active: boolean; updated_at: Date | string | null; email: string | null }[]>(
    `SELECT d.code, d.is_active, d.updated_at, u.email
       FROM export_dossier_availability d
       LEFT JOIN users u ON u.id = d.updated_by`,
  );
  const byCode = new Map(rows.map((r) => [r.code, r]));
  return DOSSIER_CODES.map((code) => {
    const r = byCode.get(code);
    return {
      code,
      isActive: r ? Boolean(r.is_active) : true,
      updatedAt: r?.updated_at ? new Date(r.updated_at).toISOString() : null,
      updatedBy: r?.email ?? null,
    };
  });
}

/** Change l'état d'un dossier ; rend l'état précédent. */
export async function setDossierAvailability(code: DossierCode, isActive: boolean, adminId: number): Promise<{ before: boolean }> {
  const [prev] = await pgClient.unsafe<{ is_active: boolean }[]>(
    `SELECT is_active FROM export_dossier_availability WHERE code = $1`, [code],
  );
  await pgClient.unsafe(
    `INSERT INTO export_dossier_availability (code, is_active, updated_by, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (code) DO UPDATE SET is_active = EXCLUDED.is_active, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [code, isActive, adminId],
  );
  cache = null;
  return { before: prev ? Boolean(prev.is_active) : true };
}

/** Message affiché quand un dossier désactivé est demandé. */
export const DOSSIER_UNAVAILABLE_MESSAGE = 'Ce dossier n’est temporairement pas disponible. Réessayez plus tard.';

/** Tests : vide le cache. */
export function resetDossierAvailabilityCache(): void {
  cache = null;
}
