/**
 * Lot 115D (Trello #782) — ÉDITION UNIFIÉE DES PÉRIODES D'UN DOCUMENT : plus d'action « Corriger »
 * permanente sur une période. Unitaires SANS base (règles pures + garde statique des écrans).
 *
 *   L115D-782-U-01  textes : « Corriger » n'est plus une action de période ; « Modifier » l'est
 *   L115D-782-U-02  tiroir du document : toutes les lignes de période sont en LECTURE (`action="none"`)
 *   L115D-782-U-03  parcours « Modifier » du document : périodes (principale, segments, autres natures)
 *                   éditées dans le formulaire, un SEUL point d'écriture (route du même fait)
 *   L115D-782-U-04  écrans sans parcours « Modifier » général : action conservée, nommée « Modifier »
 *   L115D-782-U-05  règles pures : dates partielles, durée indéterminée, chronologie, « modifié ou non »
 *   L115D-782-U-06  charte : jetons de couleur seulement ; jamais « Opération » affiché
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PERIOD_EDIT_ACTION, PERIOD_EDIT_SAVE_FAILED, PERIOD_EDIT_SECTION_TITLE, PERIOD_OPEN_ENDED_LABEL,
  PERIOD_USER_MENTION, periodEditBounds, periodEditChanged,
} from '@/lib/documents/business-periods';

const ROOT = process.cwd();
const lire = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const COMPOSANT = 'src/components/documents/BusinessPeriods.tsx';
const TIROIR = 'src/components/assets/DocumentDrawer.tsx';
const DEPENSE = 'src/components/assets/tco-expense-period.tsx';
const FICHE = 'src/components/reference-events/ReferenceEventPageContent.tsx';
const TEXTES = 'src/lib/documents/business-periods.ts';

describe('L115D-782-U-01 — textes : plus aucune action « Corriger » sur une période', () => {
  it('l’action de la ligne est « Modifier » ; « Corriger » n’est plus un libellé d’action', () => {
    // Règle remplacée (carte #782) : `PERIOD_CORRECT_ACTION = 'Corriger'` du lot 113W / carte #766 —
    // une période est une donnée structurée normale, pas une anomalie.
    expect(PERIOD_EDIT_ACTION).toBe('Modifier');
    const textes = lire(TEXTES);
    expect(textes).not.toMatch(/PERIOD_CORRECT_ACTION/);
    // Le constat « Corrigée par vous » reste : c'est un FAIT sur la période, pas un bouton.
    expect(PERIOD_USER_MENTION).toBe('Corrigée par vous');
  });
  it('aucun libellé d’action « Corriger » dans les écrans des périodes (chaînes de caractères)', () => {
    for (const f of [COMPOSANT, DEPENSE, FICHE]) {
      const chaines = [...lire(f).matchAll(/(['"`])((?:(?!\1).)*)\1/g)].map((x) => x[2]);
      expect(chaines.filter((s) => /^Corriger\b/.test(s)), f).toEqual([]);
    }
  });
  it('textes nouveaux de la carte (à valider par le PO)', () => {
    expect(PERIOD_EDIT_SECTION_TITLE).toBe('Dates et périodes du document');
    expect(PERIOD_EDIT_SAVE_FAILED).toBe('Les autres modifications sont enregistrées ; une période n’a pas pu l’être.');
  });
});

describe('L115D-782-U-02 — tiroir du document : les lignes de période sont en lecture', () => {
  const composant = lire(COMPOSANT);
  /** Corps d'une fonction exportée du composant (jusqu'à l'export suivant). */
  const corps = (nom: string): string => {
    const i = composant.indexOf(`export function ${nom}(`);
    expect(i, nom).toBeGreaterThan(0);
    const j = composant.indexOf('\nexport ', i + 1);
    return composant.slice(i, j === -1 ? undefined : j);
  };
  it('période principale, détail (segments et autres natures) et historiques : aucune action', () => {
    for (const nom of ['DocumentBusinessPeriodField', 'DocumentPeriodsDetail']) {
      const bloc = corps(nom);
      // Chaque ligne rendue par le tiroir est explicitement sans action.
      const lignes = bloc.match(/<PeriodRow\b[^>]*>/g) ?? [];
      expect(lignes.length, nom).toBeGreaterThan(0);
      for (const l of lignes) expect(l, `${nom} : ${l}`).toContain('action="none"');
      for (const l of bloc.match(/<CoverageHistoryList\b[^>]*/g) ?? []) expect(l, nom).toContain('action="none"');
    }
  });
  it('les couvertures d’un AUTRE justificatif restent ouvrables par leur document (accès conservé)', () => {
    expect(corps('CoverageHistoryList')).toContain('aria-label={`Ouvrir le document : ${c.documentTitle}`}');
    expect(corps('DocumentBusinessPeriodField')).toContain('onOpenDocument={onOpenDocument}');
    expect(lire(TIROIR)).toContain("openDrawer({ kind: 'document', id }, { stack: true })");
  });
});

