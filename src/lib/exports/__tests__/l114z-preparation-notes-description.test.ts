/**
 * Lot 114Z (Trello #767, écart E03) — écran de préparation d'un dossier destiné à un tiers :
 * « Inclure Notes / Description des documents », décochée par défaut à CHAQUE création.
 *
 *   L114Z-U-PREP-01  décochée à l'ouverture ; le corps envoyé ne porte pas l'option ;
 *   L114Z-U-PREP-02  cochée explicitement → `includeNotesDescription: true` dans les choix (génération) ;
 *   L114Z-U-PREP-03  nouvelle création (retour aux choix, régénération, réouverture) → de nouveau décochée ;
 *   L114Z-U-PREP-04  proposée seulement quand le dossier propose des documents ; inerte hors édition ;
 *   L114Z-U-PREP-05  écran : case et ligne de résumé branchées, libellé de la carte repris à l'identique.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildChoices, buildEstimateBody, buildGenerateBody, initialPrepState, needsCloseConfirmation, offersNotesDescriptionOption,
  prepReducer, type PrepAction, type PrepState,
} from '../preparation-state';
import type { EstimateDto, PrepItem, PrepSection, PreparationDto } from '@/services/exports/v12/preparation/types';
import {
  THIRD_PARTY_DOSSIER_NOTES_OPTION_LABEL, THIRD_PARTY_NOTES_DESCRIPTION_DEFAULT, thirdPartyDossierNotesSummaryValue,
} from '@/services/documents/notes-description/third-party';

const estimate: EstimateDto = {
  outputFormat: 'PDF', estimatedPages: 8, estimatedBytes: 900_000, pdfItems: 1, zipItems: 0, pdfDocuments: 1, zipDocuments: 0,
  pdfPhotos: 0, zipPhotos: 0, events: 0, blocking: [], warnings: [], zipOnlyItems: [], unavailable: [], longGeneration: false,
};
const item = (id: number): PrepItem => ({
  key: `document:${id}`, sourceType: 'document', sourceId: id, type: 'document', label: `Document ${id}`, typeLabel: null, source: 'Documents du bien',
  date: null, format: 'PDF', sizeBytes: 1000, compatibility: 'integrable', sensitive: false, allowedModes: ['PDF', 'ZIP'], selectable: true,
  recommended: true, recommendedMode: 'PDF', selected: true, mode: 'PDF', fileId: id, detail: null, error: null,
});
const section = (id: string, items: PrepItem[], over: Partial<PrepSection> = {}): PrepSection => ({
  id, label: id, description: '', required: false, toggleable: true, enabled: true, defaultEnabled: true, recommended: true,
  itemType: items[0]?.type ?? null, items, infoSections: [], cil: false, fedBy: null, fedFilled: null, rows: [], hasSensitive: false, ...over,
});
const prep = (avecDocuments = true): PreparationDto => ({
  assetId: 1, exportType: 'VENTE', status: 'ready_pristine',
  dossier: { code: 'VENTE', label: 'Kit de vente', shortLabel: 'Vente', description: '', templateVersion: 'x' },
  asset: { id: 1, name: 'Vélo', family: 'VEHICULE', familyLabel: 'Véhicule', categoryLabel: 'Vélo' },
  eligibility: { status: 'ready', message: null }, lastGeneration: null,
  sections: [
    section('cover', [], { required: true, toggleable: false, itemType: null }),
    section('documents', avecDocuments ? [item(1), item(2)] : [], avecDocuments ? {} : { itemType: 'document' }),
  ],
  photoCap: 4, additionalInfo: { sections: [], updatedAt: null }, cil: null, estimate,
  actions: { canGeneratePdf: true, canGenerateZip: false }, messages: [],
  thresholds: { docsWarning: 20, docsBlocking: 50, bytesWarning: 1, bytesBlocking: 2, pagesBlocking: 300, photosBlocking: 100 }, empty: false,
} as PreparationDto);

const run = (s: PrepState, ...actions: PrepAction[]): PrepState => actions.reduce(prepReducer, s);
const ouvert = (...actions: PrepAction[]) => run(initialPrepState, { type: 'LOAD_START' }, { type: 'LOAD_SUCCESS', prep: prep() }, ...actions);
const cocher: PrepAction = { type: 'SET_INCLUDE_NOTES_DESCRIPTION', include: true };
const lire = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');

describe('L114Z-U-PREP — « Inclure Notes / Description des documents »', () => {
  it('01 — décochée par défaut ; ni la génération ni l’estimation n’envoient l’option', () => {
    expect(THIRD_PARTY_NOTES_DESCRIPTION_DEFAULT).toBe(false);
    expect(initialPrepState.includeNotesDescription).toBe(false);
    const s = ouvert();
    expect(s.includeNotesDescription).toBe(false);
    expect(buildChoices(s, 'PDF')).not.toHaveProperty('includeNotesDescription');
    expect(buildGenerateBody(s, 'PDF').choices).not.toHaveProperty('includeNotesDescription');
    expect(buildEstimateBody(s).choices).not.toHaveProperty('includeNotesDescription');
  });
  it('02 — cochée explicitement → booléen `true` dans les choix ; la préparation est « modifiée » ; décochée → retirée', () => {
    const s = ouvert(cocher);
    expect(s.includeNotesDescription).toBe(true);
    expect(buildGenerateBody(s, 'ZIP').choices).toMatchObject({ includeNotesDescription: true });
    expect(needsCloseConfirmation(s)).toBe(true);
    // L'estimation (pages, taille) n'en dépend pas : aucun recalcul déclenché.
    expect(s.revision).toBe(ouvert().revision);
    const d = run(s, { type: 'SET_INCLUDE_NOTES_DESCRIPTION', include: false });
    expect(buildChoices(d, 'PDF')).not.toHaveProperty('includeNotesDescription');
  });
  it('03 — nouvelle création : réouverture, retour aux choix après génération, régénération → de nouveau décochée', () => {
    const coche = ouvert(cocher);
    expect(run(coche, { type: 'LOAD_START' }, { type: 'LOAD_SUCCESS', prep: prep() }).includeNotesDescription).toBe(false);
    const genere = run(coche, { type: 'GENERATE_START', format: 'PDF', now: 1 }, { type: 'GENERATE_ACCEPTED', publicId: 'g1', generationStatus: 'queued' });
    expect(run(genere, { type: 'EDIT_AND_REGENERATE' }).includeNotesDescription).toBe(false);
    const pret = run(genere, { type: 'GENERATION_UPDATE', dto: { generationStatus: 'ready', outputFormat: 'PDF' } });
    expect(run(pret, { type: 'BACK_TO_EDIT' }).includeNotesDescription).toBe(false);
    // Rechargement en cours de préparation (information enregistrée) : le choix de la session est conservé.
    expect(run(coche, { type: 'RELOAD_SUCCESS', prep: prep() }).includeNotesDescription).toBe(true);
    // Refus synchrone du serveur (même tentative) : conservé aussi.
    expect(run(coche, { type: 'GENERATE_START', format: 'PDF', now: 1 }, { type: 'GENERATE_REJECTED', code: 'NOTES_DESCRIPTION_UNAVAILABLE', message: 'x' }).includeNotesDescription).toBe(true);
  });
  it('04 — proposée seulement si le dossier propose des documents ; inerte hors édition', () => {
    expect(offersNotesDescriptionOption(ouvert())).toBe(true);
    expect(offersNotesDescriptionOption(run(initialPrepState, { type: 'LOAD_START' }, { type: 'LOAD_SUCCESS', prep: prep(false) }))).toBe(false);
    expect(offersNotesDescriptionOption(initialPrepState)).toBe(false);
    const enCours = ouvert({ type: 'GENERATE_START', format: 'PDF', now: 1 });
    expect(run(enCours, cocher).includeNotesDescription).toBe(false);
    expect(run(initialPrepState, cocher).includeNotesDescription).toBe(false);
  });
  it('05 — écran : case (desktop et mobile, même colonne), résumé vérifiable, libellé de la carte à l’identique', () => {
    expect(THIRD_PARTY_DOSSIER_NOTES_OPTION_LABEL).toBe('Inclure Notes / Description des documents');
    expect(thirdPartyDossierNotesSummaryValue(false)).toBe('Non incluses');
    expect(thirdPartyDossierNotesSummaryValue(true)).toBe('Incluses');
    const ecran = lire('src/components/exports/preparation/ExportPreparationScreen.tsx');
    expect(ecran).toMatch(/checked=\{state\.includeNotesDescription\}/);
    expect(ecran).toMatch(/dispatch\(\{ type: 'SET_INCLUDE_NOTES_DESCRIPTION', include: v === true \}\)/);
    expect(ecran).toContain('{THIRD_PARTY_DOSSIER_NOTES_OPTION_LABEL}');
    // La case est dans la colonne des sections (visible sur téléphone), pas dans le résumé masqué en mobile.
    expect(ecran.indexOf('prep-include-notes-description')).toBeLessThan(ecran.indexOf('Colonne droite : résumé collant'));
    const resume = lire('src/components/exports/preparation/PreparationSummary.tsx');
    expect(resume).toContain('thirdPartyDossierNotesSummaryValue(state.includeNotesDescription)');
    // Charte Sérénité : aucune couleur brute dans le bloc ajouté.
    const bloc = ecran.slice(ecran.indexOf('data-testid="prep-include-notes-description"') - 200, ecran.indexOf('VENTE-RULE-002'));
    expect(bloc).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(/);
  });
});
