/**
 * Lot 77B — libellés des cartes « À traiter » (décision PO du 21/10/2026).
 *
 *   L77B-01 : historique fournisseur → « Déjà 3 documents de Cardif IARD sur
 *             Maison » (bien nommé, singulier / pluriel), jamais « fourni par
 *             le serveur » ;
 *   L77B-02 : cible jamais « #id » — libellé générique lisible par type
 *             (« Événement d’agenda ») ;
 *   L77B-03 : TOUTES les familles / règles : aucun libellé produit (question,
 *             cible, propositions, contexte de source, titre et sous-titre de
 *             la mascotte) ne contient de motif interdit ;
 *   L77B-04 : rendu desktop ET mobile (même composant `ActionCard`, avec et
 *             sans visuel) des cartes héritées : aucun motif interdit ;
 *   L77B-05 : producteurs — plus de repli « #id » / « Bien 12 » / motif brut
 *             dans le code de production des cartes.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('@/db', () => ({ db: {}, pgClient: {} }));
(globalThis as { React?: typeof React }).React = React;

const L = await import('../card-labels');
const { PROCESSING_RULES, getRule } = await import('../rules-catalog');
const ops = await import('../operation-cards');
const projection = await import('../agenda-projection-cards');
const statut = await import('../agenda-status-cards');
const conflit = await import('../document-asset-conflict');
const { interventionQuestion } = await import('../document-intervention');
const { entityConflictProposals } = await import('../entity-field-cards');
const { buildMigrationProposals } = await import('../migration-review-cards');
const { mapReconciliationDecision } = await import('../reconciliation-bridge');
const { proposalsFromAnalysis } = await import('../document-rule-bridge');
const { rankCandidates } = await import('@/services/ai/reconciliation/document-asset/decision');
const { todoItemFrom, todoTitle } = await import('@/services/home/mascot/todo-items');
const { ActionCard } = await import('@/components/to-process/ActionCard');
import type { ActionProposal, TargetType } from '../action-model';
import type { ToProcessActionView } from '../to-process-query.service';

const ROOT = process.cwd();
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');

/** Échoue avec le motif et le texte fautif (lisible en CI). */
function sansJargon(textes: Array<string | null | undefined>, contexte: string) {
  for (const t of textes) {
    if (!t) continue;
    expect(L.technicalLabelIssues(t), `${contexte} : « ${t} »`).toEqual([]);
  }
}

/** Vue de file minimale (comme `getToProcessPage` avant présentation). */
function vue(p: {
  targetType: TargetType; ruleCode: string; question?: string; proposals?: ActionProposal[];
  fieldKey?: string | null; relationKey?: string | null; label?: string; assetName?: string | null; kind?: 'ARBITRATE' | 'COMPLETE';
}): ToProcessActionView {
  return {
    publicId: `p-${p.ruleCode}`, targetType: p.targetType, targetId: 9, fieldKey: p.fieldKey ?? null, relationKey: p.relationKey ?? (p.fieldKey ? null : 'rel'),
    actionKind: p.kind ?? 'ARBITRATE', priority: 'DO_FIRST', ruleCode: p.ruleCode,
    question: p.question ?? getRule(p.ruleCode)?.question ?? 'Question ?', proposals: p.proposals ?? [], allowNotApplicable: false,
    inputType: null, activeSince: '2026-10-21T08:00:00.000Z', target: { label: p.label ?? '#9', assetName: p.assetName ?? null },
  };
}
const presenter = (v: ToProcessActionView) => L.presentCardLabels(v, getRule(v.ruleCode)?.question ?? null);

/** Tous les textes qu'une carte et la mascotte affichent. */
function textesAffiches(v: ToProcessActionView): string[] {
  const item = todoItemFrom(v);
  return [
    v.question, v.target.label, v.target.assetName ?? null,
    ...v.proposals.flatMap((p) => [p.label, p.sourceContext?.label ?? null]),
    item.title, item.subtitle, item.cta,
  ].filter((x): x is string => !!x);
}

