/**
 * Lot 114Z (Trello #767, écart E03) — dossiers destinés à des tiers : inclusion VOLONTAIRE de
 * « Notes / Description » (exclue par défaut depuis le lot 113Z, #723).
 *
 *   L114Z-U-CHOIX     option strictement booléenne, origine `user` seulement ; omise ou falsifiée → exclu ;
 *   L114Z-U-SOURCE    texte AFFICHÉ seul, pièces retenues seulement, effacement volontaire exclu ;
 *   L114Z-U-RENDU     les six modèles : absent par défaut (rendu inchangé), présent une fois si coché, échappé ;
 *   L114Z-U-JOB       génération : texte attaché sur choix explicite, instantané vérifiable, panne → échec (fail-closed).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
const state = { asset: null as Row | null, updates: [] as Row[], logs: [] as Row[], owned: true };

vi.mock('@/db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where']) chain[m] = () => chain;
  chain.limit = async () => (state.asset ? [state.asset] : []);
  return { db: chain, pgClient: { unsafe: () => Promise.reject(new Error('pas de base')) } };
});
vi.mock('../generation/repository', () => ({
  MAX_ATTEMPTS: 3,
  updateOwnedGeneration: async (_id: number, _w: string, values: Row) => { if (!state.owned) return false; state.updates.push(values); return true; },
  addGenerationLog: async (_id: number, entry: Row) => { state.logs.push(entry); },
  replaceGenerationItems: async () => {},
  isGenerationCancelRequested: async () => false,
  markGenerationCancelled: async () => false,
}));
const renderMock = vi.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve(undefined));
vi.mock('../render/render-dossier', () => ({ renderDossier: (p: unknown) => renderMock(p) }));
vi.mock('../zip', () => ({ writeDossierZip: async () => 1 }));

const { parseChoicesPayload, includesNotesDescription, buildDefaultChoices, choicesFromLegacyOptions, planSelection } = await import('../data/choices');
const { withNotesDescription } = await import('../data/source');
const { mapDossierData } = await import('../data/mappers');
const { renderDossierHtml, documentNotesOf } = await import('../templates');
const { DocumentNotesSection, DOCUMENT_NOTES_SECTION_TITLE } = await import('../html/components');
const { choicesFromSections } = await import('../preparation/prepare');
const { runGeneration } = await import('../generation/job');
const { NotesDescriptionUnavailableError } = await import('@/services/documents/notes-description/store');
const { makeSource, doc, TODAY } = await import('./fixtures/sources');

import type { DossierCode } from '@/services/exports/catalog';
import type { ExportChoices } from '../data/choices';
import type { ExportSource } from '../data/source';
import type { ResolvedFiles } from '../data/resolved';

const META = { reference: 'VBN-TEST-000001', generatedAt: '2026-09-28T09:14:00+02:00', preparedBy: 'Claire Martin', templateLabel: 'test · v1.0', zipName: null, label: 'Test' };
const NOTE = 'Note corrigée par l’utilisateur — chaudière révisée';
const IA_MASQUEE = 'Ancienne description IA masquée 4471';
const IA_VISIBLE = 'Description T1 visible du DPE';

const MODELES: Array<[DossierCode, 'IMMOBILIER' | 'VEHICULE' | 'OBJET']> = [
  ['VENTE', 'VEHICULE'], ['VENTE', 'IMMOBILIER'], ['LOCATION', 'IMMOBILIER'], ['ASSURANCE_SOUSCRIPTION', 'OBJET'],
  ['ASSURANCE_SINISTRE', 'IMMOBILIER'], ['DOSSIER_COMPLET', 'IMMOBILIER'], ['CIL', 'IMMOBILIER'],
];

/** Trois pièces : note corrigée (IA masquée), description T1 visible, effacement volontaire. */
const source = (code: DossierCode, family: 'IMMOBILIER' | 'VEHICULE' | 'OBJET'): ExportSource => makeSource(family, code, {
  documents: [
    doc({ id: 1, kind: 'FACTURE', title: 'Facture chaudière' }),
    doc({ id: 2, kind: 'DPE', title: 'DPE 2024' }),
    doc({ id: 3, kind: 'GARANTIE', title: 'Garantie constructeur' }),
    doc({ id: 4, kind: 'FACTURE', title: 'Facture non retenue' }),
  ],
});
const VALEURS = new Map([
  [1, { notes: NOTE, description: IA_MASQUEE, notesUserOwned: true, descriptionSource: 'T1' }],
  [2, { notes: null, description: IA_VISIBLE, notesUserOwned: false, descriptionSource: 'T1' }],
  [3, { notes: null, description: 'Description effacée par l’utilisateur', notesUserOwned: true, descriptionSource: 'T1' }],
  [4, { notes: 'Note d’une pièce non retenue', description: null, notesUserOwned: true, descriptionSource: null }],
]);
const choix = (code: DossierCode, s: ExportSource, inclure: boolean): ExportChoices => {
  const r = parseChoicesPayload(code, {
    outputFormat: 'PDF',
    sections: [{ id: 'documents', enabled: true, items: [1, 2, 3].map((id) => ({ sourceType: 'document', sourceId: id, selected: true, mode: 'PDF' })) }],
    ...(inclure ? { includeNotesDescription: true } : {}),
  });
  if (!r.ok) throw new Error('choix invalides');
  void s;
  return r.choices;
};
const resolus = (s: ExportSource): ResolvedFiles => ({
  documents: new Map(s.documents.map((d) => [d.id, { id: d.id, status: 'ok' as const, pages: 1, localPath: `/tmp/d${d.id}` }])),
  photos: new Map(),
});
const rendre = (code: DossierCode, s: ExportSource, c: ExportChoices, resolved: ResolvedFiles = resolus(s)) => {
  const plan = planSelection(code, s, c, TODAY);
  const data = mapDossierData(code, { source: s, plan, resolved, meta: META, today: TODAY });
  const html = renderDossierHtml(code, data as never, { sys: 'SYS/', asset: () => null, stylesheets: [], pageMap: null }).html;
  return { data, html };
};

