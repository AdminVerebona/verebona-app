/**
 * Contrôle d'exploitation « Relations intercomptes » — lot 49 (ticket SEC-P0,
 * §5 « Rechercher les relations intercomptes déjà présentes », AC06, AC08).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LECTURE SEULE, SANS AUCUNE CORRECTION
 *
 * Recense, par type de relation, les associations qui relient des objets de
 * comptes DIFFÉRENTS (ou un objet à un compte qui n'est pas le sien) :
 * nombre, comptes concernés et identifiants techniques nécessaires à une
 * remise en conformité MAÎTRISÉE (sauvegarde, simulation, validation,
 * exécution journalisée, contrôle après correction — procédure
 * `docs/exploitation/relations-intercomptes.md`). Rien n'est corrigé ni
 * supprimé automatiquement.
 *
 * Exécution : une transaction `READ ONLY` (toute écriture y serait refusée
 * par PostgreSQL), délai par requête borné côté base. Utilisée par :
 *   · BO › Exploitation › « Relations intercomptes » (lecture à la demande) ;
 *   · la tâche planifiée `cross-account-relations-check` (chaque jour), qui
 *     ouvre / consolide une anomalie de Supervision par type non nul et la
 *     résout d'elle-même à 0 (`alerts.ts`).
 *
 * Lot 53 (retour PO D23) : la correction contrôlée (BO › Rattrapages,
 * journalisée, restaurable) est dans `remediation.ts` ; la qualification des
 * risques par catégorie dans `risk-catalog.ts`. Les preuves et données déjà
 * neutralisées (WITHDRAWN, superseded) ne sont plus comptées.
 *
 * Le même SQL figure dans `docs/exploitation/relations-intercomptes.sql`
 * (test de parité : `cross-account-detection.test.ts`).
 *
 * Les relations des Opérations (lots 39-48) ont leur propre contrôle
 * (anomalie dure CROSS_ACCOUNT_LINK du BO Opérations, clés composées) : elles
 * ne sont pas recomptées ici.
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Une ligne d'anomalie : compte de la relation, autre compte, identifiants. */
export interface CrossAccountRow {
  accountId: number | null;
  otherAccountId: number | null;
  ref: string;
}

export interface CrossAccountCheck {
  code: string;
  /** Famille de relation (§5 du ticket). */
  family: 'documents' | 'fournisseurs' | 'evenements' | 'agenda' | 'preuves' | 'a_traiter' | 'jobs' | 'operations';
  label: string;
  /**
   * SELECT rendant `account_id` (compte de la relation ou de l'objet
   * principal), `other_account_id` (compte de l'objet référencé) et `ref`
   * (identifiants techniques, texte).
   */
  sql: string;
}

const ID = (expr: string) => `(CASE WHEN ${expr} ~ '^[0-9]{1,9}$' THEN (${expr})::int END)`;

/**
 * Références d'un job de la file (cible ET contexte, à toute profondeur —
 * lot 54, SEC-05/06) : une ligne par objet référencé (`account_id`, `ref`).
 * Partagé par le contrôle (AI_JOB_PENDING) et la correction contrôlée.
 */
export const AI_JOB_REFS_SQL = (q: string): string => {
  const chemins = (cles: string[]) => cles.map((k) => `SELECT v FROM jsonb_path_query(${q}.payload, 'lax $.**.${k}[*]') v`).join(' UNION ALL ');
  const ids = (cles: string[]) => `(SELECT (x.v #>> '{}')::int FROM (${chemins(cles)}) x WHERE jsonb_typeof(x.v) IN ('number', 'string') AND (x.v #>> '{}') ~ '^[0-9]{1,9}$')`;
  return `SELECT a.account_id, 'assets#' || a.id AS ref FROM assets a
               WHERE a.id = CASE WHEN ${q}.target_type = 'asset' THEN ${ID(`${q}.target_id`)} END
                  OR a.id IN ${ids(['assetId', 'assetIds', 'linkedAssetId', 'liveAssetIds'])}
              UNION ALL
              SELECT f.account_id, 'asset_files#' || f.id FROM asset_files f
               WHERE f.id = CASE WHEN ${q}.target_type IN ('asset_file', 'document') THEN ${ID(`${q}.target_id`)} END
                  OR f.id IN ${ids(['fileId', 'fileIds', 'leadSourceId', 'sourceFileId', 'documentId', 'documentIds', 'assetFileId', 'invoiceFileId'])}
              UNION ALL
              SELECT b.account_id, 'equipments#' || e.id FROM equipments e JOIN assets b ON b.id = e.asset_id
               WHERE e.id = CASE WHEN ${q}.target_type = 'equipment' THEN ${ID(`${q}.target_id`)} END
                  OR e.id IN ${ids(['equipmentId', 'equipmentIds'])}
              UNION ALL
              SELECT b.account_id, 'substructures#' || s.id FROM substructures s JOIN assets b ON b.id = s.asset_id
               WHERE s.id = CASE WHEN ${q}.target_type = 'room' THEN ${ID(`${q}.target_id`)} END
                  OR s.id IN ${ids(['substructureId', 'substructureIds'])}
              UNION ALL
              SELECT i.account_id, 'agenda_items#' || i.id FROM agenda_items i
               WHERE i.id = CASE WHEN ${q}.target_type = 'agenda_item' THEN ${ID(`${q}.target_id`)} END
                  OR i.id IN ${ids(['agendaItemId', 'agendaItemIds'])}
              UNION ALL
              SELECT o.account_id, 'business_operations#' || o.id FROM business_operations o
               WHERE o.id IN ${ids(['operationId', 'operationIds', 'canonicalOperationId', 'businessOperationId', 'parentOperationId', 'mergedIntoOperationId', 'proposedOperationIds'])}
              UNION ALL
              SELECT ${ID(`${q}.target_id`)}, 'cible ' || ${q}.target_type || '#' || ${q}.target_id
               WHERE ${q}.target_type IN ('business_operations', 'business_operations_agenda')`;
};

