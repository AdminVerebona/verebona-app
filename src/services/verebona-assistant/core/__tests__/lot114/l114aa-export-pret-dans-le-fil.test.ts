/**
 * Passage 114AA (Trello #753, CDC T2 §9.10, §14.3 W28, §19.10, §22.1) — « VOTRE DOSSIER EST PRÊT »
 * ANNONCÉ DANS LA CONVERSATION, SANS AUCUNE TÂCHE DE FOND.
 *
 *   A01  repérage des cartes à relire : seules les cartes « En préparation » qui portent une GÉNÉRATION ;
 *        aucune carte de ce genre → AUCUNE requête (le coût n'est pas imposé aux demandes ordinaires) ;
 *   A02  état relu : « Prêt » et son lien de téléchargement, « Échec », « Expiré » ; en file / en cours : rien ;
 *   A03  application aux cartes d'un message : seules les cartes concernées changent, rien d'autre n'est touché ;
 *   A04  isolation du compte : le lecteur est toujours appelé avec le compte de la session ;
 *   A05  une relecture impossible laisse les cartes telles qu'elles ont été enregistrées (ne lève jamais).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) }, db: {} }));

const {
  CARTE_EXPORT_EN_PREPARATION, CARTE_EXPORT_PRET, CARTE_EXPORT_ECHEC, CARTE_EXPORT_EXPIRE,
  generationsEnPreparation, etatCarteExport, appliquerEtatsExport, rafraichirCartesExport, misesAJourDuFil, lireEtats,
} = await import('../../export-card-state');
type Ligne = import('../../export-card-state').LigneGeneration;
type Groupe = import('../../result-groups').ResultGroup;

const carte = (id: string, status: string | null, href: string | null = '/assets/7?tab=exports') => ({
  id, typeLabel: 'Export', title: 'Dossier complet du bien', subtitle: 'Clio', date: null, status, excerpt: null, href,
});
const groupe = (...items: ReturnType<typeof carte>[]): Groupe =>
  ({ type: 'document', label: 'Documents', items, total: items.length, hasMore: false, moreHref: null }) as unknown as Groupe;

const ligne = (over: Partial<Ligne> = {}): Ligne =>
  ({ id: 41, publicId: 'pub-41', status: 'queued', outputPayload: null, expiresAt: null, ...over });

/** Normalisation injectée : elle imite celle de l'onglet « Exports » sans charger ses modules. */
const norm = (statut: string, pdf: string | null = null, zip: string | null = null) => () => ({ statut, pdf, zip });

describe('L114AA-A01 — repérage borné, aucune requête sans carte en préparation', () => {
  it('ne retient que les cartes « En préparation » qui portent une génération', () => {
    expect(generationsEnPreparation([groupe(
      carte('export_41', CARTE_EXPORT_EN_PREPARATION),
      // Déjà prêt : plus rien à relire.
      carte('export_42', CARTE_EXPORT_PRET),
      // Carte de l'export de données brutes : identifiée par le bien, jamais relue comme une génération.
      carte('asset_7', CARTE_EXPORT_EN_PREPARATION),
      // Identifiant d'une autre famille, ou illisible.
      carte('doc_12', CARTE_EXPORT_EN_PREPARATION),
      carte('export_', CARTE_EXPORT_EN_PREPARATION),
    )])).toEqual([41]);
  });

  it('plusieurs messages, même génération : un seul identifiant ; aucune carte : liste vide', () => {
    expect(generationsEnPreparation([
      groupe(carte('export_41', CARTE_EXPORT_EN_PREPARATION)),
      groupe(carte('export_41', CARTE_EXPORT_EN_PREPARATION), carte('export_50', CARTE_EXPORT_EN_PREPARATION)),
    ])).toEqual([41, 50]);
    expect(generationsEnPreparation([])).toEqual([]);
    expect(generationsEnPreparation([groupe()])).toEqual([]);
    expect(generationsEnPreparation([{ type: 'document', label: 'D', total: 0, hasMore: false, moreHref: null } as unknown as Groupe])).toEqual([]);
  });

  it('aucune carte « En préparation » : le lecteur de générations n’est PAS appelé', async () => {
    const lecteur = vi.fn(async () => []);
    const messages = [
      { id: 1, result_groups_json: [groupe(carte('export_41', CARTE_EXPORT_PRET, '/api/export-generations/pub-41/download?file=pdf'))] },
      { id: 2, result_groups_json: null },
    ];
    expect(await rafraichirCartesExport(messages, 1, lecteur)).toBe(messages);
    expect(lecteur).not.toHaveBeenCalled();
    // Fil sans aucune carte : pas davantage.
    expect(await rafraichirCartesExport([{ id: 3, result_groups_json: [] }], 1, lecteur)).toHaveLength(1);
    expect(lecteur).not.toHaveBeenCalled();
    expect(await misesAJourDuFil({ accountId: 1, userId: 2, conversationId: 3 }, lecteur, [])).toEqual([]);
    expect(lecteur).not.toHaveBeenCalled();
  });
});

