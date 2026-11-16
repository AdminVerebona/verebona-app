/**
 * Catalogue des actions de l'assistant, par NATURE — CDC BO IA.
 *
 *   · navigation     : ouvre un écran ou un objet (OPEN_*) — aucune écriture ;
 *   · start_flow     : démarre un parcours de saisie (START_*) — l'écriture
 *                      se fait ensuite dans le formulaire classique ;
 *   · write_command  : commande métier exécutée depuis le chat, APRÈS
 *                      confirmation explicite d'un plan préparé et figé.
 *
 * Les commandes d'écriture n'embarquent aucune règle métier : chacune
 * appelle le service existant de l'interface classique (voir executors.ts).
 */
import type { VerebonaActionType } from '../types/actions';
import type { ReferenceEventParams } from './reference-event-model';

export type ActionKind = 'navigation' | 'start_flow' | 'write_command' | 'display';

export function actionKind(type: VerebonaActionType | WriteCommandType): ActionKind {
  if ((WRITE_COMMANDS as readonly string[]).includes(type)) return 'write_command';
  if (type.startsWith('START_')) return 'start_flow';
  if (type.startsWith('OPEN_')) return 'navigation';
  return 'display';
}

/**
 * Lot 113P (#715) : MARK_AGENDA_DONE / CANCEL_AGENDA_ITEM retirées — un événement
 * n'a plus de statut (« réalisée » / « annulée ») ; il se modifie ou se supprime.
 */
/**
 * Lot 114B (Trello #753, CDC T2 §9.2, §14.3, M16) — catalogue FERMÉ étendu :
 * UPDATE_AGENDA_ITEM (W16) et DELETE_AGENDA_ITEM (W17). Aucun statut d'événement
 * n'est réintroduit : un événement se modifie ou se supprime, par le service de
 * l'Agenda (`updateAgendaItem`, `deleteAgendaItem`), comme depuis son tiroir.
 */
const WRITE_COMMANDS = [
  'CREATE_AGENDA_ITEM', 'UPDATE_ASSET_FIELD', 'UPDATE_AGENDA_ITEM', 'DELETE_AGENDA_ITEM',
  // Biens (W01, W03) : par la façade métier `asset-write.facade`, la même que la route.
  'CREATE_ASSET', 'DELETE_ASSET',
  // Fournisseurs (W18 – W20) : par la façade métier `supplier-write.facade`, la même que les routes.
  // Le retrait d'un fournisseur est son ARCHIVAGE (aucune suppression physique, liens conservés).
  'CREATE_SUPPLIER', 'UPDATE_SUPPLIER', 'ARCHIVE_SUPPLIER',
  // Documents (W10, W12, W14) : par la façade métier `document-write.facade`, la même que les routes.
  'CREATE_WEB_DOCUMENT', 'UPDATE_DOCUMENT', 'DELETE_DOCUMENT',
  // Passage 114AB (W12, W14) : NATURE d'un document (Rubrique et Type V2) et suppression de PLUSIEURS
  // documents à la fois — par la même façade métier (`updateDocumentClassificationForAccount`, `softDeleteDocument`).
  'UPDATE_DOCUMENT_CLASSIFICATION', 'DELETE_DOCUMENTS',
  // Pièces et équipements (W04 – W09) : par la façade métier `structure-write.facade`, la même que les routes.
  // Le retrait d'un équipement est son ARCHIVAGE (règle existante) ; une pièce se supprime.
  'CREATE_ROOM', 'RENAME_ROOM', 'DELETE_ROOM', 'CREATE_EQUIPMENT', 'RENAME_EQUIPMENT', 'ARCHIVE_EQUIPMENT',
  // Lot 114F (W02, W27) : nom d'un bien et effacement d'une caractéristique, par le service de la fiche
  // (`asset-details-write.service`), le même que `PATCH /api/assets/[id]/details/[section]`.
  'RENAME_ASSET', 'CLEAR_ASSET_FIELD',
  // Passage 114AA (W02) : catégorie de bien et statut, par le même service de la fiche.
  'UPDATE_ASSET_CATEGORY', 'UPDATE_ASSET_STATUS',
  // Lot 114F (W13) : biens auxquels un document est rattaché, par la façade `document-write.facade`.
  'UPDATE_DOCUMENT_TARGETS',
  // Lot 114X (W21 – W26) : événements de référence, par la façade métier `operation-write.facade` (carte #744) —
  // la seule écriture du graphe ; acteur « utilisateur », canal « Assistant ». Le retrait est une INVALIDATION logique.
  'CREATE_REFERENCE_EVENT', 'UPDATE_REFERENCE_EVENT', 'INVALIDATE_REFERENCE_EVENT',
  'ASSOCIATE_REFERENCE_EVENTS', 'LINK_DOCUMENT_REFERENCE_EVENT', 'LINK_SUPPLIER_REFERENCE_EVENT',
  // Passage 114AB : GESTES INVERSES, par la MÊME façade (#744) — rétablir, dissocier, retirer un document
  // ou un fournisseur, rattacher une échéance. Ce ne sont pas des capacités W : ce sont les inverses de W23 – W26.
  'RESTORE_REFERENCE_EVENT', 'DISSOCIATE_REFERENCE_EVENTS', 'UNLINK_DOCUMENT_REFERENCE_EVENT',
  'UNLINK_SUPPLIER_REFERENCE_EVENT', 'LINK_AGENDA_REFERENCE_EVENT',
] as const;
export type WriteCommandType = (typeof WRITE_COMMANDS)[number];

