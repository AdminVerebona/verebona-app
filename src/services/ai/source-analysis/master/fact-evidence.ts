/**
 * Contrôle de preuve d'un fait T1 après validation Zod — CDC 15 §23 U2, T1-08.
 *
 * Le schéma ne peut pas exprimer « excerpt obligatoire SI TEXT_EXTRACTION » ;
 * ce contrôle le fait, avec la même politique que `splitByEvidence` du chemin
 * historique :
 *   · lu (TEXT_EXTRACTION) sans extrait littéral → écarté ;
 *   · observé (VISUAL_ANALYSIS) sans `visualEvidence.description` → écarté ;
 *   · observé AVEC un extrait → l'extrait est retiré (il serait inventé : le
 *     modèle n'a rien lu), l'observation est conservée ;
 *   · lu avec une `visualEvidence` → celle-ci est retirée.
 * Un fait sans valeur (null / chaîne vide) n'est pas une information.
 */
import type { T1Fact } from './t1-contract';

export type FactEvidenceCheck =
  | { ok: true; fact: T1Fact }
  | { ok: false; reason: 'NO_VALUE' | 'TEXT_WITHOUT_EXCERPT' | 'VISUAL_WITHOUT_EVIDENCE' };

function vide(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

export function checkFactEvidence(fact: T1Fact): FactEvidenceCheck {
  if (vide(fact.normalizedValue) && vide(fact.rawValue)) return { ok: false, reason: 'NO_VALUE' };

  if (fact.provenance === 'VISUAL_ANALYSIS') {
    if (!fact.visualEvidence?.description?.trim()) return { ok: false, reason: 'VISUAL_WITHOUT_EVIDENCE' };
    const { excerpt: _inventé, ...evidence } = fact.evidence ?? {};
    void _inventé;
    return { ok: true, fact: { ...fact, evidence } };
  }

  if (!fact.evidence?.excerpt?.trim()) return { ok: false, reason: 'TEXT_WITHOUT_EXCERPT' };
  return { ok: true, fact: { ...fact, visualEvidence: undefined } };
}

/** Libellé court d'un fait pour les avertissements (jamais sa valeur). */
export function factLabel(fact: Pick<T1Fact, 'canonicalKey' | 'rawKey' | 'label' | 'attribute'>): string {
  return fact.canonicalKey ?? fact.rawKey ?? fact.label ?? fact.attribute ?? 'fait';
}
