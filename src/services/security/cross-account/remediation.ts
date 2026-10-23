/**
 * Correction CONTRÔLÉE des relations intercomptes héritées — lot 53 (retour
 * PO D23 « corriger avant production » : auditer, neutraliser, corriger ; le
 * simple signalement du lot 49 ne suffit pas).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * PRINCIPE
 *
 * Une relation intercomptes relie un objet du compte A à un objet du compte
 * B (catalogue `CROSS_ACCOUNT_CHECKS`, `detection.ts`). La correction
 * DÉTACHE le lien et conserve chaque objet dans son propre compte :
 *
 *   · colonne de rattachement (document → bien, événement → pièce…) remise
 *     à NULL (`nullify`) ;
 *   · lien N-N retiré : supprimé (`delete`) ou passé à un statut inactif
 *     (`status` : REMOVED, WITHDRAWN, superseded, CANCELLED, OBSOLETE) ;
 *   · aucun bien, document, événement ou fournisseur n'est supprimé, aucun
 *     objet ne change de compte.
 *
 * Exécution UNIQUEMENT depuis le BO (Exploitation › Rattrapages, bloc
 * « Relations intercomptes », une étape par famille) : Simuler (transaction
 * ANNULÉE : rapport exact, rien d'écrit), Appliquer (motif obligatoire,
 * audit admin), Restaurer (par identifiant d'exécution). Chaque ligne
 * modifiée est journalisée dans `cross_account_remediations` (état AVANT
 * complet), ce qui rend la correction réversible ligne à ligne.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUI N'EST JAMAIS CORRIGÉ ICI (signalé seulement)
 *
 *   · DUO (D3 ouvert côté PO) : une relation dont un bien a un historique
 *     Duo (`assets.duo_id`, demande de déplacement `asset_move_requests`)
 *     ou dont les deux comptes sont reliés par un même Duo (compte titulaire
 *     `accounts.duo_account_id`, payeur, membres `duo_memberships`, tous
 *     statuts). Le transfert de bien (lot 40) et son rattrapage restent
 *     seuls compétents ; aucune hypothèse sur le modèle Duo n'est faite.
 *   · INDÉCIDABLE : un des deux objets n'a pas de compte (donnée
 *     historique) — impossible de dire lequel est « l'autre compte ».
 *
 * Partages légitimes : un compte partagé (`account_memberships`) ne crée
 * jamais deux comptes différents — ses objets ont le MÊME `account_id` et
 * ne figurent donc jamais parmi les candidats. Rien ne les touche.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { AI_JOB_REFS_SQL, CROSS_ACCOUNT_CHECKS, readOnlyDetectionExecutor, type CrossAccountCheck, type DetectionExecutor } from './detection';

export type RemediationFamily = CrossAccountCheck['family'];
export type RemediationMode = 'nullify' | 'status' | 'delete';

/** Une table corrigée pour une catégorie. */
export interface RemediationPart {
  table: string;
  /** Clé primaire (colonnes entières). */
  pk: readonly string[];
  mode: RemediationMode;
  /**
   * SELECT des lignes à corriger : `row_pk` (jsonb), `account_id` (compte
   * de la ligne corrigée), `other_account_id`, `asset_ids` (int[] : biens
   * en jeu, pour la qualification Duo), `cols` (text[], `nullify`).
   */
  sql: string;
  /** `status` : colonnes posées (expression SQL). */
  set?: Readonly<Record<string, string>>;
  /** `status` : la ligne est encore dans l'état posé (restauration sans conflit). */
  still?: string;
}

export interface RemediationSpec {
  code: string;
  family: RemediationFamily;
  parts: readonly RemediationPart[];
  /**
   * Lot 54 (SEC-09) : aucune correction automatique possible sans risque
   * pour les données légitimes (liens « cœur » des Opérations : la
   * correction passe par le moteur Opérations et sa réconsolidation) —
   * procédure d'incident décrite ici ; `parts` est vide, les lignes sont
   * seulement recensées (inventaire « en attente de décision »).
   */
  manual?: string;
}

const pk = (alias: string, ...cols: string[]) => `jsonb_build_object(${cols.map((c) => `'${c}', ${alias}.${c}`).join(', ')})`;
const ids = (...exprs: string[]) => `array_remove(ARRAY[${exprs.join(', ')}]::int[], NULL)`;
const nul = (cond: string, col: string) => `CASE WHEN ${cond} THEN '${col}' END`;
const ID = (expr: string) => `(CASE WHEN ${expr} ~ '^[0-9]{1,9}$' THEN (${expr})::int END)`;
/** Biens d'une Opération (qualification Duo d'une relation de sinistre). */
const OP_ASSETS = (op: string) => `coalesce((SELECT array_agg(l.asset_id) FROM business_operation_asset_links l WHERE l.operation_id = ${op}), '{}')::int[]`;

