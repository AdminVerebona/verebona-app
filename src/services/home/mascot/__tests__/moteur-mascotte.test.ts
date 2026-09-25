/**
 * Mascotte d'accueil — recette du moteur déterministe (CDC Mascotte §23).
 *
 * SEL-01 à SEL-06, PROC-01 à 03, ONB-01 à 03, ATP-01 à 03, DATE-01 à 04,
 * DONE-01 à 03, UI-03, UI-04, T2-02, ERR-01, SEC.
 */
import { describe, it, expect } from 'vitest';
import type { ToProcessActionView } from '@/services/to-process/to-process-query.service';
import { buildCandidates, extActionOccurrenceKey, type MascotRawData, type MascotAgendaRow } from '../signals';
import { buildSecondaries, selectSubjects } from '../selector';
import { buildPresentation } from '../presentation';
import { CLEAR_TEXT, MAX_ACTIONS_TOTAL, type MascotPresentation } from '../types';

const TODAY = '2026-09-25';

function raw(over: Partial<MascotRawData> = {}): MascotRawData {
  return {
    accountId: 7,
    today: TODAY,
    processing: { uploads: [], analyses: [], exports: [] },
    onboarding: { activeAssets: [{ id: 1, name: 'Maison' }, { id: 2, name: 'Polo' }], activeAssetCount: 2, documentCount: 12 },
    toProcess: [],
    agenda: [],
    acknowledgments: [],
    ...over,
  };
}

let n = 0;
function atp(over: Partial<ToProcessActionView> = {}): ToProcessActionView {
  n += 1;
  return {
    publicId: `p-${n}`, targetType: 'DOCUMENT', targetId: 100 + n, fieldKey: 'documentType', relationKey: null,
    actionKind: 'COMPLETE', priority: 'DO_FIRST', ruleCode: 'DOC-TYP',
    question: 'Quel est le type de ce document ?', proposals: [], allowNotApplicable: false,
    activeSince: '2026-09-20T10:00:00Z',
    target: { label: `Facture ${n}`, publicId: `doc-${n}`, assetId: 1, assetName: 'Maison' },
    ...over,
  };
}

const agenda = (over: Partial<MascotAgendaRow>): MascotAgendaRow => ({
  id: 1, title: 'Ramonage', date: '2026-10-15', forecast: false, requiresQualification: false,
  assetId: 1, assetName: 'Maison', ...over,
});

function present(r: MascotRawData): MascotPresentation {
  const c = buildCandidates(r);
  const subjects = selectSubjects(c.candidates);
  return buildPresentation({ subjects, secondaries: buildSecondaries(c, subjects), degraded: c.degraded, messages: null });
}

const codes = (p: MascotPresentation) => p.paragraphs.map((x) => x.sourceCode);
const totalActions = (p: MascotPresentation) =>
  p.paragraphs.reduce((k, x) => k + x.actions.length, 0) + p.secondaries.length;

describe('hiérarchie (§6)', () => {
  it('SEL-01 — traitement en cours d’abord, onboarding toujours visible', () => {
    const p = present(raw({
      processing: { uploads: [], analyses: [{ id: 9, title: 'Facture EDF', at: '2026-09-25T09:00:00Z' }], exports: [] },
      onboarding: { activeAssets: [{ id: 1, name: 'Maison' }], activeAssetCount: 1, documentCount: 0 },
      toProcess: [atp()],
    }));
    expect(codes(p)).toEqual(['PROC-DOC-ANALYSIS', 'ONB-DOC']);
    expect(p.secondaries.some((s) => s.kind === 'recommendation')).toBe(true);
  });

  it('SEL-02 — onboarding sujet 1, meilleur À traiter sujet 2', () => {
    const p = present(raw({
      onboarding: { activeAssets: [{ id: 1, name: 'Maison' }], activeAssetCount: 1, documentCount: 0 },
      toProcess: [atp({ priority: 'DO_FIRST' }), atp({ priority: 'DO_NEXT' })],
    }));
    expect(codes(p)).toEqual(['ONB-DOC', 'ATP-DOC-TYP']);
  });

  it('SEL-03 / ATP-01 — ordre de la source conservé, sans score concurrent', () => {
    const a = atp({ priority: 'CAN_WAIT', question: 'Question A ?' });
    const b = atp({ priority: 'DO_FIRST', question: 'Question B ?' });
    const p = present(raw({ toProcess: [a, b] }));
    // L'ordre est celui rendu par le service, même si la priorité semble l'inverse.
    expect(p.paragraphs.map((x) => x.text.split(' Cela')[0])).toEqual(['Question A ?', 'Question B ?']);
  });

  it('SEL-04 / DATE-01 — seule une prochaine date : formulée en date absolue, sans conseil', () => {
    const p = present(raw({ agenda: [agenda({ date: '2026-10-15' })] }));
    expect(codes(p)).toEqual(['DATE-NEXT']);
    expect(p.paragraphs[0].text).toBe('Votre prochaine échéance est « Ramonage » pour Maison, le 15 octobre 2026.');
  });

  it('SEL-05 — aucun signal : « Tout est à jour pour le moment. », sans T6', () => {
    const p = present(raw());
    expect(p.status).toBe('clear');
    expect(p.source).toBe('deterministic');
    expect(p.paragraphs.map((x) => x.text)).toEqual([CLEAR_TEXT]);
  });

  it('SEL-06 — deux sujets sur le même bien restent possibles', () => {
    const p = present(raw({ toProcess: [atp(), atp()] }));
    expect(p.paragraphs).toHaveLength(2);
  });
});

