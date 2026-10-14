/**
 * Qualification des risques par catégorie de relation intercomptes — lot 53
 * (retour PO D23 : « fournir l'inventaire, la qualification des risques, le
 * traitement prévu pour chaque catégorie de liaison et les preuves
 * d'absence d'accès non autorisé après correction »).
 *
 * PUR (aucun import serveur) : lu par BO › Exploitation › Relations
 * intercomptes et par la documentation d'exploitation. Pour chaque catégorie
 * (`CROSS_ACCOUNT_CHECKS.code`) :
 *
 *   · `channels` : ce que la relation PERMETTRAIT sans garde (lecture,
 *     écriture, fuite par l'assistant, les exports, la mascotte, les
 *     miniatures…) et la garde qui le NEUTRALISE (fichier) ;
 *   · `treatment` : la correction contrôlée appliquée depuis le BO ;
 *   · `duo` : la catégorie peut provenir d'un déplacement de bien Duo
 *     (lot 40) — ces lignes sont signalées, jamais corrigées (D3 ouvert) ;
 *   · `proofs` : tests qui prouvent la neutralisation et la correction.
 *
 * Test de cohérence : chaque code du contrôle a sa qualification
 * (`cross-account-remediation.test.ts`, PO-D23-01).
 */

export type AccessChannel =
  | 'lecture' | 'ecriture' | 'assistant' | 'exports' | 'mascotte' | 'miniatures'
  | 'agenda' | 'a_traiter' | 'recherche' | 'ia' | 'suppression';

export const CHANNEL_LABELS: Record<AccessChannel, string> = {
  lecture: 'Lecture (écrans, routes)',
  ecriture: 'Écriture',
  assistant: 'Assistant (T2)',
  exports: 'Exports / dossiers',
  mascotte: 'Mascotte (T6)',
  miniatures: 'Miniatures / fichiers',
  agenda: 'Agenda',
  a_traiter: 'À traiter',
  recherche: 'Recherche',
  ia: 'Traitements IA (T1, T3, T4)',
  suppression: 'Suppression (cascade)',
};

export interface ChannelRisk {
  channel: AccessChannel;
  /** Ce que la relation permettrait sans garde. */
  risk: string;
  /** Garde en place (fichier ou mécanisme). */
  guard: string;
}

export type RiskLevel = 'élevé' | 'moyen' | 'faible';

export interface CategoryRisk {
  code: string;
  level: RiskLevel;
  /** Résumé pour le BO. */
  summary: string;
  channels: readonly ChannelRisk[];
  treatment: string;
  /** La catégorie peut provenir d'un déplacement de bien Duo (lot 40). */
  duo: boolean;
  proofs: readonly string[];
}

const E2E = 'src/test/e2e/scenarios/l53b-d23-intercomptes.e2e.ts';
const L49 = 'src/test/e2e/scenarios/l49-sec-p0-intercomptes.e2e.ts';

const LECTURE_DOCS: ChannelRisk = {
  channel: 'lecture', risk: 'Nom du bien de l’autre compte affiché à côté du document (listes Documents, accueil, À traiter).',
  guard: 'Jointures bornées au compte du document (api/documents, rubric-query, HomeSummaryService, to-process-query — lot 53).',
};
const SUPPRESSION_DOCS: ChannelRisk = {
  channel: 'suppression', risk: 'Supprimer le bien d’un compte emportait par cascade le document de l’autre compte (et purgeait son fichier).',
  guard: 'Déclencheur assets_detach_foreign_refs (migration 0346) + périmètre de deleteAssetCompletely borné au compte (lot 53).',
};
const IA_DOCS: ChannelRisk = {
  channel: 'ia', risk: 'T1 projetant des faits vers le bien étranger ; T3/T4 mis en file sur un objet étranger.',
  guard: 'knownAssetOfAccount (T1), job-scope (file IA, mise en file et exécution) — lot 49.',
};