/** Catalogue des contrôles (ordre d'affichage). */
export const CROSS_ACCOUNT_CHECKS: readonly CrossAccountCheck[] = [
  // ── Documents → biens, pièces, équipements ────────────────────────────────
  {
    code: 'DOC_ASSET', family: 'documents', label: 'Document → bien (colonne asset_id)',
    sql: `SELECT f.account_id, a.account_id AS other_account_id, 'asset_files#' || f.id || ' -> assets#' || a.id AS ref
            FROM asset_files f JOIN assets a ON a.id = f.asset_id
           WHERE a.account_id IS DISTINCT FROM f.account_id`,
  },
  {
    code: 'DOC_LINKED_ASSET', family: 'documents', label: 'Document → bien lié (colonne linked_asset_id)',
    sql: `SELECT f.account_id, a.account_id AS other_account_id, 'asset_files#' || f.id || ' -> assets#' || a.id || ' (linked)' AS ref
            FROM asset_files f JOIN assets a ON a.id = f.linked_asset_id
           WHERE a.account_id IS DISTINCT FROM f.account_id`,
  },
  {
    code: 'DOC_SUBSTRUCTURE', family: 'documents', label: 'Document → pièce',
    sql: `SELECT f.account_id, a.account_id AS other_account_id, 'asset_files#' || f.id || ' -> substructures#' || s.id AS ref
            FROM asset_files f JOIN substructures s ON s.id = f.substructure_id JOIN assets a ON a.id = s.asset_id
           WHERE a.account_id IS DISTINCT FROM f.account_id`,
  },
  {
    code: 'DOC_EQUIPMENT', family: 'documents', label: 'Document → équipement',
    sql: `SELECT f.account_id, a.account_id AS other_account_id, 'asset_files#' || f.id || ' -> equipments#' || e.id AS ref
            FROM asset_files f JOIN equipments e ON e.id = f.equipment_id JOIN assets a ON a.id = e.asset_id
           WHERE a.account_id IS DISTINCT FROM f.account_id`,
  },
  {
    code: 'DOC_ROOM_LEGACY', family: 'documents', label: 'Document → pièce historique (linked_room_id)',
    sql: `SELECT f.account_id, r.account_id AS other_account_id, 'asset_files#' || f.id || ' -> rooms#' || r.id AS ref
            FROM asset_files f JOIN rooms r ON r.id = f.linked_room_id
           WHERE r.account_id IS DISTINCT FROM f.account_id`,
  },
  {
    code: 'DOC_ASSET_LINK', family: 'documents', label: 'Lien N-N document ↔ bien / pièce / équipement (actif)',
    sql: `SELECT l.account_id, coalesce(NULLIF(f.account_id, l.account_id), NULLIF(a.account_id, l.account_id), NULLIF(sa.account_id, l.account_id), NULLIF(ea.account_id, l.account_id)) AS other_account_id,
                 'document_asset_links#' || l.id || ' (asset_files#' || l.file_id || coalesce(', assets#' || l.asset_id, '') || coalesce(', substructures#' || l.substructure_id, '') || coalesce(', equipments#' || l.equipment_id, '') || ')' AS ref
            FROM document_asset_links l
            JOIN asset_files f ON f.id = l.file_id
            LEFT JOIN assets a ON a.id = l.asset_id
            LEFT JOIN substructures s ON s.id = l.substructure_id LEFT JOIN assets sa ON sa.id = s.asset_id
            LEFT JOIN equipments e ON e.id = l.equipment_id LEFT JOIN assets ea ON ea.id = e.asset_id
           WHERE l.status = 'ACTIVE'
             AND (f.account_id <> l.account_id
                  OR (a.id IS NOT NULL AND a.account_id IS DISTINCT FROM l.account_id)
                  OR (sa.id IS NOT NULL AND sa.account_id IS DISTINCT FROM l.account_id)
                  OR (ea.id IS NOT NULL AND ea.account_id IS DISTINCT FROM l.account_id))`,
  },
  {
    // Lot 54 (SEC-06) : photo d'un bien dont le fichier est d'un autre compte.
    code: 'PHOTO_FILE', family: 'documents', label: 'Photo d’un bien → fichier d’un autre compte',
    sql: `SELECT a.account_id, f.account_id AS other_account_id, 'asset_photos#' || p.id || ' (assets#' || a.id || ', asset_files#' || f.id || ')' AS ref
            FROM asset_photos p JOIN assets a ON a.id = p.asset_id JOIN asset_files f ON f.id = p.file_id
           WHERE f.account_id IS DISTINCT FROM a.account_id`,
  },
  // ── Fournisseurs ──────────────────────────────────────────────────────────
  {
    code: 'DOC_SUPPLIER', family: 'fournisseurs', label: 'Document → fournisseur',
    sql: `SELECT f.account_id, s.account_id AS other_account_id, 'document_suppliers(asset_files#' || ds.document_id || ', suppliers#' || ds.supplier_id || ')' AS ref
            FROM document_suppliers ds JOIN asset_files f ON f.id = ds.document_id JOIN suppliers s ON s.id = ds.supplier_id
           WHERE s.account_id <> f.account_id`,
  },
  {
    code: 'EQUIPMENT_SUPPLIER', family: 'fournisseurs', label: 'Équipement → fournisseur',
    sql: `SELECT a.account_id, s.account_id AS other_account_id, 'equipment_suppliers(equipments#' || es.equipment_id || ', suppliers#' || es.supplier_id || ')' AS ref
            FROM equipment_suppliers es JOIN equipments e ON e.id = es.equipment_id JOIN assets a ON a.id = e.asset_id
            JOIN suppliers s ON s.id = es.supplier_id
           WHERE s.account_id IS DISTINCT FROM a.account_id`,
  },
  {
    code: 'EQUIPMENT_SUPPLIER_SOURCE', family: 'fournisseurs', label: 'Équipement → fournisseur : document source d’un autre compte',
    sql: `SELECT a.account_id, f.account_id AS other_account_id, 'equipment_suppliers(equipments#' || es.equipment_id || ', suppliers#' || es.supplier_id || ') source asset_files#' || f.id AS ref
            FROM equipment_suppliers es JOIN equipments e ON e.id = es.equipment_id JOIN assets a ON a.id = e.asset_id
            JOIN asset_files f ON f.id = es.source_document_id
           WHERE f.account_id IS DISTINCT FROM a.account_id`,
  },
  {
    code: 'ASSET_SUPPLIER', family: 'fournisseurs', label: 'Bien → fournisseur',
    sql: `SELECT a.account_id, s.account_id AS other_account_id, 'asset_suppliers(assets#' || x.asset_id || ', suppliers#' || x.supplier_id || ')' AS ref
            FROM asset_suppliers x JOIN assets a ON a.id = x.asset_id JOIN suppliers s ON s.id = x.supplier_id
           WHERE s.account_id IS DISTINCT FROM a.account_id`,
  },
  // ── Événements (domaine historique) ───────────────────────────────────────
  {
    code: 'EVENT_DOCUMENT', family: 'evenements', label: 'Événement → document',
    sql: `SELECT ev.account_id, f.account_id AS other_account_id, 'event_documents#' || ed.id || ' (events#' || ev.id || ', asset_files#' || f.id || ')' AS ref
            FROM event_documents ed JOIN events ev ON ev.id = ed.event_id JOIN asset_files f ON f.id = ed.file_id
           WHERE f.account_id <> ev.account_id`,
  },
  {
    code: 'EVENT_TARGET', family: 'evenements', label: 'Événement → bien / pièce / équipement',
    sql: `SELECT ev.account_id, coalesce(NULLIF(a.account_id, ev.account_id), NULLIF(la.account_id, ev.account_id), NULLIF(sa.account_id, ev.account_id), NULLIF(ea.account_id, ev.account_id)) AS other_account_id,
                 'events#' || ev.id || coalesce(' assets#' || ev.asset_id, '') || coalesce(' linked_assets#' || ev.linked_asset_id, '') || coalesce(' substructures#' || ev.substructure_id, '') || coalesce(' equipments#' || ev.equipment_id, '') AS ref
            FROM events ev
            LEFT JOIN assets a ON a.id = ev.asset_id
            LEFT JOIN assets la ON la.id = ev.linked_asset_id
            LEFT JOIN substructures s ON s.id = ev.substructure_id LEFT JOIN assets sa ON sa.id = s.asset_id
            LEFT JOIN equipments e ON e.id = ev.equipment_id LEFT JOIN assets ea ON ea.id = e.asset_id
           WHERE (a.id IS NOT NULL AND a.account_id IS DISTINCT FROM ev.account_id)
              OR (la.id IS NOT NULL AND la.account_id IS DISTINCT FROM ev.account_id)
              OR (sa.id IS NOT NULL AND sa.account_id IS DISTINCT FROM ev.account_id)
              OR (ea.id IS NOT NULL AND ea.account_id IS DISTINCT FROM ev.account_id)`,
  },
  {
    code: 'DEADLINE_TARGET', family: 'evenements', label: 'Échéance historique → bien / pièce / équipement',
    sql: `SELECT d.account_id, coalesce(NULLIF(a.account_id, d.account_id), NULLIF(la.account_id, d.account_id), NULLIF(sa.account_id, d.account_id), NULLIF(ea.account_id, d.account_id)) AS other_account_id,
                 'deadlines#' || d.id || coalesce(' assets#' || d.asset_id, '') || coalesce(' linked_assets#' || d.linked_asset_id, '') || coalesce(' substructures#' || d.substructure_id, '') || coalesce(' equipments#' || d.equipment_id, '') AS ref
            FROM deadlines d
            LEFT JOIN assets a ON a.id = d.asset_id
            LEFT JOIN assets la ON la.id = d.linked_asset_id
            LEFT JOIN substructures s ON s.id = d.substructure_id LEFT JOIN assets sa ON sa.id = s.asset_id
            LEFT JOIN equipments e ON e.id = d.equipment_id LEFT JOIN assets ea ON ea.id = e.asset_id
           WHERE (a.id IS NOT NULL AND a.account_id IS DISTINCT FROM d.account_id)
              OR (la.id IS NOT NULL AND la.account_id IS DISTINCT FROM d.account_id)
              OR (sa.id IS NOT NULL AND sa.account_id IS DISTINCT FROM d.account_id)
              OR (ea.id IS NOT NULL AND ea.account_id IS DISTINCT FROM d.account_id)`,
  },
  // ── Agenda ────────────────────────────────────────────────────────────────
  {
    code: 'AGENDA_ASSET', family: 'agenda', label: 'Agenda → bien',
    sql: `SELECT i.account_id, a.account_id AS other_account_id, 'agenda_asset_links#' || l.id || ' (agenda_items#' || i.id || ', assets#' || a.id || ')' AS ref
            FROM agenda_asset_links l JOIN agenda_items i ON i.id = l.agenda_item_id JOIN assets a ON a.id = l.asset_id
           WHERE a.account_id IS DISTINCT FROM i.account_id`,
  },
  {
    code: 'AGENDA_FILE', family: 'agenda', label: 'Agenda → document',
    sql: `SELECT i.account_id, f.account_id AS other_account_id, 'agenda_file_links#' || l.id || ' (agenda_items#' || i.id || ', asset_files#' || f.id || ')' AS ref
            FROM agenda_file_links l JOIN agenda_items i ON i.id = l.agenda_item_id JOIN asset_files f ON f.id = l.asset_file_id
           WHERE f.account_id <> i.account_id`,
  },
  {
    code: 'AGENDA_ROOM', family: 'agenda', label: 'Agenda → pièce',
    sql: `SELECT i.account_id, a.account_id AS other_account_id, 'agenda_room_links#' || l.id || ' (agenda_items#' || i.id || ', substructures#' || s.id || ')' AS ref
            FROM agenda_room_links l JOIN agenda_items i ON i.id = l.agenda_item_id
            JOIN substructures s ON s.id = l.substructure_id JOIN assets a ON a.id = s.asset_id
           WHERE a.account_id IS DISTINCT FROM i.account_id`,
  },
  {
    code: 'AGENDA_EQUIPMENT', family: 'agenda', label: 'Agenda → équipement',
    sql: `SELECT i.account_id, a.account_id AS other_account_id, 'agenda_equipment_links#' || l.id || ' (agenda_items#' || i.id || ', equipments#' || e.id || ')' AS ref
            FROM agenda_equipment_links l JOIN agenda_items i ON i.id = l.agenda_item_id
            JOIN equipments e ON e.id = l.equipment_id JOIN assets a ON a.id = e.asset_id
           WHERE a.account_id IS DISTINCT FROM i.account_id`,
  },
  {
    code: 'AGENDA_SOURCE', family: 'agenda', label: 'Agenda → document source (traces et origine)',
    sql: `SELECT i.account_id, f.account_id AS other_account_id, 'agenda_item_sources#' || x.id || ' (agenda_items#' || i.id || ', asset_files#' || f.id || ')' AS ref
            FROM agenda_item_sources x JOIN agenda_items i ON i.id = x.agenda_item_id JOIN asset_files f ON f.id = x.asset_file_id
           WHERE f.account_id <> i.account_id
          UNION ALL
          SELECT i.account_id, f.account_id, 'agenda_items#' || i.id || ' origin_ref asset_files#' || f.id
            FROM agenda_items i JOIN asset_files f ON f.id = i.origin_ref_id
           WHERE i.origin_ref_type = 'asset_file' AND f.account_id <> i.account_id`,
  },
  // ── Preuves et données projetées depuis les documents ─────────────────────
  {
    code: 'EVIDENCE_ASSET', family: 'preuves', label: 'Preuve (field_evidence) → bien d’un autre compte',
    sql: `SELECT fe.account_id, a.account_id AS other_account_id, 'field_evidence#' || fe.id || ' -> assets#' || a.id || ' (' || fe.status || ')' AS ref
            FROM field_evidence fe JOIN assets a ON a.id = fe.asset_id
           WHERE a.account_id IS DISTINCT FROM fe.account_id AND fe.lifecycle_status IS DISTINCT FROM 'WITHDRAWN'`,
  },
  {
    code: 'EVIDENCE_SOURCE', family: 'preuves', label: 'Preuve (field_evidence) issue d’un document d’un autre compte',
    sql: `SELECT fe.account_id, f.account_id AS other_account_id, 'field_evidence#' || fe.id || ' <- asset_files#' || f.id || ' (' || fe.status || ')' AS ref
            FROM field_evidence fe JOIN asset_files f ON f.id = fe.source_id
           WHERE fe.source_type IN ('document', 'asset_file', 'file') AND f.account_id <> fe.account_id
             AND fe.lifecycle_status IS DISTINCT FROM 'WITHDRAWN'`,
  },
  {
    code: 'FACT_SOURCE', family: 'preuves', label: 'Fait extrait (document_facts) d’un document d’un autre compte',
    sql: `SELECT df.account_id, f.account_id AS other_account_id, 'document_facts#' || df.id || ' <- asset_files#' || f.id AS ref
            FROM document_facts df JOIN asset_files f ON f.id = df.file_id
           WHERE f.account_id <> df.account_id AND df.status = 'active'`,
  },
  {
    // Lot 53 (retour PO D23) : « Ce que j'ai fait » de l'accueil (champs
    // complétés par l'analyse) citant un bien d'un autre compte.
    code: 'AI_FIELD_UPDATE', family: 'preuves', label: 'Champ complété par l’analyse (ai_field_updates) sur un bien d’un autre compte',
    sql: `SELECT u.account_id, a.account_id AS other_account_id, 'ai_field_updates#' || u.id || ' -> assets#' || a.id AS ref
            FROM ai_field_updates u JOIN assets a ON a.id = u.asset_id
           WHERE a.account_id IS DISTINCT FROM u.account_id`,
  },
  // ── « À traiter » (lot 53, retour PO D23) ─────────────────────────────────
  {
    code: 'TO_PROCESS_TARGET', family: 'a_traiter', label: 'Carte « À traiter » ouverte visant un objet d’un autre compte',
    sql: `SELECT t.account_id, o.account_id AS other_account_id, 'to_process_actions#' || t.id || ' -> ' || t.target_type || '#' || t.target_id AS ref
            FROM to_process_actions t
            CROSS JOIN LATERAL (SELECT CASE t.target_type
                WHEN 'ASSET' THEN (SELECT x.account_id FROM assets x WHERE x.id = t.target_id)
                WHEN 'DOCUMENT' THEN (SELECT x.account_id FROM asset_files x WHERE x.id = t.target_id)
                WHEN 'EQUIPMENT' THEN (SELECT b.account_id FROM equipments x JOIN assets b ON b.id = x.asset_id WHERE x.id = t.target_id)
                WHEN 'AGENDA_ITEM' THEN (SELECT x.account_id FROM agenda_items x WHERE x.id = t.target_id)
                WHEN 'SUPPLIER' THEN (SELECT x.account_id FROM suppliers x WHERE x.id = t.target_id)
              END AS account_id) o
           WHERE t.resolved_at IS NULL AND o.account_id IS NOT NULL AND o.account_id <> t.account_id`,
  },
  // ── Jobs IA en attente ────────────────────────────────────────────────────
  {
    code: 'AI_JOB_PENDING', family: 'jobs', label: 'Job IA en attente référençant un objet d’un autre compte',
    sql: `SELECT q.account_id, o.account_id AS other_account_id, 'ai_job_queue#' || q.id || ' (' || q.treatment || ', ' || o.ref || ')' AS ref
            FROM ai_job_queue q
            CROSS JOIN LATERAL (${AI_JOB_REFS_SQL('q')}) o
           WHERE q.status IN ('PENDING', 'RUNNING') AND q.account_id IS NOT NULL
             AND o.account_id IS DISTINCT FROM q.account_id`,
  },
  // ── Opérations et Sinistres (lot 54, SEC-06) ──────────────────────────────
  // Références secondaires d'un sinistre (contrat, événement historique,
  // pièces et photos de dommage) ; les liens « cœur » des
  // Opérations (biens, équipements, composantes, sources, agenda, candidats
  // T1) sont recensés par OP_CORE_LINK — même SQL que l'anomalie dure
  // CROSS_ACCOUNT_LINK du BO Opérations, désormais comptée ici aussi.
  {
    code: 'CLAIM_CONTRACT', family: 'operations', label: 'Sinistre → contrat d’assurance d’un autre compte',
    sql: `SELECT o.account_id, k.account_id AS other_account_id, 'business_operation_claim_details(operation_id=' || o.id || ') -> business_operations#' || k.id AS ref
            FROM business_operation_claim_details cd JOIN business_operations o ON o.id = cd.operation_id
            JOIN business_operations k ON k.id = cd.insurance_contract_operation_id
           WHERE k.account_id <> o.account_id`,
  },
  {
    code: 'CLAIM_HISTORY_EVENT', family: 'operations', label: 'Sinistre → événement historique d’un autre compte',
    sql: `SELECT o.account_id, ev.account_id AS other_account_id, 'business_operation_claim_details(operation_id=' || o.id || ') -> events#' || ev.id AS ref
            FROM business_operation_claim_details cd JOIN business_operations o ON o.id = cd.operation_id
            JOIN events ev ON ev.id = cd.history_event_id
           WHERE ev.account_id IS DISTINCT FROM o.account_id`,
  },
  // Lot 84A (O-10) : CLAIM_ACTION_REF et CLAIM_EXCHANGE_DOCUMENT retirés — actions et échanges de l'ancien
  // modèle Sinistres (tables inertes depuis 83D, purgées par le nettoyage BO, supprimées par sa finalisation).
  {
    code: 'CLAIM_DAMAGE_DOCUMENT', family: 'operations', label: 'Dommage de sinistre → document d’un autre compte',
    sql: `SELECT o.account_id, f.account_id AS other_account_id, 'business_operation_claim_damage_documents(damage_id=' || dd.damage_id || ', file_id=' || f.id || ')' AS ref
            FROM business_operation_claim_damage_documents dd JOIN business_operation_claim_damages d ON d.id = dd.damage_id
            JOIN business_operations o ON o.id = d.operation_id JOIN asset_files f ON f.id = dd.file_id
           WHERE f.account_id <> o.account_id`,
  },
  {
    code: 'CLAIM_DAMAGE_PHOTO', family: 'operations', label: 'Dommage de sinistre → photo d’un autre compte',
    sql: `SELECT o.account_id, coalesce(NULLIF(pa.account_id, o.account_id), NULLIF(pf.account_id, o.account_id)) AS other_account_id,
                 'business_operation_claim_damage_photos(damage_id=' || dp.damage_id || ', photo_id=' || p.id || ')' AS ref
            FROM business_operation_claim_damage_photos dp JOIN business_operation_claim_damages d ON d.id = dp.damage_id
            JOIN business_operations o ON o.id = d.operation_id
            JOIN asset_photos p ON p.id = dp.photo_id JOIN assets pa ON pa.id = p.asset_id JOIN asset_files pf ON pf.id = p.file_id
           WHERE pa.account_id IS DISTINCT FROM o.account_id OR pf.account_id IS DISTINCT FROM o.account_id`,
  },
  {
    code: 'OP_CORE_LINK', family: 'operations', label: 'Opération → bien, équipement, composante, source, agenda ou candidat T1 d’un autre compte',
    sql: `SELECT al.account_id, a.account_id AS other_account_id, 'business_operation_asset_links#' || al.id || ' (business_operations#' || al.operation_id || ', assets#' || a.id || ')' AS ref
            FROM business_operation_asset_links al JOIN assets a ON a.id = al.asset_id
           WHERE al.active AND a.account_id IS DISTINCT FROM al.account_id
          UNION ALL
          SELECT el.account_id, ea.account_id, 'business_operation_equipment_links#' || el.id || ' (business_operations#' || el.operation_id || ', equipments#' || e.id || ')'
            FROM business_operation_equipment_links el JOIN equipments e ON e.id = el.equipment_id JOIN assets ea ON ea.id = e.asset_id
           WHERE el.active AND ea.account_id IS DISTINCT FROM el.account_id
          UNION ALL
          SELECT c.account_id, a.account_id, 'business_operation_financial_components#' || c.id || ' -> assets#' || a.id
            FROM business_operation_financial_components c JOIN assets a ON a.id = c.target_asset_id
           WHERE c.active AND a.account_id IS DISTINCT FROM c.account_id
          UNION ALL
          SELECT c.account_id, a.account_id, 'business_operation_financial_components#' || c.id || ' -> equipments#' || e.id
            FROM business_operation_financial_components c JOIN equipments e ON e.id = c.target_equipment_id JOIN assets a ON a.id = e.asset_id
           WHERE c.active AND a.account_id IS DISTINCT FROM c.account_id
          UNION ALL
          SELECT s.account_id, f.account_id, 'business_operation_sources#' || s.id || ' -> asset_files#' || f.id
            FROM business_operation_sources s JOIN asset_files f ON f.id = ${ID('s.source_entity_key')}
           WHERE s.active AND s.source_kind = 'DOCUMENT' AND f.account_id <> s.account_id
          UNION ALL
          SELECT s.account_id, a.account_id, 'business_operation_sources#' || s.id || ' -> assets#' || a.id
            FROM business_operation_sources s JOIN assets a ON a.id = ${ID('s.source_entity_key')}
           WHERE s.active AND s.source_kind IN ('ASSET_DATA', 'CLAIM_FORM') AND a.account_id IS DISTINCT FROM s.account_id
          UNION ALL
          SELECT s.account_id, ai.account_id, 'business_operation_sources#' || s.id || ' -> agenda_items#' || ai.id
            FROM business_operation_sources s JOIN agenda_items ai ON ai.id = ${ID('s.source_entity_key')}
           WHERE s.active AND s.source_kind = 'AGENDA' AND ai.account_id <> s.account_id
          UNION ALL
          SELECT ai.account_id, o.account_id, 'agenda_items#' || ai.id || ' -> business_operations#' || o.id
            FROM agenda_items ai JOIN business_operations o ON o.id = ai.business_operation_id
           WHERE ai.account_id <> o.account_id
          UNION ALL
          SELECT c.account_id, o.account_id, 'document_operation_candidates#' || c.id || ' -> business_operations#' || o.id
            FROM document_operation_candidates c JOIN business_operations o ON o.id = c.t3_operation_id
           WHERE c.account_id <> o.account_id`,
  },
];

