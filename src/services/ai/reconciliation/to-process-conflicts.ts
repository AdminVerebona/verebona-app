/**
 * Conflits de réconciliation → page « À traiter », catégorie « À arbitrer ».
 * CDC §4.2.9 et §5.4.4 — critère d'acceptation n°13.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI CE FICHIER
 *
 * `conflict-writer.ts` écrit déjà les contradictions dans
 * `inconsistency_registry`, avec les preuves des deux côtés. Mais rien ne les
 * lisait : `to-process.service.ts` construit la page « À traiter » à partir des
 * documents, de l'agenda, des équipements et des fournisseurs — pas des
 * conflits.
 *
 * Conséquence, une fois la réconciliation active : les contradictions détectées
 * seraient écrites en base sans que personne ne les voie jamais. Le moteur
 * aurait fait son travail, l'utilisateur n'en saurait rien, et la valeur
 * resterait fausse dans sa fiche.
 *
 * Ce module est la lecture manquante.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';
import { isCriticalField } from './decision/critical-fields';
import type { ToProcessItem } from '@/types/to-process';

/** PostgreSQL `undefined_table` — migrations 0104/0109 non appliquées. */
const UNDEFINED_TABLE = '42P01';

/**
 * Libellés métier des champs.
 *
 * L'utilisateur voit « Surface habitable », jamais `livingArea`. Un champ
 * absent de cette table retombe sur sa clé technique : c'est laid, mais
 * visible — donc corrigé rapidement. Masquer le champ serait pire : une
 * contradiction invisible est exactement le défaut que ce module corrige.
 */
const FIELD_LABELS: Record<string, string> = {
  address1: 'Adresse',
  address2: "Complément d'adresse",
  postalCode: 'Code postal',
  city: 'Ville',
  registrationNumber: "Plaque d'immatriculation",
  acquisitionPrice: "Prix d'achat",
  estimatedValue: 'Valeur estimée',
  livingArea: 'Surface habitable',
  landArea: 'Surface du terrain',
  vin: 'Numéro de châssis',
  serialNumber: 'Numéro de série',
  insurancePremium: "Prime d'assurance",
  contractNumber: 'Numéro de contrat',
  warrantyEndDate: 'Fin de garantie',
  occupancyStatus: "Statut d'occupation",
  iban: 'Coordonnées bancaires',
};

export function fieldLabel(fieldKey: string): string {
  return FIELD_LABELS[fieldKey] ?? fieldKey;
}

interface ConflictRow {
  id: number;
  asset_id: number;
  field_key: string;
  current_value: string | null;
  proposed_value: string | null;
  source_detail: string | null;
  inconsistency_type: string | null;
  created_at: string;
  asset_name: string | null;
}

/**
 * Conflits ouverts d'un compte, sous la forme attendue par la page
 * « À traiter ».
 *
 * Ne lève jamais : une table absente rend une liste vide. La page « À traiter »
 * est un écran de tous les jours — elle ne doit pas tomber parce qu'une
 * migration du chantier IA n'est pas encore passée.
 */
export async function listOpenReconciliationConflicts(
  accountId: number,
): Promise<ToProcessItem[]> {
  let rows: ConflictRow[];

  try {
    rows = (await pgClient.unsafe(
      `SELECT i.id, i.asset_id, i.field_key, i.current_value, i.proposed_value,
              i.source_detail, i.inconsistency_type, i.created_at,
              a.name AS asset_name
         FROM inconsistency_registry i
         LEFT JOIN assets a ON a.id = i.asset_id AND a.deleted_at IS NULL
        WHERE i.account_id = $1
          AND i.status = 'open'
          AND i.source_type = 'reconciliation'
        ORDER BY i.created_at DESC
        LIMIT 200`,
      [accountId] as never[],
    )) as unknown as ConflictRow[];
  } catch (e) {
    const err = e as { code?: string; message?: string };
    if (err.code !== UNDEFINED_TABLE) {
      console.error('[to-process] Lecture des conflits impossible :', err.message);
    }
    return [];
  }

  return rows.map(toItem);
}

function toItem(row: ConflictRow): ToProcessItem {
  const label = fieldLabel(row.field_key);
  const assetName = row.asset_name ?? 'Bien supprimé';

  return {
    id: `reconciliation_conflict_${row.id}`,
    objectType: 'asset',
    objectId: row.asset_id,
    family: 'arbitrate',
    reason: 'value_conflict',
    // Un champ critique arbitré à tort coûte plus cher que les autres : il
    // remonte en tête. C'est la seule hiérarchie que le CDC établit entre
    // champs (§4.2.6), et elle vaut aussi pour l'ordre d'affichage.
    priority: isCriticalField(row.field_key) ? 'high' : 'medium',
    actionTitle: `Choisir la bonne valeur — ${label}`,
    objectTitle: `${label} · ${assetName}`,
    badge: row.inconsistency_type === 'conflictual' ? 'Valeurs contradictoires' : 'Valeur à confirmer',
    context: {
      conflictingField: row.field_key,
      // Les deux valeurs côte à côte, avec leur origine. L'utilisateur doit
      // pouvoir trancher sans ouvrir les documents — et pouvoir les ouvrir
      // quand même s'il hésite (§4.2.9).
      conflictingValues: [
        { label: 'Valeur actuelle', value: row.current_value ?? '(vide)' },
        { label: 'Valeur proposée', value: row.proposed_value ?? '(vide)' },
      ],
      currentValue: row.current_value ?? undefined,
      detectedValue: row.proposed_value ?? undefined,
      assetName: row.asset_name ?? undefined,
      source: 'document_ai',
      createdAt: new Date(row.created_at).toISOString(),
    },
    primaryAction: 'resolve',
    secondaryActions: ['view_detail', 'view_source_document', 'snooze'],
    status: 'active',
    createdAt: new Date(row.created_at).toISOString(),
  };
}
