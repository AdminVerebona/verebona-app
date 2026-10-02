/**
 * Disponibilité des sources à l'affichage — CDC §19.10.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * `isAvailable` VALAIT TOUJOURS `true`
 *
 * Une source citée par l'assistant pouvait avoir été supprimée entre sa
 * récupération et l'affichage de la réponse. L'interface proposait alors de
 * l'ouvrir, et le clic menait à une erreur.
 *
 * Pire dans le cas d'un historique : les conversations sont conservées
 * 90 jours. Rouvrir une conversation ancienne affichait des liens vers des
 * documents effacés depuis, sans rien pour le signaler.
 *
 * ── CE N'EST PAS QU'UNE QUESTION DE CONFORT ───────────────────────────────
 *
 * La vérification porte AUSSI sur l'appartenance au compte. Une source
 * récupérée pour un compte partagé (Duo) peut cesser d'être accessible à
 * l'utilisateur qui relit la conversation — le §19.10 associe explicitement
 * « suppression » et « permission ».
 *
 * ── LA TABLE SE CHOISIT PAR LE PRÉFIXE, PAS PAR LE TYPE DE SOURCE ─────────
 *
 * (Audit lot 4, §3.) La table était choisie par `SourceType`. Or les
 * équipements et les pièces sont émis en `asset_field` avec l'identifiant
 * « equipment_12 » / « room_7 » : le 12 était vérifié dans `assets`. Un
 * équipement valide perdait son lien si le bien n° 12 n'existait pas, et un
 * équipement supprimé gardait un lien mort si le bien n° 12 existait. Les
 * fournisseurs n'étaient jamais revérifiés, et l'agenda, interrogé sur une
 * colonne `deleted_at` qu'il n'a pas, échouait en silence (tout « vivant »).
 *
 * Désormais : décodage du préfixe par `parseEntityRef`, une requête par
 * famille d'entité, écrite pour la table réelle (jointure au bien parent
 * pour les équipements et les pièces, qui n'ont pas de `account_id` fiable).
 *
 * ── UNE SEULE REQUÊTE PAR FAMILLE ─────────────────────────────────────────
 *
 * Vérifier source par source produirait autant de requêtes que de citations,
 * sur un chemin déjà contraint par le délai de réponse. Les identifiants sont
 * donc regroupés par famille, et chaque famille interrogée une fois.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';
import type { ResolvedSource } from '../types/sources';
import type { ResultGroup } from './result-groups';
import { parseEntityRef, type EntityKind } from './entity-ref';
import { canonicalReadEnabled } from '../canonical/mode';

/**
 * Requête de vérification par famille d'entité. `$1` : identifiants
 * numériques, `$2` : compte. Rend les identifiants ENCORE accessibles.
 *
 * `to_process` n'est pas vérifié ici (mode historique) : voir
 * `REQUETE_TO_PROCESS`, appliquée en lecture canonique (CDC 15 T2-45).
 */
export const REQUETES_DISPONIBILITE: Readonly<Partial<Record<EntityKind, string>>> = {
  asset: `SELECT id FROM assets WHERE id = ANY($1::int[]) AND account_id = $2 AND deleted_at IS NULL`,
  document: `SELECT id FROM asset_files WHERE id = ANY($1::int[]) AND account_id = $2 AND deleted_at IS NULL`,
  // `agenda_items` n'a pas de suppression logique : la ligne existe ou non.
  agenda_item: `SELECT id FROM agenda_items WHERE id = ANY($1::int[]) AND account_id = $2`,
  // Équipements et pièces : le périmètre passe par le bien parent, qui doit
  // lui-même être au compte et non supprimé.
  equipment: `SELECT e.id FROM equipments e JOIN assets a ON a.id = e.asset_id
               WHERE e.id = ANY($1::int[]) AND a.account_id = $2 AND a.deleted_at IS NULL`,
  // Pièce = sous-structure (D-G, lot 20).
  room: `SELECT r.id FROM substructures r JOIN assets a ON a.id = r.asset_id
          WHERE r.id = ANY($1::int[]) AND a.account_id = $2 AND a.deleted_at IS NULL`,
  // Mêmes règles que la fiche fournisseur (`supplierInAccount`).
  supplier: `SELECT id FROM suppliers WHERE id = ANY($1::int[]) AND account_id = $2 AND status <> 'deleted'`,
  // Export ou dossier généré (§12.1) : supprimé ou annulé = indisponible.
  export: `SELECT id FROM export_generation WHERE id = ANY($1::int[]) AND account_id = $2
            AND status NOT IN ('deleted', 'cancelled')`,
};

/**
 * CDC 15 T2-45 (lot 15, ASSISTANT_CANONICAL_READ=enabled) : un élément
 * « À traiter » est revérifié sur SA clé (`to_process_actions.id`, bornée au
 * compte) et selon la même règle que la page « À traiter »
 * (`to-process-query.service`, `resolved_at IS NULL`) : un élément résolu
 * n'y figure plus — le lien « Ouvrir À traiter » n'y mènerait à rien.
 */
export const REQUETE_TO_PROCESS =
  `SELECT id FROM to_process_actions WHERE id = ANY($1::int[]) AND account_id = $2 AND resolved_at IS NULL`;

/** Requêtes de vérification selon le mode de lecture. */
export function requetesDisponibilite(canonique: boolean = canonicalReadEnabled()): Readonly<Partial<Record<EntityKind, string>>> {
  return canonique ? { ...REQUETES_DISPONIBILITE, to_process: REQUETE_TO_PROCESS } : REQUETES_DISPONIBILITE;
}

