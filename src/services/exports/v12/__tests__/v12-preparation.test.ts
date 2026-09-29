/**
 * Préparation et estimation (CDC V12 §5, §6, §17.1, §24) — fonctions pures
 * `buildPreparation` / `estimateSelection`, sans base :
 *   · sections par dossier, dans l'ordre et avec les titres des templates ;
 *   · pré-sélection §6.2 / §24 (vente / location : documents non cochés ;
 *     CIL : diagnostics ; sinistre : pièces liées au sinistre) ;
 *   · DEC-006 : sensible proposé, jamais pré-coché ; occupant jamais proposé ;
 *   · DEC-005 : format non intégrable → mode ZIP seul, sortie ZIP ;
 *   · plafonds de photos (4 / 8), photos après la date du sinistre, HEIC ;
 *   · événements et agenda par section ;
 *   · seuils §6.3 (20 / 50 documents, 50 / 150 Mo, 300 pages, 100 photos) ;
 *   · fichiers indisponibles (MSG-PREP-005), trop lourds ;
 *   · CIL : blocs bloquants B1 / B3 / B8, B2, non-applicabilité ;
 *   · cohérence avec la génération : choix de l'écran → payload §17.2 →
 *     `parseChoicesPayload` → même plan.
 */
import { describe, it, expect, vi } from 'vitest';
import { makeSource, doc, photo, event, TODAY } from './fixtures/sources';
import { PREP_SECTIONS } from '../preparation/sections';
import type { CilReadiness } from '@/services/exports/cil-preparation.service';
import type { ExportSource } from '../data/source';

vi.mock('@/db', () => ({ db: {} }));

const { buildPreparation, choicesFromSections } = await import('../preparation/prepare');
const { estimateSelection } = await import('../preparation/estimate');
const { parseChoicesPayload, planSelection } = await import('../data/choices');

const prepare = (code: Parameters<typeof buildPreparation>[0], source: ExportSource) =>
  buildPreparation(code, source, { today: TODAY, lastGeneration: null });
const item = (p: ReturnType<typeof prepare>, key: string) => p.sections.flatMap((s) => s.items).find((i) => i.key === key)!;
const section = (p: ReturnType<typeof prepare>, id: string) => p.sections.find((s) => s.id === id)!;
const MB = 1024 * 1024;

