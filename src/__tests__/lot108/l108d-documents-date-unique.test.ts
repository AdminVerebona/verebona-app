/**
 * Lot 108D — listes de documents : une seule date, la date du document,
 * sinon « – » (ticket P1). Tests unitaires L108D-U-*.
 */
import * as React from 'react';
import { createElement as h } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DOCUMENT_DATE_PLACEHOLDER, documentRowDate } from '@/lib/documents/document-row-date';
import { DocumentDateCell } from '@/components/documents/DocumentDateCell';
import { legacyDefaultDays, resolveUploadDocumentDate, strictIsoDay } from '@/services/documents/upload-document-date';
import { diagnoseDocumentDateFallback, type DocumentDateState } from '@/services/coherence/registry/checks/document-date-fallback';
import { COHERENCE_REGISTRY } from '@/services/coherence/registry';
import { COVERAGE_INVENTORY } from '@/services/coherence/registry/coverage';
import { sortDocuments, documentSubtitle, displayedDate, type DocumentItem } from '@/components/documents/v2/documents-view';

(globalThis as { React?: typeof React }).React = React;

const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const sansCommentaires = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

describe('L108D-U-ROW — contrat de la date d’une ligne de document', () => {
  it('date complète : format court français, nom accessible explicite, <time datetime>', () => {
    expect(documentRowDate('2025-12-20')).toEqual({
      label: '20 déc. 2025', ariaLabel: 'Date du document : 20 décembre 2025', dateTime: '2025-12-20', precision: 'day',
    });
    expect(documentRowDate('2019-10-01').ariaLabel).toBe('Date du document : 1er octobre 2019');
  });
  it('date absente, invalide, ou horodatage (date d’ajout reçue par erreur) : « – », jamais « Date inconnue »', () => {
    for (const v of [null, undefined, '', '2025-02-30', '2026-09-24T08:15:00Z', 'Date inconnue', '24/09/2026']) {
      const d = documentRowDate(v as string | null);
      expect(d.label).toBe('–');
      expect(d.dateTime).toBeNull();
      expect(d.ariaLabel).toBe('Date du document non renseignée');
    }
    expect(DOCUMENT_DATE_PLACEHOLDER).toBe('–');
  });
  it('date partielle : aucun jour inventé', () => {
    expect(documentRowDate('2019-10')).toMatchObject({ label: 'oct. 2019', precision: 'month', dateTime: '2019-10' });
    expect(documentRowDate('2019')).toMatchObject({ label: '2019', precision: 'year' });
    expect(documentRowDate('2019-13').label).toBe('–');
  });
  it('cellule : une seule date visible, nom accessible, « – » masqué aux lecteurs d’écran au profit d’un libellé', () => {
    const avec = renderToStaticMarkup(h(DocumentDateCell, { value: '2025-12-20' }));
    expect(avec).toContain('<time dateTime="2025-12-20" aria-hidden="true">20 déc. 2025</time>');
    expect(avec).toContain('Date du document : 20 décembre 2025');
    expect(avec).toContain('tabular-nums');
    const sans = renderToStaticMarkup(h(DocumentDateCell, { value: null }));
    expect(sans).toContain('<span aria-hidden="true">–</span>');
    expect(sans).toContain('Date du document non renseignée');
    expect(sans).not.toMatch(/Date inconnue/);
  });
});

