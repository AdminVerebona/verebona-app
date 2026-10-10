/**
 * Ticket « Mascotte : simplifier la hiérarchie des À traiter et ouvrir
 * directement l'action utile » (lot 32) — critères d'acceptation MASC2-AC01
 * à MASC2-AC12, et contrat de navigation.
 *
 * Parties pures (contrat, bulle) et structure des écrans (sources). Le
 * parcours sur base réelle (même source que la file, synchronisation après
 * résolution, compteur) : `l32-a-traiter-mascotte.e2e.ts`.
 *
 * Lot 34 (MASC3) : la mascotte n'affiche plus que les DO_FIRST, au plus
 * deux, et compte les éléments affichés (jamais le total de la file) —
 * les exemples ci-dessous sont donc en DO_FIRST ; voir aussi
 * `src/__tests__/lot34/masc3-mascotte-do-first.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { ToProcessActionView } from '@/services/to-process/to-process-query.service';
import { buildTodoBlock, todoActionType, todoItemFrom, todoTitle, MAX_TODO_ITEMS } from '@/services/home/mascot/todo-items';
import { buildCandidates, type MascotRawData } from '@/services/home/mascot/signals';
import { buildSecondaries, selectSubjects } from '@/services/home/mascot/selector';
import { buildPresentation } from '@/services/home/mascot/presentation';
import { EMPTY_ACCOUNT_STATE, suggestionsForRoute } from '@/services/verebona-assistant/registries/capability-registry';
import {
  composeSpeech, homeItems, homePose, homeSuggestions, secondaryActions, todoSummary,
} from '@/services/home/mascot/bubble';
import type { MascotPresentation } from '@/services/home/mascot/types';

const lire = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');
const MASCOTTE = () => lire('src/components/home/MascotSpeaks.tsx');
const FILE = () => lire('src/components/to-process/ToProcessQueue.tsx');

let n = 0;
function atp(over: Partial<ToProcessActionView> = {}): ToProcessActionView {
  n += 1;
  return {
    publicId: `0000000${n}-aaaa-bbbb-cccc-dddddddddddd`, targetType: 'DOCUMENT', targetId: 100 + n, fieldKey: 'documentTypeCode', relationKey: null,
    actionKind: 'COMPLETE', priority: 'DO_FIRST', ruleCode: 'DOC-TYP',
    question: 'Quel est le type de ce document ?', proposals: [], allowNotApplicable: false,
    activeSince: '2026-09-20T10:00:00Z',
    target: { label: `Facture d’électricité EDF – 14/03/2024 (${n})`, publicId: `doc-${n}`, assetId: 1, assetName: 'Maison' },
    ...over,
  };
}

/** Les trois exemples du ticket. */
const immat = () => atp({
  targetType: 'ASSET', targetId: 9, fieldKey: 'registrationNumber', actionKind: 'ARBITRATE', ruleCode: 'DATA-REGISTRATION',
  question: 'Quel est le numéro d’immatriculation de ce bien ?',
  proposals: [{ value: 'AB-123-CD', label: 'AB-123-CD', confidence: 0.6 }, { value: 'AB-123-CE', label: 'AB-123-CE', confidence: 1, isCurrentValue: true }],
  target: { label: 'Vélo Jean Fourche', assetId: 9, assetName: 'Vélo Jean Fourche', publicId: 'asset-9' },
});
const rattacher = () => atp({
  fieldKey: null, relationKey: 'assetIds', actionKind: 'ARBITRATE', ruleCode: 'LINK-ASSET',
  question: 'À quel bien rattacher ce document ?',
  proposals: [{ value: 3, label: 'Cupra', confidence: 0.6 }, { value: 4, label: 'Clio', confidence: 0.5 }],
  target: { label: 'Offre client véhicule neuf – Cupra', assetId: null, assetName: null },
});
const completer = () => atp({ ruleCode: 'DATA-CONTRACT-END', fieldKey: 'contractEndDate', actionKind: 'COMPLETE', inputType: 'date' });

