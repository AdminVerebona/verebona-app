/**
 * Statuts et dates — CDC §4.4.4.
 *
 * Le passage automatique à « réalisé » est le point le plus sensible de
 * l'usage 4 : marquer réalisé un contrôle technique qui ne l'a pas été est une
 * erreur silencieuse aux conséquences réelles.
 */
import { describe, it, expect } from 'vitest';
import { decideStatus } from '../status-reconciler';
import { interpretDate, isPastDue } from '../rules/date-interpreter';
import type { ExistingAgendaItem } from '../types';

const NOW = new Date('2026-07-28T00:00:00Z');

function item(over: Partial<ExistingAgendaItem> = {}): ExistingAgendaItem {
  return {
    id: 1, title: 'Contrôle technique', date: '2026-01-01',
    category: 'action', status: 'pending', manual: false,
    originFieldKey: 'nextInspection', ...over,
  };
}

describe('passage automatique au statut réalisé', () => {
  it('exige une preuve explicite ET une confiance certaine', () => {
    const r = decideStatus(item(), {
      excerpt: 'contrôle technique effectué le 15/01/2026, résultat favorable',
      confidence: 'certain', documentType: 'RAPPORT_ENTRETIEN',
      documentDate: new Date('2026-01-15'),
    });
    expect(r.decision).toBe('mark_done');
  });

  it('se contente de proposer si la confiance n\'est que probable', () => {
    const r = decideStatus(item(), {
      excerpt: 'intervention terminée',
      confidence: 'probable', documentType: 'FACTURE', documentDate: null,
    });
    expect(r.decision).toBe('propose_done');
  });

  it('refuse sur un type de document non probant', () => {
    const r = decideStatus(item(), {
      excerpt: 'contrôle effectué', confidence: 'certain',
      documentType: 'ANNONCE_COMMERCIALE', documentDate: null,
    });
    expect(r.decision).toBe('keep');
  });

  it('refuse en l\'absence de formulation explicite', () => {
    const r = decideStatus(item(), {
      excerpt: 'facture pour prestation automobile', confidence: 'certain',
      documentType: 'FACTURE', documentDate: null,
    });
    expect(r.decision).toBe('keep');
  });

  it('UNE ÉCHÉANCE DÉPASSÉE N\'EST PAS UNE PREUVE DE RÉALISATION', () => {
    // Le point le plus important de ce module : beaucoup d'échéances sont
    // simplement en retard.
    expect(isPastDue('2026-01-01', NOW)).toBe(true);
    expect(decideStatus(item({ date: '2026-01-01' }), null).decision).toBe('keep');
  });

  it('ne touche jamais à un événement créé manuellement', () => {
    const r = decideStatus(item({ manual: true }), {
      excerpt: 'contrôle technique effectué, résultat favorable',
      confidence: 'certain', documentType: 'RAPPORT_ENTRETIEN', documentDate: null,
    });
    expect(r.decision).toBe('keep');
    expect(r.reason).toContain('manuellement');
  });
});

describe('interprétation des dates', () => {
  it('accepte une date ISO plausible', () => {
    expect(interpretDate('2027-03-01', NOW).qualification).toBe('explicit');
  });

  it.each(['01/03/2027', '2027-3-1', 'bientôt', '', null])(
    'rejette « %s »', (raw) => {
      expect(interpretDate(raw as string, NOW).qualification).toBe('invalid');
    },
  );

  it('rejette une date calendairement impossible plutôt que de la décaler', () => {
    // `2026-02-31` passe le format mais JavaScript le décalerait au 3 mars :
    // une valeur fausse silencieuse.
    expect(interpretDate('2026-02-31', NOW).qualification).toBe('invalid');
  });

  it('écarte une date trop lointaine ou trop ancienne', () => {
    expect(interpretDate('2099-01-01', NOW).qualification).toBe('out_of_range');
    expect(interpretDate('2000-01-01', NOW).qualification).toBe('out_of_range');
  });

  it('calcule correctement l\'écart en jours', () => {
    expect(interpretDate('2026-08-07', NOW).daysFromNow).toBe(10);
    expect(interpretDate('2026-07-18', NOW).daysFromNow).toBe(-10);
  });
});
