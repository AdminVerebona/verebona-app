/**
 * Machine d'états de l'écran de préparation (CDC V12 §5.3, §2.1) et règles
 * de sélection côté écran (SEL-GEN-002/008/009/010/011), ALT-002, ALT-003,
 * MSG-PREP-006, suivi du job (§15.3), payload §17.2.
 */
import { describe, it, expect } from 'vitest';
import {
  MAX_AUTO_ESTIMATE_RETRIES, estimateRetryDelayMs, linkedStatus, buildChoices, buildGenerateBody, dossierOutline, generateDecision, initialPrepState, needsCloseConfirmation,
  prepReducer, progressSteps, sectionCounts, type PrepAction, type PrepState,
} from '../preparation-state';
import type { EstimateDto, PrepItem, PrepSection, PreparationDto } from '@/services/exports/v12/preparation/types';

const estimate = (over: Partial<EstimateDto> = {}): EstimateDto => ({
  outputFormat: 'PDF', estimatedPages: 8, estimatedBytes: 900_000, pdfItems: 2, zipItems: 0, pdfDocuments: 1, zipDocuments: 0,
  pdfPhotos: 1, zipPhotos: 0, events: 0, blocking: [], warnings: [], zipOnlyItems: [], unavailable: [], longGeneration: false, ...over,
});

const it_ = (key: string, over: Partial<PrepItem> = {}): PrepItem => {
  const [sourceType, id] = key.split(':');
  return {
    key, sourceType: sourceType as PrepItem['sourceType'], sourceId: Number(id), type: sourceType === 'photo' ? 'photo' : 'document',
    label: key, typeLabel: null, source: 'Documents du bien', date: null, format: 'PDF', sizeBytes: 1000, compatibility: 'integrable',
    sensitive: false, allowedModes: ['PDF', 'ZIP'], selectable: true, recommended: false, recommendedMode: 'PDF', selected: false, mode: 'PDF',
    fileId: Number(id), detail: null, error: null, ...over,
  };
};

const sec = (id: string, items: PrepItem[], over: Partial<PrepSection> = {}): PrepSection => ({
  id, label: id, description: '', required: false, toggleable: true, enabled: items.some((i) => i.selected), defaultEnabled: true,
  recommended: true, itemType: items[0]?.type ?? null, items, infoSections: [], cil: false, fedBy: null, fedFilled: null, rows: [],
  hasSensitive: items.some((i) => i.sensitive), ...over,
});

function prep(): PreparationDto {
  return {
    assetId: 1, exportType: 'DOSSIER_COMPLET', status: 'ready_pristine',
    dossier: { code: 'DOSSIER_COMPLET', label: 'Dossier complet du bien', shortLabel: 'Dossier complet', description: '', templateVersion: 'x' },
    asset: { id: 1, name: 'Maison', family: 'IMMOBILIER', familyLabel: 'Immobilier', categoryLabel: 'Maison' },
    eligibility: { status: 'ready', message: null }, lastGeneration: null,
    sections: [
      sec('cover', [], { required: true, toggleable: false, enabled: true, itemType: null, label: 'Couverture' }),
      sec('summary', [], { required: true, toggleable: false, enabled: true, itemType: null, label: 'Synthèse du dossier' }),
      sec('documents', [
        it_('document:1', { selected: true, recommended: true }),
        it_('document:2', { sensitive: true }),
        it_('document:3', { compatibility: 'zip_only', allowedModes: ['ZIP'], recommendedMode: 'ZIP', mode: 'ZIP', format: 'DOCX' }),
        it_('document:4', { compatibility: 'missing', allowedModes: [], selectable: false, mode: null, recommendedMode: null }),
      ], { label: 'Documents clés' }),
      sec('photos', [it_('photo:1', { selected: true, recommended: true }), it_('photo:2')], { label: 'Photos du bien' }),
      sec('finance', [], { enabled: false, defaultEnabled: false, recommended: false, itemType: null, label: 'Valeur, acquisition et informations financières' }),
      sec('references', [], { required: true, toggleable: false, enabled: true, itemType: null, label: 'Méthode, sources et limites' }),
    ],
    photoCap: 8, additionalInfo: { sections: [], updatedAt: null }, cil: null, estimate: estimate(),
    actions: { canGeneratePdf: true, canGenerateZip: false }, messages: [],
    thresholds: { docsWarning: 20, docsBlocking: 50, bytesWarning: 1, bytesBlocking: 2, pagesBlocking: 300, photosBlocking: 100 }, empty: false,
  };
}