describe('L114Z-U-CHOIX — option d’inclusion : explicite, booléenne, origine utilisateur', () => {
  it('absente du payload (ancien client, ancienne sauvegarde) → exclu', () => {
    const r = parseChoicesPayload('VENTE', { outputFormat: 'PDF', sections: [] });
    expect(r.ok && r.choices).not.toHaveProperty('includeNotesDescription');
    expect(r.ok && includesNotesDescription(r.choices)).toBe(false);
  });
  it('`true` → incluse ; toute valeur falsifiée (« true », 1, objet, false, null) → exclu', () => {
    const ok = parseChoicesPayload('VENTE', { includeNotesDescription: true });
    expect(ok.ok && ok.choices.includeNotesDescription).toBe(true);
    expect(ok.ok && includesNotesDescription(ok.choices)).toBe(true);
    for (const v of ['true', 1, {}, [], false, null, 'oui']) {
      const r = parseChoicesPayload('VENTE', { includeNotesDescription: v });
      expect(r.ok && includesNotesDescription(r.choices), String(v)).toBe(false);
    }
  });
  it('pré-sélection, tiroir historique et estimation de l’écran : jamais incluse', () => {
    const s = source('VENTE', 'VEHICULE');
    expect(includesNotesDescription(buildDefaultChoices('VENTE', s, { today: TODAY }))).toBe(false);
    expect(includesNotesDescription(choicesFromLegacyOptions('VENTE', s, { customDocIds: [1, 2], includeNotesDescription: true } as never, { outputFormat: 'PDF', today: TODAY }))).toBe(false);
    expect(includesNotesDescription(choicesFromSections([]))).toBe(false);
    // Une origine autre que `user` portant le drapeau (instantané forgé) ne l'active pas.
    expect(includesNotesDescription({ origin: 'default', includeNotesDescription: true })).toBe(false);
    expect(includesNotesDescription({ origin: 'legacy_drawer', includeNotesDescription: true })).toBe(false);
    expect(includesNotesDescription(null)).toBe(false);
  });
});

describe('L114Z-U-SOURCE — texte affiché seul, pièces retenues seulement', () => {
  it('note prioritaire (jamais l’IA masquée), description T1 visible, effacement volontaire exclu, pièce non retenue exclue', () => {
    const s = source('VENTE', 'VEHICULE');
    const docs = withNotesDescription(s.documents, new Set([1, 2, 3]), VALEURS);
    expect(docs.map((d) => [d.id, d.notesDescription ?? null])).toEqual([[1, NOTE], [2, IA_VISIBLE], [3, null], [4, null]]);
    expect(JSON.stringify(docs)).not.toContain(IA_MASQUEE);
    expect(JSON.stringify(docs)).not.toContain('effacée');
    expect(JSON.stringify(docs)).not.toContain('non retenue’');
  });
  it('pièce sans valeurs lues (absente du compte) : aucun texte', () => {
    const s = source('VENTE', 'VEHICULE');
    expect(withNotesDescription(s.documents, new Set([1]), new Map()).every((d) => d.notesDescription === undefined)).toBe(true);
  });
  it('le chargement de la source ne pose jamais le texte (exclu par défaut)', () => {
    expect(source('VENTE', 'VEHICULE').documents.every((d) => !('notesDescription' in d))).toBe(true);
  });
});