describe('L115D-782-U-03 — parcours « Modifier » du document : les périodes y sont éditées', () => {
  const composant = lire(COMPOSANT);
  const tiroir = lire(TIROIR);
  it('le formulaire d’édition porte les champs des périodes, la lecture des périodes reste unique', () => {
    const edition = tiroir.indexOf("<p className=\"vb-app-subsection\">Modifier le document</p>");
    const champs = tiroir.indexOf('<DocumentPeriodsEditFields');
    expect(edition).toBeGreaterThan(0);
    expect(champs).toBeGreaterThan(edition);
    expect(tiroir.match(/useDocumentPeriods\(/g)).toHaveLength(1);
    expect(tiroir.match(/useDocumentPeriodsEdit\(/g)).toHaveLength(1);
    // Entrée en édition, annulation et enregistrement passent par l'état d'édition des périodes.
    expect(tiroir).toContain('editionPeriodes.reinitialiser();');
    expect(tiroir).toContain('if (!editionPeriodes.valider()) return;');
    expect(tiroir).toContain('await editionPeriodes.enregistrer(doc.id)');
  });
  it('toutes les périodes du document sont accessibles : principale (tous segments) et autres natures', () => {
    expect(composant).toContain("return [...(view.principal?.segments ?? []), ...view.secondary];");
    // Les champs sont rendus pour CHAQUE période, avec dates partielles et durée indéterminée.
    const champs = composant.slice(composant.indexOf('export function DocumentPeriodsEditFields'));
    expect(champs).toContain('editor.drafts.map');
    expect(champs).toContain('placeholder="JJ/MM/AAAA"');
    expect(champs).toContain('PERIOD_OPEN_ENDED_LABEL');
    expect(PERIOD_OPEN_ENDED_LABEL).toBe('Durée indéterminée (pas de date de fin)');
  });
  it('un SEUL point d’écriture : la route du même fait, et rien d’autre (ni notes, ni description)', () => {
    expect([...composant.matchAll(/apiClient\.(put|post|patch|delete)\(`([^`]+)`/g)].map((x) => x[2]))
      .toEqual(['/api/documents/${fileId}/periodes']);
    expect(composant.match(/async function enregistrerPeriode\(/g)).toHaveLength(1);
    // La façade d'écriture du document (`PUT /api/documents/:id`) n'apprend rien des périodes :
    // le corps envoyé par le tiroir ne porte aucune période (notes et description intactes).
    const corpsPut = tiroir.slice(tiroir.indexOf('const response = await fetch(`/api/documents/${doc.id}`'), tiroir.indexOf('if (!response.ok)'));
    expect(corpsPut).not.toMatch(/period|Period/);
    // Les périodes sont écrites APRÈS le document, jamais dans le même corps.
    expect(tiroir.indexOf('await editionPeriodes.enregistrer(doc.id)')).toBeGreaterThan(tiroir.indexOf('const response = await fetch(`/api/documents/${doc.id}`'));
  });
  it('les écrans ouverts se relisent après l’enregistrement (même fait, synchronisation inter-tiroirs)', () => {
    const hook = composant.slice(composant.indexOf('export function useDocumentPeriodsEdit'), composant.indexOf('export function DocumentPeriodsEditFields'));
    expect((hook.match(/BUSINESS_PERIODS_MUTATED/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(hook).toContain('reload();');
    // Refus de droits : la fenêtre de la garde d'écriture, aucun message par-dessus.
    expect(hook).toContain('if (e?.status !== 403)');
  });
});

describe('L115D-782-U-04 — écrans sans parcours « Modifier » général : action conservée', () => {
  it('détail d’une dépense, fiche de l’événement de référence, tiroir d’agenda : action « Modifier »', () => {
    expect(lire(DEPENSE)).toMatch(/<PeriodRow[^>]*action="edit"/);
    expect(lire(FICHE)).toMatch(/<CoverageHistoryList[^>]*action="edit"/);
    const agenda = lire(COMPOSANT).slice(lire(COMPOSANT).indexOf('export function AgendaCoverageHistory'));
    expect(agenda).toMatch(/<CoverageHistoryList[^>]*action="edit"/);
    // L'action porte le libellé « Modifier » et reste protégée par la garde d'écriture.
    const ligne = lire(COMPOSANT).slice(lire(COMPOSANT).indexOf('export function PeriodRow'), lire(COMPOSANT).indexOf('// ── Historique de couverture'));
    expect(ligne).toContain("action === 'edit' && !edition");
    expect(ligne).toContain('garder(() => setEdition(true))');
    expect(ligne).toContain('{PERIOD_EDIT_ACTION}');
  });
});

describe('L115D-782-U-05 — règles pures de la saisie d’une période', () => {
  it('dates partielles acceptées telles quelles ; aucune borne inventée', () => {
    expect(periodEditBounds({ start: '14/11/2026', end: '14/11/2028', openEnded: false }))
      .toEqual({ start: '2026-11-14', end: '2028-11-14', openEnded: false });
    expect(periodEditBounds({ start: '03/2026', end: '2027', openEnded: false }))
      .toEqual({ start: '2026-03', end: '2027', openEnded: false });
    expect(periodEditBounds({ start: '', end: '', openEnded: false })).toEqual({ start: null, end: null, openEnded: false });
  });
  it('saisie illisible ou fin avant début : refusée (rien n’est écrit)', () => {
    expect(periodEditBounds({ start: 'hier', end: '', openEnded: false })).toBeNull();
    expect(periodEditBounds({ start: '31/02/2026', end: '', openEnded: false })).toBeNull();
    expect(periodEditBounds({ start: '14/11/2028', end: '14/11/2026', openEnded: false })).toBeNull();
    // Bornes partielles : le chevauchement possible suffit (mars 2026 → 2026 reste ordonné).
    expect(periodEditBounds({ start: '03/2026', end: '2026', openEnded: false })).not.toBeNull();
  });
  it('durée indéterminée : explicite, et exclue dès qu’une fin est saisie', () => {
    expect(periodEditBounds({ start: '01/01/2026', end: '', openEnded: true }))
      .toEqual({ start: '2026-01-01', end: null, openEnded: true });
    expect(periodEditBounds({ start: '01/01/2026', end: '31/12/2026', openEnded: true }))
      .toEqual({ start: '2026-01-01', end: '2026-12-31', openEnded: false });
  });
  it('« modifié ou non » : une période qu’on n’a pas touchée n’est pas réécrite', () => {
    const etabli = { start: '2026-11-14', end: '2028-11-14' };
    expect(periodEditChanged(etabli, periodEditBounds({ start: '14/11/2026', end: '14/11/2028', openEnded: false })!)).toBe(false);
    // Même fait saisi autrement (zéros omis) : toujours inchangé — aucune écriture, aucun verrou utilisateur.
    expect(periodEditChanged(etabli, periodEditBounds({ start: '14/11/2026', end: '14/11/2028', openEnded: false })!)).toBe(false);
    expect(periodEditChanged({ start: '2026-01-01', end: null }, periodEditBounds({ start: '1/1/2026', end: '', openEnded: false })!)).toBe(false);
    // Fin INCONNUE ≠ durée indéterminée ÉTABLIE : jamais confondues.
    expect(periodEditChanged({ start: '2026-01-01', end: null }, periodEditBounds({ start: '01/01/2026', end: '', openEnded: true })!)).toBe(true);
    expect(periodEditChanged({ start: '2026-01-01', end: null, openEnded: true }, periodEditBounds({ start: '01/01/2026', end: '', openEnded: false })!)).toBe(true);
    // Une borne effacée est bien un changement (valeur absente assumée).
    expect(periodEditChanged(etabli, periodEditBounds({ start: '14/11/2026', end: '', openEnded: false })!)).toBe(true);
  });
});

describe('L115D-782-U-06 — charte Sérénité et vocabulaire', () => {
  it('jetons de couleur seulement, cibles tactiles, et jamais « Opération » affiché', () => {
    for (const f of [COMPOSANT, DEPENSE]) {
      // Code seulement : commentaires JSX (multilignes compris), puis lignes de commentaire et imports.
      const visibles = lire(f)
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
        .split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*|import )/.test(l)).join('\n');
      expect(visibles, f).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|\b(?:text|bg|border)-(?:red|green|blue|gray|slate|amber|yellow|orange|emerald|zinc|neutral)-\d{2,3}\b/);
    }
    const chaines = [...lire(COMPOSANT).matchAll(/(['"`])((?:(?!\1).)*)\1/g)].map((x) => x[2]).join(' ');
    expect(chaines).not.toMatch(/\bOpération\b|expiré/);
    // Desktop ET mobile : une seule grille responsive, cible tactile de la case à cocher.
    const champs = lire(COMPOSANT).slice(lire(COMPOSANT).indexOf('export function DocumentPeriodsEditFields'));
    expect(champs).toContain('grid-cols-1 sm:grid-cols-2');
    expect(champs).toContain('min-h-[32px]');
  });
});
