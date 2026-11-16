/**
 * Passage 114AB (Trello #753, CDC T2 §14.3 W28) — CHOISIR LE CONTENU d'un export demandé par écrit.
 *
 * Avant ce passage, toute demande partait avec les présélections du service d'export. La phrase peut
 * maintenant en dire le contenu, dans un périmètre ÉTROIT et honnête :
 *
 *   E01  « avec / sans les photos », « avec / sans les équipements » sont compris, et seulement eux ;
 *   E02  ce qui est dit est transmis au service dans `options` (le champ du tiroir), et rien de plus ;
 *   E03  une consigne qu'un dossier ne sait pas honorer est DITE, et rien n'est lancé ;
 *   E04  la réponse annonce le contenu retenu ; sans consigne, rien ne change (non-régression).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) }, db: {} }));

const { answerExportRequest, parseExportRequest } = await import('../../export-request');
type Deps = import('../../export-request').ExportDeps;
type Issue = import('../../export-request').ExportIssue;

const input = (message: string) => ({ accountId: 1, userId: 2, message, planType: 'PREMIUM', clientRequestId: 'x', locale: 'fr-FR' } as never);
const CLIO = { id: 7, name: 'Clio', category: 'VEHICULE' };
const MAISON = { id: 9, name: 'Maison', category: 'IMMOBILIER' };

const deps = (issue: Issue, vu: { demandes: unknown[] } = { demandes: [] }): Deps => ({
  async findAssets(_a, w) { return [CLIO, MAISON].filter((x) => w.every((m) => x.name.toLowerCase().includes(m))); },
  async getAsset() { return CLIO; },
  async getAssetCategory(_a, id) { return (id === 9 ? MAISON : CLIO).category; },
  rateLimited() { return null; },
  async request(p) { vu.demandes.push(p); return issue; },
  retentionDays: 30,
  assetNotFoundMessage: 'Bien introuvable.',
});
const PRET: Issue = { kind: 'raw_ready', downloadHref: '/api/export-generations/abc/download?file=zip' };
const EN_FILE: Issue = { kind: 'queued', reused: false, warnings: [], generationId: 41 };

describe('L114AB-E01 — ce que la phrase dit du contenu', () => {
  it.each([
    ['Exporte les données brutes de la Clio sans les photos', { photos: false }],
    ['Exporte les données brutes de la Clio avec les photos', { photos: true }],
    ['Exporte les données brutes de la Clio sans les équipements', { equipments: false }],
    ['Exporte les données brutes de la Clio avec les équipements', { equipments: true }],
    ['Exporte les données brutes de la Clio sans les photos et sans les équipements', { photos: false, equipments: false }],
    ['Exporte les données brutes de la Clio', {}],
  ])('%s', (phrase, content) => {
    expect(parseExportRequest(phrase)?.content).toEqual(content);
  });

  it('le bien reste reconnu malgré la consigne de contenu', () => {
    expect(parseExportRequest('Exporte les données brutes de la Clio sans les photos')?.assetWords).toEqual(['clio']);
  });

  it('aucune autre consigne de contenu n’est inventée', () => {
    // Les documents d'un export ne se choisissent pas dans une phrase (ils se cochent dans l'onglet « Exports »).
    expect(parseExportRequest('Exporte les données brutes de la Clio avec la facture Norauto seulement')?.content).toEqual({});
  });
});

describe('L114AB-E02 — ce qui est dit est transmis, et rien de plus', () => {
  it('le contenu demandé accompagne la demande', async () => {
    const vu = { demandes: [] as unknown[] };
    await answerExportRequest(input('Exporte les données brutes de la Clio sans les photos'), deps(PRET, vu));
    expect(vu.demandes).toEqual([{ accountId: 1, userId: 2, assetId: 7, code: 'EXPORT_BRUT', zip: false, content: { photos: false } }]);
  });

  it('un dossier accepte la consigne sur les photos', async () => {
    const vu = { demandes: [] as unknown[] };
    const r = await answerExportRequest(input('Génère le dossier complet de la maison sans les photos'), deps(EN_FILE, vu));
    expect(vu.demandes).toEqual([{ accountId: 1, userId: 2, assetId: 9, code: 'DOSSIER_COMPLET', zip: false, content: { photos: false } }]);
    expect(r!.kind).toBe('done');
  });

  it('sans consigne, aucune option n’est posée (présélections du service, comme avant)', async () => {
    const vu = { demandes: [] as unknown[] };
    await answerExportRequest(input('Exporte les données brutes de la Clio'), deps(PRET, vu));
    expect((vu.demandes[0] as { content: unknown }).content).toEqual({});
  });
});

describe('L114AB-E03 — une consigne qu’un dossier ne sait pas honorer est dite', () => {
  it('les équipements d’un dossier prêt à l’emploi : rien n’est lancé, l’onglet « Exports » est proposé', async () => {
    const vu = { demandes: [] as unknown[] };
    const r = await answerExportRequest(input('Génère le dossier complet de la maison sans les équipements'), deps(EN_FILE, vu));
    expect(vu.demandes).toEqual([]);
    expect(r).toMatchObject({
      kind: 'need_info',
      message: 'Pour choisir les équipements d’un dossier prêt à l’emploi, passez par l’onglet « Exports » de Maison. Rien n’a été lancé.',
      exportAreaAssetId: 9,
    });
  });
});

describe('L114AB-E04 — la réponse annonce le contenu retenu', () => {
  it('données brutes : la phrase dit ce qui est inclus ou non', async () => {
    const r = await answerExportRequest(input('Exporte les données brutes de la Clio sans les photos'), deps(PRET));
    expect(r!.message).toBe('L’export « Export données brutes » de Clio est prêt. Il reste disponible 30 jours dans les exports de ce bien. Les photos ne sont pas incluses.');
  });

  it('dossier : la phrase dit ce qui est inclus', async () => {
    const r = await answerExportRequest(input('Génère le dossier complet de la maison avec les photos'), deps(EN_FILE));
    expect(r!.message).toContain('Les photos sont incluses.');
  });

  it('non-régression : sans consigne, le texte est exactement celui d’avant', async () => {
    const r = await answerExportRequest(input('Exporte les données brutes de la Clio'), deps(PRET));
    expect(r!.message).toBe('L’export « Export données brutes » de Clio est prêt. Il reste disponible 30 jours dans les exports de ce bien.');
  });
});
