/**
 * Références d'entités et routes internes — CDC §19.2, §22.7.
 *
 * ── POURQUOI CE MODULE EXISTE ────────────────────────────────────────────
 * Les sources récupérées portent un identifiant PRÉFIXÉ (« asset_42 »,
 * « doc_128 », « agenda_9 »…). Le préfixe n'est pas décoratif : c'est lui qui
 * dit au serveur sur quelle table vérifier l'appartenance au compte, et vers
 * quelle route ouvrir l'objet.
 *
 * Jusqu'ici ce préfixe était transporté tel quel jusqu'aux vérificateurs
 * d'accès, qui l'injectaient dans un `WHERE id = $1` sur une colonne entière.
 * Postgres rejette « asset_42 » comme entier : le contrôle ne renvoyait donc
 * jamais vrai, et l'action correspondante était systématiquement écartée.
 *
 * Deux responsabilités, volontairement réunies ici parce qu'elles partagent la
 * même table de correspondance :
 *   1. décoder un identifiant de source en { type d'entité, identifiant réel } ;
 *   2. construire l'URL interne qui ouvre cette entité.
 *
 * ── LES ROUTES SONT CELLES DE L'APPLICATION, PAS CELLES DU CDC ───────────
 * Le §22.7 impose que le href soit construit « à partir des routes réelles de
 * l'app ». Les constantes ci-dessous ont été relevées dans `src/app` et dans la
 * navigation (`DashboardLayout`, `bottom-navigation`), pas déduites des noms
 * fonctionnels. C'est ce qui distingue « /accueil/a-traiter » (qui existe) de
 * « /a-traiter » (qui n'existe pas).
 *
 * Toute action dont la destination n'existe pas encore renvoie `null` plutôt
 * qu'une URL plausible : un lien mort est pire qu'une action absente, parce
 * qu'il fait porter à l'utilisateur le coût de la découvrir.
 */
import { drawerHref } from '@/lib/drawers';

/** Familles d'entités référençables par une source (§19.2). */
export type EntityKind = 'asset' | 'document' | 'agenda_item' | 'equipment' | 'room';

/**
 * Préfixes émis par les adaptateurs de retrieval
 * (`registries/retrieval-adapters.ts`). Toute évolution des adaptateurs doit
 * être répercutée ici, sinon la source devient non ouvrable en silence.
 */
const PREFIXE_VERS_KIND: Readonly<Record<string, EntityKind>> = {
  asset: 'asset',
  doc: 'document',
  agenda: 'agenda_item',
  equipment: 'equipment',
  room: 'room',
};

export interface EntityRef {
  kind: EntityKind;
  /** Identifiant NUMÉRIQUE, tel qu'il existe en base. */
  id: number;
  /** Identifiant préfixé d'origine — conservé pour les journaux (§32). */
  sourceId: string;
}

/**
 * Onglets réels de la fiche bien (`assets/[id]/page.tsx`, paramètre `tab`).
 * Le paramètre historique `?onglet=` n'a jamais été lu par la page.
 */
export const ONGLETS_BIEN = ['overview', 'details', 'documents', 'rooms', 'equipments', 'agenda', 'exports'] as const;
export type OngletBien = (typeof ONGLETS_BIEN)[number];

/** Routes réelles de l'application (relevées dans `src/app`). */
export const ROUTES = {
  BIENS: '/assets',
  DOCUMENTS: '/documents',
  AGENDA: '/agenda',
  A_TRAITER: '/accueil/a-traiter',
  COMPTE: '/mon-compte',
  OFFRES: '/abonnement',
  AIDE: '/aide',
} as const;

function versEntierPositif(valeur: string): number | null {
  // Volontairement strict : pas de `Number()` permissif, qui accepterait
  // « 42abc », « 0x2a » ou « 4e2 » et laisserait passer un identifiant
  // fabriqué par le modèle.
  if (!/^\d+$/.test(valeur)) return null;
  const n = Number(valeur);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Décode un identifiant de source ou une cible d'action.
 *
 * `attendu` sert deux buts : accepter un identifiant nu (« 42 ») quand
 * l'appelant sait déjà de quelle entité il parle — par exemple un `assetId`
 * venant du contexte de page (§27.1) — et refuser une cible dont le type ne
 * correspond pas à l'action demandée (§22.7).
 *
 * Renvoie `null` dès que quelque chose cloche : c'est le point d'entrée des
 * identifiants proposés par le modèle, on n'y accorde aucune confiance (§18.4).
 */
export function parseEntityRef(
  valeur: string | number | null | undefined,
  attendu?: EntityKind,
): EntityRef | null {
  if (valeur == null) return null;
  const brut = String(valeur).trim();
  if (!brut) return null;

  const separateur = brut.lastIndexOf('_');

  if (separateur === -1) {
    if (!attendu) return null;
    const id = versEntierPositif(brut);
    return id == null ? null : { kind: attendu, id, sourceId: brut };
  }

  const kind = PREFIXE_VERS_KIND[brut.slice(0, separateur)];
  const id = versEntierPositif(brut.slice(separateur + 1));
  if (!kind || id == null) return null;
  if (attendu && kind !== attendu) return null;

  return { kind, id, sourceId: brut };
}

/** URL de la fiche d'un bien, éventuellement sur un onglet précis. */
export function hrefBien(id: number, onglet?: OngletBien): string {
  return onglet && onglet !== 'overview' ? `${ROUTES.BIENS}/${id}?tab=${onglet}` : `${ROUTES.BIENS}/${id}`;
}

/**
 * URL d'ouverture d'une entité, ou `null` si l'application n'a pas de
 * destination pour elle.
 *
 * Document, échéance, équipement et pièce s'ouvrent en tiroir, par lien
 * profond `?tiroir=<kind>:<id>` (src/lib/drawers.ts) : l'utilisateur arrive
 * sur la fiche elle-même, pas sur une liste où la chercher.
 *   · `document` — `/documents/[id]` attend l'identifiant public et n'est pas
 *     la vue de référence ; le tiroir l'est.
 *   · `agenda_item` — l'agenda n'a pas de page de détail, le tiroir en tient lieu.
 *   · `equipment` / `room` — ouverts sur le bien parent, onglet correspondant,
 *     quand `assetId` est connu ; sinon sur l'accueil, le tiroir retrouvant
 *     lui-même le bien.
 */
export function hrefEntite(
  ref: EntityRef,
  meta?: Record<string, string | number | boolean | null> | null,
): string | null {
  switch (ref.kind) {
    case 'asset':
      return hrefBien(ref.id);
    case 'document':
      return drawerHref({ kind: 'document', id: ref.id }, ROUTES.DOCUMENTS);
    case 'agenda_item':
      return drawerHref({ kind: 'echeance', id: ref.id }, ROUTES.AGENDA);
    case 'equipment':
    case 'room': {
      const kind = ref.kind === 'room' ? 'piece' : 'equipement';
      const parent = versEntierPositif(String(meta?.assetId ?? ''));
      const page = parent == null ? '/accueil' : hrefBien(parent, ref.kind === 'room' ? 'rooms' : 'equipments');
      return drawerHref({ kind, id: ref.id }, page);
    }
    default:
      return null;
  }
}

/**
 * Raccourci pour les appelants qui ne disposent que de l'identifiant préfixé
 * — typiquement la route des sources d'un message, qui relit un instantané
 * en base (§19.9).
 */
export function hrefSource(
  sourceId: string,
  meta?: Record<string, string | number | boolean | null> | null,
): string | null {
  const ref = parseEntityRef(sourceId);
  return ref ? hrefEntite(ref, meta) : null;
}