function raw(toProcess: ToProcessActionView[] | null, over: Partial<MascotRawData> = {}): MascotRawData {
  return {
    accountId: 7, today: '2026-10-07',
    processing: { uploads: [], analyses: [], exports: [] },
    onboarding: { activeAssets: [{ id: 1, name: 'Maison' }, { id: 2, name: 'Polo' }], activeAssetCount: 2, documentCount: 12 },
    toProcess, toProcessTotal: toProcess?.length ?? null, agenda: [], acknowledgments: [],
    ...over,
  };
}

function present(r: MascotRawData): MascotPresentation {
  const c = buildCandidates(r);
  const subjects = selectSubjects(c.candidates);
  // Lot 34 : questions du catalogue unique — des « À traiter » en attente,
  // rien de daté pour aujourd'hui.
  const questions = suggestionsForRoute('/accueil', {
    state: { ...EMPTY_ACCOUNT_STATE, assetsTotal: 1, documentsTotal: 1, toProcessPending: r.toProcess?.length ?? 0 },
  });
  return buildPresentation({
    subjects, secondaries: buildSecondaries(c, subjects, questions), degraded: c.degraded, messages: null,
    todo: buildTodoBlock(r.toProcess, r.toProcessTotal),
  });
}

describe('contrat de navigation (MASC2)', () => {
  it('MASC2-CONTRAT — todoId, todoType, entityType, entityId, actionType ; availableChoices, targetField, documentId, assetId', () => {
    const a = todoItemFrom(immat());
    expect(a).toMatchObject({
      todoType: 'DATA-REGISTRATION', entityType: 'ASSET', entityId: 9, actionType: 'OPEN_CHOICES',
      targetField: 'registrationNumber', documentId: null, assetId: 9,
      availableChoices: [{ value: 'AB-123-CD', label: 'AB-123-CD' }, { value: 'AB-123-CE', label: 'AB-123-CE', isCurrentValue: true }],
    });
    expect(a.todoId).toBe(a.card.publicId);
    const b = todoItemFrom(rattacher());
    expect(b).toMatchObject({ entityType: 'DOCUMENT', documentId: b.entityId, targetField: 'assetIds', actionType: 'OPEN_CHOICES', cta: 'Choisir le bien' });
    const c = todoItemFrom(completer());
    expect(c.actionType).toBe('OPEN_TODO_CARD');
    expect(c.availableChoices).toBeUndefined();
    // Les preuves et scores ne quittent pas le serveur.
    expect(JSON.stringify(a)).not.toMatch(/confidence|evidenceIds/);
  });

  it('MASC2-CONTRAT — libellés homogènes (exemples du ticket)', () => {
    expect(todoItemFrom(immat())).toMatchObject({ title: 'Numéro d’immatriculation à vérifier', subtitle: 'Vélo Jean Fourche', cta: 'Vérifier' });
    expect(todoItemFrom(rattacher())).toMatchObject({ title: 'Document à rattacher à un bien', subtitle: 'Offre client véhicule neuf – Cupra' });
    expect(todoItemFrom(completer())).toMatchObject({ title: 'Date de fin de contrat à compléter', cta: 'Compléter' });
    expect(todoTitle('REGLE-INCONNUE', 'COMPLETE')).toBe('Information à compléter');
  });
});

