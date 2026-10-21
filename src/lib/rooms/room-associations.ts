/**
 * Tiroir Pièce — contrat partagé entre la route
 * `/api/substructures/[id]/associations`, le service central
 * (`services/rooms/room-scope.service.ts`) et l'écran. Lot 75 (75B).
 *
 * Fichier sans dépendance serveur.
 */

/** Équipement de la pièce. */
export interface RoomEquipmentEntry {
  id: number;
  name: string;
  type: string | null;
  status: string;
  archived: boolean;
}

/**
 * Document de la pièce, une seule fois, avec sa provenance : `direct` (lié à
 * la pièce elle-même) et/ou `via` (équipements de la pièce qui le portent).
 */
export interface RoomDocumentEntry {
  id: number;
  publicId: string;
  title: string;
  documentTypeLabel: string | null;
  documentDate: string | null;
  mimeType: string | null;
  direct: boolean;
  via: Array<{ id: number; name: string }>;
}

/** Équipement ou document proposé à l'association. */
export interface RoomCandidate {
  id: number;
  title: string;
  /** Type d'équipement, ou date du document. */
  meta: string | null;
  /** Pièce actuelle (autre que celle-ci) : la sélection est une réaffectation. */
  currentRoom: { id: number; name: string } | null;
}

export interface RoomAssociations {
  room: { id: number; name: string; assetId: number; assetName: string };
  equipments: RoomEquipmentEntry[];
  documents: RoomDocumentEntry[];
}

/** Conflit de réaffectation rendu par le serveur (409 `REASSIGN_CONFIRMATION`). */
export interface RoomReassignConflict {
  id: number;
  title: string;
  currentRoom: { id: number; name: string };
}

/**
 * Libellés de provenance : « Pièce », « Via Réfrigérateur », ou les deux
 * (« Pièce · Via Réfrigérateur ») quand le document est lié par les deux
 * chemins. Plusieurs équipements : « Via Four, Réfrigérateur ».
 */
export function roomDocumentProvenance(d: Pick<RoomDocumentEntry, 'direct' | 'via'>): string[] {
  const out: string[] = [];
  if (d.direct) out.push('Pièce');
  if (d.via.length > 0) out.push(`Via ${d.via.map((v) => v.name).join(', ')}`);
  return out;
}

/** La dissociation depuis la pièce n'existe que pour un lien DIRECT. */
export function canDissociateRoomDocument(d: Pick<RoomDocumentEntry, 'direct'>): boolean {
  return d.direct;
}

/** Texte de la confirmation de réaffectation (équipements ou documents). */
export function reassignConfirmationText(kind: 'equipment' | 'document', roomName: string, conflicts: readonly RoomReassignConflict[]): string {
  const objet = kind === 'equipment' ? 'équipement' : 'document';
  const lignes = conflicts.map((c) => `« ${c.title} » (actuellement : ${c.currentRoom.name || 'autre pièce'})`).join(', ');
  return conflicts.length > 1
    ? `Ces ${objet}s sont déjà associés à une autre pièce : ${lignes}. Ils seront déplacés vers « ${roomName} ».`
    : `Cet ${objet} est déjà associé à une autre pièce : ${lignes}. Il sera déplacé vers « ${roomName} ».`;
}

/**
 * Événement émis après toute modification d'association pièce ↔ équipement
 * ↔ document : les tiroirs ouverts (Pièce, Équipement, Document) et les
 * listes se relisent. `refresh-a-traiter` (DATA_MUTATION_EVENTS) part aussi.
 */
export const ROOM_ASSOCIATIONS_CHANGED = 'room-associations-changed';

export interface RoomAssociationsChangedDetail {
  roomIds: number[];
  equipmentIds: number[];
  fileIds: number[];
}

export function notifyRoomAssociationsChanged(detail: Partial<RoomAssociationsChangedDetail>): void {
  if (typeof window === 'undefined') return;
  const d: RoomAssociationsChangedDetail = {
    roomIds: detail.roomIds ?? [], equipmentIds: detail.equipmentIds ?? [], fileIds: detail.fileIds ?? [],
  };
  window.dispatchEvent(new CustomEvent<RoomAssociationsChangedDetail>(ROOM_ASSOCIATIONS_CHANGED, { detail: d }));
  window.dispatchEvent(new CustomEvent('refresh-a-traiter'));
  // Les échéances d'une pièce suivent ses équipements et documents.
  window.dispatchEvent(new CustomEvent('agenda-mutated'));
}
