/**
 * Registre central et versionné des contrôles de cohérence — lot 82B (CDC
 * §3.2, CA-01 ; arbitrages C-Q1, C-Q11).
 *
 * Ordre = ordre d'exécution par compte. Une évolution fonctionnelle (C-Q11)
 * ajoute ou modifie ici le contrôle concerné et incrémente sa `version` :
 * la version du registre change, la preuve de chaque objet porte la version
 * de règles appliquée, et la campagne quotidienne réexamine tout le stock.
 */
import { createHash } from 'node:crypto';
import type { CoherenceCheck } from './types';
import { toProcessDocumentFieldsCheck } from './checks/to-process';
import { documentLinksCheck } from './checks/document-links';
import { agendaOccurrencesCheck, agendaOrphansCheck } from './checks/agenda';
import { tcoExtractedExpensesCheck } from './checks/tco';
import { extractChainCheck } from './checks/extract-chain';

export const COHERENCE_REGISTRY: readonly CoherenceCheck[] = [
  toProcessDocumentFieldsCheck,
  documentLinksCheck,
  agendaOccurrencesCheck,
  agendaOrphansCheck,
  tcoExtractedExpensesCheck,
  extractChainCheck,
];

/** Contrôles exécutés par l'orchestrateur (les points d'extension PLANNED sont exclus). */
export function activeChecks(registry: readonly CoherenceCheck[] = COHERENCE_REGISTRY): CoherenceCheck[] {
  return registry.filter((c) => c.status === 'ACTIVE' && !!c.listObjects && !!c.inspect);
}

export function getCheck(id: string, registry: readonly CoherenceCheck[] = COHERENCE_REGISTRY): CoherenceCheck | undefined {
  return registry.find((c) => c.id === id);
}

/** Version du registre : dérivée des couples (contrôle, version, statut). */
export function registryVersion(registry: readonly CoherenceCheck[] = COHERENCE_REGISTRY): string {
  const sig = registry.map((c) => `${c.id}@${c.version}:${c.status}`).sort().join('|');
  return `r1-${createHash('sha256').update(sig).digest('hex').slice(0, 12)}`;
}

export type { CoherenceCheck } from './types';