interface WriteCommandDefinition {
  type: WriteCommandType;
  label: string;
  /** Service métier appelé à l'exécution (documentation / trace). */
  service: string;
  /** Contrôle d'accès : compte en écriture + objet du compte. */
  requiresWriteAccess: true;
  /**
   * Lot 114B (#753, CDC T2 §14.3) — fiche de la commande, exigée avant activation :
   * capacité métier, cible, lecture avant écriture, politiques de suppression
   * et d'annulation, effets, événement de succès, sûreté d'un rejeu. Facultative
   * pour les deux commandes historiques (déjà recettées).
   */
  spec?: {
    capabilityCode: string;
    targetKind: 'asset' | 'agenda_item' | 'supplier' | 'document' | 'room' | 'equipment' | 'reference_event';
    requiredFields: readonly string[];
    optionalFields: readonly string[];
    readBeforeWrite: boolean;
    deletePolicy: 'NONE' | 'HARD_DELETE_WITH_EXCLUSION_TRACE' | 'HARD_DELETE_WITH_CONTENT' | 'ARCHIVE_KEEPING_LINKS' | 'SOFT_DELETE' | 'HARD_DELETE_DETACHING_CONTENT'
      /** Invalidation logique (jamais un DELETE) : documents, échéances, fournisseurs et faits conservés. */
      | 'LOGICAL_INVALIDATION';
    undoPolicy: 'REVERSIBLE_15_MIN' | 'IRREVERSIBLE';
    sideEffects: readonly string[];
    successEvent: string;
    /**
     * Un second envoi de la même confirmation ne rejoue jamais l'écriture (prise atomique du plan). Lot 114X :
     * les commandes des événements de référence passent en plus une clé d'idempotence (plan + action) à la façade.
     */
    retrySafety: 'PLAN_TAKEN_ONCE' | 'PLAN_TAKEN_ONCE_AND_IDEMPOTENCY_KEY';
  };
}