const run = (...actions: PrepAction[]): PrepState => actions.reduce(prepReducer, initialPrepState);
const loaded = (...actions: PrepAction[]) => run({ type: 'LOAD_START' }, { type: 'LOAD_SUCCESS', prep: prep() }, ...actions);
const selected = (s: PrepState) => Object.entries(s.items).filter(([, v]) => v.selected).map(([k]) => k).sort();

describe('Statuts §5.3', () => {
  it('idle → loading_preparation → ready_pristine', () => {
    expect(initialPrepState.status).toBe('idle');
    expect(run({ type: 'LOAD_START' }).status).toBe('loading_preparation');
    const s = loaded();
    expect(s.status).toBe('ready_pristine');
    expect(selected(s)).toEqual(['document:1', 'photo:1']);
    expect(needsCloseConfirmation(s)).toBe(false);
  });

  it('chargement en échec → failed', () => {
    expect(run({ type: 'LOAD_START' }, { type: 'LOAD_FAILURE', code: 'NOT_ELIGIBLE', message: 'x' })).toMatchObject({ status: 'failed', error: { code: 'NOT_ELIGIBLE' } });
  });

  it('préparation avec seuil bloquant dès l’ouverture → blocked_threshold', () => {
    const p = prep();
    p.estimate = estimate({ blocking: [{ code: 'DOCS_BLOCKING', type: 'blocking', message: 'm' }] });
    expect(run({ type: 'LOAD_SUCCESS', prep: p }).status).toBe('blocked_threshold');
  });

  it('modification → ready_modified → estimating → estimation_ready (estimation périmée ignorée)', () => {
    let s = loaded({ type: 'TOGGLE_ITEM', key: 'photo:2', selected: true });
    expect(s).toMatchObject({ status: 'ready_modified', modified: true, revision: 1 });
    expect(needsCloseConfirmation(s)).toBe(true);
    s = prepReducer(s, { type: 'ESTIMATE_START' });
    expect(s.status).toBe('estimating');
    expect(generateDecision(s, 'PDF')).toBe('blocked');
    // Réponse d'une révision antérieure : ignorée.
    expect(prepReducer(s, { type: 'ESTIMATE_SUCCESS', revision: 0, estimate: estimate({ estimatedPages: 99 }), actions: s.actions, messages: [] }).estimate?.estimatedPages).toBe(8);
    s = prepReducer(s, { type: 'ESTIMATE_SUCCESS', revision: 1, estimate: estimate({ pdfPhotos: 2 }), actions: s.actions, messages: [] });
    expect(s.status).toBe('estimation_ready');
    expect(s.estimate?.pdfPhotos).toBe(2);
  });

  it('seuil bloquant → blocked_threshold, génération impossible ; une modification repasse en ready_modified', () => {
    let s = loaded({ type: 'TOGGLE_ITEM', key: 'photo:2', selected: true }, { type: 'ESTIMATE_START' });
    s = prepReducer(s, { type: 'ESTIMATE_SUCCESS', revision: 1, estimate: estimate({ blocking: [{ code: 'PHOTOS_BLOCKING', type: 'blocking', message: 'm' }] }), actions: { canGeneratePdf: false, canGenerateZip: false }, messages: [] });
    expect(s.status).toBe('blocked_threshold');
    expect(generateDecision(s, 'PDF')).toBe('blocked');
    s = prepReducer(s, { type: 'TOGGLE_ITEM', key: 'photo:2', selected: false });
    expect(s.status).toBe('ready_modified');
  });

  it('fermeture : cancel_confirm puis retour à l’état précédent', () => {
    const s = loaded({ type: 'TOGGLE_ITEM', key: 'photo:2', selected: true }, { type: 'REQUEST_CLOSE' });
    expect(s).toMatchObject({ status: 'cancel_confirm', returnTo: 'ready_modified' });
    expect(prepReducer(s, { type: 'TOGGLE_ITEM', key: 'photo:1', selected: false }).status).toBe('cancel_confirm'); // gelé
    expect(prepReducer(s, { type: 'CANCEL_CLOSE' }).status).toBe('ready_modified');
  });
});

