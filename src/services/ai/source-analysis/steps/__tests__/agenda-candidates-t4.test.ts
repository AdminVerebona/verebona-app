/**
 * Candidats agenda pilotés par le registre — CDC 15 T4-01, T4-03, T4-04,
 * T4-05 (DOD-05), T4-06, §13 ; corpus synthétique D-08.
 * Fonctions PURES : projection → champs → candidats, sans base ni modèle.
 */
import { describe, it, expect, vi } from 'vitest';
import { T1AnalyzeDocumentOutput, type T1Fact } from '../../master/t1-contract';
import { checkFactEvidence } from '../../master/fact-evidence';
import { projectDocumentFacts, type ProjectionContext } from '../../projection/document-projection';
import { projectedFactToExtractedField } from '../persist-evidence.step';
import { buildAgendaCandidatesT4, buildAgendaCandidates, selectAgendaCandidates, type T4CandidateContext } from '../build-agenda-candidates.step';
import { loadT1Fixture, type T1Fixture } from '../../__fixtures__/t1/load';
import { toAssetFamily, type AssetFamily } from '@/services/canonical/registry';
import { toFact, factsToExtractedFields } from '../../../knowledge/document-knowledge';
import { candidateFieldsForLinkedAsset } from '../../../knowledge/document-knowledge.service';
import type { ExtractedField } from '../../types';

/** Faits projetés d'une fixture → champs du contrat historique enrichi. */
function champs(f: T1Fixture, over: { knownAssetId?: number | null } = {}) {
  const parsed = T1AnalyzeDocumentOutput.parse(f.recording.output);
  const facts = parsed.facts.map(checkFactEvidence).filter((c) => c.ok).map((c) => (c as { fact: T1Fact }).fact);
  const v = f.context.verified ?? {};
  const known = over.knownAssetId !== undefined ? over.knownAssetId : f.context.linkedAssetId ?? null;
  const ctx: ProjectionContext = {
    knownAssetId: known, documentAssetId: known,
    assetFamilies: new Map<number, AssetFamily | undefined>((f.context.assets ?? []).map((a) => [a.id, toAssetFamily(a.category)])),
    verifiedIds: { ASSET: new Set(v.ASSET ?? []), EQUIPMENT: new Set(v.EQUIPMENT ?? []), ROOM: new Set(v.ROOM ?? []), SUPPLIER: new Set(v.SUPPLIER ?? []) },
  };
  const p = projectDocumentFacts({ ...parsed, facts }, ctx);
  return { fields: p.facts.map(projectedFactToExtractedField), parsed, multiAsset: p.multiAsset };
}

function ctxDe(f: T1Fixture, fileId = 500): T4CandidateContext {
  const out = f.recording.output as { document: Record<string, { value?: unknown; canonicalType?: string; documentTypeCode?: string }> };
  return {
    sourceFileId: fileId,
    documentAssetId: f.context.linkedAssetId ?? null,
    multiAsset: false,
    documentTitle: (out.document.title?.value as string | undefined) ?? null,
    documentDate: (out.document.documentDate?.value as string | undefined) ?? null,
    documentType: out.document.classification?.canonicalType ?? null,
    documentTypeCode: out.document.classification?.documentTypeCode ?? null,
  };
}