export const WRITE_COMMAND_CATALOG: Record<WriteCommandType, WriteCommandDefinition> = {
  CREATE_AGENDA_ITEM: {
    type: 'CREATE_AGENDA_ITEM', label: 'Créer une échéance',
    service: 'AgendaWriteService.createAgendaItem', requiresWriteAccess: true,
  },
  UPDATE_ASSET_FIELD: {
    type: 'UPDATE_ASSET_FIELD', label: 'Modifier une caractéristique d’un bien',
    service: 'asset-details-write.service.updateAssetDetails', requiresWriteAccess: true,
  },
  UPDATE_AGENDA_ITEM: {
    type: 'UPDATE_AGENDA_ITEM', label: 'Modifier une échéance',
    service: 'AgendaWriteService.updateAgendaItem', requiresWriteAccess: true,
    spec: {
      capabilityCode: 'AGENDA_UPDATE', targetKind: 'agenda_item',
      requiredFields: ['agendaItemId', 'expectedVersion'], optionalFields: ['title', 'startDate'],
      readBeforeWrite: true, deletePolicy: 'NONE', undoPolicy: 'IRREVERSIBLE',
      sideEffects: ['rappels de l’échéance recalculés par l’Agenda'], successEvent: 'AGENDA_ITEM_UPDATED', retrySafety: 'PLAN_TAKEN_ONCE',
    },
  },
  DELETE_AGENDA_ITEM: {
    type: 'DELETE_AGENDA_ITEM', label: 'Supprimer une échéance',
    service: 'AgendaWriteService.deleteAgendaItem', requiresWriteAccess: true,
    spec: {
      capabilityCode: 'AGENDA_DELETE', targetKind: 'agenda_item',
      requiredFields: ['agendaItemId', 'scope', 'expectedVersion', 'expectedCount'], optionalFields: [],
      readBeforeWrite: true, deletePolicy: 'HARD_DELETE_WITH_EXCLUSION_TRACE', undoPolicy: 'IRREVERSIBLE',
      sideEffects: ['liens vers les biens et les documents retirés', 'une réanalyse ne recrée pas l’échéance supprimée'],
      successEvent: 'AGENDA_ITEM_DELETED', retrySafety: 'PLAN_TAKEN_ONCE',
    },
  },
  CREATE_ASSET: {
    type: 'CREATE_ASSET', label: 'Créer un bien',
    service: 'asset-write.facade.createAssetForAccount', requiresWriteAccess: true,
    spec: {
      capabilityCode: 'ASSET_CREATE', targetKind: 'asset',
      requiredFields: ['category', 'name'], optionalFields: ['subtype', 'objectCategory'],
      readBeforeWrite: true, deletePolicy: 'NONE', undoPolicy: 'IRREVERSIBLE',
      sideEffects: ['quota de biens de l’offre', 'reprise des documents et faits encore ouverts du compte (T3)'],
      successEvent: 'ASSET_CREATED', retrySafety: 'PLAN_TAKEN_ONCE',
    },
  },
  DELETE_ASSET: {
    type: 'DELETE_ASSET', label: 'Supprimer un bien',
    service: 'asset-write.facade.deleteAssetForAccount', requiresWriteAccess: true,
    spec: {
      capabilityCode: 'ASSET_DELETE', targetKind: 'asset',
      requiredFields: ['assetId', 'expectedSummary'], optionalFields: [],
      readBeforeWrite: true, deletePolicy: 'HARD_DELETE_WITH_CONTENT', undoPolicy: 'IRREVERSIBLE',
      sideEffects: ['documents, photos, échéances, événements, pièces et équipements du bien supprimés', 'fichiers stockés purgés', 'preuves retirées sur les autres biens'],
      successEvent: 'ASSET_DELETED', retrySafety: 'PLAN_TAKEN_ONCE',
    },
  },
  // Lot 114 (Trello #753, CDC T2 §14.3 W18 – W20, X65 – X68) — fournisseurs.
  CREATE_SUPPLIER: {
    type: 'CREATE_SUPPLIER', label: 'Créer un fournisseur',
    service: 'supplier-write.facade.createSupplierForAccount', requiresWriteAccess: true,
    spec: {
      capabilityCode: 'SUPPLIER_CREATE', targetKind: 'supplier',
      requiredFields: ['name'], optionalFields: ['phone', 'email', 'website', 'distinctFrom'],
      readBeforeWrite: true, deletePolicy: 'NONE', undoPolicy: 'IRREVERSIBLE',
      sideEffects: ['fiches proches déclarées distinctes par l’utilisateur : décision conservée, jamais reproposée'],
      successEvent: 'SUPPLIER_CHANGED', retrySafety: 'PLAN_TAKEN_ONCE',
    },
  },
  UPDATE_SUPPLIER: {
    type: 'UPDATE_SUPPLIER', label: 'Modifier un fournisseur',
    service: 'supplier-write.facade.updateSupplierForAccount', requiresWriteAccess: true,
    spec: {
      capabilityCode: 'SUPPLIER_UPDATE', targetKind: 'supplier',
      requiredFields: ['supplierId', 'patch', 'expectedVersion'], optionalFields: [],
      readBeforeWrite: true, deletePolicy: 'NONE', undoPolicy: 'IRREVERSIBLE',
      sideEffects: ['valeur saisie ou effacée protégée des documents (décision de l’utilisateur par champ)'],
      successEvent: 'SUPPLIER_CHANGED', retrySafety: 'PLAN_TAKEN_ONCE',
    },
  },
  CREATE_WEB_DOCUMENT: {
    type: 'CREATE_WEB_DOCUMENT', label: 'Ajouter un lien web',
    service: 'document-write.facade.createWebDocumentForAccount', requiresWriteAccess: true,
    spec: {
      capabilityCode: 'DOCUMENT_WEB_CREATE', targetKind: 'document',
      requiredFields: ['url', 'title'], optionalFields: ['assetId'],
      readBeforeWrite: true, deletePolicy: 'NONE', undoPolicy: 'IRREVERSIBLE',
      sideEffects: ['le lien est enregistré tel quel : aucune page web n’est lue'],
      successEvent: 'DOCUMENT_UPLOADED', retrySafety: 'PLAN_TAKEN_ONCE',
    },
  },
  UPDATE_DOCUMENT: {
    type: 'UPDATE_DOCUMENT', label: 'Modifier un document',
    service: 'document-write.facade.updateDocumentForAccount', requiresWriteAccess: true,
    spec: {
      capabilityCode: 'DOCUMENT_UPDATE', targetKind: 'document',
      requiredFields: ['documentId', 'field', 'expectedVersion'], optionalFields: ['value'],
      readBeforeWrite: true, deletePolicy: 'NONE', undoPolicy: 'IRREVERSIBLE',
      sideEffects: ['titre, date ou note de l’utilisateur : jamais remplacés par une analyse', 'nouvelle analyse du document si son titre ou sa date change'],
      successEvent: 'DOCUMENT_UPDATED', retrySafety: 'PLAN_TAKEN_ONCE',
    },
  },
  DELETE_DOCUMENT: {
    type: 'DELETE_DOCUMENT', label: 'Supprimer un document',
    service: 'document-write.facade.softDeleteDocument', requiresWriteAccess: true,
    spec: {
      capabilityCode: 'DOCUMENT_DELETE', targetKind: 'document',
      requiredFields: ['documentId', 'expectedVersion'], optionalFields: [],
      readBeforeWrite: true, deletePolicy: 'SOFT_DELETE', undoPolicy: 'IRREVERSIBLE',
      sideEffects: ['informations que ce document justifiait retirées des fiches concernées, qui sont recalculées'],
      successEvent: 'DOCUMENT_DELETED', retrySafety: 'PLAN_TAKEN_ONCE',
    },
  },
  // Passage 114AB (Trello #753, CDC T2 §14.3 W12) — NATURE d'un document : Rubrique et Type du référentiel V2.
  UPDATE_DOCUMENT_CLASSIFICATION: {
    type: 'UPDATE_DOCUMENT_CLASSIFICATION', label: 'Modifier la nature d’un document',
    service: 'document-write.facade.updateDocumentClassificationForAccount', requiresWriteAccess: true,
    spec: {
      capabilityCode: 'DOCUMENT_UPDATE', targetKind: 'document',
      requiredFields: ['documentId', 'classificationLevel', 'expectedRubric', 'expectedType', 'expectedVersion'],
      optionalFields: ['rubricValue', 'typeValue'],
      readBeforeWrite: true, deletePolicy: 'NONE', undoPolicy: 'IRREVERSIBLE',
      sideEffects: [
        'classement décidé par l’utilisateur : jamais remplacé par une analyse',
        'la rubrique est déduite du type quand il en impose une ; un type qui ne relève plus de la rubrique est vidé',
        'cartes « À traiter » du classement fermées, données documentaires du document réévaluées',
      ],
      successEvent: 'DOCUMENT_UPDATED', retrySafety: 'PLAN_TAKEN_ONCE',
    },
  },
  // Passage 114AB (Trello #753, CDC T2 §14.3 W14) — suppression de PLUSIEURS documents : tout ou rien.
  DELETE_DOCUMENTS: {
    type: 'DELETE_DOCUMENTS', label: 'Supprimer plusieurs documents',
    service: 'document-write.facade.softDeleteDocument', requiresWriteAccess: true,
    spec: {
      capabilityCode: 'DOCUMENT_DELETE', targetKind: 'document',
      requiredFields: ['documents'], optionalFields: [],
      readBeforeWrite: true, deletePolicy: 'SOFT_DELETE', undoPolicy: 'IRREVERSIBLE',
      sideEffects: [
        'liste complète annoncée avant la confirmation',
        'tout ou rien : un seul document modifié ou disparu depuis l’aperçu et AUCUN n’est supprimé',
        'informations que ces documents justifiaient retirées des fiches concernées, qui sont recalculées',
      ],
      successEvent: 'DOCUMENT_DELETED', retrySafety: 'PLAN_TAKEN_ONCE',
    },
  },
  // Lot 114 (Trello #753, CDC T2 §14.3 W04 – W09) — pièces et équipements d'un bien.
  CREATE_ROOM: {
    type: 'CREATE_ROOM', label: 'Créer une pièce',
    service: 'structure-write.facade.createRoomForAccount', requiresWriteAccess: true,
    spec: {
      capabilityCode: 'ROOM_CREATE', targetKind: 'room', requiredFields: ['assetId', 'name'], optionalFields: [],
      readBeforeWrite: true, deletePolicy: 'NONE', undoPolicy: 'IRREVERSIBLE',
      sideEffects: ['réservé aux biens qui ont des pièces et aux offres Premium', 'événements de référence du bien réexaminés'],
      successEvent: 'ASSET_UPDATED', retrySafety: 'PLAN_TAKEN_ONCE',
    },
  },
  RENAME_ROOM: {
    type: 'RENAME_ROOM', label: 'Renommer une pièce',
    service: 'structure-write.facade.renameRoomForAccount', requiresWriteAccess: true,
    spec: {
      capabilityCode: 'ROOM_UPDATE', targetKind: 'room', requiredFields: ['roomId', 'name', 'expectedVersion'], optionalFields: [],
      readBeforeWrite: true, deletePolicy: 'NONE', undoPolicy: 'IRREVERSIBLE', sideEffects: [],
      successEvent: 'ASSET_UPDATED', retrySafety: 'PLAN_TAKEN_ONCE',
    },
  },
  DELETE_ROOM: {
    type: 'DELETE_ROOM', label: 'Supprimer une pièce',
    service: 'structure-write.facade.deleteRoomForAccount', requiresWriteAccess: true,
    spec: {
      capabilityCode: 'ROOM_DELETE', targetKind: 'room', requiredFields: ['roomId', 'expectedVersion'], optionalFields: [],
      readBeforeWrite: true, deletePolicy: 'HARD_DELETE_DETACHING_CONTENT', undoPolicy: 'IRREVERSIBLE',
      sideEffects: ['documents et équipements de la pièce conservés dans le bien, sans pièce', 'liens des échéances vers la pièce retirés'],
      successEvent: 'ASSET_UPDATED', retrySafety: 'PLAN_TAKEN_ONCE',
    },
  },
  CREATE_EQUIPMENT: {
    type: 'CREATE_EQUIPMENT', label: 'Créer un équipement',
    service: 'structure-write.facade.createEquipmentForAccount', requiresWriteAccess: true,
    spec: {
      capabilityCode: 'EQUIPMENT_CREATE', targetKind: 'equipment', requiredFields: ['assetId', 'name'], optionalFields: ['roomId'],
      readBeforeWrite: true, deletePolicy: 'NONE', undoPolicy: 'IRREVERSIBLE',
      sideEffects: ['réservé aux biens qui ont des équipements et aux offres Premium', 'rapprochement des documents, échéances et fournisseurs de l’équipement'],
      successEvent: 'ASSET_UPDATED', retrySafety: 'PLAN_TAKEN_ONCE',
    },
  },
  RENAME_EQUIPMENT: {
    type: 'RENAME_EQUIPMENT', label: 'Renommer un équipement',
    service: 'structure-write.facade.updateEquipmentForAccount', requiresWriteAccess: true,
    spec: {
      capabilityCode: 'EQUIPMENT_UPDATE', targetKind: 'equipment', requiredFields: ['equipmentId', 'name', 'expectedVersion'], optionalFields: [],
      readBeforeWrite: true, deletePolicy: 'NONE', undoPolicy: 'IRREVERSIBLE',
      sideEffects: ['rapprochement des documents de l’équipement relancé sous son nouveau nom'],
      successEvent: 'ASSET_UPDATED', retrySafety: 'PLAN_TAKEN_ONCE',
    },
  },
  ARCHIVE_EQUIPMENT: {
    type: 'ARCHIVE_EQUIPMENT', label: 'Retirer un équipement',
    service: 'structure-write.facade.archiveEquipmentForAccount', requiresWriteAccess: true,
    spec: {
      capabilityCode: 'EQUIPMENT_ARCHIVE', targetKind: 'equipment', requiredFields: ['equipmentId', 'expectedVersion'], optionalFields: [],
      readBeforeWrite: true, deletePolicy: 'ARCHIVE_KEEPING_LINKS', undoPolicy: 'IRREVERSIBLE',
      sideEffects: ['documents, échéances et historique de l’équipement conservés'],
      successEvent: 'ASSET_UPDATED', retrySafety: 'PLAN_TAKEN_ONCE',
    },
  },
  // Lot 114F (Trello #753, CDC T2 §14.3 W02, W27, W13).
  RENAME_ASSET: {
    type: 'RENAME_ASSET', label: 'Renommer un bien',
    service: 'asset-details-write.service.updateAssetDetails', requiresWriteAccess: true,
    spec: {
      capabilityCode: 'ASSET_UPDATE', targetKind: 'asset', requiredFields: ['renamedAssetId', 'assetNewName', 'expectedName'], optionalFields: [],
      readBeforeWrite: true, deletePolicy: 'NONE', undoPolicy: 'IRREVERSIBLE',
      sideEffects: ['le nouveau nom apparaît partout où le bien est cité (fiche, documents, Agenda, exports)'],
      successEvent: 'ASSET_UPDATED', retrySafety: 'PLAN_TAKEN_ONCE',
    },
  },
  CLEAR_ASSET_FIELD: {
    type: 'CLEAR_ASSET_FIELD', label: 'Effacer une caractéristique d’un bien',
    service: 'asset-details-write.service.updateAssetDetails', requiresWriteAccess: true,
    spec: {
      capabilityCode: 'ASSET_FIELD_CLEAR', targetKind: 'asset', requiredFields: ['clearAssetId', 'clearSection', 'clearedField', 'clearedPrevious'], optionalFields: [],
      readBeforeWrite: true, deletePolicy: 'NONE', undoPolicy: 'REVERSIBLE_15_MIN',
      sideEffects: ['effacement volontaire de l’utilisateur (origine USER) : la valeur n’est pas réécrite par une analyse', 'cohérence du compte recontrôlée si le champ y participe'],
      successEvent: 'ASSET_UPDATED', retrySafety: 'PLAN_TAKEN_ONCE',
    },
  },
  // Passage 114AA (Trello #753, CDC T2 §14.3 W02) — catégorie de bien et statut.
  UPDATE_ASSET_CATEGORY: {
    type: 'UPDATE_ASSET_CATEGORY', label: 'Modifier la catégorie d’un bien',
    service: 'asset-details-write.service.updateAssetDetails', requiresWriteAccess: true,
    spec: {
      capabilityCode: 'ASSET_UPDATE', targetKind: 'asset', requiredFields: ['classifiedAssetId', 'categoryValue', 'expectedCategory'], optionalFields: [],
      readBeforeWrite: true, deletePolicy: 'NONE', undoPolicy: 'IRREVERSIBLE',
      sideEffects: ['la catégorie oriente les rubriques de la fiche, les natures de documents attendues et les exports'],
      successEvent: 'ASSET_UPDATED', retrySafety: 'PLAN_TAKEN_ONCE',
    },
  },
  UPDATE_ASSET_STATUS: {
    type: 'UPDATE_ASSET_STATUS', label: 'Modifier le statut d’un bien',
    service: 'asset-details-write.service.updateAssetDetails', requiresWriteAccess: true,
    spec: {
      capabilityCode: 'ASSET_UPDATE', targetKind: 'asset', requiredFields: ['classifiedAssetId', 'statusValue', 'expectedStatus'], optionalFields: [],
      readBeforeWrite: true, deletePolicy: 'NONE', undoPolicy: 'IRREVERSIBLE',
      sideEffects: ['un bien vendu ou transmis sort du portefeuille actif : il n’apparaît plus dans les listes et les compteurs par défaut', 'ses documents, ses échéances et son historique sont conservés'],
      successEvent: 'ASSET_UPDATED', retrySafety: 'PLAN_TAKEN_ONCE',
    },
  },
  UPDATE_DOCUMENT_TARGETS: {
    type: 'UPDATE_DOCUMENT_TARGETS', label: 'Rattacher un document',
    service: 'document-write.facade.updateDocumentForAccount', requiresWriteAccess: true,
    spec: {
      capabilityCode: 'DOCUMENT_LINK', targetKind: 'document', requiredFields: ['documentId', 'targetAssetIds', 'expectedAssetIds', 'expectedVersion'],
      // Passage 114AA : niveau pièce ou équipement (W13 complété).
      optionalFields: ['level', 'targetStructureIds', 'expectedStructureIds'],
      readBeforeWrite: true, deletePolicy: 'NONE', undoPolicy: 'IRREVERSIBLE',
      sideEffects: ['rattachement décidé par l’utilisateur : jamais défait par une analyse', 'le document reste dans vos documents ; un retrait est une dissociation, jamais une suppression', 'fiches des biens concernés et « À traiter » mis à jour'],
      successEvent: 'DOCUMENT_UPDATED', retrySafety: 'PLAN_TAKEN_ONCE',
    },
  },
  // Lot 114X (Trello #753, CDC T2 §14.3 W21 – W26, §14.4 « Opérations », X69 – X73) — événements de référence.
  CREATE_REFERENCE_EVENT: {
    type: 'CREATE_REFERENCE_EVENT', label: 'Enregistrer un événement de référence',
    service: 'operation-write.facade.createOperation', requiresWriteAccess: true,
    spec: {
      capabilityCode: 'REFERENCE_EVENT_CREATE', targetKind: 'reference_event',
      requiredFields: ['declaration', 'typeCode', 'status'], optionalFields: ['label', 'attributes', 'assetIds', 'distinctFrom'],
      readBeforeWrite: true, deletePolicy: 'NONE', undoPolicy: 'IRREVERSIBLE',
      sideEffects: ['déclaration de l’utilisateur enregistrée comme source durable', 'aucun document, aucune échéance, aucun montant créé', 'même déclaration rejouée : rien n’est créé en double'],
      successEvent: 'BUSINESS_OPERATION_CREATED', retrySafety: 'PLAN_TAKEN_ONCE_AND_IDEMPOTENCY_KEY',
    },
  },
  UPDATE_REFERENCE_EVENT: {
    type: 'UPDATE_REFERENCE_EVENT', label: 'Corriger un événement de référence',
    service: 'operation-write.facade.updateOperation', requiresWriteAccess: true,
    spec: {
      capabilityCode: 'REFERENCE_EVENT_UPDATE', targetKind: 'reference_event',
      requiredFields: ['operationId', 'declaration', 'patch', 'expectedVersion'], optionalFields: [],
      readBeforeWrite: true, deletePolicy: 'NONE', undoPolicy: 'IRREVERSIBLE',
      sideEffects: ['correction enregistrée comme déclaration de l’utilisateur : dates et prestataire ne sont plus réécrits par une analyse'],
      successEvent: 'BUSINESS_OPERATION_UPDATED', retrySafety: 'PLAN_TAKEN_ONCE_AND_IDEMPOTENCY_KEY',
    },
  },
  INVALIDATE_REFERENCE_EVENT: {
    type: 'INVALIDATE_REFERENCE_EVENT', label: 'Supprimer un événement de référence',
    service: 'operation-write.facade.invalidateOperation', requiresWriteAccess: true,
    spec: {
      capabilityCode: 'REFERENCE_EVENT_INVALIDATE', targetKind: 'reference_event',
      requiredFields: ['operationId', 'expectedVersion'], optionalFields: [],
      readBeforeWrite: true, deletePolicy: 'LOGICAL_INVALIDATION', undoPolicy: 'IRREVERSIBLE',
      sideEffects: ['documents, échéances (détachées, conservées à leur date), fournisseurs et montants conservés', 'une analyse ne réactive pas l’événement retiré par l’utilisateur'],
      successEvent: 'BUSINESS_OPERATION_INVALIDATED', retrySafety: 'PLAN_TAKEN_ONCE_AND_IDEMPOTENCY_KEY',
    },
  },
  ASSOCIATE_REFERENCE_EVENTS: {
    type: 'ASSOCIATE_REFERENCE_EVENTS', label: 'Associer deux événements de référence',
    service: 'operation-write.facade.associateOperations', requiresWriteAccess: true,
    spec: {
      capabilityCode: 'REFERENCE_EVENTS_ASSOCIATE', targetKind: 'reference_event',
      requiredFields: ['fromOperationId', 'toOperationId', 'nature', 'expectedVersions'], optionalFields: [],
      readBeforeWrite: true, deletePolicy: 'NONE', undoPolicy: 'IRREVERSIBLE',
      sideEffects: ['les deux événements restent distincts : aucune fusion', 'aucun document déplacé, aucun montant, aucune date, aucune échéance créés'],
      successEvent: 'GRAPH_HISTORY_ONLY', retrySafety: 'PLAN_TAKEN_ONCE_AND_IDEMPOTENCY_KEY',
    },
  },
  LINK_DOCUMENT_REFERENCE_EVENT: {
    type: 'LINK_DOCUMENT_REFERENCE_EVENT', label: 'Rattacher un document à un événement de référence',
    service: 'operation-write.facade.linkDocument', requiresWriteAccess: true,
    spec: {
      capabilityCode: 'REFERENCE_EVENT_DOCUMENT_LINK', targetKind: 'reference_event',
      requiredFields: ['operationId', 'documentId', 'expectedVersion', 'documentVersion'], optionalFields: [],
      readBeforeWrite: true, deletePolicy: 'NONE', undoPolicy: 'IRREVERSIBLE',
      sideEffects: ['rattachement décidé par l’utilisateur', 'le document reste dans les documents du compte et garde ses autres rattachements'],
      successEvent: 'GRAPH_HISTORY_ONLY', retrySafety: 'PLAN_TAKEN_ONCE_AND_IDEMPOTENCY_KEY',
    },
  },
  LINK_SUPPLIER_REFERENCE_EVENT: {
    type: 'LINK_SUPPLIER_REFERENCE_EVENT', label: 'Relier un fournisseur à un événement de référence',
    service: 'operation-write.facade.linkSupplier', requiresWriteAccess: true,
    spec: {
      capabilityCode: 'REFERENCE_EVENT_SUPPLIER_LINK', targetKind: 'reference_event',
      requiredFields: ['operationId', 'supplierId', 'role', 'expectedVersion', 'supplierVersion'], optionalFields: [],
      readBeforeWrite: true, deletePolicy: 'NONE', undoPolicy: 'IRREVERSIBLE',
      sideEffects: ['lien décidé par l’utilisateur : jamais modifié par une analyse', 'aucun document, aucun coût, aucune échéance créés'],
      successEvent: 'GRAPH_HISTORY_ONLY', retrySafety: 'PLAN_TAKEN_ONCE_AND_IDEMPOTENCY_KEY',
    },
  },
  // Passage 114AB (Trello #753) — GESTES INVERSES des événements de référence, par la façade de la carte #744.
  RESTORE_REFERENCE_EVENT: {
    type: 'RESTORE_REFERENCE_EVENT', label: 'Rétablir un événement de référence',
    service: 'operation-write.facade.restoreOperation', requiresWriteAccess: true,
    spec: {
      capabilityCode: 'REFERENCE_EVENT_RESTORE', targetKind: 'reference_event',
      requiredFields: ['operationId', 'expectedVersion'], optionalFields: [],
      readBeforeWrite: true, deletePolicy: 'NONE', undoPolicy: 'IRREVERSIBLE',
      sideEffects: [
        'seules les suppressions faites par l’utilisateur sont rétablissables',
        'ses échéances détachées à la suppression ne lui sont pas rattachées de nouveau',
      ],
      successEvent: 'BUSINESS_OPERATION_UPDATED', retrySafety: 'PLAN_TAKEN_ONCE_AND_IDEMPOTENCY_KEY',
    },
  },
  DISSOCIATE_REFERENCE_EVENTS: {
    type: 'DISSOCIATE_REFERENCE_EVENTS', label: 'Dissocier deux événements de référence',
    service: 'operation-write.facade.dissociateOperations', requiresWriteAccess: true,
    spec: {
      capabilityCode: 'REFERENCE_EVENTS_DISSOCIATE', targetKind: 'reference_event',
      requiredFields: ['fromOperationId', 'toOperationId', 'expectedVersions'], optionalFields: [],
      readBeforeWrite: true, deletePolicy: 'NONE', undoPolicy: 'IRREVERSIBLE',
      sideEffects: ['seul le lien est retiré : les deux événements restent, avec leurs documents et leurs fournisseurs', 'retrait décidé par l’utilisateur : une analyse ne les associe plus d’elle-même'],
      successEvent: 'GRAPH_HISTORY_ONLY', retrySafety: 'PLAN_TAKEN_ONCE_AND_IDEMPOTENCY_KEY',
    },
  },
  UNLINK_DOCUMENT_REFERENCE_EVENT: {
    type: 'UNLINK_DOCUMENT_REFERENCE_EVENT', label: 'Retirer un document d’un événement de référence',
    service: 'operation-write.facade.unlinkDocument', requiresWriteAccess: true,
    spec: {
      capabilityCode: 'REFERENCE_EVENT_DOCUMENT_UNLINK', targetKind: 'reference_event',
      requiredFields: ['operationId', 'documentId', 'expectedVersion', 'documentVersion'], optionalFields: [],
      readBeforeWrite: true, deletePolicy: 'NONE', undoPolicy: 'IRREVERSIBLE',
      sideEffects: ['le document reste dans le compte et garde ses autres rattachements', 'montants de l’événement recalculés par la consolidation'],
      successEvent: 'GRAPH_HISTORY_ONLY', retrySafety: 'PLAN_TAKEN_ONCE_AND_IDEMPOTENCY_KEY',
    },
  },
  UNLINK_SUPPLIER_REFERENCE_EVENT: {
    type: 'UNLINK_SUPPLIER_REFERENCE_EVENT', label: 'Retirer un fournisseur d’un événement de référence',
    service: 'operation-write.facade.unlinkSupplier', requiresWriteAccess: true,
    spec: {
      capabilityCode: 'REFERENCE_EVENT_SUPPLIER_UNLINK', targetKind: 'reference_event',
      requiredFields: ['operationId', 'supplierId', 'expectedVersion', 'supplierVersion'], optionalFields: [],
      readBeforeWrite: true, deletePolicy: 'NONE', undoPolicy: 'IRREVERSIBLE',
      sideEffects: ['la fiche du fournisseur, ses documents et ses autres liens sont conservés', 'retrait décidé par l’utilisateur : jamais rétabli par une analyse'],
      successEvent: 'GRAPH_HISTORY_ONLY', retrySafety: 'PLAN_TAKEN_ONCE_AND_IDEMPOTENCY_KEY',
    },
  },
  LINK_AGENDA_REFERENCE_EVENT: {
    type: 'LINK_AGENDA_REFERENCE_EVENT', label: 'Rattacher une échéance à un événement de référence',
    service: 'operation-write.facade.linkAgendaItem', requiresWriteAccess: true,
    spec: {
      capabilityCode: 'REFERENCE_EVENT_AGENDA_LINK', targetKind: 'reference_event',
      requiredFields: ['operationId', 'agendaItemId', 'expectedVersion', 'agendaItemVersion'], optionalFields: [],
      readBeforeWrite: true, deletePolicy: 'NONE', undoPolicy: 'IRREVERSIBLE',
      sideEffects: ['l’échéance garde son identité, sa date et ses rappels : aucune échéance créée ni copiée', 'une échéance déjà rattachée ailleurs est partagée, jamais déplacée'],
      successEvent: 'GRAPH_HISTORY_ONLY', retrySafety: 'PLAN_TAKEN_ONCE_AND_IDEMPOTENCY_KEY',
    },
  },
  ARCHIVE_SUPPLIER: {
    type: 'ARCHIVE_SUPPLIER', label: 'Archiver un fournisseur',
    service: 'supplier-write.facade.setSupplierArchived', requiresWriteAccess: true,
    spec: {
      capabilityCode: 'SUPPLIER_ARCHIVE', targetKind: 'supplier',
      requiredFields: ['supplierId', 'expectedVersion'], optionalFields: [],
      readBeforeWrite: true, deletePolicy: 'ARCHIVE_KEEPING_LINKS', undoPolicy: 'IRREVERSIBLE',
      sideEffects: ['documents, biens, équipements et échéances liés conservés', 'fiche consultable et réactivable depuis les fournisseurs'],
      successEvent: 'SUPPLIER_CHANGED', retrySafety: 'PLAN_TAKEN_ONCE',
    },
  },
};

