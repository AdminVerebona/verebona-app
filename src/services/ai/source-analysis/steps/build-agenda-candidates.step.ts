/**
 * Étape 11 — production des candidats agenda.
 *
 * DÉTERMINISTE : aucun appel modèle. Les dates ont déjà été extraites avec leur
 * preuve par `extract_source` ; il ne reste qu'à reconnaître celles qui portent
 * une échéance. La classification action / information et la déduplication
 * relèvent de l'usage 4 (CDC §4.4.3), pas de l'analyse.
 *
 * Cette séparation supprime le double appel constaté dans l'existant, où
 * `extract_agenda_v1` puis `agenda_detect_v1` traitaient la même information.
 */
import type { ExtractedField, AgendaCandidate } from '../types';

/** Champs de date porteurs d'échéance, avec le libellé d'événement associé. */
const DEADLINE_FIELDS: Record<string, string> = {
  insuranceExpiry: "Fin de période d'assurance",
  nextInspection: 'Contrôle technique',
  warrantyEndDate: 'Fin de garantie',
  contractEndDate: 'Fin de contrat',
  dpeDate: 'Échéance DPE',
  leaseEndDate: 'Fin de bail',
  maintenanceDueDate: 'Entretien à prévoir',
  registrationExpiry: "Fin de validité d'immatriculation",
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function buildAgendaCandidates(
  fields: ExtractedField[],
  documentTitle?: string,
): AgendaCandidate[] {
  const candidates: AgendaCandidate[] = [];

  for (const field of fields) {
    const label = DEADLINE_FIELDS[field.fieldKey];
    if (!label) continue;

    const value = typeof field.value === 'string' ? field.value : null;
    if (!value || !ISO_DATE.test(value)) continue;

    candidates.push({
      title: documentTitle ? `${label} — ${documentTitle}` : label,
      date: value,
      confidence: field.confidence,
      excerpt: field.excerpt,
      originFieldKey: field.fieldKey,
      // Aucune catégorie suggérée : c'est la responsabilité de l'usage 4.
    });
  }

  return dedupeByDateAndField(candidates);
}

/** Deux champs différents portant la même date ne créent qu'un candidat. */
function dedupeByDateAndField(candidates: AgendaCandidate[]): AgendaCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((c) => {
    const key = `${c.date}:${c.originFieldKey}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
