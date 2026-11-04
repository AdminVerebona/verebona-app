/**
 * Lot 109K — ticket « T1 couverture PDF », COR-01 (L109K-U-COV, L109K-U-REVERIFY).
 *
 * PDF RÉELS générés de façon reproductible (`fixtures/pdf-coverage/generate.mts`) :
 * texte simple, police composite CID (sortie Chromium, tableau), scanné,
 * hybride, texte posé dans une forme. Sonde pdf-lib et couche texte pdf.js
 * RÉELLES ; seule la lecture T1 (transcription) est fournie par le test.
 *
 * Vrais manquants / fausses incertitudes distingués : une page n'est VERIFIED
 * que si son texte original est retrouvé ; MISSING = omission objectivée ;
 * UNVERIFIABLE = contrôle techniquement impossible (jamais promu).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { T1AnalyzeDocumentOutput } from '../../master/t1-contract';

const pdf = vi.hoisted(() => ({ bytes: null as Uint8Array | null }));
vi.mock('../page-chunks', async (orig) => ({
  ...(await orig<typeof import('../page-chunks')>()),
  fetchSourceBytes: async () => pdf.bytes,
}));

const sv = await import('../source-verification');
const { extractRawText } = await import('../../raw-extract/extract');
const { loadPageTextLayer, pageTextsFromRawExtract } = await import('../page-text-layer');
const { continueByPages } = await import('../continuation');
const { buildCompletenessReport } = await import('../coverage');
const { verificationFollowup, verificationAutoRetryDue, pageReasonsText } = await import('../verification-followup');
const { reverifyFromStored, reverificationDue, reverificationFingerprint } = await import('../stored-reverification');

const DIR = join(__dirname, 'fixtures', 'pdf-coverage');
const lire = (n: string) => new Uint8Array(readFileSync(join(DIR, n)));

/** Mêmes textes que le générateur. */
const PAGE1 = [
  'Devis numero DV-2026-0042', 'Entreprise Exemple Charpente, douze rue des Artisans, Lyon', 'Client : Madame Exemple, maison principale',
  'Traitement preventif des charpentes et solives', 'Deplacement et installation du chantier', 'Total HT 733,33 EUR, TVA 146,67 EUR, Total TTC 880,00 EUR',
].join('\n');
const PAGE2 = [
  'Conditions generales de vente', 'Validite du devis trois mois a compter de son emission', 'Acompte de trente pourcent exigible a la commande',
  'Garantie decennale souscrite aupres d un assureur mutualiste', 'Reglement par virement bancaire sous quinze jours',
].join('\n');

async function couche(bytes: Uint8Array) {
  const ex = await extractRawText({ bytes, mimeType: 'application/pdf' });
  return pageTextsFromRawExtract(ex.fullText, ex.pages);
}

async function verifier(fichier: string, transcription: string, opts: { textLayer?: boolean; cited?: number[]; markers?: boolean; readTexts?: string[] } = {}) {
  const bytes = lire(fichier);
  const probe = (await sv.probePdf(bytes))!;
  return sv.verifyPdfCoverage({
    probe, cited: { pages: new Set(opts.cited ?? []), markers: opts.markers ?? false }, transcription, hasContent: transcription.length > 0,
    textLayer: opts.textLayer === false ? null : await couche(bytes), readTexts: opts.readTexts,
  });
}

const detail = (v: ReturnType<typeof sv.verifyPdfCoverage>, page: number) => v.pageDetails!.find((d) => d.page === page)!;