describe('L108D-U-VIEW — Mes documents / onglet Documents : sous-titre = Type, date = date du document', () => {
  const doc = (o: Partial<DocumentItem>): DocumentItem => ({
    id: 1, publicId: 'p1', title: 'Facture', originalFilename: null, assetId: 1, rubricCode: 'MAINTENANCE_WORKS',
    documentTypeCode: 'INVOICE', documentTypeLabel: 'Facture d’entretien', documentDate: null, uploadedAt: '2026-09-24T09:00:00Z',
    mimeType: 'application/pdf', assetNames: ['Voiture'], ...o,
  });
  // Recette : facture de décembre 2025 importée en septembre 2026.
  const facture = doc({ id: 1, documentDate: '2025-12-20' });
  // Justificatifs 2019 / 2020 / 2021 importés le même jour 2026.
  const j19 = doc({ id: 2, documentDate: '2019-10-22', documentTypeLabel: 'Rapport d’entretien' });
  const j20 = doc({ id: 3, documentDate: '2020-06-03' });
  const j21 = doc({ id: 4, documentDate: '2021-01-15', documentTypeLabel: 'Certificat d’immatriculation' });
  const sansDate = doc({ id: 5, documentDate: null });

  it('facture 12/2025 importée en 09/2026 : sous-titre « Facture d’entretien », date « 20 déc. 2025 », une seule date', () => {
    expect(documentSubtitle(facture, 'mes-documents')).toBe('Facture d’entretien');
    expect(displayedDate(facture)).toBe('20 déc. 2025');
  });
  it('justificatifs importés le même jour : dates documentaires distinctes, jamais la date d’import', () => {
    const dates = [j19, j20, j21].map(displayedDate);
    expect(dates).toEqual(['22 oct. 2019', '3 juin 2020', '15 janv. 2021']);
    expect(dates.join(' ')).not.toMatch(/sept\. 2026/);
  });
  it('document sans date : « – », la date d’ajout n’apparaît nulle part dans la ligne', () => {
    expect(displayedDate(sansDate)).toBe('–');
    expect(documentSubtitle(sansDate, 'mes-documents')).not.toMatch(/2026|sept/);
  });
  it('tri « Date du document » : documents sans date EN FIN dans les deux sens, sans emprunter la date d’ajout', () => {
    const tous = [sansDate, j20, facture, j19, j21];
    expect(sortDocuments(tous, 'docDate', 'desc').map((d) => d.id)).toEqual([1, 4, 3, 2, 5]);
    expect(sortDocuments(tous, 'docDate', 'asc').map((d) => d.id)).toEqual([2, 3, 4, 1, 5]);
  });
  it('tri « Date d’ajout » : reste disponible comme critère distinct', () => {
    const a = doc({ id: 10, uploadedAt: '2026-01-01T00:00:00Z', documentDate: '2030-01-01' });
    const b = doc({ id: 11, uploadedAt: '2026-02-01T00:00:00Z', documentDate: '2001-01-01' });
    expect(sortDocuments([a, b], 'added', 'desc').map((d) => d.id)).toEqual([11, 10]);
  });
});

describe('L108D-U-UPLOAD — entrée d’un document : jamais le jour d’import comme date du document', () => {
  const now = new Date('2026-09-24T10:00:00Z');
  it('aucune date reçue : rien n’est posé', () => {
    expect(resolveUploadDocumentDate({ documentDate: null }, now)).toEqual({ documentDate: null, markUserEdited: false, reason: 'NONE' });
    expect(resolveUploadDocumentDate({ documentDate: '' }, now).documentDate).toBeNull();
  });
  it('date saisie par l’utilisateur (marque USER) : posée et protégée, même si c’est le jour même', () => {
    expect(resolveUploadDocumentDate({ documentDate: '2026-09-24', documentDateSource: 'USER' }, now))
      .toEqual({ documentDate: '2026-09-24', markUserEdited: true, reason: 'USER' });
    expect(resolveUploadDocumentDate({ documentDate: '2025-12-20', documentDateSource: 'USER' }, now).markUserEdited).toBe(true);
  });
  it('ancien client : le jour courant pré-rempli (UTC ou Paris) est ignoré ; une autre date est conservée sans marque', () => {
    expect(resolveUploadDocumentDate({ documentDate: '2026-09-24' }, now)).toMatchObject({ documentDate: null, reason: 'LEGACY_DEFAULT_IGNORED' });
    // 23 h 30 UTC = 01 h 30 le lendemain à Paris : les deux jours sont des valeurs pré-remplies possibles.
    const minuit = new Date('2026-09-24T23:30:00Z');
    expect(legacyDefaultDays(minuit)).toEqual(['2026-09-24', '2026-09-25']);
    expect(resolveUploadDocumentDate({ documentDate: '2026-09-25' }, minuit).documentDate).toBeNull();
    expect(resolveUploadDocumentDate({ documentDate: '2021-01-15' }, now)).toEqual({ documentDate: '2021-01-15', markUserEdited: false, reason: 'LEGACY_KEPT' });
  });
  it('valeur invalide ou partielle : jamais posée (aucun jour inventé)', () => {
    for (const v of ['2019', '2019-10', '2019-02-30', '20/12/2025', 12]) expect(resolveUploadDocumentDate({ documentDate: v, documentDateSource: 'USER' }, now).documentDate).toBeNull();
    expect(strictIsoDay('2024-02-29')).toBe('2024-02-29');
  });
});

