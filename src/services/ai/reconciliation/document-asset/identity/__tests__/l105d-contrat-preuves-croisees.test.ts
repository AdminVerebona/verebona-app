/**
 * Lot 105D — §E (contrat `t3-document-asset-cross-v1`), §F (carte groupée) et
 * §G (cohérence) — vérifications PURES :
 *   · bloc du guide du PO collé dans le texte LIVRÉ comme le ferait le PO :
 *     ligne repère unique, marqueur détecté après collage seulement, aucun
 *     emplacement ni branche ajoutés, contrôles d'activation du BO sans
 *     bloquant ni avertissement nouveau, exemple JSON passé dans le schéma et
 *     la décision serveur réels ; contrat déclaré au registre de conformité ;
 *   · le texte LIVRÉ du prompt T3 n'est pas modifié (empreinte du corpus) ;
 *   · carte groupée : question lisible (aucun libellé technique), choix,
 *     périmètre visible ; registre de cohérence : contrôle en FIN, ASSET_CREATED
 *     relayé ; règle « À traiter » déclarée (catalogue, publication).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: {} }));

const { inspectMasterTemplate } = await import('@/services/ai/prompts/prompt-loader');
const { checkMasterPromptContent } = await import('@/services/ai/master-prompts/master-prompt-checks');
const { guideBlock } = await import('@/services/ai/prompt-conformity/guide-blocks');
const { MARKER_CONTRACT_DECLARATIONS } = await import('@/services/ai/prompt-conformity/contracts');
const { T3LinkAmbiguityOutput } = await import('@/services/ai/reconciliation/master/t3-contract');
const { promptCarriesCrossDocument, T3_DOCUMENT_ASSET_CROSS_CONTRACT, T3_DOCUMENT_ASSET_CROSS_PROMPT_CONTRACT } = await import('../contract');
const { decideFromAiOutput } = await import('../../decision');
const cards = await import('@/services/to-process/identity-group-cards');
const { technicalLabelIssues } = await import('@/services/to-process/card-labels');
const { getRule } = await import('@/services/to-process/rules-catalog');
const { PUBLISHABILITY_CONTRACTS } = await import('@/services/to-process/publishability');
const { groupScopeOf } = await import('@/services/to-process/to-process-query.service');
const { COHERENCE_REGISTRY } = await import('@/services/coherence/registry');
const { COHERENCE_BUSINESS_EVENTS } = await import('@/services/coherence/events');
const { resolverOf } = await import('@/services/ai/reconciliation/continuous/open-actions.service');

const RACINE = process.cwd();
const GUIDE = readFileSync(join(RACINE, 'docs', 'exploitation', 'prompts-a-appliquer-par-le-po.md'), 'utf-8');
const T3_LIVRE = readFileSync(join(RACINE, 'src', 'services', 'ai', 'prompts', 'reconciliation', 't3_master_v1.txt'), 'utf-8');
const occurrences = (t: string, m: string) => t.split(m).length - 1;
const coller = (texte: string, b: { anchor: string | null; text: string }) => texte.replace(b.anchor!, `${b.text}\n\n${b.anchor}`);

function jsonsDe(texte: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const lignes = texte.split('\n');
  for (let k = 0; k < lignes.length; k++) {
    if (!lignes[k].startsWith('{')) continue;
    const reste = lignes.slice(k).join('\n');
    let prof = 0; let chaine = false; let echap = false; let fin = -1;
    for (let c = 0; c < reste.length; c++) {
      const ch = reste[c];
      if (chaine) { if (echap) echap = false; else if (ch === '\\') echap = true; else if (ch === '"') chaine = false; continue; }
      if (ch === '"') chaine = true; else if (ch === '{') prof += 1; else if (ch === '}') { prof -= 1; if (prof === 0) { fin = c; break; } }
    }
    const brut = reste.slice(0, fin + 1);
    out.push(JSON.parse(brut));
    k += brut.split('\n').length - 1;
  }
  return out;
}

describe('L105D-U-GUIDE-12 — bloc T3 `t3-document-asset-cross-v1`', () => {
  const b = guideBlock(T3_DOCUMENT_ASSET_CROSS_CONTRACT)!;
  it('bloc balisé, ligne repère unique dans le texte livré, marqueur détecté après collage seulement ; aucun emplacement ni branche ajoutés', () => {
    expect(b).toMatchObject({ prompt: 't3', action: 'insert-before', anchor: 'SORTIE LINK_AMBIGUITY' });
    expect(occurrences(T3_LIVRE, b.anchor!)).toBe(1);
    const apres = coller(T3_LIVRE, b);
    expect(promptCarriesCrossDocument(T3_LIVRE)).toBe(false);
    expect(promptCarriesCrossDocument(apres)).toBe(true);
    expect(inspectMasterTemplate(b.text).placeholders).toEqual([]);
    expect(inspectMasterTemplate(apres).branches).toEqual(inspectMasterTemplate(T3_LIVRE).branches);
    expect(inspectMasterTemplate(apres).placeholders).toEqual(inspectMasterTemplate(T3_LIVRE).placeholders);
    // Le bloc reste DANS la branche LINK_AMBIGUITY (après la relation DOCUMENT_ASSET, avant sa sortie).
    expect(apres.indexOf('PREUVES CROISÉES')).toBeGreaterThan(apres.indexOf('RELATION DOCUMENT_ASSET (Relation'));
    expect(apres.indexOf('PREUVES CROISÉES')).toBeLessThan(apres.indexOf('SORTIE LINK_AMBIGUITY'));
  });
  it('règles métier du ticket (§E) présentes dans le texte à coller', () => {
    for (const m of ['MÊME GROUPE ≠ MÊME BIEN', 'adresse de facturation', 'n’invente aucun document', 'citedEvidenceIds', 'TROIS QUESTIONS SÉPARÉES',
      'documentApplicability', 'userValidationRequired', 'Le serveur, jamais toi seul', '0,8', '"certain"']) {
      expect(b.text, m).toContain(m);
    }
  });
  it('contrôles d’activation du BO : aucun bloquant, aucun avertissement nouveau', () => {
    const apres = coller(T3_LIVRE, b);
    expect(checkMasterPromptContent('T3', apres).blocking).toEqual([]);
    expect(checkMasterPromptContent('T3', apres).warnings.map((w) => w.code)).toEqual(checkMasterPromptContent('T3', T3_LIVRE).warnings.map((w) => w.code));
  });
  it('exemple JSON : schéma réel LINK_AMBIGUITY (section facultative acceptée), décision serveur réelle → abstention', () => {
    const [ex] = jsonsDe(b.text);
    const out = T3LinkAmbiguityOutput.parse(ex);
    expect(out.crossDocument).toMatchObject({ groupToAsset: 'NOT_ESTABLISHED', userValidationRequired: true });
    const d = decideFromAiOutput(out, [{ assetId: 32, name: 'Maison', family: 'IMMOBILIER', subtype: null, identifiers: {}, serverSignals: [], t1: null, currentRole: null }],
      { allowedEvidenceIds: new Set([1, 2]), member: true });
    expect(d.kind).toBe('ABSTAIN');
    // Ancien format (sans la section) toujours accepté.
    expect(() => T3LinkAmbiguityOutput.parse({ task: 'LINK_AMBIGUITY', matches: [] })).not.toThrow();
  });
  it('contrat déclaré au registre de conformité (99B) en une ligne, détection = fonction de production ; guide à jour', async () => {
    const d = MARKER_CONTRACT_DECLARATIONS.find((x) => x.id === T3_DOCUMENT_ASSET_CROSS_CONTRACT)!;
    expect(d).toMatchObject({ treatment: 'T3', guideStep: 12, lot: '105D', task: 'LINK_AMBIGUITY', blockId: T3_DOCUMENT_ASSET_CROSS_CONTRACT, killSwitch: 'T3_CROSS_DOCUMENT_CONTEXT_ENABLED' });
    expect(await d.detect(coller(T3_LIVRE, b))).toBe(true);
    expect(await d.detect(T3_LIVRE)).toBe(false);
    expect(T3_DOCUMENT_ASSET_CROSS_PROMPT_CONTRACT.guide.step).toBe(12);
    for (const m of ['| 12 | 105D', 'promptCarriesCrossDocument', 'validateCrossDocumentOutput', 'T3_IDENTITY_GROUPS_ENABLED', 'P-T3-24']) expect(GUIDE, m).toContain(m);
  });
});

describe('L105D-U-CARD — carte groupée « Le logement du … est-il votre bien « Maison » ? »', () => {
  it('question en français simple (aucun libellé technique), deux choix explicites, seul le bien de la carte accepté', () => {
    const q = cards.identityGroupQuestion({ family: 'PROPERTY', label: '12 rue des Érables Fictifs, 69000 Lyon', assetName: 'Maison' });
    expect(q).toBe('Le logement du 12 rue des Érables Fictifs, 69000 Lyon est-il votre bien « Maison » ?');
    expect(technicalLabelIssues(q, { userContent: true })).toEqual([]);
    expect(q).not.toMatch(/op[ée]ration/i);
    const p = cards.identityGroupProposals({ assetId: 32, assetName: 'Maison', documentCount: 5 });
    expect(p.map((x) => x.value)).toEqual(['CONFIRM:32', 'REFUSE']);
    expect(p[0].label).toContain('5 documents');
    expect(cards.parseIdentityGroupChoice('CONFIRM:32', { assetId: 32 })).toEqual({ kind: 'CONFIRM', assetId: 32 });
    expect(cards.parseIdentityGroupChoice('CONFIRM:33', { assetId: 32 })).toBeNull();
    expect(cards.parseIdentityGroupChoice('REFUSE', { assetId: 32 })).toEqual({ kind: 'REFUSE' });
    expect(cards.parseIdentityGroupChoice('ALL', { assetId: 32 })).toBeNull();
  });
  it('périmètre exact : documents inclus et preuve, exceptions et motif, relu tel quel par la file « À traiter »', () => {
    const ctx = cards.groupCardContext({
      groupKey: 'g1', fingerprint: 'f', family: 'PROPERTY', label: '12 rue des Érables Fictifs, 69000 Lyon',
      members: [{ fileId: 355, via: 'OWN_IDENTITY' }, { fileId: 364, via: 'CONTRACT' }], excluded: [{ fileId: 358, reason: 'EQUIPMENT_DOCUMENT' }],
      candidateAssetIds: [32], evidenceKinds: [{ fileId: 355, kinds: ['ADDRESS'] }],
    }, 32, new Map([[355, 'Avis de taxe foncière'], [364, 'Déclaration de sinistre'], [358, 'Facture Bosch']]));
    expect(ctx.scope.documents).toEqual([
      { id: 355, title: 'Avis de taxe foncière', via: 'OWN_IDENTITY', evidence: 'adresse du bien' },
      { id: 364, title: 'Déclaration de sinistre', via: 'CONTRACT', evidence: 'même numéro de contrat qu’un document du groupe' },
    ]);
    expect(ctx.scope.exceptions[0].reason).toMatch(/appareil/);
    const vue = groupScopeOf('LINK-ASSET-GROUP', ctx)!;
    expect(vue.documents).toHaveLength(2);
    expect(vue.exceptions).toHaveLength(1);
    expect(groupScopeOf('LINK-ASSET', ctx)).toBeUndefined();
  });
  it('règle déclarée : catalogue (producteur dédié), contrat de publication, résolveur T3 de la phase « À traiter ouverts »', () => {
    expect(getRule('LINK-ASSET-GROUP')).toMatchObject({ targetType: 'DOCUMENT', relationKey: 'identityGroup', producer: 'T3_IDENTITY_GROUP', allowNotApplicable: false });
    expect(PUBLISHABILITY_CONTRACTS['LINK-ASSET-GROUP']).toMatchObject({ family: 'DOCUMENTS', decisions: 'PRODUCTION' });
    expect(resolverOf('LINK-ASSET-GROUP')).toEqual({ resolver: 'T3_IDENTITY_GROUP', t3: true });
  });
});

describe('L105D-U-COH — cohérence : ASSET_CREATED relayé, contrôle spécialisé EN FIN de registre', () => {
  it('ASSET_CREATED déclenche le contrôle ciblé ; COH-DOC-PRIMARY-LINK est le dernier contrôle, aucun doublon', () => {
    expect(COHERENCE_BUSINESS_EVENTS.has('ASSET_CREATED')).toBe(true);
    const ids = COHERENCE_REGISTRY.map((c) => c.id);
    // Ajouté en fin au lot 105D ; seuls des contrôles plus récents le suivent (106A).
    // Lot 107D : COH-PRICE-MULTI-ARTICLE ajouté en fin de registre.
    expect(ids.slice(ids.indexOf('COH-DOC-PRIMARY-LINK'))).toEqual(['COH-DOC-PRIMARY-LINK', 'COH-AGENDA-EQUIVALENT-REPRESENTATIONS', 'COH-PRICE-MULTI-ARTICLE',
      // Lot 108 : contrôles A, B et D ajoutés en fin de registre.
      'COH-TCO-SAME-FACT', 'COH-TCO-AMOUNT-RECOVERY', 'COH-DOC-DATE-FALLBACK',
      // Lot 109A : relations métier autour de l'Opération pivot (fin de registre).
      'COH-OPERATION-RELATIONS',
      // Lot 109D : remises jamais lues comme des avoirs (fin de registre).
      'COH-TCO-COMMERCIAL-ADJUSTMENTS',
      // Lot 109K : couverture PDF (fin de registre).
      'COH-T1-PDF-COVERAGE',
      // Lot 111I : rattachements multiples reflétés par la source canonique (fin de registre).
      'COH-DOC-TARGETS',
      // Lot 111S : acquisition documentaire établie sans Opération active ni historique « Achat » (fin de registre).
      'COH-OPS-ACQUISITION-DOCUMENT',
      // Lot 111U : projection documentaire CIL (fin de registre).
      'COH-CIL-DOCUMENT-PROJECTION',
      // Lot 111X : coordonnées des fournisseurs issues des documents actifs (fin de registre).
      'COH-SUPPLIER-COORDINATES',
      // Lot 113G : identité des fiches fournisseur, doublons réels soumis une fois par paire (fin de registre).
      'COH-SUPPLIER-IDENTITY',
      // Lot 113W (#724) : périodes métier des documents, en fin de registre.
      'COH-DOC-BUSINESS-PERIODS',
      // Lot 113Z (#723) : description T1 reprise depuis l'extraction persistée, en fin de registre.
      'COH-DOC-DESCRIPTION-T1',
      // Lot 113AA (#725) : résolution des périodes de couverture d'un événement de référence, en fin de registre.
      'COH-OPS-PERIOD-RESOLUTION',
      // Lot 113AK (#736) : provenance des faits T1 et preuves orphelines, en fin de registre.
      'COH-DOC-FACT-PROVENANCE']);
    expect(ids.filter((x) => x === 'COH-DOC-PRIMARY-LINK')).toHaveLength(1);
    const c = COHERENCE_REGISTRY.find((x) => x.id === 'COH-DOC-PRIMARY-LINK')!;
    expect(c.triggers).toEqual(expect.arrayContaining(['ASSET_CREATED', 'ASSET_UPDATED', 'SOURCE_ANALYZED']));
    expect(c.anomalies).toEqual(expect.arrayContaining(['PRIMARY_LINK_RECOVERABLE', 'PRIMARY_LINK_IDENTITY_TO_CONFIRM', 'PRIMARY_LINK_NO_CANDIDATE', 'PRIMARY_LINK_PENDING', 'PRIMARY_LINK_TREATMENT_FAILED']));
    expect(c.forbiddenRepairs.join(' ')).toMatch(/IA/);
  });
});
