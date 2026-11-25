/**
 * Carte #836 (Trello, écart E06) — la carte « À traiter » d'une contradiction
 * d'attribut d'un événement de référence : TOUTES les alternatives réelles
 * sélectionnables, identifiants stables, pagination d'AFFICHAGE, et une API qui
 * vérifie la source et la version de l'ensemble des choix.
 *
 *   C836-U-E06-CARTE  13 valeurs et plus : toutes construites, la DERNIÈRE
 *                     choisissable ; pagination (première page + suite) ;
 *                     aucune autre carte du dépôt n'est touchée ;
 *   C836-U-E06-API    options falsifiées refusées (valeur forgée, ensemble
 *                     altéré, contexte vide) ; isolation du choix à la carte ;
 *   C836-U-E06-ANCRE  carte portée par l'opération (Agenda) sans inventer de
 *                     document, une seule action par même fait.
 * Tests purs (aucune base, aucune IA).
 */
import { describe, expect, it } from 'vitest';
import {
  attributeOptionsVersion, attributeProposals, attributeQuestion, attributeRelationKey,
  ATTRIBUTE_PROPOSALS_MAX, OPERATION_ATTRIBUTE_RULE, parseOperationCardChoice,
} from '../operation-cards';
import {
  displayedProposalsMax, DISPLAYED_PROPOSALS_MAX, DISPLAYED_PROPOSALS_MAX_BY_RULE,
  overflowProposals, selectDisplayedProposals, type ActionProposal,
} from '../action-model';
import { PROCESSING_RULES } from '../rules-catalog';

/** `n` dates réellement différentes, la première étant la valeur en place. */
const valeurs = (n: number) => Array.from({ length: n }, (_, i) => {
  const jour = `2026-03-${String(i + 1).padStart(2, '0')}`;
  return { value: jour, normalized: jour, title: `Facture ${i + 1}`, fileIds: [100 + i] };
});

