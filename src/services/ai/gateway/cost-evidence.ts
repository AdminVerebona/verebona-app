/**
 * Carte #838 (C2, AC17/AC19) — NATURE DU COÛT d'un ensemble de requêtes
 * fournisseur RÉELLEMENT envoyées (tentatives d'analyse, essai sans schéma,
 * réparation, essai diagnostique). PUR.
 *
 * Un montant n'est jamais présenté comme exhaustif quand une partie n'est pas
 * chiffrable :
 *   · `OBSERVED`      toutes les tentatives sont chiffrées sur une consommation
 *                     rendue (au moins une non nulle) ;
 *   · `ZERO_REPORTED` le fournisseur a explicitement rendu une consommation
 *                     NULLE pour toutes les tentatives (0 € prouvé) ;
 *   · `PARTIAL`       une partie est chiffrée, une partie INCONNUE (refus HTTP
 *                     400 sans consommation, délai, tarif absent) — le montant
 *                     observé est un MINIMUM, la part inconnue est comptée ;
 *   · `UNKNOWN`       aucune tentative chiffrable : coût inconnu, jamais 0 ;
 *   · `NONE`          aucune requête envoyée (refus avant appel) : 0 € réel.
 *
 * Réutilise le chiffrage déjà calculé par tentative (`ProviderAttemptTrace`,
 * tarifs autorisés de `calcCostMicros`) : aucun tarif nouveau.
 */
import type { AttemptCostStatus, ProviderAttemptTrace } from './diagnostics/taxonomy';

export type CostEvidenceStatus = 'OBSERVED' | 'ZERO_REPORTED' | 'PARTIAL' | 'UNKNOWN' | 'NONE';

export interface CostEvidence {
  status: CostEvidenceStatus;
  /** Requêtes fournisseur réellement envoyées (tentatives tracées). */
  attempts: number;
  /** Somme des coûts CHIFFRÉS (observés ou zéro prouvé), en micro-unités : un minimum si `PARTIAL`. */
  observedMicros: number;
  observedAttempts: number;
  zeroReportedAttempts: number;
  /** Tentatives au coût non chiffrable (`UNKNOWN`, `NO_PRICE`) : la part inconnue, jamais rabattue à 0. */
  unknownAttempts: number;
}

export const NO_COST_EVIDENCE: CostEvidence = Object.freeze({
  status: 'NONE', attempts: 0, observedMicros: 0, observedAttempts: 0, zeroReportedAttempts: 0, unknownAttempts: 0,
}) as CostEvidence;

function statusOf(e: Omit<CostEvidence, 'status'>): CostEvidenceStatus {
  if (e.attempts === 0) return 'NONE';
  if (e.unknownAttempts === e.attempts) return 'UNKNOWN';
  if (e.unknownAttempts > 0) return 'PARTIAL';
  if (e.observedAttempts === 0) return 'ZERO_REPORTED';
  return 'OBSERVED';
}

/** Nature du coût d'une liste de tentatives (une tentative sans statut : coût INCONNU). */
export function costEvidenceOf(attempts: ReadonlyArray<Pick<ProviderAttemptTrace, 'costStatus' | 'costMicros'>>): CostEvidence {
  const e = { attempts: 0, observedMicros: 0, observedAttempts: 0, zeroReportedAttempts: 0, unknownAttempts: 0 };
  for (const a of attempts) {
    e.attempts++;
    const st: AttemptCostStatus = a.costStatus ?? 'UNKNOWN';
    if (st === 'OBSERVED' && typeof a.costMicros === 'number') { e.observedAttempts++; e.observedMicros += a.costMicros; }
    else if (st === 'ZERO_REPORTED') e.zeroReportedAttempts++;
    else e.unknownAttempts++;
  }
  return { ...e, status: statusOf(e) };
}

/** Somme de plusieurs natures de coût (analyse + réparation…) : une part inconnue reste visible. */
export function combineCostEvidence(...parts: ReadonlyArray<CostEvidence | null | undefined>): CostEvidence {
  const e = { attempts: 0, observedMicros: 0, observedAttempts: 0, zeroReportedAttempts: 0, unknownAttempts: 0 };
  for (const p of parts) {
    if (!p) continue;
    e.attempts += p.attempts; e.observedMicros += p.observedMicros; e.observedAttempts += p.observedAttempts;
    e.zeroReportedAttempts += p.zeroReportedAttempts; e.unknownAttempts += p.unknownAttempts;
  }
  return { ...e, status: statusOf(e) };
}