/** Échantillon d'identifiants rendu par type (le décompte, lui, est complet). */
export const SAMPLE_LIMIT = 50;
/** Comptes concernés rendus par type. */
export const ACCOUNTS_LIMIT = 200;

/** Requête d'agrégation d'un contrôle : décompte, comptes, échantillon. */
export function aggregateSql(check: CrossAccountCheck): string {
  return `WITH r AS MATERIALIZED (${check.sql})
SELECT (SELECT count(*) FROM r)::int AS n,
       (SELECT coalesce(array_agg(x ORDER BY x), '{}') FROM (
          SELECT DISTINCT x FROM (SELECT account_id AS x FROM r UNION SELECT other_account_id FROM r) u
           WHERE x IS NOT NULL ORDER BY x LIMIT ${ACCOUNTS_LIMIT}) z) AS accounts,
       (SELECT coalesce(json_agg(json_build_object('accountId', s.account_id, 'otherAccountId', s.other_account_id, 'ref', s.ref)), '[]'::json)
          FROM (SELECT * FROM r ORDER BY account_id NULLS LAST, ref LIMIT ${SAMPLE_LIMIT}) s) AS samples`;
}

export interface CrossAccountCheckResult {
  code: string;
  family: CrossAccountCheck['family'];
  label: string;
  count: number;
  accountIds: number[];
  samples: CrossAccountRow[];
  /** Contrôle non exécuté (table absente, délai dépassé) : motif. */
  error?: string;
}