/** Exécuteur de requête — injectable pour les tests. */
export type Requeteur = (sql: string, params: unknown[]) => Promise<Array<{ id: number }>>;

const requeteurPg: Requeteur = async (sql, params) =>
  (await pgClient.unsafe(sql, params as never[])) as unknown as Array<{ id: number }>;

/**
 * Identifiants préfixés (« doc_12 », « equipment_4 »…) devenus
 * INDISPONIBLES pour ce compte. Un identifiant non décodable (article
 * d'aide, règle d'offre) ou d'une famille non vérifiée n'y figure jamais.
 *
 * Ne lève jamais : une famille dont la vérification échoue est considérée
 * disponible — mieux vaut un lien mort qu'aucune réponse.
 */
export async function identifiantsIndisponibles(
  ids: string[],
  accountId: number,
  requeteur: Requeteur = requeteurPg,
): Promise<Set<string>> {
  const requetes = requetesDisponibilite();
  const parFamille = new Map<EntityKind, Map<number, string[]>>();
  for (const brut of ids) {
    const ref = parseEntityRef(brut);
    if (!ref || !requetes[ref.kind]) continue;
    const famille = parFamille.get(ref.kind) ?? new Map<number, string[]>();
    famille.set(ref.id, [...(famille.get(ref.id) ?? []), brut]);
    parFamille.set(ref.kind, famille);
  }

  const indisponibles = new Set<string>();
  for (const [kind, famille] of parFamille) {
    try {
      // Le compte est dans la clause : une entité d'un autre compte ne
      // remonte pas, donc est marquée indisponible (« suppression ET
      // permission », §19.10).
      const rows = await requeteur(requetes[kind]!, [[...famille.keys()], accountId]);
      const vivants = new Set(rows.map((r) => Number(r.id)));
      for (const [id, bruts] of famille) if (!vivants.has(id)) bruts.forEach((b) => indisponibles.add(b));
    } catch (e) {
      console.warn(`[verebona] disponibilité non vérifiable pour ${kind} :`, (e as Error).message);
    }
  }
  return indisponibles;
}

/**
 * Marque les sources devenues indisponibles (lien retiré).
 *
 * Ne lève jamais : une vérification impossible ne doit pas empêcher
 * l'affichage d'une réponse.
 */
export async function marquerDisponibilite(
  sources: ResolvedSource[],
  accountId: number,
  requeteur: Requeteur = requeteurPg,
): Promise<ResolvedSource[]> {
  if (sources.length === 0) return sources;
  const morts = await identifiantsIndisponibles(sources.map((s) => s.id), accountId, requeteur)
    .catch(() => new Set<string>());
  if (morts.size === 0) return sources;
  return sources.map((s) => (morts.has(s.id)
    ? {
        ...s,
        isAvailable: false,
        // L'action d'ouverture est retirée : proposer un lien mort est pire
        // que de ne rien proposer.
        openAction: null,
      }
    : s));
}

/** Statut affiché sur une carte dont l'objet n'est plus accessible. */
export const CARTE_INDISPONIBLE = 'N’est plus disponible';

/**
 * Revérifie les cartes de résultats relues depuis l'historique
 * (`result_groups_json`) : une carte dont l'objet a été supprimé ou n'est
 * plus accessible perd son lien et l'indique (§19.10, §22.1).
 */
export async function reverifierCartes(
  groups: ResultGroup[] | null | undefined,
  accountId: number,
  requeteur: Requeteur = requeteurPg,
): Promise<ResultGroup[] | null | undefined> {
  if (!Array.isArray(groups) || groups.length === 0) return groups;
  const ids = groups.flatMap((g) => (Array.isArray(g.items) ? g.items : []).filter((c) => c?.href).map((c) => c.id));
  if (ids.length === 0) return groups;
  const morts = await identifiantsIndisponibles(ids, accountId, requeteur).catch(() => new Set<string>());
  if (morts.size === 0) return groups;
  return groups.map((g) => ({
    ...g,
    items: g.items.map((c) => (morts.has(c.id) ? { ...c, href: null, status: CARTE_INDISPONIBLE } : c)),
  }));
}

/**
 * Applique `reverifierCartes` aux messages d'un historique (colonne
 * `result_groups_json`). Ne lève jamais.
 */
export async function reverifierCartesDesMessages<T extends { result_groups_json?: unknown }>(
  messages: T[],
  accountId: number,
  requeteur: Requeteur = requeteurPg,
): Promise<T[]> {
  const avecCartes = messages.filter((m) => Array.isArray(m.result_groups_json) && (m.result_groups_json as unknown[]).length > 0);
  if (avecCartes.length === 0) return messages;
  // Une seule vérification pour tout l'historique : les identifiants de
  // toutes les cartes sont regroupés, puis redistribués.
  const tous = avecCartes.flatMap((m) => m.result_groups_json as ResultGroup[]);
  const morts = await identifiantsIndisponibles(
    tous.flatMap((g) => (Array.isArray(g.items) ? g.items : []).filter((c) => c?.href).map((c) => c.id)),
    accountId, requeteur,
  ).catch(() => new Set<string>());
  if (morts.size === 0) return messages;
  return messages.map((m) => (Array.isArray(m.result_groups_json)
    ? {
        ...m,
        result_groups_json: (m.result_groups_json as ResultGroup[]).map((g) => ({
          ...g,
          items: (g.items ?? []).map((c) => (morts.has(c.id) ? { ...c, href: null, status: CARTE_INDISPONIBLE } : c)),
        })),
      }
    : m));
}