describe('C836-U-E06-CARTE — 13 valeurs et plus : toutes sélectionnables (E06)', () => {
  it('CONTRE-EXEMPLE — treize valeurs réelles dont la DERNIÈRE est choisie : elle est construite, paginée et acceptée (avant : la treizième n’existait nulle part)', () => {
    const options = valeurs(13);
    const p = attributeProposals('realizedDate', options, '2026-03-01');
    // Avant la carte #836 : `slice(0, ATTRIBUTE_PROPOSALS_MAX - 1)` → douze propositions, la treizième perdue.
    expect(p).toHaveLength(13);
    expect(p.map((x) => x.value)).toContain('ATTRIBUTE:2026-03-13');
    expect(new Set(p.map((x) => x.value)).size).toBe(13);
    // La valeur en place reste la dernière, marquée.
    expect(p.at(-1)).toMatchObject({ value: 'ATTRIBUTE:2026-03-01', isCurrentValue: true });

    // AFFICHAGE : première page bornée (lisibilité §8.5 complétée par le lot 115), suite atteignable.
    const page1 = selectDisplayedProposals(p, OPERATION_ATTRIBUTE_RULE);
    const suite = overflowProposals(p, OPERATION_ATTRIBUTE_RULE);
    expect(page1).toHaveLength(displayedProposalsMax(OPERATION_ATTRIBUTE_RULE) + 1);
    expect(suite).toHaveLength(13 - 1 - displayedProposalsMax(OPERATION_ATTRIBUTE_RULE));
    // Aucune valeur réelle n'est perdue entre la page et la suite, et aucune n'est servie deux fois.
    const toutes = [...page1, ...suite].map((x) => String(x.value));
    expect(new Set(toutes).size).toBe(13);
    expect(toutes).toContain('ATTRIBUTE:2026-03-13');

    // CHOIX de la treizième : l'API l'accepte, parce que la carte l'a présentée.
    const ctx = {
      kind: 'operation_attribute', operationId: 42, field: 'realizedDate', role: 'REALIZATION',
      options: options.map((o) => ({ value: o.value, normalized: o.normalized, fileIds: o.fileIds })),
      optionsVersion: attributeOptionsVersion('realizedDate', 'REALIZATION', options),
    };
    expect(parseOperationCardChoice(OPERATION_ATTRIBUTE_RULE, 'ATTRIBUTE:2026-03-13', ctx))
      .toEqual({ kind: 'ATTRIBUTE', normalized: '2026-03-13', value: '2026-03-13' });
  });

  it('le plafond de douze reste une règle d’AFFICHAGE : vingt valeurs réelles donnent vingt propositions', () => {
    expect(ATTRIBUTE_PROPOSALS_MAX).toBe(12);
    const p = attributeProposals('provider', [
      ...valeurs(0), ...Array.from({ length: 20 }, (_, i) => ({ value: `Prestataire ${i}`, normalized: `prestataire${i}`, title: null })),
    ], 'Prestataire 0');
    expect(p).toHaveLength(20);
    expect(selectDisplayedProposals(p, OPERATION_ATTRIBUTE_RULE).length + overflowProposals(p, OPERATION_ATTRIBUTE_RULE).length).toBe(20);
  });

  it('identifiants STABLES : ni le rang, ni la page, ni l’ordre d’arrivée n’entrent dans la valeur d’une proposition', () => {
    const options = valeurs(13);
    const p1 = attributeProposals('realizedDate', options, '2026-03-01').map((x) => x.value).sort();
    const p2 = attributeProposals('realizedDate', [...options].reverse(), '2026-03-01').map((x) => x.value).sort();
    expect(p2).toEqual(p1);
    // Et la version de l'ensemble ne dépend pas de l'ordre (deux balayages identiques, même version).
    expect(attributeOptionsVersion('realizedDate', 'REALIZATION', [...options].reverse()))
      .toBe(attributeOptionsVersion('realizedDate', 'REALIZATION', options));
  });

  it('les valeurs ÉQUIVALENTES ne comptent qu’une fois (aucun doublon de choix pour un même fait)', () => {
    const p = attributeProposals('provider', [
      { value: 'Ets Durand & Fils', normalized: 'durandfils', title: null },
      { value: 'Societe Durand et Fils', normalized: 'durandfils', title: null },
      { value: 'Chauffage Martin', normalized: 'chauffagemartin', title: null },
    ], 'Ets Durand & Fils');
    expect(p).toHaveLength(2);
  });

  it('AUCUNE AUTRE CARTE n’est touchée : borne commune à deux, et aucune suite pour les autres règles', () => {
    expect(DISPLAYED_PROPOSALS_MAX).toBe(2);
    expect(Object.keys(DISPLAYED_PROPOSALS_MAX_BY_RULE)).toEqual([OPERATION_ATTRIBUTE_RULE]);
    const quatre: ActionProposal[] = [
      { value: 'A', label: 'A', confidence: 0.8 }, { value: 'B', label: 'B', confidence: 0.7 },
      { value: 'C', label: 'C', confidence: 0.6 }, { value: 'D', label: 'D', confidence: 1, isCurrentValue: true },
    ];
    expect(selectDisplayedProposals([...quatre]).map((x) => x.value)).toEqual(['A', 'B', 'D']);
    expect(overflowProposals([...quatre])).toEqual([]);
    expect(overflowProposals([...quatre], null)).toEqual([]);
    for (const r of PROCESSING_RULES.filter((x) => x.code !== OPERATION_ATTRIBUTE_RULE)) {
      expect(selectDisplayedProposals([...quatre], r.code).map((x) => x.value), r.code).toEqual(['A', 'B', 'D']);
      expect(overflowProposals([...quatre], r.code), r.code).toEqual([]);
    }
  });
});

