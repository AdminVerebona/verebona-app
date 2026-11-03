/**
 * Lot 107E — « À traiter » : liens directs vers l'objet et les justificatifs.
 *
 *   L107E-01 plan : identifiants typés lus dans la carte seulement (preuves,
 *            `file:` / `file_`, `t1:`, contexte de source, périmètre groupé,
 *            documents d'un sinistre / d'une projection, événement, événement
 *            de référence) ; un candidat hors carte n'est jamais lié ;
 *   L107E-02 Draisienne : « Voir la facture » sur 69,99 €, AUCUNE source pour
 *            127,93 € (actuelle) sans écriture journalisée qui la justifie ;
 *   L107E-03 deux sources distinctes : chaque valeur garde la sienne ; la
 *            valeur actuelle n'a de source que si la dernière écriture porte
 *            cette valeur ET vient d'un document ;
 *   L107E-04 plusieurs justificatifs : « Voir les justificatifs (n) », liste
 *            bornée aux preuves de la carte ;
 *   L107E-05 document supprimé / en dépôt / autre compte / preuve disparue :
 *            état explicite, aucun identifiant ni titre exposé ; défauts
 *            techniques (pas les suppressions) signalés en Supervision ;
 *   L107E-06 présentation : pas de répétition (facture cible), regroupement
 *            des mêmes pièces, libellés « Voir la fiche / l’événement /
 *            l’événement de référence », jamais « Opération » ;
 *   L107E-07 clic : aucune action de la carte (ni choix, ni « Autre ») ;
 *            revalidation par la route de la carte ; destination native
 *            (tiroir document avec focus rendu, échéance en consultation,
 *            page du bien) ; supprimé → pas d'ouverture, file relue ;
 *   L107E-08 retour sans perte : état noté au départ vers une page, relu une
 *            fois, expiré au-delà du délai ; saisies non validées conservées ;
 *   L107E-09 charte : jetons de couleur, cibles tactiles 36 px en mobile,
 *            liens hors des boutons de choix ; route : session + carte.
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
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));
vi.mock('@/db', () => ({ db: {}, pgClient: { unsafe: async () => [] } }));

(globalThis as { React?: typeof React }).React = React;

const L = await import('@/services/to-process/card-links');
const M = await import('@/lib/to-process-links');
const O = await import('@/components/to-process/card-link-open');
const R = await import('@/components/to-process/return-state');
const { ActionCard } = await import('@/components/to-process/ActionCard');
const { CardLinks, CardLinkButton, CARD_LINK_CLASS } = await import('@/components/to-process/CardLinks');
const { TO_PROCESS_SYNC_EVENT } = await import('@/components/to-process/useToProcessResolution');

type Input = Parameters<typeof L.planCardLinks>[0];
type Data = Parameters<typeof L.assembleCardLinks>[2];
const lire = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');

const prix = (over: Partial<Input> = {}): Input => ({
  publicId: '00000000-0000-4000-8000-000000000107', ruleCode: 'DATA-ACQUISITION-PRICE', actionKind: 'ARBITRATE',
  targetType: 'ASSET', targetId: 55, fieldKey: 'acquisitionPrice', relationKey: null,
  proposals: [
    { value: 69.99, label: '69,99 €', confidence: 0.6, evidenceIds: ['901'] },
    { value: 127.93, label: '127,93 €', confidence: 1, isCurrentValue: true },
  ],
  triggerContext: null,
  ...over,
});

const vide = (): Data => ({
  evidence: new Map(), files: new Map(), assets: new Map(), equipments: new Map(), rooms: new Map(),
  agenda: new Map(), references: new Map(), suppliers: new Map(), currentWrites: new Map(),
});
const doc = (label: string, invoice = true, state: 'ok' | 'deleted' | 'not_ready' | 'other_account' = 'ok') => ({ state, label, invoice });
const draisienne = (): Data => {
  const d = vide();
  d.evidence.set(901, 4001);
  d.files.set(4001, doc('Facture Decathlon du 12/03/2024'));
  d.assets.set(55, { publicId: 'aaaaaaaa-0000-4000-8000-000000000055', label: 'Draisienne', available: true });
  return d;
};
const assemble = (c: Input, d: Data) => L.assembleCardLinks(c, L.planCardLinks(c), d);

describe('L107E-01 — plan : identifiants typés de la carte, rien d’autre', () => {
  it('preuves numériques, file:/file_, t1: (document cible), contexte de source DOCUMENT/ASSET/EQUIPMENT/AGENDA_ITEM', () => {
    const p = L.planCardLinks(prix({
      targetType: 'DOCUMENT', targetId: 7, fieldKey: null, relationKey: 'x', ruleCode: 'AGENDA-DONE',
      proposals: [
        { value: 'a', label: 'A', confidence: 1, evidenceIds: ['12', 'file:30', 'file_31', 't1:u4', 'n’importe quoi'] },
        { value: 'b', label: 'B', confidence: 1, sourceContext: { label: 'x', targetType: 'DOCUMENT', targetId: 32 } },
        { value: 'c', label: 'C', confidence: 1, sourceContext: { label: 'x', targetType: 'ASSET', targetId: 8 } },
        { value: 'd', label: 'D', confidence: 1, sourceContext: { label: 'x', targetType: 'EQUIPMENT', targetId: 9 } },
      ],
    }));
    expect(p.object).toEqual({ kind: 'document', id: 7 });
    expect(p.proposals[0]).toMatchObject({ evidence: [12], files: [30, 31, 7], target: null });
    expect(p.proposals[1]).toMatchObject({ files: [32] });
    expect(p.proposals[2].target).toEqual({ kind: 'asset', id: 8 });
    expect(p.proposals[3].target).toEqual({ kind: 'equipement', id: 9 });
  });

  it('candidats d’agenda et événements de référence : seulement ceux OFFERTS par la carte', () => {
    const projection = L.planCardLinks(prix({
      ruleCode: 'AGENDA-PROJECTION-MATCH', fieldKey: null, relationKey: 'p',
      proposals: [{ value: 'ITEM:70', label: 'Oui', confidence: 0.6 }, { value: 'ITEM:999', label: 'Faux', confidence: 0.5 }, { value: 'NEW', label: 'Non', confidence: 1, isCurrentValue: true }],
      triggerContext: { candidates: [{ itemId: 70 }], operationId: 5, provenance: { documents: [{ fileId: 44 }] } },
    }));
    expect(projection.proposals.map((x) => x.target)).toEqual([{ kind: 'echeance', id: 70 }, null, null]);
    expect(projection.related).toEqual([{ kind: 'reference', id: 5 }]);
    expect(projection.cardFiles).toEqual([44]);
    const match = L.planCardLinks(prix({
      targetType: 'DOCUMENT', targetId: 3, ruleCode: 'OPERATION-MATCH', fieldKey: null, relationKey: 'm',
      proposals: [{ value: 'SAME:11', label: 'Oui', confidence: 0.6 }, { value: 'SAME:12', label: 'Oui 2', confidence: 0.5 }],
      triggerContext: { operationIds: [11] },
    }));
    expect(match.proposals.map((x) => x.target)).toEqual([{ kind: 'reference', id: 11 }, null]);
  });

  it('carte groupée (105D), sinistre, statut d’un bien (événement), fournisseur résolu seulement', () => {
    const groupe = L.planCardLinks(prix({ targetType: 'DOCUMENT', targetId: 1, ruleCode: 'LINK-ASSET-GROUP', triggerContext: { scope: { label: 'x', documents: [{ id: 1 }, { id: 2 }, { id: 3 }] } } }));
    expect(groupe.cardFiles).toEqual([2, 3]); // le document cible n'est pas répété
    const confirme = L.planCardLinks(prix({ targetType: 'DOCUMENT', targetId: 1, ruleCode: 'LINK-ASSET-GROUP', triggerContext: { assetId: 8 },
      proposals: [{ value: 'CONFIRM:8', label: 'Oui', confidence: 0.6 }, { value: 'CONFIRM:9', label: 'Faux', confidence: 0.5 }, { value: 'REFUSE', label: 'Non', confidence: 0.3 }] }));
    expect(confirme.proposals.map((x) => x.target)).toEqual([{ kind: 'asset', id: 8 }, null, null]);
    const sinistre = L.planCardLinks(prix({ targetType: 'DOCUMENT', targetId: 9, triggerContext: { operationId: 4, fileIds: [8, 9], documents: [{ fileId: 8 }] } }));
    expect(sinistre.cardFiles).toEqual([8]);
    const statut = L.planCardLinks(prix({ ruleCode: 'ASSET-STATUS', triggerContext: { agendaItemId: 61 } }));
    expect(statut.related).toEqual([{ kind: 'echeance', id: 61 }]);
    expect(L.planCardLinks(prix({ targetType: 'SUPPLIER', targetId: 5, supplierId: null })).object).toBeNull();
    expect(L.planCardLinks(prix({ targetType: 'SUPPLIER', targetId: 5, supplierId: 77 })).object).toEqual({ kind: 'supplier', id: 77 });
  });

  it('rattachement : la valeur proposée est le bien ; la valeur actuelle, elle, n’est jamais une cible', () => {
    const p = L.planCardLinks(prix({ targetType: 'DOCUMENT', targetId: 1, ruleCode: 'LINK-ASSET', fieldKey: null, relationKey: 'assetIds',
      proposals: [{ value: 8, label: 'Maison', confidence: 0.7 }, { value: 9, label: 'Voiture', confidence: 1, isCurrentValue: true }] }));
    expect(p.proposals.map((x) => x.target)).toEqual([{ kind: 'asset', id: 8 }, null]);
  });
});

describe('L107E-02 / 03 — chaque valeur garde SA source, jamais de preuve factice', () => {
  it('Draisienne : 69,99 € → la facture exacte ; 127,93 € (actuelle) → aucune source', () => {
    const { links, issues } = assemble(prix(), draisienne());
    expect(links.object).toEqual({ kind: 'asset', id: 55, publicId: 'aaaaaaaa-0000-4000-8000-000000000055', label: 'Draisienne' });
    expect(links.proposals).toEqual([
      { documents: [4001], target: null, unavailable: 0 },
      { documents: [], target: null, unavailable: 0 },
    ]);
    expect(links.documents).toEqual([{ kind: 'document', id: 4001, label: 'Facture Decathlon du 12/03/2024', invoice: true }]);
    expect(issues).toEqual([]);
  });

  it('valeur actuelle : source seulement si la dernière écriture appliquée porte cette valeur et vient d’un document', () => {
    const d = draisienne();
    d.files.set(4002, doc('Facture Boutique vélo'));
    d.currentWrites.set('55:acquisitionPrice', { value: 127.93, fileId: 4002 });
    expect(assemble(prix(), d).links.proposals[1].documents).toEqual([4002]);
    // Valeur différente (saisie ou correction depuis) : pas de source.
    d.currentWrites.set('55:acquisitionPrice', { value: 120, fileId: 4002 });
    expect(assemble(prix(), d).links.proposals[1].documents).toEqual([]);
    // Dernière écriture humaine (sans document) : pas de source.
    d.currentWrites.set('55:acquisitionPrice', { value: 127.93, fileId: null });
    expect(assemble(prix(), d).links.proposals[1].documents).toEqual([]);
  });

  it('preuve non documentaire (saisie, agenda) : aucun lien, aucune anomalie', () => {
    const d = draisienne();
    d.evidence.set(901, null);
    const { links, issues } = assemble(prix(), d);
    expect(links.proposals[0]).toEqual({ documents: [], target: null, unavailable: 0 });
    expect(issues).toEqual([]);
  });
});

describe('L107E-04 — plusieurs justificatifs', () => {
  it('liste bornée, dédoublonnée, limitée aux preuves de la carte', () => {
    const d = draisienne();
    const ids = Array.from({ length: L.CARD_LINKS_MAX_DOCUMENTS + 3 }, (_, i) => 5000 + i);
    ids.forEach((id, i) => { d.evidence.set(100 + i, id); d.files.set(id, doc(`Pièce ${i}`, false)); });
    const c = prix({ proposals: [{ value: 69.99, label: '69,99 €', confidence: 0.6, evidenceIds: ids.map((_, i) => String(100 + i)).concat(['100']) }] });
    const { links } = assemble(c, d);
    expect(links.documents).toHaveLength(L.CARD_LINKS_MAX_DOCUMENTS);
    expect(links.proposals[0].documents).toHaveLength(L.CARD_LINKS_MAX_DOCUMENTS);
    const m = M.cardLinksModel([{ label: '69,99 €' }], links)!;
    expect(m.lines[0].items[0]).toMatchObject({ type: 'documents', text: `Voir les justificatifs (${L.CARD_LINKS_MAX_DOCUMENTS})` });
  });
});

describe('L107E-05 — supprimé, en dépôt, autre compte, preuve disparue', () => {
  it('jamais exposés (ni id ni titre) ; état « plus disponible » ; seuls les défauts TECHNIQUES sont signalés', () => {
    for (const state of ['deleted', 'not_ready'] as const) {
      const d = draisienne();
      d.files.set(4001, doc('Facture secrète', true, state));
      const { links, issues } = assemble(prix(), d);
      expect(links.documents).toEqual([]);
      expect(links.proposals[0]).toEqual({ documents: [], target: null, unavailable: 1 });
      expect(JSON.stringify(links)).not.toContain('secrète');
      expect(issues).toEqual([]);
    }
    const autre = draisienne();
    autre.files.set(4001, doc('Facture d’un autre compte', true, 'other_account'));
    const r1 = assemble(prix(), autre);
    expect(JSON.stringify(r1.links)).not.toMatch(/4001|autre compte/);
    expect(r1.issues).toEqual([{ code: 'SOURCE_OTHER_ACCOUNT', publicId: prix().publicId, ruleCode: 'DATA-ACQUISITION-PRICE', ref: 4001 }]);
    const perdue = draisienne();
    perdue.evidence.clear();
    expect(assemble(prix(), perdue).issues.map((i) => i.code)).toEqual(['EVIDENCE_NOT_FOUND']);
    const introuvable = draisienne();
    introuvable.files.clear();
    expect(assemble(prix(), introuvable).issues.map((i) => i.code)).toEqual(['SOURCE_NOT_FOUND']);
  });

  it('objet supprimé / archivé : état explicite, aucun lien', () => {
    const d = draisienne();
    d.assets.set(55, { publicId: 'x', label: 'Draisienne', available: false });
    const { links } = assemble(prix(), d);
    expect(links.object).toBeNull();
    expect(links.objectUnavailable).toBe('asset');
    expect(M.cardLinksModel(prix().proposals, links)!.notes).toContain('Fiche plus disponible');
  });

  it('Supervision : une anomalie par code et par compte, limitée dans le temps, sans secret', async () => {
    const appels: unknown[] = [];
    vi.doMock('@/services/admin/anomaly.service', () => ({
      buildFingerprint: (...p: unknown[]) => p.join(':'),
      reportAnomaly: async (x: unknown) => { appels.push(x); return 1; },
    }));
    L.resetCardLinkAnomalyThrottle();
    const issue = { code: 'SOURCE_OTHER_ACCOUNT' as const, publicId: 'p', ruleCode: 'R', ref: 1 };
    expect(await L.reportCardLinkIssues(9, [issue, { ...issue, ref: 2 }], 1000)).toBe(1);
    expect(await L.reportCardLinkIssues(9, [issue], 2000)).toBe(0); // dans la fenêtre
    expect(await L.reportCardLinkIssues(9, [issue], 1000 + L.CARD_LINKS_ANOMALY_THROTTLE_MS + 1)).toBe(1);
    expect(appels[0]).toMatchObject({ domain: 'other', accountId: 9, detail: { code: 'SOURCE_OTHER_ACCOUNT', count: 2 } });
    vi.doUnmock('@/services/admin/anomaly.service');
  });
});

describe('L107E-06 — présentation compacte, sans répétition', () => {
  it('Draisienne : une ligne « 69,99 € · Voir la facture », puis « Voir la fiche »', () => {
    const { links } = assemble(prix(), draisienne());
    const m = M.cardLinksModel(prix().proposals, links)!;
    expect(m.lines).toHaveLength(1);
    expect(m.lines[0]).toMatchObject({ index: 0, value: '69,99 €' });
    expect(m.lines[0].items[0]).toMatchObject({ type: 'link', text: 'Voir la facture', aria: 'Voir la facture justifiant « 69,99 € »' });
    expect(m.nav.map((n) => n.text)).toEqual(['Voir la fiche']);
  });

  it('mêmes pièces pour toutes les propositions → une seule entrée ; document cible jamais répété', () => {
    const d = draisienne();
    d.evidence.set(902, 4001);
    const meme = prix({ proposals: [{ value: 1, label: 'A', confidence: 1, evidenceIds: ['901'] }, { value: 2, label: 'B', confidence: 1, evidenceIds: ['902'] }] });
    const m = M.cardLinksModel(meme.proposals, assemble(meme, d).links)!;
    expect(m.lines).toEqual([]);
    expect(m.nav.map((n) => n.text)).toEqual(['Voir la facture', 'Voir la fiche']);
    // Carte sur un document : sa facture est l'objet, pas une ligne de plus.
    d.files.set(7, doc('Facture cible'));
    const surDoc = prix({ targetType: 'DOCUMENT', targetId: 7, fieldKey: 'x', ruleCode: 'AGENDA-PROPOSAL',
      proposals: [{ value: 'YES', label: 'Oui', confidence: 1, sourceContext: { label: 's', targetType: 'DOCUMENT', targetId: 7 } }, { value: 'NO', label: 'Non', confidence: 0.3 }] });
    const m2 = M.cardLinksModel(surDoc.proposals, assemble(surDoc, d).links)!;
    expect(m2.lines).toEqual([]);
    expect(m2.nav.map((n) => n.text)).toEqual(['Voir la facture']);
  });

  it('libellés selon l’objet ; jamais le mot « Opération »', () => {
    expect(M.cardLinkText({ kind: 'document', invoice: false })).toBe('Voir le document');
    expect(M.cardLinkText({ kind: 'equipement' })).toBe('Voir la fiche');
    expect(M.cardLinkText({ kind: 'piece' })).toBe('Voir la fiche');
    expect(M.cardLinkText({ kind: 'echeance' })).toBe('Voir l’événement');
    expect(M.cardLinkText({ kind: 'reference' })).toBe('Voir l’événement de référence');
    const textes = JSON.stringify(M.CARD_LINK_TEXT) + lire('src/components/to-process/CardLinks.tsx').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(textes).not.toMatch(/op[ée]ration/i);
  });

  it('sans liens (mascotte, ancienne réponse) : rien n’est affiché, la source historique reste', () => {
    expect(M.cardLinksModel([], undefined)).toBeNull();
    expect(renderToStaticMarkup(React.createElement(CardLinks, { cardId: 'x', proposals: [], links: undefined }))).toBe('');
  });
});

// ── Clic ────────────────────────────────────────────────────────────────────

type Win = EventTarget & { location: { assign: (h: string) => void } };
let events: Array<{ type: string; detail: unknown }> = [];
let fetchCalls: Array<{ url: string; body: unknown }> = [];
let reponse: unknown = { status: 'ok' };

beforeEach(() => {
  toasts.info.length = 0; toasts.error.length = 0; events = []; fetchCalls = []; reponse = { status: 'ok' };
  const w = new EventTarget() as Win;
  const orig = w.dispatchEvent.bind(w);
  w.dispatchEvent = (e: Event) => { events.push({ type: e.type, detail: (e as CustomEvent).detail }); return orig(e); };
  w.location = { assign: (h: string) => events.push({ type: 'assign', detail: h }) };
  vi.stubGlobal('window', w);
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    fetchCalls.push({ url, body: JSON.parse(String(init.body)) });
    return { ok: true, json: async () => reponse } as Response;
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

function find(node: ReactNode, pred: (el: ReactElement<Record<string, unknown>>) => boolean): ReactElement<Record<string, unknown>> | null {
  if (Array.isArray(node)) { for (const n of node) { const r = find(n, pred); if (r) return r; } return null; }
  if (!isValidElement(node)) return null;
  const el = node as ReactElement<Record<string, unknown>>;
  if (pred(el)) return el;
  if (typeof el.type === 'function' && !(el.type as { prototype?: { render?: unknown } }).prototype?.render) {
    try { const r = find((el.type as (p: unknown) => ReactNode)(el.props), pred); if (r) return r; } catch { /* composant à hooks : ignoré */ }
  }
  return find(el.props.children as ReactNode, pred);
}
const clic = () => {
  const focused: string[] = [];
  return { e: { currentTarget: { focus: () => focused.push('focus'), isConnected: true }, preventDefault: vi.fn(), stopPropagation: vi.fn() }, focused };
};