describe('T4-01 — candidats depuis le registre (HISTORICAL et DEADLINE)', () => {
  it('ticket draisienne → un « Achat » HISTORICAL, transportant type documentaire, autorité et clé fonctionnelle', () => {
    const f = loadT1Fixture('p-t1-02-ticket-draisienne.json');
    const c = buildAgendaCandidatesT4(champs(f).fields, ctxDe(f));
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({
      title: 'Achat — Ticket Draisienne', date: '2026-04-24', nature: 'HISTORICAL', businessType: 'purchase',
      originFieldKey: 'acquisitionDate', occurrence: 'single', target: { type: 'ASSET', id: 184 }, sourceFileId: 500,
      dateSource: 'FIELD', documentType: 'FACTURE', authority: 'SUPPORTING', mayCreateAgenda: true,
    });
    // L'ancienne liste fermée n'en produisait aucun (constat T4-01).
    expect(buildAgendaCandidates(champs(f).fields)).toEqual([]);
  });

  it('« Dernier entretien » seul → historique « Entretien réalisé », aucune échéance', () => {
    const f = loadT1Fixture('t1-06-dernier-entretien-seul.json');
    const c = buildAgendaCandidatesT4(champs(f).fields, ctxDe(f));
    expect(c.map((x) => [x.title.split(' — ')[0], x.nature, x.date])).toEqual([['Entretien réalisé', 'HISTORICAL', '2026-11-15']]);
    expect(c.some((x) => x.nature === 'DEADLINE')).toBe(false);
  });

  it('facture de réparation → « Réparation » historique datée du document ; aucune acquisition', () => {
    const f = loadT1Fixture('p-t1-03-facture-reparation.json');
    const c = buildAgendaCandidatesT4(champs(f).fields, ctxDe(f));
    expect(c.map((x) => [x.businessType, x.nature, x.date, x.dateSource, x.occurrence])).toEqual([
      ['repair', 'HISTORICAL', '2026-06-02', 'DOCUMENT_DATE', '2026-06-02'],
    ]);
  });

  it('multi-biens : seuls les faits du bien du document (la Clio), jamais ceux de la Tesla', () => {
    const f = loadT1Fixture('p-t1-04-facture-deux-vehicules.json');
    const c = buildAgendaCandidatesT4(champs(f).fields, { ...ctxDe(f), multiAsset: true });
    expect(c.map((x) => [x.originFieldKey, x.nature, x.date])).toEqual([
      ['lastRevision', 'HISTORICAL', '2026-09-03'], ['maintenanceDueDate', 'DEADLINE', '2027-11-15'],
    ]);
    expect(c[1].title).toBe('Prochain entretien — Clio');
  });
});

describe('Corpus §15 E2E-17 — échéance d’un équipement', () => {
  it('facture chaudière : candidat CIBLÉ sur l’équipement, jamais rabattu sur le bien parent ; rien en multi-biens', () => {
    const f = loadT1Fixture('t1-04-equipement-chaudiere.json');
    const { fields } = champs(f);
    const eq = fields.filter((x) => x.target?.targetType === 'EQUIPMENT' && x.target.targetEntityId != null);
    expect(eq.length).toBeGreaterThan(0);
    const c = buildAgendaCandidatesT4(fields, ctxDe(f));
    const surEquipement = c.filter((x) => x.target?.type === 'EQUIPMENT');
    expect(surEquipement.length).toBeGreaterThan(0);
    expect(surEquipement.every((x) => x.target?.id === eq[0].target?.targetEntityId)).toBe(true);
    // Aucun candidat du bien parent ne reprend un champ de l'équipement.
    const clesEquipement = new Set(eq.map((x) => x.canonicalKey ?? x.fieldKey));
    expect(c.filter((x) => x.target?.type === 'ASSET' && clesEquipement.has(x.originFieldKey ?? ''))).toEqual([]);
    expect(buildAgendaCandidatesT4(fields, { ...ctxDe(f), multiAsset: true }).filter((x) => x.target?.type === 'EQUIPMENT')).toEqual([]);
    expect(buildAgendaCandidatesT4(fields, { ...ctxDe(f), documentAssetId: null }).filter((x) => x.target?.type === 'EQUIPMENT')).toEqual([]);
  });
});

describe('T4-03 — DPE', () => {
  it('DPE réalisé seul → « DPE réalisé » historique, aucun futur', () => {
    const f = loadT1Fixture('p-t1-05-dpe-realise.json');
    const c = buildAgendaCandidatesT4(champs(f).fields, ctxDe(f));
    expect(c.map((x) => [x.title.split(' — ')[0], x.nature, x.businessType])).toEqual([['DPE réalisé', 'HISTORICAL', 'dpe']]);
  });

  it('DPE + expiration explicite → une seule échéance', () => {
    const f = loadT1Fixture('p-t1-05-dpe-realise.json');
    const facts = f.recording.output.facts as Array<Record<string, unknown>>;
    facts[1] = { ...facts[1], normalizedValue: '2036-03-11', rawValue: '11/03/2036', evidence: { excerpt: 'Valable jusqu’au 11/03/2036' } };
    const c = buildAgendaCandidatesT4(champs(f).fields, ctxDe(f));
    expect(c.filter((x) => x.nature === 'DEADLINE').map((x) => [x.originFieldKey, x.date])).toEqual([['dpeExpiryDate', '2036-03-11']]);
  });
});