describe('L114Z-U-RENDU — les modèles de dossier', () => {
  for (const [code, family] of MODELES) {
    it(`${code} / ${family} : absent par défaut ; coché → texte affiché une fois, jamais l’IA masquée ni la valeur effacée`, () => {
      const base = source(code, family);
      // Même avec le texte posé sur la source, sans rendu de la section rien n'apparaît ailleurs (index, annexes, résumé).
      const sans = rendre(code, base, choix(code, base, false));
      expect(sans.html).not.toContain(DOCUMENT_NOTES_SECTION_TITLE);
      for (const t of [NOTE, IA_MASQUEE, IA_VISIBLE]) expect(sans.html).not.toContain(t);

      const c = choix(code, base, true);
      const retenues = new Set(planSelection(code, base, c, TODAY).documents.map((pd) => pd.doc.id));
      const avec = rendre(code, { ...base, documents: withNotesDescription(base.documents, retenues, VALEURS) }, c);
      const attendues = [...retenues].filter((id) => id === 1 || id === 2);
      expect(attendues.sort()).toEqual([1, 2]); // les deux pièces à texte sont retenues par chaque modèle
      expect(avec.html).toContain(DOCUMENT_NOTES_SECTION_TITLE);
      if (retenues.has(1)) expect(avec.html.split('Note corrigée par l’utilisateur').length - 1).toBe(1);
      if (retenues.has(2)) expect(avec.html.split(IA_VISIBLE).length - 1).toBe(1);
      expect(avec.html).not.toContain(IA_MASQUEE);
      expect(avec.html).not.toContain('Description effacée');
      expect(avec.html).not.toContain('pièce non retenue');
      // Données exactes transmises au modèle (instantané) : `note` sur les seules pièces à texte.
      const notes = documentNotesOf((avec.data as { documents?: never }).documents);
      expect(notes.map((n) => n.text).sort()).toEqual(attendues.map((id) => (id === 1 ? NOTE : IA_VISIBLE)).sort());
    });
  }
  it('documents multiples : une carte par pièce, dans l’ordre du dossier ; pièce inutilisable exclue', () => {
    const base = source('VENTE', 'VEHICULE');
    const c = choix('VENTE', base, true);
    const s = { ...base, documents: withNotesDescription(base.documents, new Set([1, 2, 3]), VALEURS) };
    const tout = rendre('VENTE', s, c);
    expect(documentNotesOf((tout.data as { documents?: never }).documents)).toHaveLength(2);
    const r = resolus(s);
    r.documents.set(1, { id: 1, status: 'corrupted', pages: null });
    const partiel = rendre('VENTE', s, c, r);
    expect(partiel.html).not.toContain('Note corrigée');
    expect(partiel.html).toContain(IA_VISIBLE);
  });
  it('texte échappé (aucune balise injectable), sauts de ligne conservés, jamais tronqué', () => {
    const long = `${'x'.repeat(4990)}FIN`;
    const html = DocumentNotesSection([
      { title: 'Doc <b>', text: 'ligne 1\n<script>alert(1)</script>' },
      { title: 'Long', text: long },
    ]);
    expect(html).toContain('Doc &lt;b&gt;');
    expect(html).toContain('ligne 1<br>&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain(long);
    expect(DocumentNotesSection([])).toBe('');
    expect(DocumentNotesSection(null)).toBe('');
    expect(DocumentNotesSection([{ title: 'Sans texte', text: '   ' }])).toBe('');
  });
});

describe('L114Z-U-JOB — génération', () => {
  const NOW = new Date('2026-09-28T07:14:00Z');
  const s0 = source('VENTE', 'VEHICULE');
  const loadSource = vi.fn(async () => ({ ...s0, preparedBy: 'Claire Martin' }));
  const attachNotes = vi.fn(async (src: ExportSource, _a: number, ids: readonly number[]) => ({ ...src, documents: withNotesDescription(src.documents, new Set(ids), VALEURS) }));
  const deps = {
    upload: vi.fn(async () => undefined), notifySupport: vi.fn(async () => true), loadSource: loadSource as never,
    attachNotes: attachNotes as never, scheduleOrphans: vi.fn(async () => 1) as never, now: () => NOW,
  };
  const row = (choices: ExportChoices | null, over: Row = {}) => ({
    id: 7, publicId: 'p', assetId: 5, accountId: 10, userId: 2, exportType: 'VENTE', status: 'generating', generationAttemptCount: 1, createdAt: NOW,
    snapshotJson: { request: { outputFormat: 'PDF', requestedAt: NOW.toISOString(), ...(choices ? { choices } : {}) } }, ...over,
  }) as never;
  const rendered = () => ({
    pdf: Buffer.from('%PDF-1.7'), pageCount: 3, passes: 2, data: { export: {} }, plan: { sections: {} }, templateVersion: 'vente-v1', fileBaseName: 'Verebona_Vente',
    zipEntries: [], items: [], partial: false, warnings: [], counts: { integratedPdf: 3, zip: 0, excluded: 0, photos: 0 },
  });
  beforeEach(() => {
    state.asset = { id: 5, accountId: 10, category: 'VEHICULE', subtype: 'Vélo', deletedAt: null };
    state.updates = []; state.logs = []; state.owned = true;
    renderMock.mockReset(); renderMock.mockResolvedValue(rendered()); attachNotes.mockClear(); loadSource.mockClear();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('option non cochée (ou demande antérieure sans le champ) : aucune lecture du texte, instantané « non incluses »', async () => {
    for (const c of [choix('VENTE', s0, false), null]) {
      attachNotes.mockClear(); state.updates = [];
      expect(await runGeneration(row(c), 'w1', { deps })).toBe('ready');
      expect(attachNotes).not.toHaveBeenCalled();
      const src = (renderMock.mock.calls.at(-1)![0] as { source: ExportSource }).source;
      expect(src.documents.every((d) => !d.notesDescription)).toBe(true);
      expect((state.updates.at(-1)!.snapshotJson as Row).notesDescription).toEqual({ included: false, documents: 0 });
    }
  });
  it('option cochée : texte attaché aux seules pièces retenues, borné au compte de la génération, choix figé et vérifiable', async () => {
    expect(await runGeneration(row(choix('VENTE', s0, true)), 'w1', { deps })).toBe('ready');
    expect(attachNotes).toHaveBeenCalledTimes(1);
    expect(attachNotes.mock.calls[0][1]).toBe(10);
    expect([...attachNotes.mock.calls[0][2]].sort()).toEqual([1, 2, 3]);
    const src = (renderMock.mock.calls[0][0] as { source: ExportSource }).source;
    expect(src.documents.map((d) => d.notesDescription ?? null)).toEqual([NOTE, IA_VISIBLE, null, null]);
    const snap = state.updates.at(-1)!.snapshotJson as Row;
    expect(snap.notesDescription).toEqual({ included: true, documents: 2 });
    expect((snap.choices as Row).includeNotesDescription).toBe(true);
    // Journal : un nombre, jamais le texte.
    const j = JSON.stringify(state.logs);
    expect(j).toContain('Notes / Description des documents : inclusion demandée.');
    expect(j).not.toContain('chaudière révisée');
  });
  it('instantané forgé (origine autre que `user`) : jamais inclus', async () => {
    const forge = { ...choix('VENTE', s0, true), origin: 'default' } as ExportChoices;
    expect(await runGeneration(row(forge), 'w1', { deps })).toBe('ready');
    expect(attachNotes).not.toHaveBeenCalled();
  });
  it('panne de métadonnées (schéma, SQL, délai) : la génération ÉCHOUE — aucun dossier produit, aucun texte de repli', async () => {
    attachNotes.mockRejectedValue(new NotesDescriptionUnavailableError('READ_FAILED'));
    expect(await runGeneration(row(choix('VENTE', s0, true), { generationAttemptCount: 3 }), 'w1', { deps })).toBe('failed');
    expect(renderMock).not.toHaveBeenCalled();
    expect(deps.upload).not.toHaveBeenCalled();
    expect(state.updates.at(-1)).toMatchObject({ status: 'failed', errorCode: 'DB_ERROR' });
    const payload = JSON.parse(String(state.updates.at(-1)!.errorPayload));
    expect(payload).toMatchObject({ step: 'lock_snapshot' });
    expect(payload.technicalMessage).toMatch(/métadonnées « Notes \/ Description » indisponibles \(READ_FAILED\)/);
  });
});