export const CATEGORY_RISKS: readonly CategoryRisk[] = [
  {
    code: 'DOC_ASSET', level: 'élevé', duo: true,
    summary: 'Document d’un compte rattaché (colonne asset_id) au bien d’un autre compte.',
    channels: [
      LECTURE_DOCS,
      { channel: 'exports', risk: 'Document de l’autre compte inclus dans le dossier du bien.', guard: 'loadExportSource / documentInAssetsCondition toujours combinés à asset_files.account_id.' },
      { channel: 'assistant', risk: 'Document cité par T2 pour le bien.', guard: 'account-data.repository, listAssetDocuments : asset_files.account_id = compte actif.' },
      { channel: 'miniatures', risk: 'Vignette / URL signée du fichier étranger.', guard: '/api/files/[id]/* : fichier du compte actif seulement (404).' },
      SUPPRESSION_DOCS, IA_DOCS,
    ],
    treatment: 'asset_id remis à NULL : le document reste dans son compte, sans bien.',
    proofs: [`${E2E} PO-D23-03, PO-D23-04, PO-D23-07`, `${L49} AC05`],
  },
  {
    code: 'DOC_LINKED_ASSET', level: 'élevé', duo: true,
    summary: 'Document rattaché comme « bien lié » (linked_asset_id) à un bien d’un autre compte.',
    channels: [LECTURE_DOCS, { channel: 'exports', risk: 'Document inclus dans le dossier du bien lié.', guard: 'Requêtes bornées par asset_files.account_id.' }, SUPPRESSION_DOCS],
    treatment: 'linked_asset_id remis à NULL.',
    proofs: [`${E2E} PO-D23-03, PO-D23-07`],
  },
  {
    code: 'DOC_SUBSTRUCTURE', level: 'moyen', duo: true,
    summary: 'Document rattaché à la pièce d’un bien d’un autre compte.',
    channels: [{ channel: 'lecture', risk: 'Nom de la pièce étrangère affiché.', guard: 'Lectures des pièces jointes au bien porteur du compte (account-ownership).' }, SUPPRESSION_DOCS],
    treatment: 'substructure_id remis à NULL.',
    proofs: [`${E2E} PO-D23-03, PO-D23-07`],
  },
  {
    code: 'DOC_EQUIPMENT', level: 'moyen', duo: true,
    summary: 'Document rattaché à l’équipement d’un bien d’un autre compte.',
    channels: [{ channel: 'lecture', risk: 'Document listé sur l’équipement étranger.', guard: 'api/equipments/[id]/documents : équipement ET document du compte actif (lot 49).' }],
    treatment: 'equipment_id remis à NULL.',
    proofs: [`${E2E} PO-D23-03`, `${L49} AC01`],
  },
  {
    code: 'DOC_ROOM_LEGACY', level: 'faible', duo: true,
    summary: 'Document rattaché à une pièce historique (rooms) d’un autre compte.',
    channels: [{ channel: 'suppression', risk: 'Cascade à la suppression du bien porteur.', guard: 'Déclencheur 0346 (linked_room_id détaché).' }],
    treatment: 'linked_room_id remis à NULL.',
    proofs: [`${E2E} PO-D23-07`],
  },
  {
    code: 'DOC_ASSET_LINK', level: 'élevé', duo: true,
    summary: 'Lien N-N actif document ↔ bien / pièce / équipement entre deux comptes.',
    channels: [
      { channel: 'lecture', risk: 'Document de l’autre compte dans la liste du bien (périmètre 32C).', guard: 'Listes : asset_files.account_id = compte actif en plus du lien.' },
      { channel: 'exports', risk: 'Document dans le dossier du bien.', guard: 'listAssetDocuments : lien ET document du compte.' },
      { channel: 'ia', risk: 'T3 rapprochant à partir du lien.', guard: 'linkDocumentToAsset refuse toute cible étrangère (lot 49).' },
    ],
    treatment: 'Lien passé au statut REMOVED (removed_at posé) ; document et bien inchangés.',
    proofs: [`${E2E} PO-D23-03`, `${L49} AC05`],
  },
  {
    code: 'DOC_SUPPLIER', level: 'moyen', duo: false,
    summary: 'Document lié à la fiche fournisseur d’un autre compte.',
    channels: [
      { channel: 'lecture', risk: 'Documents de l’autre compte sur la fiche fournisseur.', guard: 'supplier-detail.service : document et bien du compte (lot 49).' },
      { channel: 'a_traiter', risk: 'Nom du fournisseur étranger proposé comme valeur du document.', guard: 'document-slots : suppliers.account_id = compte.' },
      { channel: 'ecriture', risk: 'Suppression du fournisseur bloquée par la clé étrangère.', guard: 'Correction (lien retiré).' },
    ],
    treatment: 'Lien document_suppliers supprimé (journalisé, restaurable).',
    proofs: [`${E2E} PO-D23-03, PO-D23-05`],
  },
  {
    code: 'EQUIPMENT_SUPPLIER', level: 'moyen', duo: false,
    summary: 'Équipement lié à la fiche fournisseur d’un autre compte.',
    channels: [
      { channel: 'lecture', risk: 'Coordonnées du fournisseur étranger sur l’équipement.', guard: 'api/equipments/[id]/suppliers : fournisseur du compte (lot 49).' },
      { channel: 'assistant', risk: 'Fournisseur cité par T2.', guard: 'canonical/suppliers : suppliers.account_id = compte.' },
    ],
    treatment: 'Lien equipment_suppliers supprimé (journalisé, restaurable).',
    proofs: [`${E2E} PO-D23-03, PO-D23-05`, `${L49} AC06/AC08`],
  },
  {
    code: 'EQUIPMENT_SUPPLIER_SOURCE', level: 'faible', duo: false,
    summary: 'Lien équipement ↔ fournisseur dont le document source est d’un autre compte.',
    channels: [{ channel: 'ecriture', risk: 'Suppression du document source bloquée (clé étrangère sans cascade).', guard: 'Correction (source retirée).' }],
    treatment: 'source_document_id remis à NULL ; le lien du compte est conservé.',
    proofs: [`${E2E} PO-D23-05`],
  },
  {
    code: 'ASSET_SUPPLIER', level: 'moyen', duo: false,
    summary: 'Bien lié à la fiche fournisseur d’un autre compte.',
    channels: [{ channel: 'lecture', risk: 'Fournisseur étranger dans les fournisseurs du bien.', guard: 'supplier-detail / canonical/suppliers bornés au compte.' }],
    treatment: 'Lien asset_suppliers supprimé (journalisé, restaurable).',
    proofs: [`${E2E} PO-D23-05`],
  },
  {
    code: 'EVENT_DOCUMENT', level: 'élevé', duo: false,
    summary: 'Événement (historique) lié au document d’un autre compte.',
    channels: [
      { channel: 'lecture', risk: 'Document étranger dans les pièces de l’événement.', guard: 'api/events/[eventId]/documents : documents du compte (lot 49).' },
      { channel: 'miniatures', risk: 'Ouverture du fichier étranger.', guard: '/api/files/[id]/* : 404 hors compte.' },
    ],
    treatment: 'Lien event_documents supprimé (journalisé, restaurable).',
    proofs: [`${E2E} PO-D23-03, PO-D23-05`, `${L49} AC06/AC08`],
  },
  {
    code: 'EVENT_TARGET', level: 'moyen', duo: true,
    summary: 'Événement visant un bien, une pièce ou un équipement d’un autre compte.',
    channels: [
      { channel: 'lecture', risk: 'Nom de la cible étrangère.', guard: 'Routes events : cibles du compte (lot 49).' },
      { channel: 'suppression', risk: 'Événement supprimé quand l’autre compte supprime son bien.', guard: 'Déclencheur 0346.' },
    ],
    treatment: 'Colonnes de cible étrangères (seulement elles) remises à NULL.',
    proofs: [`${E2E} PO-D23-05, PO-D23-07`],
  },
  {
    code: 'DEADLINE_TARGET', level: 'moyen', duo: true,
    summary: 'Échéance historique visant un bien, une pièce ou un équipement d’un autre compte.',
    channels: [{ channel: 'suppression', risk: 'Échéance supprimée quand l’autre compte supprime son bien.', guard: 'Déclencheur 0346.' }],
    treatment: 'Colonnes de cible étrangères remises à NULL.',
    proofs: [`${E2E} PO-D23-05`],
  },
  {
    code: 'AGENDA_ASSET', level: 'élevé', duo: true,
    summary: 'Élément d’agenda lié au bien d’un autre compte.',
    channels: [
      { channel: 'agenda', risk: 'Nom du bien étranger sur l’élément.', guard: 'AgendaQueryService : bien porteur du compte de l’élément (lot 49).' },
      { channel: 'assistant', risk: 'Échéance citée par T2 avec le bien étranger.', guard: 'canonical/agenda borné au compte.' },
      { channel: 'mascotte', risk: 'Annonce de la mascotte citant le bien.', guard: 'home/mascot/collector borné au compte.' },
      { channel: 'recherche', risk: 'Élément trouvé par le nom du bien étranger.', guard: 'global-search : a.account_id = ai.account_id.' },
    ],
    treatment: 'Lien agenda_asset_links supprimé (journalisé, restaurable).',
    proofs: [`${E2E} PO-D23-03, PO-D23-05`, `${L49} AC06/AC08`],
  },
  {
    code: 'AGENDA_FILE', level: 'élevé', duo: false,
    summary: 'Élément d’agenda lié au document d’un autre compte.',
    channels: [{ channel: 'agenda', risk: 'Titre du document étranger sur l’élément.', guard: 'AgendaQueryService : document du compte.' }],
    treatment: 'Lien agenda_file_links supprimé.',
    proofs: [`${E2E} PO-D23-03, PO-D23-05`],
  },
  {
    code: 'AGENDA_ROOM', level: 'moyen', duo: false,
    summary: 'Élément d’agenda lié à la pièce d’un autre compte.',
    channels: [{ channel: 'agenda', risk: 'Nom de la pièce étrangère.', guard: 'AgendaQueryService : bien porteur du compte.' }],
    treatment: 'Lien agenda_room_links supprimé.',
    proofs: [`${E2E} PO-D23-05`],
  },
  {
    code: 'AGENDA_EQUIPMENT', level: 'moyen', duo: false,
    summary: 'Élément d’agenda lié à l’équipement d’un autre compte.',
    channels: [{ channel: 'agenda', risk: 'Nom de l’équipement étranger.', guard: 'AgendaQueryService : bien porteur du compte.' }],
    treatment: 'Lien agenda_equipment_links supprimé.',
    proofs: [`${E2E} PO-D23-05`],
  },
  {
    code: 'AGENDA_SOURCE', level: 'moyen', duo: false,
    summary: 'Élément d’agenda dont la trace ou l’origine est un document d’un autre compte.',
    channels: [{ channel: 'agenda', risk: '« Source » renvoyant vers le document étranger.', guard: 'agenda-source-links borné au compte (lot 49).' }],
    treatment: 'Trace agenda_item_sources supprimée ; origin_ref_id remis à NULL.',
    proofs: [`${E2E} PO-D23-05`],
  },
  {
    code: 'EVIDENCE_ASSET', level: 'élevé', duo: true,
    summary: 'Preuve (field_evidence) d’un compte portant sur le bien d’un autre compte.',
    channels: [{ channel: 'ia', risk: 'T3 alimentant la fiche du bien étranger.', guard: 'Projection T1 refusée hors compte (TARGET_NOT_FOUND, lot 49).' }],
    treatment: 'Preuve retirée (lifecycle_status WITHDRAWN), jamais supprimée.',
    proofs: [`${E2E} PO-D23-05`, `${L49} AC05`],
  },
  {
    code: 'EVIDENCE_SOURCE', level: 'élevé', duo: true,
    summary: 'Preuve extraite d’un document d’un autre compte.',
    channels: [{ channel: 'ia', risk: 'Valeur issue du document étranger proposée sur la fiche.', guard: 'Lecteurs filtrés sur lifecycle_status ; correction.' }],
    treatment: 'Preuve retirée (WITHDRAWN).',
    proofs: [`${E2E} PO-D23-05`],
  },
  {
    code: 'FACT_SOURCE', level: 'moyen', duo: false,
    summary: 'Fait extrait (document_facts) d’un document d’un autre compte.',
    channels: [{ channel: 'assistant', risk: 'Fait du document étranger cité par T2.', guard: 'document-knowledge : faits joints au document du compte.' }],
    treatment: 'Fait passé à « superseded ».',
    proofs: [`${E2E} PO-D23-05`],
  },
  {
    code: 'AI_FIELD_UPDATE', level: 'moyen', duo: true,
    summary: '« Ce que j’ai fait » (champ complété par l’analyse) citant le bien d’un autre compte.',
    channels: [{ channel: 'lecture', risk: 'Nom du bien étranger sur l’accueil.', guard: 'HomeSummaryService : bien du compte (lot 53).' }],
    treatment: 'Ligne de journal ai_field_updates supprimée (journalisée, restaurable).',
    proofs: [`${E2E} PO-D23-03, PO-D23-05`],
  },
  {
    code: 'TO_PROCESS_TARGET', level: 'moyen', duo: true,
    summary: 'Carte « À traiter » ouverte visant un objet d’un autre compte.',
    channels: [{ channel: 'a_traiter', risk: 'Carte affichant le contexte de l’objet étranger.', guard: 'to-process-query : contexte lu dans le compte de la carte.' }],
    treatment: 'Carte close (OBSOLETE), restaurable.',
    proofs: [`${E2E} PO-D23-03, PO-D23-05`],
  },
  {
    code: 'AI_JOB_PENDING', level: 'faible', duo: false,
    summary: 'Job IA en attente référençant un objet d’un autre compte.',
    channels: [{ channel: 'ia', risk: 'Écriture T1/T3/T4 sur l’objet étranger.', guard: 'job-scope : refus à l’exécution, jobs anciens et relancés compris (lot 49).' }],
    treatment: 'Job PENDING annulé (CANCELLED), restaurable.',
    proofs: [`${E2E} PO-D23-05`, `${L49} AC05`],
  },
];

export function categoryRisk(code: string): CategoryRisk | null {
  return CATEGORY_RISKS.find((r) => r.code === code) ?? null;
}
