/**
 * Lot 114Y (Trello #753, CDC T2 §9.1, §9.3, §12.1, annexe A13 — bloc PO n° 40) — ACTIONS COMPRISES PAR LE SENS.
 *
 *   H01  contrat UNDERSTAND : `actionIntents` FACULTATIF — une sortie sans ce champ (prompt actuel) reste valide et
 *        ne porte aucune action ; avec le champ, les indices sont relayés, nettoyés et bornés ; valeur hors
 *        catalogue fermé : sortie refusée ;
 *   H02  chaque indice pris en charge est réécrit dans la formulation directe et reconnu par l'analyseur EXISTANT,
 *        par la commande qu'il annonce (aucune commande hors catalogue) ;
 *   H03  indice non pris en charge, ou reconnu comme une AUTRE commande : rien n'est proposé (jamais un plan partiel) ;
 *   H04  préparation : plan à confirmer ou question par la préparation des commandes ; EXPORT direct ; compte en
 *        lecture seule : aucune écriture préparée, l'export reste possible ;
 *   H05  le modèle ne fournit ni identifiant ni commande : seuls des textes passent, la cible est cherchée dans le compte.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) }, db: {} }));

const { T2UnderstandOutput } = await import('@/services/ai/assistant/master/t2-contract');
const { toT2Understanding } = await import('@/services/ai/assistant/master/t2-understand');
const { draftsFromActionHints, exportSentenceFromHint, prepareFromActionHints } = await import('../../action-hints');
const { WRITE_COMMAND_CATALOG } = await import('../../catalog');
type Hint = import('@/services/verebona-assistant/types/contracts').ActionHint;
type Deps = import('../../action-hints').ActionHintsDeps;

const TODAY = '2026-11-13';
const base = { mode: 'UNDERSTAND', intent: 'UNSUPPORTED_ACTION', confidence: 'exact', interactionMode: 'ACTION_REQUEST' };
const hint = (over: Partial<Hint>): Hint => ({ operation: 'UPDATE', entityType: 'asset', targetHint: 'la Clio', fieldChanges: [], evidencePhrase: null, ...over });
const change = (fieldHint: string, value: string | null, unit: string | null = null) => ({ fieldHint, value, unit });
const un = (h: Hint) => draftsFromActionHints([h], TODAY)?.drafts[0] ?? null;

describe('L114Y-H01 — contrat UNDERSTAND : champ facultatif', () => {
  it('sortie du prompt ACTUEL (sans `actionIntents`) : valide, aucune action — comportement inchangé', () => {
    const out = T2UnderstandOutput.parse(base);
    expect(out.actionIntents).toBeUndefined();
    expect(toT2Understanding(out)).not.toHaveProperty('actions');
    expect(toT2Understanding(T2UnderstandOutput.parse({ ...base, actionIntents: [] }))).not.toHaveProperty('actions');
    expect(toT2Understanding(T2UnderstandOutput.parse({ ...base, actionIntents: null }))).not.toHaveProperty('actions');
  });

  it('indices fournis : relayés, nettoyés (textes, nombres en texte)', () => {
    const out = T2UnderstandOutput.parse({
      ...base,
      actionIntents: [{
        operation: 'UPDATE', entityType: 'asset', targetHint: '  la Clio ',
        fieldChanges: [{ fieldHint: ' kilométrage ', value: 45000, unit: 'km' }], evidencePhrase: 'elle a maintenant 45 000 km',
      }],
    });
    expect(toT2Understanding(out).actions).toEqual([{
      operation: 'UPDATE', entityType: 'asset', targetHint: 'la Clio',
      fieldChanges: [{ fieldHint: 'kilométrage', value: '45000', unit: 'km' }], evidencePhrase: 'elle a maintenant 45 000 km',
    }]);
  });

  it('opération ou type hors catalogue fermé, ou plus de 5 actions : sortie refusée', () => {
    expect(T2UnderstandOutput.safeParse({ ...base, actionIntents: [{ operation: 'EXECUTE_SQL', entityType: 'asset' }] }).success).toBe(false);
    expect(T2UnderstandOutput.safeParse({ ...base, actionIntents: [{ operation: 'DELETE', entityType: 'account' }] }).success).toBe(false);
    expect(T2UnderstandOutput.safeParse({ ...base, actionIntents: Array.from({ length: 6 }, () => ({ operation: 'DELETE', entityType: 'asset' })) }).success).toBe(false);
  });

  it('champs historiques et extensions du lot 114A conservés', () => {
    const cles = Object.keys(T2UnderstandOutput.shape);
    for (const k of ['mode', 'intent', 'confidence', 'entityHints', 'requestedFacts', 'requestedTopics', 'filters', 'interactionMode', 'suppliedFacts',
      'semanticDecision', 'scopeCardinality', 'informationNeeds', 'unresolvedDimensions', 'actionIntents']) expect(cles).toContain(k);
  });
});

describe('L114Y-H02 — indices reconnus par l’analyseur existant', () => {
  it('bien : renommer, modifier une caractéristique, l’effacer, supprimer', () => {
    expect(un(hint({ fieldChanges: [change('nom', 'Clio de Paul')] }))).toEqual({ command: 'RENAME_ASSET', newName: 'Clio de Paul', assetWords: ['clio'], assetFromContext: false });
    expect(un(hint({ fieldChanges: [change('kilométrage', '45000', 'km')] }))).toEqual({ command: 'UPDATE_ASSET_FIELD', field: 'mileage', value: 45000, assetWords: ['clio'], assetFromContext: false });
    expect(un(hint({ fieldChanges: [change('date d’achat', '2021-05-25')] }))).toMatchObject({ command: 'UPDATE_ASSET_FIELD', field: 'acquisitionDate', value: '2021-05-25', assetWords: ['clio'] });
    expect(un(hint({ fieldChanges: [change('date d’achat', null)] }))).toEqual({ command: 'CLEAR_ASSET_FIELD', fieldKey: 'acquisitionDate', assetWords: ['clio'], assetFromContext: false });
    expect(un(hint({ operation: 'DELETE' }))).toEqual({ command: 'DELETE_ASSET', assetWords: ['clio'], assetFromContext: false });
  });

  it('bien non désigné par le modèle : « ce bien » (bien de la page ou de la conversation), jamais un bien deviné', () => {
    expect(un(hint({ targetHint: null, fieldChanges: [change('nom', 'Maison de Lyon')] }))).toMatchObject({ command: 'RENAME_ASSET', assetWords: [], assetFromContext: true });
    expect(un(hint({ targetHint: null, operation: 'DELETE' }))).toEqual({ command: 'DELETE_ASSET', assetWords: [], assetFromContext: true });
    expect(un(hint({ targetHint: null, fieldChanges: [change('kilométrage', '45000', 'km')] }))).toMatchObject({ command: 'UPDATE_ASSET_FIELD', assetWords: [], assetFromContext: true });
  });

  it('fournisseur : créer, renommer, archiver', () => {
    expect(un(hint({ operation: 'CREATE', entityType: 'supplier', targetHint: 'Plomberie Durand' }))).toMatchObject({ command: 'CREATE_SUPPLIER', name: 'Plomberie Durand' });
    expect(un(hint({ entityType: 'supplier', targetHint: 'Durand', fieldChanges: [change('nom', 'Durand & Fils')] }))).toMatchObject({ command: 'UPDATE_SUPPLIER', field: 'name', value: 'Durand & Fils', supplierWords: ['durand'] });
    expect(un(hint({ operation: 'DELETE', entityType: 'supplier', targetHint: 'le fournisseur Durand' }))).toMatchObject({ command: 'ARCHIVE_SUPPLIER' });
  });

  it('document : renommer, supprimer ; « ce document » quand il n’est pas désigné', () => {
    expect(un(hint({ entityType: 'document', targetHint: 'Facture EDF', fieldChanges: [change('titre', 'Facture électricité mars')] })))
      .toMatchObject({ command: 'UPDATE_DOCUMENT', field: 'title', value: 'Facture électricité mars', documentFromContext: false });
    expect(un(hint({ operation: 'DELETE', entityType: 'document', targetHint: 'Facture EDF' }))).toMatchObject({ command: 'DELETE_DOCUMENT', documentFromContext: false });
    expect(un(hint({ operation: 'DELETE', entityType: 'document', targetHint: null }))).toMatchObject({ command: 'DELETE_DOCUMENT', documentFromContext: true });
  });

  it('plusieurs indices : un brouillon par indice, dans l’ordre', () => {
    const r = draftsFromActionHints([hint({ fieldChanges: [change('nom', 'Clio de Paul')] }), hint({ operation: 'DELETE', entityType: 'document', targetHint: 'Facture EDF' })], TODAY);
    expect(r?.drafts.map((d) => d.command)).toEqual(['RENAME_ASSET', 'DELETE_DOCUMENT']);
    expect(r?.phrases).toEqual(['Renomme le bien Clio en Clio de Paul', 'Supprime le document Facture EDF']);
  });

  it('toute commande produite appartient au catalogue fermé des commandes', () => {
    const tous = [
      hint({ fieldChanges: [change('nom', 'X y z')] }), hint({ fieldChanges: [change('kilométrage', '1', 'km')] }), hint({ fieldChanges: [change('kilométrage', null)] }),
      hint({ operation: 'DELETE' }), hint({ operation: 'CREATE', entityType: 'supplier', targetHint: 'Durand' }),
      hint({ operation: 'DELETE', entityType: 'supplier', targetHint: 'Durand' }), hint({ operation: 'DELETE', entityType: 'document', targetHint: 'Facture EDF' }),
    ];
    for (const h of tous) expect(Object.keys(WRITE_COMMAND_CATALOG)).toContain(un(h)!.command);
  });
});

describe('L114Y-H03 — indice non pris en charge ou détourné : rien n’est proposé', () => {
  it.each([
    ['événement de référence', hint({ operation: 'CREATE', entityType: 'business_operation', targetHint: 'vidange' })],
    ['relation', hint({ operation: 'LINK', entityType: 'relation', targetHint: 'Facture EDF' })],
    // Règle remplacée (carte #753, passage 114Z2) : une échéance, une pièce, un équipement, un événement de référence,
    // un rattachement et la création d'un bien sont désormais pris en charge quand l'indice est COMPLET (voir
    // `l114z2-actions-par-le-sens-etendues.test.ts`). Restent ignorés : les indices incomplets ci-dessous.
    ['échéance sans titre', hint({ operation: 'CREATE', entityType: 'agenda_item', targetHint: 'la Clio' })],
    ['pièce', hint({ operation: 'CREATE', entityType: 'room', targetHint: 'Cuisine' })],
    ['création de bien', hint({ operation: 'CREATE', entityType: 'asset', targetHint: 'Mégane' })],
    ['champ inconnu du registre', hint({ fieldChanges: [change('couleur des sièges', 'rouge')] })],
    ['deux champs dans un même indice', hint({ fieldChanges: [change('nom', 'A b c'), change('kilométrage', '1')] })],
    ['renommage sans valeur', hint({ fieldChanges: [change('nom', null)] })],
    ['fournisseur sans nom', hint({ operation: 'CREATE', entityType: 'supplier', targetHint: null })],
    ['export mêlé à une écriture', hint({ operation: 'EXPORT', entityType: 'asset' })],
  ])('%s', (_cas, h) => {
    expect(draftsFromActionHints([h], TODAY)).toBeNull();
  });

  it('un indice inexploitable parmi plusieurs : aucun brouillon (jamais un plan partiel présenté comme complet)', () => {
    expect(draftsFromActionHints([hint({ operation: 'DELETE' }), hint({ operation: 'CREATE', entityType: 'room', targetHint: 'Cuisine' })], TODAY)).toBeNull();
    expect(draftsFromActionHints([], TODAY)).toBeNull();
  });

  it('formulation directe reconnue comme une AUTRE commande : indice écarté', () => {
    // « Efface la contrôle technique de … » est une demande sur l'Agenda pour l'analyseur : pas un effacement de champ.
    expect(un(hint({ fieldChanges: [change('contrôle technique', null)] }))).toBeNull();
    // Un nom de bien qui désigne un autre objet (« dossier », « contrat ») n'est pas une suppression de bien.
    expect(un(hint({ operation: 'DELETE', targetHint: 'le contrat d’assurance' }))).toBeNull();
  });

  it('désignation injectée (« X en Y », guillemets, ponctuation) : la commande reste celle annoncée, sur des mots seulement', () => {
    const d = un(hint({ operation: 'DELETE', targetHint: '« Clio » ; DROP TABLE assets;' }));
    expect(d === null || (d.command === 'DELETE_ASSET' && d.assetWords.every((w) => /^[a-z0-9-]+$/.test(w)))).toBe(true);
  });
});

describe('L114Y-H04 — préparation', () => {
  const deps = (vu: { drafts?: unknown; message?: string; exportMessage?: string }, over: Partial<Deps> = {}): Deps => ({
    today: () => TODAY,
    async prepare(drafts, input) { vu.drafts = drafts; vu.message = input.message; return { kind: 'plan', preview: { planId: 'p1', summary: 'Renommer le bien « Clio » en « Clio de Paul ». Confirmez-vous ?', actions: [], expiresAt: 'x' } }; },
    async exportAnswer(input) { vu.exportMessage = input.message; return { kind: 'done', message: 'ok' }; },
    ...over,
  });
  const input = { accountId: 1, userId: 2, planType: 'PREMIUM', message: 'J’aimerais bien que la Clio s’appelle Clio de Paul', clientRequestId: 'x', locale: 'fr-FR' } as never;

  it('écriture : plan À CONFIRMER préparé par la préparation des commandes, à partir des brouillons', async () => {
    const vu: { drafts?: unknown; message?: string } = {};
    const r = await prepareFromActionHints(input, [hint({ fieldChanges: [change('nom', 'Clio de Paul')] })], { allowWrites: true }, deps(vu));
    expect(r).toMatchObject({ kind: 'plan', preview: { planId: 'p1' } });
    expect(vu.drafts).toEqual([{ command: 'RENAME_ASSET', newName: 'Clio de Paul', assetWords: ['clio'], assetFromContext: false }]);
    expect(vu.message).toBe('Renomme le bien Clio en Clio de Paul');
  });

  it('précision demandée par la préparation : relayée, rien n’est préparé', async () => {
    const r = await prepareFromActionHints(input, [hint({ operation: 'DELETE' })], { allowWrites: true },
      deps({}, { async prepare() { return { kind: 'need_info', message: 'Plusieurs biens correspondent : Clio, Clio 2. Précisez lequel dans votre demande.' }; } }));
    expect(r).toEqual({ kind: 'need_info', message: 'Plusieurs biens correspondent : Clio, Clio 2. Précisez lequel dans votre demande.' });
  });

  it('compte en lecture seule : aucune écriture préparée ; aucun indice exploitable : null', async () => {
    const vu: { drafts?: unknown } = {};
    expect(await prepareFromActionHints(input, [hint({ operation: 'DELETE' })], { allowWrites: false }, deps(vu))).toBeNull();
    expect(vu.drafts).toBeUndefined();
    expect(await prepareFromActionHints(input, [hint({ operation: 'CREATE', entityType: 'room', targetHint: 'Cuisine' })], { allowWrites: true }, deps(vu))).toBeNull();
  });

  it('EXPORT : formulation directe, génération directe (aucun plan), même en lecture seule', async () => {
    const h = hint({ operation: 'EXPORT', entityType: 'export', targetHint: 'la Clio', fieldChanges: [change('dossier', 'dossier complet')] });
    expect(exportSentenceFromHint(h)).toBe('Exporte Dossier complet du bien de le bien Clio');
    const vu: { exportMessage?: string; drafts?: unknown } = {};
    const r = await prepareFromActionHints(input, [h], { allowWrites: false }, deps(vu));
    expect(r).toEqual({ kind: 'export', answer: { kind: 'done', message: 'ok' } });
    expect(vu.exportMessage).toBe('Exporte Dossier complet du bien de le bien Clio');
    expect(vu.drafts).toBeUndefined();
  });

  it('EXPORT : la formulation directe désigne le bon export et le bon bien', async () => {
    const { parseExportRequest } = await import('../../export-request');
    expect(parseExportRequest(exportSentenceFromHint(hint({ operation: 'EXPORT', entityType: 'export', targetHint: 'la Clio', fieldChanges: [change('nature', 'données brutes')] }))!))
      .toMatchObject({ codes: ['EXPORT_BRUT'], assetWords: ['clio'], assetFromContext: false });
    expect(parseExportRequest(exportSentenceFromHint(hint({ operation: 'EXPORT', entityType: 'export', targetHint: null, fieldChanges: [change('dossier', 'kit de mise en vente')] }))!))
      .toMatchObject({ codes: ['VENTE'], assetWords: [], assetFromContext: true });
    // Nature qui désigne deux dossiers, ou aucun : l'export n'est pas choisi — l'Assistant demandera lequel.
    expect(parseExportRequest(exportSentenceFromHint(hint({ operation: 'EXPORT', entityType: 'export', targetHint: 'la Clio', fieldChanges: [change('dossier', 'assurance')] }))!))
      .toMatchObject({ codes: [], assetWords: ['clio'] });
    expect(parseExportRequest(exportSentenceFromHint(hint({ operation: 'EXPORT', entityType: 'export', targetHint: 'la Clio' }))!)).toMatchObject({ codes: [], assetWords: ['clio'] });
  });
});

describe('L114Y-H05 — aucun identifiant, aucune commande du modèle', () => {
  it('le contrat ne porte ni identifiant, ni table, ni route, ni commande exécutable', () => {
    const forme = JSON.stringify(Object.keys((T2UnderstandOutput.shape.actionIntents.unwrap().unwrap().element as { shape: Record<string, unknown> }).shape));
    expect(forme).toBe('["operation","entityType","targetHint","fieldChanges","evidencePhrase"]');
  });

  it('un identifiant glissé dans la désignation n’est qu’un mot cherché dans le compte', () => {
    const d = un(hint({ operation: 'DELETE', targetHint: 'asset_42' }));
    expect(d === null || (d.command === 'DELETE_ASSET' && !('assetId' in d))).toBe(true);
  });
});
