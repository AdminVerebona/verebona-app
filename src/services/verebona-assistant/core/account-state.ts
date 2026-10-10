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
  SUGGESTIONS, isAssetNameSuggestable,
  type AccountSuggestionState, type SuggestionAsset, type SuggestionContext,
} from '../registries/capability-registry';
import { assistantAssetAvailableSql } from './asset-availability';
// Lot 34C : compteurs sur l'état EFFECTIF (job de file réel).
import { effectiveAnalysisStateSql } from '@/services/ai/processing-status/effective-state-sql';
import { agendaFunctionalColumnsReady } from '@/services/agenda/agenda-columns';
import { HISTORICAL_FIELD_KEYS, NOT_HISTORICAL, countUpcomingAgenda, listUpcomingAgenda } from '../canonical/agenda';
import { listActionables } from '../canonical/actionables';
import { actionableReadWindow, analyserDemandeActionnable, selectionnerActionnables } from './actionable-request';
import { aujourdhuiParis } from './query-period';

/**
 * Fenêtre des « échéances qui arrivent bientôt » : celle que T2 applique à
 * cette question (`upcomingAgendaRequest`, 30 jours par défaut).
 */
export const SUGGESTION_SOON_DAYS = 30;
/** Borne des listes lues pour un compteur (seule sa positivité compte). */
const BORNE = 50;

/**
 * Lot 34 : nombre d'éléments en retard ou dus aujourd'hui que le RÉSOLVEUR
 * des demandes d'actions rend pour le libellé exact de la suggestion
 * « Que dois-je faire aujourd'hui ? » — mêmes lectures canoniques, même
 * sélection. 0 si le résolveur ne reconnaît pas la question : la suggestion
 * n'est alors jamais proposée.
 */
export async function countActionsDueToday(accountId: number, today = aujourdhuiParis()): Promise<number> {
  const label = SUGGESTIONS.find((s) => s.id === 'home_today')?.label ?? '';
  const req = analyserDemandeActionnable(label, today);
  if (!req) return 0;
  const w = actionableReadWindow(req, today);
  const lu = await listActionables(accountId, {
    from: w.from, to: w.to, todos: req.allowedSourceTypes.includes('TODO'), deadlines: req.allowedSourceTypes.includes('DEADLINE'),
  });
  return selectionnerActionnables(req, lu, today)
    .filter((r) => r.reasonForInclusion === 'OVERDUE' || r.reasonForInclusion === 'DUE_TODAY').length;
}

export async function loadAccountSuggestionState(accountId: number): Promise<AccountSuggestionState> {
  const rows = (await pgClient.unsafe(
    `SELECT
       (SELECT count(*)::int FROM to_process_actions WHERE account_id = $1 AND resolved_at IS NULL) AS "toProcessPending",
       (SELECT count(*)::int FROM assets a WHERE a.account_id = $1 AND ${assistantAssetAvailableSql('a')}) AS "assetsTotal",
       (SELECT count(*)::int FROM asset_files WHERE account_id = $1 AND deleted_at IS NULL) AS "documentsTotal",
       (SELECT count(*)::int FROM asset_files
         WHERE account_id = $1 AND deleted_at IS NULL AND ${effectiveAnalysisStateSql('asset_files')} IN ('UPLOADING', 'UPLOADED', 'ANALYZING')) AS "documentsInAnalysis",
       (SELECT count(*)::int FROM asset_files
         WHERE account_id = $1 AND deleted_at IS NULL AND ${effectiveAnalysisStateSql('asset_files')} = 'ANALYSIS_FAILED') AS "documentsFailed",
       (SELECT count(*)::int FROM export_generation WHERE account_id = $1 AND status IN ('ready', 'partial')) AS "exportsReady",
       (SELECT count(*)::int FROM asset_files
         WHERE account_id = $1 AND deleted_at IS NULL AND asset_id IS NULL AND linked_asset_id IS NULL) AS "documentsUnlinked"`,
    [accountId] as never[],
  )) as unknown as Array<AccountSuggestionState & { assetsTotal: number; documentsTotal: number }>;
  const r = rows[0];
  // Lot 34 : échéances lues par les MÊMES fonctions que les réponses de T2
  // (ouvertes, non HISTORICAL) — jamais un compte brut d'`agenda_items`.
  const [soon, upcoming, dueToday] = await Promise.all([
    listUpcomingAgenda(accountId, { windowDays: SUGGESTION_SOON_DAYS, limit: BORNE }).then((l) => l.length),
    countUpcomingAgenda(accountId),
    countActionsDueToday(accountId),
  ]);
  return {
    toProcessPending: Number(r?.toProcessPending ?? 0),
    deadlinesSoon: soon,
    deadlinesUpcoming: upcoming,
    actionsDueToday: dueToday,
    assetsTotal: Number(r?.assetsTotal ?? 0),
    documentsTotal: Number(r?.documentsTotal ?? 0),
    documentsInAnalysis: Number(r?.documentsInAnalysis ?? 0),
    documentsFailed: Number(r?.documentsFailed ?? 0),
    exportsReady: Number(r?.exportsReady ?? 0),
    documentsUnlinked: Number(r?.documentsUnlinked ?? 0),
  };
}

