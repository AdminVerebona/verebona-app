/**
 * Lot 105D — identités documentaires (ticket « Rattachement rétroactif après
 * création d'un bien », §D1 à §D3) : signaux typés et rôles d'adresse,
 * groupes et confrontation aux biens, décisions déterministes, garde avant
 * l'IA, contexte croisé sans valeur sensible, contrôle serveur de la sortie.
 * Modules PURS.
 */
import { describe, expect, it } from 'vitest';
import { addressRoleBefore, addressesIn, extractIdentityProfile, type IdentityProfileInput } from '../signals';
import { assetIdentityFingerprint, buildIdentityGraph, documentIdentityFingerprint, GROUP_CARD_MIN_DOCUMENTS, membershipOf, type GraphDocument } from '../graph';
import { crossDocumentContext, decideFromIdentity, identityContextOf, identityGate, validateCrossDocumentOutput } from '../decision';
import { decideFromAiOutput, documentAssetVariables, type DocumentAssetCandidate } from '../../decision';
import type { IndexedAsset } from '../../matching-index';

const ADR = '12 rue des Érables Fictifs, 69000 Lyon';
const ADR2 = '8 avenue des Tilleuls, 69000 Lyon';

const asset = (id: number, name: string, family: 'IMMOBILIER' | 'VEHICULE', values: Record<string, string> = {}): IndexedAsset => ({
  assetId: id, name, normalizedName: name.toLowerCase(), aliases: [], family, category: family, subtype: null,
  record: { assetId: id, family, values }, brandModel: null, city: null, postalCode: null,
});
const input = (fileId: number, texts: string[], facts: Array<{ k: string; v: string; label?: string }> = [], o: Partial<IdentityProfileInput> = {}): IdentityProfileInput => ({
  fileId, title: `Document ${fileId}`, documentType: 'OTHER', supplier: null, multiAsset: false,
  texts: texts.map((t) => ({ origin: 'TRANSCRIPTION', zone: 'BODY', text: t })),
  facts: facts.map((f) => ({ canonicalKey: f.k, label: f.label ?? null, subject: null, value: f.v, excerpt: null })), ...o,
});
const orphan = (i: IdentityProfileInput): GraphDocument => ({ profile: extractIdentityProfile(i), orphan: true, primaryAssetIds: [] });
const anchor = (i: IdentityProfileInput, assetIds: number[]): GraphDocument => ({ profile: extractIdentityProfile(i), orphan: false, primaryAssetIds: assetIds });

const MAISON = asset(32, 'Maison', 'IMMOBILIER');
const KAROQ = asset(31, 'Skoda Karoq', 'VEHICULE', { registrationNumber: 'FG-123-HJ' });

/** Corpus synthétique équivalent au compte 10 (taxe foncière, DPE, assurance, sinistre, travaux, Bosch, Brandt). */
function compte10(extra: GraphDocument[] = []): GraphDocument[] {
  return [
    orphan(input(355, [`Avis de taxe foncière. Adresse du bien : ${ADR}`])),
    orphan(input(361, [`DPE — Adresse du logement : ${ADR}`], [{ k: 'dpeAdemeNumber', v: '2569E1234567X' }])),
    orphan(input(363, [`Attestation. Adresse du risque : ${ADR}`], [{ k: 'insuranceContractNumber', v: 'HAB-778899' }])),
    orphan(input(364, ['Déclaration de sinistre dégât des eaux'], [{ k: 'insuranceContractNumber', v: 'HAB-778899' }])),
    orphan(input(367, [`Facture travaux. Lieu des travaux : ${ADR}`])),
    orphan(input(358, [`Facture lave-vaisselle. Adresse de livraison : ${ADR}`], [{ k: 'serialNumber', v: 'FD9811-0456' }, { k: 'brand', v: 'Bosch' }])),
    orphan(input(372, [`Garantie four Brandt. Adresse de facturation : ${ADR}`], [{ k: 'modelName', v: 'BXP6332X' }, { k: 'brand', v: 'Brandt' }])),
    // Karoq : documents déjà rattachés (ancres véhicule) — l'adresse du titulaire n'est jamais une identité de logement.
    anchor(input(301, [`Carte grise FG-123-HJ. Titulaire : M. Exemple, domicile ${ADR}`], [{ k: 'registrationNumber', v: 'FG-123-HJ' }]), [31]),
    anchor(input(302, ['Facture entretien Skoda FG-123-HJ'], [{ k: 'registrationNumber', v: 'FG-123-HJ' }]), [31]),
    ...extra,
  ];
}