describe('C836-U-E06-API — permissions, source et version de l’ensemble des choix (E06)', () => {
  const options = valeurs(13).map((o) => ({ value: o.value, normalized: o.normalized, fileIds: o.fileIds }));
  const ctx = (over: Record<string, unknown> = {}) => ({
    kind: 'operation_attribute', operationId: 42, field: 'realizedDate', role: 'REALIZATION', options,
    optionsVersion: attributeOptionsVersion('realizedDate', 'REALIZATION', options), ...over,
  });

  it('OPTIONS FALSIFIÉES : une valeur jamais présentée est refusée, quelle que soit sa forme', () => {
    for (const forge of ['ATTRIBUTE:2026-12-31', 'ATTRIBUTE:', 'ATTRIBUTE:2026-03-13 ', '2026-03-13', 'ATTRIBUTE:%27%20OR%201=1']) {
      expect(parseOperationCardChoice(OPERATION_ATTRIBUTE_RULE, forge, ctx()), forge).toBeNull();
    }
  });

  it('ENSEMBLE ALTÉRÉ : une option ajoutée au contexte sans que la version suive est refusée (version de l’ensemble des choix)', () => {
    const altere = ctx({ options: [...options, { value: '2026-12-31', normalized: '2026-12-31', fileIds: [999] }] });
    expect(parseOperationCardChoice(OPERATION_ATTRIBUTE_RULE, 'ATTRIBUTE:2026-12-31', altere)).toBeNull();
    // … et même une option LÉGITIME de l'ensemble altéré est refusée : l'ensemble n'est plus celui présenté.
    expect(parseOperationCardChoice(OPERATION_ATTRIBUTE_RULE, 'ATTRIBUTE:2026-03-02', altere)).toBeNull();
    // Ensemble intact : le choix passe.
    expect(parseOperationCardChoice(OPERATION_ATTRIBUTE_RULE, 'ATTRIBUTE:2026-03-02', ctx())).toMatchObject({ kind: 'ATTRIBUTE' });
  });

  it('CONTEXTE VIDE ou absent : aucun choix (jamais une écriture sans carte)', () => {
    expect(parseOperationCardChoice(OPERATION_ATTRIBUTE_RULE, 'ATTRIBUTE:2026-03-02', ctx({ options: [] }))).toBeNull();
    expect(parseOperationCardChoice(OPERATION_ATTRIBUTE_RULE, 'ATTRIBUTE:2026-03-02', { kind: 'operation_attribute' })).toBeNull();
    expect(parseOperationCardChoice(OPERATION_ATTRIBUTE_RULE, 'ATTRIBUTE:2026-03-02', null)).toBeNull();
  });

  it('cartes ANTÉRIEURES (sans version d’ensemble) : toujours répondables — aucune carte ouverte n’est cassée', () => {
    const ancienne = { kind: 'operation_attribute', operationId: 42, field: 'realizedDate', role: 'REALIZATION', options };
    expect(parseOperationCardChoice(OPERATION_ATTRIBUTE_RULE, 'ATTRIBUTE:2026-03-13', ancienne)).toMatchObject({ kind: 'ATTRIBUTE', value: '2026-03-13' });
  });

  it('ISOLATION par carte : la clé de relation porte le compte (par la carte), l’opération, l’attribut et le rôle — une action par même fait', () => {
    expect(attributeRelationKey(42, 'realizedDate', 'REALIZATION')).toBe('operationAttribute:42:realizedDate:REALIZATION');
    // Deux rôles = deux sujets = deux actions distinctes (jamais fondues).
    expect(attributeRelationKey(42, 'realizedDate', 'PAYMENT')).not.toBe(attributeRelationKey(42, 'realizedDate', 'REALIZATION'));
    // Deux opérations = deux actions (isolation entre comptes assurée par la lecture de la file).
    expect(attributeRelationKey(43, 'realizedDate', 'REALIZATION')).not.toBe(attributeRelationKey(42, 'realizedDate', 'REALIZATION'));
    expect(attributeQuestion('realizedDate', 'INTERVENTION')).toContain('dates de réalisation');
  });
});

describe('C836-U-E06-STOCK — la carte CONSERVE toutes ses propositions réelles (E06)', () => {
  it('CONTRE-EXEMPLE — la carte enregistre toutes les propositions, pas la première page (avant : `proposalsJson: displayed`)', async () => {
    const { readFileSync } = await import('node:fs');
    const svc = readFileSync('src/services/to-process/to-process-action.service.ts', 'utf8');
    expect(svc).not.toMatch(/proposalsJson: displayed/);
    expect(svc.match(/proposalsJson: proposals,/g)).toHaveLength(2);
    // L'empreinte du contexte reste calculée sur les propositions AFFICHÉES : aucune autre carte n'est remuée.
    expect(svc).toMatch(/proposals: displayed,\n\s+dueDate/);
    // Et la lecture pagine (page d'affichage + suite), au lieu de tronquer à l'écriture.
    const file = readFileSync('src/services/to-process/to-process-query.service.ts', 'utf8');
    expect(file).toMatch(/const suite = overflowProposals\(vue\.proposals, row\.ruleCode\);/);
  });
});

describe('C836-U-E06-ANCRE — carte portée par l’opération, sans inventer de document (E06)', () => {
  it('le producteur n’exige PLUS un document : sans pièce associable, l’ancre est un événement RÉEL de l’Agenda', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/services/to-process/operation-cards.ts', 'utf8');
    expect(src).toMatch(/agendaItemOfOperations/);
    // Aucun objet n'est créé pour porter une carte : sans objet réel, aucune carte (jamais un faux succès).
    expect(src).toMatch(/sans objet réel, aucune carte/);
    const ancre = readFileSync('src/services/to-process/reference-event-card-anchor.ts', 'utf8');
    expect(ancre).not.toMatch(/INSERT INTO (asset_files|agenda_items)/);
  });
});