describe('Sections par dossier (PREP-SECTIONS, titres du PDF)', () => {
  it('six dossiers, couverture en tête et sources à la fin', () => {
    for (const code of ['CIL', 'DOSSIER_COMPLET', 'VENTE', 'LOCATION', 'ASSURANCE_SOUSCRIPTION', 'ASSURANCE_SINISTRE'] as const) {
      const defs = PREP_SECTIONS[code];
      expect(defs[0].id, code).toBe('cover');
      expect(defs.at(-1)!.id, code).toBe('references');
      expect(defs.at(-1)!.required, code).toBe(true);
    }
  });

  it('les titres sont ceux des templates validés', async () => {
    const fs = await import('node:fs');
    const tpl = (f: string) => fs.readFileSync(`src/services/exports/v12/templates/${f}.ts`, 'utf8');
    const expectTitles = (file: string, code: keyof typeof PREP_SECTIONS, skip: string[]) => {
      const src = tpl(file);
      for (const s of PREP_SECTIONS[code]) {
        if (skip.includes(s.id)) continue;
        expect(src.replace(/\\'/g, '’').replace(/'/g, '’'), `${code} · ${s.label}`).toContain(s.label.replace(/'/g, '’'));
      }
    };
    expectTitles('vente', 'VENTE', ['cover']);
    expectTitles('location', 'LOCATION', ['cover']);
    expectTitles('assurance-souscription', 'ASSURANCE_SOUSCRIPTION', ['cover', 'photos']);
    expectTitles('assurance-sinistre', 'ASSURANCE_SINISTRE', ['cover']);
    expectTitles('dossier-complet', 'DOSSIER_COMPLET', ['cover', 'history', 'deadlines']);
    expectTitles('cil', 'CIL', ['cover', 'documents']);
  });

  it('sections obligatoires verrouillées, optionnelles décochables avec les défauts §6.2', () => {
    const p = prepare('DOSSIER_COMPLET', makeSource('IMMOBILIER', 'DOSSIER_COMPLET'));
    expect(section(p, 'summary')).toMatchObject({ required: true, toggleable: false, enabled: true });
    // DOSSIER_COMPLET-RULE-002 : finances non incluses par défaut.
    expect(section(p, 'finance')).toMatchObject({ toggleable: true, enabled: false, defaultEnabled: false, recommended: false });
    expect(section(p, 'contracts')).toMatchObject({ toggleable: true, enabled: true, recommended: true });
  });
});

describe('Pré-sélection (§6.2, §24) et sensibilité (DEC-006)', () => {
  it('vente et location : documents proposés non cochés ; section documents désactivée (SEL-GEN-010)', () => {
    for (const code of ['VENTE', 'LOCATION'] as const) {
      const p = prepare(code, makeSource('IMMOBILIER', code, { documents: [doc({ id: 1, kind: 'DPE', title: 'DPE' }), doc({ id: 2, kind: 'FACTURE', title: 'Facture cuisine' })] }));
      expect(item(p, 'document:1')).toMatchObject({ selected: false, recommended: false, selectable: true });
      expect(section(p, 'documents').enabled).toBe(false);
      expect(section(p, 'followUp').enabled).toBe(false);
    }
  });

  it('CIL : diagnostics et plans pré-cochés, factures proposées ; bloc indiqué', () => {
    const p = prepare('CIL', makeSource('IMMOBILIER', 'CIL', {
      documents: [doc({ id: 1, kind: 'DPE', title: 'DPE' }), doc({ id: 2, kind: 'PLAN_CONSTRUCTION', title: 'Plans' }), doc({ id: 3, kind: 'FACTURE', title: 'Facture' })],
      photos: [photo(1)],
    }));
    expect(item(p, 'document:1')).toMatchObject({ selected: true, mode: 'PDF', detail: 'Bloc B8' });
    expect(item(p, 'document:2')).toMatchObject({ selected: true, detail: 'Bloc B3' });
    expect(item(p, 'document:3')).toMatchObject({ selected: false });
    // Pas de section photos dans le CIL.
    expect(p.sections.some((s) => s.itemType === 'photo')).toBe(false);
  });

  it('document sensible : proposé, jamais pré-coché, badge de section ; occupant jamais proposé', () => {
    const p = prepare('DOSSIER_COMPLET', makeSource('IMMOBILIER', 'DOSSIER_COMPLET', {
      documents: [
        doc({ id: 1, kind: 'FACTURE', title: 'Facture chaudière' }),
        doc({ id: 2, kind: 'ACTE_NOTARIE', title: 'Acte de vente', sensitive: true }),
        doc({ id: 3, kind: 'LOCATIF', title: 'Bail M. Garnier', occupantData: true }),
      ],
    }));
    expect(item(p, 'document:1')).toMatchObject({ selected: true, recommended: true });
    expect(item(p, 'document:2')).toMatchObject({ selected: false, recommended: false, sensitive: true, selectable: true });
    expect(p.sections.flatMap((s) => s.items).some((i) => i.key === 'document:3')).toBe(false);
    expect(section(p, 'documents').hasSensitive).toBe(true);
  });

  it('sinistre : pièces et photos liées au sinistre (datées du sinistre ou après) pré-cochées', () => {
    const p = prepare('ASSURANCE_SINISTRE', makeSource('IMMOBILIER', 'ASSURANCE_SINISTRE', {
      additionalInfo: { commercial: {}, rental: {}, insurance: {}, claim: { occurredOn: '2026-06-01', consequences: 'Plafond de la cuisine' }, updatedAt: null },
      documents: [doc({ id: 1, kind: 'DEVIS', title: 'Devis peinture', date: '2026-06-10' }), doc({ id: 2, kind: 'DEVIS', title: 'Ancien devis', date: '2025-01-10' }), doc({ id: 3, kind: 'SINISTRE', title: 'Déclaration', date: '2020-01-01' })],
      photos: Array.from({ length: 12 }, (_, i) => photo(i + 1, { date: i < 10 ? '2026-06-02' : '2026-01-01' })),
      events: [event(1, { title: 'Dégât des eaux', date: '2026-06-01', category: 'sinistre' }), event(2, { title: 'Entretien chaudière', date: '2025-06-12' })],
    }));
    expect(item(p, 'document:1').selected).toBe(true);
    expect(item(p, 'document:2').selected).toBe(false);
    expect(item(p, 'document:3').selected).toBe(true);
    const photos = section(p, 'photos').items;
    expect(photos.filter((i) => i.selected)).toHaveLength(8); // plafond 6-8
    expect(photos.filter((i) => i.selected).every((i) => i.date === '2026-06-02')).toBe(true);
    expect(item(p, 'event:1').selected).toBe(true);
    expect(item(p, 'event:2')).toMatchObject({ selected: false, recommended: false });
    // Dommages : saisie structurée seulement (le texte « constaté » ne suffit pas, comme le mappeur).
    expect(section(p, 'damages')).toMatchObject({ fedFilled: false });
    expect(section(p, 'actions')).toMatchObject({ fedFilled: false });
  });

  it('plafonds de photos : 4 pour la vente, 8 pour le dossier complet ; photos listées une par une', () => {
    const photos = Array.from({ length: 10 }, (_, i) => photo(i + 1));
    const vente = prepare('VENTE', makeSource('VEHICULE', 'VENTE', { photos }));
    expect(vente.photoCap).toBe(4);
    expect(section(vente, 'photos').items).toHaveLength(10);
    expect(section(vente, 'photos').items.filter((i) => i.selected).map((i) => i.sourceId)).toEqual([1, 2, 3, 4]);
    const complet = prepare('DOSSIER_COMPLET', makeSource('OBJET', 'DOSSIER_COMPLET', { photos }));
    expect(section(complet, 'photos').items.filter((i) => i.selected)).toHaveLength(8);
  });

  it('événements et agenda répartis par section (historique / échéances)', () => {
    const p = prepare('DOSSIER_COMPLET', makeSource('IMMOBILIER', 'DOSSIER_COMPLET', {
      events: [
        event(1, { title: 'Entretien chaudière', date: '2025-10-01' }),
        { ...event(2, { title: 'Contrôle annuel', date: '2026-11-15', status: 'prevu' }), key: 'agenda:2', source: 'agenda', category: null },
      ],
    }));
    expect(section(p, 'history').items.map((i) => i.key)).toEqual(['event:1']);
    expect(section(p, 'deadlines').items.map((i) => i.key)).toEqual(['agenda:2']);
    expect(item(p, 'agenda:2')).toMatchObject({ selected: true, source: 'Agenda du bien', allowedModes: [] });
  });
});

describe('Formats et modes PDF / ZIP (DEC-005, SEL-GEN-003-005, ZIP-001)', () => {
  const docx = doc({ id: 7, kind: 'FACTURE', title: 'Facture Word', format: 'DOCX', integrable: false, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', fileName: 'facture.docx' });

  it('format non intégrable : ZIP seul, pré-coché en ZIP (« sinon ZIP »), sortie PDF + ZIP', () => {
    const p = prepare('DOSSIER_COMPLET', makeSource('IMMOBILIER', 'DOSSIER_COMPLET', { documents: [docx, doc({ id: 8, kind: 'FACTURE', title: 'Facture PDF' })] }));
    expect(item(p, 'document:7')).toMatchObject({ compatibility: 'zip_only', allowedModes: ['ZIP'], selected: true, mode: 'ZIP', recommendedMode: 'ZIP' });
    expect(item(p, 'document:8')).toMatchObject({ compatibility: 'integrable', allowedModes: ['PDF', 'ZIP'], mode: 'PDF' });
    expect(p.estimate).toMatchObject({ outputFormat: 'ZIP', pdfDocuments: 1, zipDocuments: 1 });
    expect(p.estimate.zipOnlyItems.map((z) => z.key)).toEqual(['document:7']);
    expect(p.actions).toEqual({ canGeneratePdf: true, canGenerateZip: true });
  });

  it('tout en PDF : pas de ZIP (ZIP-001), bouton ZIP indisponible', () => {
    const p = prepare('DOSSIER_COMPLET', makeSource('IMMOBILIER', 'DOSSIER_COMPLET', { documents: [doc({ id: 8, kind: 'FACTURE', title: 'Facture PDF' })] }));
    expect(p.estimate).toMatchObject({ outputFormat: 'PDF', zipItems: 0 });
    expect(p.actions.canGenerateZip).toBe(false);
  });

  it('photo HEIC : ZIP seul, jamais pré-cochée', () => {
    const p = prepare('VENTE', makeSource('VEHICULE', 'VENTE', { photos: [photo(1, { mimeType: 'image/heic', fileName: 'a.heic' }), photo(2)] }));
    expect(item(p, 'photo:1')).toMatchObject({ compatibility: 'zip_only', allowedModes: ['ZIP'], selected: false });
    expect(item(p, 'photo:2')).toMatchObject({ selected: true, mode: 'PDF' });
  });

  it('« PDF seul » confirmé : les pièces ZIP sont retirées (ALT-002)', () => {
    const src = makeSource('IMMOBILIER', 'DOSSIER_COMPLET', { documents: [docx, doc({ id: 8, kind: 'FACTURE', title: 'Facture PDF' })] });
    const p = prepare('DOSSIER_COMPLET', src);
    const e = estimateSelection('DOSSIER_COMPLET', src, choicesFromSections(p.sections), TODAY, { outputFormat: 'PDF' });
    expect(e.dto).toMatchObject({ outputFormat: 'PDF', pdfDocuments: 1, zipDocuments: 0, zipItems: 0 });
    expect(e.plan.excluded.find((x) => x.sourceId === 7)?.reason).toBe('zip_only_pdf_output');
  });
});

describe('Fichiers indisponibles (SEL-GEN-006, MSG-PREP-005)', () => {
  it('fichier absent : non sélectionnable, message ; trop lourd : non sélectionnable', () => {
    const p = prepare('DOSSIER_COMPLET', makeSource('IMMOBILIER', 'DOSSIER_COMPLET', {
      documents: [doc({ id: 1, kind: 'FACTURE', title: 'Perdue', s3Key: null }), doc({ id: 2, kind: 'FACTURE', title: 'Énorme', sizeBytes: 80 * MB })],
    }));
    expect(item(p, 'document:1')).toMatchObject({ compatibility: 'missing', selectable: false, selected: false, recommended: true });
    expect(item(p, 'document:1').error).toMatch(/introuvable/);
    expect(item(p, 'document:2')).toMatchObject({ compatibility: 'too_large', selectable: false, allowedModes: [] });
    expect(p.messages.map((m) => m.code)).toContain('MSG-PREP-005');
  });

  it('estimation : une pièce indisponible cochée est signalée et exclue', () => {
    const src = makeSource('IMMOBILIER', 'DOSSIER_COMPLET', { documents: [doc({ id: 1, kind: 'FACTURE', title: 'Perdue', s3Key: null })] });
    const parsed = parseChoicesPayload('DOSSIER_COMPLET', { items: [{ sourceType: 'document', sourceId: 1, selected: true, mode: 'PDF' }] });
    if (!parsed.ok) throw new Error('payload');
    const e = estimateSelection('DOSSIER_COMPLET', src, parsed.choices, TODAY);
    expect(e.dto.unavailable).toEqual([{ key: 'document:1', label: 'Perdue', reason: 'missing' }]);
    expect(e.dto.pdfDocuments).toBe(0);
  });

  it('aucun élément utile : MSG-PREP-001 (ALT-001)', () => {
    const p = prepare('VENTE', makeSource('OBJET', 'VENTE'));
    expect(p.empty).toBe(true);
    expect(p.messages[0]).toMatchObject({ code: 'MSG-PREP-001', level: 'info' });
  });
});

describe('Seuils §6.3 (ALT-003, THRESHOLD_BLOCKED)', () => {
  const docs = (n: number, size = 100_000) => Array.from({ length: n }, (_, i) => doc({ id: 1000 + i, kind: 'FACTURE', title: `Facture ${i}`, sizeBytes: size }));
  const est = (src: ExportSource) => prepare('DOSSIER_COMPLET', src).estimate;

  it('> 20 documents intégrés : avertissement ; > 50 : blocage et MSG-PREP-004', () => {
    expect(est(makeSource('IMMOBILIER', 'DOSSIER_COMPLET', { documents: docs(21) })).warnings.map((w) => w.code)).toContain('DOCS_WARNING');
    const p = prepare('DOSSIER_COMPLET', makeSource('IMMOBILIER', 'DOSSIER_COMPLET', { documents: docs(51) }));
    expect(p.estimate.blocking.map((b) => b.code)).toContain('DOCS_BLOCKING');
    expect(p.estimate.blocking.find((b) => b.code === 'DOCS_BLOCKING')!.message).toMatch(/Réduisez la sélection ou passez certaines pièces en ZIP/);
    expect(p.messages.map((m) => m.code)).toContain('MSG-PREP-004');
    expect(p.actions.canGeneratePdf).toBe(false);
    expect(p.estimate.longGeneration).toBe(true);
  });

  it('51 documents dont une partie passée en ZIP : plus de blocage', () => {
    const src = makeSource('IMMOBILIER', 'DOSSIER_COMPLET', { documents: docs(51) });
    const p = prepare('DOSSIER_COMPLET', src);
    const choices = choicesFromSections(p.sections);
    choices.items = choices.items.map((it, i) => (i < 10 ? { ...it, mode: 'ZIP' as const } : it));
    const e = estimateSelection('DOSSIER_COMPLET', src, choices, TODAY);
    expect(e.dto.blocking).toEqual([]);
    expect(e.dto).toMatchObject({ outputFormat: 'ZIP', pdfDocuments: 41, zipDocuments: 10 });
  });

  it('> 50 Mo : avertissement ; > 150 Mo : blocage ; > 300 pages : blocage', () => {
    expect(est(makeSource('IMMOBILIER', 'DOSSIER_COMPLET', { documents: docs(3, 20 * MB) })).warnings.map((w) => w.code)).toContain('SIZE_WARNING');
    const big = est(makeSource('IMMOBILIER', 'DOSSIER_COMPLET', { documents: docs(4, 40 * MB) }));
    expect(big.blocking.map((b) => b.code)).toEqual(expect.arrayContaining(['SIZE_BLOCKING', 'PAGES_BLOCKING']));
  });

  it('> 100 photos sélectionnées : blocage', () => {
    const src = makeSource('IMMOBILIER', 'DOSSIER_COMPLET', { photos: Array.from({ length: 101 }, (_, i) => photo(i + 1, { sizeBytes: 10_000 })) });
    const choices = choicesFromSections(prepare('DOSSIER_COMPLET', src).sections);
    choices.items = src.photos.map((p) => ({ sourceType: 'photo' as const, sourceId: p.id, selected: true, mode: 'PDF' as const }));
    expect(estimateSelection('DOSSIER_COMPLET', src, choices, TODAY).dto.blocking.map((b) => b.code)).toContain('PHOTOS_BLOCKING');
  });
});

describe('CIL : blocs bloquants B1 / B3 / B8 (CIL-RULE-002, §20)', () => {
  const readiness = (over: Partial<Record<string, CilReadiness['blocks'][number]['status']>>): CilReadiness => {
    const ids = ['B1', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9'];
    const blocks = ids.map((id) => {
      const status = over[id] ?? 'complete';
      const blocking = ['B1', 'B8'].includes(id) || (id === 'B3' && status === 'missing');
      return { id, label: `Bloc ${id}`, status, blocking, missingItems: status === 'complete' ? [] : [{ id: `m-${id}`, label: 'Manquant', target: { type: 'documents' }, actionLabel: 'Ajouter' }] };
    });
    const blockingBlocks = blocks.filter((b) => b.blocking && ['missing', 'invalid', 'unknown'].includes(b.status));
    return { globalStatus: blockingBlocks.length ? 'action_required' : 'ready', completion: { resolvedBlocks: 0, applicableBlocks: 8, totalBlocks: 8, percentage: 50 }, blocks, blockingBlocks };
  };
  const cilSource = (r: CilReadiness, profile: NonNullable<ExportSource['cil']>['profile'] = null) =>
    makeSource('IMMOBILIER', 'CIL', { cil: { readiness: r, profile, materials: [], works: [], resolutions: [] } });

  it('B3 et B8 manquants : préparation « à compléter », génération impossible', () => {
    const p = prepare('CIL', cilSource(readiness({ B3: 'missing', B8: 'missing', B4: 'unknown' })));
    expect(p.eligibility.status).toBe('partial');
    expect(p.actions).toEqual({ canGeneratePdf: false, canGenerateZip: false });
    const ids = p.cil!.blocks.filter((b) => b.blocksGeneration).map((b) => b.id);
    expect(ids).toEqual(['B3', 'B8']);
    // B4 à compléter mais non bloquant.
    expect(p.cil!.blocks.find((b) => b.id === 'B4')).toMatchObject({ blocksGeneration: false, canMarkNotApplicable: true });
    // B1 et B8 ne peuvent pas être déclarés non applicables ; B3 si.
    expect(p.cil!.blocks.find((b) => b.id === 'B8')!.canMarkNotApplicable).toBe(false);
    expect(p.cil!.blocks.find((b) => b.id === 'B3')!.canMarkNotApplicable).toBe(true);
  });

  it('B2 (profil CIL) inséré, non bloquant ; tout complet : prêt', () => {
    const p = prepare('CIL', cilSource(readiness({}), { triggerType: 'volontaire', triggerDate: null, authorizationType: null, voluntaryReason: 'Vente' }));
    expect(p.cil!.blocks.map((b) => b.id)).toEqual(['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9']);
    expect(p.cil!.blocks[1]).toMatchObject({ id: 'B2', status: 'complete', blocksGeneration: false });
    expect(p.eligibility.status).toBe('ready');
    expect(p.actions.canGeneratePdf).toBe(true);
  });
});

describe('Cohérence écran → génération (§17.2)', () => {
  it('les choix de l’écran, relus par parseChoicesPayload, donnent le même plan', () => {
    const src = makeSource('IMMOBILIER', 'VENTE', {
      documents: [doc({ id: 1, kind: 'DPE', title: 'DPE' }), doc({ id: 2, kind: 'ACTE_NOTARIE', title: 'Acte', sensitive: true })],
      photos: [photo(1), photo(2), photo(3), photo(4), photo(5)],
      events: [event(1, { title: 'Révision chaudière' })],
    });
    const p = prepare('VENTE', src);
    const choices = choicesFromSections(p.sections);
    // L'utilisateur coche explicitement la pièce sensible, en ZIP.
    choices.items.push({ sourceType: 'document', sourceId: 2, selected: true, mode: 'ZIP' });
    choices.sections.documents = true;
    const payload = {
      outputFormat: 'ZIP',
      sections: Object.entries(choices.sections).map(([id, enabled]) => ({ id, enabled, items: id === 'documents' ? choices.items.filter((i) => i.sourceType === 'document') : [] })),
      items: choices.items.filter((i) => i.sourceType !== 'document'),
    };
    const parsed = parseChoicesPayload('VENTE', payload);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
    const plan = planSelection('VENTE', src, parsed.choices, TODAY);
    expect(plan.documents.map((d) => [d.doc.id, d.mode])).toEqual([[2, 'ZIP']]);
    expect(plan.photos.map((x) => x.photo.id)).toEqual([1, 2, 3, 4]);
    expect(plan.sections.followUp).toBe(false);
  });

  it('includeCurrentSelections : les choix transmis sont repris', () => {
    const src = makeSource('IMMOBILIER', 'VENTE', { documents: [doc({ id: 1, kind: 'DPE', title: 'DPE' })] });
    const parsed = parseChoicesPayload('VENTE', { items: [{ sourceType: 'document', sourceId: 1, selected: true, mode: 'ZIP' }], sections: [{ id: 'documents', enabled: true }] });
    if (!parsed.ok) throw new Error('payload');
    const p = buildPreparation('VENTE', src, { today: TODAY, lastGeneration: null, choices: parsed.choices });
    expect(item(p, 'document:1')).toMatchObject({ selected: true, mode: 'ZIP', recommended: false });
    expect(section(p, 'documents').enabled).toBe(true);
    expect(p.estimate.outputFormat).toBe('ZIP');
  });
});

describe('Données structurées des informations complémentaires (schéma v2)', () => {
  const info = (over: Partial<ExportSource['additionalInfo']>): ExportSource['additionalInfo'] =>
    ({ commercial: {}, rental: {}, insurance: {}, claim: {}, finance: {}, updatedAt: null, ...over } as ExportSource['additionalInfo']);

  it('sinistre : dommages, actions, échanges comptés avec leurs pièces liées', () => {
    const p = prepare('ASSURANCE_SINISTRE', makeSource('IMMOBILIER', 'ASSURANCE_SINISTRE', {
      documents: [doc({ id: 1, kind: 'DEVIS', title: 'Devis' }), doc({ id: 2, kind: 'FACTURE', title: 'Facture séchage' })],
      photos: [photo(1), photo(2)],
      additionalInfo: info({ claim: {
        occurredOn: '2026-08-14',
        damages: [{ id: 'd1', zone: 'Salle de bain', element: 'Plafond', finding: 'Auréoles', estimatedAmountCents: 120000, photoIds: [1, 2], documentIds: [1] }],
        actions: [{ id: 'a1', title: 'Séchage', date: '2026-08-15', status: 'REALISEE', invoiceDocumentId: 2 }],
        exchanges: [{ id: 'x1', date: '2026-08-20', summary: 'Convocation à l’expertise', party: 'EXPERT', channel: 'EMAIL' }],
      } as never }),
    }));
    expect(section(p, 'damages').rows).toEqual([{ id: 'd1', label: 'Salle de bain · Plafond', detail: expect.stringContaining('Auréoles'), linked: ['photo:1', 'photo:2', 'document:1'] }]);
    expect(section(p, 'damages').fedFilled).toBe(true);
    expect(section(p, 'actions').rows[0]).toMatchObject({ label: 'Séchage', detail: expect.stringContaining('Réalisée'), linked: ['document:2'] });
    expect(section(p, 'exchanges').rows[0].label).toBe('Convocation à l’expertise');
  });

  it('souscription : protections détaillées et éléments assurés (justificatif lié)', () => {
    const p = prepare('ASSURANCE_SOUSCRIPTION', makeSource('OBJET', 'ASSURANCE_SOUSCRIPTION', {
      additionalInfo: info({ insurance: {
        protectionItems: [{ id: 'p1', title: 'Garage fermé', text: 'Porte motorisée' }],
        insuredItems: [{ id: 'i1', label: 'Housse', valueCents: 12000, documentId: 9 }, { id: 'i2', label: 'Leash', valueCents: 3000 }],
      } as never }),
    }));
    expect(section(p, 'protections').rows).toEqual([{ id: 'p1', label: 'Garage fermé', detail: 'Porte motorisée', linked: [] }]);
    expect(section(p, 'value').rows.map((r) => r.linked)).toEqual([['document:9'], []]);
    expect(section(p, 'value').rows[1].detail).toContain('sans justificatif');
  });

  it('dossier complet : valeur et charges listées, section financière toujours décochée par défaut', () => {
    const p = prepare('DOSSIER_COMPLET', makeSource('IMMOBILIER', 'DOSSIER_COMPLET', {
      additionalInfo: info({ finance: { retainedValueCents: 34000000, retainedValueSource: 'EXPERTISE', acquisitionFeesCents: 2500000, charges: [{ id: 'c1', kind: 'TAXE_FONCIERE', amountCents: 120000, year: 2025 }] } as never }),
    }));
    const fin = section(p, 'finance');
    expect(fin.enabled).toBe(false);
    expect(fin.rows.map((r) => r.label)).toEqual(['Valeur retenue', 'Frais d’acquisition', 'Taxe foncière']);
    expect(fin.infoSections).toEqual(['finance']);
  });

  it('vente : points forts choisis (4 au plus)', () => {
    const highlights = Array.from({ length: 5 }, (_, i) => ({ id: `h${i}`, title: `Point ${i}`, text: '' }));
    const p = prepare('VENTE', makeSource('VEHICULE', 'VENTE', { additionalInfo: info({ commercial: { highlights } as never }) }));
    expect(section(p, 'highlights').rows).toHaveLength(4);
    expect(section(p, 'highlights').fedFilled).toBe(true);
    // Sans point fort choisi : repli du mappeur sur les faits documentés — même résultat.
    const bare = makeSource('OBJET', 'VENTE');
    const d = mapDossierData('VENTE', { source: bare, plan: planSelection('VENTE', bare, buildDefaultChoices('VENTE', bare, { today: TODAY }), TODAY), resolved: null, meta: { reference: 'R', generatedAt: '2026-09-28T09:00:00+02:00', preparedBy: null, templateLabel: 'x', zipName: null, label: 'x' }, today: TODAY }) as { highlights?: unknown[] };
    expect(section(prepare('VENTE', bare), 'highlights').fedFilled).toBe((d.highlights?.length ?? 0) > 0);
  });

  it('date du sinistre : repli sur l’événement de l’agenda lié (claimEventKey)', async () => {
    const { claimDate } = await import('../data/choices');
    const src = makeSource('IMMOBILIER', 'ASSURANCE_SINISTRE', {
      additionalInfo: info({ claim: { claimEventKey: 'agenda:9' } }),
      events: [{ ...event(9, { title: 'Dégât des eaux', date: '2026-08-14' }), key: 'agenda:9', source: 'agenda', category: null }],
      documents: [doc({ id: 1, kind: 'DEVIS', title: 'Devis après', date: '2026-08-20' }), doc({ id: 2, kind: 'DEVIS', title: 'Devis avant', date: '2026-01-01' })],
    });
    expect(claimDate(src)).toBe('2026-08-14');
    const p = prepare('ASSURANCE_SINISTRE', src);
    expect(item(p, 'document:1').selected).toBe(true);
    expect(item(p, 'document:2').selected).toBe(false);
    // La date saisie prime.
    expect(claimDate({ ...src, additionalInfo: info({ claim: { claimEventKey: 'agenda:9', occurredOn: '2026-08-01' } }) })).toBe('2026-08-01');
  });
});

const { mapDossierData } = await import('../data/mappers');
const { buildDefaultChoices } = await import('../data/choices');

describe('État « renseigné » des sections = sortie des mappeurs (fixtures)', () => {
  const meta = { reference: 'R', generatedAt: '2026-09-28T09:00:00+02:00', preparedBy: null, templateLabel: 'x', zipName: null, label: 'x' };
  const mapped = (code: Parameters<typeof mapDossierData>[0], src: ExportSource, choices = buildDefaultChoices(code, src, { outputFormat: 'ZIP', today: TODAY })) => {
    const on = Object.fromEntries(Object.keys(choices.sections).map((k) => [k, true]));
    const plan = planSelection(code, src, { ...choices, sections: { ...choices.sections, ...on } }, TODAY);
    return mapDossierData(code, { source: src, plan, resolved: null, meta, today: TODAY }) as unknown as Record<string, unknown[] | null>;
  };
  const infoOf = (over: Record<string, unknown>) => ({ commercial: {}, rental: {}, insurance: {}, claim: {}, finance: {}, updatedAt: null, ...over }) as ExportSource['additionalInfo'];

  const cases: Array<[string, ExportSource]> = [
    ['texte libre seulement', makeSource('IMMOBILIER', 'ASSURANCE_SINISTRE', { additionalInfo: infoOf({ claim: { occurredOn: '2026-06-01', consequences: 'Plafond', measures: 'Une seule mesure', exchangesSummary: 'Appel' } }) })],
    ['mesures sur plusieurs lignes', makeSource('IMMOBILIER', 'ASSURANCE_SINISTRE', { additionalInfo: infoOf({ claim: { occurredOn: '2026-06-01', measures: 'Coupure eau\nBâche' } }) })],
    ['structuré', makeSource('IMMOBILIER', 'ASSURANCE_SINISTRE', { additionalInfo: infoOf({ claim: { occurredOn: '2026-06-01', damages: [{ id: 'd', zone: 'Cuisine' }], actions: [{ id: 'a', title: 'Séchage' }], exchanges: [{ id: 'x', date: '2026-06-03', summary: 'Appel expert' }] } }) })],
    ['courrier assureur non retenu', makeSource('IMMOBILIER', 'ASSURANCE_SINISTRE', { documents: [doc({ id: 5, kind: 'ECHANGE_ASSUREUR', title: 'Courrier', date: '2020-01-01', sensitive: true })] })],
  ];
  it.each(cases)('sinistre — %s', (_n, src) => {
    const p = prepare('ASSURANCE_SINISTRE', src);
    const d = mapped('ASSURANCE_SINISTRE', src, choicesFromSections(p.sections));
    for (const id of ['damages', 'actions', 'exchanges']) expect(section(p, id).fedFilled, id).toBe((d[id]?.length ?? 0) > 0);
  });

  it('souscription, location, dossier complet, vente', () => {
    const sous = makeSource('OBJET', 'ASSURANCE_SOUSCRIPTION', { additionalInfo: infoOf({ insurance: { specialItems: 'Alarme' } }) });
    expect(section(prepare('ASSURANCE_SOUSCRIPTION', sous), 'protections').fedFilled).toBe((mapped('ASSURANCE_SOUSCRIPTION', sous).protections?.length ?? 0) > 0);
    const dc = makeSource('IMMOBILIER', 'DOSSIER_COMPLET', { asset: { ...makeSource('IMMOBILIER', 'DOSSIER_COMPLET').asset, purchasePriceCents: null } });
    expect(section(prepare('DOSSIER_COMPLET', dc), 'finance').fedFilled).toBe(false);
    const dc2 = makeSource('IMMOBILIER', 'DOSSIER_COMPLET');
    expect(section(prepare('DOSSIER_COMPLET', dc2), 'finance').fedFilled).toBe(true);
    const loc = makeSource('IMMOBILIER', 'LOCATION');
    expect(section(prepare('LOCATION', loc), 'equipments').fedFilled).toBe(true);
  });
});

describe('Mappeur sinistre : événement lié repris seulement s’il est retenu', () => {
  it('titre et description de l’agenda absents si l’événement est décoché', () => {
    const src = makeSource('IMMOBILIER', 'ASSURANCE_SINISTRE', {
      additionalInfo: { commercial: {}, rental: {}, insurance: {}, claim: { claimEventKey: 'agenda:9' }, updatedAt: null },
      events: [{ ...event(9, { title: 'Fuite chez le voisin M. Dupont', date: '2026-08-14', description: 'Détails privés' }), key: 'agenda:9', source: 'agenda', category: null }],
    });
    const meta = { reference: 'R', generatedAt: '2026-09-28T09:00:00+02:00', preparedBy: null, templateLabel: 'x', zipName: null, label: 'x' };
    const run = (choices: ReturnType<typeof buildDefaultChoices>) =>
      JSON.stringify(mapDossierData('ASSURANCE_SINISTRE', { source: src, plan: planSelection('ASSURANCE_SINISTRE', src, choices, TODAY), resolved: null, meta, today: TODAY }));
    const retained = buildDefaultChoices('ASSURANCE_SINISTRE', src, { today: TODAY });
    expect(run(retained)).toContain('Fuite chez le voisin');
    const dropped = { ...retained, items: retained.items.filter((i) => i.sourceType !== 'agenda') };
    const out = run(dropped);
    expect(out).not.toContain('Fuite chez le voisin');
    expect(out).not.toContain('Détails privés');
    expect(out).toContain('Survenue du sinistre');
  });
});