describe('L105D-U-SIG — identités typées et rôles d’adresse', () => {
  it('rôle de l’adresse = libellé le plus proche qui la précède ; facturation, livraison, intervention ≠ bien', () => {
    expect(addressRoleBefore('avis de taxe fonciere adresse du bien')).toBe('PROPERTY');
    expect(addressRoleBefore('client m dupont adresse de facturation')).toBe('BILLING');
    expect(addressRoleBefore('adresse du bien 3 rue x adresse de livraison')).toBe('DELIVERY');
    expect(addressRoleBefore('lieu d installation')).toBe('INTERVENTION');
    expect(addressRoleBefore('bonjour madame')).toBe('UNKNOWN');
  });
  it('adresses lues avec leur graphie d’origine et leur clé normalisée (abréviations maîtrisées)', () => {
    const [a] = addressesIn(`Adresse du bien : ${ADR}`);
    expect(a).toMatchObject({ role: 'PROPERTY', postalCode: '69000', display: '12 rue des Érables Fictifs, 69000 Lyon' });
    const p1 = extractIdentityProfile(input(1, [`Adresse du bien : 12 r. des Erables fictifs 69000 LYON`]));
    const p2 = extractIdentityProfile(input(2, [`Adresse du bien : ${ADR}`]));
    expect(p1.signals.find((s) => s.kind === 'ADDRESS')!.key).toBe(p2.signals.find((s) => s.kind === 'ADDRESS')!.key);
  });
  it('fait canonique address1 = identité de bien (HIGH) ; libellé « facturation » = simple contexte', () => {
    const p = extractIdentityProfile(input(1, [], [{ k: 'address1', v: ADR }]));
    expect(p.signals.find((s) => s.kind === 'ADDRESS')).toMatchObject({ family: 'PROPERTY', role: 'PROPERTY', reliability: 'HIGH', origin: 'FACT' });
    const f = extractIdentityProfile(input(1, [], [{ k: 'address1', v: ADR, label: 'Adresse de facturation' }]));
    expect(f.signals.find((s) => s.kind === 'ADDRESS')).toMatchObject({ family: 'CONTEXT', role: 'BILLING' });
  });
  it('fournisseur, marque, modèle : contexte ; série : identité d’équipement ; contrat : identité de dossier ; deux logements : contradiction', () => {
    const p = extractIdentityProfile(input(1, [], [{ k: 'brand', v: 'Bosch' }, { k: 'modelName', v: 'SMV4' }, { k: 'serialNumber', v: 'FD9811-0456' }, { k: 'contractNumber', v: 'CTR-445566' }], { supplier: 'Bosch' }));
    expect(p.signals.map((s) => `${s.family}:${s.kind}`).sort()).toEqual(['CONTEXT:BRAND', 'CONTEXT:SUPPLIER', 'CONTRACT:CONTRACT_REF', 'EQUIPMENT:MODEL_REF', 'EQUIPMENT:SERIAL']);
    const multi = extractIdentityProfile(input(2, [`Adresse du bien : ${ADR}. Adresse du bien : ${ADR2}`]));
    expect(multi.contradictions).toContain('MULTIPLE_PROPERTY_ADDRESSES');
    // Une lecture incertaine n'est jamais une identité.
    const u = extractIdentityProfile({ ...input(3, []), texts: [{ origin: 'SOURCE_UNITS', zone: 'BODY', text: `Adresse du bien : ${ADR}`, uncertain: true }] });
    expect(u.signals.find((s) => s.kind === 'ADDRESS')).toMatchObject({ family: 'CONTEXT', reliability: 'LOW' });
  });
});