/**
 * Lot 54 (SEC-07) : état global à trois valeurs. « Conforme » SEULEMENT si
 * tous les contrôles ont été exécutés et que tous les compteurs valent 0 ;
 * un seul contrôle non exécuté rend le diagnostic « incomplet » (jamais
 * conforme, même à 0).
 */
export type IsolationStatus = 'CONFORME' | 'ANOMALIES' | 'INCOMPLET';

export const ISOLATION_STATUS_LABELS: Record<IsolationStatus, string> = {
  CONFORME: 'Conforme',
  ANOMALIES: 'Anomalies détectées',
  INCOMPLET: 'Contrôle incomplet',
};

export function isolationStatus(checks: ReadonlyArray<Pick<CrossAccountCheckResult, 'count' | 'error'>>, expected = CROSS_ACCOUNT_CHECKS.length): IsolationStatus {
  if (checks.length < expected || checks.some((c) => c.error)) return 'INCOMPLET';
  return checks.some((c) => c.count > 0) ? 'ANOMALIES' : 'CONFORME';
}

export interface CrossAccountReport {
  computedAt: string;
  /** Lot 54 (SEC-07) : Conforme / Anomalies détectées / Contrôle incomplet. */
  status: IsolationStatus;
  /** Contrôles non exécutés. */
  checksFailed: number;
  total: number;
  /** Comptes concernés, tous types confondus (bornés). */
  accountIds: number[];
  checks: CrossAccountCheckResult[];
  /** Le contrôle n'a rien modifié (transaction READ ONLY). */
  readOnly: true;
}