const RAISON_T3_RECETTE = 'Historique fournisseur fourni par le serveur : 3 documents du même émetteur Cardif IARD sont déjà rattachés à ce bien';

describe('L77B-01 — historique fournisseur, formulation utilisateur', () => {
  it('L77B-01a capture PO : « Déjà 3 documents de Cardif IARD sur Maison »', () => {
    expect(L.userSourceLabel(RAISON_T3_RECETTE, { assetName: 'Maison' })).toBe('Déjà 3 documents de Cardif IARD sur Maison');
  });

  it('L77B-01b signal serveur (semantic-search) : nom du fournisseur pris dans l’analyse, singulier correct', () => {
    expect(L.userSourceLabel('historique fournisseur : 1 document(s) du même fournisseur déjà rattaché(s) à ce bien', { assetName: 'Peugeot 208', supplier: 'Allianz' }))
      .toBe('Déjà 1 document d’Allianz sur Peugeot 208');
    expect(L.userSourceLabel('historique fournisseur : 4 document(s) du même fournisseur déjà rattaché(s) à ce bien'))
      .toBe('Déjà 4 documents du même fournisseur sur ce bien');
  });

  it('L77B-01c justification technique non reconnue : non affichée (null), jamais recopiée', () => {
    for (const brut of [
      'IDENTIFIER_EXACT:VIN', 'SHARED_REFERENCE', 'score 0.82 — candidat #12 (preuve serveur)', 'T3 : signal faible',
      'contexte fourni par le serveur', 'assetIds incohérent',
    ]) expect(L.userSourceLabel(brut), brut).toBeNull();
    // Texte déjà lisible : conservé (première lettre en capitale, dates jj/mm/aaaa).
    expect(L.userSourceLabel('bien cité par le document')).toBe('Bien cité par le document');
    expect(L.userSourceLabel('Contrôle technique — 2026-05-12')).toBe('Contrôle technique — 12/05/2026');
  });

  it('L77B-01d producteur T3 : la carte LINK-ASSET écrit le libellé utilisateur (resolve-document-asset)', () => {
    const src = read('src/services/ai/reconciliation/document-asset/resolve-document-asset.service.ts');
    expect(src).toMatch(/userSourceLabel\(c\.reason, \{ assetName: c\.label, supplier: p\.supplier \?\? null \}\)/);
    expect(src).not.toMatch(/sourceContext: \{ label: c\.reason/);
  });
});

describe('L77B-02 — cible : jamais « #id »', () => {
  it.each(['DOCUMENT', 'ASSET', 'EQUIPMENT', 'ROOM', 'AGENDA_ITEM', 'SUPPLIER'] as const)('%s : libellé générique lisible', (t) => {
    const libelle = L.targetFallbackLabel(t);
    sansJargon([libelle], t);
    expect(presenter(vue({ targetType: t, ruleCode: 'DOC-RUB', label: '#9' })).target.label).toBe(libelle);
    expect(presenter(vue({ targetType: t, ruleCode: 'DOC-RUB', label: '' })).target.label).toBe(libelle);
  });

  it('L77B-02b « À quelle date « Contrôle technique » a-t-il lieu ? » : « Événement d’agenda » si le titre manque', () => {
    expect(L.targetFallbackLabel('AGENDA_ITEM')).toBe('Événement d’agenda');
  });

  it('L77B-02c un titre saisi qui CONTIENT un numéro (« Facture #123 ») est conservé', () => {
    expect(presenter(vue({ targetType: 'DOCUMENT', ruleCode: 'DOC-RUB', label: 'Facture #123' })).target.label).toBe('Facture #123');
  });

  it('L77B-02d hydratation agenda (pure) : titre + premier bien lié ; titre vide → générique', async () => {
    const { agendaContexts } = await import('../to-process-query.service');
    const r = agendaContexts([
      { id: 9, title: 'Contrôle technique', linkId: 5, assetId: 2, assetName: 'Peugeot 208' },
      { id: 9, title: 'Contrôle technique', linkId: 3, assetId: 1, assetName: 'Clio' },
      { id: 10, title: '  ', linkId: null, assetId: null, assetName: null },
    ]);
    expect(r.find((x) => x.id === 9)!.context).toEqual({ label: 'Contrôle technique', assetId: 1, assetName: 'Clio' });
    expect(r.find((x) => x.id === 10)!.context).toEqual({ label: 'Événement d’agenda', assetId: null, assetName: null });
  });
});

describe('L77B-03 — toutes les familles : aucun libellé technique', () => {
  it('L77B-03a catalogue : chaque règle (question par défaut, titre mascotte ARBITRATE / COMPLETE)', () => {
    for (const r of PROCESSING_RULES) {
      sansJargon([r.question, todoTitle(r.code, 'ARBITRATE'), todoTitle(r.code, 'COMPLETE')], r.code);
    }
  });

  it('L77B-03b motifs interdits reconnus (garde du test lui-même)', () => {
    for (const t of ['#9', 'fourni par le serveur', 'USER_VALUE_PROTECTED', 'DATA-AGENDA-DATE', 'passage T3', 'contractEndDate', 'undefined', 'true', '2026-05-12', 'Bien 12']) {
      expect(L.technicalLabelIssues(t), t).not.toEqual([]);
    }
    for (const t of ['Maison', 'iPhone 15', 'Peugeot 208', 'Déjà 3 documents de Cardif IARD sur Maison', 'Contrôle technique', '12/05/2026']) {
      expect(L.technicalLabelIssues(t), t).toEqual([]);
    }
  });

  // Une vue par famille, avec les VRAIS constructeurs de libellés quand ils
  // sont purs, sinon la forme enregistrée par le producteur (y compris les
  // formes héritées, recalculées à la lecture).
  const A = { id: 12, label: 'Devis freinage du 03/06/2026' };
  const B = { id: 15, label: 'Facture vidange du 10/04/2026' };
  const familles: Array<[string, ToProcessActionView]> = [
    ['LINK-ASSET (T3, justification héritée)', vue({ targetType: 'DOCUMENT', ruleCode: 'LINK-ASSET', relationKey: 'assetIds', label: 'Fiche de contacts Cardif IARD BNP Paribas',
      proposals: [
        { value: 7, label: 'Maison', confidence: 0.8, sourceContext: { label: RAISON_T3_RECETTE } },
        ...rankCandidates([{ assetId: 8, serverSignals: [], contextSignals: [], currentRole: null, t1: { confidence: 'probable', score: 0.4, reason: 'SUPPLIER_MATCH score=0.4', signals: '' } } as never])
          .map((r) => ({ value: r.assetId, label: 'Bien 8', confidence: r.score, sourceContext: { label: r.reason } })),
      ] })],
    ['LINK-ASSET (pont documentaire, nom manquant)', vue({ targetType: 'DOCUMENT', ruleCode: 'LINK-ASSET', relationKey: 'assetIds', label: 'Facture',
      proposals: proposalsFromAnalysis('assetIds', { kind: 'relation' } as never, { facts: [], assetCandidates: [], documentAssetId: 31 } as never) })],
    ['LINK-ASSET-CONFLICT', vue({ targetType: 'DOCUMENT', ruleCode: 'LINK-ASSET-CONFLICT', relationKey: 'assetConflict', label: 'Carte grise',
      question: conflit.assetConflictQuestion({ basis: 'IDENTIFIER', kinds: ['VIN'], currentName: 'Clio', suggestedName: 'Peugeot 208' }),
      proposals: conflit.assetConflictProposals({ currentAssetId: 1, suggestedAssetId: 2, currentName: 'Clio', suggestedName: 'Peugeot 208', basis: 'IDENTIFIER' }) })],
    ['LINK-ELT (justification héritée)', vue({ targetType: 'DOCUMENT', ruleCode: 'LINK-ELT', relationKey: 'equipmentId', label: 'Facture chaudière',
      proposals: [{ value: 3, label: 'Équipement 3', confidence: 0.5, sourceContext: { label: 'EQUIPMENT_NAME_MATCH (score 0.7)' } }, { value: 4, label: 'Chaudière', confidence: 0.4 }] })],
    ['DATA-AGENDA-DATE (capture « #9 »)', vue({ targetType: 'AGENDA_ITEM', ruleCode: 'DATA-AGENDA-DATE', fieldKey: 'date', kind: 'COMPLETE', label: '#9', question: 'À quelle date « Contrôle technique » a-t-il lieu ?' })],
    ['AGENDA-PROPOSAL (forme héritée, dates ISO)', vue({ targetType: 'DOCUMENT', ruleCode: 'AGENDA-PROPOSAL', relationKey: 'agenda:x', label: 'Avis d’échéance',
      question: 'Ajouter cette échéance à l’agenda ? « Contrôle technique » le 2026-05-12',
      proposals: [{ value: 'YES:2026-05-12', label: 'Oui, le 2026-05-12', confidence: 0.5, sourceContext: { label: 'Contrôle technique — 2026-05-12' } }, { value: 'NO', label: 'Non', confidence: 0.3 }] })],
    ['AGENDA-PROJECTION-MATCH', vue({ targetType: 'AGENDA_ITEM', ruleCode: 'AGENDA-PROJECTION-MATCH', relationKey: 'proj', label: 'Vidange',
      question: projection.agendaProjectionQuestion({ title: 'Vidange', date: '2026-04-10', typeCode: null }, [{ itemId: 4, title: 'Entretien', date: '2026-04-11', reason: 'DATE_PROXIMITY' }, { itemId: 5, title: 'Révision', date: null, reason: 'X' }], 'Facture garage'),
      proposals: projection.agendaProjectionProposals([{ itemId: 4, title: 'Entretien', date: '2026-04-11', reason: 'DATE_PROXIMITY' }, { itemId: 5, title: 'Révision', date: null, reason: 'X' }]) })],
    ['AGENDA-DONE', vue({ targetType: 'AGENDA_ITEM', ruleCode: 'AGENDA-DONE', fieldKey: 'status', label: 'Ramonage', proposals: statut.agendaStatusProposals('propose_done', 44) })],
    ['AGENDA-NOT-DONE', vue({ targetType: 'AGENDA_ITEM', ruleCode: 'AGENDA-NOT-DONE', fieldKey: 'status', label: 'Ramonage', proposals: statut.agendaStatusProposals('propose_not_done', null) })],
    ['ASSET-STATUS', vue({ targetType: 'ASSET', ruleCode: 'ASSET-STATUS', fieldKey: 'status', label: 'Peugeot 208',
      proposals: statut.assetStatusProposals('sale', 'ACTIF', 'Acte de vente', new Set(['VENDU', 'TRANSMIS'])) })],
    ['AGENDA-DUPLICATE', vue({ targetType: 'AGENDA_ITEM', ruleCode: 'AGENDA-DUPLICATE', relationKey: 'dup', label: 'Contrôle technique',
      question: '« Contrôle technique » du 12/05/2026 (Avis) est-il le même événement que « CT » du 13/05/2026 ?',
      proposals: [{ value: 'SAME', label: 'Même échéance', confidence: 0.8, sourceContext: { label: 'Avis' } }, { value: 'DIFFERENT', label: 'Échéances différentes', confidence: 0.2 }] })],
    ['DOC-INTERVENTION', vue({ targetType: 'DOCUMENT', ruleCode: 'DOC-INTERVENTION', relationKey: 'intervention:contractEndDate', label: 'Contrat',
      question: interventionQuestion({ action: null, kind: 'TERMINATE', actBy: '2026-11-30' } as never),
      proposals: [{ value: 'DONE', label: 'C’est fait', confidence: 0 }, { value: 'NOT_NEEDED', label: 'Pas nécessaire', confidence: 0 }] })],
    ['DATA-ACQUISITION-PRICE (valeurs brutes)', vue({ targetType: 'ASSET', ruleCode: 'DATA-ACQUISITION-PRICE', fieldKey: 'acquisitionPrice', label: 'Maison',
      proposals: mapReconciliationDecision({ fieldKey: 'acquisitionPrice', currentValue: 250000, proposedValue: 245000.5, action: 'create_conflict', reasonCode: 'SOURCE_CONFLICT', confidence: 'probable', evidenceIds: [1], deterministic: true } as never)!.proposals! })],
    ['DATA-ACQUISITION-DATE (valeurs brutes)', vue({ targetType: 'ASSET', ruleCode: 'DATA-ACQUISITION-DATE', fieldKey: 'acquisitionDate', label: 'Maison',
      proposals: mapReconciliationDecision({ fieldKey: 'acquisitionDate', currentValue: '2019-03-01', proposedValue: '2019-03-15T00:00:00.000Z', action: 'create_conflict', reasonCode: 'SOURCE_CONFLICT', confidence: 'probable', evidenceIds: [1], deterministic: true } as never)!.proposals! })],
    ['DATA-REGISTRATION', vue({ targetType: 'ASSET', ruleCode: 'DATA-REGISTRATION', fieldKey: 'registrationNumber', label: 'Peugeot 208',
      proposals: [{ value: 'AB-123-CD', label: 'AB-123-CD', confidence: 0.8 }, { value: 'AB-123-CE', label: 'AB-123-CE', confidence: 1, isCurrentValue: true }] })],
    ['DATA-CONTRACT-END (vide hérité)', vue({ targetType: 'DOCUMENT', ruleCode: 'DATA-CONTRACT-END', fieldKey: 'contractEndDate', kind: 'COMPLETE', label: 'Contrat habitation',
      proposals: [{ value: '2027-01-31', label: '2027-01-31', confidence: 0.6, sourceContext: { label: 'Le contrat prend fin le 2027-01-31' } }] })],
    ['SUPPLIER-IDENTITY', vue({ targetType: 'SUPPLIER', ruleCode: 'SUPPLIER-IDENTITY', fieldKey: 'identity', label: '#4',
      proposals: [{ value: 'EDF', label: 'EDF', confidence: 0 }, { value: 'EDF SA', label: 'EDF SA', confidence: 1, isCurrentValue: true }] })],
    ['LINK-EQUIP-ASSET', vue({ targetType: 'EQUIPMENT', ruleCode: 'LINK-EQUIP-ASSET', relationKey: 'assetId', kind: 'COMPLETE', label: '#3' })],
    ['MIG-REVIEW', vue({ targetType: 'ASSET', ruleCode: 'MIG-REVIEW', relationKey: 'mig:MIG-02:acquisitionPrice', label: 'Maison',
      ...buildMigrationProposals({ step: 'MIG-02', accountId: 1, assetId: 1, key: 'acquisitionPrice', reason: 'ALIAS_CONFLICT', current: 120000, candidates: [{ value: 1200 }] }) })],
    ['ENTITY-FIELD (booléen, champ inconnu)', vue({ targetType: 'EQUIPMENT', ruleCode: 'ENTITY-FIELD', fieldKey: 'underWarranty', label: 'Chaudière', assetName: 'Maison',
      question: 'Deux valeurs différentes pour « cette information » de Chaudière. Laquelle garder ?',
      proposals: entityConflictProposals({ fieldKey: 'underWarranty', currentValue: false, proposedValue: true, action: 'create_conflict', reasonCode: 'X', confidence: 'certain', evidenceIds: [], deterministic: true } as never) })],
    ['ENTITY-FIELD-ROOM (question héritée au nom de champ anglais)', vue({ targetType: 'ROOM', ruleCode: 'ENTITY-FIELD-ROOM', fieldKey: 'floorCovering', label: 'Salon',
      question: 'Deux valeurs différentes pour « floorCovering » de la pièce. Laquelle garder ?', proposals: [{ value: 'parquet', label: 'parquet', confidence: 0.6 }, { value: 'carrelage', label: 'carrelage', confidence: 1, isCurrentValue: true }] })],
    ['OPERATION-MATCH', vue({ targetType: 'DOCUMENT', ruleCode: 'OPERATION-MATCH', relationKey: 'op', label: 'Facture garage',
      question: ops.matchQuestion('INTERVENTION', 'CERTAIN', [A, B]), proposals: ops.matchProposals('INTERVENTION', 'CERTAIN', [A, B]) })],
    ['OPERATION-AMOUNT', vue({ targetType: 'DOCUMENT', ruleCode: 'OPERATION-AMOUNT', relationKey: 'op', label: 'Facture',
      question: ops.amountQuestion('REPAIR'), proposals: ops.amountProposals([{ amountMinor: 12000, currency: 'EUR', title: 'Devis' }, { amountMinor: 13000, currency: 'EUR', title: null }], { amountMinor: 13000, currency: 'EUR' }) })],
    ['OPERATION-CLAIM-ASSET', vue({ targetType: 'DOCUMENT', ruleCode: 'OPERATION-CLAIM-ASSET', relationKey: 'op', label: 'Rapport',
      question: ops.exclusionQuestion('Maison', 'Dégât des eaux'), proposals: ops.exclusionProposals('Maison') })],
    ['OPERATION-CURRENCY', vue({ targetType: 'DOCUMENT', ruleCode: 'OPERATION-CURRENCY', relationKey: 'op', label: 'Facture',
      question: ops.currencyQuestion(12000), proposals: ops.currencyProposals(['USD', 'CHF']) })],
    ['DOC-RUB / DOC-TYP / DATA-SUPPLIER / DATA-WARRANTY-END (repli cible)', vue({ targetType: 'DOCUMENT', ruleCode: 'DOC-RUB', fieldKey: 'rubric', kind: 'COMPLETE', label: '' })],
  ];

  it('L77B-03c la liste couvre toutes les règles du catalogue (sauf variantes de même forme)', () => {
    const couvertes = new Set(familles.flatMap(([, v]) => [v.ruleCode]));
    const memeForme = new Set(['DOC-TYP', 'DATA-SUPPLIER', 'DATA-WARRANTY-END']);
    const manquantes = PROCESSING_RULES.map((r) => r.code).filter((c) => !couvertes.has(c) && !memeForme.has(c));
    expect(manquantes).toEqual([]);
  });

  it.each(familles)('L77B-03d %s : textes de la carte et de la mascotte lisibles après présentation', (_nom, brute) => {
    const v = presenter(brute);
    sansJargon(textesAffiches(v), `${v.ruleCode}`);
  });

  it('L77B-03e cas PO : capture « À arbitrer » et « #9 » corrigées, valeurs brutes formatées', () => {
    const lien = presenter(familles.find(([n]) => n.startsWith('LINK-ASSET (T3'))![1]);
    expect(lien.proposals[0].sourceContext?.label).toBe('Déjà 3 documents de Cardif IARD sur Maison');
    expect(lien.proposals[1]).not.toHaveProperty('sourceContext');
    expect(lien.proposals[1].label).toBe('Bien sans nom');
    const agenda = presenter(familles.find(([n]) => n.startsWith('DATA-AGENDA-DATE'))![1]);
    expect(agenda.target.label).toBe('Événement d’agenda');
    expect(agenda.question).toBe('À quelle date « Contrôle technique » a-t-il lieu ?');
    const prix = presenter(familles.find(([n]) => n.startsWith('DATA-ACQUISITION-PRICE'))![1]);
    expect(prix.proposals.map((p) => p.label.replace(/\s/g, ' '))).toEqual(['245 000,5 €', '250 000 €']);
    const date = presenter(familles.find(([n]) => n.startsWith('DATA-ACQUISITION-DATE'))![1]);
    expect(date.proposals.map((p) => p.label)).toEqual(['15/03/2019', '01/03/2019']);
    const bool = presenter(familles.find(([n]) => n.startsWith('ENTITY-FIELD (booléen'))![1]);
    expect(bool.proposals.map((p) => p.label)).toEqual(['Oui', 'Non']);
    const piece = presenter(familles.find(([n]) => n.startsWith('ENTITY-FIELD-ROOM'))![1]);
    expect(piece.question).toBe(getRule('ENTITY-FIELD-ROOM')!.question);
    const proposition = presenter(familles.find(([n]) => n.startsWith('AGENDA-PROPOSAL'))![1]);
    expect(proposition.question).toBe('Ajouter cette échéance à l’agenda ? « Contrôle technique » le 12/05/2026');
    expect(proposition.proposals[0].label).toBe('Oui, le 12/05/2026');
    // La valeur appliquée n'est jamais touchée : seuls les libellés changent.
    expect(proposition.proposals[0].value).toBe('YES:2026-05-12');
  });

  it('L77B-03f mascotte : sous-titre « Contrôle technique · Peugeot 208 » (même vue que la file)', () => {
    const v = presenter(vue({ targetType: 'AGENDA_ITEM', ruleCode: 'DATA-AGENDA-DATE', fieldKey: 'date', kind: 'COMPLETE', label: 'Contrôle technique', assetName: 'Peugeot 208' }));
    expect(todoItemFrom(v).subtitle).toBe('Contrôle technique · Peugeot 208');
  });

  it.each(familles)('L77B-04 %s : rendu ActionCard (mobile sans visuel, desktop avec visuel) sans motif interdit', (_nom, brute) => {
    const v = presenter(brute);
    for (const visual of [false, true]) {
      const html = renderToStaticMarkup(h(ActionCard, { action: v as never, visual, onChoose: () => {}, onOpenTarget: () => {} }));
      const texte = html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, '’').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
      expect(texte, `${v.ruleCode} (visual=${visual})`).not.toMatch(/#\d+|serveur|fourni par|\b[A-Z][A-Z0-9]*_[A-Z0-9_]*[A-Z0-9]\b|\b\d{4}-\d{2}-\d{2}\b/i);
    }
  });
});

describe('L77B-05 — producteurs : plus de repli technique dans le code des cartes', () => {
  const FICHIERS = [
    'src/services/to-process/to-process-query.service.ts',
    'src/services/to-process/document-equipment-link.ts',
    'src/services/to-process/document-rule-bridge.ts',
    'src/services/to-process/document-slots.ts',
    'src/services/to-process/agenda-proposal-cards.ts',
    'src/services/to-process/entity-field-cards.ts',
    'src/services/to-process/document-asset-conflict.ts',
    'src/services/ai/reconciliation/document-asset/resolve-document-asset.service.ts',
  ];
  it.each(FICHIERS)('%s', (f) => {
    const src = read(f);
    expect(src, 'repli « #id »').not.toMatch(/label: `#\$\{/);
    expect(src, 'repli « Bien 12 » / « Équipement 12 »').not.toMatch(/`(?:Bien|Équipement) \$\{/);
    expect(src, 'motif brut en contexte de source').not.toMatch(/sourceContext: \{ label: c\.reason/);
    expect(src, 'nom de champ technique en question').not.toMatch(/getField\(d\.fieldKey\)\?\.label \?\? d\.fieldKey/);
  });

  it('la file applique la politique de libellés à la lecture (page, pastille, accueil, mascotte)', () => {
    const src = read('src/services/to-process/to-process-query.service.ts');
    expect(src).toMatch(/return presentCardLabels\(\{/);
    expect(src).toMatch(/byType\.get\('AGENDA_ITEM'\)/);
  });
});