describe('L105D-U-GRAPH — groupes et confrontation aux biens (ordre de création indifférent)', () => {
  it('compte 10 : un groupe « logement » (identité propre + contrat à UN saut), Bosch / Brandt exclus avec motif, Karoq jamais mêlé, « Maison » sans adresse → TO_CONFIRM', () => {
    const g = buildIdentityGraph({ accountId: 10, documents: compte10(), assets: [KAROQ, MAISON] });
    const logement = g.groups.filter((x) => x.family === 'PROPERTY');
    expect(logement).toHaveLength(1);
    const L = logement[0];
    expect(L.label).toBe(ADR);
    expect(L.members.map((m) => `${m.fileId}:${m.via}`)).toEqual(['355:OWN_IDENTITY', '361:OWN_IDENTITY', '363:OWN_IDENTITY', '364:CONTRACT', '367:OWN_IDENTITY']);
    expect(L.members.find((m) => m.fileId === 364)!.hopFromFileId).toBe(363);
    expect(L.excluded).toEqual([{ fileId: 358, reason: 'EQUIPMENT_DOCUMENT' }, { fileId: 372, reason: 'EQUIPMENT_DOCUMENT' }]);
    // L'adresse du TITULAIRE de la carte grise (domicile) n'est pas une identité de logement : l'ancre Karoq n'atteste rien.
    expect(L.anchors).toEqual([]);
    expect(L).toMatchObject({ status: 'TO_CONFIRM', targetAssetId: null, candidateAssetIds: [32], cardEligible: true });
    expect(L.members.length).toBeGreaterThanOrEqual(GROUP_CARD_MIN_DOCUMENTS);
    // Arêtes : provenance (références de signaux) conservée.
    expect(L.edges.find((e) => e.via === 'SAME_CONTRACT')).toMatchObject({ fromFileId: 363, toFileId: 364, kind: 'CONTRACT_REF' });
    expect(L.edges.every((e) => e.evidenceRefs.length === 2)).toBe(true);
  });
  it('bien créé AVANT ou APRÈS : même résultat ; adresse fiable sur la fiche → DEMONSTRABLE', () => {
    const avec = asset(32, 'Maison', 'IMMOBILIER', { address1: '12 rue des Erables Fictifs', postalCode: '69000', city: 'Lyon' });
    const g1 = buildIdentityGraph({ accountId: 10, documents: compte10(), assets: [avec, KAROQ] });
    const g2 = buildIdentityGraph({ accountId: 10, documents: [...compte10()].reverse(), assets: [KAROQ, avec] });
    const p1 = g1.groups.find((x) => x.family === 'PROPERTY')!;
    expect(p1).toMatchObject({ status: 'DEMONSTRABLE', targetAssetId: 32 });
    expect(g2.groups.find((x) => x.family === 'PROPERTY')!.fingerprint).toBe(p1.fingerprint);
  });
  it('documents déjà rattachés au même bien et à lui seul → ATTESTED ; en désaccord → AMBIGUOUS', () => {
    const ok = buildIdentityGraph({ accountId: 10, documents: compte10([anchor(input(390, [`Acte de vente. Bien situé : ${ADR}`]), [32])]), assets: [MAISON, KAROQ] });
    expect(ok.groups.find((x) => x.family === 'PROPERTY')).toMatchObject({ status: 'ATTESTED', targetAssetId: 32 });
    const app = asset(33, 'Appartement', 'IMMOBILIER');
    const ko = buildIdentityGraph({ accountId: 10, documents: compte10([anchor(input(390, [`Bien situé : ${ADR}`]), [32]), anchor(input(391, [`Bien situé : ${ADR}`]), [33])]), assets: [MAISON, app] });
    expect(ko.groups.find((x) => x.family === 'PROPERTY')!.status).toBe('AMBIGUOUS');
    // Ancre rattachée à un VÉHICULE : jamais une attestation, contradiction tracée.
    const veh = buildIdentityGraph({ accountId: 10, documents: compte10([anchor(input(392, [`Adresse du bien : ${ADR}`]), [31])]), assets: [MAISON, KAROQ] });
    const v = veh.groups.find((x) => x.family === 'PROPERTY')!;
    expect(v.status).toBe('TO_CONFIRM');
    expect(v.contradictions.map((c) => c.code)).toContain('ANCHOR_LINKED_TO_INCOMPATIBLE_ASSET');
  });
  it('décision CONFIRMED → CONFIRMED ; REFUSED stable tant que l’identité du bien ne change pas ; jamais un bien d’une autre famille', () => {
    const base = buildIdentityGraph({ accountId: 10, documents: compte10(), assets: [MAISON, KAROQ] });
    const gk = base.groups.find((x) => x.family === 'PROPERTY')!.groupKey;
    const conf = buildIdentityGraph({ accountId: 10, documents: compte10(), assets: [MAISON, KAROQ], decisions: [{ id: 1, groupKey: gk, assetId: 32, decision: 'CONFIRMED', contextFingerprint: assetIdentityFingerprint(MAISON) }] });
    expect(conf.groups.find((x) => x.family === 'PROPERTY')).toMatchObject({ status: 'CONFIRMED', targetAssetId: 32, decisionIds: [1] });
    const ref = buildIdentityGraph({ accountId: 10, documents: compte10(), assets: [MAISON, KAROQ], decisions: [{ id: 2, groupKey: gk, assetId: 32, decision: 'REFUSED', contextFingerprint: assetIdentityFingerprint(MAISON) }] });
    expect(ref.groups.find((x) => x.family === 'PROPERTY')).toMatchObject({ status: 'REFUSED', candidateAssetIds: [], refusedAssetIds: [32], cardEligible: false });
    // Bien renommé : le refus ne vaut plus (contexte différent) — nouvelle question possible.
    const renomme = asset(32, 'Maison de Lyon', 'IMMOBILIER');
    const r2 = buildIdentityGraph({ accountId: 10, documents: compte10(), assets: [renomme, KAROQ], decisions: [{ id: 2, groupKey: gk, assetId: 32, decision: 'REFUSED', contextFingerprint: assetIdentityFingerprint(MAISON) }] });
    expect(r2.groups.find((x) => x.family === 'PROPERTY')!.status).toBe('TO_CONFIRM');
    // Confirmation contredite par une adresse DIFFÉRENTE saisie ensuite : ambiguïté, rien d'appliqué.
    const autreAdr = asset(32, 'Maison', 'IMMOBILIER', { address1: '8 avenue des Tilleuls', postalCode: '69000' });
    const c2 = buildIdentityGraph({ accountId: 10, documents: compte10(), assets: [autreAdr], decisions: [{ id: 1, groupKey: gk, assetId: 32, decision: 'CONFIRMED', contextFingerprint: 'x' }] });
    expect(c2.groups.find((x) => x.family === 'PROPERTY')!.status).toBe('AMBIGUOUS');
    // Seul un véhicule au compte : aucun candidat (jamais « seul bien du compte »).
    expect(buildIdentityGraph({ accountId: 10, documents: compte10(), assets: [KAROQ] }).groups.find((x) => x.family === 'PROPERTY')!.status).toBe('NO_CANDIDATE');
  });
  it('deux logements de la même ville, fournisseur commun, facturation à la résidence : zéro mélange', () => {
    const docs = [
      orphan(input(1, [`Adresse du bien : ${ADR}`], [], { supplier: 'EDF' })),
      orphan(input(2, [`Adresse du bien : ${ADR}`], [], { supplier: 'EDF' })),
      // Logement loué : adresse du bien ≠ adresse de facturation (résidence du propriétaire).
      orphan(input(3, [`Adresse de facturation : ${ADR}. Adresse du bien : ${ADR2}`], [], { supplier: 'EDF' })),
      orphan(input(4, [`Adresse du bien : ${ADR2}`], [], { supplier: 'EDF' })),
      // Même fournisseur, même ville, aucune adresse de bien : jamais membre.
      orphan(input(5, ['Facture EDF Lyon 69000'], [], { supplier: 'EDF' })),
    ];
    const a = asset(40, 'Maison', 'IMMOBILIER', { address1: '12 rue des Erables Fictifs', postalCode: '69000' });
    const b = asset(41, 'Appartement', 'IMMOBILIER', { address1: '8 avenue des Tilleuls', postalCode: '69000' });
    const g = buildIdentityGraph({ accountId: 1, documents: docs, assets: [a, b] });
    const parCible = Object.fromEntries(g.groups.map((x) => [x.targetAssetId, x.members.map((m) => m.fileId)]));
    expect(parCible).toEqual({ 40: [1, 2], 41: [3, 4] });
    expect(membershipOf(g, 5)).toBeNull();
  });
  it('pas de transitivité abusive : contrat partagé par deux logements → exclu ; contrat → contrat → jamais deux sauts', () => {
    const docs = [
      orphan(input(1, [`Adresse du bien : ${ADR}`], [{ k: 'contractNumber', v: 'CTR-123456' }])),
      orphan(input(2, [`Adresse du bien : ${ADR2}`], [{ k: 'contractNumber', v: 'CTR-123456' }])),
      orphan(input(3, ['Avenant'], [{ k: 'contractNumber', v: 'CTR-123456' }])),
      // Chaîne : 4 partage un contrat avec 5 (sans identité), qui partage un autre contrat avec 1.
      orphan(input(5, ['Courrier'], [{ k: 'insuranceContractNumber', v: 'POL-999888' }, { k: 'contractNumber', v: 'CTR-777666' }])),
      orphan(input(6, [`Adresse du bien : ${ADR}`], [{ k: 'insuranceContractNumber', v: 'POL-999888' }])),
      orphan(input(4, ['Relance'], [{ k: 'contractNumber', v: 'CTR-777666' }])),
    ];
    const g = buildIdentityGraph({ accountId: 1, documents: docs, assets: [MAISON] });
    const tous = g.groups.flatMap((x) => x.members.map((m) => m.fileId));
    expect(tous).not.toContain(3);
    expect(g.exclusions.get(3)?.map((e) => e.reason)).toEqual(['CONTRACT_SPANS_SEVERAL_IDENTITIES', 'CONTRACT_SPANS_SEVERAL_IDENTITIES']);
    expect(tous).toContain(5); // un saut depuis 6
    expect(tous).not.toContain(4); // deux sauts : jamais
  });
  it('document multibiens : exclu, jamais membre automatique', () => {
    const g = buildIdentityGraph({ accountId: 1, documents: [
      orphan(input(1, [`Adresse du bien : ${ADR}`])), orphan(input(2, [`Adresse du bien : ${ADR}`])),
      orphan(input(3, [`Adresse du bien : ${ADR}`], [], { multiAsset: true })),
    ], assets: [MAISON] });
    expect(g.groups[0].excluded).toEqual([{ fileId: 3, reason: 'MULTI_ASSET_DOCUMENT' }]);
  });
});

