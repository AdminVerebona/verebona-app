/**
 * Passage 114AB (Trello #753, CDC T2 §14.3 W12 et W14, §14.4 « Documents ») —
 *
 *   · **NATURE d'un document** : sa Rubrique et son Type (référentiel V2), le vrai manque de la carte. Le
 *     point d'écriture est créé dans la façade partagée (`updateDocumentClassificationForAccount`) ;
 *   · **supprimer PLUSIEURS documents à la fois** : liste complète annoncée, tout ou rien.
 *
 *   B01  phrases reconnues (rubrique, type, nature, catégorie) ; non-régression des autres champs ;
 *   B02  aperçu : valeur du référentiel, état avant → après, règles de classement annoncées à blanc ;
 *   B03  jamais un choix au hasard : valeur inconnue, ambiguë, déjà en place → question, aucun plan ;
 *   B04  empreinte du classement : distincte de celle du document, un changement bloque l'écriture ;
 *   B05  suppression multiple : phrases reconnues, liste annoncée, doublon et plafond refusés ;
 *   B06  exécution : une seule écriture métier, par la façade partagée, tout ou rien.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) }, db: {} }));

const { parseCommand } = await import('../../parser');
const { resolveDraft, documentVersion, documentClassificationVersion, MAX_BULK_DOCUMENTS } = await import('../../plan.service');
const { WRITE_COMMAND_CATALOG } = await import('../../catalog');
const { matchDocumentType, matchRubric, rubricLabelOf, typeLabelOf } = await import('../../document-classification');
type Lookup = import('../../plan.service').CommandLookup;
type Doc = import('../../plan.service').DocumentState;

const TODAY = '2026-11-13';
const input = { accountId: 1, userId: 2, planType: 'PREMIUM', message: '', clientRequestId: 'x', locale: 'fr-FR' } as never;
const sansAccent = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

const doc = (id: number, title: string, classement: { rubricCode?: string | null; documentTypeCode?: string | null } = {}): Doc => {
  const b = { id, title, documentDate: '2026-03-10', notesShown: '' };
  return {
    ...b, originalFilename: `${title}.pdf`, notesUserOwned: false, isWebLink: false, webLinkUrl: null,
    assetLabel: 'Maison', rubricCode: classement.rubricCode ?? null, documentTypeCode: classement.documentTypeCode ?? null,
    version: documentVersion(b),
  };
};
const FACTURE = doc(33, 'Facture EDF');
const GDF = doc(34, 'Facture GDF');
const NOTICE = doc(35, 'Notice chaudière');

const lookup = (docs: Doc[] = [FACTURE]): Lookup => ({
  today: () => TODAY,
  async findAssets() { return []; },
  async getAsset() { return null; },
  async findDocuments(_a, w) {
    return docs.filter((d) => w.every((x) => sansAccent(d.title).includes(x)))
      .map((d) => ({ id: d.id, title: d.title, documentDate: d.documentDate }));
  },
  async getDocumentState(_a, id) { return docs.find((d) => d.id === id) ?? null; },
});
const besoin = (a: unknown) => (a as { needInfo: string }).needInfo;
const effets = (a: unknown) => (a as { effects: string[] }).effects;

describe('L114AB-B01 — phrases reconnues (nature d’un document)', () => {
  it.each([
    ['Change la rubrique du document Facture EDF en Assurances et sinistres', 'rubric', 'Assurances et sinistres'],
    ['Modifie la rubrique du document Facture EDF : Entretien et travaux', 'rubric', 'Entretien et travaux'],
    ['Classe le document Facture EDF dans la rubrique Entretien et travaux', 'rubric', 'Entretien et travaux'],
    ['Change le type du document Facture EDF en Facture de réparation', 'type', 'Facture de réparation'],
    ['Mets la nature du document Facture EDF à Facture de travaux', 'type', 'Facture de travaux'],
    ['Change la catégorie du document Facture EDF en Photos et vidéos', 'rubric', 'Photos et vidéos'],
  ])('%s', (phrase, level, valeur) => {
    expect(parseCommand(phrase, TODAY)).toMatchObject({
      command: 'UPDATE_DOCUMENT_CLASSIFICATION', level, requestedValue: valeur, documentWords: ['facture', 'edf'],
    });
  });

  it('« ce document » : le document du fil', () => {
    expect(parseCommand('Change la rubrique de ce document en Photos et vidéos', TODAY))
      .toMatchObject({ command: 'UPDATE_DOCUMENT_CLASSIFICATION', level: 'rubric', documentFromContext: true, documentWords: [] });
  });

  it('le niveau nommé sans valeur reste une commande (la question est posée ensuite)', () => {
    expect(parseCommand('Change la rubrique du document Facture EDF', TODAY))
      .toMatchObject({ command: 'UPDATE_DOCUMENT_CLASSIFICATION', requestedValue: null });
  });

  it('non-régression : titre, date et note d’un document gardent leur commande', () => {
    expect(parseCommand('Renomme le document Facture EDF en Facture électricité', TODAY))
      .toMatchObject({ command: 'UPDATE_DOCUMENT', field: 'title' });
    expect(parseCommand('Change la date du document Facture EDF au 12 mars 2025', TODAY))
      .toMatchObject({ command: 'UPDATE_DOCUMENT', field: 'date' });
    expect(parseCommand('Efface la note de ce document', TODAY))
      .toMatchObject({ command: 'UPDATE_DOCUMENT', field: 'notes', clear: true });
  });

  it('non-régression : « change le type de l’intervention … » reste un événement de référence', () => {
    expect(parseCommand('Change le type de l’intervention Vidange en contrat', TODAY))
      .toMatchObject({ command: 'UPDATE_REFERENCE_EVENT', field: 'type' });
  });
});

describe('L114AB-B02 — aperçu : valeur du référentiel, avant → après', () => {
  it('rubrique : l’aperçu nomme les libellés, jamais les codes', async () => {
    const d = parseCommand('Change la rubrique du document Facture EDF en Assurances et sinistres', TODAY)!;
    const a = await resolveDraft(d, input, lookup([doc(33, 'Facture EDF', { rubricCode: 'MEDIA' })]));
    expect(a).toMatchObject({
      command: 'UPDATE_DOCUMENT_CLASSIFICATION',
      preview: 'Modifier « Rubrique » du document « Facture EDF » : Photos et vidéos → Assurances et sinistres.',
      params: { kind: 'document_classification', documentId: 33, classificationLevel: 'rubric', rubricValue: 'INSURANCE_CLAIMS', expectedRubric: 'MEDIA', expectedType: null },
    });
    expect(effets(a)).toContain('Rubrique : Photos et vidéos → Assurances et sinistres');
    expect(effets(a)).toContain('Ce classement est votre décision : il ne sera pas remplacé par une analyse.');
    expect(JSON.stringify(a)).not.toContain('INSURANCE_CLAIMS"]');
  });

  it('sans rubrique en place : « Sans rubrique » → la nouvelle', async () => {
    const d = parseCommand('Classe le document Facture EDF dans la rubrique Entretien et travaux', TODAY)!;
    const a = await resolveDraft(d, input, lookup());
    expect(a).toMatchObject({ preview: 'Modifier « Rubrique » du document « Facture EDF » : Sans rubrique → Entretien et travaux.' });
  });

  it('type : la rubrique DÉDUITE est annoncée (règle du classement appliquée à blanc)', async () => {
    const d = parseCommand('Change le type du document Facture EDF en Facture de réparation', TODAY)!;
    const a = await resolveDraft(d, input, lookup());
    expect(a).toMatchObject({
      preview: 'Modifier « Type » du document « Facture EDF » : non précisé → Facture de réparation.',
      params: { classificationLevel: 'type', typeValue: 'REPAIR_INVOICE', expectedRubric: null, expectedType: null },
    });
    expect(effets(a)).toContain('Rubrique : Sans rubrique → Entretien et travaux');
    expect(effets(a)).toContain('Type : non précisé → Facture de réparation');
    expect(effets(a)).toContain('La rubrique est déduite de ce type : c’est elle qui range le document.');
  });

  it('rubrique changée : un type qui n’en relève plus est annoncé comme vidé', async () => {
    const d = parseCommand('Change la rubrique du document Facture EDF en Photos et vidéos', TODAY)!;
    const a = await resolveDraft(d, input, lookup([doc(33, 'Facture EDF', { rubricCode: 'MAINTENANCE_WORKS', documentTypeCode: 'REPAIR_INVOICE' })]));
    expect(effets(a)).toContain('Type : Facture de réparation → non précisé');
    expect(effets(a)).toContain('Le type actuel ne relève pas de cette rubrique : il sera vidé, et vous pourrez en choisir un autre.');
  });

  it('la cible de la trace est le document', async () => {
    const a = await resolveDraft(parseCommand('Change la rubrique du document Facture EDF en Photos et vidéos', TODAY)!, input, lookup());
    expect((a as { targets: unknown[] }).targets).toEqual([{ type: 'document', id: 33, label: 'Facture EDF' }]);
  });
});

describe('L114AB-B03 — jamais un choix au hasard', () => {
  it('valeur hors référentiel : la question liste les rubriques', async () => {
    const d = parseCommand('Change la rubrique du document Facture EDF en Trésorerie', TODAY)!;
    const r = besoin(await resolveDraft(d, input, lookup()));
    expect(r).toContain('« Trésorerie » n’est pas une rubrique du référentiel.');
    expect(r).toContain('Propriété et gestion');
    expect(r).toContain('Autres documents');
  });

  it('type hors référentiel : la question liste les types de la rubrique en place', async () => {
    const d = parseCommand('Change le type du document Facture EDF en Bordereau magique', TODAY)!;
    const r = besoin(await resolveDraft(d, input, lookup([doc(33, 'Facture EDF', { rubricCode: 'MAINTENANCE_WORKS' })])));
    expect(r).toContain('n’est pas un type de document du référentiel');
    expect(r).toContain('pour la rubrique « Entretien et travaux »');
  });

  it('plusieurs valeurs de même libellé (« Autre » de chaque rubrique) : la liste et une question', async () => {
    const d = parseCommand('Change le type du document Facture EDF en Autre', TODAY)!;
    const r = besoin(await resolveDraft(d, input, lookup()));
    expect(r).toContain('Plusieurs types correspondent');
    expect(r).toContain('« Autre » (');
  });

  it('valeur déjà en place : c’est dit, aucun plan', async () => {
    const dejaRubrique = parseCommand('Change la rubrique du document Facture EDF en Entretien et travaux', TODAY)!;
    expect(besoin(await resolveDraft(dejaRubrique, input, lookup([doc(33, 'Facture EDF', { rubricCode: 'MAINTENANCE_WORKS' })]))))
      .toBe('La rubrique de « Facture EDF » est déjà « Entretien et travaux ».');
    const dejaType = parseCommand('Change le type du document Facture EDF en Facture de réparation', TODAY)!;
    expect(besoin(await resolveDraft(dejaType, input, lookup([doc(33, 'Facture EDF', { rubricCode: 'MAINTENANCE_WORKS', documentTypeCode: 'REPAIR_INVOICE' })]))))
      .toBe('Le type de « Facture EDF » est déjà « Facture de réparation ».');
  });

  it('niveau nommé sans valeur : la question liste les valeurs possibles', async () => {
    const d = parseCommand('Change la rubrique du document Facture EDF', TODAY)!;
    expect(besoin(await resolveDraft(d, input, lookup()))).toContain('Quelle rubrique voulez-vous donner à « Facture EDF » ?');
    const t = parseCommand('Change le type du document Facture EDF', TODAY)!;
    expect(besoin(await resolveDraft(t, input, lookup()))).toContain('Quel type voulez-vous donner à « Facture EDF » ?');
  });

  it('document introuvable ou ambigu : une question, aucun plan', async () => {
    expect(besoin(await resolveDraft(parseCommand('Change la rubrique du document Inconnu en Photos et vidéos', TODAY)!, input, lookup())))
      .toContain('Je n’ai pas trouvé ce document dans votre compte.');
    expect(besoin(await resolveDraft(parseCommand('Change la rubrique du document Facture en Photos et vidéos', TODAY)!, input, lookup([FACTURE, GDF]))))
      .toContain('Plusieurs documents correspondent');
  });

  it('la résolution du référentiel est pure et stricte', () => {
    expect(matchRubric('assurances et sinistres')).toMatchObject({ kind: 'found', value: { code: 'INSURANCE_CLAIMS' } });
    expect(matchRubric('photos et videos')).toMatchObject({ kind: 'found', value: { code: 'MEDIA' } });
    expect(matchRubric('inconnue')).toEqual({ kind: 'unknown' });
    expect(matchRubric('')).toEqual({ kind: 'unknown' });
    expect(matchDocumentType('facture de reparation', null)).toMatchObject({ kind: 'found', value: { code: 'REPAIR_INVOICE' } });
    expect(matchDocumentType('Autre', null).kind).toBe('ambiguous');
    // Le « Autre » de la rubrique en place l'emporte : chaque rubrique garde le sien (§2.2).
    expect(matchDocumentType('Autre', 'MAINTENANCE_WORKS')).toMatchObject({ kind: 'found' });
    expect(rubricLabelOf(null)).toBe('Sans rubrique');
    expect(typeLabelOf(null)).toBe('non précisé');
  });
});

describe('L114AB-B04 — empreinte du classement présenté', () => {
  it('distincte de l’empreinte du document : un plan déjà préparé garde la sienne', () => {
    const base = doc(1, 'X');
    expect(documentClassificationVersion(base)).not.toBe(base.version);
    expect(documentClassificationVersion(base)).toBe(documentClassificationVersion({ version: base.version, rubricCode: null, documentTypeCode: null }));
  });

  it('une rubrique ou un type différent change l’empreinte', () => {
    const v = 'v1';
    const sans = documentClassificationVersion({ version: v, rubricCode: null, documentTypeCode: null });
    expect(documentClassificationVersion({ version: v, rubricCode: 'MEDIA', documentTypeCode: null })).not.toBe(sans);
    expect(documentClassificationVersion({ version: v, rubricCode: null, documentTypeCode: 'REPAIR_INVOICE' })).not.toBe(sans);
  });

  it('l’empreinte figée à l’aperçu est celle du classement lu', async () => {
    const etat = doc(33, 'Facture EDF', { rubricCode: 'MEDIA' });
    const a = await resolveDraft(parseCommand('Change la rubrique du document Facture EDF en Entretien et travaux', TODAY)!, input, lookup([etat]));
    expect((a as { params: { expectedVersion: string } }).params.expectedVersion).toBe(documentClassificationVersion(etat));
  });
});

describe('L114AB-B05 — supprimer plusieurs documents à la fois (W14)', () => {
  it('phrases reconnues : les documents sont NOMMÉS un par un', () => {
    expect(parseCommand('Supprime les documents Facture EDF et Facture GDF', TODAY))
      .toEqual({ command: 'DELETE_DOCUMENTS', documentGroups: [['facture', 'edf'], ['facture', 'gdf']] });
    expect(parseCommand('Supprime les documents Facture EDF, Facture GDF et Notice chaudière', TODAY))
      .toMatchObject({ command: 'DELETE_DOCUMENTS', documentGroups: [['facture', 'edf'], ['facture', 'gdf'], ['notice', 'chaudiere']] });
  });

  it('une seule désignation n’est pas une suppression multiple (comportement d’avant)', () => {
    expect(parseCommand('Supprime les documents de la maison', TODAY)).toBeNull();
    expect(parseCommand('Supprime le document Facture EDF', TODAY)).toMatchObject({ command: 'DELETE_DOCUMENT' });
  });

  it('aperçu : la liste COMPLÈTE est annoncée, et le tout ou rien est dit', async () => {
    const d = parseCommand('Supprime les documents Facture EDF et Facture GDF', TODAY)!;
    const a = await resolveDraft(d, input, lookup([FACTURE, GDF]));
    expect(a).toMatchObject({
      command: 'DELETE_DOCUMENTS',
      preview: 'Supprimer 2 documents : « Facture EDF » du 10 mars 2026 (Maison), « Facture GDF » du 10 mars 2026 (Maison).',
      params: { kind: 'documents_delete', documents: [{ documentId: 33 }, { documentId: 34 }] },
    });
    expect(effets(a)).toContain('Document : « Facture EDF » du 10 mars 2026 (Maison)');
    expect(effets(a)).toContain('Document : « Facture GDF » du 10 mars 2026 (Maison)');
    expect(effets(a)).toContain('Tout ou rien : si l’un d’eux a changé entre-temps, aucun n’est supprimé.');
    expect(effets(a)).toContain('Cette suppression ne s’annule pas depuis l’Assistant.');
    expect((a as { targets: unknown[] }).targets).toEqual([
      { type: 'document', id: 33, label: 'Facture EDF' }, { type: 'document', id: 34, label: 'Facture GDF' },
    ]);
    // L'empreinte de CHAQUE document est figée.
    expect((a as { params: { documents: Array<{ expectedVersion: string }> } }).params.documents.map((x) => x.expectedVersion))
      .toEqual([FACTURE.version, GDF.version]);
  });

  it('une désignation introuvable ou ambiguë annule toute la demande', async () => {
    expect(besoin(await resolveDraft(parseCommand('Supprime les documents Facture EDF et Inconnu', TODAY)!, input, lookup([FACTURE, GDF]))))
      .toContain('Je n’ai pas trouvé ce document dans votre compte.');
    expect(besoin(await resolveDraft(parseCommand('Supprime les documents Facture et Notice chaudière', TODAY)!, input, lookup([FACTURE, GDF, NOTICE]))))
      .toContain('Plusieurs documents correspondent');
  });

  it('un document nommé deux fois : c’est dit, aucun plan', async () => {
    const d = parseCommand('Supprime les documents Facture EDF et Facture EDF', TODAY)!;
    expect(besoin(await resolveDraft(d, input, lookup([FACTURE]))))
      .toBe('« Facture EDF » est nommé deux fois dans votre demande. Précisez les documents à supprimer.');
  });

  it('au-delà du plafond, la demande est refusée sans rien préparer', async () => {
    const noms = Array.from({ length: MAX_BULK_DOCUMENTS + 1 }, (_, i) => `Doc${i}`);
    const d = { command: 'DELETE_DOCUMENTS' as const, documentGroups: noms.map((n) => [n.toLowerCase()]) };
    expect(besoin(await resolveDraft(d, input, lookup()))).toContain(`Je ne supprime pas plus de ${MAX_BULK_DOCUMENTS} documents à la fois`);
  });
});

describe('L114AB-B06 — exécution : une seule écriture métier', () => {
  const src = readFileSync(join(__dirname, '../../executors.ts'), 'utf8');
  const nature = src.slice(src.indexOf('async UPDATE_DOCUMENT_CLASSIFICATION('), src.indexOf('async DELETE_DOCUMENTS('));
  const multiple = src.slice(src.indexOf('async DELETE_DOCUMENTS('), src.indexOf('async CREATE_SUPPLIER('));

  it('la nature passe par le point d’écriture de la façade, avec l’état relu', () => {
    expect(nature).toMatch(/updateDocumentClassificationForAccount\(/);
    expect(nature).toMatch(/documentClassificationVersion\(etat\) !== p\.expectedVersion/);
    expect(nature).toMatch(/expectedCurrent: \{ rubricCode: p\.expectedRubric, documentTypeCode: p\.expectedType \}/);
    // Aucune écriture propre : pas de SQL dans cet exécuteur.
    expect(nature).not.toMatch(/pgClient|UPDATE |INSERT /);
  });

  it('la suppression multiple relit TOUT avant de supprimer quoi que ce soit', () => {
    const relecture = multiple.indexOf('getDocumentState');
    const suppression = multiple.indexOf('softDeleteDocument({');
    expect(relecture).toBeGreaterThan(-1);
    expect(suppression).toBeGreaterThan(relecture);
    expect(multiple).toMatch(/aucun document n’a été supprimé/);
    expect(multiple).not.toMatch(/pgClient|DELETE FROM/);
  });

  it('les deux commandes sont au catalogue fermé, avec leur fiche', () => {
    for (const type of ['UPDATE_DOCUMENT_CLASSIFICATION', 'DELETE_DOCUMENTS'] as const) {
      const def = WRITE_COMMAND_CATALOG[type];
      expect(def.requiresWriteAccess).toBe(true);
      expect(def.service).toMatch(/^document-write\.facade\./);
      expect(def.spec?.readBeforeWrite).toBe(true);
      expect(def.spec?.undoPolicy).toBe('IRREVERSIBLE');
    }
    expect(WRITE_COMMAND_CATALOG.DELETE_DOCUMENTS.spec?.deletePolicy).toBe('SOFT_DELETE');
    expect(WRITE_COMMAND_CATALOG.UPDATE_DOCUMENT_CLASSIFICATION.label).toBe('Modifier la nature d’un document');
  });

  it('aucun texte de l’aperçu ne dit « Opération »', async () => {
    const a = await resolveDraft(parseCommand('Change la rubrique du document Facture EDF en Photos et vidéos', TODAY)!, input, lookup());
    expect(JSON.stringify(a)).not.toMatch(/Op[ée]ration/);
  });
});

describe('L114AB-B07 — actions comprises par le sens (bloc PO n° 40, facultatif)', () => {
  type Hint = import('@/services/verebona-assistant/types/contracts').ActionHint;
  const hint = (over: Partial<Hint>): Hint => ({ operation: 'UPDATE', entityType: 'document', targetHint: null, fieldChanges: [], evidencePhrase: null, ...over });
  const ch = (fieldHint: string, value: string | null) => ({ fieldHint, value, unit: null });

  it('un indice « rubrique » ou « type » aboutit à la MÊME commande que la phrase directe', async () => {
    const { draftsFromActionHints } = await import('../../action-hints');
    const un = (h: Hint) => draftsFromActionHints([h], TODAY)?.drafts[0] ?? null;
    expect(un(hint({ targetHint: 'le document Facture EDF', fieldChanges: [ch('rubrique', 'Assurances et sinistres')] })))
      .toMatchObject({ command: 'UPDATE_DOCUMENT_CLASSIFICATION', level: 'rubric', requestedValue: 'Assurances et sinistres', documentWords: ['facture', 'edf'] });
    expect(un(hint({ targetHint: 'la Facture EDF', fieldChanges: [ch('type', 'Facture de réparation')] })))
      .toMatchObject({ command: 'UPDATE_DOCUMENT_CLASSIFICATION', level: 'type', requestedValue: 'Facture de réparation' });
    // « nature » est le mot courant du Type d'un document.
    expect(un(hint({ targetHint: 'la Facture EDF', fieldChanges: [ch('nature', 'Garantie')] })))
      .toMatchObject({ command: 'UPDATE_DOCUMENT_CLASSIFICATION', level: 'type', requestedValue: 'Garantie' });
  });

  it('indices écartés : valeur absente, deux champs dans le même indice', async () => {
    const { draftsFromActionHints } = await import('../../action-hints');
    expect(draftsFromActionHints([hint({ targetHint: 'la Facture EDF', fieldChanges: [ch('rubrique', null)] })], TODAY)).toBeNull();
    expect(draftsFromActionHints([hint({ targetHint: 'la Facture EDF', fieldChanges: [ch('rubrique', 'Médias'), ch('type', 'Garantie')] })], TODAY)).toBeNull();
  });

  it('non-régression : renommer un document par le sens est inchangé', async () => {
    const { draftsFromActionHints } = await import('../../action-hints');
    expect(draftsFromActionHints([hint({ targetHint: 'la Facture EDF', fieldChanges: [ch('nom', 'Facture électricité')] })], TODAY)?.drafts[0])
      .toMatchObject({ command: 'UPDATE_DOCUMENT', field: 'title' });
  });

  it('la suppression de PLUSIEURS documents n’est jamais ouverte aux indices', async () => {
    const { draftsFromActionHints } = await import('../../action-hints');
    const h = hint({ operation: 'DELETE', targetHint: 'les documents Facture EDF et Facture GDF', fieldChanges: [] });
    const d = draftsFromActionHints([h], TODAY)?.drafts[0] ?? null;
    expect(d === null || d.command !== 'DELETE_DOCUMENTS').toBe(true);
  });
});

describe('L114AB-B08 — vocabulaire', () => {
  it('aucun texte de ce passage ne dit « Opération »', async () => {
    const a = await resolveDraft(parseCommand('Change la rubrique du document Facture EDF en Photos et vidéos', TODAY)!, input, lookup());
    expect(JSON.stringify(a)).not.toMatch(/Op[ée]ration/);
  });
});