/** Lot 114 (Trello #753, CDC T2 §14.3 W10, W12, W14) — documents : champs modifiables depuis l'Assistant. */
export const DOCUMENT_COMMAND_FIELDS = ['title', 'date', 'notes'] as const;
export type DocumentCommandField = (typeof DOCUMENT_COMMAND_FIELDS)[number];

/** Champs d'une fiche fournisseur modifiables depuis l'Assistant (jamais les coordonnées bancaires). */
export const SUPPLIER_COMMAND_FIELDS = ['name', 'phone', 'email', 'website'] as const;
export type SupplierCommandField = (typeof SUPPLIER_COMMAND_FIELDS)[number];

/** Paramètres figés d'une action préparée. */
export type CommandParams =
  // CREATE_AGENDA_ITEM — lot 114B (#753, W15) : `startDate: null` = sans date — annoncée « À prévoir » (lot 114V, #742 : situation par défaut) ;
  // `noDeadline: true` = option « Sans échéance » explicitement demandée. Les deux ne se confondent pas.
  | { title: string; startDate: string | null; assetIds: number[]; noDeadline?: boolean }
  | {                                                                   // UPDATE_ASSET_FIELD
      assetId: number; section: string; field: string;
      value: string | number;
      /** Valeur présentée comme « ancienne » : l'exécution refuse si elle a changé depuis. */
      previous: unknown;
    }
  // UPDATE_AGENDA_ITEM (W16) : seuls le titre et la date sont modifiables depuis l'Assistant.
  | { kind: 'agenda_update'; agendaItemId: number; patch: { title?: string; startDate?: string | null }; expectedVersion: string }
  // DELETE_AGENDA_ITEM (W17) : portée figée à la préparation — une série n'est pas une occurrence.
  | { kind: 'agenda_delete'; agendaItemId: number; scope: 'OCCURRENCE' | 'SERIES'; expectedVersion: string; expectedCount: number }
  // CREATE_ASSET (W01) : famille et catégorie du référentiel des biens, nom donné par l'utilisateur.
  | { kind: 'asset_create'; category: string; subtype: string | null; objectCategory: string | null; name: string }
  // DELETE_ASSET (W03) : le décompte présenté est figé — s'il change, rien n'est supprimé.
  | { kind: 'asset_delete'; assetId: number; expectedSummary: Record<string, number> }
  // CREATE_SUPPLIER (W18) : `distinctFrom` = fiches proches que la confirmation déclare distinctes.
  | { kind: 'supplier_create'; name: string; phone: string | null; email: string | null; website: string | null; distinctFrom: number[] }
  // UPDATE_SUPPLIER (W19) : `null` = effacement volontaire du champ (protégé des documents).
  | { kind: 'supplier_update'; supplierId: number; patch: Partial<Record<SupplierCommandField, string | null>>; expectedVersion: string }
  // ARCHIVE_SUPPLIER (W20) : archivage — aucune suppression physique.
  | { kind: 'supplier_archive'; supplierId: number; expectedVersion: string }
  // CREATE_WEB_DOCUMENT (W10) : lien http(s) et titre obligatoires, bien facultatif.
  | { kind: 'document_web_create'; url: string; linkTitle: string; linkAssetId: number | null }
  // UPDATE_DOCUMENT (W12) : un champ à la fois ; `null` = effacement (date ou note).
  | { kind: 'document_update'; documentId: number; documentField: DocumentCommandField; newValue: string | null; expectedVersion: string }
  // DELETE_DOCUMENT (W14) : suppression logique du document, comme depuis la liste des documents.
  | { kind: 'document_delete'; documentId: number; expectedVersion: string }
  /**
   * UPDATE_DOCUMENT_CLASSIFICATION (W12, passage 114AB) : NATURE d'un document — une Rubrique
   * (`rubricValue`) OU un Type (`typeValue`) du référentiel V2, jamais un libellé libre. `expectedRubric`
   * et `expectedType` sont l'état présenté à l'aperçu : la façade refuse d'écrire s'il a changé.
   */
  | {
      kind: 'document_classification'; documentId: number; classificationLevel: 'rubric' | 'type';
      rubricValue?: string; typeValue?: string;
      expectedRubric: string | null; expectedType: string | null; expectedVersion: string;
    }
  /**
   * DELETE_DOCUMENTS (W14, passage 114AB) : liste FIGÉE des documents annoncés, avec l'empreinte de chacun.
   * Tout ou rien — un seul écart et aucun n'est supprimé.
   */
  | { kind: 'documents_delete'; documents: Array<{ documentId: number; expectedVersion: string; title: string }> }
  // Pièces (W07 – W09) et équipements (W04 – W06) d'un bien.
  | { kind: 'room_create'; roomAssetId: number; roomName: string }
  | { kind: 'room_rename'; roomId: number; roomAssetId: number; roomName: string; expectedVersion: string }
  | { kind: 'room_delete'; roomId: number; roomAssetId: number; expectedVersion: string }
  | { kind: 'equipment_create'; equipmentAssetId: number; equipmentName: string; equipmentRoomId: number | null }
  | { kind: 'equipment_rename'; equipmentId: number; equipmentAssetId: number; equipmentName: string; expectedVersion: string }
  | { kind: 'equipment_archive'; equipmentId: number; equipmentAssetId: number; expectedVersion: string }
  // RENAME_ASSET (W02) : le nom présenté comme « ancien » est figé — s'il a changé, rien n'est écrit.
  | { kind: 'asset_rename'; renamedAssetId: number; assetNewName: string; expectedName: string }
  // CLEAR_ASSET_FIELD (W27) : la valeur présentée comme « actuelle » est figée — si elle a changé, rien n'est effacé.
  | { kind: 'asset_field_clear'; clearAssetId: number; clearSection: string; clearedField: string; clearedPrevious: unknown }
  /**
   * UPDATE_ASSET_CATEGORY (W02, passage 114AA) : catégorie du RÉFÉRENTIEL (`lib/asset-taxonomy`), jamais un
   * libellé libre. La catégorie présentée comme « actuelle » est figée — si elle a changé, rien n'est écrit.
   */
  | {
      kind: 'asset_category'; classifiedAssetId: number; categoryValue: string; expectedCategory: string | null;
      /**
       * Passage 114AB (W02) : `true` pour un bien de la famille OBJET — sa catégorie est le champ CANONIQUE
       * `objectCategory` de sa fiche (section « Identification »), et non la colonne d'identité `subtype`.
       */
      objectCategory?: true;
    }
  /** UPDATE_ASSET_STATUS (W02, passage 114AA) : statut du référentiel (`lib/asset-status`), archivage exclu. */
  | { kind: 'asset_status'; classifiedAssetId: number; statusValue: string; expectedStatus: string }
  // UPDATE_DOCUMENT_TARGETS (W13) : liste COMPLÈTE des cibles après l'action, et liste présentée à l'aperçu.
  // Passage 114AA : `level` dit quel niveau change (bien, pièce ou équipement) ; les deux autres sont laissés
  // intacts par la façade (un niveau absent du corps garde sa sélection).
  | {
      kind: 'document_targets'; documentId: number; targetAssetIds: number[]; expectedAssetIds: number[]; expectedVersion: string;
      level?: 'asset' | 'room' | 'equipment';
      /** Pièces ou équipements après l'action, et ceux présentés à l'aperçu (vides pour le niveau « bien »). */
      targetStructureIds?: number[]; expectedStructureIds?: number[];
    }
  // Lot 114X (W21 – W26) : événements de référence — paramètres définis avec leurs commandes (`reference-events.ts`).
  | ReferenceEventParams;

