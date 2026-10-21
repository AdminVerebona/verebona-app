/**
 * Lot 77C — BO › Supervision › Diagnostics techniques : module pur.
 *
 *   · L77C-U01 lecture des paramètres (périmètres, identifiant, période par
 *     défaut, bornes de période, traitements, option renforcée) ;
 *   · L77C-U02 masquage : secrets (clés et motifs de texte), e-mails
 *     pseudonymisés, adresses, téléphones, n° de contrat, IBAN, contenus
 *     bruts (longueur seule), compteurs de jetons non confondus avec un
 *     secret, idempotence ;
 *   · L77C-U03 validité JSON des fichiers et du ZIP (relu par JSZip) ;
 *   · L77C-U04 bornes explicites et nommage de l'archive ;
 *   · L77C-U05 traçabilité : identifiants de ligne TCO, candidat de la
 *     source T3, ordre des étapes, rupture, rapport TXT (contexte, filtres,
 *     informations non disponibles).
 */
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import {
  DIAG_LIMITS, MASKING_NOTES, READ_ONLY_NOTE, buildReportText, candidateIdFromSourceVersion, finalizeTrace, leaksSecretOrEmail, maskForExport,
  maskText, parseDiagRequest, parseLineId, periodBounds, pseudonym, step, toJsonFile, zipFileName, type DiagManifest,
} from '../model';
import { buildDiagnosticZip } from '../zip';

const sp = (o: Record<string, string>) => new URLSearchParams(o);
const NOW = new Date('2026-10-21T10:00:00Z');

describe('L77C-U01 paramètres du diagnostic', () => {
  it('global par défaut, période de 30 jours jusqu’à aujourd’hui, tous traitements', () => {
    const r = parseDiagRequest(sp({}), NOW);
    expect(r).toEqual({ ok: true, value: { scope: 'global', id: null, from: '2026-09-22', to: '2026-10-21', treatments: [], reinforced: false } });
  });
  it('périmètre ciblé : identifiant obligatoire, entier positif', () => {
    for (const scope of ['user', 'asset', 'document', 'operation']) {
      expect(parseDiagRequest(sp({ scope }), NOW)).toMatchObject({ ok: false, code: 'INVALID_ID' });
      expect(parseDiagRequest(sp({ scope, id: '0' }), NOW)).toMatchObject({ ok: false, code: 'INVALID_ID' });
      expect(parseDiagRequest(sp({ scope, id: '12; DROP' }), NOW)).toMatchObject({ ok: false, code: 'INVALID_ID' });
      expect(parseDiagRequest(sp({ scope, id: '12' }), NOW)).toMatchObject({ ok: true, value: { scope, id: 12 } });
    }
    expect(parseDiagRequest(sp({ scope: 'accounts' }), NOW)).toMatchObject({ ok: false, code: 'INVALID_SCOPE' });
  });
  it('période : dates valides, ordre, borne de 366 jours', () => {
    expect(parseDiagRequest(sp({ from: '2026-02-30' }), NOW)).toMatchObject({ ok: false, code: 'INVALID_PERIOD' });
    expect(parseDiagRequest(sp({ from: '2026-10-22', to: '2026-10-21' }), NOW)).toMatchObject({ ok: false, code: 'INVALID_PERIOD' });
    expect(parseDiagRequest(sp({ from: '2025-10-20', to: '2026-10-21' }), NOW)).toMatchObject({ ok: false, code: 'PERIOD_TOO_LONG' });
    expect(parseDiagRequest(sp({ from: '2025-10-21', to: '2026-10-21' }), NOW)).toMatchObject({ ok: true });
    expect(periodBounds({ from: '2026-10-01', to: '2026-10-21' })).toEqual({ start: '2026-10-01T00:00:00.000Z', end: '2026-10-22T00:00:00.000Z' });
  });
  it('traitements en liste blanche, ordre canonique ; option renforcée', () => {
    expect(parseDiagRequest(sp({ treatments: 't4,T1' }), NOW)).toMatchObject({ ok: true, value: { treatments: ['T1', 'T4'] } });
    expect(parseDiagRequest(sp({ treatments: 'T9' }), NOW)).toMatchObject({ ok: false, code: 'INVALID_TREATMENT' });
    expect(parseDiagRequest(sp({ reinforced: '1' }), NOW)).toMatchObject({ ok: true, value: { reinforced: true } });
  });
});

