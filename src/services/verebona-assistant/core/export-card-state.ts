/**
 * État RELU de la carte d'un export demandé depuis l'Assistant — Trello #753, passage 114AA
 * (CDC T2 §9.10, §14.3 W28, §19.10, §22.1).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * « VOTRE DOSSIER EST PRÊT », SANS AUCUNE TÂCHE DE FOND
 *
 * Un dossier prêt à l'emploi demandé par écrit est mis en file : sa génération
 * se termine dans un AUTRE processus (le worker d'export). La conversation
 * affichait donc une carte « En préparation » définitive — l'utilisateur
 * devait aller voir l'onglet « Exports » du bien pour savoir où en était son
 * dossier.
 *
 * Aucune tâche de fond n'est ajoutée, aucune notification n'est poussée : la
 * carte porte l'identifiant de SA génération (`export_<id>`), et son état est
 * relu aux deux seuls moments où l'utilisateur regarde la conversation :
 *   · il y revient (GET /api/verebona/conversation) ;
 *   · il envoie un message (POST /api/verebona/messages).
 * La carte passe alors de « En préparation » à « Prêt », avec son lien de
 * téléchargement (la route de téléchargement revérifie les droits à chaque
 * clic). Un échec ou une expiration sont dits, eux aussi.
 *
 * ── LE COÛT EST BORNÉ ─────────────────────────────────────────────────────
 *
 * Aucune requête n'est émise si aucune carte du fil n'est « En préparation » :
 * le repérage se fait dans les cartes DÉJÀ lues (un `status` et un
 * identifiant). Quand il y en a, c'est UNE requête pour tout le fil, bornée
 * au compte. La fonction ne lève jamais : une relecture impossible laisse la
 * carte telle qu'elle était enregistrée.
 *
 * ── RIEN N'EST RÉÉCRIT EN BASE ────────────────────────────────────────────
 *
 * L'état relu n'est pas persisté : `result_groups_json` garde ce qui a été
 * répondu. La carte affichée est donc toujours l'état RÉEL au moment de la
 * lecture, et aucune migration n'est nécessaire.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';
import { parseEntityRef } from './entity-ref';
import type { ResultGroup } from './result-groups';

/** Statuts affichés sur la carte d'un export de l'Assistant (textes du passage 114Y, repris tels quels). */
export const CARTE_EXPORT_EN_PREPARATION = 'En préparation';
export const CARTE_EXPORT_PRET = 'Prêt';
/** Passage 114AA : la génération a échoué — l'onglet « Exports » du bien en donne le motif. */
export const CARTE_EXPORT_ECHEC = 'Échec';
/** Passage 114AA : le dossier a été généré mais n'est plus téléchargeable (rétention dépassée). */
export const CARTE_EXPORT_EXPIRE = 'Expiré';

/** Nombre de cartes « En préparation » relues en une fois : un fil n'en porte jamais beaucoup. */
const MAX_CARTES = 20;

/** État relu d'une génération : statut à afficher, lien à proposer (`null` : aucun). */
export interface EtatCarteExport { status: string; href: string | null }

/** Ligne de génération, réduite à ce que la carte en dit. */
export interface LigneGeneration {
  id: number;
  publicId: string;
  status: string;
  outputPayload: string | null;
  expiresAt: Date | string | null;
  cancelRequestedAt?: Date | string | null;
  cancelReason?: string | null;
}

/** Lecteur des générations du compte — injectable pour les tests ; `sqlGenerations` en production. */
export type LecteurGenerations = (accountId: number, ids: number[]) => Promise<LigneGeneration[]>;

/**
 * Identifiants de générations portés par les cartes ENCORE « En préparation » (pure).
 * Vide : rien à relire, donc aucune requête.
 */
export function generationsEnPreparation(groups: readonly ResultGroup[]): number[] {
  const ids = new Set<number>();
  for (const g of groups) {
    for (const c of Array.isArray(g?.items) ? g.items : []) {
      if (!c || c.status !== CARTE_EXPORT_EN_PREPARATION) continue;
      const ref = parseEntityRef(c.id, 'export');
      if (ref) ids.add(ref.id);
      if (ids.size >= MAX_CARTES) return [...ids];
    }
  }
  return [...ids];
}