describe('L109K-U-COV — verdict par page sur PDF réels', () => {
  it('PDF texte simple : chaque page VERIFIED par la couche texte, motif text_matched', async () => {
    const v = await verifier('texte-simple.pdf', `${PAGE1}\n${PAGE2}`);
    expect(v.status).toBe('VERIFIED');
    expect(v.verified).toEqual([1, 2]);
    expect(detail(v, 1)).toMatchObject({ status: 'VERIFIED', method: 'PDF_TEXT_LAYER', reason: 'text_matched' });
    expect(v.verifierVersion).toBe(sv.SOURCE_VERIFIER_VERSION);
  });

  it('police CID : la sonde seule laisse une FAUSSE incertitude (cause démontrée) ; la couche texte vérifie', async () => {
    const probe = (await sv.probePdf(lire('police-cid.pdf')))!;
    expect(probe.pages.map((p) => [p.kind, p.sample])).toEqual([['TEXT', null], ['TEXT', null]]);
    const avant = await verifier('police-cid.pdf', `${PAGE1}\n${PAGE2}`, { textLayer: false, cited: [1, 2] });
    expect(avant.status).toBe('PARTIAL');
    expect(avant.unverified).toEqual([1, 2]);
    expect(detail(avant, 1).reason).toBe('text_not_decodable');
    const apres = await verifier('police-cid.pdf', `${PAGE1}\n${PAGE2}`, { cited: [1, 2] });
    expect(apres.status).toBe('VERIFIED');
    expect(apres.pageDetails!.every((d) => d.method === 'PDF_TEXT_LAYER' && d.reason === 'text_matched')).toBe(true);
  });

  it('tableau : le contenu des tableaux LUS compte comme lecture (transcription sans les lignes)', async () => {
    const sansLignes = PAGE1.split('\n').filter((l) => !/Traitement|Deplacement/.test(l)).join('\n');
    const lignes = ['Traitement preventif des charpentes et solives', '650,00 EUR', 'Deplacement et installation du chantier', '83,33 EUR'];
    const v = await verifier('police-cid.pdf', `${sansLignes}\n${PAGE2}`, { readTexts: lignes });
    expect(detail(v, 1).status).toBe('VERIFIED');
  });

  it('police CID, page 2 réellement omise : MISSING objectivée (et non une incertitude), même citée', async () => {
    const v = await verifier('police-cid.pdf', PAGE1, { cited: [1, 2] });
    expect(v.missing).toEqual([2]);
    expect(detail(v, 2)).toMatchObject({ status: 'MISSING', method: 'PDF_TEXT_LAYER', reason: 'text_absent_from_transcription', cited: true });
    expect(v.reason).toBe('pages_missing');
  });

  it('citation seule ≠ preuve : pages citées par des faits, texte original absent → MISSING, jamais VERIFIED', async () => {
    const v = await verifier('police-cid.pdf', 'Montant total 880 EUR', { cited: [1, 2] });
    expect(v.verified).toEqual([]);
    expect(v.missing).toEqual([1, 2]);
  });

  it('PDF scanné : UNVERIFIABLE (scanned_no_text_layer) même avec une lecture modèle complète et citée', async () => {
    const v = await verifier('scanne.pdf', `${PAGE1}\n${PAGE2}`, { cited: [1, 2] });
    expect(v.status).toBe('PARTIAL');
    expect(v.unverified).toEqual([1, 2]);
    expect(v.scanned).toEqual([1, 2]);
    expect(detail(v, 1)).toMatchObject({ status: 'UNVERIFIABLE', reason: 'scanned_no_text_layer', scanned: true });
  });

  it('PDF hybride : page texte VERIFIED, page scannée UNVERIFIABLE', async () => {
    const v = await verifier('hybride.pdf', `${PAGE1}\n${PAGE2}`, { cited: [1, 2] });
    expect(detail(v, 1)).toMatchObject({ status: 'VERIFIED', method: 'PDF_TEXT_LAYER' });
    expect(detail(v, 2)).toMatchObject({ status: 'UNVERIFIABLE', reason: 'scanned_no_text_layer' });
  });

  it('texte dans une forme (XObject) : sonde aveugle, couche texte VERIFIED', async () => {
    const avant = await verifier('forme-xobject.pdf', PAGE1, { textLayer: false });
    expect(avant.status).toBe('PARTIAL');
    expect(detail(avant, 1).reason).toBe('no_text_layer');
    const apres = await verifier('forme-xobject.pdf', PAGE1);
    expect(apres.status).toBe('VERIFIED');
  });

  it('état de qualité : CID lu → plus de VERIFICATION_INCOMPLETE ; scan → VERIFICATION_INCOMPLETE conservé (aucun seuil changé)', async () => {
    const rapport = (v: ReturnType<typeof sv.verifyPdfCoverage>) => buildCompletenessReport([], {
      factsCount: 3, unresolvedFacts: [], truncatedSectionsCount: 0, batchedSectionsCount: 0, repairPassCount: 0, chunkCount: 0,
      warningCodes: [], retryAllowed: true, verification: v,
    });
    const cid = rapport(await verifier('police-cid.pdf', `${PAGE1}\n${PAGE2}`, { cited: [1, 2] }));
    expect(cid.qualityState).toBe('COMPLETE');
    expect(cid.diagnostics!.pageDetails).toHaveLength(2);
    const scan = rapport(await verifier('scanne.pdf', `${PAGE1}\n${PAGE2}`, { cited: [1, 2] }));
    expect(scan.qualityState).toBe('VERIFICATION_INCOMPLETE');
    // Motif exact et prochaine action : intelligibles ; aucune reprise automatique (anti-boucle conservée).
    const f = verificationFollowup({
      qualityState: 'VERIFICATION_INCOMPLETE', sourceVerification: 'PARTIAL', verificationReason: 'pages_unverified',
      pagesUnverified: scan.diagnostics!.pagesUnverified, pageDetails: scan.diagnostics!.pageDetails,
    })!;
    expect(f.reason).toContain('page scannée sans couche texte');
    expect(f.autoRetry).toBe(false);
    expect(verificationAutoRetryDue({ qualityState: 'VERIFICATION_INCOMPLETE', verificationReason: 'pages_unverified', retryAttempts: 0, maxRetries: 3 })).toBe(false);
    expect(pageReasonsText([{ page: 2, status: 'MISSING', reason: 'text_absent_from_transcription' }])).toContain('omission');
  });
});

