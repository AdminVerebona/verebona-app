/**
 * Lot 81F — tiroirs mobiles : zones sûres, bouton de fermeture, retour.
 * Volet Node (sans navigateur) : logique d'historique du bouton « retour »,
 * correctif posé UNE fois dans le composant de base et hérité par tous les
 * tiroirs, configuration de la page (viewport / barre d'état).
 * Le rendu réel est vérifié dans Chromium : l81f-tiroirs-zones-sures-navigateur.test.ts.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  SHEET_BELOW_KEY,
  SHEET_STACK_KEY,
  __resetSheetHistoryForTests,
  pushSheetEntry,
  releaseSheetEntry,
  sheetEntryPopped,
  sheetHistoryEnabled,
  sheetStack,
  skipDeadSheetEntry,
  type SheetHistoryWindow,
} from '../sheet-history';

const ROOT = join(process.cwd(), 'src');
const lire = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/** Historique de navigateur en mémoire (pile + index), sans événements. */
function fauxNavigateur(etatInitial: unknown = { __NA: true, tree: 'B' }) {
  const entrees: unknown[] = [etatInitial];
  let i = 0;
  let retours = 0;
  const w: SheetHistoryWindow = {
    history: {
      get state() { return entrees[i]; },
      pushState(d) { entrees.splice(i + 1); entrees.push(d); i += 1; },
      replaceState(d) { entrees[i] = d; },
      back() { retours += 1; if (i > 0) i -= 1; },
    },
    location: { href: 'https://app.verebona.fr/assets/12', protocol: 'https:' },
  };
  return { w, entrees, index: () => i, retours: () => retours, retour: () => { if (i > 0) i -= 1; } };
}

describe('L81F — bouton retour et tiroirs (logique d\'historique)', () => {
  beforeEach(() => __resetSheetHistoryForTests());

  it('L81F-20 — ouverture : une entrée (même URL, état Next.js recopié) est posée au-dessus de la page', () => {
    const nav = fauxNavigateur();
    pushSheetEntry(nav.w, 'A');
    expect(nav.entrees).toHaveLength(2);
    expect(nav.entrees[0]).toMatchObject({ __NA: true, tree: 'B', [SHEET_BELOW_KEY]: 'A' });
    expect(nav.entrees[1]).toMatchObject({ __NA: true, tree: 'B', [SHEET_STACK_KEY]: ['A'] });
    expect(nav.entrees[1]).not.toHaveProperty(SHEET_BELOW_KEY);
    expect(sheetEntryPopped(nav.w, 'A')).toBe(false);
  });

  it('L81F-21 — retour : le tiroir est retiré de l\'historique (il se ferme), sans appui enchaîné', () => {
    const nav = fauxNavigateur();
    pushSheetEntry(nav.w, 'A');
    nav.retour();
    expect(sheetEntryPopped(nav.w, 'A')).toBe(true);
    expect(skipDeadSheetEntry(nav.w)).toBe(false);
    expect(nav.retours()).toBe(0);
  });

  it('L81F-22 — tiroirs imbriqués : retour ne ferme que celui du dessus', () => {
    const nav = fauxNavigateur();
    pushSheetEntry(nav.w, 'A');
    pushSheetEntry(nav.w, 'B');
    expect(sheetStack(nav.w.history.state)).toEqual(['A', 'B']);
    nav.retour();
    expect(sheetEntryPopped(nav.w, 'B')).toBe(true);
    expect(sheetEntryPopped(nav.w, 'A')).toBe(false);
  });

  it('L81F-23 — fermeture par le X : jamais de history.back() (navigation simultanée préservée) ; l\'appui retour suivant quitte la page en un seul geste', () => {
    const nav = fauxNavigateur();
    pushSheetEntry(nav.w, 'A');
    releaseSheetEntry(nav.w, 'A');
    expect(nav.retours()).toBe(0);
    expect(sheetStack(nav.w.history.state)).toEqual([]);
    // L'utilisateur appuie sur retour : il arrive sur la même page (entrée du dessous)…
    nav.retour();
    // … et le retour est enchaîné pour qu'un seul appui suffise.
    expect(skipDeadSheetEntry(nav.w)).toBe(true);
    expect(nav.retours()).toBe(1);
    // Une seule fois : un retour ultérieur sur cette entrée n'est plus enchaîné.
    expect(skipDeadSheetEntry(nav.w)).toBe(false);
  });

  it('L81F-24 — navigation lancée depuis le tiroir : l\'entrée de la nouvelle page n\'est pas modifiée', () => {
    const nav = fauxNavigateur();
    pushSheetEntry(nav.w, 'A');
    nav.w.history.pushState({ __NA: true, tree: 'N' }, '', '/documents');
    releaseSheetEntry(nav.w, 'A');
    expect(nav.w.history.state).toEqual({ __NA: true, tree: 'N' });
    expect(nav.retours()).toBe(0);
  });

  it('L81F-25 — activé sur tactile et dans l\'application native, jamais sur desktop (pointeur fin)', () => {
    const base = fauxNavigateur().w;
    expect(sheetHistoryEnabled({ ...base, matchMedia: () => ({ matches: false }) })).toBe(false);
    expect(sheetHistoryEnabled({ ...base, matchMedia: (q) => ({ matches: q === '(pointer: coarse)' }) })).toBe(true);
    expect(sheetHistoryEnabled({ ...base, matchMedia: () => ({ matches: false }), Capacitor: { isNativePlatform: () => true } })).toBe(true);
    expect(sheetHistoryEnabled({ ...base, location: { href: 'capacitor://localhost/', protocol: 'capacitor:' } })).toBe(true);
    expect(sheetHistoryEnabled(base)).toBe(false);
  });
});

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : tsxFiles(full);
    return full.endsWith('.tsx') ? [full] : [];
  });
}

