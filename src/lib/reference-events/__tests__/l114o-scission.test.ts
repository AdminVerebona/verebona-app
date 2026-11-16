/**
 * Lot 114O (Trello #744) — SCISSION d'un événement de référence (CDC
 * « Opérations / Agenda V2.0 » §7 « Scission explicite depuis la fiche », §14
 * « Actions » ; critère AC46). Décision du PO du 16/11/2026 : « Scinder : oui,
 * maintenant. »
 *
 *   L114OS-U01  textes : une phrase pour chaque refus de la scission, jamais « Opération », jamais un code
 *   L114OS-U02  lecture de la demande « scinder » : champs admis, bornes, au moins un fait désigné
 *   L114OS-U03  aperçu avant d'écrire : ce qui part / ce qui reste, et seuls les faits désignés sont envoyés
 *   L114OS-U04  refus dits AVANT tout envoi : aucun intitulé, intitulé trop long, rien désigné, tout désigné
 *   L114OS-U05  gardes de code : route gardée qui appelle la façade, façade qui ne duplique aucune règle,
 *               mémoire de la séparation, aucune suppression physique, aucune règle métier à l'écran
 *   L114OS-U06  page rendue : « Scinder » proposé quand il y a quelque chose à déplacer, et seulement alors
 */
import * as React from 'react';
import { createElement as h } from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  REFERENCE_EVENT_GESTURES, REFERENCE_EVENT_LABEL_MAX, REFERENCE_EVENT_SPLIT_EMPTY_FORM, REFERENCE_EVENT_SPLIT_PARTS,
  REFERENCE_EVENT_SUCCESS, REFERENCE_EVENT_WRITE_LABELS as L, REFERENCE_EVENT_WRITE_MESSAGES,
  buildReferenceEventSplit, parseReferenceEventSplit, referenceEventSplitItems, referenceEventSplitPreview,
  type ReferenceEventSplitCurrent, type ReferenceEventSplitForm,
} from '../reference-event-write';
import type { ReferenceEventPageView } from '@/services/business-operations/graph/reference-event-page';

(globalThis as { React?: typeof React }).React = React;
const { ReferenceEventPageContent } = await import('@/components/reference-events/ReferenceEventPageContent');

const ROOT = process.cwd();
const lire = (rel: string) => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n?/g, '\n');
/** Code seulement (commentaires et imports retirés). */
const visible = (s: string) => s.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*|import )/.test(l)).map((l) => l.replace(/\{\/\*.*?\*\/\}/g, '')).join('\n');

const ROUTE = 'src/app/api/evenements-reference/[id]/scission/route.ts';
const FACADE = 'src/services/business-operations/operation-write.facade.ts';

/** Fiche lue par la page : deux événements de l'Agenda, deux justificatifs, un fournisseur. */
const courant: ReferenceEventSplitCurrent = {
  version: 7,
  agendaItems: [{ id: 21, title: 'Remplacement de la chaudière' }, { id: 22, title: 'Visite d’entretien' }],
  documents: [{ fileId: 11, title: 'Facture de la chaudière' }, { fileId: 12, title: 'Devis du ballon' }],
  suppliers: [{ id: 5, name: 'Plomberie Martin' }],
};
const form = (over: Partial<ReferenceEventSplitForm> = {}): ReferenceEventSplitForm =>
  ({ ...REFERENCE_EVENT_SPLIT_EMPTY_FORM, label: 'Remplacement du ballon', ...over });

