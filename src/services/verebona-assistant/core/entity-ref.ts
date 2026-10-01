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
import { SUPPLIERS_ROUTE, supplierHref } from '@/lib/supplier-routes';
import { parseAssetFieldSourceId } from '../canonical/source-ids';

/** Familles d'entités référençables par une source (§19.2). */
export type EntityKind = 'asset' | 'document' | 'agenda_item' | 'equipment' | 'room' | 'supplier' | 'to_process' | 'export';

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
  // Fournisseurs (§11.1) : fiche `/fournisseurs/[id]` (OPEN_SUPPLIER).
  // Éléments « À traiter » : reconnus pour l'affichage et la disponibilité.
  supplier: 'supplier',
  todo: 'to_process',
  // Exports et dossiers générés (§12.1) : onglet « Exports » du bien.
  export: 'export',
};

export interface EntityRef {
  kind: EntityKind;
  /** Identifiant NUMÉRIQUE, tel qu'il existe en base. */
  id: number;
  /** Identifiant préfixé d'origine — conservé pour les journaux (§32). */
  sourceId: string;
  /**
   * Source de NIVEAU CHAMP (`asset_field:<assetId>:<clé>`, CDC 15 T2-32) :
   * clé canonique du registre. L'entité reste le BIEN (`kind: 'asset'`) : son
   * appartenance au compte est vérifiée comme celle de toute source bien.
   */
  fieldKey?: string;
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
  FOURNISSEURS: SUPPLIERS_ROUTE,
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

  // CDC 15 T2-32 (lot 15) : source de niveau champ `asset_field:<id>:<clé>`,
  // décodée par la couche canonique (clé du registre obligatoire). Entité :
  // le bien — contrôle d'appartenance au compte par la famille `asset`.
  if (brut.startsWith('asset_field:')) {
    const champ = parseAssetFieldSourceId(brut);
    if (!champ || (attendu && attendu !== 'asset')) return null;
    return { kind: 'asset', id: champ.assetId, sourceId: brut, fieldKey: champ.key };
  }

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
      // Source de niveau champ : fiche du bien, onglet « Détails », champ en
      // surbrillance (`?highlight=`, lu par AssetDetailsTab).
      return ref.fieldKey
        ? `${hrefBien(ref.id, 'details')}&highlight=${encodeURIComponent(ref.fieldKey)}`
        : hrefBien(ref.id);
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
    case 'to_process':
      return ROUTES.A_TRAITER;
    // Fiche fournisseur (page `/fournisseurs/[id]`, droits du compte).
    case 'supplier':
      return supplierHref(ref.id);
    // Export : ouvert dans l'onglet « Exports » de son bien, seul endroit où
    // l'application le présente ; sans bien connu, pas de lien deviné.
    case 'export': {
      const parent = versEntierPositif(String(meta?.assetId ?? ''));
      return parent == null ? null : hrefBien(parent, 'exports');
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
  return ref ? hrefEntite(ref, meta) : hrefAgendaSynthetique(sourceId);
}

/**
 * Sources SYNTHÉTIQUES d'agenda (reliquat R8) : `timeline:<portée>:<n>` et
 * `upcoming_agenda:<portée>` regroupent plusieurs événements, sans objet
 * unique à ouvrir. Elles ouvrent l'agenda filtré sur leur portée (page
 * `/agenda`, paramètre `assetIds` lu par la page) :
 *   · `asset_12` → `/agenda?assetIds=12` ; `assets_3_7` → `/agenda?assetIds=3,7` ;
 *   · `account` → `/agenda` (tout le compte).
 * Toute autre source synthétique (`to_process:…`, `expenses:…`) : `null`,
 * non ouvrable — jamais de lien deviné.
 */
export function hrefAgendaSynthetique(sourceId: string): string | null {
  const m = /^(?:timeline:([a-z0-9_]+):\d+|upcoming_agenda:([a-z0-9_]+))$/.exec(sourceId);
  if (!m) return null;
  const portee = m[1] ?? m[2];
  if (portee === 'account') return ROUTES.AGENDA;
  const p = /^assets?_((?:\d+_)*\d+)$/.exec(portee);
  if (!p) return null;
  const ids = p[1].split('_').map(versEntierPositif);
  if (ids.some((x) => x == null) || (portee.startsWith('asset_') && ids.length !== 1)) return null;
  return `${ROUTES.AGENDA}?assetIds=${ids.join(',')}`;
}
