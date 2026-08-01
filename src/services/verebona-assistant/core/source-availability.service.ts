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
 * Pire dans le cas d'un historique : les conversations sont conservées sept
 * jours (§24.3). Rouvrir une conversation d'hier affichait des liens vers des
 * documents effacés depuis, sans rien pour le signaler.
 *
 * ── CE N'EST PAS QU'UNE QUESTION DE CONFORT ───────────────────────────────
 *
 * La vérification porte AUSSI sur l'appartenance au compte. Une source
 * récupérée pour un compte partagé (Duo) peut cesser d'être accessible à
 * l'utilisateur qui relit la conversation — le §19.10 associe explicitement
 * « suppression » et « permission ».
 *
 * ── UNE SEULE REQUÊTE PAR FAMILLE ─────────────────────────────────────────
 *
 * Vérifier source par source produirait autant de requêtes que de citations,
 * sur un chemin déjà contraint par le délai de réponse. Les identifiants sont
 * donc regroupés par famille, et chaque famille interrogée une fois.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';
import type { ResolvedSource, SourceType } from '../types/sources';

/** Familles dont la disponibilité se vérifie en base. */
const TABLES: Partial<Record<SourceType, { table: string; colonneCompte: string }>> = {
  asset_field: { table: 'assets', colonneCompte: 'account_id' },
  document: { table: 'asset_files', colonneCompte: 'account_id' },
  document_extraction: { table: 'asset_files', colonneCompte: 'account_id' },
  agenda_item: { table: 'agenda_items', colonneCompte: 'account_id' },
  to_process_item: { table: 'asset_files', colonneCompte: 'account_id' },
};

/**
 * Extrait l'identifiant numérique d'une référence « doc_128 ».
 *
 * Une référence non numérique — un article d'aide, une règle d'offre — n'a pas
 * de ligne à vérifier : ces sources sont partagées et ne disparaissent pas.
 */
function numero(reference: string): number | null {
  const m = reference.match(/(\d+)$/);
  return m ? Number(m[1]) : null;
}

/**
 * Marque les sources devenues indisponibles.
 *
 * Ne lève jamais : une vérification impossible ne doit pas empêcher
 * l'affichage d'une réponse. En cas d'incident, les sources restent marquées
 * disponibles — l'utilisateur verra un lien mort plutôt qu'aucune réponse.
 */
export async function marquerDisponibilite(
  sources: ResolvedSource[],
  accountId: number,
): Promise<ResolvedSource[]> {
  if (sources.length === 0) return sources;

  // Regroupement par famille : une requête par table, jamais une par source.
  const parFamille = new Map<SourceType, number[]>();
  for (const s of sources) {
    if (!TABLES[s.type]) continue;
    const id = numero(s.id);
    if (id === null) continue;
    if (!parFamille.has(s.type)) parFamille.set(s.type, []);
    parFamille.get(s.type)!.push(id);
  }

  if (parFamille.size === 0) return sources;

  const vivants = new Map<SourceType, Set<number>>();

  for (const [type, ids] of parFamille) {
    const cfg = TABLES[type]!;
    try {
      // Le compte est dans la clause : une source appartenant à un autre
      // compte ne remonte pas, donc est marquée indisponible — ce qui est le
      // comportement voulu, le §19.10 visant « suppression ET permission ».
      const rows = await pgClient<{ id: number }[]>`
        SELECT id FROM ${pgClient(cfg.table)}
         WHERE id = ANY(${ids})
           AND ${pgClient(cfg.colonneCompte)} = ${accountId}
           AND deleted_at IS NULL
      `;
      vivants.set(type, new Set(rows.map((r) => r.id)));
    } catch (e) {
      // Table sans `deleted_at`, ou incident : on ne marque rien plutôt que
      // de tout marquer indisponible, ce qui masquerait des sources valides.
      console.warn(
        `[verebona] disponibilité non vérifiable pour ${type} :`,
        (e as Error).message,
      );
      vivants.set(type, new Set(ids));
    }
  }

  return sources.map((s) => {
    const ensemble = vivants.get(s.type);
    if (!ensemble) return s;
    const id = numero(s.id);
    if (id === null) return s;
    const disponible = ensemble.has(id);
    return disponible
      ? s
      : {
          ...s,
          isAvailable: false,
          // L'action d'ouverture est retirée : proposer un lien mort est pire
          // que de ne rien proposer.
          openAction: null,
        };
  });
}
