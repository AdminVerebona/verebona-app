/**
 * Lot 76E — « À traiter » : la vignette d'aperçu du document ouvre son tiroir.
 *
 * Retour PO du 21/10/2026 : « dans À traiter, le clic sur le preview doit
 * ouvrir le drawer ».
 *
 *   L76E-01 la vignette est un VRAI bouton (type="button", nom accessible
 *           « Ouvrir le document <titre> », curseur pointeur, anneau de focus
 *           de la charte) ; l'icône de repli n'en est pas un ;
 *   L76E-02 clic / tap : le tiroir document EXISTANT s'ouvre (mécanisme
 *           `openDrawer` → `open-document-drawer`), sur le bon document ;
 *   L76E-03 le clic ne déclenche AUCUNE action de la carte (ni choix, ni
 *           « Autre », ni résolution) et ne remonte pas ;
 *   L76E-04 clavier : Entrée / Espace (bouton natif hors formulaire, aucun
 *           gestionnaire clavier qui l'empêcherait) ;
 *   L76E-05 focus restitué à la fermeture : le bouton prend le focus avant
 *           l'ouverture et le tiroir le lui rend (`returnFocusTo`) ;
 *   L76E-06 document inaccessible (supprimé, autre compte) : pas d'ouverture,
 *           message existant, file relue ; erreur réseau : pas d'ouverture ;
 *   L76E-07 double clic : une seule vérification, un seul tiroir ;
 *   L76E-08 desktop ET mobile : même composant, toutes familles de cartes à
 *           vignette (pas seulement le rattachement), page « À traiter » ;
 *   L76E-09 isolation : la vérification passe par la route de revalidation
 *           (compte de la SESSION, `deleted_at IS NULL`) — aucun identifiant
 *           cru sur parole.
 *
 * Environnement `node`, sans DOM (convention du dépôt) : balisage par
 * `renderToStaticMarkup`, composant SANS hook (`DocumentPreviewButton`)
 * appelé comme une fonction pour déclencher son `onClick`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import React, { createElement as h, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const toasts = vi.hoisted(() => ({ info: [] as string[], error: [] as string[] }));
vi.mock('sonner', () => ({
  toast: Object.assign(() => {}, {
    info: (m: string) => { toasts.info.push(m); },
    error: (m: string) => { toasts.error.push(m); },
    success: () => {},
  }),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));

(globalThis as { React?: typeof React }).React = React;

const drawers = await import('@/lib/drawers');
const { ActionCard, DocumentPreviewButton } = await import('@/components/to-process/ActionCard');
const preview = await import('@/components/to-process/document-preview');
const { TO_PROCESS_SYNC_EVENT } = await import('@/components/to-process/useToProcessResolution');

const lire = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');

type View = Parameters<typeof ActionCard>[0]['action'];
const THUMB = 'https://s3.example/derivatives/thumbnails/a_1/f_42/list-x.webp?X-Amz-Signature=1';
const rattachement = (over: Partial<View> = {}, target: Partial<View['target']> = {}): View => ({
  publicId: 'a1b2c3d4-0076', targetType: 'DOCUMENT', targetId: 42, fieldKey: null, relationKey: 'asset',
  actionKind: 'ARBITRATE', priority: 'DO_NEXT', ruleCode: 'DOC-ASSET-LINK', question: 'À quel bien rattacher ce document ?',
  proposals: [
    { value: 7, label: 'Maison', sourceContext: { label: 'Historique fournisseur fourni par le serveur : 3 documents' } },
  ],
  ...over,
  target: { label: 'Fiche de contacts Cardif IARD BNP Paribas', thumbnailUrl: THUMB, ...target },
});

function find(node: ReactNode, pred: (el: ReactElement<Record<string, unknown>>) => boolean): ReactElement<Record<string, unknown>> | null {
  if (Array.isArray(node)) {
    for (const n of node) { const r = find(n, pred); if (r) return r; }
    return null;
  }
  if (!isValidElement(node)) return null;
  const el = node as ReactElement<Record<string, unknown>>;
  if (pred(el)) return el;
  return find(el.props.children as ReactNode, pred);
}

// ── Fenêtre minimale (événements) ─────────────────────────────────────────
type Win = EventTarget;
let events: { type: string; detail: unknown }[] = [];
const g = globalThis as unknown as { window?: Win };
beforeEach(() => {
  events = [];
  toasts.info.length = 0;
  toasts.error.length = 0;
  const w = new EventTarget();
  for (const t of [drawers.OPEN_ENTITY_DRAWER, drawers.OPEN_DOCUMENT_DRAWER, TO_PROCESS_SYNC_EVENT]) {
    w.addEventListener(t, (e) => events.push({ type: t, detail: (e as CustomEvent).detail }));
  }
  g.window = w;
});
afterEach(() => { delete g.window; });

/** Bouton « vignette » simulé : élément focalisable, branché au document. */
const trigger = () => {
  const order: string[] = [];
  const el = { isConnected: true, focus: vi.fn(() => { order.push('focus'); }) };
  return { el, order };
};
const fakeClick = (el: unknown) => ({ currentTarget: el, preventDefault: vi.fn(), stopPropagation: vi.fn() });