/** Plafond de biens lus pour choisir un nom (comptes ordinaires : quelques dizaines). */
const MAX_BIENS = 500;

interface BienLu { id: number; name: string | null; documents: number; deadlines?: number }

/**
 * Biens DISPONIBLES pour T2 (même règle que la résolution : ni supprimés, ni
 * archivés, ni transmis — `asset-availability`), du plus récemment modifié
 * au plus ancien, avec leur nombre de documents.
 */
async function biensDisponibles(accountId: number): Promise<BienLu[]> {
  const col = await agendaFunctionalColumnsReady().catch(() => false);
  // Échéances d'un bien : règle de `listUpcomingAgenda` (ouvertes, non
  // HISTORICAL, à venir dans la fenêtre que T2 applique à « Quelles sont
  // les prochaines échéances de X ? »).
  const rows = (await pgClient.unsafe(
    `SELECT a.id, a.name,
            (SELECT count(*)::int FROM asset_files f
              WHERE f.account_id = a.account_id AND f.deleted_at IS NULL
                AND (f.asset_id = a.id OR f.linked_asset_id = a.id)) AS documents,
            (SELECT count(*)::int FROM agenda_items i
              WHERE i.account_id = a.account_id AND (i.manual_status IS NULL OR i.manual_status = '')
                AND i.start_date >= $2::date AND i.start_date <= $2::date + $3::int
                AND EXISTS (SELECT 1 FROM agenda_asset_links x WHERE x.agenda_item_id = i.id AND x.asset_id = a.id)
                AND ${NOT_HISTORICAL(col, '$4')}) AS deadlines
       FROM assets a
      WHERE a.account_id = $1 AND ${assistantAssetAvailableSql('a')}
      ORDER BY a.updated_at DESC NULLS LAST, a.id DESC
      LIMIT ${MAX_BIENS}`,
    [accountId, aujourdhuiParis(), SUGGESTION_SOON_DAYS, [...HISTORICAL_FIELD_KEYS]] as never[],
  )) as unknown as BienLu[];
  return rows.map((r) => ({ id: Number(r.id), name: r.name, documents: Number(r.documents ?? 0), deadlines: Number(r.deadlines ?? 0) }));
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
  const vers = (b: BienLu | undefined): SuggestionAsset | null => (b
    ? { id: b.id, name: (b.name ?? '').replace(/\s+/g, ' ').trim(), documents: b.documents, ...(b.deadlines != null ? { deadlines: b.deadlines } : {}) }
    : null);
  if (pageAssetId != null) {
    const b = biens.find((x) => x.id === pageAssetId);
    return { pageAsset: b && nommable(b) ? vers(b) : null, accountAsset: null };
  }
  const candidats = biens.filter(nommable);
  return { pageAsset: null, accountAsset: vers(candidats.find((b) => b.documents > 0) ?? candidats.find((b) => (b.deadlines ?? 0) > 0) ?? candidats[0]) };
}

/** Contexte complet des suggestions d'une page (§8.2 + lot 32). */
export async function loadSuggestionContext(accountId: number, route: string | null | undefined): Promise<SuggestionContext> {
  const [state, biens] = await Promise.all([
    loadAccountSuggestionState(accountId).catch(() => null),
    biensDisponibles(accountId).catch(() => [] as BienLu[]),
  ]);
  return { state, ...pickSuggestionAssets(biens, assetIdFromRoute(route)) };
}
