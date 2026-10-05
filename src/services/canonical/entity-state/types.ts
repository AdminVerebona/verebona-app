/**
 * État canonique d'un ÉQUIPEMENT ou d'une PIÈCE — types publics (CDC 15
 * T1-04, T3-01, T3-02, T3-05 ; plan lot 18, volet R3).
 *
 * PIÈCE (`ROOM`) = SOUS-STRUCTURE (`substructures.id`) depuis la décision PO
 * D-G (lot 20, migration 0229) ; la table `rooms` n'est plus lue.
 */
import type {
  CanonicalFieldState, CanonicalFieldWrite, CanonicalOrigin, CanonicalWriteResult, CanonicalWriteSource,
} from '@/services/canonical/asset-state';

/** Cibles d'une fiche autre que le bien (registre : `targetTypes`). `ROOM` : identifiant de `substructures`. */
export type CanonicalEntityType = 'EQUIPMENT' | 'ROOM';

export interface CanonicalEntityTarget {
  type: CanonicalEntityType;
  id: number;
}

/** Colonne miroir d'un champ d'entité (D-10 transposée). */
export interface EntityMirrorColumn {
  table: 'equipments' | 'equipment_cil_specs' | 'substructures';
  column: string;
  transform: 'eur_to_cents' | 'number' | 'text_number' | 'identity';
}

/** Ligne chargée d'une entité, bornée au compte par le bien parent. */
export interface CanonicalEntityRow {
  target: CanonicalEntityTarget;
  /** Bien PORTEUR (cloisonnement, journal, événements). */
  assetId: number;
  accountId: number;
  name: string | null;
  /** Équipement archivé (lu, jamais réconcilié par T3). */
  archived: boolean;
  /** Fiche canonique de l'entité (0227). */
  kc: Record<string, unknown>;
  /** Colonnes miroirs lues, indexées `table.colonne`. */
  columns: Record<string, unknown>;
  /** `equipment_cil_specs` existe déjà pour cet équipement. */
  hasSpecs?: boolean;
}

export interface CanonicalEntityState {
  target: CanonicalEntityTarget;
  assetId: number;
  accountId: number;
  name: string | null;
  archived: boolean;
  /** Clés canoniques renseignées → état (même forme que pour un bien). */
  fields: Record<string, CanonicalFieldState>;
  /** Fiche brute (autorité, date de preuve : arbitrages T3). */
  kc: Record<string, unknown>;
}

export interface WriteCanonicalEntityFieldsInput {
  target: CanonicalEntityTarget;
  accountId: number;
  writes: CanonicalFieldWrite[];
  origin: CanonicalOrigin;
  actorUserId?: number | null;
  source?: CanonicalWriteSource;
  traceId?: string | null;
  /** Publie ASSET_UPDATED (bien porteur) après écriture (défaut : oui). */
  emitEvent?: boolean;
}

export interface WriteCanonicalEntityFieldInput extends Omit<WriteCanonicalEntityFieldsInput, 'writes'>, Omit<CanonicalFieldWrite, 'key' | 'value'> {
  key: string;
  value: unknown;
}

export interface CanonicalEntityWriteResult extends CanonicalWriteResult {
  target: CanonicalEntityTarget;
  /** Bien porteur (null : entité introuvable dans le compte). */
  assetId: number | null;
  /** Migration 0227 absente : rien n'a été lu ni écrit. */
  schemaNotReady?: boolean;
  /** Rien n'a été tenté (migration 0227 absente). */
  skipped: boolean;
}
