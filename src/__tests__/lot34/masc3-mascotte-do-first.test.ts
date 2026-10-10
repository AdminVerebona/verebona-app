/**
 * Lot 34 — Mascotte : n'afficher que les « À faire en premier » (DO_FIRST),
 * au plus deux, et ne compter que les éléments affichés (MASC3-01…08).
 *
 * Règles : filtre `priority === 'DO_FIRST'` AVANT la limite (jamais de
 * remplissage par DO_NEXT / CAN_WAIT) ; phrase de niveau 1 : 0 → aucune,
 * 1 → « Un sujet… », 2 → « Deux sujets… » ; plus de « N autres sujets dans
 * « À traiter » » ; les autres sujets (échéances…) restent indépendants.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { ToProcessActionView } from '@/services/to-process/to-process-query.service';
import type { ActionPriority } from '@/services/to-process/action-model';
import { buildTodoBlock, MAX_TODO_ITEMS } from '@/services/home/mascot/todo-items';
import { buildCandidates, type MascotRawData } from '@/services/home/mascot/signals';
import { buildSecondaries, selectSubjects } from '@/services/home/mascot/selector';
import { buildPresentation } from '@/services/home/mascot/presentation';
import { composeSpeech, homeItems, NOTHING_URGENT } from '@/services/home/mascot/bubble';
import type { MascotPresentation } from '@/services/home/mascot/types';

let n = 0;
function atp(priority: ActionPriority): ToProcessActionView {
  n += 1;
  return {
    publicId: `${String(n).padStart(8, '0')}-aaaa-bbbb-cccc-dddddddddddd`, targetType: 'DOCUMENT', targetId: 100 + n,
    fieldKey: 'documentTypeCode', relationKey: null, actionKind: 'COMPLETE', priority, ruleCode: 'DOC-TYP',
    question: 'Quel est le type de ce document ?', proposals: [], allowNotApplicable: false,
    activeSince: '2026-09-20T10:00:00Z',
    target: { label: `Document ${n}`, publicId: `doc-${n}`, assetId: 1, assetName: 'Maison' },
  };
}
const many = (count: number, p: ActionPriority) => Array.from({ length: count }, () => atp(p));

function raw(toProcess: ToProcessActionView[], over: Partial<MascotRawData> = {}): MascotRawData {
  return {
    accountId: 7, today: '2026-10-09',
    processing: { uploads: [], analyses: [], exports: [] },
    onboarding: { activeAssets: [{ id: 1, name: 'Maison' }], activeAssetCount: 1, documentCount: 12 },
    toProcess, toProcessTotal: toProcess.length, agenda: [], acknowledgments: [],
    ...over,
  };
}

function present(r: MascotRawData): MascotPresentation {
  const c = buildCandidates(r);
  const subjects = selectSubjects(c.candidates);
  return buildPresentation({
    subjects, secondaries: buildSecondaries(c, subjects), degraded: c.degraded, messages: null,
    todo: buildTodoBlock(r.toProcess, r.toProcessTotal),
  });
}

const todos = (p: MascotPresentation) => homeItems(p, false).filter((i) => i.kind === 'todo');
const speech = (p: MascotPresentation) => composeSpeech({ presentation: p, empty: false }).text;
const MENTION_TODO = /sujets? nécessitent?|À traiter/;

describe('Mascotte — DO_FIRST seulement, au plus deux (MASC3)', () => {
  it('MASC3-01 — 3 DO_FIRST → 2 affichés, « Deux sujets… »', () => {
    const p = present(raw(many(3, 'DO_FIRST')));
    expect(MAX_TODO_ITEMS).toBe(2);
    expect(todos(p)).toHaveLength(2);
    expect(speech(p)).toBe('Deux sujets nécessitent votre attention aujourd’hui.');
  });

  it('MASC3-02 — 2 DO_FIRST + 10 DO_NEXT → 2 (les DO_FIRST)', () => {
    const p = present(raw([...many(2, 'DO_FIRST'), ...many(10, 'DO_NEXT')]));
    expect(todos(p).map((i) => i.kind === 'todo' && i.todo.priority)).toEqual(['DO_FIRST', 'DO_FIRST']);
    expect(speech(p)).toBe('Deux sujets nécessitent votre attention aujourd’hui.');
  });

  it('MASC3-03 — 1 DO_FIRST + 10 DO_NEXT → 1, jamais complété par un DO_NEXT', () => {
    // Même si la file n'est pas triée par priorité : le filtre précède la limite.
    const p = present(raw([...many(5, 'DO_NEXT'), atp('DO_FIRST'), ...many(5, 'DO_NEXT')]));
    expect(todos(p)).toHaveLength(1);
    expect(p.todo?.items.every((i) => i.priority === 'DO_FIRST')).toBe(true);
    expect(speech(p)).toBe('Un sujet nécessite votre attention aujourd’hui.');
  });

  it('MASC3-04 — 0 DO_FIRST + 10 DO_NEXT → 0, aucune phrase sur les « À traiter »', () => {
    const p = present(raw(many(10, 'DO_NEXT')));
    expect(todos(p)).toHaveLength(0);
    expect(speech(p)).not.toMatch(MENTION_TODO);
    expect(speech(p)).not.toMatch(/10|Dix/);
    // Jamais « Tout est à jour » alors que la file n'est pas vide.
    expect(speech(p)).toBe(NOTHING_URGENT);
  });

  it('MASC3-05 — 0 DO_FIRST + 10 CAN_WAIT → 0', () => {
    const p = present(raw(many(10, 'CAN_WAIT')));
    expect(todos(p)).toHaveLength(0);
    expect(speech(p)).not.toMatch(MENTION_TODO);
  });

  it('MASC3-06 — 5 DO_FIRST + une échéance → 2 « À traiter » + l’échéance (indépendante de la limite)', () => {
    const p = present(raw(many(5, 'DO_FIRST'), {
      agenda: [{ id: 1, title: 'Ramonage', date: '2026-10-15', forecast: false, requiresQualification: false, assetId: 1, assetName: 'Maison' }],
    }));
    expect(homeItems(p, false).map((i) => i.kind)).toEqual(['todo', 'todo', 'subject']);
    const t = speech(p);
    expect(t.startsWith('Deux sujets nécessitent votre attention aujourd’hui.')).toBe(true);
    expect(t).toMatch(/échéance/);
  });

  it('MASC3-07 — 25 actions dont 2 DO_FIRST → « Deux sujets… », jamais « 25 »', () => {
    const file = [...many(10, 'DO_NEXT'), ...many(2, 'DO_FIRST'), ...many(13, 'CAN_WAIT')];
    const p = present(raw(file));
    expect(p.todo?.total).toBe(25); // total de la file conservé, jamais affiché
    expect(todos(p)).toHaveLength(2);
    expect(speech(p)).toBe('Deux sujets nécessitent votre attention aujourd’hui.');
    expect(speech(p)).not.toMatch(/25|Vingt/);
  });

  it('MASC3-08 — 25 actions dont 0 DO_FIRST → aucune mention des 25', () => {
    const p = present(raw([...many(12, 'DO_NEXT'), ...many(13, 'CAN_WAIT')]));
    expect(todos(p)).toHaveLength(0);
    expect(speech(p)).not.toMatch(/25|Vingt/);
    expect(speech(p)).not.toMatch(MENTION_TODO);
    // L'écran n'annonce plus « N autres sujets dans « À traiter » ».
    const src = readFileSync(join(process.cwd(), 'src/components/home/MascotSpeaks.tsx'), 'utf8');
    expect(src).not.toMatch(/autres? sujets? dans « À traiter »/);
    expect(src).not.toContain('todoRemaining');
  });
});