describe('L107E-07 — toucher un lien ne décide rien et ouvre la destination native', () => {
  const vue = () => {
    const { links } = assemble(prix(), draisienne());
    return {
      publicId: prix().publicId, targetType: 'ASSET' as const, targetId: 55, fieldKey: 'acquisitionPrice', relationKey: null,
      actionKind: 'ARBITRATE' as const, priority: 'DO_NEXT' as const, ruleCode: 'DATA-ACQUISITION-PRICE',
      question: 'Quel est le prix d’acquisition de ce bien ?',
      proposals: [{ value: 69.99, label: '69,99 €' }, { value: 127.93, label: '127,93 €', isCurrentValue: true }],
      target: { label: 'Draisienne', assetName: 'Draisienne', publicId: 'aaaaaaaa-0000-4000-8000-000000000055' },
      links,
    };
  };

  it('la carte rend « Voir la facture » (lien distinct des choix) ; le clic : revalidation, tiroir document, aucun choix', async () => {
    const onChoose = vi.fn();
    const onOpenTarget = vi.fn();
    const action = vue();
    const html = renderToStaticMarkup(React.createElement(ActionCard, { action, onChoose, onOpenTarget, visual: true }));
    expect(html).toContain('Voir la facture');
    expect(html).toContain('aria-label="Voir la facture justifiant « 69,99 € »"');
    expect(html).toContain('Voir la fiche');
    expect(html).not.toContain('Historique');
    // Le lien n'est jamais DANS un bouton de choix : le bloc des liens suit celui des choix, fermé.
    const choix = html.indexOf('data-proposals');
    const liens = html.indexOf('data-card-links');
    expect(choix).toBeGreaterThan(-1);
    expect(liens).toBeGreaterThan(choix);
    expect(html.slice(choix, liens)).toContain('</div>');
    const btn = find(React.createElement(CardLinks, { cardId: action.publicId, proposals: action.proposals, links: action.links }),
      (el) => el.props['data-link-kind'] === 'document' || (el.type === CardLinkButton && (el.props.target as { kind: string })?.kind === 'document'));
    expect(btn).not.toBeNull();
    const { e, focused } = clic();
    const rendu = (btn!.type === CardLinkButton ? (CardLinkButton as (p: unknown) => ReactElement<Record<string, unknown>>)(btn!.props) : btn!);
    await (rendu.props.onClick as (e: unknown) => Promise<void>)(e);
    await new Promise((r) => setTimeout(r, 0));
    expect(e.preventDefault).toHaveBeenCalled();
    expect(e.stopPropagation).toHaveBeenCalled();
    expect(focused).toEqual(['focus']);
    expect(fetchCalls).toEqual([{ url: `/api/v2/to-process/${action.publicId}/links`, body: { target: { kind: 'document', id: 4001 } } }]);
    expect(events.find((x) => x.type === 'open-document-drawer')?.detail).toMatchObject({ docId: 4001 });
    expect(onChoose).not.toHaveBeenCalled();
    expect(onOpenTarget).not.toHaveBeenCalled();
  });

  it('document supprimé entre-temps : rien ne s’ouvre, message existant, file relue ; erreur : rien ne s’ouvre', async () => {
    const ref = { kind: 'document' as const, id: 4001, label: 'F', invoice: true };
    reponse = { status: 'gone' };
    expect(await O.openCardLink(clic().e, 'card-0001', ref, 'p0:document:4001')).toBe('gone');
    expect(toasts.info).toContain('Cet élément n’est plus disponible.');
    expect(events.map((x) => x.type)).toEqual([TO_PROCESS_SYNC_EVENT]);
    events = [];
    expect(await O.openCardLink(clic().e, 'card-0001', ref, 'k', { check: async () => 'error' })).toBe('error');
    expect(events).toEqual([]);
    expect(await O.openCardLink(clic().e, 'card-0001', ref, 'k', { check: async () => 'resolved' })).toBe('resolved');
    expect(toasts.info).toContain('Cette action est déjà traitée.');
  });

  it('destinations : échéance et événement de référence en CONSULTATION, équipement / pièce en tiroir, bien en page (état noté)', async () => {
    expect(O.cardLinkDestination({ kind: 'reference', id: 70, label: 'x' })).toEqual({ type: 'drawer', kind: 'echeance', id: 70 });
    expect(O.cardLinkDestination({ kind: 'asset', id: 1, label: 'x', publicId: 'bad id' })).toBeNull();
    await O.openCardLink(clic().e, 'card-0001', { kind: 'echeance', id: 70, label: 'x' }, 'r:echeance:70', { check: async () => 'ok' });
    expect(events.at(-1)).toMatchObject({ type: 'open-entity-drawer', detail: { kind: 'echeance', id: 70, initialMode: 'view' } });
    await O.openCardLink(clic().e, 'card-0001', { kind: 'equipement', id: 9, label: 'x' }, 'k2', { check: async () => 'ok' });
    expect(events.at(-1)).toMatchObject({ type: 'open-entity-drawer', detail: { kind: 'equipement', id: 9 } });
    const nav: string[] = [];
    await O.openCardLink(clic().e, 'card-0001', { kind: 'asset', id: 55, label: 'x', publicId: 'aaaaaaaa-0000-4000-8000-000000000055' }, 'o:asset:55', { check: async () => 'ok', navigate: (h) => nav.push(h) });
    expect(events.at(-1)).toMatchObject({ type: R.TO_PROCESS_LEAVING_EVENT, detail: { cardId: 'card-0001', linkKey: 'o:asset:55' } });
    expect(nav).toEqual(['/assets/aaaaaaaa-0000-4000-8000-000000000055']);
  });

  it('double tap : une seule vérification', async () => {
    let n = 0;
    const lente = () => new Promise<'ok'>((r) => { n += 1; setTimeout(() => r('ok'), 5); });
    const ref = { kind: 'document' as const, id: 1, label: 'x' };
    const [a, b] = await Promise.all([O.openCardLink(clic().e, 'c-00000001', ref, 'k', { check: lente }), O.openCardLink(clic().e, 'c-00000001', ref, 'k', { check: lente })]);
    expect([a, b].sort()).toEqual(['busy', 'opened']);
    expect(n).toBe(1);
  });

  it('revalidation : une destination hors des liens de la carte est refusée', () => {
    const { links } = assemble(prix(), draisienne());
    expect(L.linksOffer(links, { kind: 'document', id: 4001 })).toBe(true);
    expect(L.linksOffer(links, { kind: 'asset', id: 55 })).toBe(true);
    expect(L.linksOffer(links, { kind: 'document', id: 4002 })).toBe(false);
    expect(L.linksOffer(links, { kind: 'asset', id: 56 })).toBe(false);
  });
});

