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
import { findDeclaredModel } from '../../registry/models';
import { masterOutputSchemaFor } from '../master-output-schemas';
import { resolveRuntimeContract, providerSchemaHash } from '../output-resolution/runtime-contract';
import { providerJsonSchema, providerSchemaPropertyCap, PROVIDER_SCHEMA_ADAPTER_VERSION } from '../output-resolution/provider-schema';
import type { GeminiSchemaMetrics } from '../providers/gemini-schema-contract';

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
  /**
   * Lot 115 (carte #784, §A) — profil de complexité MESURÉ de la projection
   * (propriétés, noms, énumérations, unions, listes, profondeur, bornes
   * imbriquées, taille). Mesure, jamais cause : le refus du fournisseur n'est
   * expliqué par aucune de ces dimensions tant qu'un essai réel ne l'a pas
   * corrélé.
   */
  metrics: GeminiSchemaMetrics | null;
  /** Plafond de propriétés posé en exploitation (`AI_PROVIDER_SCHEMA_MAX_PROPERTIES`) ; `null` : aucun. */
  propertyCap: number | null;
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
      metrics: ps.metrics ?? null, propertyCap: providerSchemaPropertyCap(),
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

/**
 * Lot 115 (carte #784, §E1) — LE MODÈLE EST-IL ENCORE UN COUPLE ACTIF ?
 *
 * Écart constaté par la carte : `isCurrentCouple` compare le contrat, le
 * schéma projeté, l'adaptateur et l'opération, mais JAMAIS si le fournisseur
 * et le modèle sont encore réellement configurés pour cette opération. Une
 * alerte portant sur un modèle retiré du routage pouvait donc rester active
 * indéfiniment ; et une compatibilité remplacée pouvait être requalifiée à
 * tort.
 *
 * Trois réponses SEULEMENT, et la troisième n'autorise rien :
 *
 *   · `ACTIVE`    le modèle est dans la chaîne réellement configurée de
 *                 l'opération (principal ou repli) : l'alerte garde son objet ;
 *   · `WITHDRAWN` le routage a été lu SANS erreur, le modèle n'y est plus, ET
 *                 il n'est plus dans le référentiel des modèles déclarés :
 *                 PREUVE de retrait — l'alerte peut être close avec ce motif ;
 *   · `UNKNOWN`   le routage n'a pas pu être lu (base, délai), ou le modèle
 *                 est absent de la chaîne mais TOUJOURS déclaré (retrait
 *                 possiblement temporaire, ou simple changement de rang) :
 *                 rien n'est conclu, RIEN n'est fermé. Une indisponibilité
 *                 ponctuelle ou un état inconnu ne doit jamais clore une
 *                 alerte, ni la rouvrir le lendemain.
 *
 * `readChain` : lecture de la chaîne configurée (injectable pour les tests) ;
 * c'est la SEULE partie non pure de ce module.
 */
export type CoupleRoutingStatus = 'ACTIVE' | 'WITHDRAWN' | 'UNKNOWN';

export async function coupleRoutingStatus(
  k: { operationCode: string; model: string },
  readChain?: (operationCode: string) => Promise<readonly string[]>,
): Promise<CoupleRoutingStatus> {
  // L'opération elle-même a disparu du registre (ou n'est plus maître active) :
  // c'est une preuve de code, pas une indisponibilité — le couple est historique.
  const op = AI_OPERATIONS[k.operationCode];
  if (!op || !op.active || !isMasterOperation(op)) return 'WITHDRAWN';
  let chaine: readonly string[];
  try {
    chaine = readChain
      ? await readChain(k.operationCode)
      : await (async () => {
        const { resolveOperationConfig } = await import('../../config/config-resolver');
        const cfg = await resolveOperationConfig(k.operationCode);
        return [cfg.primaryModel, ...cfg.fallbackModels];
      })();
  } catch {
    // Configuration illisible : on ne sait pas. On ne ferme pas.
    return 'UNKNOWN';
  }
  if (chaine.includes(k.model)) return 'ACTIVE';
  // Absent de la chaîne : retrait DÉFINITIF seulement si le modèle n'est plus
  // déclaré du tout. Sinon, il peut revenir (changement de rang, essai) : inconnu.
  return findDeclaredModel(k.model) ? 'UNKNOWN' : 'WITHDRAWN';
}
