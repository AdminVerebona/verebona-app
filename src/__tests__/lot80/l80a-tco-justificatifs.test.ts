/**
 * Lot 80A — bug « Justificatif » des lignes TCO (retour PO du 22/10/2026,
 * capture : toast « Erreur lors du chargement du document » au clic).
 *
 * Cause : le lien « Justificatif » menait à la page historique
 * `/documents/<id>`, qui lit `GET /api/documents/<id>` — route qui n'a JAMAIS
 * eu de GET (seul PUT existe depuis le tag `base`) : 405 → toast d'erreur et
 * renvoi vers « Mes documents », quel que soit le document (TOUS les liens).
 * L'identifiant transmis était bien celui du fichier (asset_files.id).
 *
 *   L80A-J01 aucun lien TCO ne mène plus à la page historique (test rouge
 *            avant correction) ; la page historique elle-même ouvre le tiroir ;
 *   L80A-J02 clic : revalidation (route existante de la mascotte, compte de la
 *            SESSION) puis tiroir document EXISTANT (`openDrawer`, 76E) avec
 *            retour du focus (`returnFocusTo`) ;
 *   L80A-J03 document supprimé / d'un autre compte : pas d'ouverture, message
 *            existant ; erreur réseau : pas d'ouverture ;
 *   L80A-J04 clic modifié (nouvel onglet) : le lien porte le lien profond du
 *            tiroir (`?tiroir=document:<id>`), jamais `/documents/<id>` ;
 *   L80A-J05 tous les liens « Justificatif » (sous-tiroirs retenues ET non
 *            retenues, justificatifs multiples « Justificatif : … ») passent
 *            par le même composant.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import React, { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const toasts = vi.hoisted(() => ({ info: [] as string[], error: [] as string[] }));
vi.mock('sonner', () => ({
  toast: Object.assign(() => {}, {
    info: (m: string) => { toasts.info.push(m); },
    error: (m: string) => { toasts.error.push(m); },
    success: () => {},
  }),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {}, replace: () => {} }), useParams: () => ({}) }));

(globalThis as { React?: typeof React }).React = React;

const lire = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');

describe('L80A-J — boutons « Justificatif » du TCO', () => {
  it('L80A-J01 — cause : la page /documents/<id> lit un GET inexistant ; aucun lien TCO n’y mène plus', () => {
    const route = lire('src/app/api/documents/[id]/route.ts');
    expect(route).not.toMatch(/export async function GET/);
    const ui = lire('src/components/assets/TcoSection.tsx');
    expect(ui).not.toMatch(/href=\{`\/documents\/\$\{/);
    // La page historique (liens anciens, notifications) ouvre le tiroir au lieu d'échouer.
    const page = lire('src/app/(dashboard)/documents/[id]/page.tsx');
    expect(page).not.toMatch(/fetch\(`\/api\/documents\/\$\{params\.id\}`/);
    expect(page).toMatch(/drawerHref\(\{ kind: 'document'/);
  });
});

// ── Comportement (sans DOM, convention du dépôt) ───────────────────────────
const drawers = await import('@/lib/drawers');
const mod = await import('@/components/assets/tco-justificatif');

type Win = EventTarget;
let events: { type: string; detail: unknown }[] = [];
const g = globalThis as unknown as { window?: Win };
beforeEach(() => {
  events = [];
  toasts.info.length = 0;
  toasts.error.length = 0;
  const w = new EventTarget();
  for (const t of [drawers.OPEN_ENTITY_DRAWER, drawers.OPEN_DOCUMENT_DRAWER]) w.addEventListener(t, (e) => events.push({ type: t, detail: (e as CustomEvent).detail }));
  g.window = w;
});
afterEach(() => { delete g.window; });

const el = () => ({ isConnected: true, focus: vi.fn() });
const clic = (target: unknown, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; button: number }> = {}) => ({
  currentTarget: target, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...mods,
});

function find(node: ReactNode, pred: (e: ReactElement<Record<string, unknown>>) => boolean): ReactElement<Record<string, unknown>> | null {
  if (Array.isArray(node)) { for (const n of node) { const r = find(n, pred); if (r) return r; } return null; }
  if (!isValidElement(node)) return null;
  const e = node as ReactElement<Record<string, unknown>>;
  if (pred(e)) return e;
  return find(e.props.children as ReactNode, pred);
}

describe('L80A-J — ouverture du tiroir document', () => {
  it('L80A-J02 — clic : revalidation puis tiroir document existant, sur le FICHIER, focus rendu au lien', async () => {
    const check = vi.fn(async () => 'ok' as const);
    const a = el();
    const e = clic(a);
    expect(await mod.openTcoJustificatif(e, 4242, { check })).toBe('opened');
    expect(e.preventDefault).toHaveBeenCalled();
    expect(check).toHaveBeenCalledWith(4242);
    const ouverts = events.filter((x) => x.type === drawers.OPEN_DOCUMENT_DRAWER);
    expect(ouverts).toHaveLength(1);
    expect(ouverts[0].detail).toMatchObject({ docId: 4242, returnFocusTo: a });
    expect(a.focus).toHaveBeenCalled();
    expect(toasts.error).toEqual([]);
  });

  it('L80A-J03 — document supprimé ou d’un autre compte : pas d’ouverture, message existant ; vérification impossible : pas d’ouverture', async () => {
    expect(await mod.openTcoJustificatif(clic(el()), 7, { check: async () => 'gone' })).toBe('gone');
    expect(await mod.openTcoJustificatif(clic(el()), 8, { check: async () => 'error' })).toBe('error');
    expect(events.filter((x) => x.type === drawers.OPEN_DOCUMENT_DRAWER)).toEqual([]);
    expect(toasts.info).toEqual(['Cet élément n’est plus disponible.']);
    expect(toasts.error).toEqual(['Cette action n’a pas pu être ouverte. Réessayez.']);
    // Jamais le message de la page historique.
    expect([...toasts.info, ...toasts.error].join(' ')).not.toMatch(/Erreur lors du chargement du document/);
  });

  it('L80A-J04 — clic modifié : suit le lien profond du tiroir (nouvel onglet), jamais /documents/<id>', async () => {
    const check = vi.fn(async () => 'ok' as const);
    const e = clic(el(), { ctrlKey: true });
    expect(await mod.openTcoJustificatif(e, 9, { check })).toBe('follow');
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
    const html = renderToStaticMarkup(React.createElement(mod.TcoJustificatif, { fileId: 9 }));
    expect(html).toContain('href="/documents?tiroir=document%3A9"');
    expect(html).toContain('data-tco-doc-link="9"');
    expect(html).toContain('>Justificatif<');
    expect(html).not.toMatch(/href="\/documents\/9"/);
    // Justificatif multiple : libellé « Justificatif : <titre> », nom accessible complet.
    const multi = renderToStaticMarkup(React.createElement(mod.TcoJustificatif, { fileId: 10, title: 'Facture Homiris' }));
    expect(multi).toContain('Justificatif : Facture Homiris');
    expect(multi).toMatch(/aria-label="Ouvrir le justificatif Facture Homiris"/);
    // Sans fichier : rien.
    expect(mod.TcoJustificatif({ fileId: null })).toBeNull();
  });

  it('L80A-J04b — le composant branche le clic sur l’ouverture du tiroir (pas de navigation)', async () => {
    const tree = mod.TcoJustificatif({ fileId: 11 });
    const a = find(tree, (x) => x.type === 'a');
    expect(a).not.toBeNull();
    expect(typeof a!.props.onClick).toBe('function');
  });

  it('L80A-J05 — tous les liens « Justificatif » du TCO (retenues, non retenues, multiples) passent par TcoJustificatif', () => {
    const ui = lire('src/components/assets/TcoSection.tsx');
    expect(ui).not.toMatch(/<Link\b/);
    expect(ui).toMatch(/<TcoJustificatif fileId=\{l\.fileId\}/);
    expect(ui).toMatch(/supportingDocuments \?\? \[\]\)\.map\(\(d\) => <TcoJustificatif key=\{d\.fileId\} fileId=\{d\.fileId\} title=\{d\.title\}/);
    // Une seule ligne de dépense (LigneDepense) rend les justificatifs, dans les deux sous-tiroirs.
    expect((ui.match(/<LigneDepense /g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});
