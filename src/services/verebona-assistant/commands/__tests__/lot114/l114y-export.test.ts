/**
 * Lot 114Y (Trello #753, CDC T2 §9.10, §12.5, §14.3 W28, D27) — EXPORT DEMANDÉ DEPUIS L'ASSISTANT.
 *
 *   X01  reconnaissance : verbe d'action en tête + export nommé, d'après les libellés du catalogue des exports ;
 *        une question ou une autre commande n'est jamais une demande d'export ;
 *   X02  génération DIRECTE, sans plan ni confirmation : données brutes prêtes (carte de téléchargement),
 *        dossier mis en file (carte de suivi) ;
 *   X03  jamais un bien ni un export choisi au hasard : une question, et rien n'est lancé ;
 *   X04  les droits sont ceux du service d'export : refus repris tel quel, bouton vers les exports du bien
 *        seulement si le refus se lève dans la préparation du dossier ; limitation de débit respectée ;
 *   X05  carte : lien de téléchargement admis seulement vers la route de téléchargement des exports.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) }, db: {} }));

const { parseExportRequest, answerExportRequest, safeExportDownloadHref, exportLabel } = await import('../../export-request');
const { parseCommands } = await import('../../parser');
const { isExportDownloadHref, objectsFromCards, DOWNLOAD_CTA } = await import('@/lib/verebona/space');
type Deps = import('../../export-request').ExportDeps;
type Issue = import('../../export-request').ExportIssue;

const clio = { id: 7, name: 'Clio', city: null };
const maison = { id: 9, name: 'Maison', city: 'Lyon' };
const input = (message: string, extra: Record<string, unknown> = {}) =>
  ({ accountId: 1, userId: 2, planType: 'PREMIUM', message, clientRequestId: 'x', locale: 'fr-FR', ...extra }) as never;

const deps = (issue: Issue | null, vu: { demandes: unknown[] } = { demandes: [] }, over: Partial<Deps> = {}): Deps => ({
  async findAssets(_a, w) { return [clio, maison].filter((b) => w.some((x) => b.name.toLowerCase().includes(x))); },
  async getAsset(_a, id) { return [clio, maison].find((b) => b.id === id) ?? null; },
  async getAssetCategory(_a, id) { return id === 7 ? 'VEHICULE' : id === 9 ? 'IMMOBILIER' : null; },
  rateLimited: () => null,
  async request(p) { vu.demandes.push(p); return issue; },
  retentionDays: 30,
  assetNotFoundMessage: 'Bien introuvable.',
  ...over,
});

describe('L114Y-X01 — reconnaissance d’une demande d’export', () => {
  it.each([
    ['Exporte les données brutes de la Clio', ['EXPORT_BRUT'], ['clio']],
    ['Génère le dossier complet de la maison', ['DOSSIER_COMPLET'], ['maison']],
    ['Prépare le kit de mise en vente de la Clio', ['VENTE'], ['clio']],
    ['Peux-tu télécharger le dossier de location de l’appartement', ['LOCATION'], ['appartement']],
    ['Crée le carnet d’information du logement pour la maison', ['CIL'], ['maison']],
    ['Génère le CIL de la maison', ['CIL'], ['maison']],
    ['Prépare le dossier assurance sinistre de la Clio', ['ASSURANCE_SINISTRE'], ['clio']],
    ['Fais-moi un export brut de la Clio', ['EXPORT_BRUT'], ['clio']],
  ])('« %s »', (phrase, codes, assetWords) => {
    expect(parseExportRequest(phrase)).toMatchObject({ codes, assetWords, assetFromContext: false });
  });

  it('« assurance » seul : deux dossiers possibles, à départager', () => {
    expect(parseExportRequest('Prépare le dossier assurance de la Clio')?.codes).toEqual(['ASSURANCE_SOUSCRIPTION', 'ASSURANCE_SINISTRE']);
  });

  it('export non nommé : à demander (« exporte … », ou un nom d’export explicite)', () => {
    expect(parseExportRequest('Exporte la Clio')).toMatchObject({ codes: [], assetWords: ['clio'] });
    expect(parseExportRequest('Prépare un dossier pour la Clio')).toMatchObject({ codes: [], assetWords: ['clio'] });
  });

  it('« ce bien », « cette maison » : bien de la page ou de la conversation', () => {
    expect(parseExportRequest('Génère le dossier complet de ce bien')).toMatchObject({ codes: ['DOSSIER_COMPLET'], assetWords: [], assetFromContext: true });
    expect(parseExportRequest('Exporte les données brutes de cette maison')).toMatchObject({ codes: ['EXPORT_BRUT'], assetWords: [], assetFromContext: true });
  });

  it('« en ZIP », « avec les fichiers » : fichiers demandés avec le dossier', () => {
    expect(parseExportRequest('Génère le dossier complet de la Clio en ZIP')).toMatchObject({ codes: ['DOSSIER_COMPLET'], zip: true, assetWords: ['clio'] });
    expect(parseExportRequest('Génère le dossier complet de la Clio')?.zip).toBe(false);
  });

  it.each([
    'Comment exporter le dossier complet de la Clio ?',
    'Exporter le dossier complet, c’est possible ?',
    'Quels dossiers puis-je préparer pour la Clio',
    'Prépare un rappel vidange pour la Clio',
    'Crée une voiture nommée Mégane',
    'Supprime le dossier complet de la Clio',
    'Je voudrais un dossier complet',
    'Où est mon export ?',
  ])('« %s » n’est pas une demande d’export', (phrase) => {
    expect(parseExportRequest(phrase)).toBeNull();
  });

  it('non-régression : une demande d’export n’est reconnue par aucune commande d’écriture', () => {
    for (const phrase of ['Exporte les données brutes de la Clio', 'Génère le dossier complet de la maison', 'Crée le dossier complet de la Clio']) {
      expect(parseCommands(phrase, '2026-11-13')).toBeNull();
    }
  });

  it('les libellés sont ceux du catalogue des exports', () => {
    expect(exportLabel('EXPORT_BRUT')).toBe('Export données brutes');
    expect(exportLabel('DOSSIER_COMPLET')).toBe('Dossier complet du bien');
  });
});

describe('L114Y-X02 — génération directe, sans plan ni confirmation', () => {
  it('données brutes : la demande part tout de suite ; carte de téléchargement, identifiée par le bien', async () => {
    const vu = { demandes: [] as unknown[] };
    const r = await answerExportRequest(input('Exporte les données brutes de la Clio'),
      deps({ kind: 'raw_ready', downloadHref: '/api/export-generations/abc-123/download?file=zip' }, vu));
    expect(vu.demandes).toEqual([{ accountId: 1, userId: 2, assetId: 7, code: 'EXPORT_BRUT', zip: false, content: {} }]);
    expect(r).toMatchObject({ kind: 'done', code: 'EXPORT_BRUT' });
    expect(r!.message).toBe('L’export « Export données brutes » de Clio est prêt. Il reste disponible 30 jours dans les exports de ce bien.');
    expect(r!.resultGroups).toEqual([{
      type: 'document', label: 'Documents', total: 1, hasMore: false, moreHref: null,
      items: [{ id: 'asset_7', typeLabel: 'Export', title: 'Export données brutes', subtitle: 'Clio', date: null, status: 'Prêt', excerpt: null, href: '/api/export-generations/abc-123/download?file=zip' }],
    }]);
    // Aucun plan, aucune confirmation : la réponse ne porte ni l'un ni l'autre.
    expect(r).not.toHaveProperty('preview');
    expect(r).not.toHaveProperty('plan');
  });

  it('données brutes sans lien de téléchargement : la carte mène aux exports du bien', async () => {
    const r = await answerExportRequest(input('Exporte les données brutes de la Clio'), deps({ kind: 'raw_ready', downloadHref: null }));
    expect(r!.resultGroups![0].items[0].href).toBe('/assets/7?tab=exports');
  });

  it('dossier : mis en file, suivi dans les exports du bien ; alertes du service ajoutées', async () => {
    const vu = { demandes: [] as unknown[] };
    const r = await answerExportRequest(input('Génère le dossier complet de la maison en ZIP'),
      deps({ kind: 'queued', reused: false, warnings: ['Le dossier est volumineux.'], generationId: 41 }, vu));
    expect(vu.demandes).toEqual([{ accountId: 1, userId: 2, assetId: 9, code: 'DOSSIER_COMPLET', zip: true, content: {} }]);
    expect(r!.kind).toBe('done');
    expect(r!.message).toBe('Le dossier « Dossier complet du bien » de Maison est en cours de préparation. Vous le retrouverez, dès qu’il sera prêt, dans les exports de ce bien. Le dossier est volumineux.');
    // Passage 114AA : la carte porte l'identifiant de la GÉNÉRATION (« export_41 ») et non celui du bien — son
    // état est relu au retour dans la conversation (« En préparation » → « Prêt »).
    expect(r!.resultGroups![0].items[0]).toMatchObject({ id: 'export_41', title: 'Dossier complet du bien', subtitle: 'Maison', status: 'En préparation', href: '/assets/9?tab=exports' });
  });

  it('même dossier déjà en file (double demande) : c’est dit, rien n’est présenté comme nouveau', async () => {
    const r = await answerExportRequest(input('Génère le dossier complet de la maison'), deps({ kind: 'queued', reused: true, warnings: [], generationId: 42 }));
    expect(r!.message).toContain('est déjà en cours de préparation');
  });

  it('bien de la page ou de la conversation quand la phrase n’en nomme pas', async () => {
    const vu = { demandes: [] as Array<{ assetId: number }> };
    await answerExportRequest(input('Exporte les données brutes de ce bien', { pageContext: { assetId: '9' } }), deps({ kind: 'raw_ready', downloadHref: null }, vu));
    await answerExportRequest(input('Exporte les données brutes', { reference: { type: 'asset', id: 7, method: 'thread' } }), deps({ kind: 'raw_ready', downloadHref: null }, vu));
    expect(vu.demandes.map((d) => d.assetId)).toEqual([9, 7]);
  });

  it('une phrase qui n’est pas une demande d’export : null, rien n’est lu ni lancé', async () => {
    const vu = { demandes: [] as unknown[] };
    expect(await answerExportRequest(input('Comment exporter le dossier complet de la Clio ?'), deps({ kind: 'raw_ready', downloadHref: null }, vu))).toBeNull();
    expect(vu.demandes).toEqual([]);
  });
});

describe('L114Y-X03 — jamais un bien ni un export choisi au hasard', () => {
  const rien = { kind: 'raw_ready', downloadHref: null } as const;

  it('aucun bien désigné : question, rien n’est lancé', async () => {
    const vu = { demandes: [] as unknown[] };
    const r = await answerExportRequest(input('Exporte les données brutes'), deps(rien, vu));
    expect(r).toEqual({ kind: 'need_info', message: 'Pour quel bien voulez-vous cet export ?' });
    expect(vu.demandes).toEqual([]);
  });

  it('bien introuvable : question, jamais un autre bien', async () => {
    const vu = { demandes: [] as unknown[] };
    const r = await answerExportRequest(input('Exporte les données brutes de la Twingo'), deps(rien, vu));
    expect(r).toEqual({ kind: 'need_info', message: 'Je n’ai pas trouvé ce bien dans votre compte. Pour quel bien voulez-vous cet export ?' });
    expect(vu.demandes).toEqual([]);
  });

  it('plusieurs biens : ils sont listés, aucun n’est choisi', async () => {
    const vu = { demandes: [] as unknown[] };
    const r = await answerExportRequest(input('Exporte les données brutes de la Clio'), deps(rien, vu, { async findAssets() { return [clio, { id: 8, name: 'Clio 2', city: 'Paris' }]; } }));
    expect(r).toEqual({ kind: 'need_info', message: 'Plusieurs biens correspondent : Clio, Clio 2 (Paris). Précisez lequel dans votre demande.' });
    expect(vu.demandes).toEqual([]);
  });

  it('deux dossiers possibles : question avec les deux libellés du catalogue', async () => {
    const vu = { demandes: [] as unknown[] };
    const r = await answerExportRequest(input('Prépare le dossier assurance de la Clio'), deps(rien, vu));
    expect(r).toEqual({ kind: 'need_info', message: 'Quel export voulez-vous pour Clio ? « Assurance — souscription / mise à jour », « Assurance — sinistre / indemnisation ».' });
    expect(vu.demandes).toEqual([]);
  });

  it('export non nommé : question avec les exports possibles pour CE bien (famille)', async () => {
    const r = await answerExportRequest(input('Exporte la Clio'), deps(rien));
    expect(r!.kind).toBe('need_info');
    // Véhicule : ni Carnet d'information du logement, ni dossier de location.
    expect(r!.message).toBe('Quel export voulez-vous pour Clio ? « Export données brutes », « Dossier complet du bien », « Kit de mise en vente », « Assurance — souscription / mise à jour », « Assurance — sinistre / indemnisation ».');
    const m = await answerExportRequest(input('Exporte la maison'), deps(rien));
    expect(m!.message).toContain('« Carnet d\'information du logement »');
    expect(m!.message).toContain('« Dossier de mise en location »');
  });
});

describe('L114Y-X04 — les droits sont ceux du service d’export', () => {
  it('offre sans dossiers : refus du service repris tel quel, aucun bouton, aucune carte', async () => {
    const r = await answerExportRequest(input('Génère le dossier complet de la Clio'),
      deps({ kind: 'refused', status: 403, message: 'Cette fonctionnalité est disponible avec Premium et Premium Duo.' }));
    expect(r).toEqual({
      kind: 'refused', code: 'DOSSIER_COMPLET', exportAreaAssetId: null,
      message: '« Dossier complet du bien » pour Clio n’a pas été lancé. Cette fonctionnalité est disponible avec Premium et Premium Duo.',
    });
  });

  it.each([422, 409])('refus à lever dans la préparation du dossier (%s) : bouton vers les exports du bien', async (status) => {
    const r = await answerExportRequest(input('Génère le dossier complet de la Clio'), deps({ kind: 'refused', status, message: 'Réduisez le contenu sélectionné.' }));
    expect(r).toMatchObject({ kind: 'refused', exportAreaAssetId: 7 });
    expect(r!.resultGroups).toBeUndefined();
  });

  it('limitation de débit : message du service, rien n’est lancé', async () => {
    const vu = { demandes: [] as unknown[] };
    const r = await answerExportRequest(input('Exporte les données brutes de la Clio'),
      deps({ kind: 'raw_ready', downloadHref: null }, vu, { rateLimited: () => 'Trop de demandes de génération en peu de temps. Patientez une minute avant de réessayer.' }));
    expect(r).toEqual({ kind: 'refused', code: 'EXPORT_BRUT', message: 'Trop de demandes de génération en peu de temps. Patientez une minute avant de réessayer.' });
    expect(vu.demandes).toEqual([]);
  });

  it('bien inaccessible pour le service d’export, ou génération en échec : message du service', async () => {
    expect(await answerExportRequest(input('Exporte les données brutes de la Clio'), deps(null))).toEqual({ kind: 'refused', code: 'EXPORT_BRUT', message: 'Bien introuvable.' });
    expect(await answerExportRequest(input('Exporte les données brutes de la Clio'), deps({ kind: 'raw_failed', message: 'La génération du dossier a échoué.' })))
      .toEqual({ kind: 'refused', code: 'EXPORT_BRUT', message: 'La génération du dossier a échoué.' });
  });
});

describe('L114Y-X05 — carte de téléchargement', () => {
  it('seule la route de téléchargement des exports est admise comme lien de téléchargement', () => {
    expect(safeExportDownloadHref('/api/export-generations/3f2a-9b/download?file=zip')).toBe('/api/export-generations/3f2a-9b/download?file=zip');
    for (const h of ['https://exemple.test/x.zip', '//exemple.test/x', '/api/export-generations/../x/download?file=zip', '/api/autre/abc/download?file=zip', null, 12]) {
      expect(safeExportDownloadHref(h)).toBeNull();
    }
  });

  it('interface : une carte de téléchargement se présente « Télécharger », les autres cartes sont inchangées', () => {
    expect(isExportDownloadHref('/api/export-generations/abc/download?file=zip')).toBe(true);
    expect(isExportDownloadHref('/assets/7?tab=exports')).toBe(false);
    expect(isExportDownloadHref(null)).toBe(false);
    const carte = (href: string) => ({ id: 'asset_7', typeLabel: 'Export', title: 'Export données brutes', subtitle: 'Clio', date: null, status: 'Prêt', excerpt: null, href, groupType: 'document' as const });
    expect(objectsFromCards([carte('/api/export-generations/abc/download?file=zip')] as never)[0].cta).toBe(DOWNLOAD_CTA);
    expect(objectsFromCards([carte('/assets/7?tab=exports')] as never)[0].cta).toBe('Ouvrir');
  });
});
