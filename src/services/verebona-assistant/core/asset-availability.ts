/**
 * Disponibilité d'un bien pour l'assistant T2 — RÈGLE UNIQUE (ticket 14, lot 29).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI CE MODULE
 *
 * La condition « bien utilisable comme cible » était recopiée dans plusieurs
 * requêtes (`listAssets`, validation des clarifications, références du fil,
 * commandes, complétude) — et oubliée ailleurs (`findAssets`, biens nommés
 * de `assistant-targets`, adaptateur de recherche des biens). T2 avait donc
 * deux visions du même compte : un bien ARCHIVÉ pouvait créer une ambiguïté
 * avec le bien actif de même nom, puis être refusé plus loin.
 *
 * Contrat fonctionnel (défaut de toute résolution standard de T2) :
 *
 *   account_id = compte courant          (toujours dans la requête appelante)
 *   deleted_at IS NULL                   → sinon : SUPPRIMÉ
 *   status NOT IN ('ARCHIVED','TRANSMIS') → sinon : ARCHIVÉ / TRANSMIS
 *
 * Les trois cas restent DISTINCTS (aucune donnée n'est modifiée) ; pour la
 * résolution T2 standard, ils ont la même conséquence : non candidat.
 * Les autres statuts (EN_SERVICE, EN_MAINTENANCE, EN_PANNE, EN_REPARATION,
 * HORS_SERVICE, VENDU, DÉTRUIT, INACTIF) restent accessibles : ce module ne
 * les exclut pas (AC14).
 *
 * Archives : aucune recherche automatique (§J). Un parcours explicite (« ma
 * voiture vendue l'an dernier ») devra passer par `includeArchived: true`,
 * jamais par un repli silencieux quand la cible active est introuvable.
 *
 * Utilisé par : `findAssets`, `listAssets` (account-data.repository),
 * catalogue des cibles (`target-lookup.repository` → `resolveAssistantTargets`),
 * revalidation des candidats de clarification (`clarification.service`),
 * références du fil (`ports.describeEntity`), lookup des commandes
 * (`commands/plan.service`), complétude (`canonical/completeness`),
 * adaptateurs de recherche (biens, équipements, pièces), planificateur de
 * synthèse. Un test de cohérence interdit toute autre copie de la règle.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { sql, type SQL, type AnyColumn } from 'drizzle-orm';

/** Statuts exclus de la résolution standard de T2. */
export const ASSISTANT_EXCLUDED_ASSET_STATUSES = ['ARCHIVED', 'TRANSMIS'] as const;
/** Statut d'un bien sans statut renseigné (valeur par défaut de la colonne). */
export const DEFAULT_ASSET_STATUS = 'EN_SERVICE';

export interface AvailabilityOptions {
  /**
   * Recherche EXPLICITE dans les archives (intention dédiée). Jamais
   * positionné par un repli automatique.
   */
  includeArchived?: boolean;
}

const LISTE_SQL = ASSISTANT_EXCLUDED_ASSET_STATUSES.map((s) => `'${s}'`).join(', ');

/** Condition SQL sur le STATUT seul (`coalesce(a.status, 'EN_SERVICE') NOT IN (…)`). */
export function assistantAssetStatusSql(alias = 'a', opts: AvailabilityOptions = {}): string {
  if (opts.includeArchived) return 'TRUE';
  const col = alias ? `${alias}.status` : 'status';
  return `coalesce(${col}, '${DEFAULT_ASSET_STATUS}') NOT IN (${LISTE_SQL})`;
}

/**
 * Condition SQL COMPLÈTE de disponibilité (hors compte, toujours posé par la
 * requête appelante) : non supprimé ET ni archivé ni transmis.
 */
export function assistantAssetAvailableSql(alias = 'a', opts: AvailabilityOptions = {}): string {
  const del = alias ? `${alias}.deleted_at` : 'deleted_at';
  return `${del} IS NULL AND ${assistantAssetStatusSql(alias, opts)}`;
}

/** Même règle pour une requête Drizzle (adaptateurs de recherche). */
export function assistantAssetStatusCondition(statusColumn: AnyColumn): SQL {
  return sql`coalesce(${statusColumn}, ${DEFAULT_ASSET_STATUS}) NOT IN ('ARCHIVED', 'TRANSMIS')`;
}

/** Même règle en mémoire (pure, testée). */
export function isAssetAvailableForAssistant(
  a: { status?: string | null; deletedAt?: unknown; deleted_at?: unknown },
  opts: AvailabilityOptions = {},
): boolean {
  const supprime = (a.deletedAt ?? a.deleted_at) != null;
  if (supprime) return false;
  if (opts.includeArchived) return true;
  const statut = (a.status ?? DEFAULT_ASSET_STATUS).toUpperCase();
  return !(ASSISTANT_EXCLUDED_ASSET_STATUSES as readonly string[]).includes(statut);
}

/** Point d'entrée unique (lisibilité des appelants : `assistantAssetAvailability.sql('a')`). */
export const assistantAssetAvailability = {
  excludedStatuses: ASSISTANT_EXCLUDED_ASSET_STATUSES,
  sql: assistantAssetAvailableSql,
  statusSql: assistantAssetStatusSql,
  drizzle: assistantAssetStatusCondition,
  isAvailable: isAssetAvailableForAssistant,
} as const;

/** Phrase utilisateur : cible (page, fil, clarification) devenue indisponible (§D, §E). */
export const ASSET_NO_LONGER_AVAILABLE_MESSAGE = 'Ce bien n’est plus disponible dans vos biens actifs (archivé, transmis ou supprimé).';
