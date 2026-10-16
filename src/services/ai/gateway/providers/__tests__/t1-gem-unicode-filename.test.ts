/**
 * Lot 61 — T1-GEM-01 / T1-GEM-02 : un nom de fichier Unicode (forme
 * décomposée NFD, accents combinants U+0300/U+0301) ne bloque plus la
 * construction de la requête Gemini (incident fileId=98, rapports T1 10-12,
 * job 2113, appels 3738-3740 : « Cannot convert argument to a ByteString …
 * value of 768 », étape `request_build`).
 *
 * Cause : `X-Goog-Upload-File-Name` recevait le nom d'origine tel quel ; un
 * en-tête HTTP n'accepte que des octets (ByteString ≤ 255), `fetch` (undici)
 * refuse la requête avant tout contact réseau.
 *
 * Le `fetch` simulé construit une VRAIE `Request` (validation d'en-têtes
 * undici, identique à la production), sans aucun réseau.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { prepareAttachmentParts, encodeHeaderValue, AttachmentRequestBuildError } from '../gemini-files';

const NOM_NFD = 'Facture électricité à régler.pdf'.normalize('NFD');
const NOM_NFC = 'Facture électricité à régler.pdf';

const envoyes: Request[] = [];

beforeEach(() => {
  envoyes.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    // Validation réelle des en-têtes (ByteString), comme undici en production.
    const r = input instanceof Request ? input : new Request(input, init);
    envoyes.push(r);
    if (r.url.includes('/upload/v1beta/files')) {
      return new Response(JSON.stringify({ file: { uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc', state: 'ACTIVE' } }), { status: 200 });
    }
    return new Response(new Uint8Array([37, 80, 68, 70]), { status: 200 });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('T1-GEM-01 — nom de fichier Unicode NFD (cas du document 98)', () => {
  it('T1-GEM-01 : « Facture électricité » en NFD passe la construction de la requête Files API', async () => {
    expect(NOM_NFD).not.toBe(NOM_NFC); // vraie forme décomposée
    const r = await prepareAttachmentParts([{ url: 'https://s3.test/doc.pdf', mimeType: 'application/pdf', displayName: NOM_NFD }], 'k');
    expect(r.parts).toEqual([{ fileData: { fileUri: 'https://generativelanguage.googleapis.com/v1beta/files/abc', mimeType: 'application/pdf' } }]);
    const upload = envoyes.find((x) => x.url.includes('/upload/v1beta/files'))!;
    const h = upload.headers.get('X-Goog-Upload-File-Name')!;
    // En-tête ASCII pur, réversible vers la forme NFC du nom.
    expect(/^[\x20-\x7e]+$/.test(h)).toBe(true);
    expect(decodeURIComponent(h)).toBe(NOM_NFC);
  });

  it('T1-GEM-02 : noms Unicode variés (NFC, NFD, emoji, CJK, nom des lots de pages « à ») acceptés', async () => {
    for (const nom of [NOM_NFC, NOM_NFD, 'Reçu 🔌 borne.pdf', '契約書.pdf', 'contrat (pages 1 à 20)', '  ', '']) {
      await expect(prepareAttachmentParts([{ url: 'https://s3.test/d.pdf', mimeType: 'application/pdf', displayName: nom }], 'k'))
        .resolves.toMatchObject({ temporaryFileUris: ['https://generativelanguage.googleapis.com/v1beta/files/abc'] });
    }
  });

  it('T1-GEM-02 : encodage de l’en-tête — ASCII, NFC, borné, jamais vide ; le nom d’origine n’est pas modifié', () => {
    const avant = NOM_NFD;
    expect(encodeHeaderValue(NOM_NFD)).toBe(encodeURIComponent(NOM_NFC));
    expect(NOM_NFD).toBe(avant);
    expect(encodeHeaderValue('')).toBe('source');
    expect(encodeHeaderValue(undefined)).toBe('source');
    expect(encodeHeaderValue('é'.repeat(1000)).length).toBeLessThanOrEqual(512);
    // Pas de séquence %XX coupée en fin de chaîne bornée.
    expect(() => decodeURIComponent(encodeHeaderValue('é'.repeat(1000)))).not.toThrow();
  });

  it('T1-GEM-03 : requête impossible à construire localement → erreur DÉTERMINISTE typée (request_build), aucun envoi', async () => {
    const e = await prepareAttachmentParts([{ url: 'https://s3.test/v.mp4', mimeType: 'video/x\u0300', displayName: 'x' }], 'k')
      .then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(AttachmentRequestBuildError);
    expect(e).toMatchObject({ deterministic: true, aiStage: 'request_build' });
    expect(envoyes.some((x) => x.url.includes('/upload/'))).toBe(false);
  });
});