describe('L105D-U-DEC — décision déterministe, garde avant l’IA, contexte croisé', () => {
  const cand = (c: Partial<DocumentAssetCandidate> & { assetId: number }): DocumentAssetCandidate => ({
    name: 'Maison', family: 'IMMOBILIER', subtype: null, identifiers: {}, serverSignals: [], t1: null, currentRole: null, ...c,
  });
  it('CONFIRMED / ATTESTED / DEMONSTRABLE : membres rattachés sans IA ; exclus et autres désignations : jamais', () => {
    const base = buildIdentityGraph({ accountId: 10, documents: compte10(), assets: [MAISON, KAROQ] });
    const gk = base.groups.find((x) => x.family === 'PROPERTY')!.groupKey;
    const g = buildIdentityGraph({ accountId: 10, documents: compte10(), assets: [MAISON, KAROQ], decisions: [{ id: 1, groupKey: gk, assetId: 32, decision: 'CONFIRMED', contextFingerprint: assetIdentityFingerprint(MAISON) }] });
    const ctx = (f: number) => identityContextOf(g, f, documentIdentityFingerprint(g, f));
    expect(decideFromIdentity(ctx(355), [], { multiAssetDeclared: false, identifiedAssetIds: [] })).toMatchObject({ kind: 'APPLY', assetId: 32, method: 'DETERMINISTIC', reason: 'GROUP_IDENTITY_CONFIRMED:OWN_IDENTITY' });
    expect(decideFromIdentity(ctx(364), [], { multiAssetDeclared: false, identifiedAssetIds: [] })).toMatchObject({ kind: 'APPLY', reason: 'GROUP_IDENTITY_CONFIRMED:CONTRACT' });
    // Bosch : exclu (adresse de livraison, appareil) — aucune affectation au logement.
    expect(decideFromIdentity(ctx(358), [], { multiAssetDeclared: false, identifiedAssetIds: [] })).toBeNull();
    // Autre bien désigné par un fait ou un identifiant : le groupe ne tranche pas.
    expect(decideFromIdentity(ctx(355), [cand({ assetId: 33, sources: ['FACT_TARGET'] })], { multiAssetDeclared: false, identifiedAssetIds: [] })).toBeNull();
    expect(decideFromIdentity(ctx(355), [], { multiAssetDeclared: false, identifiedAssetIds: [33] })).toBeNull();
    expect(decideFromIdentity(ctx(355), [], { multiAssetDeclared: true, identifiedAssetIds: [] })).toBeNull();
  });
  it('TO_CONFIRM avec carte groupée → abstention sans IA ; refus → biens retirés ; groupe d’un seul document → pas de carte groupée', () => {
    const g = buildIdentityGraph({ accountId: 10, documents: compte10(), assets: [MAISON, KAROQ] });
    const ctx = identityContextOf(g, 355, documentIdentityFingerprint(g, 355));
    expect(identityGate(ctx)).toMatchObject({ kind: 'GROUP_CONFIRMATION_PENDING' });
    expect(decideFromIdentity(ctx, [], { multiAssetDeclared: false, identifiedAssetIds: [] })).toBeNull();
    const seul = buildIdentityGraph({ accountId: 1, documents: [orphan(input(1, [`Adresse du bien : ${ADR}`]))], assets: [MAISON] });
    expect(seul.groups[0]).toMatchObject({ status: 'TO_CONFIRM', cardEligible: false });
    expect(identityGate(identityContextOf(seul, 1, null))).toBeNull();
    const gk = g.groups.find((x) => x.family === 'PROPERTY')!.groupKey;
    const r = buildIdentityGraph({ accountId: 10, documents: compte10(), assets: [MAISON, KAROQ], decisions: [{ id: 2, groupKey: gk, assetId: 32, decision: 'REFUSED', contextFingerprint: assetIdentityFingerprint(MAISON) }] });
    expect(identityGate(identityContextOf(r, 355, null))).toEqual({ kind: 'REFUSED_ASSETS', groupKey: gk, refusedAssetIds: [32] });
  });
  it('empreinte « identité » : null hors groupe (empreinte de contexte inchangée), change avec le statut du groupe', () => {
    const g = buildIdentityGraph({ accountId: 10, documents: compte10(), assets: [MAISON, KAROQ] });
    expect(documentIdentityFingerprint(g, 999)).toBeNull();
    expect(documentIdentityFingerprint(g, 302)).toBeNull();
    const avec = asset(32, 'Maison', 'IMMOBILIER', { address1: '12 rue des Erables Fictifs', postalCode: '69000' });
    const g2 = buildIdentityGraph({ accountId: 10, documents: compte10(), assets: [avec, KAROQ] });
    expect(documentIdentityFingerprint(g2, 355)).not.toBe(documentIdentityFingerprint(g, 355));
  });
  it('contexte croisé du prompt : références opaques, AUCUNE adresse, preuves numérotées, rôle des documents', () => {
    const g = buildIdentityGraph({ accountId: 10, documents: compte10(), assets: [MAISON, KAROQ] });
    const c = crossDocumentContext(identityContextOf(g, 364, null), 364, g.documents)!;
    const json = JSON.stringify(c.context);
    expect(json).not.toMatch(/rables|Tilleuls|69000/i);
    expect(c.context).toMatchObject({ contract: 't3-document-asset-cross-v1', documentIdentity: { status: 'MEMBER', membership: 'CONTRACT', hopFromFileId: 363, identityRef: 'I1' } });
    expect(c.context.groupDocuments[0].fileId).toBe(364);
    expect(c.context.groupDocuments.find((d) => d.fileId === 358)).toMatchObject({ membership: 'EXCLUDED', exclusionReason: 'EQUIPMENT_DOCUMENT' });
    expect(c.context.groupToAsset).toMatchObject({ status: 'TO_CONFIRM', candidateAssetIds: [32] });
    expect([...c.allowedEvidenceIds]).toEqual(c.context.evidences.map((e) => e.evidenceId));
    // Document exclu : contexte transmis aussi (EXCLUDED), sans appartenance.
    const ex = crossDocumentContext(identityContextOf(g, 358, null), 358, g.documents)!;
    expect(ex.context.documentIdentity).toMatchObject({ status: 'EXCLUDED', exclusionReason: 'EQUIPMENT_DOCUMENT', membership: null });
    expect(crossDocumentContext(identityContextOf(g, 999, null), 999)).toBeNull();
  });
  it('variables : sans contrat, STRICTEMENT celles d’avant ; avec contrat, `document.fileId` et `crossDocument` ajoutés au seul SUBJECT_CONTEXT', () => {
    const subject = { title: 'Taxe foncière', documentType: 'PROPERTY_TAX', documentDate: null, supplier: null, description: null, multiAssetDeclared: false, facts: [] };
    const avant = documentAssetVariables(subject, [cand({ assetId: 32 })]);
    expect(documentAssetVariables(subject, [cand({ assetId: 32 })], null)).toEqual(avant);
    const g = buildIdentityGraph({ accountId: 10, documents: compte10(), assets: [MAISON, KAROQ] });
    const c = crossDocumentContext(identityContextOf(g, 355, null), 355, g.documents)!;
    const apres = documentAssetVariables(subject, [cand({ assetId: 32 })], { fileId: 355, context: c.context });
    expect(Object.keys(apres)).toEqual(Object.keys(avant));
    expect({ ...apres, SUBJECT_CONTEXT: null }).toEqual({ ...avant, SUBJECT_CONTEXT: null });
    const sc = JSON.parse(apres.SUBJECT_CONTEXT as string);
    expect(sc.document.fileId).toBe(355);
    expect(sc.crossDocument.contract).toBe('t3-document-asset-cross-v1');
  });
  it('sortie : preuve citée inconnue → monde fermé violé ; relation non établie / validation demandée → aucun rattachement ; section absente → règles d’avant', () => {
    expect(validateCrossDocumentOutput(null, { allowedEvidenceIds: new Set([1]), member: true })).toEqual({ violation: false, blockApply: false, reasons: [] });
    expect(validateCrossDocumentOutput({ documentIdentity: 'ESTABLISHED', groupToAsset: 'ESTABLISHED', documentApplicability: 'APPLIES', citedEvidenceIds: [7] }, { allowedEvidenceIds: new Set([1]), member: true }).violation).toBe(true);
    const fort = cand({ assetId: 32, serverSignals: ['adresse du bien identique à celle du document (contrôle serveur exact)'] });
    const sortie = (cd: Record<string, unknown> | null) => ({ task: 'LINK_AMBIGUITY' as const, matches: [{ candidateId: 32, score: 0.95, confidence: 'certain' as const, reason: 'adresse' }], ...(cd ? { crossDocument: cd as never } : {}) });
    const cross = { allowedEvidenceIds: new Set([1, 2]), member: true };
    expect(decideFromAiOutput(sortie(null), [fort], cross)).toMatchObject({ kind: 'APPLY', assetId: 32 });
    expect(decideFromAiOutput(sortie({ documentIdentity: 'ESTABLISHED', groupToAsset: 'ESTABLISHED', documentApplicability: 'APPLIES', citedEvidenceIds: [1] }), [fort], cross)).toMatchObject({ kind: 'APPLY' });
    expect(decideFromAiOutput(sortie({ documentIdentity: 'ESTABLISHED', groupToAsset: 'NOT_ESTABLISHED', documentApplicability: 'APPLIES' }), [fort], cross)).toMatchObject({ kind: 'ABSTAIN', reasonCode: 'INSUFFICIENT_EVIDENCE' });
    expect(decideFromAiOutput(sortie({ documentIdentity: 'ESTABLISHED', groupToAsset: 'ESTABLISHED', documentApplicability: 'APPLIES', userValidationRequired: true }), [fort], cross)).toMatchObject({ kind: 'ABSTAIN' });
    expect(decideFromAiOutput(sortie({ documentIdentity: 'ESTABLISHED', groupToAsset: 'ESTABLISHED', documentApplicability: 'APPLIES', citedEvidenceIds: [99] }), [fort], cross)).toMatchObject({ kind: 'ABSTAIN', reasonCode: 'CLOSED_WORLD_VIOLATION' });
    // Seuil et hasEvidence INCHANGÉS : un « certain » sans preuve serveur reste refusé, même avec une section favorable.
    const sansPreuve = cand({ assetId: 32, contextSignals: ['catégorie'] });
    expect(decideFromAiOutput(sortie({ documentIdentity: 'ESTABLISHED', groupToAsset: 'ESTABLISHED', documentApplicability: 'APPLIES' }), [sansPreuve], cross)).toMatchObject({ kind: 'ABSTAIN', reasonCode: 'UNSUPPORTED_CHOICE' });
  });
});
