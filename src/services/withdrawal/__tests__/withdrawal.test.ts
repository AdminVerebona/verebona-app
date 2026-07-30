/**
 * Déclaration de rétractation — CDC 6 §5.5, §7.4, §11.
 *
 * Les deux règles qui ne doivent jamais céder sont testées ici : une anomalie
 * ne produit pas un refus, et une référence n'est pas devinable.
 */
import { describe, it, expect } from 'vitest';
import {
  initialStatus,
  generatePublicReference,
  hashToken,
  DATA_RECOVERY_DAYS,
} from '@/services/withdrawal/withdrawal.service';
import { ineligibilityMessage } from '@/services/withdrawal/eligibility.service';

describe('statut initial d’une déclaration (§5.5)', () => {
  it('accepte une demande éligible', () => {
    expect(initialStatus('eligible')).toBe('received');
  });

  it('met en examen une éligibilité indéterminable', () => {
    // « Une anomalie technique ne doit pas empêcher l'enregistrement. »
    expect(initialStatus('undetermined')).toBe('manual_review');
  });

  it('met en examen — et non en refus — un cas inéligible', () => {
    // « Aucun motif de refus définitif n'est affiché avant examen. »
    // Le consommateur a exprimé sa volonté : elle laisse une trace.
    expect(initialStatus('ineligible')).toBe('manual_review');
  });

  it('ne produit jamais un statut de refus automatique', () => {
    const verdicts = ['eligible', 'undetermined', 'ineligible'] as const;
    for (const v of verdicts) {
      expect(initialStatus(v)).not.toBe('rejected');
      expect(initialStatus(v)).not.toBe('failed');
    }
  });
});

describe('référence publique', () => {
  const REF = /^RET-\d{8}-[A-HJ-NP-Z2-9]{6}$/;

  it('suit le format RET-AAAAMMJJ-XXXXXX', () => {
    expect(generatePublicReference(new Date('2026-08-15T10:00:00Z'))).toMatch(REF);
  });

  it('porte la date de la demande', () => {
    expect(generatePublicReference(new Date('2026-08-15T10:00:00Z'))).toContain('RET-20260815-');
  });

  it('évite les caractères ambigus à l’oral', () => {
    // La référence est lue au téléphone au support : ni I, ni O, ni 0, ni 1.
    for (let i = 0; i < 200; i += 1) {
      const suffix = generatePublicReference().split('-')[2];
      expect(suffix).not.toMatch(/[IO01]/);
    }
  });

  it('n’est pas séquentielle', () => {
    // Une référence incrémentale révélerait le volume de rétractations et
    // permettrait de deviner celle d'un autre consommateur.
    const now = new Date('2026-08-15T10:00:00Z');
    const refs = new Set(Array.from({ length: 500 }, () => generatePublicReference(now)));
    expect(refs.size).toBeGreaterThan(495);
  });
});

describe('empreinte de jeton', () => {
  it('est stable et non réversible', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'));
    expect(hashToken('abc')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken('abc')).not.toContain('abc');
  });

  it('change au moindre caractère', () => {
    expect(hashToken('abc')).not.toBe(hashToken('abd'));
  });
});

describe('délai de récupération des données (§3.4)', () => {
  it('est de trente jours', () => {
    expect(DATA_RECOVERY_DAYS).toBe(30);
  });
});

describe('messages de non-éligibilité (§12.1)', () => {
  it('reste générique pour chaque motif', () => {
    const reasons = [
      'NO_PAID_CONTRACT', 'DEADLINE_PASSED', 'ALREADY_WITHDRAWN', 'NOT_ACCOUNT_OWNER',
    ] as const;
    for (const reason of reasons) {
      const message = ineligibilityMessage(reason);
      expect(message.length).toBeGreaterThan(20);
      // Aucun message ne doit divulguer une donnée du compte : ni identifiant,
      // ni email, ni montant — la réponse ne révèle rien à un tiers.
      expect(message).not.toMatch(/\d{4,}|@|€/);
    }
  });

  it('propose une issue quand le délai est écoulé', () => {
    // Une impasse sans alternative pousse le consommateur vers un litige.
    const message = ineligibilityMessage('DEADLINE_PASSED');
    expect(message).toMatch(/résilier|contacter/i);
  });
});