describe('L114OS-U01 — textes de la scission', () => {
  it('le geste a sa phrase de réussite, et chaque refus propre à la scission a la sienne', () => {
    expect([...REFERENCE_EVENT_GESTURES]).toContain('split');
    expect(REFERENCE_EVENT_SUCCESS.split).toBe('Événement de référence scindé. Le nouveau est associé à celui-ci.');
    expect(REFERENCE_EVENT_WRITE_MESSAGES.SPLIT_PART_NOT_LINKED).toContain('refaites votre choix');
    expect(REFERENCE_EVENT_WRITE_MESSAGES.SPLIT_NOTHING_TO_MOVE).toContain('au moins un élément');
  });

  it('aucun texte de la scission ne dit « Opération », n’affiche un code ni ne promet un calcul immédiat', () => {
    const textes = [
      REFERENCE_EVENT_SUCCESS.split, REFERENCE_EVENT_WRITE_MESSAGES.SPLIT_PART_NOT_LINKED, REFERENCE_EVENT_WRITE_MESSAGES.SPLIT_NOTHING_TO_MOVE,
      L.split, L.splitTitle, L.splitHint, L.splitLabelField, L.splitLabelPlaceholder, L.splitPartsLegend, L.splitPartAgenda,
      L.splitPartDocument, L.splitPartSupplier, L.splitLabelRequired, L.splitNothingChosen, L.splitAllChosen, L.splitTypeNote,
      L.splitPreviewTitle, L.splitPreviewMoved, L.splitPreviewKept, L.splitPreviewHint, L.splitConfirm, L.splitReview,
    ];
    for (const t of textes) {
      expect(t, t).toBeTruthy();
      expect(t, t).not.toMatch(/Opération|opération|[A-Z]{3,}_[A-Z_]+/);
    }
    // Ce qui est dit à l'utilisateur : rien n'est effacé, rien n'est copié, les montants attendent l'analyse.
    expect(L.splitHint).toContain('Rien n’est effacé');
    expect(L.splitPreviewHint).toContain('prochaine analyse automatique');
    expect(L.splitPreviewHint).toContain('ne sera pas regroupé de nouveau automatiquement');
    // Le nouvel événement de référence reprend le type et les biens : c'est dit, et corrigible ensuite.
    expect(L.splitTypeNote).toContain('reprend le type et les biens');
  });
});

describe('L114OS-U02 — lecture de la demande « scinder »', () => {
  it('demande valide : version attendue, intitulé normalisé, listes dédoublonnées', () => {
    expect(parseReferenceEventSplit({ expectedVersion: 7, label: '  Ballon   d’eau  ', agendaItemIds: [21, 21, 22], fileIds: [12] }))
      .toEqual({ expectedVersion: 7, label: 'Ballon d’eau', agendaItemIds: [21, 22], fileIds: [12] });
    expect(parseReferenceEventSplit({ supplierIds: [5] })).toEqual({ supplierIds: [5] });
  });

  it('demande refusée : aucun fait, champ inconnu, identifiant invalide, intitulé vide ou trop long, liste trop longue', () => {
    for (const body of [
      null, 'x', {}, { label: 'Ballon' }, { agendaItemIds: [] },
      { agendaItemIds: [21], parentId: 9 },
      { agendaItemIds: [0] }, { agendaItemIds: [-1] }, { agendaItemIds: [1.5] }, { agendaItemIds: ['x'] }, { agendaItemIds: 21 },
      { label: '   ', agendaItemIds: [21] }, { label: 'x'.repeat(REFERENCE_EVENT_LABEL_MAX + 1), agendaItemIds: [21] },
      { label: 42, agendaItemIds: [21] },
      { expectedVersion: 0, agendaItemIds: [21] }, { expectedVersion: 'x', agendaItemIds: [21] },
      { fileIds: Array.from({ length: 101 }, (_, i) => i + 1) },
    ]) {
      expect(parseReferenceEventSplit(body), JSON.stringify(body)).toBeNull();
    }
  });
});