describe('traitements en cours (PROC)', () => {
  it('PROC-01 / PROC-02 / PROC-03 — envoi, analyse, export', () => {
    const p = present(raw({
      processing: {
        uploads: [{ id: 3, title: 'Contrat', at: '2026-09-25T10:00:00Z' }],
        analyses: [],
        exports: [{ id: 4, exportType: 'ASSET_SHEET', assetId: 2, assetName: 'Polo', at: '2026-09-25T09:00:00Z' }],
      },
    }));
    // SEL-005 : le plus récent d'abord.
    expect(codes(p)).toEqual(['PROC-DOC-UPLOAD', 'PROC-EXPORT']);
    expect(p.paragraphs[1].actions[0].target).toEqual({ kind: 'route', href: '/assets/2?tab=exports' });
  });
});

describe('onboarding (§8)', () => {
  it('ONB-01 — compte vide : créer le premier bien + questions « vide »', () => {
    const p = present(raw({ onboarding: { activeAssets: [], activeAssetCount: 0, documentCount: 0 } }));
    expect(codes(p)).toEqual(['ONB-ASSET']);
    expect(p.secondaries.map((s) => s.sourceCode)).toEqual(['Q-EMPTY-ADD', 'Q-EMPTY-SCOPE', 'Q-EMPTY-AI']);
  });

  it('ONB-02 — premier bien créé : premier document', () => {
    const p = present(raw({ onboarding: { activeAssets: [{ id: 1, name: 'Maison' }], activeAssetCount: 1, documentCount: 0 } }));
    expect(codes(p)).toEqual(['ONB-DOC']);
    expect(p.paragraphs[0].actions[0].target).toEqual({ kind: 'upload_document', assetId: 1 });
  });

  it('ONB-03 — premier envoi réussi, analyse en cours : onboarding terminé', () => {
    const p = present(raw({
      onboarding: { activeAssets: [{ id: 1, name: 'Maison' }], activeAssetCount: 1, documentCount: 1 },
      processing: { uploads: [], analyses: [{ id: 5, title: 'Facture', at: '2026-09-25T10:00:00Z' }], exports: [] },
    }));
    expect(codes(p)).toEqual(['PROC-DOC-ANALYSIS']);
  });

  it('SEL-006 — onboarding non retenu : place secondaire réservée', () => {
    const p = present(raw({
      onboarding: { activeAssets: [{ id: 1, name: 'Maison' }], activeAssetCount: 1, documentCount: 0 },
      processing: {
        uploads: [{ id: 3, title: 'A', at: '2026-09-25T10:00:00Z' }],
        analyses: [{ id: 4, title: 'B', at: '2026-09-25T09:00:00Z' }],
        exports: [],
      },
    }));
    expect(codes(p)).toEqual(['PROC-DOC-UPLOAD', 'PROC-DOC-ANALYSIS']);
    expect(p.secondaries[0]).toMatchObject({ kind: 'onboarding', sourceCode: 'ONB-DOC' });
  });
});

