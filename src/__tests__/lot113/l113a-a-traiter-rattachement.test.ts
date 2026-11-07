/**
 * Lot 113A (#692, régression P1) — « À traiter » : boutons des biens sur la
 * carte « À quel bien rattacher ce document ? ».
 *
 *   L113A-U-01 composition pure : candidats de l'analyse d'abord (confiance),
 *              puis les autres biens éligibles ; inéligibles écartés ; chaque
 *              bien une fois ; bien sans nom ; liste vide → EMPTY.
 *   L113A-U-02 périmètre : seules les cartes LINK-ASSET d'un document ;
 *              conflit, carte groupée, fournisseurs (113G) exclus.
 *   L113A-U-03 carte COMPLETE (cas observé) : boutons nommés des biens, AUCUN
 *              « Ouvrir » ni « Autre » ; vignette et « Voir le document »
 *              toujours présents.
 *   L113A-U-04 clic sur un bien → parcours commun (`onChoose`) avec
 *              l'identifiant du bien ; ni vignette ni lien ne choisissent.
 *   L113A-U-05 états explicites : vide (aucun bouton), erreur (seul
 *              « Réessayer », qui relit la file).
 *   L113A-U-06 plusieurs biens, mobile : passage à la ligne, libellés sur
 *              plusieurs lignes, zone tactile, aucune largeur fixe.
 *   L113A-U-07 non-régression : autres familles (arbitrage générique,
 *              intervention, saisie en ligne, COMPLETE sans choix) inchangées.
 *   L113A-U-08 messages : succès nommant le bien ; refus d'un bien devenu
 *              inéligible sans renvoi vers un « Autre » absent.
 *   L113A-U-09 câblage : la page demande les choix ; accueil et mascotte non ;
 *              le contrôle d'écriture refuse un bien archivé / verrouillé.
 *
 * Environnement `node`, sans DOM (convention du dépôt) : balisage par
 * `renderToStaticMarkup`, composant sans hook appelé comme une fonction.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import React, { createElement as h, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('sonner', () => ({ toast: Object.assign(() => {}, { info: () => {}, error: () => {}, success: () => {} }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));
vi.mock('@/db', () => ({ db: {}, pgClient: { unsafe: async () => [] } }));

(globalThis as { React?: typeof React }).React = React;

const { buildAssetLinkChoices, isAssetLinkChoiceCard } = await import('@/services/to-process/asset-link-choices');
const { ActionCard, PROPOSAL_BUTTON_CLASS } = await import('@/components/to-process/ActionCard');
const { AssetLinkChoices, ASSET_LINK_TEXT } = await import('@/components/to-process/AssetLinkChoices');
const { TO_PROCESS_SYNC_EVENT, resolutionToastText, ASSET_LINK_REFUSED_MESSAGE } = await import('@/components/to-process/useToProcessResolution');
const { resolveErrorMessage } = await import('@/lib/to-process-resolve-errors');

const lire = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');

type View = Parameters<typeof ActionCard>[0]['action'];
const THUMB = 'https://s3.example/derivatives/thumbnails/a_1/f_42/list-x.webp?X-Amz-Signature=1';
const carte = (over: Partial<View> = {}): View => ({
  publicId: 'c0ffee00-0113', targetType: 'DOCUMENT', targetId: 42, fieldKey: null, relationKey: 'assetIds',
  actionKind: 'COMPLETE', priority: 'DO_NEXT', ruleCode: 'LINK-ASSET', question: 'À quel bien rattacher ce document ?',
  proposals: [],
  target: { label: 'Certificat de garantie Electro DEMO — Lave-linge Bosch', thumbnailUrl: THUMB },
  links: {
    object: { kind: 'document', id: 42, label: 'Certificat de garantie Electro DEMO — Lave-linge Bosch' },
    objectUnavailable: null, related: [], documents: [], cardDocuments: [], proposals: [], unavailable: 0,
  } as unknown as View['links'],
  assetChoices: {
    status: 'OK',
    items: [
      { assetId: 3, label: 'Appartement Lyon', suggested: false },
      { assetId: 1, label: 'Maison', suggested: false },
      { assetId: 9, label: 'Peugeot 3008', suggested: false },
    ],
  },
  ...over,
});
const noop = () => {};
const rendu = (action: View, handlers: Partial<Parameters<typeof ActionCard>[0]> = {}) =>
  renderToStaticMarkup(h(ActionCard, { action, onChoose: noop, onOpenTarget: noop, visual: true, ...handlers }));
/** Libellés visibles des boutons (texte entre balises, sans attributs). */
const boutons = (html: string) => [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').trim());

function find(node: ReactNode, pred: (el: ReactElement<Record<string, unknown>>) => boolean, out: ReactElement<Record<string, unknown>>[] = []) {
  if (Array.isArray(node)) { node.forEach((n) => find(n, pred, out)); return out; }
  if (!isValidElement(node)) return out;
  const el = node as ReactElement<Record<string, unknown>>;
  if (pred(el)) out.push(el);
  find(el.props.children as ReactNode, pred, out);
  return out;
}

describe('L113A — composition des choix (serveur, pure)', () => {
  const eligibles = [
    { id: 3, name: 'Appartement Lyon' }, { id: 1, name: 'Maison' }, { id: 9, name: 'Peugeot 3008' }, { id: 4, name: '  ' },
  ];
  it('L113A-U-01 — candidats d’abord (confiance), puis les autres ; inéligibles écartés ; sans doublon ; bien sans nom', () => {
    const v = buildAssetLinkChoices([
      { value: 9, confidence: 0.4 },
      { value: '1', confidence: 0.7 },
      { value: 77, confidence: 0.9 }, // archivé / supprimé / autre compte : absent des éligibles
      { value: 9, confidence: 0.2 },
      { value: 3, confidence: 1, isCurrentValue: true },
    ], eligibles);
    expect(v.status).toBe('OK');
    expect(v.items.map((i) => [i.assetId, i.suggested])).toEqual([[1, true], [9, true], [3, false], [4, false]]);
    expect(v.items.find((i) => i.assetId === 4)!.label).not.toBe('');
    expect(buildAssetLinkChoices([{ value: 5, confidence: 1 }], [])).toEqual({ status: 'EMPTY', items: [] });
  });
  it('L113A-U-02 — périmètre : LINK-ASSET d’un document seulement', () => {
    expect(isAssetLinkChoiceCard({ ruleCode: 'LINK-ASSET', targetType: 'DOCUMENT', relationKey: 'assetIds' })).toBe(true);
    for (const ruleCode of ['LINK-ASSET-CONFLICT', 'LINK-ASSET-GROUP', 'LINK-ELT', 'SUPPLIER-IDENTITY', 'DATA-SUPPLIER', 'DOC-INTERVENTION', 'OPERATION-MATCH']) {
      expect(isAssetLinkChoiceCard({ ruleCode, targetType: 'DOCUMENT', relationKey: 'assetIds' }), ruleCode).toBe(false);
    }
    expect(isAssetLinkChoiceCard({ ruleCode: 'LINK-ASSET', targetType: 'ASSET', relationKey: 'assetIds' })).toBe(false);
  });
});

describe('L113A — carte « À quel bien rattacher ce document ? »', () => {
  let events: string[] = [];
  const g = globalThis as unknown as { window?: EventTarget };
  beforeEach(() => {
    events = [];
    const w = new EventTarget();
    w.addEventListener(TO_PROCESS_SYNC_EVENT, () => events.push(TO_PROCESS_SYNC_EVENT));
    g.window = w;
  });
  afterEach(() => { delete g.window; });

  it('L113A-U-03 — carte COMPLETE : boutons nommés, aucun « Ouvrir » ni « Autre », vignette et « Voir le document » présents', () => {
    const html = rendu(carte());
    const labels = boutons(html);
    expect(labels).toEqual(expect.arrayContaining(['Appartement Lyon', 'Maison', 'Peugeot 3008']));
    expect(labels).not.toContain('Ouvrir');
    expect(labels).not.toContain('Autre');
    expect(html).toContain('aria-label="Rattacher à Maison"');
    expect(html).toContain(`aria-label="${ASSET_LINK_TEXT.group}"`);
    expect(html).toContain('data-card-visual="thumbnail"');
    expect(html).toMatch(/data-link-kind="document"/);
    // Carte ARBITRATE (candidats) : idem, candidat en évidence.
    const arb = rendu(carte({
      actionKind: 'ARBITRATE', proposals: [{ value: 1, label: 'Maison' }],
      assetChoices: { status: 'OK', items: [{ assetId: 1, label: 'Maison', suggested: true }, { assetId: 3, label: 'Appartement Lyon', suggested: false }] },
    }));
    expect(boutons(arb)).not.toContain('Autre');
    expect(arb).toMatch(/data-asset-choice="1" data-suggested="true"/);
  });

  it('L113A-U-04 — clic sur un bien → onChoose(identifiant du bien) ; consultation sans choix', () => {
    const onChoose = vi.fn();
    const action = carte();
    const tree = AssetLinkChoices({ choices: action.assetChoices!, onPick: (c) => onChoose(action, { value: c.assetId, label: c.label }), onRetry: noop });
    const btns = find(tree, (el) => (el.props as { 'data-asset-choice'?: number })['data-asset-choice'] !== undefined);
    expect(btns).toHaveLength(3);
    (btns[1].props.onClick as () => void)();
    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(onChoose).toHaveBeenCalledWith(action, { value: 1, label: 'Maison' });
    // Câblage de la carte : `Controls` passe par `onChoose` (parcours commun) ; la vignette et les liens n'y touchent pas.
    const src = lire('src/components/to-process/ActionCard.tsx');
    expect(src).toMatch(/onPick=\{\(c\) => onChoose\(action, \{ value: c\.assetId, label: c\.label \}\)\}/);
    const vignette = src.slice(src.indexOf('export function DocumentPreviewButton'), src.indexOf('const isInterventionCard'));
    expect(vignette).not.toMatch(/onChoose/);
    expect(lire('src/components/to-process/CardLinks.tsx')).not.toMatch(/onChoose|\/resolve/);
  });

  it('L113A-U-05 — états explicites : vide sans bouton ; erreur avec « Réessayer » seul, qui relit la file', () => {
    const vide = rendu(carte({ assetChoices: { status: 'EMPTY', items: [] } }));
    expect(vide).toContain('data-asset-choices="empty"');
    expect(vide).toContain(ASSET_LINK_TEXT.empty.replace(/’/g, '’'));
    // Aucun bouton de BIEN ; seuls restent « Aucun » (lot 113V, #719 : l'absence de bien n'est pas
    // une anomalie, l'utilisateur peut la confirmer) et le lien de consultation (« Voir le document »).
    expect(boutons(vide).filter((b) => b !== '')).toEqual([ASSET_LINK_TEXT.none, 'Voir le document']);
    const err = rendu(carte({ assetChoices: { status: 'ERROR', items: [] } }));
    expect(err).toContain('role="alert"');
    expect(boutons(err).filter((b) => b !== '')).toEqual([ASSET_LINK_TEXT.retry, 'Voir le document']);
    const tree = AssetLinkChoices({ choices: { status: 'ERROR', items: [] }, onPick: noop, onRetry: () => window.dispatchEvent(new CustomEvent(TO_PROCESS_SYNC_EVENT)) });
    const [retry] = find(tree, (el) => typeof el.props.onClick === 'function');
    (retry.props.onClick as () => void)();
    expect(events).toEqual([TO_PROCESS_SYNC_EVENT]);
    expect(lire('src/components/to-process/ActionCard.tsx')).toMatch(/onRetry=\{notifyToProcessChanged\}/);
  });

  it('L113A-U-06 — plusieurs biens, mobile : passage à la ligne, libellés multi-lignes, aucune largeur fixe', () => {
    const items = Array.from({ length: 9 }, (_, i) => ({ assetId: i + 1, label: `Résidence secondaire numéro ${i + 1} — Chemin des Érables Fictifs`, suggested: i === 0 }));
    const html = rendu(carte({ assetChoices: { status: 'OK', items } }));
    const groupe = /data-asset-choices="ok"[^>]*class="([^"]*)"/.exec(html)?.[1] ?? '';
    expect(groupe.split(' ')).toEqual(expect.arrayContaining(['flex-wrap', 'max-w-full', 'min-w-0']));
    expect(boutons(html).filter((b) => b.startsWith('Résidence'))).toHaveLength(9);
    for (const cls of PROPOSAL_BUTTON_CLASS.split(' ')) expect(html).toContain(cls);
    expect(PROPOSAL_BUTTON_CLASS).toMatch(/whitespace-normal/);
    expect(PROPOSAL_BUTTON_CLASS).toMatch(/min-h-9/);
    const comp = lire('src/components/to-process/AssetLinkChoices.tsx');
    expect(comp).not.toMatch(/\bw-\[\d|min-w-\[\d|whitespace-nowrap|truncate/);
  });

  it('L113A-U-07 — non-régression des autres familles', () => {
    // Arbitrage générique : propositions + « Autre ».
    const gen = boutons(rendu(carte({ ruleCode: 'DOC-TYP', relationKey: null, fieldKey: 'documentTypeCode', actionKind: 'ARBITRATE', assetChoices: undefined, proposals: [{ value: 'FACTURE', label: 'Facture' }] })));
    expect(gen).toEqual(expect.arrayContaining(['Facture', 'Autre']));
    // Intervention : « Ouvrir ».
    const inter = boutons(rendu(carte({ ruleCode: 'DOC-INTERVENTION', relationKey: null, fieldKey: 'intervention', actionKind: 'ARBITRATE', assetChoices: undefined, proposals: [{ value: 'DONE', label: 'C’est fait' }] })));
    expect(inter).toEqual(expect.arrayContaining(['C’est fait', 'Ouvrir']));
    // Saisie en ligne : « Valider » + « Ouvrir ».
    const date = boutons(rendu(carte({ ruleCode: 'DATA-WARRANTY-END', relationKey: null, fieldKey: 'warrantyEndDate', inputType: 'date', assetChoices: undefined })));
    expect(date).toEqual(expect.arrayContaining(['Valider', 'Ouvrir']));
    // Carte LINK-ASSET reçue SANS choix (accueil, mascotte) : comportement antérieur.
    expect(boutons(rendu(carte({ assetChoices: undefined })))).toContain('Ouvrir');
  });

  it('L113A-U-08 — messages : succès nommant le bien ; refus sans « Autre »', () => {
    expect(resolutionToastText(carte(), { label: 'Maison' })).toBe('Document rattaché à « Maison »');
    expect(resolutionToastText({ assetChoices: undefined }, { label: '12/03/2027' })).toBe('Valeur mise à jour');
    expect(ASSET_LINK_REFUSED_MESSAGE).not.toMatch(/Autre/);
    expect(resolveErrorMessage('INVALID_VALUE')).toMatch(/Autre/); // message générique inchangé pour les autres cartes
    const hook = lire('src/components/to-process/useToProcessResolution.ts');
    expect(hook).toMatch(/action\.assetChoices && code === 'INVALID_VALUE'/);
  });

  it('L113A-U-09 — câblage : page avec choix, accueil / mascotte sans ; écriture refusée pour un bien archivé ou verrouillé', () => {
    expect(lire('src/app/api/v2/to-process/route.ts')).toMatch(/withAssetChoices: true/);
    expect(lire('src/services/home/HomeSummaryService.ts')).not.toMatch(/withAssetChoices/);
    expect(lire('src/services/home/mascot/collector.ts')).not.toMatch(/withAssetChoices/);
    const q = lire('src/services/to-process/to-process-query.service.ts');
    expect(q).toMatch(/options\.withAssetChoices \? rows\.filter\(\(row\) => isAssetLinkChoiceCard\(row\)\) : \[\]/);
    const slots = lire('src/services/to-process/document-slots.ts');
    const check = slots.slice(slots.indexOf('export const ASSET_LINK_SLOT'), slots.indexOf('async read(client, accountId, fileId)', slots.indexOf('export const ASSET_LINK_SLOT')));
    expect(check).toMatch(/assetWritableOfAccount/);
    expect(slots).toMatch(/IS DISTINCT FROM 'ARCHIVED'/);
    // Écriture automatique (T3) inchangée.
    const debut = slots.indexOf('export const ASSET_LINK_SLOT');
    const auto = slots.slice(slots.indexOf('async writeAuto', debut), slots.indexOf('async writeUser', debut));
    expect(auto).toMatch(/assetOfAccount\(/);
    // Aucun second moteur : pas d'autre route ni d'écriture dans le composant.
    expect(lire('src/components/to-process/AssetLinkChoices.tsx')).not.toMatch(/apiClient|fetch\(|['`]\/api\//);
  });
});