/** Action d'un plan, préparée et figée avant toute confirmation. */
export interface PlannedAction {
  /** Identifiant de l'action dans le plan (« a1 », « a2 »…). */
  actionId: string;
  command: WriteCommandType;
  /** Cible(s), pour l'affichage et la trace. */
  targets: Array<{ type: 'asset' | 'agenda_item' | 'supplier' | 'document' | 'room' | 'equipment' | 'reference_event'; id: number; label: string }>;
  params: CommandParams;
  /** Actions dont celle-ci dépend (exécutée seulement si elles réussissent). */
  dependsOn: string[];
  /** Ce que l'utilisateur voit avant de confirmer. */
  preview: string;
  /** Principales conséquences / valeurs concernées. */
  effects: string[];
}

type ActionOutcome = 'SUCCESS' | 'FAILED' | 'SKIPPED_DEPENDENCY' | 'REFUSED';

export interface ActionResult {
  actionId: string;
  status: ActionOutcome;
  message: string;
  /** Objet créé ou modifié. */
  entity?: { type: 'agenda_item' | 'asset' | 'supplier' | 'document' | 'room' | 'equipment' | 'reference_event'; id: number } | null;
}

export type PlanStatus =
  | 'PENDING_CONFIRMATION' | 'EXECUTING' | 'EXECUTED' | 'PARTIAL' | 'FAILED'
  | 'CANCELLED' | 'EXPIRED' | 'REFUSED'
  /** Exécuté puis annulé par l'utilisateur dans la fenêtre prévue (undo.service). */
  | 'UNDONE';

/** Ce que le client reçoit : jamais les paramètres modifiables, seulement l'aperçu. */
export interface CommandPlanPreview {
  planId: string;
  summary: string;
  actions: Array<{ actionId: string; label: string; preview: string; effects: string[]; dependsOn: string[] }>;
  expiresAt: string;
}