type Row = Record<string, unknown>;
export type DetectionQuery = (sql: string) => Promise<Row[]>;
export type DetectionExecutor = <T>(fn: (q: DetectionQuery) => Promise<T>) => Promise<T>;

/** Délai par requête, appliqué par PostgreSQL. */
export const DETECTION_STATEMENT_TIMEOUT_MS = 60_000;

/** Session par défaut : transaction READ ONLY + délai côté base. */
export const readOnlyDetectionExecutor: DetectionExecutor = async <T>(fn: (q: DetectionQuery) => Promise<T>): Promise<T> => {
  const { pgClient } = await import('@/db');
  const out = await pgClient.begin('read only', async (tx) => {
    await tx.unsafe(`SET LOCAL statement_timeout = ${DETECTION_STATEMENT_TIMEOUT_MS}`);
    const q: DetectionQuery = async (sql) => (await tx.unsafe(sql)) as unknown as Row[];
    return [await fn(q)];
  });
  return (out as unknown as T[])[0];
};

const parseJson = <T>(v: unknown, fallback: T): T => {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'string') { try { return JSON.parse(v) as T; } catch { return fallback; } }
  return v as T;
};

/**
 * Exécute tous les contrôles (lecture seule). Un contrôle en échec (table
 * absente d'une base ancienne, délai) est rendu avec son motif sans faire
 * échouer les autres — sous-transaction `SAVEPOINT` (lecture seule aussi).
 */