describe('L81F — correctif à la source, hérité par tous les tiroirs', () => {
  const sheet = lire('components/ui/sheet.tsx');

  it('L81F-30 — un seul composant de base : aucun tiroir ne monte Radix Dialog / vaul en direct', () => {
    const directs = tsxFiles(ROOT)
      .filter((f) => /@radix-ui\/react-(alert-)?dialog|from ["']vaul["']/.test(readFileSync(f, 'utf8')))
      .map((f) => f.replace(ROOT, 'src'))
      .sort();
    expect(directs).toEqual(['src/components/ui/alert-dialog.tsx', 'src/components/ui/dialog.tsx', 'src/components/ui/sheet.tsx']);
  });

  it('L81F-31 — tous les tiroirs de l\'application (document, bien, équipement, agenda, fournisseur, TCO, BO…) passent par SheetContent du composant de base', () => {
    const consommateurs = tsxFiles(ROOT)
      .filter((f) => !f.endsWith('components/ui/sheet.tsx'))
      .filter((f) => /<SheetContent\b/.test(readFileSync(f, 'utf8')))
      .map((f) => f.replace(ROOT, 'src'));
    for (const attendu of [
      'src/components/assets/DocumentDrawer.tsx',
      'src/components/assets/EquipmentDrawer.tsx',
      'src/components/assets/RoomDrawer.tsx',
      'src/components/assets/TcoSection.tsx',
      'src/components/agenda/AgendaItemDrawer.tsx',
      'src/components/agenda/CreateAgendaItemDrawer.tsx',
      'src/components/suppliers/SupplierDrawer.tsx',
      'src/components/documents/unified-document-dialog.tsx',
      'src/components/AssetFormDialog.tsx',
      'src/app/admin/accounts/[id]/_components/account-data/EntityDrawer.tsx',
    ]) expect(consommateurs).toContain(attendu);
    for (const f of consommateurs) {
      expect(readFileSync(join(ROOT, '..', f), 'utf8')).toMatch(/from ['"]@\/components\/ui\/sheet['"]/);
    }
  });

  it('L81F-32 — composant de base : encarts haut / bas / côtés posés APRÈS la classe de l\'appelant (un p-0 local ne les retire pas)', () => {
    expect(sheet).toMatch(/right: "pt-\[var\(--vb-safe-top\)\] pb-\[var\(--vb-safe-bottom\)\] pr-\[var\(--vb-safe-right\)\]"/);
    expect(sheet).toMatch(/className,\s*\n\s*SHEET_SAFE_AREA\[side\]/);
    // Marge droite réservée au X dans l'en-tête (premier bloc).
    expect(sheet).toContain('[&>:first-child]:pr-13');
  });

  it('L81F-33 — bouton de fermeture : présent, aria-label « Fermer », 44 × 44, au-dessus du contenu, sous la zone sûre', () => {
    const bouton = sheet.slice(sheet.indexOf('<SheetPrimitive.Close'), sheet.indexOf('</SheetPrimitive.Close>'));
    expect(bouton).toContain('aria-label="Fermer"');
    expect(bouton).toContain('data-slot="sheet-close"');
    expect(bouton).toContain('size-11');
    expect(bouton).toContain('z-50');
    expect(sheet).toMatch(/right: "fixed top-\[calc\(var\(--vb-safe-top\)\+0\.5rem\)\]/);
    const dialog = lire('components/ui/dialog.tsx');
    expect(dialog).toContain('aria-label="Fermer"');
    expect(dialog).toMatch(/max-h-\[min\(90dvh,calc\(100dvh-var\(--vb-safe-top\)-var\(--vb-safe-bottom\)-2rem\)\)\]/);
  });

  it('L81F-34 — le bouton retour est branché sur la racine Sheet (tous les tiroirs)', () => {
    expect(sheet).toMatch(/useSheetHistory\(open\)/);
  });

  it('L81F-35 — page plein écran sous la barre d\'état (cause) et encarts définis une fois pour toute l\'application', () => {
    const layout = lire('app/layout.tsx');
    expect(layout).toMatch(/viewportFit: 'cover'/);
    expect(layout).toMatch(/statusBarStyle: 'black-translucent'/);
    const css = lire('app/globals.css');
    for (const c of ['top', 'right', 'bottom', 'left']) {
      expect(css).toContain(`--vb-safe-${c}: max(var(--safe-area-inset-${c}, 0px), env(safe-area-inset-${c}, 0px));`);
    }
  });

  it('L81F-36 — panneaux plein écran hors Sheet : préparation de dossier (mobile), menu du BO, détail d\'exécution du BO', () => {
    expect(lire('components/exports/preparation/ExportPreparationScreen.tsx')).toContain('fixed inset-0 z-50 flex flex-col bg-background pt-[var(--vb-safe-top)]');
    const bo = lire('components/AdminSidebar.tsx');
    expect(bo).toContain('fixed inset-y-0 left-0 z-50 w-72 bg-[color:var(--sidebar)] pt-[var(--vb-safe-top)] pb-[var(--vb-safe-bottom)]');
    expect(bo).toMatch(/aria-label="Fermer le menu"/);
    expect(bo).toContain('h-[calc(3.5rem+var(--vb-safe-top))] pt-[var(--vb-safe-top)]');
    expect(lire('app/admin/ai-executions/page.tsx')).toContain('pt-[calc(var(--vb-safe-top)+1.25rem)]');
  });
});