describe('À traiter (§9)', () => {
  it('ATP-03 — fournisseur / équipement : la cible source est transmise au resolver commun', () => {
    const p = present(raw({ toProcess: [atp({ targetType: 'SUPPLIER', targetId: 55, target: { label: 'EDF' } })] }));
    expect(p.paragraphs[0].actions[0].target).toMatchObject({ kind: 'to_process', targetType: 'SUPPLIER', targetId: 55 });
  });

  it('ATP-004 — une échéance déjà dans « À traiter » n’est pas reprise en date', () => {
    const p = present(raw({
      toProcess: [atp({ targetType: 'AGENDA_ITEM', targetId: 1 })],
      agenda: [agenda({ id: 1 })],
    }));
    expect(codes(p)).toEqual(['ATP-DOC-TYP']);
  });

  it('ATP-008 — pas de compteur dans le discours', () => {
    const p = present(raw({ toProcess: [atp(), atp(), atp(), atp()] }));
    expect(p.paragraphs.every((x) => !/\d+ (actions|éléments)/.test(x.text))).toBe(true);
  });
});

describe('dates (§10)', () => {
  it('DATE-02 — prévisionnelle : jamais présentée comme certaine', () => {
    const p = present(raw({ agenda: [agenda({ forecast: true })] }));
    expect(p.paragraphs[0].text).toContain('prévue autour du 15 octobre 2026 (date estimée)');
  });

  it('DATE-03 — deux dates le même jour : un seul sujet composé', () => {
    const p = present(raw({
      agenda: [agenda({ id: 1, title: 'Ramonage' }), agenda({ id: 2, title: 'Vidange', assetName: 'Polo', assetId: 2 })],
      toProcess: [atp()],
    }));
    expect(codes(p)).toEqual(['ATP-DOC-TYP', 'DATE-NEXT-2']);
    expect(p.paragraphs[1].text).toBe('Deux échéances tombent le 15 octobre 2026 : « Ramonage » et « Vidange ».');
  });

  it('DATE-04 — une date réalisée ou annulée n’est jamais lue (filtrée à la source)', () => {
    // Le collecteur ne lit que les échéances sans statut manuel ; sans ligne, pas de sujet.
    expect(codes(present(raw({ agenda: [] })))).toEqual(['CLEAR']);
  });
});

describe('« C’est fait » (§11)', () => {
  const echue = agenda({ id: 8, title: 'Contrôle technique', date: '2026-09-20', assetName: 'Polo', assetId: 2 });

  it('MASC-EXT-ACTION — action externe échue : Voir + C’est fait', () => {
    const p = present(raw({ agenda: [echue] }));
    expect(codes(p)).toEqual(['MASC-EXT-ACTION']);
    expect(p.paragraphs[0].actions.map((a) => a.label)).toEqual(['Voir', 'C’est fait']);
    expect(p.paragraphs[0].actions[1].target).toEqual({ kind: 'done', occurrenceKey: extActionOccurrenceKey(8), cycleKey: '2026-09-20' });
  });

  it('DONE-01 — occurrence acquittée : masquée', () => {
    const p = present(raw({ agenda: [echue], acknowledgments: [{ occurrenceKey: extActionOccurrenceKey(8), cycleKey: '2026-09-20' }] }));
    expect(codes(p)).toEqual(['CLEAR']);
  });

  it('DONE-03 — nouveau cycle (nouvelle date) : nouvelle occurrence affichée', () => {
    const p = present(raw({
      agenda: [{ ...echue, date: '2026-09-24' }],
      acknowledgments: [{ occurrenceKey: extActionOccurrenceKey(8), cycleKey: '2026-09-20' }],
    }));
    expect(codes(p)).toEqual(['MASC-EXT-ACTION']);
  });

  it('MASC-BLOCKED — dépendance : seule l’étape actionnable est proposée', () => {
    const p = present(raw({ agenda: [{ ...echue, requiresQualification: true }] }));
    expect(codes(p)).toEqual(['MASC-BLOCKED']);
    expect(p.paragraphs[0].actions.map((a) => a.label)).toEqual(['Préciser l’échéance']);
  });

  it('une date prévisionnelle échue n’est pas une action à acquitter', () => {
    expect(codes(present(raw({ agenda: [{ ...echue, forecast: true }] })))).toEqual(['CLEAR']);
  });
});