describe('L109K-U-COV — continuation : réparation SEULEMENT sur omission objectivée', () => {
  const out = (transcription: string): T1AnalyzeDocumentOutput => ({
    transcription, facts: [], tables: [], visual: { observations: [] }, document: {},
    entities: { assets: [], rooms: [], equipments: [], suppliers: [], multiAsset: false }, businessOperationCandidates: [],
  } as unknown as T1AnalyzeDocumentOutput);
  const entree = { sourceType: 'file' as const, sourceIds: [9_109], accountId: 1, userId: 1, mimeTypes: ['application/pdf'], displayNames: ['devis.pdf'], contentUrls: ['https://stockage.test/devis.pdf'] };
  const layer = async (b: Uint8Array) => ({ pages: await couche(b), pageCount: 2, origin: 'IN_MEMORY_EXTRACTION' as const, sourceSha256: 'x', truncated: false });

  it('CID entièrement lu : aucun appel de reprise, couverture VERIFIED', async () => {
    pdf.bytes = lire('police-cid.pdf');
    const call = vi.fn();
    const r = await continueByPages({ input: entree, groupIndices: [0], first: out(`${PAGE1}\n${PAGE2}`), firstOutputTokens: 100, firstReport: null, call, textLayer: layer });
    expect(call).not.toHaveBeenCalled();
    expect(r.verification!.status).toBe('VERIFIED');
  });

  it('CID page 2 omise : UNE reprise ciblée de la page 2 seule, puis TARGETED_REREAD ; idempotent', async () => {
    pdf.bytes = lire('police-cid.pdf');
    const call = vi.fn(async () => ({ output: out(PAGE2), report: null, batches: 1, outputTokens: 50 }));
    const r = await continueByPages({ input: entree, groupIndices: [0], first: out(PAGE1), firstOutputTokens: 100, firstReport: null, call, textLayer: layer });
    expect(call).toHaveBeenCalledTimes(1);
    expect((call.mock.calls[0] as unknown as [{ triggerCode: string }])[0].triggerCode).toBe('t1_page_omission');
    expect(r.gaps).toEqual([]);
    expect(r.verification!.status).toBe('VERIFIED');
    expect(detail(r.verification!, 2)).toMatchObject({ status: 'VERIFIED', method: 'TARGETED_REREAD' });
  });

  it('scanné : aucune reprise automatique (une relecture ne lèverait pas l’incertitude)', async () => {
    pdf.bytes = lire('scanne.pdf');
    const call = vi.fn();
    const r = await continueByPages({ input: entree, groupIndices: [0], first: out(`${PAGE1}\n${PAGE2}`), firstOutputTokens: 100, firstReport: null, call, textLayer: layer });
    expect(call).not.toHaveBeenCalled();
    expect(r.verification!.unverified).toEqual([1, 2]);
  });

  it('couche texte : extraction en mémoire quand aucun extract persisté (aucune IA)', async () => {
    const l = await loadPageTextLayer({ accountId: 1, fileId: null, bytes: lire('police-cid.pdf') });
    expect(l?.origin).toBe('IN_MEMORY_EXTRACTION');
    expect(l?.pages.get(2)).toContain('Conditions generales');
  });
});

describe('L109K-U-REVERIFY — re-vérification déterministe du stock', () => {
  const unites = (texte: string, page: number) => texte.split('\n').map((t, i) => ({ sourceUnitId: `p${page}:${i}`, page, text: t, kind: 'TEXT_BLOCK' as const }));

  it('couverture CID enregistrée par la sonde seule : due ; confrontée → VERIFIED ; empreinte stable', async () => {
    const pages = await couche(lire('police-cid.pdf'));
    expect(reverificationDue({ qualityState: 'VERIFICATION_INCOMPLETE', verification: { sourceVerification: 'PARTIAL', verificationReason: 'pages_unverified' } })).toBe(true);
    expect(reverificationDue({ qualityState: 'VERIFICATION_INCOMPLETE', verification: { sourceVerification: 'PARTIAL', verificationReason: 'pages_unverified', verifierVersion: 2 } })).toBe(false);
    expect(reverificationDue({ qualityState: 'VERIFICATION_INCOMPLETE', verification: { sourceVerification: 'UNVERIFIABLE', verificationReason: 'source_unreadable' } })).toBe(false);
    const u = [...unites(PAGE1, 1), ...unites(PAGE2, 2)];
    const v = reverifyFromStored({ pageCount: 2, pageTexts: pages, scannedPages: [], rereadPages: [], units: u, extractSha: 'abc' });
    expect(v.status).toBe('VERIFIED');
    expect(reverificationFingerprint({ extractSha: 'abc', units: u })).toBe(reverificationFingerprint({ extractSha: 'abc', units: [...u].reverse() }));
  });

  it('stock : omission réelle → MISSING ; page scannée → UNVERIFIABLE ; jamais MISSING par pagination reconstruite', async () => {
    const pages = await couche(lire('hybride.pdf'));
    const v = reverifyFromStored({ pageCount: 2, pageTexts: pages, scannedPages: [2], rereadPages: [], units: unites('Autre texte sans rapport aucun', 1), extractSha: null });
    expect(v.missing).toEqual([1]);
    expect(detail(v, 2)).toMatchObject({ status: 'UNVERIFIABLE', reason: 'scanned_no_text_layer' });
  });
});