describe('Sélection (SEL-GEN-002/008/009/010/011)', () => {
  it('Tout cocher : jamais les pièces sensibles ni les fichiers indisponibles', () => {
    const s = loaded({ type: 'SECTION_ALL', id: 'documents' });
    expect(selected(s)).toEqual(['document:1', 'document:3', 'photo:1']);
    expect(s.items['document:3'].mode).toBe('ZIP');
  });

  it('Tout décocher : section désactivée ; réactivation → dernière sélection restaurée', () => {
    let s = loaded({ type: 'TOGGLE_ITEM', key: 'document:2', selected: true }, { type: 'SECTION_NONE', id: 'documents' });
    expect(s.sections.documents).toBe(false);
    expect(selected(s)).toEqual(['photo:1']);
    s = prepReducer(s, { type: 'SET_SECTION', id: 'documents', enabled: true });
    expect(s.sections.documents).toBe(true);
    expect(selected(s)).toEqual(['document:1', 'document:2', 'photo:1']);
  });

  it('dernière pièce décochée → section désactivée automatiquement ; cocher une pièce la réactive', () => {
    let s = loaded({ type: 'TOGGLE_ITEM', key: 'photo:1', selected: false });
    expect(s.sections.photos).toBe(false);
    s = prepReducer(s, { type: 'TOGGLE_ITEM', key: 'photo:2', selected: true });
    expect(s.sections.photos).toBe(true);
  });

  it('réactivation sans sélection mémorisée → recommandation', () => {
    const s = loaded({ type: 'SET_SECTION', id: 'photos', enabled: false }, { type: 'SECTION_NONE', id: 'photos' });
    const back = prepReducer({ ...s, memory: {} }, { type: 'SET_SECTION', id: 'photos', enabled: true });
    expect(back.items['photo:1'].selected).toBe(true);
  });

  it('restaurer la recommandation', () => {
    const s = loaded({ type: 'SECTION_ALL', id: 'photos' }, { type: 'SET_MODE', key: 'photo:1', mode: 'ZIP' }, { type: 'SECTION_RESTORE', id: 'photos' });
    expect(s.items['photo:1']).toEqual({ selected: true, mode: 'PDF' });
    expect(s.items['photo:2'].selected).toBe(false);
  });

  it('mode : PDF refusé pour un format non intégrable (DEC-005) ; fichier indisponible non cochable', () => {
    let s = loaded({ type: 'TOGGLE_ITEM', key: 'document:3', selected: true });
    s = prepReducer(s, { type: 'SET_MODE', key: 'document:3', mode: 'PDF' });
    expect(s.items['document:3'].mode).toBe('ZIP');
    expect(prepReducer(s, { type: 'TOGGLE_ITEM', key: 'document:4', selected: true }).items['document:4'].selected).toBe(false);
  });

  it('pièces liées à une ligne saisie : cochées ensemble, jamais la sensible ni l’indisponible', () => {
    const keys = ['photo:2', 'document:2', 'document:4', 'document:1'];
    const before = loaded({ type: 'SECTION_NONE', id: 'photos' });
    expect(linkedStatus(before, keys)).toEqual({ retained: ['document:1'], addable: ['photo:2'], sensitive: ['document:2'], missing: 1 });
    const s = prepReducer(before, { type: 'SELECT_LINKED', keys: linkedStatus(before, keys).addable });
    expect(s.items['photo:2'].selected).toBe(true);
    expect(s.sections.photos).toBe(true);
    expect(s.items['document:2'].selected).toBe(false);
    expect(prepReducer(s, { type: 'SELECT_LINKED', keys: ['document:2', 'document:4'] })).toBe(s);
  });

  it('section obligatoire verrouillée', () => {
    const s = loaded({ type: 'SET_SECTION', id: 'summary', enabled: false });
    expect(s.sections.summary).toBe(true);
    expect(s.modified).toBe(false);
  });

  it('compteurs de section', () => {
    const s = loaded({ type: 'TOGGLE_ITEM', key: 'document:3', selected: true });
    expect(sectionCounts(s, s.prep!.sections[2])).toEqual({ selected: 2, pdf: 1, zip: 1, total: 4 });
  });
});