describe('L107E-08 — retour vers la carte sans perte', () => {
  const store = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, m };
  };
  it('noté au départ, relu UNE fois, expiré au-delà du délai ; saisies non validées restaurées', () => {
    const s = store();
    R.setDraft('card-00000001', '2027-01-31');
    R.saveReturnState(s, { orderMode: 'BY_ACTION', scrollY: 840, cardId: 'card-00000001', linkKey: 'o:asset:55' }, 1000);
    R.clearDraft('card-00000001');
    const r = R.consumeReturnState(s, 2000)!;
    expect(r).toMatchObject({ orderMode: 'BY_ACTION', scrollY: 840, cardId: 'card-00000001', linkKey: 'o:asset:55', drafts: { 'card-00000001': '2027-01-31' } });
    expect(R.getDraft('card-00000001')).toBe('2027-01-31');
    expect(R.consumeReturnState(s, 2000)).toBeNull(); // une seule fois
    R.saveReturnState(s, { orderMode: 'BY_ACTION', scrollY: 0, cardId: null, linkKey: null }, 1000);
    expect(R.consumeReturnState(s, 1000 + R.RETURN_STATE_TTL_MS + 1)).toBeNull(); // nouvelle visite
    s.m.set(R.RETURN_STATE_KEY, '{pas du json');
    expect(R.consumeReturnState(s)).toBeNull();
    expect(R.consumeReturnState(null)).toBeNull();
  });

  it('la file écoute le départ, restaure ordre / carte / lien touché ; la saisie en ligne relit son brouillon', () => {
    const q = lire('src/components/to-process/ToProcessQueue.tsx');
    expect(q).toContain('TO_PROCESS_LEAVING_EVENT');
    expect(q).toMatch(/consumeReturnState\(sessionStore\(\)\)/);
    expect(q).toMatch(/retour\.current\?\.orderMode \?\? 'BY_PRIORITY'/);
    expect(q).toMatch(/scrollIntoView\(\{ block: 'center' \}\)/);
    const c = lire('src/components/to-process/ActionCard.tsx');
    expect(c).toMatch(/useState\(\(\) => getDraft\(action\.publicId\)\)/);
  });
});