export async function detectCrossAccountRelations(
  exec: DetectionExecutor = readOnlyDetectionExecutor,
  checks: readonly CrossAccountCheck[] = CROSS_ACCOUNT_CHECKS,
): Promise<CrossAccountReport> {
  const results = await exec(async (q) => {
    const out: CrossAccountCheckResult[] = [];
    for (const c of checks) {
      try {
        await q('SAVEPOINT cross_account_check');
        const [r] = await q(aggregateSql(c));
        await q('RELEASE SAVEPOINT cross_account_check');
        const samples = parseJson<Array<{ accountId: unknown; otherAccountId: unknown; ref: unknown }>>(r?.samples, []);
        out.push({
          code: c.code, family: c.family, label: c.label,
          count: Number(r?.n ?? 0),
          accountIds: (parseJson<unknown[]>(r?.accounts, []) ?? []).map(Number),
          samples: samples.map((s) => ({
            accountId: s.accountId == null ? null : Number(s.accountId),
            otherAccountId: s.otherAccountId == null ? null : Number(s.otherAccountId),
            ref: String(s.ref ?? ''),
          })),
        });
      } catch (e) {
        await q('ROLLBACK TO SAVEPOINT cross_account_check').catch(() => {});
        // Compteur à 0 mais `error` : jamais lu comme « aucune anomalie » (SEC-07).
        out.push({ code: c.code, family: c.family, label: c.label, count: 0, accountIds: [], samples: [], error: (e as Error).message.slice(0, 300) || 'contrôle non exécuté' });
      }
    }
    return out;
  });
  const comptes = new Set<number>();
  for (const r of results) r.accountIds.forEach((a) => comptes.add(a));
  return {
    computedAt: new Date().toISOString(),
    status: isolationStatus(results, checks.length),
    checksFailed: results.filter((r) => r.error).length,
    total: results.reduce((n, r) => n + r.count, 0),
    accountIds: [...comptes].sort((a, b) => a - b).slice(0, ACCOUNTS_LIMIT),
    checks: results,
    readOnly: true,
  };
}