describe('critères d’acceptation (MASC2)', () => {
  it('MASC2-AC01 — deux niveaux seulement : une synthèse + des éléments d’action', () => {
    const p = present(raw([immat(), rattacher(), completer()]));
    const speech = composeSpeech({ presentation: p, empty: false });
    // MASC3 : au plus deux DO_FIRST affichés, la phrase compte les affichés.
    expect(speech.text).toBe('Deux sujets nécessitent votre attention aujourd’hui.');
    const items = homeItems(p, false);
    expect(items.map((i) => i.kind)).toEqual(['todo', 'todo']);
    // Aucune autre liste d'actions : pas de secondaire « recommandation » issu de la file.
    expect(p.secondaries.filter((s) => s.sourceCode.startsWith('ATP-'))).toEqual([]);
  });

  it('MASC2-AC02 — la synthèse ne répète pas les sujets (« Cela concerne… » disparu)', () => {
    const p = present(raw([immat(), rattacher()]));
    const t = composeSpeech({ presentation: p, empty: false }).text;
    expect(t).toBe('Deux sujets nécessitent votre attention aujourd’hui.');
    expect(t).not.toMatch(/immatriculation|rattacher|Cela concerne/);
    expect(todoSummary(1)).toBe('Un sujet nécessite votre attention aujourd’hui.');
    // MASC3 : 0 affiché → aucune phrase sur les « À traiter ».
    expect(todoSummary(0)).toBe('');
  });

  it('MASC2-AC03 — les pastilles « Compléter “…” » / « Choisir “…” » (3e niveau) ont disparu', () => {
    const p = present(raw([immat(), rattacher(), completer(), atp(), atp()]));
    expect(secondaryActions(p, false).some((s) => /^(Compléter|Choisir) «/.test(s.action.label))).toBe(false);
    const src = MASCOTTE();
    expect(src).not.toContain('Autres suggestions');
    expect(src).not.toContain('autresActions');
  });

  it('MASC2-AC04 — chaque « À traiter » affiché possède une action explicite', () => {
    const items = homeItems(present(raw([immat(), rattacher(), completer()])), false);
    for (const i of items) {
      expect(i.cta).toBeTruthy();
      if (i.kind === 'todo') expect(['OPEN_CHOICES', 'OPEN_TODO_CARD']).toContain(i.todo.actionType);
    }
  });

  it('MASC2-AC05 — un clic ne conduit jamais simplement en haut de la page « À traiter »', () => {
    const src = MASCOTTE();
    expect(src).toContain('router.push(todoCardHref(t.todoId))');
    expect(src).toMatch(/return `\/accueil\/a-traiter\?todo=\$\{encodeURIComponent\(todoId\)\}`/);
    // La file amène la carte ciblée à l'écran et y pose le focus.
    const file = FILE();
    expect(file).toContain("scrollIntoView({ block: 'center'");
    expect(file).toContain(".focus({ preventScroll: true })");
  });

  it('MASC2-AC06 — liste de choix exploitable : ouverte directement (composant de la file)', () => {
    expect(todoActionType({ actionKind: 'ARBITRATE', proposals: immat().proposals })).toBe('OPEN_CHOICES');
    const src = MASCOTTE();
    expect(src).toMatch(/t\.actionType === 'OPEN_CHOICES'[\s\S]{0,80}setChoices\(t\)/);
    const dlg = lire('src/components/home/TodoChoicesDialog.tsx');
    expect(dlg).toContain('<ActionCard');
    expect(dlg).toContain('useToProcessResolution(');
  });

  it('MASC2-AC07 — carte complète nécessaire : la bonne carte est ouverte, dépliée et mise en évidence', () => {
    expect(todoItemFrom(completer()).actionType).toBe('OPEN_TODO_CARD');
    expect(todoItemFrom(atp({ actionKind: 'ARBITRATE', proposals: [] })).actionType).toBe('OPEN_TODO_CARD');
    const file = FILE();
    expect(file).toContain('focused={focusId === action.publicId}');
    expect(lire('src/components/to-process/ActionCard.tsx')).toContain('id={todoCardDomId(action.publicId)}');
  });

  it('MASC2-AC08 — ciblage par l’ID du « À traiter », jamais par son titre ou son libellé', () => {
    const a = atp({ question: 'Même question ?' });
    const b = atp({ question: 'Même question ?' });
    const items = buildTodoBlock([a, b], 2)!.items;
    expect(items.map((i) => i.todoId)).toEqual([a.publicId, b.publicId]);
    const file = FILE();
    expect(file).toContain('page.actions.some((a) => a.publicId === id)');
    expect(file).not.toMatch(/question\s*===|label\s*===/);
  });

  it('MASC2-AC09 — un seul choix ne génère pas de sélecteur (carte ouverte, valeur proposée, rien d’appliqué)', () => {
    const un = todoItemFrom(atp({ actionKind: 'ARBITRATE', proposals: [{ value: 'RK469970GP', label: 'RK469970GP', confidence: 0.6 }] }));
    expect(un.actionType).toBe('OPEN_TODO_CARD');
    expect(un.availableChoices).toBeUndefined();
    expect(un.card.proposals).toEqual([{ value: 'RK469970GP', label: 'RK469970GP' }]);
    // Garde côté écran : un sélecteur n'est ouvert qu'avec au moins deux choix.
    expect(MASCOTTE()).toContain("(t.availableChoices?.length ?? 0) >= 2");
  });

  it('MASC2-AC10 — après résolution : élément retiré aussitôt, puis mascotte, file et compteur relus', () => {
    const src = MASCOTTE();
    expect(src).toContain('onRemoved={(id) => setHidden((h) => new Set(h).add(id))}');
    const res = lire('src/components/to-process/useToProcessResolution.ts');
    expect(res).toContain("TO_PROCESS_SYNC_EVENT = 'refresh-a-traiter'");
    expect(res).toMatch(/onResolved\?\.\(action\);\s*notifyToProcessChanged\(\);/);
    expect(lire('src/components/home/useMascotPresentation.ts')).toContain("'refresh-a-traiter'");
    expect(lire('src/hooks/useToProcessCount.ts')).toContain("'refresh-a-traiter'");
    // Une action résolue change l'empreinte : la bulle accepte la nouvelle présentation.
    const avant = present(raw([immat(), rattacher()]));
    const apres = present(raw([rattacher()]));
    expect(apres.contextHash).not.toBe(avant.contextHash);
  });

  it('MASC2-AC11 — fonctionnement identique desktop et mobile (un seul composant, aucun parcours par écran)', () => {
    const src = MASCOTTE();
    expect(src).toContain('function ItemButton(');
    // Les éléments ne sont jamais masqués selon la largeur ; l'appel à l'action reste visible.
    expect(src).not.toMatch(/items\.map[\s\S]{0,200}md:hidden/);
    expect(src).not.toMatch(/\{cta && <span className="hidden/);
  });

  it('MASC2-AC12 — « Ou demandez-moi » reste indépendant de la file et secondaire, sous les actions', () => {
    const p = present(raw([immat()]));
    const s = homeSuggestions(p, false, ['Comment ajouter un document ?']);
    expect(s.every((x) => !x.secondary || x.secondary.action.target.kind === 'ask')).toBe(true);
    // Lot 34 : « Que dois-je traiter en priorité ? » (ACCOUNT_TO_PROCESS) —
    // jamais « Que dois-je faire aujourd’hui ? » sur la seule file À traiter.
    expect(s.map((x) => x.label)).toContain('Que dois-je traiter en priorité ?');
    expect(s.map((x) => x.label)).not.toContain('Que dois-je faire aujourd’hui ?');
    const src = MASCOTTE();
    expect(src.indexOf('aria-label="Sujets à traiter"')).toBeLessThan(src.indexOf('aria-label="Ou demandez-moi"'));
  });
});

describe('bulle (MASC2)', () => {
  it('MASC2/MASC3 — au plus 2 « À traiter » affichés ; le reste n’est plus annoncé ; pose de vérification', () => {
    const actions = [immat(), rattacher(), completer(), atp(), atp()];
    const p = present(raw(actions));
    expect(MAX_TODO_ITEMS).toBe(2);
    expect(p.todo?.items).toHaveLength(MAX_TODO_ITEMS);
    expect(MASCOTTE()).not.toMatch(/autres? sujets? dans « À traiter »/);
    expect(homePose(p, false)).toBe('questioning');
    expect(p.status).toBe('ok');
  });

  it('MASC2 — sans « À traiter » : synthèse historique inchangée (échéance seule)', () => {
    const p = present(raw([], { agenda: [{ id: 1, title: 'Ramonage', date: '2026-10-15', forecast: false, requiresQualification: false, assetId: 1, assetName: 'Maison' }] }));
    expect(composeSpeech({ presentation: p, empty: false }).text).toMatch(/^Tout est à jour\. Votre prochaine échéance/);
    expect(homeItems(p, false).map((i) => i.kind)).toEqual(['subject']);
  });
});