const boutonDe = (action: View, extra: Partial<Parameters<typeof DocumentPreviewButton>[0]> = {}) => {
  const tree = DocumentPreviewButton({ action, src: THUMB, onImageError: () => {}, ...extra });
  const btn = find(tree, (el) => el.type === 'button');
  if (!btn) throw new Error('bouton absent');
  return btn;
};

describe('L76E — vignette « À traiter » → tiroir du document', () => {
  it('L76E-01 — la vignette est un vrai bouton accessible (nom « Ouvrir le document <titre> », pointeur, focus de la charte)', () => {
    const html = renderToStaticMarkup(h(ActionCard, { action: rattachement(), onChoose: () => {}, onOpenTarget: () => {}, visual: true }));
    const m = /<button[^>]*data-card-visual="thumbnail"[^>]*>/.exec(html);
    expect(m, 'la vignette doit être un <button>').not.toBeNull();
    const tag = m![0];
    expect(tag).toContain('type="button"');
    expect(tag).toContain('aria-label="Ouvrir le document Fiche de contacts Cardif IARD BNP Paribas"');
    expect(tag).toContain('cursor-pointer');
    // Anneau de focus : celui de la charte (globals.css, `button:focus-visible`),
    // jamais neutralisé.
    expect(tag).not.toContain('data-focus-ring="off"');
    expect(tag).not.toMatch(/focus-visible:outline-none|focus:outline-none/);
    // L'image est décorative : le nom vient du bouton.
    expect(html).toMatch(/<img[^>]+alt=""/);
    expect(lire('src/app/globals.css')).toMatch(/:where\(a\[href\], button,[\s\S]*?:focus-visible/);

    // Icône de repli (pas de miniature) : pas un bouton.
    const sans = renderToStaticMarkup(h(ActionCard, { action: rattachement({}, { thumbnailUrl: null }), onChoose: () => {}, onOpenTarget: () => {}, visual: true }));
    expect(sans).toContain('data-card-visual="icon"');
    expect(sans).not.toMatch(/<button[^>]*data-card-visual/);
    expect(sans).not.toContain('Ouvrir le document');
  });

  it('L76E-02 — clic / tap : le tiroir document existant s’ouvre sur le document de la carte', async () => {
    const check = vi.fn(async () => 'ok' as const);
    const { el } = trigger();
    const r = await preview.openCardDocumentPreview(fakeClick(el), rattachement(), { check });
    expect(r).toBe('opened');
    expect(check).toHaveBeenCalledWith(42);
    const ouverts = events.filter((e) => e.type === drawers.OPEN_DOCUMENT_DRAWER);
    expect(ouverts).toHaveLength(1);
    expect((ouverts[0].detail as { docId: number }).docId).toBe(42);
    // Même tiroir que partout ailleurs : aucun nouveau tiroir, pas la pile.
    expect(events.some((e) => e.type === drawers.OPEN_ENTITY_DRAWER)).toBe(false);
    expect(toasts.info).toEqual([]);
    expect(toasts.error).toEqual([]);

    // Le bouton rendu est bien branché sur ce parcours.
    const src = lire('src/components/to-process/ActionCard.tsx');
    expect(src).toMatch(/onClick=\{\(e\) => \{ void openCardDocumentPreview\(e, action\); \}\}/);
    expect(lire('src/components/to-process/document-preview.ts')).toMatch(/openDrawer\(\{ kind: 'document', id: action\.targetId \}/);
  });

  it('L76E-03 — le clic ne déclenche aucune action de la carte et ne remonte pas', async () => {
    const onChoose = vi.fn();
    const onOpenTarget = vi.fn();
    const check = vi.fn(async () => 'ok' as const);
    const { el } = trigger();
    const e = fakeClick(el);
    await preview.openCardDocumentPreview(e, rattachement(), { check });
    expect(e.stopPropagation).toHaveBeenCalled();
    expect(e.preventDefault).toHaveBeenCalled();
    expect(onChoose).not.toHaveBeenCalled();
    expect(onOpenTarget).not.toHaveBeenCalled();
    // Aucune résolution : ni appel de la route `resolve`, ni relecture de la file.
    expect(events.some((x) => x.type === TO_PROCESS_SYNC_EVENT)).toBe(false);

    // Le bouton est HORS du corps de la carte (choix, « Autre », formulaire) :
    // rendu à côté, jamais imbriqué dans un contrôle.
    const html = renderToStaticMarkup(h(ActionCard, { action: rattachement(), onChoose, onOpenTarget, visual: true }));
    const iBtn = html.indexOf('data-card-visual="thumbnail"');
    expect(html.indexOf('data-proposals')).toBeLessThan(iBtn);
    expect(html.slice(0, iBtn)).not.toMatch(/<form(?![\s\S]*<\/form>)/);
    expect(onChoose).not.toHaveBeenCalled();
    expect(onOpenTarget).not.toHaveBeenCalled();
  });

  it('L76E-04 — clavier : Entrée / Espace activent le bouton natif (aucun gestionnaire clavier ne l’empêche)', () => {
    const btn = boutonDe(rattachement());
    expect(btn.props.type).toBe('button');
    expect(btn.props.onKeyDown).toBeUndefined();
    expect(btn.props.onKeyUp).toBeUndefined();
    expect(btn.props.tabIndex).toBeUndefined();
    expect(btn.props.disabled).toBeFalsy();
    expect(typeof btn.props.onClick).toBe('function');
    // Une carte « À compléter » en ligne (formulaire) : la vignette reste hors
    // du formulaire — Entrée sur la vignette ne soumet rien.
    const html = renderToStaticMarkup(h(ActionCard, {
      action: rattachement({ actionKind: 'COMPLETE', inputType: 'date', proposals: [] }),
      onChoose: () => {}, onOpenTarget: () => {}, visual: true,
    }));
    expect(html.indexOf('</form>')).toBeGreaterThan(-1);
    expect(html.indexOf('</form>')).toBeLessThan(html.indexOf('data-card-visual="thumbnail"'));
  });

  it('L76E-05 — focus : le bouton prend le focus AVANT l’ouverture et le tiroir le lui rend à la fermeture', async () => {
    const check = vi.fn(async () => 'ok' as const);
    const { el, order } = trigger();
    const w = g.window!;
    w.addEventListener(drawers.OPEN_DOCUMENT_DRAWER, () => order.push('open'));
    await preview.openCardDocumentPreview(fakeClick(el), rattachement(), { check });
    expect(order).toEqual(['focus', 'open']);
    const detail = events.find((e) => e.type === drawers.OPEN_DOCUMENT_DRAWER)!.detail as { returnFocusTo?: unknown };
    expect(detail.returnFocusTo).toBe(el);

    // Fermeture du tiroir : `restoreFocusOnClose` rend le focus au bouton et
    // empêche le comportement Radix (qui, sans déclencheur, ne le rend à rien).
    el.focus.mockClear();
    const ev = { preventDefault: vi.fn() };
    expect(drawers.restoreFocusOnClose(ev, el as unknown as HTMLElement)).toBe(true);
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(el.focus).toHaveBeenCalledTimes(1);
    // Carte retirée entre-temps (élément détaché) : comportement par défaut.
    const parti = { isConnected: false, focus: vi.fn() };
    const ev2 = { preventDefault: vi.fn() };
    expect(drawers.restoreFocusOnClose(ev2, parti as unknown as HTMLElement)).toBe(false);
    expect(ev2.preventDefault).not.toHaveBeenCalled();
    expect(parti.focus).not.toHaveBeenCalled();
    expect(drawers.restoreFocusOnClose(ev2, null)).toBe(false);

    // Câblage : l'hôte du tiroir document transmet l'élément, le tiroir le
    // rend à sa fermeture (opt-in : les autres ouvertures sont inchangées).
    const layout = lire('src/components/DashboardLayout.tsx');
    expect(layout).toMatch(/returnFocusTo/);
    expect(layout).toMatch(/returnFocusTo=\{globalDocDrawerReturnFocus\}/);
    const tiroir = lire('src/components/assets/DocumentDrawer.tsx');
    expect(tiroir).toMatch(/onCloseAutoFocus=\{\(e\) => \{ restoreFocusOnClose\(e, returnFocusTo\); \}\}/);
  });

  it('L76E-05b — sans `returnFocusTo`, l’ouverture du tiroir document est inchangée (autres écrans)', () => {
    drawers.openDrawer({ kind: 'document', id: 9 });
    const d = events.find((e) => e.type === drawers.OPEN_DOCUMENT_DRAWER)!.detail as Record<string, unknown>;
    expect(d.docId).toBe(9);
    expect(d.returnFocusTo).toBeUndefined();
  });

  it('L76E-06 — document inaccessible : pas d’ouverture, message existant, file relue ; erreur : pas d’ouverture', async () => {
    const { el } = trigger();
    const r = await preview.openCardDocumentPreview(fakeClick(el), rattachement(), { check: async () => 'gone' });
    expect(r).toBe('gone');
    expect(events.some((e) => e.type === drawers.OPEN_DOCUMENT_DRAWER)).toBe(false);
    // Message existant (mascotte, revalidation au clic).
    expect(toasts.info).toEqual(['Cet élément n’est plus disponible.']);
    expect(lire('src/components/home/MascotSpeaks.tsx')).toContain('Cet élément n’est plus disponible.');
    expect(events.some((e) => e.type === TO_PROCESS_SYNC_EVENT)).toBe(true);

    events.length = 0;
    const r2 = await preview.openCardDocumentPreview(fakeClick(el), rattachement(), { check: async () => 'error' });
    expect(r2).toBe('error');
    expect(events.some((e) => e.type === drawers.OPEN_DOCUMENT_DRAWER)).toBe(false);
    expect(toasts.error).toEqual(['Cette action n’a pas pu être ouverte. Réessayez.']);
    expect(lire('src/components/home/MascotSpeaks.tsx')).toContain('Cette action n’a pas pu être ouverte. Réessayez.');

    // La vérification elle-même : 404 / 401 / réseau → « error », jamais « ok ».
    const rep = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });
    expect(await preview.checkDocumentAccessible(42, rep(200, { status: 'ok' }))).toBe('ok');
    expect(await preview.checkDocumentAccessible(42, rep(200, { status: 'gone' }))).toBe('gone');
    expect(await preview.checkDocumentAccessible(42, rep(401, {}))).toBe('error');
    expect(await preview.checkDocumentAccessible(42, rep(200, { status: 'bizarre' }))).toBe('error');
    expect(await preview.checkDocumentAccessible(42, async () => { throw new Error('réseau'); })).toBe('error');
  });

  it('L76E-07 — double clic : une seule vérification, un seul tiroir', async () => {
    let release!: () => void;
    const check = vi.fn(() => new Promise<'ok'>((res) => { release = () => res('ok'); }));
    const { el } = trigger();
    const a = rattachement();
    const p1 = preview.openCardDocumentPreview(fakeClick(el), a, { check });
    const r2 = await preview.openCardDocumentPreview(fakeClick(el), a, { check });
    expect(r2).toBe('busy');
    release();
    expect(await p1).toBe('opened');
    expect(check).toHaveBeenCalledTimes(1);
    expect(events.filter((e) => e.type === drawers.OPEN_DOCUMENT_DRAWER)).toHaveLength(1);
    // Après coup, un nouveau clic rouvre normalement.
    const r3 = await preview.openCardDocumentPreview(fakeClick(el), a, { check: async () => 'ok' });
    expect(r3).toBe('opened');
  });

  it('L76E-08 — desktop ET mobile, toutes familles de cartes à vignette, page « À traiter »', () => {
    const familles: Partial<View>[] = [
      { ruleCode: 'DOC-ASSET-LINK', actionKind: 'ARBITRATE' },
      { ruleCode: 'DOC-INTERVENTION', actionKind: 'ARBITRATE', proposals: [{ value: true, label: 'C’est fait' }] },
      { ruleCode: 'R', actionKind: 'COMPLETE', proposals: [] },
      { ruleCode: 'R', actionKind: 'COMPLETE', inputType: 'date', proposals: [] },
      { ruleCode: 'AGENDA-PROPOSAL', actionKind: 'ARBITRATE', proposals: [{ value: true, label: 'Oui' }] },
      { ruleCode: 'DOC-FIELD', actionKind: 'ARBITRATE', fieldKey: 'documentDate', relationKey: null, proposals: [{ value: '2026-01-01', label: '01/01/2026', isCurrentValue: true }] },
    ];
    for (const f of familles) {
      const html = renderToStaticMarkup(h(ActionCard, { action: rattachement(f), onChoose: () => {}, onOpenTarget: () => {}, visual: true }));
      expect(html, String(f.ruleCode)).toMatch(/<button[^>]*data-card-visual="thumbnail"[^>]*aria-label="Ouvrir le document /);
    }
    // Un seul composant, deux gabarits : plus petit sur mobile, `sm:` au-delà.
    const tag = /<button[^>]*data-card-visual="thumbnail"[^>]*>/.exec(
      renderToStaticMarkup(h(ActionCard, { action: rattachement(), onChoose: () => {}, onOpenTarget: () => {}, visual: true })),
    )![0];
    expect(tag).toMatch(/\bh-14\b/);
    expect(tag).toMatch(/\bw-11\b/);
    expect(tag).toMatch(/sm:h-\[88px\]/);
    expect(tag).toMatch(/sm:w-\[68px\]/);
    // La page (desktop et mobile) rend les cartes avec leur visuel.
    expect(lire('src/components/to-process/ToProcessQueue.tsx')).toMatch(/<ActionCard[\s\S]*?visual\s*\/>/);
    expect(lire('src/app/(dashboard)/accueil/a-traiter/page.tsx')).toContain('ToProcessQueue');
  });

  it('L76E-09 — isolation : revalidation par la route de session, jamais par l’identifiant seul', async () => {
    const appels: { url: string; init: RequestInit }[] = [];
    await preview.checkDocumentAccessible(42, async (url, init) => {
      appels.push({ url: String(url), init: init! });
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
    });
    expect(appels).toHaveLength(1);
    expect(appels[0].url).toBe('/api/home/mascot/check');
    expect(appels[0].init.method).toBe('POST');
    expect(appels[0].init.credentials).toBe('include');
    expect(JSON.parse(String(appels[0].init.body))).toEqual({ target: { kind: 'drawer', drawer: 'document', id: 42 } });
    // Côté serveur : compte de la session, document non supprimé.
    expect(lire('src/app/api/home/mascot/check/route.ts')).toMatch(/checkTarget\(s\.accountId/);
    expect(lire('src/services/home/mascot/actions.service.ts'))
      .toMatch(/document: `SELECT 1 FROM asset_files WHERE id = \$1 AND account_id = \$2 AND deleted_at IS NULL`/);
    // Cible non document : jamais de vignette cliquable vers un tiroir document.
    const html = renderToStaticMarkup(h(ActionCard, {
      action: rattachement({ targetType: 'ASSET', ruleCode: 'ASSET-STATUS' }), onChoose: () => {}, onOpenTarget: () => {}, visual: true,
    }));
    expect(html).not.toContain('Ouvrir le document');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// L76E-ETQ — étiquettes action / priorité (retour PO du 21/10/2026 12:20)
//
// Variante 1 retenue : en bas à droite de la carte, sous la vignette quand il
// y en a une (≥ sm) ; sur mobile, la carte empile et les étiquettes passent
// en bas à droite, sous les boutons. Style discret, NON bouton. Ordre DOM =
// ordre visuel : question, cible, boutons, (vignette), étiquettes.
// ══════════════════════════════════════════════════════════════════════════
describe('L76E-ETQ — étiquettes action / priorité en bas à droite, discrètes', () => {
  const rendu = (a: View, visual = true) => renderToStaticMarkup(h(ActionCard, { action: a, onChoose: () => {}, onOpenTarget: () => {}, visual }));
  const etiquettes = (html: string) => {
    const m = /<p[^>]*data-card-tags[^>]*>([\s\S]*?)<\/p>/.exec(html);
    if (!m) throw new Error('étiquettes absentes');
    return { tag: /<p[^>]*>/.exec(m[0])![0], inner: m[1], at: m.index };
  };
  const familles: [string, Partial<View>, string][] = [
    ['rattachement', { ruleCode: 'DOC-ASSET-LINK', actionKind: 'ARBITRATE' }, 'À arbitrer'],
    ['intervention', { ruleCode: 'DOC-INTERVENTION', actionKind: 'ARBITRATE', proposals: [{ value: true, label: 'C’est fait' }] }, 'Action à mener'],
    ['à compléter (Ouvrir)', { ruleCode: 'R', actionKind: 'COMPLETE', proposals: [] }, 'À compléter'],
    ['à compléter en ligne', { ruleCode: 'R', actionKind: 'COMPLETE', inputType: 'date', proposals: [] }, 'À compléter'],
    ['échéance sans vignette', { ruleCode: 'AGENDA-DATE', actionKind: 'COMPLETE', targetType: 'AGENDA_ITEM', proposals: [] }, 'À compléter'],
  ];

  it('L76E-ETQ-01 — toutes familles : les deux étiquettes sont conservées, APRÈS les boutons (le bloc d’actions suit le texte)', () => {
    for (const [nom, f, nature] of familles) {
      for (const visual of [true, false]) {
        const html = rendu(rattachement(f), visual);
        const e = etiquettes(html);
        expect(e.inner, nom).toContain(nature);
        expect(e.inner, nom).toContain('À faire ensuite');
        // Question → cible → contrôles → étiquettes.
        expect(html.indexOf('<h3'), nom).toBeLessThan(e.at);
        const controle = Math.max(html.lastIndexOf('<button', e.at), html.lastIndexOf('<input', e.at));
        expect(controle, nom).toBeGreaterThan(html.indexOf('<h3'));
        // Plus rien entre la ligne de la cible et les boutons : aucune étiquette avant eux.
        const corps = html.slice(html.indexOf('<h3'), html.indexOf('<button'));
        expect(corps, nom).not.toContain(nature);
        expect(corps, nom).not.toContain('À faire ensuite');
      }
    }
  });

  it('L76E-ETQ-02 — style discret, clairement non cliquable (ni bouton, ni pastille, ni fond ni bordure)', () => {
    const html = rendu(rattachement());
    const { tag, inner } = etiquettes(html);
    expect(tag).toMatch(/text-\[11px\]/);
    expect(tag).toContain('text-muted-foreground');
    expect(tag).not.toMatch(/\brole=|tabindex|cursor-pointer/);
    expect(inner).not.toMatch(/<button|<a |role=/);
    // Plus aucun composant Badge (pastille bordée / fond secondaire) dans la carte.
    expect(html).not.toContain('data-slot="badge"');
    expect(inner).not.toMatch(/\bborder\b|\bbg-|rounded-full|rounded-md/);
    expect(lire('src/components/to-process/ActionCard.tsx')).not.toMatch(/from '@\/components\/ui\/badge'/);
    // Séparateur visuel ignoré des lecteurs d'écran ; priorité en toutes lettres (§16.2).
    expect(inner).toMatch(/<span aria-hidden="true"[^>]*>·<\/span>/);
    for (const p of ['DO_FIRST', 'DO_NEXT', 'CAN_WAIT'] as const) {
      expect(etiquettes(rendu(rattachement({ priority: p }))).inner.replace(/&#x27;/g, "'"))
        .toContain({ DO_FIRST: "À faire d'abord", DO_NEXT: 'À faire ensuite', CAN_WAIT: 'Peut attendre' }[p]);
    }
  });

  it('L76E-ETQ-03 — desktop (≥ sm) : sous la vignette, en bas à droite de la carte', () => {
    const html = rendu(rattachement());
    const { tag, at } = etiquettes(html);
    // Même colonne que la vignette, après elle.
    const col = /<div[^>]*data-card-aside[^>]*>/.exec(html)!;
    expect(col.index).toBeLessThan(html.indexOf('data-card-visual="thumbnail"'));
    expect(html.indexOf('data-card-visual="thumbnail"')).toBeLessThan(at);
    expect(col[0]).toMatch(/sm:flex\b/);
    expect(col[0]).toMatch(/sm:flex-col/);
    expect(col[0]).toMatch(/sm:items-end/);
    expect(col[0]).toMatch(/sm:justify-between/);
    expect(col[0]).toMatch(/sm:self-stretch/);
    expect(tag).toMatch(/sm:flex-col/);
    expect(tag).toMatch(/sm:items-end/);
    // Le séparateur disparaît quand les étiquettes s'empilent.
    expect(etiquettes(html).inner).toMatch(/<span aria-hidden="true" class="[^"]*sm:hidden/);
    // Carte sans miniature : même place, sous l'icône de la cible.
    const ic = rendu(rattachement({}, { thumbnailUrl: null }));
    expect(ic.indexOf('data-card-visual="icon"')).toBeLessThan(etiquettes(ic).at);
  });

  it('L76E-ETQ-04 — mobile : la carte empile, étiquettes sur leur ligne en bas à droite, sans débordement', () => {
    const html = rendu(rattachement());
    const article = /<article[^>]*>/.exec(html)![0];
    // Disposition historique conservée (L34-11-4), passage à la ligne en mobile seulement.
    expect(article).toMatch(/flex items-start gap-3 sm:gap-4/);
    expect(article).toMatch(/\bflex-wrap\b/);
    expect(article).toMatch(/sm:flex-nowrap/);
    // Colonne « transparente » en mobile : vignette et étiquettes deviennent des
    // éléments de la carte ; les étiquettes prennent toute une ligne, à droite.
    const col = /<div[^>]*data-card-aside[^>]*>/.exec(html)![0];
    expect(col).toMatch(/class="contents /);
    const { tag } = etiquettes(html);
    expect(tag).toMatch(/\bbasis-full\b/);
    expect(tag).toMatch(/justify-end/);
    expect(tag).toMatch(/flex-wrap/);
    expect(tag).toMatch(/max-w-full/);
    expect(tag).toMatch(/sm:basis-auto/);
    expect(html).toContain('min-w-0 flex-1');
  });

  it('L76E-ETQ-05 — sans visuel (choix de la mascotte) : en fin de carte, alignées à droite', () => {
    const html = rendu(rattachement(), false);
    const { tag, at } = etiquettes(html);
    expect(tag).toMatch(/justify-end/);
    expect(at).toBeGreaterThan(html.lastIndexOf('<button'));
    expect(html).not.toContain('data-card-aside');
  });

  it('L76E-ETQ-06 — rien ne change pour le tri / la bascule de priorité (serveur), ni pour la mascotte', () => {
    const q = lire('src/components/to-process/ToProcessQueue.tsx');
    expect(q).toContain("`/api/v2/to-process?order=${mode === 'BY_ACTION' ? 'action' : 'priority'}`");
    expect(lire('src/components/home/TodoChoicesDialog.tsx')).not.toMatch(/\bvisual\b/);
  });
});