describe('L114AA-A02 — état relu d’une génération', () => {
  it('prête : « Prêt » et le lien de téléchargement de la route existante (PDF d’abord, sinon ZIP)', () => {
    expect(etatCarteExport(ligne({ status: 'ready' }), norm('ready', 'k.pdf', 'k.zip')))
      .toEqual({ status: CARTE_EXPORT_PRET, href: '/api/export-generations/pub-41/download?file=pdf' });
    expect(etatCarteExport(ligne({ status: 'ready' }), norm('ready', null, 'k.zip')))
      .toEqual({ status: CARTE_EXPORT_PRET, href: '/api/export-generations/pub-41/download?file=zip' });
    // Générée partiellement : téléchargeable, donc prête (même règle que l'onglet « Exports »).
    expect(etatCarteExport(ligne({ status: 'partial' }), norm('partial', 'k.pdf')))
      .toEqual({ status: CARTE_EXPORT_PRET, href: '/api/export-generations/pub-41/download?file=pdf' });
    // Prête mais sans fichier connu : le statut change, aucun lien n'est deviné.
    expect(etatCarteExport(ligne({ status: 'ready' }), norm('ready'))).toEqual({ status: CARTE_EXPORT_PRET, href: null });
  });

  it('échec, expiration : c’est dit, sans lien', () => {
    expect(etatCarteExport(ligne({ status: 'failed' }), norm('failed'))).toEqual({ status: CARTE_EXPORT_ECHEC, href: null });
    expect(etatCarteExport(ligne({ status: 'ready' }), norm('expired'))).toEqual({ status: CARTE_EXPORT_EXPIRE, href: null });
  });

  it('en file, en cours, supprimée ou remplacée : la carte garde « En préparation »', () => {
    for (const s of ['queued', 'generating', 'deleted', 'cancelled']) {
      expect(etatCarteExport(ligne({ status: s }), norm(s))).toBeNull();
    }
  });

  it('lien de téléchargement : seule la route des exports, avec l’identifiant public de LA génération relue', () => {
    const e = etatCarteExport(ligne({ publicId: 'abc_DEF-123', status: 'ready' }), norm('ready', 'k.pdf'));
    expect(e!.href).toBe('/api/export-generations/abc_DEF-123/download?file=pdf');
  });
});

