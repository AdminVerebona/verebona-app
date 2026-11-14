/**
 * Lot 114 (carte #776, §5 — premier filtre, STATIQUE) — projection COURANTE
 * du schéma fournisseur de chaque opération maître active : contrat runtime
 * (identifiant, version, empreinte), schéma projeté (empreinte, taille),
 * contraintes non transmises, écarts au contrat du fournisseur, branches
 * perdues. Calcul local, sans réseau et sans base : c'est ce que la
 * passerelle transmettrait MAINTENANT.
 *
 * Ce filtre ne prouve PAS l'acceptation par le fournisseur (second filtre :
 * appels réels, `ai_schema_compatibility`).
 */
import { AI_OPERATIONS, isMasterOperation } from '../../registry/operations';
import { masterOutputSchemaFor } from '../master-output-schemas';
import { resolveRuntimeContract, providerSchemaHash } from '../output-resolution/runtime-contract';
import { providerJsonSchema, PROVIDER_SCHEMA_ADAPTER_VERSION } from '../output-resolution/provider-schema';

export interface StaticSchemaRow {
  operationCode: string;
  contractId: string;
  contractVersion: number;
  schemaVersion: string;
  /** Empreinte du contrat runtime canonique. */
  schemaHash: string;
  /** Empreinte du schéma projeté ; `null` : non transmissible. */
  providerSchemaHash: string | null;
  adapterVersion: string;
  /** Nœuds et taille sérialisée du schéma projeté. */
  nodes: number;
  serializedChars: number | null;
  /** Motif statique d'absence de schéma ; `null` : transmissible. */
  omitted: string | null;
  /** Contraintes retirées de la projection (revalidées par Verebona). */
  droppedKeywords: string[];
  /** Écarts au contrat du fournisseur (codes compacts). */
  issues: string[];
  /** Branches du contrat canonique absentes de la projection (toujours vide pour un schéma transmis). */
  lostBranches: string[];
}

/** Projection courante d'UNE opération ; `null` : opération inconnue, inactive, non maître ou sans contrat. */
export function staticSchemaRowOf(operationCode: string): StaticSchemaRow | null {
  const op = AI_OPERATIONS[operationCode];
  if (!op || !op.active || !isMasterOperation(op) || !op.outputSchema || op.outputSchema === 'none') return null;
  const caller = masterOutputSchemaFor(op.outputSchema);
  if (!caller) return null;
  try {
    const { contract } = resolveRuntimeContract({ schemaName: op.outputSchema, operationCode, callerSchema: caller });
    const ps = providerJsonSchema(contract.canonical);
    return {
      operationCode, contractId: contract.contractId, contractVersion: contract.contractVersion, schemaVersion: contract.schemaVersion,
      schemaHash: contract.schemaHash, providerSchemaHash: providerSchemaHash(ps.schema), adapterVersion: PROVIDER_SCHEMA_ADAPTER_VERSION,
      nodes: ps.nodes, serializedChars: ps.schema ? JSON.stringify(ps.schema).length : null, omitted: ps.omitted,
      droppedKeywords: ps.dropped, issues: ps.issues ?? [], lostBranches: ps.lostBranches ?? [],
    };
  } catch {
    return null;
  }
}

/** Projection courante de toutes les opérations maîtres actives (ordre du registre). */
export function staticSchemaMatrix(): StaticSchemaRow[] {
  const rows: StaticSchemaRow[] = [];
  for (const code of Object.keys(AI_OPERATIONS)) {
    const r = staticSchemaRowOf(code);
    if (r) rows.push(r);
  }
  return rows;
}

/**
 * Un couple mémorisé correspond-il encore à ce que la passerelle transmet ?
 * `false` : contrat, schéma projeté ou adaptateur changés (ou opération
 * retirée) — l'état mémorisé est HISTORIQUE, il ne commande plus rien.
 */
export function isCurrentCouple(k: { operationCode: string; contractId: string; contractVersion: number; schemaHash: string; providerSchemaHash: string | null; adapterVersion: string }): boolean {
  const cur = staticSchemaRowOf(k.operationCode);
  if (!cur) return false;
  return cur.contractId === k.contractId && cur.contractVersion === k.contractVersion && cur.schemaHash === k.schemaHash
    && cur.providerSchemaHash === k.providerSchemaHash && cur.adapterVersion === k.adapterVersion;
}