/**
 * État à afficher pour une génération relue (pure) : « Prêt » et son lien de téléchargement dès qu'elle est
 * disponible, « Échec » ou « Expiré » quand c'est le cas, et `null` tant qu'elle est en file ou en cours
 * (la carte garde alors « En préparation »).
 *
 * Le statut est normalisé par le MÊME code que l'onglet « Exports » (`normalizeGenerationStatus`,
 * `outputKeys`) : l'Assistant ne définit aucune règle d'état d'export de son côté.
 */
export function etatCarteExport(
  ligne: LigneGeneration,
  normaliser: (row: LigneGeneration) => { statut: string; pdf: string | null; zip: string | null },
): EtatCarteExport | null {
  const { statut, pdf, zip } = normaliser(ligne);
  switch (statut) {
    case 'ready':
    case 'partial': {
      // Même lien que l'onglet « Exports » (droits revérifiés à chaque clic) ; le PDF d'abord, sinon le ZIP.
      const fichier = pdf ? 'pdf' : zip ? 'zip' : null;
      return { status: CARTE_EXPORT_PRET, href: fichier ? `/api/export-generations/${ligne.publicId}/download?file=${fichier}` : null };
    }
    case 'failed':
      return { status: CARTE_EXPORT_ECHEC, href: null };
    case 'expired':
      return { status: CARTE_EXPORT_EXPIRE, href: null };
    // `queued` / `generating` : rien n'a changé. `deleted` / `cancelled` : la garde de disponibilité
    // (`source-availability.service`) retire déjà le lien et dit « N'est plus disponible ».
    default:
      return null;
  }
}

/** Applique les états relus aux cartes d'un message (pure) : seules les cartes « En préparation » changent. */
export function appliquerEtatsExport(groups: readonly ResultGroup[], etats: Map<number, EtatCarteExport>): ResultGroup[] {
  if (etats.size === 0) return groups as ResultGroup[];
  return groups.map((g) => ({
    ...g,
    items: (Array.isArray(g?.items) ? g.items : []).map((c) => {
      if (!c || c.status !== CARTE_EXPORT_EN_PREPARATION) return c;
      const ref = parseEntityRef(c.id, 'export');
      const etat = ref ? etats.get(ref.id) : undefined;
      return etat ? { ...c, status: etat.status, href: etat.href } : c;
    }),
  }));
}

/** Normalisation d'une ligne par le code de l'onglet « Exports » (import différé : module serveur). */
async function normaliseur(): Promise<(row: LigneGeneration) => { statut: string; pdf: string | null; zip: string | null }> {
  const { normalizeGenerationStatus, outputKeys } = await import('@/services/exports/v12/generation/status');
  return (row) => {
    const cles = outputKeys(row.outputPayload);
    return {
      statut: normalizeGenerationStatus(row.status, row.expiresAt, undefined, { requestedAt: row.cancelRequestedAt, reason: row.cancelReason }),
      pdf: cles.pdf, zip: cles.zip,
    };
  };
}

/** Générations du COMPTE, par identifiants (jamais celles d'un autre compte). */
export const sqlGenerations: LecteurGenerations = async (accountId, ids) =>
  (await pgClient.unsafe(
    `SELECT id, public_id AS "publicId", status, output_payload AS "outputPayload", expires_at AS "expiresAt",
            cancel_requested_at AS "cancelRequestedAt", cancel_reason AS "cancelReason"
       FROM export_generation
      WHERE id = ANY($1::int[]) AND account_id = $2`,
    [ids, accountId] as never[],
  )) as unknown as LigneGeneration[];

/**
 * Cartes d'export d'un ensemble de messages, avec leur état RELU. Rend les messages inchangés — et n'émet
 * AUCUNE requête — si aucune carte n'est « En préparation ». Ne lève jamais.
 */