describe('L114AA-A03 — application aux cartes d’un message', () => {
  const etats = new Map([[41, { status: CARTE_EXPORT_PRET, href: '/api/export-generations/pub-41/download?file=pdf' }]]);

  it('la carte passe de « En préparation » à « Prêt » avec son lien ; les autres ne changent pas', () => {
    const avant = [groupe(
      carte('export_41', CARTE_EXPORT_EN_PREPARATION),
      carte('export_50', CARTE_EXPORT_EN_PREPARATION),
      carte('asset_7', CARTE_EXPORT_PRET, '/api/export-generations/pub-7/download?file=zip'),
    )];
    const apres = appliquerEtatsExport(avant, etats);
    expect(apres[0].items[0]).toMatchObject({ id: 'export_41', status: CARTE_EXPORT_PRET, href: '/api/export-generations/pub-41/download?file=pdf' });
    // Titre, sous-titre et type de la carte sont ceux qui ont été répondus : rien n'est réécrit.
    expect(apres[0].items[0]).toMatchObject({ title: 'Dossier complet du bien', subtitle: 'Clio', typeLabel: 'Export' });
    expect(apres[0].items[1]).toEqual(avant[0].items[1]);
    expect(apres[0].items[2]).toEqual(avant[0].items[2]);
    // Rien n'est muté : l'objet enregistré est intact.
    expect(avant[0].items[0].status).toBe(CARTE_EXPORT_EN_PREPARATION);
  });

  it('aucun état relu : les cartes sont rendues telles quelles', () => {
    const avant = [groupe(carte('export_41', CARTE_EXPORT_EN_PREPARATION))];
    expect(appliquerEtatsExport(avant, new Map())).toBe(avant);
  });

  it('historique : seuls les messages concernés sont remplacés', async () => {
    const lecteur = vi.fn(async () => [ligne({ status: 'ready', outputPayload: JSON.stringify({ pdfS3Key: 'k.pdf' }) })]);
    const messages = [
      { id: 1, result_groups_json: [groupe(carte('export_41', CARTE_EXPORT_EN_PREPARATION))] },
      { id: 2, result_groups_json: [groupe(carte('asset_7', CARTE_EXPORT_PRET))] },
    ];
    const out = await rafraichirCartesExport(messages, 12, lecteur);
    expect((out[0].result_groups_json as Groupe[])[0].items[0]).toMatchObject({ status: CARTE_EXPORT_PRET, href: '/api/export-generations/pub-41/download?file=pdf' });
    expect(out[1]).toStrictEqual(messages[1]);
  });

  it('mises à jour du fil : seules les cartes dont l’état a changé sont transmises au client', async () => {
    const lecteur = vi.fn(async () => [ligne({ status: 'ready', outputPayload: JSON.stringify({ zipS3Key: 'k.zip' }) })]);
    const maj = await misesAJourDuFil({ accountId: 12, userId: 2, conversationId: 3 }, lecteur, [
      { id: 90, result_groups_json: [groupe(carte('export_41', CARTE_EXPORT_EN_PREPARATION))] },
      // Génération encore en file (absente du retour du lecteur) : rien à transmettre pour ce message.
      { id: 91, result_groups_json: [groupe(carte('export_99', CARTE_EXPORT_EN_PREPARATION))] },
    ]);
    expect(maj).toHaveLength(1);
    expect(maj[0].messageId).toBe('90');
    expect(maj[0].resultGroups[0].items[0]).toMatchObject({ status: CARTE_EXPORT_PRET, href: '/api/export-generations/pub-41/download?file=zip' });
  });
});

describe('L114AA-A04 — isolation du compte', () => {
  it('le lecteur est appelé avec le compte de la session, et avec les seuls identifiants repérés', async () => {
    const vu: Array<[number, number[]]> = [];
    const lecteur = vi.fn(async (accountId: number, ids: number[]) => { vu.push([accountId, ids]); return []; });
    await rafraichirCartesExport([{ id: 1, result_groups_json: [groupe(carte('export_41', CARTE_EXPORT_EN_PREPARATION))] }], 77, lecteur);
    expect(vu).toEqual([[77, [41]]]);
    vu.length = 0;
    await misesAJourDuFil({ accountId: 88, userId: 2, conversationId: 3 }, lecteur, [
      { id: 90, result_groups_json: [groupe(carte('export_41', CARTE_EXPORT_EN_PREPARATION))] },
    ]);
    expect(vu).toEqual([[88, [41]]]);
  });

  it('une génération d’un autre compte n’est jamais rendue par le lecteur : la carte reste « En préparation »', async () => {
    // Le lecteur borne au compte : une génération hors compte ne remonte pas, donc aucun état n'est appliqué.
    const lecteur = vi.fn(async () => []);
    const messages = [{ id: 1, result_groups_json: [groupe(carte('export_41', CARTE_EXPORT_EN_PREPARATION))] }];
    const out = await rafraichirCartesExport(messages, 1, lecteur);
    expect((out[0].result_groups_json as Groupe[])[0].items[0].status).toBe(CARTE_EXPORT_EN_PREPARATION);
  });
});

describe('L114AA-A05 — une relecture impossible ne casse rien', () => {
  it('lecteur en erreur : aucun état, cartes inchangées, aucune exception', async () => {
    const lecteur = vi.fn(async () => { throw new Error('base indisponible'); });
    expect(await lireEtats(1, [41], lecteur)).toEqual(new Map());
    const messages = [{ id: 1, result_groups_json: [groupe(carte('export_41', CARTE_EXPORT_EN_PREPARATION))] }];
    const out = await rafraichirCartesExport(messages, 1, lecteur);
    expect((out[0].result_groups_json as Groupe[])[0].items[0].status).toBe(CARTE_EXPORT_EN_PREPARATION);
    expect(await misesAJourDuFil({ accountId: 1, userId: 2, conversationId: 3 }, lecteur, messages.map((m) => ({ id: m.id, result_groups_json: m.result_groups_json })))).toEqual([]);
  });
});