describe('Génération (ALT-002, MSG-PREP-006, §17.2, §15.3)', () => {
  it('payload §17.2 : sections, éléments retenus avec leur mode, accusé « PDF seul »', () => {
    const s = loaded({ type: 'TOGGLE_ITEM', key: 'document:3', selected: true });
    const body = buildGenerateBody(s, 'PDF', true);
    expect(body.exportType).toBe('DOSSIER_COMPLET');
    expect(body.choices.outputFormat).toBe('PDF');
    expect(body.choices.acknowledgements).toEqual({ pdfOnlyExcludesZipItems: true });
    const docs = body.choices.sections.find((x) => x.id === 'documents')!;
    expect(docs).toMatchObject({ enabled: true });
    expect(docs.items).toEqual([
      { sourceType: 'document', sourceId: 1, selected: true, mode: 'PDF' },
      { sourceType: 'document', sourceId: 3, selected: true, mode: 'ZIP' },
    ]);
    expect(buildChoices(s, 'ZIP').sections.find((x) => x.id === 'finance')).toMatchObject({ enabled: false, items: [] });
  });

  it('ALT-002 : « Générer le PDF » avec des pièces ZIP → confirmation', () => {
    let s = loaded({ type: 'TOGGLE_ITEM', key: 'document:3', selected: true }, { type: 'ESTIMATE_START' });
    s = prepReducer(s, {
      type: 'ESTIMATE_SUCCESS', revision: 1,
      estimate: estimate({ outputFormat: 'ZIP', zipDocuments: 1, zipItems: 1, zipOnlyItems: [{ key: 'document:3', label: 'x' }] }),
      actions: { canGeneratePdf: true, canGenerateZip: true }, messages: [],
    });
    expect(generateDecision(s, 'PDF')).toBe('confirm_pdf_only');
    expect(generateDecision(s, 'ZIP')).toBe('go');
    expect(prepReducer(s, { type: 'OPEN_PDF_ONLY_CONFIRM' }).confirmPdfOnly).toBe(true);
  });

  it('ZIP indisponible sans pièce en mode ZIP (ZIP-001)', () => {
    expect(generateDecision(loaded(), 'ZIP')).toBe('blocked');
    expect(generateDecision(loaded(), 'PDF')).toBe('go');
  });

  it('MSG-PREP-006 : échec (ou enregistrement en cours) des informations → génération bloquée', () => {
    expect(generateDecision(loaded({ type: 'AUTOSAVE', status: 'error' }), 'PDF')).toBe('blocked');
    const saving = loaded({ type: 'AUTOSAVE', status: 'saving' });
    expect(saving).toMatchObject({ modified: true, status: 'ready_modified' });
    expect(generateDecision(saving, 'PDF')).toBe('blocked');
    // Enregistré puis estimation à jour : génération possible.
    const saved = loaded({ type: 'AUTOSAVE', status: 'saving' }, { type: 'AUTOSAVE', status: 'saved' }, { type: 'ESTIMATE_START' });
    expect(generateDecision(prepReducer(saved, { type: 'ESTIMATE_SUCCESS', revision: saved.revision, estimate: estimate(), actions: saved.actions, messages: [] }), 'PDF')).toBe('go');
  });

  it('CIL bloqué : génération impossible', () => {
    const p = prep();
    p.actions = { canGeneratePdf: false, canGenerateZip: false };
    expect(generateDecision(run({ type: 'LOAD_SUCCESS', prep: p }), 'PDF')).toBe('blocked');
  });

  it('generating → generated_pdf / generated_zip / generated_partial / failed', () => {
    const start = loaded({ type: 'GENERATE_START', format: 'ZIP', now: 0 }, { type: 'GENERATE_ACCEPTED', publicId: 'u', generationStatus: 'queued' });
    expect(start.status).toBe('generating');
    expect(needsCloseConfirmation(start)).toBe(true);
    const upd = (g: string, extra: Record<string, unknown> = {}) => prepReducer(start, { type: 'GENERATION_UPDATE', dto: { generationStatus: g, ...extra } });
    expect(upd('generating', { currentStep: 'render_pdf' }).status).toBe('generating');
    expect(upd('ready', { outputFormat: 'PDF' }).status).toBe('generated_pdf');
    expect(upd('ready', { outputFormat: 'ZIP' }).status).toBe('generated_zip');
    const partial = upd('partial', { outputFormat: 'PDF', excludedFiles: [{ label: 'Facture', reasonLabel: 'Fichier illisible' }] });
    expect(partial.status).toBe('generated_partial');
    expect(partial.generation?.excludedFiles).toHaveLength(1);
    expect(upd('failed', { errorMessage: 'La génération a échoué.' })).toMatchObject({ status: 'failed', error: { message: 'La génération a échoué.' } });
    expect(upd('expired').status).toBe('expired');
    expect(upd('deleted').status).toBe('file_deleted');
    // Retour à la préparation.
    expect(prepReducer(upd('ready', { outputFormat: 'PDF' }), { type: 'BACK_TO_EDIT' }).status).toBe('ready_modified');
  });

  it('refus synchrone : message, blocages du serveur, puis nouvelle estimation', () => {
    const s = loaded({ type: 'GENERATE_START', format: 'PDF', now: 0 });
    const blocking = [{ code: 'DOCS_BLOCKING', type: 'blocking' as const, message: 'Trop de documents' }];
    const t = prepReducer(s, { type: 'GENERATE_REJECTED', code: 'THRESHOLD_BLOCKED', message: 'Réduisez le contenu sélectionné.', blocking });
    expect(t).toMatchObject({ status: 'ready_modified', generation: null, error: { code: 'THRESHOLD_BLOCKED' }, revision: s.revision + 1 });
    expect(t.estimate?.blocking).toEqual(blocking);
    // Tant que la nouvelle estimation n'est pas revenue, rien ne part.
    expect(generateDecision(t, 'PDF')).toBe('blocked');
    const other = prepReducer(s, { type: 'GENERATE_REJECTED', code: 'TOO_MANY_GENERATIONS', message: 'm' });
    expect(other).toMatchObject({ status: 'ready_modified', confirmPdfOnly: false, error: { message: 'm' } });
  });

  it('409 « PDF seul » non confirmé : la confirmation s’ouvre avec les pièces du serveur', () => {
    const s = loaded({ type: 'GENERATE_START', format: 'PDF', now: 0 });
    const zipOnlyItems = [{ key: 'document:3', label: 'Devis Word' }];
    const t = prepReducer(s, { type: 'GENERATE_REJECTED', code: 'PDF_ONLY_CONFIRMATION_REQUIRED', message: 'Certaines pièces…', zipOnlyItems });
    expect(t.confirmPdfOnly).toBe(true);
    expect(t.estimate?.zipOnlyItems).toEqual(zipOnlyItems);
  });

  it('génération interdite sur une modification non encore estimée', () => {
    const s = loaded({ type: 'TOGGLE_ITEM', key: 'photo:2', selected: true });
    expect(s.status).toBe('ready_modified');
    expect(generateDecision(s, 'PDF')).toBe('blocked');
  });

  it('estimation en échec : état dédié, génération bloquée, pas de relance en boucle, reprise manuelle', () => {
    let s = loaded({ type: 'TOGGLE_ITEM', key: 'photo:2', selected: true }, { type: 'ESTIMATE_START' });
    s = prepReducer(s, { type: 'ESTIMATE_FAILURE', revision: s.revision });
    expect(s).toMatchObject({ status: 'estimate_failed', estimateFailures: 1 });
    expect(generateDecision(s, 'PDF')).toBe('blocked');
    // L'écran ne relance l'estimation que sur `ready_modified` : aucune boucle.
    expect(prepReducer(s, { type: 'ESTIMATE_START' }).status).toBe('estimating'); // (déclenché seulement par RETRY_ESTIMATE)
    const retried = prepReducer(s, { type: 'RETRY_ESTIMATE' });
    expect(retried).toMatchObject({ status: 'ready_modified', revision: s.revision + 1 });
    const again = prepReducer(prepReducer(retried, { type: 'ESTIMATE_START' }), { type: 'ESTIMATE_FAILURE', revision: retried.revision });
    expect(again.estimateFailures).toBe(2);
    const ok = prepReducer(prepReducer(again, { type: 'RETRY_ESTIMATE' }), { type: 'ESTIMATE_START' });
    expect(prepReducer(ok, { type: 'ESTIMATE_SUCCESS', revision: ok.revision, estimate: estimate(), actions: ok.actions, messages: [] })).toMatchObject({ status: 'estimation_ready', estimateFailures: 0 });
    expect(MAX_AUTO_ESTIMATE_RETRIES).toBe(3);
    expect([1, 2, 3].map(estimateRetryDelayMs)).toEqual([2000, 4000, 8000]);
  });

  it('rechargement (action CIL, informations enregistrées) : modifications, mémoire et enregistrement conservés', () => {
    let s = loaded({ type: 'SECTION_NONE', id: 'photos' }, { type: 'AUTOSAVE', status: 'saving' }, { type: 'AUTOSAVE', status: 'saved' });
    const memory = s.memory;
    const next = prep();
    next.sections = next.sections.map((x) => (x.id === 'finance' ? { ...x, fedFilled: true } : x));
    s = prepReducer(s, { type: 'RELOAD_SUCCESS', prep: next });
    expect(s).toMatchObject({ modified: true, autosave: 'saved', status: 'estimation_ready', memory });
    expect(s.items['photo:1'].selected).toBe(false);
    expect(s.sections.photos).toBe(false);
    expect(s.prep?.sections.find((x) => x.id === 'finance')?.fedFilled).toBe(true);
    // Contre-exemple : un chargement initial repart de zéro.
    expect(prepReducer(s, { type: 'LOAD_SUCCESS', prep: prep() }).modified).toBe(false);
  });

  it('fermeture pendant la génération : le suivi continue et l’état est retrouvé', () => {
    let s = loaded({ type: 'GENERATE_START', format: 'PDF', now: 0 }, { type: 'REQUEST_CLOSE' });
    s = prepReducer(s, { type: 'GENERATION_UPDATE', dto: { generationStatus: 'ready', outputFormat: 'PDF' } });
    expect(s).toMatchObject({ status: 'cancel_confirm', returnTo: 'generated_pdf' });
    expect(prepReducer(s, { type: 'CANCEL_CLOSE' }).status).toBe('generated_pdf');
  });

  it('étapes de progression : ZIP seulement si demandé', () => {
    const g = loaded({ type: 'GENERATE_START', format: 'PDF', now: 0 }).generation!;
    expect(progressSteps({ ...g, generationStatus: 'generating', currentStep: 'render_pdf' }).map((x) => [x.id, x.state])).toEqual([
      ['prepare', 'done'], ['render', 'current'], ['store', 'todo'], ['finalize', 'todo'],
    ]);
    expect(progressSteps({ ...g, requestedFormat: 'ZIP', generationStatus: 'ready' }).every((x) => x.state === 'done')).toBe(true);
  });

  it('plan du dossier : sections retenues numérotées, index des annexes', () => {
    const outline = dossierOutline(loaded());
    expect(outline).toEqual([
      { no: null, label: 'Couverture' },
      { no: '01', label: 'Synthèse du dossier' },
      { no: '02', label: 'Documents clés' },
      { no: '03', label: 'Photos du bien' },
      { no: 'Annexes', label: 'Index des annexes intégrées' },
      { no: null, label: 'Méthode, sources et limites' },
    ]);
  });
});