describe('L77C-U02 masquage', () => {
  const sensitive = (k: string) => k === 'address1' || k === 'insuranceContractNumber';
  const input = {
    id: 7,
    password_hash: '$2b$10$abcdefghijklmnop',
    api_key: 'AIzaSyD-0123456789abcdefghijklmnopq',
    invite_token: 'tok-123',
    entree_jetons: 1200, sortie_jetons: 300, cost_micros: 42,
    email: 'jean.dupont@example.fr',
    admin_email: 'admin@verebona.fr',
    phone: '+33 6 12 34 56 78',
    address1: '12 rue des Lilas',
    contract_number: 'AXA-123456',
    policy_number: 'POL-9',
    iban: 'FR76 3000 6000 0112 3456 7890 189',
    full_text: 'TEXTE INTÉGRAL DU DOCUMENT',
    raw_output: '{"x":1}',
    s3_key: 'e2e/1/secret.pdf',
    filename: 'facture-dupont.pdf',
    notes: 'Contacter jean.dupont@example.fr, IBAN FR76 3000 6000 0112 3456 7890 189, Authorization: Bearer abcdefghijkl123456',
    error_message: 'connexion postgres://app:motdepasse@db.local:5432/x refusée ; sk-proj-ABCDEFGHIJKLMNOPQRST ; eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.abcdefghijklmnop',
    kc: { address1: '12 rue des Lilas', insuranceContractNumber: 'C-1', acquisitionPrice: 490000 },
    nested: [{ supplier: 'Tikamoon', amount_minor: 49000000 }],
  };
  const out = maskForExport(input, { isSensitiveKey: sensitive }) as Record<string, unknown>;
  const json = JSON.stringify(out);

  it('aucun secret ni donnée personnelle en clair', () => {
    for (const leak of ['$2b$10$', 'AIzaSy', 'tok-123', 'jean.dupont', 'admin@verebona.fr', '12 34 56 78', '12 rue des Lilas', 'AXA-123456', 'POL-9',
      '0112 3456 7890', 'TEXTE INTÉGRAL', 'e2e/1/secret.pdf', 'facture-dupont', 'motdepasse', 'sk-proj-ABC', 'eyJhbGciOi', 'abcdefghijkl123456']) {
      expect(json, leak).not.toContain(leak);
    }
    expect(leaksSecretOrEmail(json)).toBe(false);
  });
  it('les valeurs utiles au diagnostic restent lisibles (montants, fournisseur, compteurs de jetons)', () => {
    expect(out.entree_jetons).toBe(1200);
    expect(out.sortie_jetons).toBe(300);
    expect(out.id).toBe(7);
    expect(out.nested).toEqual([{ supplier: 'Tikamoon', amount_minor: 49000000 }]);
    expect((out.kc as Record<string, unknown>).acquisitionPrice).toBe(490000);
  });
  it('marqueurs explicites : e-mail pseudonymisé stable, contenu brut avec longueur', () => {
    expect(out.email).toEqual({ $etat: 'masque', motif: 'e-mail', pseudonyme: pseudonym('Jean.Dupont@example.fr') });
    expect(out.full_text).toMatchObject({ $etat: 'masque', longueur: 'TEXTE INTÉGRAL DU DOCUMENT'.length });
    expect(out.raw_output).toMatchObject({ $etat: 'masque' });
    expect(String(out.notes)).toContain(`[e-mail masqué #${pseudonym('jean.dupont@example.fr')}]`);
    expect(String(out.notes)).toContain('IBAN masqué');
    expect((out.kc as Record<string, unknown>).address1).toMatchObject({ $etat: 'masque' });
  });
  it('idempotent', () => {
    expect(maskForExport(out, { isSensitiveKey: sensitive })).toEqual(out);
  });
  it('maskText seul : secrets dans un texte libre', () => {
    expect(maskText('token=abc123 et password: hunter2')).not.toMatch(/abc123|hunter2/);
    expect(maskText('whsec_ABCDEFGH1234 sk_live_ABCDEFGH1234')).toBe('[secret masqué] [secret masqué]');
  });
});

