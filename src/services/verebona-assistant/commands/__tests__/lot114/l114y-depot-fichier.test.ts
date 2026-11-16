/**
 * Lot 114Y (Trello #753, CDC T2 §9.2, §14.3 W11, §14.4 « Documents », M27) — DÉPÔT D'UN FICHIER DEMANDÉ DEPUIS
 * L'ASSISTANT.
 *
 *   D01  reconnaissance : impératif (ou demande polie) + nom de fichier ; une question, un infinitif seul, un lien
 *        web, une note de document ne sont pas des demandes de dépôt ; les commandes déjà livrées gardent la main ;
 *   D02  le bien est résolu dans le compte : nommé, ou celui de la page / de la conversation ; plusieurs biens →
 *        question ; bien introuvable → aucun bien présélectionné ;
 *   D03  l'Assistant ne dépose rien : la réponse renvoie au bouton existant « Ajouter un document ».
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) }, db: {} }));

const { parseUploadRequest, answerUploadRequest, uploadMessage, UPLOAD_BUTTON_LABEL } = await import('../../upload-request');
const { parseCommands } = await import('../../parser');
const { helpPrimaryAction } = await import('../../../core/navigation-targets');
type Deps = import('../../upload-request').UploadDeps;

const clio = { id: 7, name: 'Clio', city: null };
const maison = { id: 9, name: 'Maison', city: 'Lyon' };
const deps: Deps = {
  async findAssets(_a, w) { return [clio, maison].filter((b) => w.some((x) => b.name.toLowerCase().includes(x))); },
  async getAsset(_a, id) { return [clio, maison].find((b) => b.id === id) ?? null; },
};
const input = (message: string, extra: Record<string, unknown> = {}) =>
  ({ accountId: 1, userId: 2, planType: 'PREMIUM', message, clientRequestId: 'x', locale: 'fr-FR', ...extra }) as never;

describe('L114Y-D01 — reconnaissance d’une demande de dépôt', () => {
  it.each([
    ['Dépose une facture pour la Clio', ['clio'], false],
    ['Ajoute un document pour la maison', ['maison'], false],
    ['Téléverse la facture du garage pour la Clio', ['clio'], false],
    ['Importe un fichier sur la Clio.', ['clio'], false],
    ['Peux-tu ajouter une photo pour la Clio ?', ['clio'], false],
    ['Pourrais-tu déposer un justificatif pour ma maison', ['maison'], false],
    ['Ajoute un document', [], true],
    ['Dépose-moi une facture', [], true],
    ['Joins une pièce jointe pour ce bien', [], true],
    ['Ajoute la facture de Norauto', [], true],
  ])('« %s »', (phrase, assetWords, assetFromContext) => {
    expect(parseUploadRequest(phrase)).toEqual({ assetWords, assetFromContext });
  });

  it.each([
    'Ajouter un document',
    'Déposer un fichier',
    'Comment ajouter un document ?',
    'Ajoute une facture ?',
    'Où est la facture de la Clio ?',
    'Montre la facture de la Clio',
    'Ajoute le lien https://exemple.test/notice intitulé « Notice » pour la maison',
    'Ajoute un document web',
    'Ajoute la note « payée » au document Facture EDF',
    'Ajoute un rappel vidange pour la Clio',
    'Ajoute un contrat pour la maison',
    'Ajoute une garantie pour la Clio',
    'Supprime le document Facture EDF',
    'Rattache le document Garantie à la Clio',
    'Ajoute une voiture nommée Mégane',
  ])('« %s » n’est pas une demande de dépôt', (phrase) => {
    expect(parseUploadRequest(phrase)).toBeNull();
  });

  it('non-régression : les commandes déjà livrées sur les documents gardent la main (elles sont reconnues avant)', () => {
    expect(parseCommands('Ajoute le lien https://exemple.test/notice intitulé « Notice » pour la maison', '2026-11-13')?.[0].draft.command).toBe('CREATE_WEB_DOCUMENT');
    expect(parseCommands('Ajoute la note « payée » au document Facture EDF', '2026-11-13')?.[0].draft.command).toBe('UPDATE_DOCUMENT');
    // Une demande de dépôt n'est reconnue par AUCUNE commande d'écriture.
    for (const p of ['Dépose une facture pour la Clio', 'Ajoute un document pour la maison', 'Importe un fichier sur la Clio']) expect(parseCommands(p, '2026-11-13')).toBeNull();
  });
});

describe('L114Y-D02 — bien résolu dans le compte', () => {
  it('bien nommé et trouvé : présélectionné', async () => {
    expect(await answerUploadRequest(input('Dépose une facture pour la Clio'), deps)).toEqual({
      kind: 'open', assetId: 7, message: 'Pour déposer un document pour Clio, choisissez le fichier avec le bouton « Ajouter un document » ci-dessous.',
    });
  });

  it('aucun bien nommé : celui de la conversation, sinon celui de la page, sinon aucun', async () => {
    expect(await answerUploadRequest(input('Ajoute un document', { reference: { type: 'asset', id: 9, method: 'thread' }, pageContext: { assetId: '7' } }), deps)).toMatchObject({ kind: 'open', assetId: 9 });
    expect(await answerUploadRequest(input('Ajoute un document pour ce bien', { pageContext: { assetId: '7' } }), deps)).toMatchObject({ kind: 'open', assetId: 7 });
    expect(await answerUploadRequest(input('Ajoute un document'), deps)).toEqual({ kind: 'open', assetId: null, message: uploadMessage(null) });
    expect(uploadMessage(null)).toBe('Pour déposer un document, choisissez le fichier avec le bouton « Ajouter un document » ci-dessous. Vous indiquerez le bien concerné dans la fenêtre de dépôt.');
  });

  it('plusieurs biens : question, aucun bouton, aucun bien choisi', async () => {
    const r = await answerUploadRequest(input('Dépose une facture pour la Clio'), { ...deps, async findAssets() { return [clio, { id: 8, name: 'Clio 2', city: 'Paris' }]; } });
    expect(r).toEqual({ kind: 'need_info', assetId: null, message: 'Plusieurs biens correspondent : Clio, Clio 2 (Paris). Précisez lequel dans votre demande.' });
  });

  it('bien nommé introuvable : aucun bien présélectionné — jamais celui de la page à la place', async () => {
    expect(await answerUploadRequest(input('Dépose une facture pour la Twingo', { pageContext: { assetId: '7' } }), deps)).toEqual({ kind: 'open', assetId: null, message: uploadMessage(null) });
  });

  it('une phrase qui n’est pas une demande de dépôt : null', async () => {
    expect(await answerUploadRequest(input('Comment ajouter un document ?'), deps)).toBeNull();
  });
});

describe('L114Y-D03 — l’Assistant ne dépose rien', () => {
  const orchestrateur = readFileSync(join(process.cwd(), 'src/services/verebona-assistant/core/assistant-orchestrator.service.ts'), 'utf8');

  it('le bouton proposé est le bouton EXISTANT de dépôt (même libellé, même action de création)', () => {
    expect(UPLOAD_BUTTON_LABEL).toBe('Ajouter un document');
    expect(helpPrimaryAction(UPLOAD_BUTTON_LABEL, 'PRODUCT_HELP_HOW_TO')).toBe('START_ADD_DOCUMENT');
    expect(readFileSync(join(process.cwd(), 'src/services/verebona-assistant/core/action-resolver.service.ts'), 'utf8')).toContain("START_ADD_DOCUMENT: 'Ajouter un document'");
  });

  it('le module ne crée aucun document et n’appelle aucun service de dépôt', () => {
    const src = readFileSync(join(process.cwd(), 'src/services/verebona-assistant/commands/upload-request.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(src).not.toMatch(/presign|confirm|asset_files|INSERT|UPDATE |uploadFile|s3/i);
  });

  it('orchestrateur : après les commandes d’écriture ; seul le bouton de dépôt est gardé ; lecture seule annoncée sans bouton', () => {
    const depot = orchestrateur.indexOf('ports.prepareUpload(input)');
    expect(depot).toBeGreaterThan(orchestrateur.indexOf('ports.prepareCommand(input)'));
    const bloc = orchestrateur.slice(depot, depot + 1800);
    expect(bloc).toContain("filter((a) => a.type === 'START_ADD_DOCUMENT')");
    expect(bloc).toContain('ecritureBloquee ? UPDATE_READ_ONLY_MESSAGE : depot.message');
    expect(bloc).toContain("depot.kind === 'open' && !ecritureBloquee");
  });
});
