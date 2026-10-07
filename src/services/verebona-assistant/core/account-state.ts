/**
 * État du compte pour les suggestions — CDC §8.2.
 *
 * Des requêtes bornées au compte (§13.2) qui ne rendent que des compteurs
 * et, depuis le lot 32 (point 8), le NOM d'un bien à citer dans un exemple
 * (« Quels sont les documents de Cupra ? ») : celui de la fiche ouverte, ou
 * un bien du compte hors fiche. Le nom n'est rendu qu'à l'utilisateur du
 * compte, dans un libellé du catalogue validé.
 */
import { pgClient } from '@/db';
import {
  isAssetNameSuggestable,
  type AccountSuggestionState, type SuggestionAsset, type SuggestionContext,
} from '../registries/capability-registry';
import { assistantAssetAvailableSql } from './asset-availability';

export async function loadAccountSuggestionState(accountId: number): Promise<AccountSuggestionState> {
  const rows = (await pgClient.unsafe(
    `SELECT
       (SELECT count(*)::int FROM to_process_actions WHERE account_id = $1 AND resolved_at IS NULL) AS "toProcessPending",
       (SELECT count(*)::int FROM agenda_items
         WHERE account_id = $1 AND start_date >= current_date AND start_date <= current_date + 30) AS "deadlinesSoon",
       (SELECT count(*)::int FROM asset_files
         WHERE account_id = $1 AND deleted_at IS NULL AND analysis_state IN ('UPLOADING', 'UPLOADED', 'ANALYZING')) AS "documentsInAnalysis",
       (SELECT count(*)::int FROM asset_files
         WHERE account_id = $1 AND deleted_at IS NULL AND analysis_state = 'ANALYSIS_FAILED') AS "documentsFailed",
       (SELECT count(*)::int FROM export_generation WHERE account_id = $1 AND status IN ('ready', 'partial')) AS "exportsReady",
       (SELECT count(*)::int FROM asset_files
         WHERE account_id = $1 AND deleted_at IS NULL AND asset_id IS NULL AND linked_asset_id IS NULL) AS "documentsUnlinked"`,
    [accountId] as never[],
  )) as unknown as AccountSuggestionState[];
  const r = rows[0];
  return {
    toProcessPending: Number(r?.toProcessPending ?? 0),
    deadlinesSoon: Number(r?.deadlinesSoon ?? 0),
    documentsInAnalysis: Number(r?.documentsInAnalysis ?? 0),
    documentsFailed: Number(r?.documentsFailed ?? 0),
    exportsReady: Number(r?.exportsReady ?? 0),
    documentsUnlinked: Number(r?.documentsUnlinked ?? 0),
  };
}

/** Plafond de biens lus pour choisir un nom (comptes ordinaires : quelques dizaines). */
const MAX_BIENS = 500;

interface BienLu { id: number; name: string | null; documents: number }

/**
 * Biens DISPONIBLES pour T2 (même règle que la résolution : ni supprimés, ni
 * archivés, ni transmis — `asset-availability`), du plus récemment modifié
 * au plus ancien, avec leur nombre de documents.
 */
async function biensDisponibles(accountId: number): Promise<BienLu[]> {
  const rows = (await pgClient.unsafe(
    `SELECT a.id, a.name,
            (SELECT count(*)::int FROM asset_files f
              WHERE f.account_id = a.account_id AND f.deleted_at IS NULL
                AND (f.asset_id = a.id OR f.linked_asset_id = a.id)) AS documents
       FROM assets a
      WHERE a.account_id = $1 AND ${assistantAssetAvailableSql('a')}
      ORDER BY a.updated_at DESC NULLS LAST, a.id DESC
      LIMIT ${MAX_BIENS}`,
    [accountId] as never[],
  )) as unknown as BienLu[];
  return rows.map((r) => ({ id: Number(r.id), name: r.name, documents: Number(r.documents ?? 0) }));
}

/** Identifiant du bien d'une fiche (`/assets/42`, `/assets/42/documents`). */
export function assetIdFromRoute(route: string | null | undefined): number | null {
  const m = /^\/assets\/(\d{1,10})(\/|$)/.exec((route ?? '').split(/[?#]/)[0]);
  const id = m ? Number(m[1]) : NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * Choix des biens nommés (pur, testé) : le bien de la fiche s'il est
 * disponible et nommable ; hors fiche, le bien nommable le plus récent,
 * de préférence avec des documents.
 */
export function pickSuggestionAssets(biens: BienLu[], pageAssetId: number | null): Pick<SuggestionContext, 'pageAsset' | 'accountAsset'> {
  const nommable = (b: BienLu) => isAssetNameSuggestable(b.name, biens.filter((o) => o.id !== b.id).map((o) => o.name));
  const vers = (b: BienLu | undefined): SuggestionAsset | null => (b ? { name: (b.name ?? '').replace(/\s+/g, ' ').trim(), documents: b.documents } : null);
  if (pageAssetId != null) {
    const b = biens.find((x) => x.id === pageAssetId);
    return { pageAsset: b && nommable(b) ? vers(b) : null, accountAsset: null };
  }
  const candidats = biens.filter(nommable);
  return { pageAsset: null, accountAsset: vers(candidats.find((b) => b.documents > 0) ?? candidats[0]) };
}

/** Contexte complet des suggestions d'une page (§8.2 + lot 32). */
export async function loadSuggestionContext(accountId: number, route: string | null | undefined): Promise<SuggestionContext> {
  const [state, biens] = await Promise.all([
    loadAccountSuggestionState(accountId).catch(() => null),
    biensDisponibles(accountId).catch(() => [] as BienLu[]),
  ]);
  return { state, ...pickSuggestionAssets(biens, assetIdFromRoute(route)) };
}