describe('L77C-U03 validité JSON et ZIP', () => {
  const manifest = {
    schema: 'verebona.bo.diagnostic-technique/1', generationId: '0123456789abcdef', generatedAt: '2026-10-21T10:00:00.000Z', environment: 'preprod',
    build: { version: '1.0.0', commit: 'abc1234', commitSource: 'SOURCE_VERSION', container: null },
    request: { scope: 'operation', id: 42, from: '2026-09-22', to: '2026-10-21', treatments: ['T3'], reinforced: false, scopeLabel: 'Opération' },
    target: { label: 'Opération #42', accountIds: [3] }, limits: DIAG_LIMITS, files: [], warnings: [], unavailable: [], masking: [...MASKING_NOTES], readOnly: READ_ONLY_NOTE,
  } as DiagManifest;

  it('chaque fichier JSON est relu à l’identique ; caractères spéciaux et unicode conservés', () => {
    const v = { a: 'guillemet " barre \\ retour\nligne', b: '€ — é', c: [1, null, { d: true }] };
    expect(JSON.parse(toJsonFile(maskForExport(v)))).toEqual(v);
  });
  it('archive ZIP lisible, fichiers JSON valides, rapport TXT présent', async () => {
    const files = [
      { path: 'rapport.txt', content: 'VEREBONA — DIAGNOSTIC\n' },
      { path: 'manifeste.json', content: toJsonFile(manifest) },
      { path: 'tracabilite/montants.json', content: toJsonFile([{ ligne: { id: 'c:1' } }]) },
    ];
    const buf = await buildDiagnosticZip({ files, manifest });
    const zip = await JSZip.loadAsync(buf);
    expect(Object.keys(zip.files).filter((k) => !zip.files[k].dir).sort()).toEqual(['manifeste.json', 'rapport.txt', 'tracabilite/montants.json']);
    expect(JSON.parse(await zip.file('manifeste.json')!.async('string'))).toMatchObject({ generationId: '0123456789abcdef' });
    expect(JSON.parse(await zip.file('tracabilite/montants.json')!.async('string'))).toEqual([{ ligne: { id: 'c:1' } }]);
    expect(await zip.file('rapport.txt')!.async('string')).toContain('DIAGNOSTIC');
  });
});

describe('L77C-U04 bornes et nommage', () => {
  it('bornes explicites, figées', () => {
    expect(Object.isFrozen(DIAG_LIMITS)).toBe(true);
    expect(DIAG_LIMITS).toMatchObject({ periodMaxDays: 366, listRows: 500, dossierSectionRows: 500, totalBytes: 40 * 1024 * 1024, concurrent: 2 });
  });
  it('nom d’archive : périmètre, identifiant, date, génération', () => {
    expect(zipFileName({ request: { scope: 'asset', id: 12 } as never, generatedAt: '2026-10-21T10:00:00.000Z', generationId: 'abcdef0123456789' }))
      .toBe('verebona-diagnostic-asset-12-2026-10-21-abcdef01.zip');
    expect(zipFileName({ request: { scope: 'global', id: null } as never, generatedAt: '2026-10-21T10:00:00.000Z', generationId: 'abcdef0123456789' }))
      .toBe('verebona-diagnostic-global-2026-10-21-abcdef01.zip');
  });
});