describe('L107E-09 — charte, mobile, route', () => {
  it('jetons de couleur seulement, cible tactile 36 px en mobile, boutons natifs', () => {
    const src = lire('src/components/to-process/CardLinks.tsx');
    expect(src).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|\b(?:text|bg|border)-(?:red|blue|green|gray|slate|zinc|neutral)-\d{2,3}\b/i);
    expect(CARD_LINK_CLASS).toContain('min-h-9');
    expect(CARD_LINK_CLASS).toContain('sm:min-h-7');
    expect(src).toContain('type="button"');
  });

  it('route de revalidation : compte de la session, carte, liste fermée de destinations, lecture seule', () => {
    const r = lire('src/app/api/v2/to-process/[publicId]/links/route.ts');
    expect(r).toContain('SessionService.getSession');
    expect(r).toContain('session.currentAccountId');
    expect(r).toContain('checkCardLink(accountId, publicId');
    expect(r).not.toMatch(/resolveArbitration|upsertAction|UPDATE |INSERT /);
    const s = lire('src/services/to-process/card-links.ts');
    // Aucune recherche approximative au clic : pas de LIKE / ILIKE / similarité.
    expect(s).not.toMatch(/\bI?LIKE\b|similarity|levenshtein/i);
    // Aucune URL de stockage dans le contrat.
    expect(s).not.toMatch(/s3Key|signedUrl|getSignedUrl/);
  });
});
