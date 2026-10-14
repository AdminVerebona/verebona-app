/**
 * Lot 49B — tickets T3 « Réexaminer systématiquement les À traiter ouverts »
 * et « Exploiter la couche exhaustive T1 (document_source_units) » : règles
 * pures (routage, fournisseurs de connaissance, Candidate Builder, empreinte,
 * recherche ciblée) et orchestration du passage compte. Chaîne complète sur
 * base réelle : `src/test/e2e/scenarios/l49b-t3-a-traiter-couche-exhaustive.e2e.ts`
 * (tests 1 à 9 du ticket « À traiter », AC1 à AC8 du ticket « couche exhaustive »).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { effectOfClosedDuringRun, resolverOf, OPEN_ACTION_EFFECTS } from '../open-actions.service';
import { addressTerms, identifierTerms, nameTerms } from '../source-unit-targeting';
import {
  RELIABLE_UNRESOLVED_REASONS, sourceUnitTexts, unresolvedFactTexts, unitText,
} from '../../document-asset/source-unit-provider';
import { buildDocumentAssetCandidates, CANDIDATE_BUILDER_VERSION } from '../../document-asset/candidate-builder';
import { documentAssetContextFingerprint, matchSourceUnits } from '../../document-asset/context';
import { documentKnowledgeDigest, usedDocumentSources, type DocumentKnowledgeSources, type DocumentSourceText } from '../../document-asset/document-sources';
import { buildMatchingIndex, type IndexedAsset } from '../../document-asset/matching-index';
import { normalizeText } from '../../document-asset/identifiers';
import { previousAiAt } from '../../document-asset/resolve-document-asset.service';
import * as budget from '../../document-asset/rearbitration-budget';

const bien = (id: number, name: string, values: Record<string, string> = {}, family: IndexedAsset['family'] = 'IMMOBILIER'): IndexedAsset => ({
  assetId: id, name, normalizedName: normalizeText(name), aliases: [], family, category: 'IMMOBILIER', subtype: null,
  record: { assetId: id, family, values }, brandModel: null, city: null, postalCode: null,
});
const index = buildMatchingIndex(1, [
  bien(1, 'Appartement de Lyon'),
  bien(2, 'Maison Victor Hugo', { address1: '12 rue Victor Hugo', postalCode: '69003', city: 'Lyon' }),
  bien(3, 'Maison de Bourg'),
], []);
const sources = (texts: DocumentSourceText[]): DocumentKnowledgeSources => ({
  accountId: 1, fileId: 10, origins: ['EXTRACTION'], texts, facts: [],
  extraction: { extractedAt: null, title: 'Facture', description: null, documentType: null, documentDate: null, supplier: null, multiAsset: false },
  digest: 'd',
});
const etat = { secondaryAssetIds: [], mentionedAssetIds: [] };
const construire = (texts: DocumentSourceText[]) => buildDocumentAssetCandidates({ index, sources: sources(texts), state: etat, t1Candidates: [], fileId: 10 });

describe('ticket « À traiter ouverts » — routage par le registre PROCESSING_RULES (§2, §3)', () => {
  it('chaque règle a son résolveur ; T4 et règles inconnues hors T3 (jamais le prompt T3)', () => {
    expect(resolverOf('LINK-ASSET')).toEqual({ resolver: 'T3_DOCUMENT_ASSET', t3: true });
    expect(resolverOf('LINK-ASSET-CONFLICT')).toEqual({ resolver: 'T3_ASSET_CONFLICT', t3: true });
    expect(resolverOf('LINK-ELT')).toEqual({ resolver: 'T3_EQUIPMENT_LINK', t3: true });
    expect(resolverOf('DATA-REGISTRATION')).toEqual({ resolver: 'T3_ASSET', t3: true });
    expect(resolverOf('DATA-ACQUISITION-PRICE')).toEqual({ resolver: 'T3_ASSET', t3: true });
    expect(resolverOf('ENTITY-FIELD')).toEqual({ resolver: 'T3_ENTITY', t3: true });
    expect(resolverOf('ENTITY-FIELD-ROOM')).toEqual({ resolver: 'T3_ENTITY', t3: true });
    for (const t4 of ['AGENDA-DUPLICATE', 'AGENDA-DONE', 'AGENDA-NOT-DONE', 'AGENDA-PROPOSAL', 'ASSET-STATUS']) {
      expect(resolverOf(t4).t3, t4).toBe(false);
    }
    expect(resolverOf('XX-INCONNUE')).toEqual({ resolver: 'UNKNOWN_RULE', t3: false });
  });

  it('effets du rapport (§15) ; ligne fermée pendant le passage : CLOSED (résolue par T3) ou SUPERSEDED', () => {
    expect(OPEN_ACTION_EFFECTS).toEqual(['CLOSED', 'UPDATED', 'STILL_OPEN', 'SKIPPED_NOT_T3', 'SUPERSEDED', 'ERROR']);
    expect(effectOfClosedDuringRun('T3_ASSET', 'OBSOLETE')).toBe('CLOSED');
    expect(effectOfClosedDuringRun('T3_ASSET', 'USER_DISMISSED')).toBe('SUPERSEDED');
  });

  it('T3-OPEN-E01 (lot 54A) : plus aucun plafond T3 des réarbitrages — fonctions et variables supprimées', () => {
    expect(budget).not.toHaveProperty('rearbitrationsPerPass');
    expect(budget).not.toHaveProperty('rearbitrationsPerDay');
    expect(budget).not.toHaveProperty('dailyRearbitrationAllowed');
  });

  it('l’issue précédente n’est qu’un historique (date du dernier appel modèle, monitoring)', () => {
    expect(previousAiAt({ lastEvaluation: { aiCalled: true, at: '2026-10-01T00:00:00Z' } } as never)).toBe('2026-10-01T00:00:00Z');
    expect(previousAiAt({ lastEvaluation: { lastAiAt: '2026-10-02T00:00:00Z' } } as never)).toBe('2026-10-02T00:00:00Z');
    expect(previousAiAt(null)).toBeNull();
  });
});

describe('orchestration du passage compte (§1, §13) — exécutée sur base réelle par T3OA-09', () => {
  const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
  const A = src('src/services/ai/reconciliation/account-reconciliation.service.ts');
  const O = src('src/services/ai/reconciliation/continuous/open-actions.service.ts');
  const Q = src('src/services/ai/reconciliation/document-asset/queue.ts');

  it('phase « open actions » à CHAQUE passage, après les biens et la connaissance ouverte, non bloquante', () => {
    expect(A).toMatch(/deps\.reconcileOpenActions\(accountId/);
    expect(A.indexOf('reconcileOpenKnowledge(accountId')).toBeLessThan(A.indexOf('deps.reconcileOpenActions(accountId'));
    expect(A).toMatch(/« À traiter » ouverts du compte \$\{accountId\} non réexaminés/);
  });

  it('parcours RÉEL de to_process_actions, paginé par curseur, borne du cycle (jamais « LIMIT 200 » rejoué)', () => {
    expect(O).toMatch(/FROM to_process_actions\s+WHERE account_id = \$1 AND id > \$2 AND id <= \$3/);
    expect(O).toMatch(/ORDER BY id LIMIT \$5/);
    expect(O).toMatch(/curseur = Number\(rows\[rows\.length - 1\]\.id\)/);
  });

  it('voie canonique unique : la phase s’efface devant un travail DOCUMENT_ASSET vivant ; le balayage délègue les cartes ouvertes à contexte identique', () => {
    expect(O).toMatch(/liveDocumentJob\(fileId\)/);
    expect(Q).toMatch(/verdict === 'OPEN_ACTION'\) \{ delegated \+= 1; continue; \}/);
  });

  it('jamais T1, jamais le fichier (base seulement)', () => {
    for (const f of [O, src('src/services/ai/reconciliation/document-asset/source-unit-provider.ts'), src('src/services/ai/reconciliation/continuous/source-unit-targeting.ts')]) {
      expect(f).not.toMatch(/analyzeFileSources|source-analysis\/entrypoint|getSignedUrl|fetchSourceBytes/);
    }
  });
});

describe('ticket « couche exhaustive T1 » — fournisseurs SOURCE_UNITS et UNRESOLVED_FACTS (§1 à §4)', () => {
  const unite = (id: string, kind: string, coverageStatus: string, text: string) => ({ sourceUnitId: id, kind, coverageStatus, text, label: null, value: null });

  it('COVERED, UNRESOLVED, UNCERTAIN apportent de la connaissance ; FAILED jamais ; NON_INFORMATIONAL ignoré ; UNCERTAIN marqué incertain', () => {
    const t = sourceUnitTexts([
      unite('page:1:field:1', 'LABEL_VALUE', 'UNRESOLVED', 'Lieu : 12 rue Victor Hugo'),
      unite('page:1:block:1', 'TEXT_BLOCK', 'COVERED', 'Texte couvert'),
      unite('page:2:table:1:row:1', 'TABLE_ROW', 'UNCERTAIN', 'Maison de Bourg'),
      unite('page:3:block:1', 'TEXT_BLOCK', 'FAILED', 'Illisible'),
      unite('page:3:block:2', 'TEXT_BLOCK', 'NON_INFORMATIONAL', 'Page 3/3'),
      unite('page:4:gap:5', 'PAGE_GAP', 'UNRESOLVED', ''),
    ]);
    expect(t.map((x) => [x.unitIds?.[0], x.uncertain === true])).toEqual([
      ['page:1:field:1', false], ['page:1:block:1', false], ['page:2:table:1:row:1', true],
    ]);
    expect(t.every((x) => x.origin === 'SOURCE_UNITS')).toBe(true);
    expect(unitText({ text: null, label: 'N° de série', value: 'SN-1' })).toBe('N° de série : SN-1');
  });

  it('sélection BORNÉE (jamais tout le document dans le modèle)', () => {
    const many = Array.from({ length: 50 }, (_, i) => unite(`page:1:block:${i}`, 'TEXT_BLOCK', 'UNRESOLVED', 'x'.repeat(100)));
    expect(sourceUnitTexts(many, 1_000)).toHaveLength(10);
  });

  it('faits non résolus : UNRESOLVED et RETAINED seulement ; charge brute, incertaine sauf motif fiable', () => {
    const f = (id: number, reason: string, status: string, rawValue: string | null, originalPayload: unknown = null) => ({
      id, reason, status, sourceUnitIds: [], rawKey: 'cle', canonicalKey: null, rawValue, originalPayload,
    });
    const t = unresolvedFactTexts([
      f(1, 'UNKNOWN_TARGET', 'UNRESOLVED', 'AB-123-CD'),
      f(2, 'INVALID_SCHEMA', 'UNRESOLVED', null, { rawValue: 'EF-456-GH', confidence: 'certain' }),
      f(3, 'UNKNOWN_CANONICAL_KEY', 'RECOVERED', 'perdu'),
      f(4, 'VALUE_TRUNCATED', 'RETAINED', 'Libellé intégral'),
    ]);
    expect(t.map((x) => [x.unitIds?.[0], x.text, x.uncertain === true])).toEqual([
      ['unresolved:1', 'cle : AB-123-CD', false],
      ['unresolved:2', 'cle : EF-456-GH', true],
      ['unresolved:4', 'cle : Libellé intégral', false],
    ]);
    expect(RELIABLE_UNRESOLVED_REASONS).toContain('VALUE_TRUNCATED');
  });
});

describe('Candidate Builder (lot 34E conservé) et priorité des sources (§9)', () => {
  it('unité CERTAINE : identifiant fort → STRONG_IDENTIFIER, rapprochement déterministe', () => {
    const b = construire([{ origin: 'SOURCE_UNITS', zone: 'BODY', text: 'Lieu d’intervention : 12 rue Victor Hugo 69003 Lyon', unitIds: ['page:1:field:1'] }]);
    expect(b.candidates.find((c) => c.assetId === 2)?.sources).toContain('STRONG_IDENTIFIER');
    expect(b.deterministicMatches).toEqual(['2:ADDRESS']);
  });

  it('unité INCERTAINE : jamais seule la base d’un rattachement (CONTEXTUAL_MATCH, aucune correspondance déterministe)', () => {
    const b = construire([{ origin: 'SOURCE_UNITS', zone: 'BODY', text: 'Lieu : 12 rue Victor Hugo 69003 Lyon — Maison de Bourg', unitIds: ['u'], uncertain: true }]);
    expect(b.deterministicMatches).toEqual([]);
    expect(b.candidates.map((c) => [c.assetId, c.sources])).toEqual([[2, ['CONTEXTUAL_MATCH']], [3, ['CONTEXTUAL_MATCH']]]);
    expect(CANDIDATE_BUILDER_VERSION).toBe(1);
  });

  it('AC8 — information au-delà de 200 000 caractères de transcription, persistée en unité : rapprochable', () => {
    const b = construire([
      { origin: 'TRANSCRIPTION', zone: 'BODY', text: 'x '.repeat(100_000) },
      { origin: 'SOURCE_UNITS', zone: 'BODY', text: 'Adresse : 12 rue Victor Hugo 69003 Lyon', unitIds: ['page:900:field:1'] },
    ]);
    expect(b.deterministicMatches).toEqual(['2:ADDRESS']);
  });
});

describe('empreinte du contexte et digest documentaire (§5, §6, AC5, AC6)', () => {
  const base = { documentDigest: 'd', candidates: [], candidateIdentifiers: {}, matches: [] };

  it('sans unité considérée : empreinte INCHANGÉE (documents existants, aucune réévaluation de masse)', () => {
    expect(documentAssetContextFingerprint({ ...base, sourceUnits: [] })).toBe(documentAssetContextFingerprint(base));
  });

  it('unité qui désigne un candidat : empreinte différente (décision réévaluable) ; stable (ordre indifférent)', () => {
    const a = documentAssetContextFingerprint({ ...base, sourceUnits: [{ unitId: 'u1', uncertain: false, assetIds: [2] }, { unitId: 'u2', uncertain: true, assetIds: [3, 1] }] });
    const b = documentAssetContextFingerprint({ ...base, sourceUnits: [{ unitId: 'u2', uncertain: true, assetIds: [1, 3] }, { unitId: 'u1', uncertain: false, assetIds: [2] }] });
    expect(a).toBe(b);
    expect(a).not.toBe(documentAssetContextFingerprint(base));
  });

  it('unités considérées = celles qui désignent un candidat retenu (une unité sans rapport ne compte pas)', () => {
    const s = { texts: [
      { origin: 'SOURCE_UNITS', zone: 'BODY', text: 'Adresse : 12 rue Victor Hugo 69003 Lyon', unitIds: ['page:1:field:1'] },
      { origin: 'SOURCE_UNITS', zone: 'BODY', text: 'Conditions générales de vente', unitIds: ['page:2:block:1'] },
      { origin: 'TRANSCRIPTION', zone: 'BODY', text: 'Maison Victor Hugo' },
    ] as DocumentSourceText[] };
    expect(matchSourceUnits(s, index, [2])).toEqual([{ unitId: 'page:1:field:1', origin: 'SOURCE_UNITS', uncertain: false, assetIds: [2] }]);
    expect(matchSourceUnits(s, index, [])).toEqual([]);
  });

  it('digest documentaire : la couche exhaustive n’y entre pas en bloc ; sources réellement utilisées tracées', () => {
    const t: DocumentSourceText[] = [{ origin: 'TRANSCRIPTION', zone: 'BODY', text: 'Texte' }];
    const avec = [...t, { origin: 'SOURCE_UNITS', zone: 'BODY', text: 'Unité' } as DocumentSourceText];
    expect(documentKnowledgeDigest({ extraction: null, texts: avec, facts: [] })).toBe(documentKnowledgeDigest({ extraction: null, texts: t, facts: [] }));
    expect(usedDocumentSources({ texts: [...avec, { origin: 'UNRESOLVED_FACTS', zone: 'BODY', text: 'x' }, { origin: 'EXTRACTION', zone: 'TITLE', text: 'T' }], facts: [{} as never] }))
      .toEqual(['EXTRACTION', 'TRANSCRIPTION', 'FACTS', 'SOURCE_UNITS', 'UNRESOLVED_FACTS']);
  });
});

describe('recherche ciblée après une évolution de connaissance (§7)', () => {
  it('termes discriminants : adresse, identifiant (forme lue et compacte), nom distinctif ; rien de générique', () => {
    expect(addressTerms('12 rue Victor Hugo')).toEqual({ terms: ['12', 'victor', 'hugo'], kind: 'ADDRESS' });
    expect(addressTerms('rue')).toBeNull();
    expect(identifierTerms('AB-123-CD')).toEqual([{ terms: ['ab-123-cd'], kind: 'IDENTIFIER' }, { terms: ['ab123cd'], kind: 'IDENTIFIER' }]);
    expect(identifierTerms('ABC')).toEqual([]);
    expect(nameTerms('Maison Victor Hugo')).toEqual({ terms: ['maison', 'victor', 'hugo'], kind: 'NAME' });
    expect(nameTerms('Maison')).toBeNull();
  });
});