describe('L108D-U-COH — COH-DOC-DATE-FALLBACK (diagnostic pur)', () => {
  const base: DocumentDateState = {
    fileId: 1, documentDate: '2026-09-24', importDays: ['2026-09-24'], userEdited: false, analysisInProgress: false,
    hasExtraction: true, extractedDate: null, extractedConfidence: null,
  };
  it('date différente du jour d’import, absente, ou validée par l’utilisateur : conforme, aucune écriture', () => {
    expect(diagnoseDocumentDateFallback({ ...base, documentDate: '2021-01-15' }).verdict).toBe('CONSISTENT');
    expect(diagnoseDocumentDateFallback({ ...base, documentDate: null }).verdict).toBe('CONSISTENT');
    expect(diagnoseDocumentDateFallback({ ...base, userEdited: true }).verdict).toBe('CONSISTENT');
  });
  it('document réellement daté du jour d’import (T1 l’a lu) : conforme — un même jour d’import n’est pas présumé erroné', () => {
    expect(diagnoseDocumentDateFallback({ ...base, extractedDate: '2026-09-24', extractedConfidence: 'certain' }).verdict).toBe('CONSISTENT');
  });
  it('T1 a lu une autre date fiable : réparation déterministe vers cette date', () => {
    expect(diagnoseDocumentDateFallback({ ...base, extractedDate: '2025-12-20', extractedConfidence: 'probable' }))
      .toMatchObject({ verdict: 'REPAIRABLE', repair: 'RESTORE_EXTRACTED_DATE', expected: '2025-12-20' });
  });
  it('aucune date fiable (non lue, contestée sur une autre valeur, jamais analysé) : valeur retirée → « – »', () => {
    expect(diagnoseDocumentDateFallback(base)).toMatchObject({ verdict: 'REPAIRABLE', repair: 'CLEAR_IMPORT_DAY', expected: null, reason: 'T1_READ_NO_DATE' });
    expect(diagnoseDocumentDateFallback({ ...base, extractedDate: '2025-12-20', extractedConfidence: 'conflictual' }))
      .toMatchObject({ repair: 'CLEAR_IMPORT_DAY', reason: 'T1_DATE_CONTESTED_NO_RELIABLE_DATE' });
    expect(diagnoseDocumentDateFallback({ ...base, hasExtraction: false }))
      .toMatchObject({ repair: 'CLEAR_IMPORT_DAY', reason: 'NEVER_ANALYZED_NO_EVIDENCE' });
  });
  it('jour d’import lu comme date contestée : ambigu (aucune écriture) ; analyse en cours : constat', () => {
    expect(diagnoseDocumentDateFallback({ ...base, extractedDate: '2026-09-24', extractedConfidence: 'conflictual' }).verdict).toBe('AMBIGUOUS');
    expect(diagnoseDocumentDateFallback({ ...base, analysisInProgress: true }).verdict).toBe('FINDING');
  });
  it('registre : en fin de liste, réparation par le service dédié seulement, couverture déclarée, interdits explicites', () => {
    const ids = COHERENCE_REGISTRY.map((c) => c.id);
    expect(ids).toContain('COH-DOC-DATE-FALLBACK');
    expect(ids.indexOf('COH-DOC-DATE-FALLBACK')).toBeGreaterThan(ids.indexOf('COH-PRICE-MULTI-ARTICLE'));
    const c = COHERENCE_REGISTRY.find((x) => x.id === 'COH-DOC-DATE-FALLBACK')!;
    expect(c.services).toEqual(['documents/document-date-repair.service#repairDocumentDateFallback']);
    expect(c.forbiddenRepairs.join(' ')).toMatch(/saisie ou validée par l’utilisateur/);
    expect(c.forbiddenRepairs.join(' ')).toMatch(/date d’ajout/);
    expect(COVERAGE_INVENTORY.some((e) => e.checks.includes('COH-DOC-DATE-FALLBACK'))).toBe(true);
  });
});

