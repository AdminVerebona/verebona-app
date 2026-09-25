/**
 * Résolution depuis la carte et règles d'affichage — CDC V2.0 §7.4, §8.5, §8.7.
 *
 * Deux propriétés sont testées ici parce qu'elles ne se voient pas à l'écran :
 * la liste blanche des champs écrivables, et le fait qu'une action « À
 * arbitrer » sans proposition ne doit jamais atteindre l'interface (ATP-05).
 */
import { describe, it, expect } from 'vitest';
import {
  findFieldWriter,
  isResolvableFromCard,
} from '@/services/to-process/resolve-action.service';
import {
  isDisplayableArbitration,
  selectDisplayedProposals,
  type ActionProposal,
} from '@/services/to-process/action-model';
import { getRule } from '@/services/to-process/rules-catalog';

const proposal = (
  value: string,
  confidence: number,
  extra: Partial<ActionProposal> = {},
): ActionProposal => ({ value, label: value, confidence, ...extra });

describe('liste blanche des champs écrivables (§8.5, §13.5)', () => {
  it('accepte les champs prévus par le catalogue', () => {
    expect(isResolvableFromCard('DOCUMENT', 'rubricCode')).toBe(true);
    expect(isResolvableFromCard('DOCUMENT', 'documentTypeCode')).toBe(true);
  });

  it('refuse tout autre champ, y compris sensible', () => {
    // Une écriture dynamique sur la colonne nommée par `fieldKey` suffirait à
    // viser n'importe quelle colonne depuis une action forgée.
    expect(isResolvableFromCard('DOCUMENT', 'passwordHash')).toBe(false);
    expect(isResolvableFromCard('ASSET', 'accountId')).toBe(false);
    // Attribut retiré (0160) : l'usage « Mis en location » de la fiche le remplace.
    expect(isResolvableFromCard('ASSET', 'isRented')).toBe(false);
    expect(isResolvableFromCard('DOCUMENT', null)).toBe(false);
  });

  it('refuse un champ existant sur le mauvais type d’objet', () => {
    expect(isResolvableFromCard('ASSET', 'rubricCode')).toBe(false);
  });

  it('valide la valeur avant toute écriture', () => {
    const writer = findFieldWriter('DOCUMENT', 'rubricCode')!;
    expect(writer.validate('MAINTENANCE_WORKS')).toBe(true);
    expect(writer.validate('RUBRIQUE_INVENTEE')).toBe(false);
    expect(writer.validate(42)).toBe(false);
  });

  it('§5.2 — le Type « Autre » est accepté ici : c’est l’utilisateur qui agit', () => {
    const writer = findFieldWriter('DOCUMENT', 'documentTypeCode')!;
    expect(writer.validate('OTHER_MEDIA')).toBe(true);
    expect(writer.validate('TYPE_INEXISTANT')).toBe(false);
  });
});

describe('« Non applicable » (§7.4, §10.6)', () => {
  it('n’est jamais autorisé pour la Rubrique ni le rattachement à un bien', () => {
    expect(getRule('DOC-RUB')!.allowNotApplicable).toBe(false);
    expect(getRule('LINK-ASSET')!.allowNotApplicable).toBe(false);
  });

  it('l’est pour les règles où l’absence est un état final légitime', () => {
    expect(getRule('DATA-CONTRACT-END')!.allowNotApplicable).toBe(true);
    expect(getRule('LINK-ELT')!.allowNotApplicable).toBe(true);
  });
});

describe('propositions affichées (§8.5, ATP-05)', () => {
  it('ATP-05 — un arbitrage sans candidat n’est pas affichable', () => {
    expect(isDisplayableArbitration([])).toBe(false);
    // Une valeur actuelle seule ne suffit pas : confirmer une valeur qu'aucune
    // autre ne conteste ne résout rien.
    expect(
      isDisplayableArbitration([proposal('A', 1, { isCurrentValue: true })]),
    ).toBe(false);
    expect(isDisplayableArbitration([proposal('A', 0.5)])).toBe(true);
  });

  it('n’affiche jamais plus de deux candidats', () => {
    const displayed = selectDisplayedProposals([
      proposal('A', 0.8),
      proposal('B', 0.7),
      proposal('C', 0.6),
      proposal('D', 0.5),
    ]);
    expect(displayed).toHaveLength(2);
    // Les deux plus pertinents (§8.5).
    expect(displayed.map((p) => p.value)).toEqual(['A', 'B']);
  });

  it('joint la valeur actuelle en plus des deux candidats', () => {
    const displayed = selectDisplayedProposals([
      proposal('A', 0.8),
      proposal('B', 0.7),
      proposal('C', 0.6),
      proposal('ACTUELLE', 1, { isCurrentValue: true }),
    ]);
    expect(displayed).toHaveLength(3);
    expect(displayed[2].isCurrentValue).toBe(true);
  });
});