describe('plafonds et secondaires (§4, §12)', () => {
  it('UI-03 — 2 sujets avec 4 actions : 1 secondaire au plus', () => {
    const e1 = agenda({ id: 8, date: '2026-09-20' });
    const e2 = agenda({ id: 9, date: '2026-09-21', title: 'Vidange' });
    const p = present(raw({ agenda: [e1, e2, agenda({ id: 10, date: '2026-12-01', title: 'Assurance' })], toProcess: [] }));
    expect(p.paragraphs.flatMap((x) => x.actions)).toHaveLength(3); // DATE (1) + EXT (2)
    const p2 = present(raw({ agenda: [e1, e2] }));
    expect(p2.paragraphs.flatMap((x) => x.actions)).toHaveLength(4);
    expect(p2.secondaries.length).toBeLessThanOrEqual(1);
    expect(totalActions(p2)).toBeLessThanOrEqual(MAX_ACTIONS_TOTAL);
  });

  it('UI-04 — aucune action liée : jusqu’à 3 secondaires, sans remplissage', () => {
    const p = present(raw({ onboarding: { activeAssets: [], activeAssetCount: 0, documentCount: 0 } }));
    expect(p.secondaries.length).toBeLessThanOrEqual(3);
    const clear = present(raw({ onboarding: { activeAssets: [{ id: 1, name: 'M' }], activeAssetCount: 1, documentCount: 3 } }));
    expect(clear.secondaries.map((s) => s.sourceCode)).toEqual(['Q-ANALYSIS']);
  });

  it('T2-02 / SEC-004 — question équivalente à un sujet affiché : exclue', () => {
    const p = present(raw({ agenda: [agenda({})] }));
    expect(p.secondaries.map((s) => s.sourceCode)).not.toContain('Q-NEXT-DATE');
    const q = present(raw({ toProcess: [atp()] }));
    expect(q.secondaries.map((s) => s.sourceCode)).not.toContain('Q-TODO');
  });

  it('UX-008 — un sujet n’est jamais à la fois dans le discours et en secondaire', () => {
    const p = present(raw({ toProcess: [atp(), atp(), atp()] }));
    const discours = new Set(p.paragraphs.map((x) => x.occurrenceKey));
    expect(p.secondaries.some((s) => discours.has(s.occurrenceKey))).toBe(false);
  });

  it('T2-01 — une question transporte son intention et, s’il y a lieu, le bien', () => {
    const p = present(raw({ agenda: [agenda({ date: '2026-09-20', id: 8 })] }));
    const qAsset = p.secondaries.find((s) => s.sourceCode === 'Q-ASSET');
    expect(qAsset?.action.target).toEqual({
      kind: 'ask', question: 'Que sais-tu sur Maison ?', context: { intent: 'asset_summary', assetId: 1 },
    });
  });
});

describe('modes dégradés (§20)', () => {
  it('ERR-01 — « À traiter » indisponible : jamais « Tout est à jour »', () => {
    const p = present(raw({ toProcess: null }));
    expect(p.status).toBe('degraded');
    expect(p.paragraphs).toEqual([]);
    expect(p.degradedNotice).toBeTruthy();
  });

  it('agenda indisponible mais un sujet fiable : affiché, avec la mention', () => {
    const p = present(raw({ agenda: null, toProcess: [atp()] }));
    expect(codes(p)).toEqual(['ATP-DOC-TYP']);
    expect(p.status).toBe('degraded');
  });
});

describe('contrat', () => {
  it('au plus 2 actions par sujet, 2 sujets, empreinte stable', () => {
    const r = raw({ toProcess: [atp(), atp(), atp()] });
    const a = present(r);
    const b = present(r);
    expect(a.paragraphs.length).toBeLessThanOrEqual(2);
    expect(a.paragraphs.every((x) => x.actions.length <= 2)).toBe(true);
    expect(a.contextHash).toBe(b.contextHash);
  });

  it('DUO-001 — calcul au niveau du compte : aucun élément propre à l’utilisateur', () => {
    const p = present(raw({ toProcess: [atp()] }));
    expect(JSON.stringify(p)).not.toMatch(/userId|firstName|prénom/);
  });
});