describe('L77C-U05 traçabilité et rapport', () => {
  it('identifiants de ligne TCO du moteur (lot 61)', () => {
    expect(parseLineId('c:15')).toEqual({ kind: 'component', componentId: 15 });
    expect(parseLineId('doc:7')).toEqual({ kind: 'document', fileId: 7, candidateId: null, hintIndex: null });
    expect(parseLineId('doc:7:99:1')).toEqual({ kind: 'document', fileId: 7, candidateId: 99, hintIndex: 1 });
    expect(parseLineId('asset:3:acquisitionPrice')).toEqual({ kind: 'asset-price', assetId: 3 });
    expect(parseLineId('equipment:4:acquisitionPrice')).toEqual({ kind: 'equipment-price', equipmentId: 4 });
    expect(parseLineId('zzz')).toEqual({ kind: 'unknown' });
  });
  it('candidat T1 désigné par la source T3 (`c<id>|a…|t…`), sinon null', () => {
    expect(candidateIdFromSourceVersion('c321|a5|tFACTURE')).toBe(321);
    expect(candidateIdFromSourceVersion('v1')).toBeNull();
    expect(candidateIdFromSourceVersion(null)).toBeNull();
  });
  it('étapes ordonnées Document → … → Affichage ; première rupture identifiée', () => {
    const t = finalizeTrace({
      ligne: { id: 'c:1' }, assetId: 1, valeurs: { source: null, proposeeIA: null, enregistree: null, calculee: null, affichee: null },
      chaine: [step('AFFICHAGE', 'disponible'), step('EXTRACTION_IA', 'non_disponible', [], undefined, 'pas de fait'), step('DOCUMENT', 'disponible'), step('DECISION', 'non_disponible')],
    });
    expect(t.chaine.map((s) => s.etape)).toEqual(['DOCUMENT', 'EXTRACTION_IA', 'DECISION', 'AFFICHAGE']);
    expect(t.rupture).toBe('EXTRACTION_IA');
  });
  it('rapport TXT : environnement, version, période, filtres, date, montants tracés et limites', () => {
    const m = {
      schema: 'verebona.bo.diagnostic-technique/1', generationId: 'g-1', generatedAt: '2026-10-21T10:00:00.000Z', environment: 'preprod',
      build: { version: '1.0.0', commit: 'abc1234', commitSource: 'SOURCE_VERSION', container: 'web-1' },
      request: { scope: 'operation', id: 42, from: '2026-09-22', to: '2026-10-21', treatments: ['T1', 'T3'], reinforced: false, scopeLabel: 'Opération' },
      target: { label: 'Opération #42 (compte #3)', accountIds: [3] }, limits: DIAG_LIMITS,
      files: [{ path: 'tracabilite/montants.json', description: 'Traçabilité', count: 1, complete: true }],
      warnings: ['borne atteinte'], unavailable: [{ element: 'Rapports T1', motif: 'rétention' }], masking: ['masque'], readOnly: READ_ONLY_NOTE,
    } as DiagManifest;
    const t = finalizeTrace({
      ligne: { id: 'c:9', label: 'Achat — Tikamoon', eurCents: 49_000_000, includedCents: 49_000_000, status: 'RETAINED_CONSOLIDATED', provenance: 'T3' }, assetId: 5,
      valeurs: { source: null, proposeeIA: null, enregistree: null, calculee: null, affichee: null },
      chaine: [step('DOCUMENT', 'disponible', [{ table: 'asset_files', id: 77 }]), step('EXTRACTION_IA', 'non_disponible', [], undefined, 'aucun rapport T1')],
    });
    const txt = buildReportText(m, [['Appels IA', 3]], [t]);
    for (const attendu of ['Environnement    : preprod', 'commit abc1234', 'du 2026-09-22 au 2026-10-21', 'T1, T3', '2026-10-21T10:00:00.000Z',
      'Opération #42', '490 000,00 €', 'asset_files#77', 'NON DISPONIBLE', 'Rupture de la trace : Extraction IA (T1)', 'Rapports T1 : rétention', 'borne atteinte', READ_ONLY_NOTE]) {
      expect(txt, attendu).toContain(attendu);
    }
  });
});