/**
 * Script SQL en lecture seule équivalent (procédure maîtrisée ultérieure,
 * `docs/exploitation/relations-intercomptes.sql`) — généré depuis le même
 * catalogue ; test de parité dans `cross-account-detection.test.ts`.
 */
export function renderCrossAccountSqlScript(): string {
  const tete = [
    '-- ════════════════════════════════════════════════════════════════════════════',
    '-- Isolation des comptes — contrôle en LECTURE SEULE (lot 49 SEC-P0 §5, lot 54 SEC-P0-CORR)',
    '--',
    '-- FICHIER GÉNÉRÉ depuis src/services/security/cross-account/detection.ts',
    '-- (CROSS_ACCOUNT_CHECKS) — ne pas modifier à la main.',
    '--',
    '-- Même contrôle que BO › Exploitation › Isolation des comptes et que la tâche',
    '-- planifiée `cross-account-relations-check`. Aucune écriture : la transaction',
    '-- est ouverte en READ ONLY. Pour chaque type : décompte, puis détail',
    '-- (compte de la relation, autre compte, identifiants techniques).',
    '-- Remise en conformité : procédure maîtrisée de relations-intercomptes.md.',
    '-- ════════════════════════════════════════════════════════════════════════════',
    '',
    'BEGIN TRANSACTION READ ONLY;',
    "SET LOCAL statement_timeout = '120s';",
    '',
  ];
  const corps = CROSS_ACCOUNT_CHECKS.flatMap((c) => [
    `-- ── ${c.code} — ${c.label} (${c.family})`,
    `SELECT '${c.code}' AS code, count(*) AS n FROM (${c.sql}) r;`,
    `SELECT '${c.code}' AS code, r.* FROM (${c.sql}) r ORDER BY r.account_id NULLS LAST, r.ref;`,
    '',
  ]);
  return [...tete, ...corps, 'ROLLBACK;', ''].join('\n');
}