describe('L114OS-U03 — aperçu avant d’écrire', () => {
  it('tous les faits déplaçables de la fiche, dans l’ordre de la page', () => {
    expect(referenceEventSplitItems(courant).map((i) => `${i.part}-${i.id}`))
      .toEqual(['agenda-21', 'agenda-22', 'document-11', 'document-12', 'supplier-5']);
    expect([...REFERENCE_EVENT_SPLIT_PARTS]).toEqual(['agenda', 'document', 'supplier']);
  });

  it('ce qui part et ce qui reste, sans rien perdre ni rien dupliquer', () => {
    const apercu = referenceEventSplitPreview(courant, form({ agendaItemIds: [22], fileIds: [12] }));
    expect(apercu.moved.map((i) => i.title)).toEqual(['Visite d’entretien', 'Devis du ballon']);
    expect(apercu.kept.map((i) => i.title)).toEqual(['Remplacement de la chaudière', 'Facture de la chaudière', 'Plomberie Martin']);
    // Chaque fait de la fiche est d'un côté ou de l'autre, jamais des deux.
    expect(apercu.moved.length + apercu.kept.length).toBe(referenceEventSplitItems(courant).length);
    expect(apercu.moved.filter((m) => apercu.kept.some((k) => k.part === m.part && k.id === m.id))).toEqual([]);
  });

  it('la demande envoyée porte la version lue, l’intitulé et SEULEMENT les faits désignés', () => {
    const r = buildReferenceEventSplit(courant, form({ agendaItemIds: [22], supplierIds: [5] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body).toEqual({ expectedVersion: 7, label: 'Remplacement du ballon', agendaItemIds: [22], supplierIds: [5] });
    expect(r.preview.moved.map((i) => i.id)).toEqual([22, 5]);
    // La demande construite est relue par la route sans perte (même contrat).
    expect(parseReferenceEventSplit(r.body)).toEqual(r.body);
  });

  it('un identifiant choisi qui n’est plus dans la fiche n’est jamais envoyé', () => {
    const r = buildReferenceEventSplit(courant, form({ agendaItemIds: [22, 999], fileIds: [404] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.agendaItemIds).toEqual([22]);
    expect(r.body.fileIds).toBeUndefined();
  });
});

describe('L114OS-U04 — refus dits avant tout envoi', () => {
  it('aucun intitulé, intitulé trop long, rien désigné, tout désigné', () => {
    const cas: Array<[ReferenceEventSplitForm, string]> = [
      [form({ label: '  ', agendaItemIds: [21] }), L.splitLabelRequired],
      [form({ label: 'x'.repeat(REFERENCE_EVENT_LABEL_MAX + 1), agendaItemIds: [21] }), L.labelTooLong],
      [form(), L.splitNothingChosen],
      [form({ agendaItemIds: [21, 22], fileIds: [11, 12], supplierIds: [5] }), L.splitAllChosen],
    ];
    for (const [f, erreur] of cas) {
      const r = buildReferenceEventSplit(courant, f);
      expect(r.ok, erreur).toBe(false);
      if (r.ok) continue;
      expect(r.error).toBe(erreur);
    }
  });

  it('une fiche sans aucun fait déplaçable ne peut pas être scindée', () => {
    const vide: ReferenceEventSplitCurrent = { version: 1, agendaItems: [], documents: [], suppliers: [] };
    const r = buildReferenceEventSplit(vide, form({ agendaItemIds: [21] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(L.splitNothingChosen);
  });
});

describe('L114OS-U05 — gardes de code', () => {
  it('la route : garde d’écriture, compte de la session, façade, phrase utilisateur, aucune règle métier', () => {
    const code = visible(lire(ROUTE));
    expect(code).toContain('refuserSiLectureSeule(scope.accountId)');
    expect(code).toContain('openReferenceEventRoute(req, context)');
    expect(code).toContain('splitOperation(scope.ctx');
    expect(code).toContain("referenceEventWriteResponse('split'");
    expect(code).toContain('parseReferenceEventSplit(');
    // Le compte et l'événement scindé viennent de la session et de l'adresse, jamais du corps.
    expect(code).toContain('operationId: scope.operationId');
    expect(code).not.toMatch(/\baccountId:\s*(?:body|demande)\b/);
    // Aucun seuil, aucune liste métier, aucun SQL dans la route.
    expect(code).not.toMatch(/SELECT |INSERT |business_operation/);
  });

  it('la façade : la scission réutilise les corps des gestes, mémorise la séparation et ne supprime rien', () => {
    const facade = lire(FACADE);
    const corps = facade.slice(facade.indexOf("'splitOperation', input, async"));
    expect(corps).toContain("if (ctx.actor.kind !== 'USER') return stop(refused('FORBIDDEN', 'USER_ONLY'));");
    // Aucune règle dupliquée : les corps des gestes de la page font le déplacement.
    for (const appel of ['unlinkAgendaItemBody(ctx, g,', 'linkAgendaItemBody(ctx, g,', 'moveDocumentBody(ctx, g,', "supplierBody(ctx, g, 'unlinkSupplier'", "supplierBody(ctx, g, 'linkSupplier'"]) {
      expect(corps, appel).toContain(appel);
    }
    // Version attendue, journal des DEUX côtés, relation d'association gardée, mémoire de la séparation.
    expect(corps).toContain("refused('CONFLICT', 'VERSION_MISMATCH'");
    expect(corps).toContain("relationKind: 'OPERATION', operationId: cree.id, otherOperationId: faits.id, action: 'CREATED'");
    expect(corps).toContain("relationKind: 'OPERATION', operationId: faits.id, otherOperationId: cree.id, action: 'UPDATED'");
    expect(corps).toContain("nature: 'ASSOCIATED', state: 'ACTIVE', origin: 'USER', reasonCode: SPLIT_RELATION_REASON");
    expect(facade).toContain("export const SPLIT_RELATION_REASON = 'USER_SPLIT';");
    // Jamais une suppression physique, jamais un rôle « principal », aucune date inventée pour le nouveau.
    expect(corps).not.toMatch(/DELETE FROM|PRINCIPAL|new Date\(|Date\.now/);
    // La séparation est lisible par un rapprochement automatique avant toute refusion.
    expect(lire('src/services/business-operations/graph/read.ts')).toContain('export async function wasSplitApart(');
  });

  it('l’écran : aperçu avant d’écrire, aucune règle métier, aucun code affiché, charte et cibles tactiles', () => {
    const code = visible(lire('src/components/reference-events/ReferenceEventWrite.tsx'));
    const dialogue = code.slice(code.indexOf('function SplitDialog'), code.indexOf('Chef d’orchestre'));
    // L'enregistrement n'est proposé qu'après l'aperçu (deux temps : « Vérifier » puis « Scinder »).
    expect(dialogue).toContain('data-testid="reference-event-split-review"');
    expect(dialogue).toContain('data-testid="reference-event-split-save"');
    expect(dialogue.indexOf('apercu ? (')).toBeLessThan(dialogue.indexOf('data-testid="reference-event-split-save"'));
    expect(dialogue).toContain('buildReferenceEventSplit(fiche, form)');
    expect(dialogue).toContain('/scission');
    // Aucun code de la façade, aucune phrase en dur, aucune couleur brute, cibles de 44 px.
    expect(dialogue).not.toMatch(/SPLIT_[A-Z_]+:|VERSION_MISMATCH|#[0-9a-fA-F]{3,8}\b|rgba?\(/);
    expect(dialogue).toMatch(/min-h-\[44px\]/);
    expect(dialogue).not.toMatch(/Opération/);
  });
});

describe('L114OS-U06 — page rendue', () => {
  const fiche = (over: Partial<ReferenceEventPageView> = {}): ReferenceEventPageView => ({
    id: 42, redirectedFrom: null, version: 7, title: 'Intervention — Chaudière', ownLabel: 'Chaudière',
    typeCode: 'INTERVENTION', provider: null, dates: [{ role: 'REALIZED', date: '2025-06-27' }], undated: false,
    declarations: [], assets: [], equipments: [],
    suppliers: [{ id: 5, name: 'Plomberie Martin' }], coverages: [],
    documents: [{ fileId: 11, title: 'Facture de la chaudière', date: '2025-06-27' }],
    agendaItems: [{ id: 21, title: 'Remplacement de la chaudière', date: '2025-06-27', shared: false }],
    relations: [], ...over,
  });
  const openers = { openDocument: () => undefined, openAgendaItem: () => undefined, openEquipment: () => undefined, onPeriodsSaved: () => undefined };
  const rien = () => undefined;
  const actions = {
    correct: rien, remove: rien, linkAgenda: rien, unlinkAgenda: rien, linkDocument: rien, unlinkDocument: rien,
    moveDocument: rien, linkSupplier: rien, unlinkSupplier: rien, associate: rien, dissociate: rien, split: rien,
  };
  const rendre = (f: ReferenceEventPageView, avecScission = true) =>
    renderToStaticMarkup(h(ReferenceEventPageContent, { fiche: f, openers, actions: avecScission ? actions : { ...actions, split: undefined } }));

  it('« Scinder » est proposé dans la barre de gestes, une fois', () => {
    const html = rendre(fiche());
    expect(html).toContain('data-testid="reference-event-action-split"');
    expect(html.match(/Scinder/g)?.length).toBe(1);
    expect(html).not.toMatch(/Opération/);
  });

  it('rien à déplacer : le geste n’est pas proposé (une action dit son périmètre)', () => {
    const html = rendre(fiche({ suppliers: [], documents: [], agendaItems: [] }), false);
    expect(html).not.toContain('data-testid="reference-event-action-split"');
    expect(html).not.toContain('Scinder');
    // Les autres gestes restent là.
    expect(html).toContain('data-testid="reference-event-action-correct"');
  });

  it('la décision « quand proposer Scinder » vit dans le socle partagé, pas dans la page', () => {
    const orchestre = visible(lire('src/components/reference-events/ReferenceEventWrite.tsx'));
    expect(orchestre).toContain('referenceEventSplitItems(fiche).length > 0');
    expect(visible(lire('src/components/reference-events/ReferenceEventPageContent.tsx'))).toContain('actions.split &&');
  });
});