describe('chemin étapes (clés historiques) et T4-06', () => {
  const champ = (over: Partial<ExtractedField>): ExtractedField =>
    ({ fieldKey: 'x', value: '2026-01-01', confidence: 'certain', excerpt: 'e', ...over });
  const ctx: T4CandidateContext = { sourceFileId: 9, documentAssetId: 3, multiAsset: false, documentType: 'FACTURE' };

  it('alias historique résolu (purchaseDate → achat) ; clé libre sans effet ignorée', () => {
    const c = buildAgendaCandidatesT4([champ({ fieldKey: 'purchaseDate' }), champ({ fieldKey: 'boilerPower', value: '24' })], ctx);
    expect(c.map((x) => [x.originFieldKey, x.businessType])).toEqual([['acquisitionDate', 'purchase']]);
  });

  it('observation visuelle ou sans extrait : aucune date lue, aucun candidat', () => {
    expect(buildAgendaCandidatesT4([champ({ fieldKey: 'nextInspection', provenance: 'VISUAL_ANALYSIS' })], ctx)).toEqual([]);
    expect(buildAgendaCandidatesT4([champ({ fieldKey: 'nextInspection', excerpt: undefined })], ctx)).toEqual([]);
  });

  it('T4-06 : la récurrence d’un fait du chemin étapes survit à la persistance et atteint le candidat', () => {
    const f = champ({
      fieldKey: 'maintenanceDueDate', value: '2027-01-10', excerpt: 'Entretien annuel, prochain le 10/01/2027',
      recurrence: { frequency: 'yearly', interval: 1, excerpt: 'Entretien annuel' },
    });
    const restitue = factsToExtractedFields([{ ...toFact(f), location: {} }]);
    expect(restitue[0].recurrence).toEqual(f.recurrence);
    const [c] = buildAgendaCandidatesT4(restitue, ctx);
    expect(c).toMatchObject({ nature: 'DEADLINE', recurrence: { mode: 'EXPLICIT_SOURCE', frequency: 'yearly', interval: 1 } });
  });
});

describe('T4-05 / DOD-05 — rattachement tardif : même état final', () => {
  it('candidats identiques, document rattaché dès l’analyse ou après', () => {
    const f = loadT1Fixture('p-t1-02-ticket-draisienne.json');
    const avant = buildAgendaCandidatesT4(champs(f).fields, ctxDe(f, 777));

    // Même ticket déposé SANS bien : le modèle ne cite aucun bien.
    const seul = structuredClone(f);
    seul.context.linkedAssetId = null;
    const out = seul.recording.output as { entities: { assets: unknown[] }; facts: Array<{ target: { entityId: number | null } }> };
    out.entities.assets = [];
    for (const x of out.facts) x.target.entityId = null;
    const sansBien = champs(seul).fields;
    // Faits d'acquisition posés sans identifiant (non rattachés à l'analyse).
    expect(sansBien.find((x) => x.canonicalKey === 'acquisitionDate')?.target).toMatchObject({ targetType: 'ASSET', targetEntityId: null });
    expect(buildAgendaCandidatesT4(sansBien, { ...ctxDe(seul, 777), documentAssetId: null })).toHaveLength(1);

    // Persistés, relus, puis rattachés au bien 184.
    const relus = factsToExtractedFields(sansBien.map((x) => ({ ...toFact(x), location: {} })));
    const apres = buildAgendaCandidatesT4(candidateFieldsForLinkedAsset(relus, 184, { allowReassign: true }), ctxDe(f, 777));
    expect(apres).toEqual(avant);
  });
});

describe('AI_T4_EFFECTS', () => {
  const legacy = [{ title: 'L', date: '2026-01-01', confidence: 'certain' as const, excerpt: 'e' }];
  const f = loadT1Fixture('p-t1-02-ticket-draisienne.json');

  it('legacy : candidats historiques, strictement', () => {
    expect(selectAgendaCandidates(legacy, champs(f).fields, ctxDe(f), 'legacy')).toBe(legacy);
  });
  it('shadow : calcul journalisé, candidats historiques retenus', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    expect(selectAgendaCandidates(legacy, champs(f).fields, ctxDe(f), 'shadow')).toBe(legacy);
    expect(info).toHaveBeenCalledWith('[t4-shadow] candidats agenda', expect.stringContaining('purchase:HISTORICAL'));
  });
  it('enabled : candidats du registre', () => {
    expect(selectAgendaCandidates(legacy, champs(f).fields, ctxDe(f), 'enabled')[0].nature).toBe('HISTORICAL');
  });
});
