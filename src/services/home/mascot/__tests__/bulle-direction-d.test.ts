/**
 * La mascotte parle — Direction D v2 §3.2, §12ter.
 *
 * Phrase naturelle à partir des sujets du moteur, tuiles d'action (au plus
 * 2, sévérité, bien · statut), pose, suggestions. Les sujets viennent du
 * moteur réel (`buildCandidates` → `selectSubjects` → `buildPresentation`).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { buildCandidates, type MascotRawData } from '../signals';
import { buildSecondaries, selectSubjects } from '../selector';
import { buildPresentation } from '../presentation';
import type { MascotParagraph, MascotPresentation, MascotSubject } from '../types';
import {
  CLEAR_SPEECH, EMPTY_ACCOUNT_SPEECH, homePoseLabel, EMPTY_ACCOUNT_SUGGESTIONS, actionTiles, composeSpeech, displayedSecondaries, homePose,
  homeSuggestions, lowerFirst, secondaryActions, splitHighlights, tileFor,
} from '../bubble';

const TODAY = '2026-09-21';

const presentationOf = (p: Partial<MascotPresentation> & { paragraphs: MascotParagraph[] }): MascotPresentation => ({
  schemaVersion: 'mascot-presentation-v1', status: 'ok', source: 'fallback', contextHash: 'h',
  secondaries: [], degradedNotice: null, computedAt: '2026-09-21T08:00:00Z', ...p,
});

const para = (text: string, tile: MascotParagraph['tile'], extra: Partial<MascotParagraph> = {}): MascotParagraph => ({
  subjectId: text, sourceCode: 'ATP-X', occurrenceKey: text, text, highlight: null,
  actions: [{ actionId: `${text}:a`, label: 'Voir', target: { kind: 'route', href: '/x' } }], tile, ...extra,
});

const ambre = { tone: 'amber' as const, icon: 'circle-alert' as const, label: 'Vérifier l’information', assetName: 'Ferrari Testarossa', status: 'À vérifier', attention: true };
const rouge = { tone: 'red' as const, icon: 'clock' as const, label: 'Reporter ou marquer fait', assetName: 'Vélo Cargo', status: 'En retard (2 j)', attention: true };
const info = { tone: 'blue' as const, icon: 'calendar-days' as const, label: 'Voir l’échéance', assetName: 'Ferrari Testarossa', status: 'Le 12 octobre 2026', attention: false };

describe('phrase en langage naturel (§3.2)', () => {
  it('deux sujets : « Deux sujets méritent… : a, et b. »', () => {
    const s = composeSpeech({
      empty: false,
      presentation: presentationOf({ paragraphs: [
        para('Deux documents indiquent des immatriculations différentes pour votre Ferrari Testarossa.', ambre),
        para('La révision annuelle du Vélo Cargo est en retard de 2 jours.', rouge),
      ] }),
    });
    expect(s.text).toBe('Deux sujets méritent votre attention aujourd’hui : deux documents indiquent des immatriculations différentes pour votre Ferrari Testarossa, et la révision annuelle du Vélo Cargo est en retard de 2 jours.');
  });

  it('un sujet : « Un sujet mérite… : a. »', () => {
    const s = composeSpeech({ empty: false, presentation: presentationOf({ paragraphs: [para('Votre assurance expire demain.', ambre)] }) });
    expect(s.text).toBe('Un sujet mérite votre attention aujourd’hui : votre assurance expire demain.');
  });

  it('zéro sujet : « Tout est à jour. … »', () => {
    const clear = presentationOf({ status: 'clear', paragraphs: [{ subjectId: 'CLEAR', sourceCode: 'CLEAR', occurrenceKey: 'CLEAR', text: 'Tout est à jour pour le moment.', highlight: null, actions: [] }] });
    expect(composeSpeech({ empty: false, presentation: clear }).text).toBe(CLEAR_SPEECH);
  });

  it('un sujet seulement informatif suit « Tout est à jour. »', () => {
    const s = composeSpeech({ empty: false, presentation: presentationOf({ paragraphs: [para('Votre prochaine échéance concerne Ferrari : CT, le 12 octobre 2026.', info)] }) });
    expect(s.text).toBe('Tout est à jour. Votre prochaine échéance concerne Ferrari : CT, le 12 octobre 2026.');
  });

  it('textes de plusieurs phrases : juxtaposés, jamais enchaînés après « : »', () => {
    const s = composeSpeech({ empty: false, presentation: presentationOf({ paragraphs: [para('Quelle date retenir ? Cela concerne « Bail » (Maison).', ambre)] }) });
    expect(s.text).toBe('Un sujet mérite votre attention aujourd’hui. Quelle date retenir ? Cela concerne « Bail » (Maison).');
  });

  it('compte vide et discours indisponible', () => {
    expect(composeSpeech({ empty: true, presentation: null }).text).toBe(EMPTY_ACCOUNT_SPEECH);
    expect(composeSpeech({ empty: false, presentation: null, failed: true }).text).toMatch(/n’ont pas pu être actualisées/);
    expect(composeSpeech({ empty: false, presentation: presentationOf({ status: 'degraded', paragraphs: [] }) }).text).toMatch(/n’ont pas pu être actualisées/);
  });

  it('minuscule initiale seulement pour un mot courant (jamais un nom propre)', () => {
    expect(lowerFirst('Votre Ferrari')).toBe('votre Ferrari');
    expect(lowerFirst('L’échéance du bail')).toBe('l’échéance du bail');
    expect(lowerFirst('Ferrari Testarossa a…')).toBe('Ferrari Testarossa a…');
    expect(lowerFirst('CT à refaire')).toBe('CT à refaire');
  });

  it('segments mis en valeur, dans l’ordre du texte', () => {
    expect(splitHighlights('a Ferrari b Vélo c', ['Vélo', 'Ferrari'])).toEqual([
      { text: 'a ', strong: false }, { text: 'Ferrari', strong: true }, { text: ' b ', strong: false },
      { text: 'Vélo', strong: true }, { text: ' c', strong: false },
    ]);
  });
});

describe('tuiles d’action (§3.2)', () => {
  const subject = (s: Partial<MascotSubject>): MascotSubject => ({
    subjectId: 's', sourceFamily: 'TO_PROCESS', sourceCode: 'ATP-X', accountId: 1, priority: null, requiresAttention: true,
    intent: 'act', facts: {}, actions: [], fallbackText: '', allowedHighlight: null, occurrenceKey: 's', dedupeKeys: [],
    secondaryLabel: '', ...s,
  });

  it('nature du sujet pour la pose : vérifier, compléter, retard, échéance', () => {
    expect(tileFor(subject({ sourceCode: 'ATP-CONFLICT', facts: { actionKind: 'arbitrage' } }), TODAY).kind).toBe('verify');
    expect(tileFor(subject({ sourceCode: 'ATP-MISSING', facts: { actionKind: 'complément' } }), TODAY).kind).toBe('action');
    expect(tileFor(subject({ sourceCode: 'MASC-EXT-ACTION', facts: { date: '2026-09-19' } }), TODAY).kind).toBe('overdue');
    expect(tileFor(subject({ sourceCode: 'MASC-EXT-ACTION', facts: { date: TODAY } }), TODAY).kind).toBe('action');
    expect(tileFor(subject({ sourceCode: 'DATE-NEXT', requiresAttention: false, facts: {} }), TODAY).kind).toBe('info');
  });

  it('sévérité : amber à vérifier, rouge en retard (jours), bleu pour une échéance', () => {
    expect(tileFor(subject({ sourceCode: 'ATP-CONFLICT', facts: { actionKind: 'arbitrage' }, assetName: 'Ferrari Testarossa' }), TODAY))
      .toMatchObject({ tone: 'amber', label: 'Vérifier l’information', status: 'À vérifier', assetName: 'Ferrari Testarossa', attention: true });
    expect(tileFor(subject({ sourceCode: 'MASC-EXT-ACTION', facts: { date: '2026-09-19' }, assetName: 'Vélo Cargo' }), TODAY))
      .toMatchObject({ tone: 'red', icon: 'clock', label: 'Reporter ou marquer fait', status: 'En retard (2 j)' });
    expect(tileFor(subject({ sourceCode: 'MASC-EXT-ACTION', facts: { date: TODAY } }), TODAY))
      .toMatchObject({ tone: 'amber', status: 'Aujourd’hui' });
    expect(tileFor(subject({ sourceCode: 'DATE-NEXT', requiresAttention: false, facts: { dateLabel: '12 octobre 2026', dateNature: 'confirmée' } }), TODAY))
      .toMatchObject({ tone: 'blue', attention: false, status: 'Le 12 octobre 2026' });
  });

  it('au plus 2 tuiles, sous-ligne « bien · statut »', () => {
    const p = presentationOf({ paragraphs: [para('a.', ambre), para('b.', rouge), para('c.', info)] });
    const tiles = actionTiles(p);
    expect(tiles).toHaveLength(2);
    expect(tiles[0]).toMatchObject({ label: 'Vérifier l’information', sub: 'Ferrari Testarossa · À vérifier', tone: 'amber' });
    expect(tiles[1]).toMatchObject({ sub: 'Vélo Cargo · En retard (2 j)', tone: 'red' });
  });

  it('masquées s’il n’y a rien à traiter', () => {
    const clear = presentationOf({ status: 'clear', paragraphs: [{ subjectId: 'CLEAR', sourceCode: 'CLEAR', occurrenceKey: 'CLEAR', text: 'x', highlight: null, actions: [] }] });
    expect(actionTiles(clear)).toEqual([]);
    expect(actionTiles(null)).toEqual([]);
  });

  it('bout en bout : le moteur réel produit des tuiles colorées (retard réel)', () => {
    const raw: MascotRawData = {
      accountId: 1, today: TODAY,
      processing: { uploads: [], analyses: [], exports: [] },
      onboarding: { activeAssets: [{ id: 1, name: 'Vélo Cargo' }, { id: 2, name: 'Maison' }], activeAssetCount: 2, documentCount: 3 },
      toProcess: [],
      agenda: [{ id: 8, title: 'Révision annuelle', date: '2026-09-19', forecast: false, requiresQualification: false, assetId: 1, assetName: 'Vélo Cargo' }],
      acknowledgments: [],
    };
    const c = buildCandidates(raw);
    const subjects = selectSubjects(c.candidates);
    const p = buildPresentation({ subjects, secondaries: buildSecondaries(c, subjects), degraded: false, messages: null, today: TODAY });
    const [tile] = actionTiles(p);
    expect(tile).toMatchObject({ tone: 'red', label: 'Reporter ou marquer fait', sub: 'Vélo Cargo · En retard (2 j)' });
    expect(homePose(p, false)).toBe('alert-folder'); // révision en retard réelle
    expect(composeSpeech({ presentation: p, empty: false }).text).toMatch(/^Un sujet mérite votre attention aujourd’hui/);
  });
});

describe('pose et suggestions', () => {
  it('gradation : vide → welcome-wave ; en retard → alert-folder ; à vérifier → questioning ; autre sujet → reminder-bell ; rien → success-check ; panne → neutral', () => {
    const verifier = { ...ambre, kind: 'verify' as const };
    const completer = { ...ambre, label: 'Compléter l’information', status: 'À compléter', kind: 'action' as const };
    const retard = { ...rouge, kind: 'overdue' as const };
    const echeance = { ...info, kind: 'info' as const };
    expect(homePose(presentationOf({ paragraphs: [para('a.', verifier), para('b.', retard)] }), false)).toBe('alert-folder');
    expect(homePose(presentationOf({ paragraphs: [para('a.', completer), para('b.', verifier)] }), false)).toBe('questioning');
    expect(homePose(presentationOf({ paragraphs: [para('a.', completer), para('b.', echeance)] }), false)).toBe('reminder-bell');
    expect(homePose(presentationOf({ paragraphs: [para('a.', echeance)] }), false)).toBe('success-check');
    expect(homePose(presentationOf({ status: 'degraded', paragraphs: [] }), false)).toBe('neutral');
    expect(homePose(presentationOf({ paragraphs: [para('a.', verifier)] }), true)).toBe('welcome-wave');
    // Présentation sans « kind » (cache ancien) : la couleur suffit.
    expect(homePose(presentationOf({ paragraphs: [para('a.', rouge)] }), false)).toBe('alert-folder');
    expect(homePose(presentationOf({ paragraphs: [para('a.', ambre)] }), false)).toBe('reminder-bell');
    expect(homePose(presentationOf({ paragraphs: [para('a.', info)] }), false)).toBe('success-check');
    expect(homePose(presentationOf({ status: 'clear', paragraphs: [] }), false)).toBe('success-check');
    expect(homePose(null, true)).toBe('welcome-wave');
    expect(homePose(null, false, true)).toBe('neutral');
  });

  it('chaque pose a un texte alternatif et une image', () => {
    for (const pose of ['welcome-wave', 'alert-folder', 'questioning', 'reminder-bell', 'success-check', 'neutral'] as const) {
      expect(homePoseLabel(pose)).toMatch(/^Verebona/);
      expect(() => readFileSync(join(process.cwd(), 'public/mascot', `${pose}.webp`))).not.toThrow();
    }
  });

  it('3 pastilles : questions du moteur, puis catalogue de la page ; compte vide : questions d’amorce', () => {
    const p = presentationOf({
      paragraphs: [],
      secondaries: [{ id: 'q', kind: 'question', sourceCode: 'Q-ASSET', occurrenceKey: 'q', action: { actionId: 'q', label: 'Que sais-tu sur Ferrari ?', target: { kind: 'ask', question: 'Que sais-tu sur Ferrari ?', context: { intent: 'Q_ASSET', assetId: 3 } } } }],
    });
    const s = homeSuggestions(p, false, ['Comment transférer un bien ?', 'Que sais-tu sur Ferrari ?', 'Mes échéances', 'Autre']);
    expect(s.map((x) => x.label)).toEqual(['Que sais-tu sur Ferrari ?', 'Comment transférer un bien ?', 'Mes échéances']);
    expect(s[0].context).toEqual({ intent: 'Q_ASSET', assetId: 3 });
    expect(homeSuggestions(p, true, []).map((x) => x.label)).toEqual(EMPTY_ACCOUNT_SUGGESTIONS);
  });

  it('secondaires non-questions (onboarding, recommandations) : pastilles d’action ; télémétrie de ce qui est montré', () => {
    const q = (i: number) => ({ id: `q${i}`, kind: 'question' as const, sourceCode: 'Q', occurrenceKey: `q${i}`, action: { actionId: `q${i}`, label: `Q${i} ?`, target: { kind: 'ask' as const, question: `Q${i} ?`, context: { intent: 'Q' } } } });
    const onb = { id: 'onb', kind: 'onboarding' as const, sourceCode: 'ONB-DOC', occurrenceKey: 'ONB-DOC', action: { actionId: 'onb', label: 'Ajouter un document', target: { kind: 'upload_document' as const, assetId: null } } };
    const p = presentationOf({ paragraphs: [], secondaries: [onb, q(1), q(2), q(3), q(4)] });
    expect(secondaryActions(p, false).map((x) => x.id)).toEqual(['onb']);
    expect(secondaryActions(p, true)).toEqual([]);
    // 3 pastilles seulement : la 4e question n'est pas affichée, donc pas comptée.
    expect(displayedSecondaries(p, false).map((x) => x.id)).toEqual(['onb', 'q1', 'q2', 'q3']);
    expect(homeSuggestions(p, false, [])[0].secondary?.occurrenceKey).toBe('q1');
    expect(displayedSecondaries(p, true)).toEqual([]);
  });

  it('les clics sur les pastilles passent par le parcours et la télémétrie du moteur', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/home/MascotSpeaks.tsx'), 'utf8');
    expect(src).toMatch(/run\(sec\.action, sec, 'secondary'\)/);
    expect(src).toMatch(/run\(s\.secondary\.action, s\.secondary, 'secondary'\)/);
    expect(src).toMatch(/useMascotPresentation\(\(p\) => displayedSecondaries\(p, emptyRef\.current\)\)/);
  });
});