export async function rafraichirCartesExport<T extends { result_groups_json?: unknown }>(
  messages: T[],
  accountId: number,
  lecteur: LecteurGenerations = sqlGenerations,
): Promise<T[]> {
  const avecCartes = messages.filter((m) => Array.isArray(m.result_groups_json) && (m.result_groups_json as unknown[]).length > 0);
  if (avecCartes.length === 0) return messages;
  const ids = generationsEnPreparation(avecCartes.flatMap((m) => m.result_groups_json as ResultGroup[]));
  if (ids.length === 0) return messages;
  const etats = await lireEtats(accountId, ids, lecteur);
  if (etats.size === 0) return messages;
  return messages.map((m) => (Array.isArray(m.result_groups_json)
    ? { ...m, result_groups_json: appliquerEtatsExport(m.result_groups_json as ResultGroup[], etats) }
    : m));
}

/** États relus des générations demandées ; vide si la relecture est impossible (la carte reste telle quelle). */
export async function lireEtats(
  accountId: number,
  ids: number[],
  lecteur: LecteurGenerations = sqlGenerations,
): Promise<Map<number, EtatCarteExport>> {
  const etats = new Map<number, EtatCarteExport>();
  try {
    const [lignes, norm] = await Promise.all([lecteur(accountId, ids), normaliseur()]);
    for (const l of lignes) {
      const etat = etatCarteExport(l, norm);
      if (etat) etats.set(Number(l.id), etat);
    }
  } catch (e) {
    console.warn('[verebona] état des exports du fil non relu :', (e as Error).message);
  }
  return etats;
}

/** Carte d'export d'un message du fil, mise à jour (transmise au client avec la réponse suivante). */
export interface MiseAJourCarte { messageId: string; resultGroups: ResultGroup[] }

/**
 * Cartes d'export d'un FIL dont l'état a changé — appelé quand l'utilisateur envoie un message.
 * Rien à faire (et aucune lecture de génération) si le fil ne porte aucune carte « En préparation ».
 */
export async function misesAJourDuFil(
  p: { accountId: number; userId: number; conversationId: number },
  lecteur: LecteurGenerations = sqlGenerations,
  messages?: Array<{ id: number; result_groups_json: unknown }>,
): Promise<MiseAJourCarte[]> {
  try {
    const lignes = messages ?? await sqlMessagesAvecExportEnPreparation(p);
    if (lignes.length === 0) return [];
    const ids = generationsEnPreparation(lignes.flatMap((m) => (Array.isArray(m.result_groups_json) ? m.result_groups_json as ResultGroup[] : [])));
    if (ids.length === 0) return [];
    const etats = await lireEtats(p.accountId, ids, lecteur);
    if (etats.size === 0) return [];
    const out: MiseAJourCarte[] = [];
    for (const m of lignes) {
      if (!Array.isArray(m.result_groups_json)) continue;
      const avant = m.result_groups_json as ResultGroup[];
      const apres = appliquerEtatsExport(avant, etats);
      if (JSON.stringify(apres) !== JSON.stringify(avant)) out.push({ messageId: String(m.id), resultGroups: apres });
    }
    return out;
  } catch (e) {
    console.warn('[verebona] cartes d’export du fil non relues :', (e as Error).message);
    return [];
  }
}

/**
 * Messages du fil de CET utilisateur qui portent une carte « En préparation » (filtre dans la requête :
 * un fil ordinaire n'en a aucune, et la requête ne rend alors rien). Jamais un autre fil, jamais un autre membre.
 */
async function sqlMessagesAvecExportEnPreparation(
  p: { accountId: number; userId: number; conversationId: number },
): Promise<Array<{ id: number; result_groups_json: unknown }>> {
  return (await pgClient.unsafe(
    `SELECT m.id, m.result_groups_json
       FROM verebona_messages m
       JOIN verebona_conversations c ON c.id = m.conversation_id
      WHERE c.id = $1 AND c.account_id = $2 AND c.user_id = $3 AND c.status = 'active'
        AND m.account_id = $2 AND m.role = 'assistant' AND m.expires_at > now()
        AND m.result_groups_json IS NOT NULL
        AND m.result_groups_json::text LIKE $4
      ORDER BY m.id DESC
      LIMIT $5`,
    [p.conversationId, p.accountId, p.userId, `%${CARTE_EXPORT_EN_PREPARATION}%`, MAX_CARTES] as never[],
  )) as unknown as Array<{ id: number; result_groups_json: unknown }>;
}
