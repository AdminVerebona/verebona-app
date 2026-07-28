/**
 * Tests des candidats agenda — CDC §4.4.
 *
 * L'analyse produit les candidats de façon DÉTERMINISTE, sans appel modèle :
 * c'est ce qui supprime le double appel `extract_agenda` + `agenda_detect` de
 * l'existant.
 */
import { describe, it, expect } from 'vitest';
import { buildAgendaCandidates } from '../steps/build-agenda-candidates.step';
import type { ExtractedField } from '../types';

function field(fieldKey: string, value: unknown): ExtractedField {
  return { fieldKey, value, confidence: 'certain', excerpt: 'extrait' };
}

describe('production des candidats agenda', () => {
  it('reconnaît un champ porteur d\'échéance', () => {
    const out = buildAgendaCandidates([field('insuranceExpiry', '2027-03-01')], 'Contrat AXA');
    expect(out).toHaveLength(1);
    expect(out[0].date).toBe('2027-03-01');
    expect(out[0].title).toContain('AXA');
    expect(out[0].originFieldKey).toBe('insuranceExpiry');
  });

  it('ignore les champs sans portée calendaire', () => {
    expect(buildAgendaCandidates([field('registrationNumber', 'AB-123-CD')])).toHaveLength(0);
  });

  it('rejette une date mal formée plutôt que de la deviner', () => {
    expect(buildAgendaCandidates([field('nextInspection', '01/03/2027')])).toHaveLength(0);
    expect(buildAgendaCandidates([field('nextInspection', '2027-3-1')])).toHaveLength(0);
  });

  it('ne propose aucune catégorie : elle relève de l\'usage 4', () => {
    const out = buildAgendaCandidates([field('warrantyEndDate', '2028-01-15')]);
    expect(out[0].suggestedCategory).toBeUndefined();
  });

  it('ne crée pas deux candidats pour le même champ et la même date', () => {
    const out = buildAgendaCandidates([
      field('dpeDate', '2030-06-01'),
      field('dpeDate', '2030-06-01'),
    ]);
    expect(out).toHaveLength(1);
  });
});