/** Correction par catégorie (mêmes codes que `CROSS_ACCOUNT_CHECKS`). */
export const REMEDIATION_SPECS: readonly RemediationSpec[] = [
  // ── Documents ──────────────────────────────────────────────────────────
  {
    code: 'DOC_ASSET', family: 'documents', parts: [{
      table: 'asset_files', pk: ['id'], mode: 'nullify',
      sql: `SELECT ${pk('f', 'id')} AS row_pk, f.account_id, a.account_id AS other_account_id, ${ids('a.id')} AS asset_ids, ARRAY['asset_id'] AS cols
              FROM asset_files f JOIN assets a ON a.id = f.asset_id WHERE a.account_id IS DISTINCT FROM f.account_id`,
    }],
  },
  {
    code: 'DOC_LINKED_ASSET', family: 'documents', parts: [{
      table: 'asset_files', pk: ['id'], mode: 'nullify',
      sql: `SELECT ${pk('f', 'id')} AS row_pk, f.account_id, a.account_id AS other_account_id, ${ids('a.id')} AS asset_ids, ARRAY['linked_asset_id'] AS cols
              FROM asset_files f JOIN assets a ON a.id = f.linked_asset_id WHERE a.account_id IS DISTINCT FROM f.account_id`,
    }],
  },
  {
    code: 'DOC_SUBSTRUCTURE', family: 'documents', parts: [{
      table: 'asset_files', pk: ['id'], mode: 'nullify',
      sql: `SELECT ${pk('f', 'id')} AS row_pk, f.account_id, a.account_id AS other_account_id, ${ids('a.id')} AS asset_ids, ARRAY['substructure_id'] AS cols
              FROM asset_files f JOIN substructures s ON s.id = f.substructure_id JOIN assets a ON a.id = s.asset_id
             WHERE a.account_id IS DISTINCT FROM f.account_id`,
    }],
  },
  {
    code: 'DOC_EQUIPMENT', family: 'documents', parts: [{
      table: 'asset_files', pk: ['id'], mode: 'nullify',
      sql: `SELECT ${pk('f', 'id')} AS row_pk, f.account_id, a.account_id AS other_account_id, ${ids('a.id')} AS asset_ids, ARRAY['equipment_id'] AS cols
              FROM asset_files f JOIN equipments e ON e.id = f.equipment_id JOIN assets a ON a.id = e.asset_id
             WHERE a.account_id IS DISTINCT FROM f.account_id`,
    }],
  },
  {
    code: 'DOC_ROOM_LEGACY', family: 'documents', parts: [{
      table: 'asset_files', pk: ['id'], mode: 'nullify',
      sql: `SELECT ${pk('f', 'id')} AS row_pk, f.account_id, r.account_id AS other_account_id, ${ids('r.asset_id')} AS asset_ids, ARRAY['linked_room_id'] AS cols
              FROM asset_files f JOIN rooms r ON r.id = f.linked_room_id WHERE r.account_id IS DISTINCT FROM f.account_id`,
    }],
  },
  {
    code: 'DOC_ASSET_LINK', family: 'documents', parts: [{
      table: 'document_asset_links', pk: ['id'], mode: 'status',
      set: { status: `'REMOVED'`, removed_at: 'now()', updated_at: 'now()' },
      still: `status = 'REMOVED'`,
      sql: `SELECT ${pk('l', 'id')} AS row_pk, l.account_id,
                   coalesce(NULLIF(f.account_id, l.account_id), NULLIF(a.account_id, l.account_id), NULLIF(sa.account_id, l.account_id), NULLIF(ea.account_id, l.account_id)) AS other_account_id,
                   ${ids('a.id', 'sa.id', 'ea.id', 'f.asset_id')} AS asset_ids, NULL::text[] AS cols
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
    }],
  },
  // ── Fournisseurs ───────────────────────────────────────────────────────
  {
    code: 'DOC_SUPPLIER', family: 'fournisseurs', parts: [{
      table: 'document_suppliers', pk: ['document_id', 'supplier_id'], mode: 'delete',
      sql: `SELECT ${pk('ds', 'document_id', 'supplier_id')} AS row_pk, f.account_id, s.account_id AS other_account_id, ${ids('f.asset_id')} AS asset_ids, NULL::text[] AS cols
              FROM document_suppliers ds JOIN asset_files f ON f.id = ds.document_id JOIN suppliers s ON s.id = ds.supplier_id
             WHERE s.account_id <> f.account_id`,
    }],
  },
  {
    code: 'EQUIPMENT_SUPPLIER', family: 'fournisseurs', parts: [{
      table: 'equipment_suppliers', pk: ['equipment_id', 'supplier_id'], mode: 'delete',
      sql: `SELECT ${pk('es', 'equipment_id', 'supplier_id')} AS row_pk, a.account_id, s.account_id AS other_account_id, ${ids('a.id')} AS asset_ids, NULL::text[] AS cols
              FROM equipment_suppliers es JOIN equipments e ON e.id = es.equipment_id JOIN assets a ON a.id = e.asset_id
              JOIN suppliers s ON s.id = es.supplier_id
             WHERE s.account_id IS DISTINCT FROM a.account_id`,
    }],
  },
  {
    code: 'EQUIPMENT_SUPPLIER_SOURCE', family: 'fournisseurs', parts: [{
      table: 'equipment_suppliers', pk: ['equipment_id', 'supplier_id'], mode: 'nullify',
      sql: `SELECT ${pk('es', 'equipment_id', 'supplier_id')} AS row_pk, a.account_id, f.account_id AS other_account_id, ${ids('a.id', 'f.asset_id')} AS asset_ids, ARRAY['source_document_id'] AS cols
              FROM equipment_suppliers es JOIN equipments e ON e.id = es.equipment_id JOIN assets a ON a.id = e.asset_id
              JOIN asset_files f ON f.id = es.source_document_id
             WHERE f.account_id IS DISTINCT FROM a.account_id`,
    }],
  },
  {
    code: 'ASSET_SUPPLIER', family: 'fournisseurs', parts: [{
      table: 'asset_suppliers', pk: ['asset_id', 'supplier_id'], mode: 'delete',
      sql: `SELECT ${pk('x', 'asset_id', 'supplier_id')} AS row_pk, a.account_id, s.account_id AS other_account_id, ${ids('a.id')} AS asset_ids, NULL::text[] AS cols
              FROM asset_suppliers x JOIN assets a ON a.id = x.asset_id JOIN suppliers s ON s.id = x.supplier_id
             WHERE s.account_id IS DISTINCT FROM a.account_id`,
    }],
  },
  // ── Événements et échéances historiques ───────────────────────────────
  {
    code: 'EVENT_DOCUMENT', family: 'evenements', parts: [{
      table: 'event_documents', pk: ['id'], mode: 'delete',
      sql: `SELECT ${pk('ed', 'id')} AS row_pk, ev.account_id, f.account_id AS other_account_id, ${ids('ev.asset_id', 'f.asset_id')} AS asset_ids, NULL::text[] AS cols
              FROM event_documents ed JOIN events ev ON ev.id = ed.event_id JOIN asset_files f ON f.id = ed.file_id
             WHERE f.account_id <> ev.account_id`,
    }],
  },
  ...(['events', 'deadlines'] as const).map((t): RemediationSpec => {
    const x = t === 'events' ? 'ev' : 'd';
    const diff = (alias: string) => `${alias}.id IS NOT NULL AND ${alias}.account_id IS DISTINCT FROM ${x}.account_id`;
    return {
      code: t === 'events' ? 'EVENT_TARGET' : 'DEADLINE_TARGET', family: 'evenements', parts: [{
        table: t, pk: ['id'], mode: 'nullify',
        sql: `SELECT ${pk(x, 'id')} AS row_pk, ${x}.account_id,
                     coalesce(NULLIF(a.account_id, ${x}.account_id), NULLIF(la.account_id, ${x}.account_id), NULLIF(sa.account_id, ${x}.account_id), NULLIF(ea.account_id, ${x}.account_id)) AS other_account_id,
                     ${ids('a.id', 'la.id', 'sa.id', 'ea.id')} AS asset_ids,
                     array_remove(ARRAY[${nul(diff('a'), 'asset_id')}, ${nul(diff('la'), 'linked_asset_id')}, ${nul(diff('sa'), 'substructure_id')}, ${nul(diff('ea'), 'equipment_id')}]::text[], NULL) AS cols
                FROM ${t} ${x}
                LEFT JOIN assets a ON a.id = ${x}.asset_id
                LEFT JOIN assets la ON la.id = ${x}.linked_asset_id
                LEFT JOIN substructures s ON s.id = ${x}.substructure_id LEFT JOIN assets sa ON sa.id = s.asset_id
                LEFT JOIN equipments e ON e.id = ${x}.equipment_id LEFT JOIN assets ea ON ea.id = e.asset_id
               WHERE (${diff('a')}) OR (${diff('la')}) OR (${diff('sa')}) OR (${diff('ea')})`,
      }],
    };
  }),
  // ── Agenda ─────────────────────────────────────────────────────────────
  {
    code: 'AGENDA_ASSET', family: 'agenda', parts: [{
      table: 'agenda_asset_links', pk: ['id'], mode: 'delete',
      sql: `SELECT ${pk('l', 'id')} AS row_pk, i.account_id, a.account_id AS other_account_id, ${ids('a.id')} AS asset_ids, NULL::text[] AS cols
              FROM agenda_asset_links l JOIN agenda_items i ON i.id = l.agenda_item_id JOIN assets a ON a.id = l.asset_id
             WHERE a.account_id IS DISTINCT FROM i.account_id`,
    }],
  },
  {
    code: 'AGENDA_FILE', family: 'agenda', parts: [{
      table: 'agenda_file_links', pk: ['id'], mode: 'delete',
      sql: `SELECT ${pk('l', 'id')} AS row_pk, i.account_id, f.account_id AS other_account_id, ${ids('f.asset_id')} AS asset_ids, NULL::text[] AS cols
              FROM agenda_file_links l JOIN agenda_items i ON i.id = l.agenda_item_id JOIN asset_files f ON f.id = l.asset_file_id
             WHERE f.account_id <> i.account_id`,
    }],
  },
  {
    code: 'AGENDA_ROOM', family: 'agenda', parts: [{
      table: 'agenda_room_links', pk: ['id'], mode: 'delete',
      sql: `SELECT ${pk('l', 'id')} AS row_pk, i.account_id, a.account_id AS other_account_id, ${ids('a.id')} AS asset_ids, NULL::text[] AS cols
              FROM agenda_room_links l JOIN agenda_items i ON i.id = l.agenda_item_id
              JOIN substructures s ON s.id = l.substructure_id JOIN assets a ON a.id = s.asset_id
             WHERE a.account_id IS DISTINCT FROM i.account_id`,
    }],
  },
  {
    code: 'AGENDA_EQUIPMENT', family: 'agenda', parts: [{
      table: 'agenda_equipment_links', pk: ['id'], mode: 'delete',
      sql: `SELECT ${pk('l', 'id')} AS row_pk, i.account_id, a.account_id AS other_account_id, ${ids('a.id')} AS asset_ids, NULL::text[] AS cols
              FROM agenda_equipment_links l JOIN agenda_items i ON i.id = l.agenda_item_id
              JOIN equipments e ON e.id = l.equipment_id JOIN assets a ON a.id = e.asset_id
             WHERE a.account_id IS DISTINCT FROM i.account_id`,
    }],
  },
  {
    code: 'AGENDA_SOURCE', family: 'agenda', parts: [
      {
        table: 'agenda_item_sources', pk: ['id'], mode: 'delete',
        sql: `SELECT ${pk('x', 'id')} AS row_pk, i.account_id, f.account_id AS other_account_id, ${ids('f.asset_id')} AS asset_ids, NULL::text[] AS cols
                FROM agenda_item_sources x JOIN agenda_items i ON i.id = x.agenda_item_id JOIN asset_files f ON f.id = x.asset_file_id
               WHERE f.account_id <> i.account_id`,
      },
      {
        table: 'agenda_items', pk: ['id'], mode: 'nullify',
        sql: `SELECT ${pk('i', 'id')} AS row_pk, i.account_id, f.account_id AS other_account_id, ${ids('f.asset_id')} AS asset_ids, ARRAY['origin_ref_id'] AS cols
                FROM agenda_items i JOIN asset_files f ON f.id = i.origin_ref_id
               WHERE i.origin_ref_type = 'asset_file' AND f.account_id <> i.account_id`,
      },
    ],
  },
  // ── Preuves et données projetées ──────────────────────────────────────
  {
    code: 'EVIDENCE_ASSET', family: 'preuves', parts: [{
      table: 'field_evidence', pk: ['id'], mode: 'status',
      set: { lifecycle_status: `'WITHDRAWN'`, superseded_at: 'now()' },
      still: `lifecycle_status = 'WITHDRAWN'`,
      sql: `SELECT ${pk('fe', 'id')} AS row_pk, fe.account_id, a.account_id AS other_account_id, ${ids('a.id')} AS asset_ids, NULL::text[] AS cols
              FROM field_evidence fe JOIN assets a ON a.id = fe.asset_id
             WHERE a.account_id IS DISTINCT FROM fe.account_id AND fe.lifecycle_status IS DISTINCT FROM 'WITHDRAWN'`,
    }],
  },
  {
    code: 'EVIDENCE_SOURCE', family: 'preuves', parts: [{
      table: 'field_evidence', pk: ['id'], mode: 'status',
      set: { lifecycle_status: `'WITHDRAWN'`, superseded_at: 'now()' },
      still: `lifecycle_status = 'WITHDRAWN'`,
      sql: `SELECT ${pk('fe', 'id')} AS row_pk, fe.account_id, f.account_id AS other_account_id, ${ids('fe.asset_id', 'f.asset_id')} AS asset_ids, NULL::text[] AS cols
              FROM field_evidence fe JOIN asset_files f ON f.id = fe.source_id
             WHERE fe.source_type IN ('document', 'asset_file', 'file') AND f.account_id <> fe.account_id
               AND fe.lifecycle_status IS DISTINCT FROM 'WITHDRAWN'`,
    }],
  },
  {
    code: 'FACT_SOURCE', family: 'preuves', parts: [{
      table: 'document_facts', pk: ['id'], mode: 'status',
      set: { status: `'superseded'` },
      still: `status = 'superseded'`,
      sql: `SELECT ${pk('df', 'id')} AS row_pk, df.account_id, f.account_id AS other_account_id, ${ids('f.asset_id')} AS asset_ids, NULL::text[] AS cols
              FROM document_facts df JOIN asset_files f ON f.id = df.file_id
             WHERE f.account_id <> df.account_id AND df.status = 'active'`,
    }],
  },
  {
    code: 'AI_FIELD_UPDATE', family: 'preuves', parts: [{
      table: 'ai_field_updates', pk: ['id'], mode: 'delete',
      sql: `SELECT ${pk('u', 'id')} AS row_pk, u.account_id, a.account_id AS other_account_id, ${ids('a.id')} AS asset_ids, NULL::text[] AS cols
              FROM ai_field_updates u JOIN assets a ON a.id = u.asset_id
             WHERE a.account_id IS DISTINCT FROM u.account_id`,
    }],
  },
  // ── « À traiter » ─────────────────────────────────────────────────────
  {
    code: 'TO_PROCESS_TARGET', family: 'a_traiter', parts: [{
      table: 'to_process_actions', pk: ['id'], mode: 'status',
      set: { resolved_at: 'now()', resolution_reason: `'OBSOLETE'`, updated_at: 'now()' },
      still: `resolved_at IS NOT NULL AND resolution_reason = 'OBSOLETE'`,
      sql: `SELECT ${pk('t', 'id')} AS row_pk, t.account_id, o.account_id AS other_account_id,
                   ${ids(`CASE WHEN t.target_type = 'ASSET' THEN t.target_id END`)} AS asset_ids, NULL::text[] AS cols
              FROM to_process_actions t
              CROSS JOIN LATERAL (SELECT CASE t.target_type
                  WHEN 'ASSET' THEN (SELECT x.account_id FROM assets x WHERE x.id = t.target_id)
                  WHEN 'DOCUMENT' THEN (SELECT x.account_id FROM asset_files x WHERE x.id = t.target_id)
                  WHEN 'EQUIPMENT' THEN (SELECT b.account_id FROM equipments x JOIN assets b ON b.id = x.asset_id WHERE x.id = t.target_id)
                  WHEN 'AGENDA_ITEM' THEN (SELECT x.account_id FROM agenda_items x WHERE x.id = t.target_id)
                  WHEN 'SUPPLIER' THEN (SELECT x.account_id FROM suppliers x WHERE x.id = t.target_id)
                END AS account_id) o
             WHERE t.resolved_at IS NULL AND o.account_id IS NOT NULL AND o.account_id <> t.account_id`,
    }],
  },
  // ── Jobs IA en attente ────────────────────────────────────────────────
  {
    code: 'AI_JOB_PENDING', family: 'jobs', parts: [{
      table: 'ai_job_queue', pk: ['id'], mode: 'status',
      set: { status: `'CANCELLED'`, last_error: `'CROSS_ACCOUNT_REMEDIATION : job référençant un objet d''un autre compte'` },
      still: `status = 'CANCELLED'`,
      // PENDING seulement : un job RUNNING est déjà refusé à l'exécution (job-scope).
      // Lot 54 (SEC-05/06) : mêmes références que le contrôle (cible et contexte imbriqué).
      sql: `SELECT DISTINCT ON (q.id) ${pk('q', 'id')} AS row_pk, q.account_id, o.account_id AS other_account_id,
                   ${ids(`CASE WHEN q.target_type = 'asset' THEN ${ID('q.target_id')} END`, ID("q.payload ->> 'assetId'"))} AS asset_ids, NULL::text[] AS cols
              FROM ai_job_queue q
              CROSS JOIN LATERAL (${AI_JOB_REFS_SQL('q')}) o
             WHERE q.status = 'PENDING' AND q.account_id IS NOT NULL AND o.account_id IS DISTINCT FROM q.account_id
             ORDER BY q.id`,
    }],
  },
  // ── Documents : photos (lot 54, SEC-06) ───────────────────────────────
  {
    code: 'PHOTO_FILE', family: 'documents', parts: [{
      // Association photo ↔ bien retirée ; le fichier reste dans son compte.
      table: 'asset_photos', pk: ['id'], mode: 'delete',
      sql: `SELECT ${pk('p', 'id')} AS row_pk, a.account_id, f.account_id AS other_account_id, ${ids('a.id', 'f.asset_id')} AS asset_ids, NULL::text[] AS cols
              FROM asset_photos p JOIN assets a ON a.id = p.asset_id JOIN asset_files f ON f.id = p.file_id
             WHERE f.account_id IS DISTINCT FROM a.account_id`,
    }],
  },
  // ── Opérations et Sinistres (lot 54, SEC-06 / SEC-09) ─────────────────
  {
    code: 'CLAIM_CONTRACT', family: 'operations', parts: [{
      table: 'business_operation_claim_details', pk: ['operation_id'], mode: 'nullify',
      sql: `SELECT ${pk('cd', 'operation_id')} AS row_pk, o.account_id, k.account_id AS other_account_id, ${OP_ASSETS('o.id')} AS asset_ids,
                   ARRAY['insurance_contract_operation_id'] AS cols
              FROM business_operation_claim_details cd JOIN business_operations o ON o.id = cd.operation_id
              JOIN business_operations k ON k.id = cd.insurance_contract_operation_id
             WHERE k.account_id <> o.account_id`,
    }],
  },
  {
    code: 'CLAIM_HISTORY_EVENT', family: 'operations', parts: [{
      table: 'business_operation_claim_details', pk: ['operation_id'], mode: 'nullify',
      sql: `SELECT ${pk('cd', 'operation_id')} AS row_pk, o.account_id, ev.account_id AS other_account_id, ${OP_ASSETS('o.id')} AS asset_ids,
                   ARRAY['history_event_id'] AS cols
              FROM business_operation_claim_details cd JOIN business_operations o ON o.id = cd.operation_id
              JOIN events ev ON ev.id = cd.history_event_id
             WHERE ev.account_id IS DISTINCT FROM o.account_id`,
    }],
  },
  // Lot 84A (O-10) : CLAIM_ACTION_REF et CLAIM_EXCHANGE_DOCUMENT retirés (tables de l'ancien modèle Sinistres
  // supprimées par la finalisation du nettoyage BO). Une restauration d'une correction ancienne qui les visait
  // est rapportée en conflit « catégorie inconnue », jamais rejouée.
  {
    code: 'CLAIM_DAMAGE_DOCUMENT', family: 'operations', parts: [{
      table: 'business_operation_claim_damage_documents', pk: ['damage_id', 'file_id'], mode: 'delete',
      sql: `SELECT ${pk('dd', 'damage_id', 'file_id')} AS row_pk, o.account_id, f.account_id AS other_account_id, ${OP_ASSETS('o.id')} AS asset_ids, NULL::text[] AS cols
              FROM business_operation_claim_damage_documents dd JOIN business_operation_claim_damages d ON d.id = dd.damage_id
              JOIN business_operations o ON o.id = d.operation_id JOIN asset_files f ON f.id = dd.file_id
             WHERE f.account_id <> o.account_id`,
    }],
  },
  {
    code: 'CLAIM_DAMAGE_PHOTO', family: 'operations', parts: [{
      table: 'business_operation_claim_damage_photos', pk: ['damage_id', 'photo_id'], mode: 'delete',
      sql: `SELECT ${pk('dp', 'damage_id', 'photo_id')} AS row_pk, o.account_id,
                   coalesce(NULLIF(pa.account_id, o.account_id), NULLIF(pf.account_id, o.account_id)) AS other_account_id,
                   ${OP_ASSETS('o.id')} AS asset_ids, NULL::text[] AS cols
              FROM business_operation_claim_damage_photos dp JOIN business_operation_claim_damages d ON d.id = dp.damage_id
              JOIN business_operations o ON o.id = d.operation_id
              JOIN asset_photos p ON p.id = dp.photo_id JOIN assets pa ON pa.id = p.asset_id JOIN asset_files pf ON pf.id = p.file_id
             WHERE pa.account_id IS DISTINCT FROM o.account_id OR pf.account_id IS DISTINCT FROM o.account_id`,
    }],
  },
  {
    code: 'OP_CORE_LINK', family: 'operations', parts: [],
    manual: 'Procédure d’incident : aucune correction directe (liens de preuve et de calcul des Opérations). Lectures et écritures '
      + 'déjà bornées au compte. BO › Opérations › Diagnostic (anomalie dure CROSS_ACCOUNT_LINK) puis réconsolidation du compte '
      + 'concerné (BO › Opérations › Réconsolidation, simulation puis application) ; en attente de décision tant que l’origine '
      + '(déplacement Duo, donnée historique) n’est pas établie.',
  },
];

export const REMEDIATION_FAMILIES: readonly RemediationFamily[] = ['documents', 'fournisseurs', 'evenements', 'agenda', 'preuves', 'a_traiter', 'jobs', 'operations'];

export function remediationSpec(code: string): RemediationSpec | null {
  return REMEDIATION_SPECS.find((s) => s.code === code) ?? null;
}

/**
 * Qualification d'une ligne : DUO (signalée, jamais corrigée — D3 ouvert),
 * INDÉCIDABLE (un compte inconnu) ou CORRECTABLE. Même expression pour
 * l'inventaire (lecture seule) et la correction.
 */
const DUO_ACCOUNTS = `(
    SELECT a.id AS account_id, a.duo_account_id AS duo_id FROM accounts a WHERE a.duo_account_id IS NOT NULL
    UNION SELECT a.id, m.duo_id FROM accounts a JOIN duo_memberships m ON m.user_id = a.owner_user_id
    UNION SELECT a.id, d.id FROM accounts a JOIN duo_accounts d ON d.billing_owner_user_id = a.owner_user_id
  )`;

export function qualifiedSql(part: RemediationPart, accountId: number | null): string {
  const filtre = accountId ? `WHERE c.account_id = ${Number(accountId)} OR c.other_account_id = ${Number(accountId)}` : '';
  return `WITH c AS MATERIALIZED (${part.sql}), duo_acc AS MATERIALIZED ${DUO_ACCOUNTS}
SELECT c.row_pk, c.account_id, c.other_account_id, c.asset_ids, c.cols,
       CASE
         WHEN c.account_id IS NULL OR c.other_account_id IS NULL THEN 'UNDECIDABLE'
         WHEN EXISTS (SELECT 1 FROM assets x WHERE x.id = ANY(c.asset_ids) AND x.duo_id IS NOT NULL)
           OR EXISTS (SELECT 1 FROM asset_move_requests m WHERE m.asset_id = ANY(c.asset_ids))
           OR EXISTS (SELECT 1 FROM duo_acc x JOIN duo_acc y ON y.duo_id = x.duo_id
                       WHERE x.account_id = c.account_id AND y.account_id = c.other_account_id)
           THEN 'DUO'
         ELSE 'CORRECTABLE'
       END AS qualification
  FROM c ${filtre}`;
}

// ── Inventaire (lecture seule) ──────────────────────────────────────────────

export interface RemediationInventoryEntry {
  code: string;
  family: RemediationFamily;
  total: number;
  correctable: number;
  duo: number;
  undecidable: number;
  /** Lot 54 : relations sans correction automatique (procédure d'incident, en attente de décision). */
  manual?: number;
  error?: string;
}

type Q = (sql: string) => Promise<Array<Record<string, unknown>>>;

/** Décompte par qualification (exécuté dans la transaction READ ONLY de la détection). */
export async function inventoryRemediation(q: Q, accountId: number | null = null): Promise<RemediationInventoryEntry[]> {
  const out: RemediationInventoryEntry[] = [];
  for (const spec of REMEDIATION_SPECS) {
    const e: RemediationInventoryEntry = { code: spec.code, family: spec.family, total: 0, correctable: 0, duo: 0, undecidable: 0 };
    try {
      if (spec.manual) {
        const check = CROSS_ACCOUNT_CHECKS.find((c) => c.code === spec.code);
        if (check) {
          await q('SAVEPOINT cross_account_inventory');
          const [r] = await q(`SELECT count(*)::int AS n FROM (${check.sql}) z`);
          await q('RELEASE SAVEPOINT cross_account_inventory');
          e.manual = Number(r?.n ?? 0);
          e.total += e.manual;
        }
      }
      for (const part of spec.parts) {
        await q('SAVEPOINT cross_account_inventory');
        const rows = await q(`SELECT qualification, count(*)::int AS n FROM (${qualifiedSql(part, accountId)}) z GROUP BY qualification`);
        await q('RELEASE SAVEPOINT cross_account_inventory');
        for (const r of rows) {
          const n = Number(r.n ?? 0);
          e.total += n;
          if (r.qualification === 'DUO') e.duo += n;
          else if (r.qualification === 'UNDECIDABLE') e.undecidable += n;
          else e.correctable += n;
        }
      }
    } catch (err) {
      await q('ROLLBACK TO SAVEPOINT cross_account_inventory').catch(() => undefined);
      e.error = (err as Error).message.slice(0, 300);
    }
    out.push(e);
  }
  return out;
}

/** Inventaire qualifié, transaction READ ONLY (BO, rapport). */
export async function readRemediationInventory(
  exec: DetectionExecutor = readOnlyDetectionExecutor, accountId: number | null = null,
): Promise<RemediationInventoryEntry[]> {
  return exec((q) => inventoryRemediation(q as Q, accountId));
}

/** Dernières corrections journalisées (preuve du BO), par exécution. */
export interface RemediationJournalRun {
  runId: string;
  at: string;
  rows: number;
  restored: number;
  categories: string[];
}

export async function readRemediationJournal(q: Q, limit = 20): Promise<RemediationJournalRun[]> {
  const rows = await q(`SELECT run_id::text AS run_id, max(created_at) AS at, count(*)::int AS n,
                               count(restored_at)::int AS restored, array_agg(DISTINCT category) AS categories
                          FROM cross_account_remediations GROUP BY run_id ORDER BY max(created_at) DESC LIMIT ${Math.max(1, Math.min(limit, 100))}`);
  return rows.map((r) => ({
    runId: String(r.run_id), at: new Date(r.at as string).toISOString(), rows: Number(r.n), restored: Number(r.restored),
    categories: (r.categories as string[] | null) ?? [],
  }));
}

// ── Correction (simulation / application) ───────────────────────────────────

export interface RemediationCategoryResult {
  code: string;
  candidates: number;
  /** Corrigées (application) ou à corriger (simulation). */
  corrected: number;
  duo: number;
  undecidable: number;
  failed: number;
  samples: string[];
  duoSamples: string[];
  failures: string[];
  /** Lot 54 : relations recensées sans correction automatique (procédure d'incident). */
  manual?: number;
}

export interface RemediationReport {
  mode: 'simulate' | 'apply';
  runId: string;
  family: RemediationFamily;
  accountId: number | null;
  corrected: number;
  duo: number;
  undecidable: number;
  failed: number;
  /** Lot borné atteint : relancer pour la suite. */
  more: boolean;
  categories: RemediationCategoryResult[];
  /**
   * Lot 54 (SEC-09) : contrôle d'intégrité REJOUÉ après l'application
   * (lecture seule) — relations restantes par catégorie de la famille ;
   * `incomplete` : un contrôle n'a pas pu s'exécuter.
   */
  postCheck?: { at: string; remaining: Record<string, number>; incomplete: string[] };
}

export const REMEDIATION_BATCH = 2_000;
const SAMPLES = 20;

class Simulation extends Error {}

const ident = (s: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`Identifiant SQL refusé : ${s}`);
  return `"${s}"`;
};
const pkWhere = (part: Pick<RemediationPart, 'pk'>, param: string) =>
  part.pk.map((c) => `${ident(c)} = (${param}::jsonb ->> '${c}')::bigint`).join(' AND ');
const refText = (table: string, rowPk: Record<string, unknown>) => `${table}(${Object.entries(rowPk).map(([k, v]) => `${k}=${v}`).join(', ')})`;

export interface RemediationRunOptions {
  family: RemediationFamily;
  apply: boolean;
  accountId?: number | null;
  reason?: string | null;
  batchSize?: number;
  log?: (m: string) => void;
}

/**
 * Corrige (ou simule) les relations d'une famille. Une transaction par
 * catégorie ; simulation = mêmes écritures dans une transaction ANNULÉE
 * (rapport exact). Chaque ligne dans son SAVEPOINT : un échec (contrainte,
 * ligne disparue) est rapporté sans interrompre la catégorie.
 */
export async function runCrossAccountRemediation(sql: postgres.Sql, o: RemediationRunOptions): Promise<RemediationReport> {
  const runId = randomUUID();
  const batch = Math.max(1, Math.min(o.batchSize ?? REMEDIATION_BATCH, 10_000));
  const report: RemediationReport = {
    mode: o.apply ? 'apply' : 'simulate', runId, family: o.family, accountId: o.accountId ?? null,
    corrected: 0, duo: 0, undecidable: 0, failed: 0, more: false, categories: [],
  };
  for (const spec of REMEDIATION_SPECS.filter((s) => s.family === o.family)) {
    let res: RemediationCategoryResult = { code: spec.code, candidates: 0, corrected: 0, duo: 0, undecidable: 0, failed: 0, samples: [], duoSamples: [], failures: [] };
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL lock_timeout = '5s'`);
        await tx.unsafe(`SET LOCAL statement_timeout = '120s'`);
        for (const part of spec.parts) {
          const rows = await tx.unsafe<Array<{ row_pk: Record<string, unknown>; account_id: number | null; other_account_id: number | null; cols: string[] | null; qualification: string }>>(
            `${qualifiedSql(part, o.accountId ?? null)} LIMIT ${batch + 1}`,
          );
          if (rows.length > batch) { report.more = true; rows.length = batch; }
          for (const r of rows) {
            res.candidates++;
            const ref = `${refText(part.table, r.row_pk)} [compte ${r.account_id ?? '?'} / ${r.other_account_id ?? '?'}]`;
            if (r.qualification === 'DUO') { res.duo++; if (res.duoSamples.length < SAMPLES) res.duoSamples.push(ref); continue; }
            if (r.qualification === 'UNDECIDABLE') { res.undecidable++; continue; }
            try {
              await tx.unsafe('SAVEPOINT cross_account_row');
              await corrigerLigne(tx, part, spec.code, r, runId, o.reason ?? null);
              await tx.unsafe('RELEASE SAVEPOINT cross_account_row');
              res.corrected++;
              if (res.samples.length < SAMPLES) res.samples.push(ref);
            } catch (e) {
              await tx.unsafe('ROLLBACK TO SAVEPOINT cross_account_row');
              res.failed++;
              if (res.failures.length < SAMPLES) res.failures.push(`${ref} — ${(e as Error).message.slice(0, 200)}`);
            }
          }
        }
        if (!o.apply) throw new Simulation();
      });
    } catch (e) {
      if (!(e instanceof Simulation)) {
        res = { ...res, failed: res.failed + 1, failures: [...res.failures, `catégorie ${spec.code} — ${(e as Error).message.slice(0, 200)}`] };
      }
    }
    if (spec.manual) {
      const check = CROSS_ACCOUNT_CHECKS.find((c) => c.code === spec.code);
      if (check) {
        const filtre = o.accountId ? ` WHERE z.account_id = ${Number(o.accountId)} OR z.other_account_id = ${Number(o.accountId)}` : '';
        const [r] = await sql.unsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM (${check.sql}) z${filtre}`).catch(() => [{ n: -1 }]);
        res.manual = Number(r?.n ?? 0);
      }
    }
    o.log?.(`${spec.code} : ${res.candidates} relation(s), ${res.corrected} ${o.apply ? 'corrigée(s)' : 'à corriger'}, ${res.duo} Duo (signalées), ${res.undecidable} indécidable(s), ${res.failed} échec(s)${spec.manual ? `, ${res.manual ?? 0} en attente de décision (procédure d'incident)` : ''}`);
    report.categories.push(res);
    report.corrected += res.corrected;
    report.duo += res.duo;
    report.undecidable += res.undecidable;
    report.failed += res.failed;
  }
  if (o.apply) report.postCheck = await recontroler(sql, o.family);
  return report;
}

/** Lot 54 (SEC-09) : recontrôle de la famille après correction (READ ONLY). */
async function recontroler(sql: postgres.Sql, family: RemediationFamily): Promise<NonNullable<RemediationReport['postCheck']>> {
  const { detectCrossAccountRelations } = await import('./detection');
  const exec: DetectionExecutor = async <T>(fn: (q: (s: string) => Promise<Array<Record<string, unknown>>>) => Promise<T>): Promise<T> => {
    const out = await sql.begin('read only', async (tx) => [await fn(async (s) => (await tx.unsafe(s)) as unknown as Array<Record<string, unknown>>)]);
    return (out as unknown as T[])[0];
  };
  try {
    const r = await detectCrossAccountRelations(exec, CROSS_ACCOUNT_CHECKS.filter((c) => c.family === family));
    return {
      at: r.computedAt,
      remaining: Object.fromEntries(r.checks.map((c) => [c.code, c.count])),
      incomplete: r.checks.filter((c) => c.error).map((c) => c.code),
    };
  } catch (e) {
    return { at: new Date().toISOString(), remaining: {}, incomplete: [`recontrôle indisponible : ${(e as Error).message.slice(0, 120)}`] };
  }
}

async function corrigerLigne(
  tx: postgres.TransactionSql, part: RemediationPart, code: string,
  r: { row_pk: Record<string, unknown>; account_id: number | null; other_account_id: number | null; cols: string[] | null },
  runId: string, reason: string | null,
): Promise<void> {
  const t = ident(part.table);
  const where = pkWhere(part, '$1');
  const pkJson = JSON.stringify(r.row_pk);
  const [avant] = await tx.unsafe<Array<{ row: Record<string, unknown> }>>(`SELECT to_jsonb(t) AS row FROM ${t} t WHERE ${where} FOR UPDATE`, [pkJson] as never[]);
  if (!avant) throw new Error('ligne disparue');
  let change: Record<string, unknown>;
  if (part.mode === 'nullify') {
    const cols = (r.cols ?? []).filter(Boolean);
    if (!cols.length) throw new Error('aucune colonne à détacher');
    await tx.unsafe(`UPDATE ${t} SET ${cols.map((c) => `${ident(c)} = NULL`).join(', ')} WHERE ${where}`, [pkJson] as never[]);
    change = { cols };
  } else if (part.mode === 'status') {
    const set = Object.entries(part.set ?? {});
    await tx.unsafe(`UPDATE ${t} SET ${set.map(([c, v]) => `${ident(c)} = ${v}`).join(', ')} WHERE ${where}`, [pkJson] as never[]);
    change = { set: Object.keys(part.set ?? {}) };
  } else {
    await tx.unsafe(`DELETE FROM ${t} WHERE ${where}`, [pkJson] as never[]);
    change = { deleted: true };
  }
  await tx.unsafe(
    `INSERT INTO cross_account_remediations (run_id, category, table_name, row_pk, mode, before_row, change, account_id, other_account_id, reason)
     VALUES ($1::uuid, $2, $3, $4::text::jsonb, $5, $6::text::jsonb, $7::text::jsonb, $8, $9, $10)`,
    [runId, code, part.table, pkJson, part.mode, JSON.stringify(avant.row), JSON.stringify(change), r.account_id, r.other_account_id, reason] as never[],
  );
}

// ── Restauration ────────────────────────────────────────────────────────────

export interface RemediationRestoreReport {
  runId: string;
  restoreRunId: string;
  restored: number;
  conflicts: Array<{ ref: string; reason: string }>;
}

/**
 * Restaure une application (`runId`) ligne à ligne, de la plus récente à la
 * plus ancienne. Une ligne modifiée depuis (colonne de nouveau renseignée,
 * statut changé, ligne recréée) n'est PAS restaurée : conflit signalé. Les
 * liens retirés sont réinsérés à l'identique (garde 0332 suspendue pour
 * cette seule transaction, `verebona.cross_account_restore`).
 */
export async function restoreCrossAccountRemediation(sql: postgres.Sql, runId: string): Promise<RemediationRestoreReport> {
  const restoreRunId = randomUUID();
  const out: RemediationRestoreReport = { runId, restoreRunId, restored: 0, conflicts: [] };
  await sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL lock_timeout = '5s'`);
    await tx.unsafe(`SET LOCAL verebona.cross_account_restore = 'on'`);
    const rows = await tx.unsafe<Array<{ id: number; category: string; table_name: string; row_pk: Record<string, unknown>; mode: RemediationMode; before_row: Record<string, unknown>; change: { cols?: string[]; set?: string[] } }>>(
      `SELECT id, category, table_name, row_pk, mode, before_row, change FROM cross_account_remediations
        WHERE run_id = $1::uuid AND restored_at IS NULL ORDER BY id DESC`, [runId] as never[],
    );
    for (const r of rows) {
      const spec = remediationSpec(r.category);
      const part = spec?.parts.find((p) => p.table === r.table_name && p.mode === r.mode);
      const ref = refText(r.table_name, r.row_pk);
      let outcome = 'restored';
      await tx.unsafe('SAVEPOINT cross_account_restore_row');
      try {
        if (!part) throw new Error('catégorie inconnue');
        const t = ident(part.table);
        const where = pkWhere(part, '$1');
        const avant = JSON.stringify(r.before_row);
        const pkJson = JSON.stringify(r.row_pk);
        let n: number;
        if (r.mode === 'nullify') {
          const cols = (r.change.cols ?? []).map(ident);
          const res = await tx.unsafe(
            `UPDATE ${t} SET (${cols.join(', ')}) = (SELECT ${cols.map((c) => `r.${c}`).join(', ')} FROM jsonb_populate_record(NULL::${t}, $2::text::jsonb) r)
              WHERE ${where} AND ${cols.map((c) => `${c} IS NULL`).join(' AND ')}`, [pkJson, avant] as never[],
          );
          n = res.count;
        } else if (r.mode === 'status') {
          const cols = (r.change.set ?? Object.keys(part.set ?? {})).map(ident);
          const res = await tx.unsafe(
            `UPDATE ${t} SET (${cols.join(', ')}) = (SELECT ${cols.map((c) => `r.${c}`).join(', ')} FROM jsonb_populate_record(NULL::${t}, $2::text::jsonb) r)
              WHERE ${where} AND (${part.still ?? 'TRUE'})`, [pkJson, avant] as never[],
          );
          n = res.count;
        } else {
          const res = await tx.unsafe(
            `INSERT INTO ${t} SELECT * FROM jsonb_populate_record(NULL::${t}, $1::text::jsonb) ON CONFLICT DO NOTHING`, [avant] as never[],
          );
          n = res.count;
        }
        if (n === 0) {
          await tx.unsafe('ROLLBACK TO SAVEPOINT cross_account_restore_row');
          outcome = 'conflict: ligne modifiée, recréée ou disparue depuis la correction';
        } else {
          await tx.unsafe('RELEASE SAVEPOINT cross_account_restore_row');
        }
      } catch (e) {
        await tx.unsafe('ROLLBACK TO SAVEPOINT cross_account_restore_row');
        outcome = `conflict: ${(e as Error).message.slice(0, 200)}`;
      }
      if (outcome === 'restored') out.restored++;
      else out.conflicts.push({ ref, reason: outcome.slice(10) });
      await tx.unsafe(
        `UPDATE cross_account_remediations SET restored_at = now(), restore_run_id = $2::uuid, restore_outcome = $3 WHERE id = $1`,
        [r.id, restoreRunId, outcome] as never[],
      );
    }
  });
  return out;
}

/** Les catégories du contrôle et de la correction coïncident (test). */
export function uncoveredChecks(): string[] {
  const codes = new Set(REMEDIATION_SPECS.map((s) => s.code));
  return CROSS_ACCOUNT_CHECKS.map((c) => c.code).filter((c) => !codes.has(c));
}