describe('L108D-U-SRC — aucune substitution date d’ajout ↔ date du document dans le code', () => {
  it('fenêtre d’ajout : plus de date du jour pré-remplie, plus de date d’élément d’agenda reprise', () => {
    const s = sansCommentaires(src('src/components/documents/unified-document-dialog.tsx'));
    expect(s).not.toMatch(/setDocumentDate\(new Date\(\)/);
    expect(s).not.toMatch(/useState\(new Date\(\)\.toISOString\(\)/);
    expect(s).not.toMatch(/setDocumentDate\(r\.item\.startDate\)/);
    expect(s).toMatch(/documentDateSource: documentDate \? 'USER' : null/);
  });
  it('confirmation de dépôt et lien web : date passée par la décision unique', () => {
    for (const f of ['src/app/api/files/confirm/route.ts', 'src/app/api/web-links/route.ts']) {
      const s = sansCommentaires(src(f));
      expect(s, f).toMatch(/resolveUploadDocumentDate\(/);
      expect(s, f).not.toMatch(/documentDate: documentDate \|\| null/);
    }
  });
  it('listes : la date de ligne ne lit jamais uploadedAt ; accueil sans repli', () => {
    const v = src('src/components/documents/v2/documents-view.ts');
    const fn = v.slice(v.indexOf('export function displayedDate'), v.indexOf('export function documentSubtitle'));
    expect(fn).not.toMatch(/uploadedAt/);
    expect(sansCommentaires(src('src/services/home/HomeSummaryService.ts'))).not.toMatch(/documentDate \?\? \(d\.uploadedAt/);
    const rubric = src('src/components/documents/v2/DocumentsByRubric.tsx');
    expect(rubric).toMatch(/<DocumentDateCell\s+value=\{document\.documentDate\}/);
    expect(rubric).not.toMatch(/hidden w-\[90px\]/);
  });
  it('toutes les listes de documents réutilisent la même cellule', () => {
    for (const f of [
      'src/components/documents/v2/DocumentsByRubric.tsx', 'src/components/assets/EquipmentDrawer.tsx', 'src/components/assets/RoomAssociations.tsx',
      /* Lot 109B : tiroir fournisseur supprimé */ 'src/app/(dashboard)/fournisseurs/[id]/page.tsx', 'src/components/agenda/AgendaGroupingPanel.tsx',
      'src/components/assets/AssetOverviewTab.tsx',
    ]) expect(src(f), f).toMatch(/DocumentDateCell/);
  });
  it('détail du document : la date d’ajout est visible ; « – » sans date du document', () => {
    const s = src('src/components/assets/DocumentDrawer.tsx');
    expect(s).toMatch(/data-testid="document-detail-added-date"/);
    expect(s).toMatch(/Date d’ajout/);
    expect(s).toMatch(/\?\? DOCUMENT_DATE_PLACEHOLDER/);
  });
});

describe('L108D-U-COUNT — Mes documents : un seul compteur de résultats (ticket « compteur affiché deux fois »)', () => {
  it('libellé du compteur unique (barre au-dessus de la liste) : recherche 0 / 1 / n, avec et sans filtres, sans recherche', async () => {
    const { countLabel } = await import('@/components/documents/v2/documents-view');
    expect(countLabel(13, 13, false, 'mes-documents', true)).toBe('13 documents trouvés');
    expect(countLabel(1, 1, false, 'mes-documents', true)).toBe('1 document trouvé');
    expect(countLabel(0, 0, false, 'mes-documents', true)).toBe('Aucun document trouvé');
    expect(countLabel(4, 13, true, 'mes-documents', true)).toBe('4 documents sur 13 trouvés');
    expect(countLabel(19, 19, false, 'mes-documents')).toBe('19 documents');
  });
  it('cause : le champ de recherche ET la barre affichaient chacun le nombre ; seul celui de la barre subsiste (aria-live)', () => {
    const s = sansCommentaires(src('src/components/documents/v2/DocumentsByRubric.tsx'));
    const champ = s.slice(s.indexOf('<LocalSearchField'), s.indexOf('/>', s.indexOf('<LocalSearchField')));
    expect(champ).not.toMatch(/resultCount=/);
    expect(s).toMatch(/countLabel=\{!meta \? ' ' : countLabel\(total, scopeTotal, filtered, context, !!q\)\}/);
    // Bandeau « Résultats de la recherche Verebona » (retour de la recherche globale) : plus de second nombre.
    expect(s).not.toMatch(/libelleResultats\(/);
    expect(src('src/components/documents/v2/DocumentsToolbar.tsx')).toMatch(/aria-live="polite"/);
  });
  it('les autres écrans à recherche locale (agenda) gardent leur compteur unique sous le champ', () => {
    expect(src('src/app/(dashboard)/agenda/page.tsx')).toMatch(/resultCount=/);
    expect(src('src/components/assets/AssetAgendaTab.tsx')).toMatch(/resultCount=/);
  });
});
