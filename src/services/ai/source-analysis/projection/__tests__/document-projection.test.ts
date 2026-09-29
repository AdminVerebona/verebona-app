/**
 * Projection déterministe T1 — CDC 15 T1-01 à T1-06, U5 à U16, §13, P-T1-02
 * à P-T1-05, sur le corpus synthétique (D-08) et des cas ciblés.
 * Fonction PURE : aucun mock, aucune base.
 */
import { describe, it, expect } from 'vitest';
import { T1AnalyzeDocumentOutput, type T1Fact } from '../../master/t1-contract';
import { checkFactEvidence } from '../../master/fact-evidence';
import { projectDocumentFacts, type ProjectionContext } from '../document-projection';
import { PROJECTION_RULES, classifyPurpose, countArticleLines } from '../rules';
import { agendaCandidatesFromFacts } from '../../master/to-source-analysis-result';
import { loadT1Fixture, type T1Fixture } from '../../__fixtures__/t1/load';
import { toMirrorValue, toAssetFamily, resolveDocumentType, type AssetFamily } from '@/services/canonical/registry';

/** Reproduit, sans base, ce que fait l'étape avant la projection. */
function prepare(f: T1Fixture) {
  const parsed = T1AnalyzeDocumentOutput.parse(f.recording.output);
  const facts = parsed.facts.map(checkFactEvidence).filter((c) => c.ok).map((c) => (c as { fact: T1Fact }).fact);
  const v = f.context.verified ?? {};
  const verifiedIds = {
    ASSET: new Set(v.ASSET ?? []), EQUIPMENT: new Set(v.EQUIPMENT ?? []),
    ROOM: new Set(v.ROOM ?? []), SUPPLIER: new Set(v.SUPPLIER ?? []),
  };
  const known = f.context.linkedAssetId ?? null;
  const verifiedCertain = parsed.entities.assets.filter((c) => c.entityId !== null && verifiedIds.ASSET.has(c.entityId) && c.confidence === 'certain');
  const ctx: ProjectionContext = {
    knownAssetId: known,
    documentAssetId: known ?? (verifiedCertain.length === 1 ? verifiedCertain[0].entityId : null),
    assetFamilies: new Map<number, AssetFamily | undefined>((f.context.assets ?? []).map((a) => [a.id, toAssetFamily(a.category)])),
    verifiedIds,
  };
  return { analysis: { ...parsed, facts }, ctx };
}

function run(file: string) {
  const { analysis, ctx } = prepare(loadT1Fixture(file));
  const projection = projectDocumentFacts(analysis, ctx);
  const byKey = (k: string) => projection.facts.filter((x) => x.canonicalKey === k);
  const agenda = agendaCandidatesFromFacts(projection.facts, {
    documentAssetId: ctx.documentAssetId, multiAsset: projection.multiAsset,
  });
  return { projection, byKey, agenda, ctx };
}

describe('P-T1-02 — ticket d’achat de la draisienne', () => {
  it('documentDate → acquisitionDate, amountCents → acquisitionPrice en EUROS, purchase HISTORICAL, preuve', () => {
    const { projection, byKey } = run('p-t1-02-ticket-draisienne.json');
    expect(projection.purpose).toBe('ASSET_PURCHASE');
    const [date] = byKey('acquisitionDate');
    const [prix] = byKey('acquisitionPrice');
    expect(date).toMatchObject({
      value: '2026-04-24', origin: 'DETERMINISTIC_RULE', ruleCode: PROJECTION_RULES.PURCHASE_RECEIPT_ACQUISITION_DATE,
      semanticEvent: { type: 'purchase', nature: 'HISTORICAL' },
      target: { targetType: 'ASSET', targetEntityId: 184, targetConfidence: 'certain' },
      provenance: 'TEXT_EXTRACTION', evidence: { excerpt: '24/04/2026 15:42' },
    });
    expect(prix).toMatchObject({
      value: 129, canonicalUnit: 'EUR', valueType: 'money_eur', rawValue: 12900,
      ruleCode: PROJECTION_RULES.PURCHASE_RECEIPT_ACQUISITION_PRICE,
      semanticEvent: { type: 'purchase', nature: 'HISTORICAL' }, evidence: { excerpt: 'TOTAL TTC 129,00 €' },
    });
    expect(projection.appliedRules).toEqual(expect.arrayContaining([
      PROJECTION_RULES.PURCHASE_RECEIPT_ACQUISITION_DATE, PROJECTION_RULES.PURCHASE_RECEIPT_ACQUISITION_PRICE,
    ]));
  });

  it('aucun doublon quand le modèle a déjà rendu les faits d’acquisition', () => {
    const f = loadT1Fixture('p-t1-02-ticket-draisienne.json');
    (f.recording.output.facts as unknown[]).push({
      canonicalKey: 'acquisitionDate', rawValue: '24/04/2026', normalizedValue: '2026-04-24', valueType: 'date',
      target: { type: 'ASSET', entityId: 184, confidence: 'certain' }, provenance: 'TEXT_EXTRACTION',
      confidence: 'certain', evidence: { excerpt: '24/04/2026' }, semanticEvent: { type: 'purchase', nature: 'HISTORICAL' },
    });
    const { analysis, ctx } = prepare(f);
    const p = projectDocumentFacts(analysis, ctx);
    const dates = p.facts.filter((x) => x.canonicalKey === 'acquisitionDate');
    expect(dates).toHaveLength(1);
    expect(dates[0].origin).toBe('MODEL_CANONICAL');
  });

  it('sans preuve de la date du document, aucune acquisitionDate déduite', () => {
    const f = loadT1Fixture('p-t1-02-ticket-draisienne.json');
    const doc = f.recording.output.document as Record<string, { evidence: Record<string, unknown> }>;
    doc.documentDate.evidence = {};
    const { analysis, ctx } = prepare(f);
    expect(projectDocumentFacts(analysis, ctx).facts.some((x) => x.canonicalKey === 'acquisitionDate')).toBe(false);
  });

  it('bien non vérifié (aucun bien connu, candidat incertain) : aucune règle d’acquisition', () => {
    const f = loadT1Fixture('p-t1-02-ticket-draisienne.json');
    f.context.linkedAssetId = null;
    const out = f.recording.output as { entities: { assets: Array<{ confidence: string }> } };
    out.entities.assets[0].confidence = 'probable';
    const { analysis, ctx } = prepare(f);
    const p = projectDocumentFacts(analysis, ctx);
    expect(p.facts.some((x) => x.origin === 'DETERMINISTIC_RULE')).toBe(false);
  });
});

describe('T1-02 — trois effets différents : achat du bien, réparation, achat de pièce', () => {
  it('P-T1-03 facture de réparation : événement repair, kilométrage, JAMAIS acquisitionPrice', () => {
    const { projection, byKey } = run('p-t1-03-facture-reparation.json');
    expect(projection.purpose).toBe('SERVICE');
    expect(byKey('acquisitionPrice')).toHaveLength(0);
    // U14 : la date d'achat proposée par le modèle est retirée elle aussi.
    expect(byKey('acquisitionDate')).toHaveLength(0);
    // … ainsi que tout événement d'achat porté par un fait du bien.
    expect(projection.facts.some((x) => x.semanticEvent?.type === 'purchase')).toBe(false);
    expect(projection.appliedRules).toContain(PROJECTION_RULES.SERVICE_INVOICE_NO_PURCHASE_EVENT);
    expect(projection.facts.some((x) => x.semanticEvent?.type === 'repair' && x.semanticEvent.nature === 'HISTORICAL')).toBe(true);
    expect(byKey('mileage')[0]).toMatchObject({ value: 78000, canonicalUnit: 'km', target: { targetEntityId: 12 } });
    expect(projection.warnings).toContainEqual(expect.objectContaining({
      code: 'FACT_REMOVED_BY_RULE', ruleCode: PROJECTION_RULES.SERVICE_INVOICE_NO_ACQUISITION,
    }));
  });

  it('achat de pièce : achat de la pièce conservé, aucune acquisition du véhicule', () => {
    const { projection, byKey } = run('t1-02-achat-piece.json');
    expect(projection.purpose).toBe('PART_PURCHASE');
    expect(byKey('acquisitionPrice')).toHaveLength(0);
    expect(byKey('acquisitionDate')).toHaveLength(0);
    const piece = projection.facts.find((x) => x.subject === 'Pneus');
    expect(piece).toMatchObject({ canonicalKey: null, semanticEvent: { type: 'purchase' }, target: { targetType: 'GENERIC' } });
    expect(projection.appliedRules).toContain(PROJECTION_RULES.PART_PURCHASE_NO_ASSET_ACQUISITION);
  });

  it('les trois finalités sont distinctes', () => {
    const effets = ['p-t1-02-ticket-draisienne.json', 'p-t1-03-facture-reparation.json', 't1-02-achat-piece.json']
      .map((f) => run(f).projection.purpose);
    expect(new Set(effets).size).toBe(3);
  });

  it('classifyPurpose : un bon de commande ne prouve pas un achat', () => {
    expect(classifyPurpose({
      entry: resolveDocumentType('BON_COMMANDE'), documentTypeCode: 'ACQUISITION_ORDER', purchaseTargets: ['ASSET'], serviceEvents: 0,
    })).toBe('OTHER');
  });
});

describe('P-T1-04 — document multi-biens', () => {
  it('chaque fait reste sur sa cible, rien de la Tesla sur la Clio (bien connu), ambigu sans cible', () => {
    const { projection, byKey, ctx } = run('p-t1-04-facture-deux-vehicules.json');
    expect(ctx.knownAssetId).toBe(12);
    expect(projection.multiAsset).toBe(true);
    const km = byKey('mileage').map((x) => [x.value, x.target.targetEntityId]);
    expect(km).toEqual([[78000, 12], [42000, 13]]);
    expect(byKey('lastRevision').map((x) => x.target.targetEntityId)).toEqual([12, 13]);
    // Aucun fait porté par la Tesla n'est projeté sur la Clio.
    expect(projection.facts.filter((x) => x.target.targetEntityId === 12 && x.evidence.excerpt?.includes('Tesla'))).toEqual([]);
    // Ambigu : conservé, jamais attribué au bien connu (U8).
    expect(byKey('registrationNumber')[0].target).toMatchObject({ targetType: 'ASSET', targetEntityId: null, targetEntityLabel: 'véhicule de prêt' });
    // Cellules de tableau conservées.
    expect(byKey('mileage')[0].evidence.table).toEqual({ index: 0, row: 0, column: 1 });
  });

  it('seule l’échéance du bien du document devient candidat agenda', () => {
    const { agenda } = run('p-t1-04-facture-deux-vehicules.json');
    expect(agenda.map((a) => [a.date, a.originFieldKey])).toEqual([['2027-11-15', 'maintenanceDueDate']]);
  });

  it('justificatif d’achat multi-biens : aucune règle d’acquisition', () => {
    const f = loadT1Fixture('p-t1-02-ticket-draisienne.json');
    (f.recording.output.entities as { multiAsset: boolean }).multiAsset = true;
    const { analysis, ctx } = prepare(f);
    const p = projectDocumentFacts(analysis, ctx);
    expect(p.facts.some((x) => x.origin === 'DETERMINISTIC_RULE')).toBe(false);
    expect(p.appliedRules).toContain(PROJECTION_RULES.MULTI_ASSET_NO_ACQUISITION_RULE);
  });

  it('multi-biens constaté sur les cibles même si le modèle ne le déclare pas', () => {
    const f = loadT1Fixture('p-t1-04-facture-deux-vehicules.json');
    (f.recording.output.entities as { multiAsset: boolean }).multiAsset = false;
    const { analysis, ctx } = prepare(f);
    const p = projectDocumentFacts(analysis, ctx);
    expect(p.multiAsset).toBe(true);
    expect(p.facts.find((x) => x.canonicalKey === 'registrationNumber')?.target.targetEntityId).toBeNull();
  });
});

describe('P-T1-05 — DPE réalisé', () => {
  it('dpeDate HISTORICAL, aucune expiration, aucune échéance', () => {
    const { projection, byKey, agenda } = run('p-t1-05-dpe-realise.json');
    expect(byKey('dpeDate')).toHaveLength(1);
    expect(byKey('dpeDate')[0]).toMatchObject({ value: '2026-03-12', semanticEvent: { type: 'dpe', nature: 'HISTORICAL' } });
    expect(byKey('dpeExpiryDate')).toHaveLength(0);
    expect(byKey('dpeClass')[0].value).toBe('D');
    expect(agenda).toEqual([]);
    expect(projection.appliedRules).toContain(PROJECTION_RULES.DPE_DATE_NOT_EXPIRY);
  });

  it('une expiration EXPLICITE reste une expiration', () => {
    const f = loadT1Fixture('p-t1-05-dpe-realise.json');
    const facts = f.recording.output.facts as Array<Record<string, unknown>>;
    facts[1] = { ...facts[1], normalizedValue: '2036-03-11', rawValue: '11/03/2036', evidence: { excerpt: 'Valable jusqu’au 11/03/2036' } };
    const { analysis, ctx } = prepare(f);
    const p = projectDocumentFacts(analysis, ctx);
    expect(p.facts.find((x) => x.canonicalKey === 'dpeExpiryDate')).toMatchObject({ value: '2036-03-11', semanticEvent: { nature: 'DEADLINE' } });
  });
});

describe('T1-06 / U12 / U15 — « Dernier entretien » seul', () => {
  it('requalifié en lastRevision, aucune date future, récurrence non écrite retirée', () => {
    const { projection, byKey, agenda } = run('t1-06-dernier-entretien-seul.json');
    expect(byKey('maintenanceDueDate')).toHaveLength(0);
    expect(byKey('lastRevision')[0]).toMatchObject({
      value: '2026-11-15', ruleCode: PROJECTION_RULES.LAST_EVENT_NOT_DEADLINE,
      semanticEvent: { type: 'maintenance', nature: 'HISTORICAL' }, recurrence: null,
    });
    expect(agenda).toEqual([]);
    expect(projection.warnings.map((w) => w.code)).toContain('RECURRENCE_WITHOUT_EXPLICIT_SOURCE');
  });

  it('une échéance explicite reste une échéance, avec sa récurrence écrite', () => {
    const f = loadT1Fixture('t1-06-dernier-entretien-seul.json');
    const facts = f.recording.output.facts as Array<Record<string, unknown>>;
    facts[0] = {
      ...facts[0], normalizedValue: '2027-11-15', rawValue: '15/11/2027',
      evidence: { excerpt: 'Prochain entretien avant le 15/11/2027 (entretien annuel)' },
      recurrence: { frequency: 'yearly', interval: 1, excerpt: 'entretien annuel' },
    };
    const { analysis, ctx } = prepare(f);
    const p = projectDocumentFacts(analysis, ctx);
    const due = p.facts.find((x) => x.canonicalKey === 'maintenanceDueDate');
    expect(due).toMatchObject({ value: '2027-11-15', semanticEvent: { nature: 'DEADLINE' }, recurrence: { frequency: 'yearly' } });
    const agenda = agendaCandidatesFromFacts(p.facts, { documentAssetId: 12, multiAsset: false });
    expect(agenda[0]).toMatchObject({ date: '2027-11-15', recurrence: { mode: 'EXPLICIT_SOURCE', frequency: 'yearly' } });
  });

  it('échéance identique au dernier entretien, sur la même cible : retirée', () => {
    const f = loadT1Fixture('t1-06-dernier-entretien-seul.json');
    const facts = f.recording.output.facts as Array<Record<string, unknown>>;
    facts[0] = { ...facts[0], evidence: { excerpt: 'Entretien : 15/11/2026' }, recurrence: null };
    facts.push({ ...facts[0], canonicalKey: 'lastRevision', evidence: { excerpt: 'Dernier entretien : 15/11/2026' } });
    const { analysis, ctx } = prepare(f);
    const p = projectDocumentFacts(analysis, ctx);
    expect(p.facts.map((x) => x.canonicalKey)).toEqual(['lastRevision']);
    expect(p.appliedRules).toContain(PROJECTION_RULES.DEADLINE_EQUALS_LAST_EVENT);
  });
});

describe('T1-03 — unités monétaires', () => {
  it('749 € : 749 EUR dans la fiche, 74 900 cents dans les champs en centimes', () => {
    const { byKey, projection } = run('t1-03-montant-749.json');
    const [prix] = byKey('acquisitionPrice');
    expect(prix).toMatchObject({ value: 749, canonicalUnit: 'EUR', origin: 'MODEL_CANONICAL' });
    // Pas de seconde valeur déduite du total (déjà fournie par le modèle).
    expect(byKey('acquisitionPrice')).toHaveLength(1);
    // Miroir historique en centimes : conversion centralisée du registre.
    expect(toMirrorValue('acquisitionPrice', prix.value)).toEqual({ purchase_price_cents: 74900 });
    expect(projection.warnings.map((w) => w.code)).not.toContain('UNIT_CONVERTED');
  });

  it('jamais ×100 implicite : 74 900 annoncé en EUR pour « 749,00 € » lu → rétrogradé en générique', () => {
    const f = loadT1Fixture('t1-03-montant-749.json');
    (f.recording.output.facts as Array<Record<string, unknown>>)[0].normalizedValue = 74900;
    const { analysis, ctx } = prepare(f);
    const p = projectDocumentFacts(analysis, ctx);
    expect(p.facts.find((x) => x.canonicalKey === 'acquisitionPrice' && x.origin === 'MODEL_CANONICAL')).toBeUndefined();
    expect(p.facts.find((x) => x.rawKey === 'acquisitionPrice')).toMatchObject({ canonicalKey: null, origin: 'GENERIC' });
    expect(p.warnings.map((w) => w.code)).toContain('UNIT_MISMATCH');
  });

  it('unité annoncée lisible et convertible (cents) : conversion explicite vers EUR', () => {
    const f = loadT1Fixture('t1-03-montant-749.json');
    Object.assign((f.recording.output.facts as Array<Record<string, unknown>>)[0], {
      normalizedValue: 74900, canonicalUnit: 'cents', valueType: 'money_cents',
    });
    const { analysis, ctx } = prepare(f);
    const p = projectDocumentFacts(analysis, ctx);
    expect(p.facts.find((x) => x.canonicalKey === 'acquisitionPrice')?.value).toBe(749);
    expect(p.warnings.map((w) => w.code)).toContain('UNIT_CONVERTED');
  });

  it('unité annoncée non convertible : générique + avertissement', () => {
    const f = loadT1Fixture('t1-03-montant-749.json');
    Object.assign((f.recording.output.facts as Array<Record<string, unknown>>)[0], { canonicalUnit: 'USD', rawValue: null });
    const { analysis, ctx } = prepare(f);
    const p = projectDocumentFacts(analysis, ctx);
    expect(p.facts.find((x) => x.canonicalKey === 'acquisitionPrice' && x.origin === 'MODEL_CANONICAL')).toBeUndefined();
    expect(p.warnings.map((w) => w.code)).toContain('VALUE_NOT_NORMALIZABLE');
  });
});

describe('T1-01 / U5 — clés canoniques', () => {
  it('alias → clé canonique ; clé inventée → générique ; jamais d’alias libre en clé canonique', () => {
    const { projection } = run('t1-01-alias-libre.json');
    const canon = projection.facts.filter((x) => x.canonicalKey !== null).map((x) => x.canonicalKey);
    expect(canon).toContain('acquisitionPrice');
    expect(canon).not.toContain('prixAchat');
    expect(canon).not.toContain('boilerPower');
    const puissance = projection.facts.find((x) => x.rawKey === 'puissance');
    expect(puissance).toMatchObject({ canonicalKey: null, origin: 'GENERIC', value: 24, canonicalUnit: 'kW' });
    expect(projection.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['ALIAS_RESOLVED', 'UNKNOWN_CANONICAL_KEY']));
  });

  it('identifiant halluciné neutralisé ; le fait n’est pas rabattu sur le bien connu', () => {
    const { projection } = run('t1-01-alias-libre.json');
    const serie = projection.facts.find((x) => x.canonicalKey === 'serialNumber');
    expect(serie?.target).toMatchObject({ targetType: 'ASSET', targetEntityId: null, targetEntityLabel: 'Autre draisienne' });
    expect(projection.warnings.map((w) => w.code)).toContain('TARGET_UNVERIFIED');
  });

  it('clé inapplicable à la famille de la cible → générique', () => {
    const f = loadT1Fixture('t1-03-montant-749.json');
    (f.recording.output.facts as unknown[]).push({
      canonicalKey: 'registrationNumber', normalizedValue: 'AB-123-CD', target: { type: 'ASSET', entityId: 184 },
      provenance: 'TEXT_EXTRACTION', confidence: 'certain', evidence: { excerpt: 'AB-123-CD' },
    });
    const { analysis, ctx } = prepare(f);
    const p = projectDocumentFacts(analysis, ctx);
    expect(p.facts.find((x) => x.rawKey === 'registrationNumber')).toMatchObject({ canonicalKey: null });
    expect(p.warnings.map((w) => w.code)).toContain('KEY_NOT_APPLICABLE_TO_FAMILY');
  });
});

describe('T1-04 / U7 — équipement jamais rabattu sur le bien parent', () => {
  it('garantie et n° de série : canoniques SUR la chaudière (champs déclarés EQUIPMENT), rien sur l’appartement', () => {
    const { projection, agenda } = run('t1-04-equipement-chaudiere.json');
    expect(projection.facts.every((x) => x.target.targetType === 'EQUIPMENT' && x.target.targetEntityId === 501)).toBe(true);
    expect(projection.facts.some((x) => x.target.targetType === 'ASSET')).toBe(false);
    expect(projection.facts.filter((x) => x.canonicalKey).map((x) => [x.canonicalKey, x.value])).toEqual([
      ['warrantyEndDate', '2028-12-31'], ['serialNumber', 'FR-2026-001'],
    ]);
    // Échéance d'équipement : jamais un candidat agenda du bien.
    expect(agenda).toEqual([]);
  });

  it('clé de bien sans cible équipement déclarée (ex. livingArea) : générique', () => {
    const f = loadT1Fixture('t1-04-equipement-chaudiere.json');
    (f.recording.output.facts as unknown[]).push({
      canonicalKey: 'livingArea', normalizedValue: 3, canonicalUnit: 'm2', target: { type: 'EQUIPMENT', entityId: 501 },
      provenance: 'TEXT_EXTRACTION', confidence: 'certain', evidence: { excerpt: 'Encombrement 3 m²' },
    });
    const { analysis, ctx } = prepare(f);
    const p = projectDocumentFacts(analysis, ctx);
    expect(p.facts.find((x) => x.rawKey === 'livingArea')).toMatchObject({ canonicalKey: null, target: { targetType: 'EQUIPMENT' } });
    expect(p.warnings.map((w) => w.code)).toContain('CANONICAL_KEY_TARGET_MISMATCH');
  });

  it('pièce : roomArea canonique sur la pièce ; jamais surface habitable du bien', () => {
    const f = loadT1Fixture('t1-04-equipement-chaudiere.json');
    const piece = (key: string, type: string, id: number) => ({
      canonicalKey: key, rawValue: '12 m²', normalizedValue: 12, canonicalUnit: 'm2', target: { type, entityId: id },
      provenance: 'TEXT_EXTRACTION', confidence: 'certain', evidence: { excerpt: 'Cuisine : 12 m²' },
    });
    f.recording.output.facts = [piece('roomArea', 'ROOM', 301), piece('livingArea', 'ROOM', 301), piece('roomArea', 'ASSET', 30)];
    const { analysis, ctx } = prepare(f);
    const p = projectDocumentFacts(analysis, ctx);
    expect(p.facts.map((x) => [x.canonicalKey, x.target.targetType, x.target.targetEntityId])).toEqual([
      ['roomArea', 'ROOM', 301], [null, 'ROOM', 301], [null, 'ASSET', 30],
    ]);
  });

  it('observation visuelle : jamais de citation fabriquée (T1-08)', () => {
    const { projection } = run('t1-04-equipement-chaudiere.json');
    const visuel = projection.facts.find((x) => x.provenance === 'VISUAL_ANALYSIS');
    expect(visuel?.evidence.excerpt).toBeUndefined();
    expect(visuel?.visualEvidence?.description).toBe('Appareil fixé au mur');
  });
});

describe('U13 — événements', () => {
  it('l’événement d’une clé du registre est celui du registre ; type inconnu ignoré', () => {
    const f = loadT1Fixture('t1-03-montant-749.json');
    (f.recording.output.facts as unknown[]).push(
      {
        canonicalKey: 'lastRevision', normalizedValue: '2026-01-10', target: { type: 'ASSET', entityId: 184 },
        provenance: 'TEXT_EXTRACTION', confidence: 'certain', evidence: { excerpt: 'Révisée le 10/01/2026' },
        semanticEvent: { type: 'maintenance', nature: 'DEADLINE' },
      },
      {
        canonicalKey: null, rawKey: 'note', normalizedValue: 'x', target: { type: 'DOCUMENT' },
        provenance: 'TEXT_EXTRACTION', confidence: 'certain', evidence: { excerpt: 'x' },
        semanticEvent: { type: 'teleportation', nature: 'HISTORICAL' },
      },
    );
    const { analysis, ctx } = prepare(f);
    const p = projectDocumentFacts(analysis, ctx);
    expect(p.facts.find((x) => x.canonicalKey === 'lastRevision')?.semanticEvent).toEqual({ type: 'maintenance', nature: 'HISTORICAL' });
    expect(p.facts.find((x) => x.rawKey === 'note')?.semanticEvent).toBeNull();
    expect(p.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['SEMANTIC_EVENT_ALIGNED', 'SEMANTIC_EVENT_UNKNOWN']));
  });
});

describe('U14 — acquisition sans preuve d’achat, ticket à plusieurs articles', () => {
  it('FACTURE sans finalité établie : acquisition du modèle → connaissance générique, aucun événement purchase', () => {
    const { projection, byKey } = run('t1-02-facture-sans-finalite.json');
    expect(projection.purpose).toBe('OTHER');
    expect(byKey('acquisitionDate')).toHaveLength(0);
    expect(byKey('acquisitionPrice')).toHaveLength(0);
    const generiques = projection.facts.filter((x) => x.ruleCode === PROJECTION_RULES.ACQUISITION_WITHOUT_PURCHASE_PROOF);
    expect(generiques.map((x) => [x.canonicalKey, x.rawKey, x.origin, x.semanticEvent])).toEqual([
      [null, 'date', 'GENERIC', null], [null, 'total', 'GENERIC', null],
    ]);
    expect(projection.warnings.map((w) => w.code)).toContain('FACT_REQUALIFIED_BY_RULE');
  });

  it('un acte authentique qui énonce l’acquisition vaut preuve d’achat', () => {
    const f = loadT1Fixture('t1-02-facture-sans-finalite.json');
    (f.recording.output.document as { classification: Record<string, unknown> }).classification.canonicalType = 'ACTE_AUTHENTIQUE';
    const { analysis, ctx } = prepare(f);
    const p = projectDocumentFacts(analysis, ctx);
    expect(p.purpose).toBe('ASSET_PURCHASE');
    expect(p.facts.find((x) => x.canonicalKey === 'acquisitionDate')?.origin).toBe('MODEL_CANONICAL');
  });

  it('ticket à plusieurs articles : prix = ligne d’achat du bien, jamais le total', () => {
    const { projection, byKey } = run('t1-02-ticket-plusieurs-articles.json');
    expect(projection.purpose).toBe('ASSET_PURCHASE');
    expect(byKey('acquisitionPrice')).toHaveLength(1);
    expect(byKey('acquisitionPrice')[0]).toMatchObject({
      value: 99, ruleCode: PROJECTION_RULES.PURCHASE_LINE_ACQUISITION_PRICE, evidence: { excerpt: 'DRAISIENNE BOIS 99,00' },
    });
    expect(byKey('acquisitionDate')[0]?.value).toBe('2026-04-24');
  });

  it('ticket à plusieurs articles sans ligne chiffrée du bien : aucun prix d’acquisition', () => {
    const f = loadT1Fixture('t1-02-ticket-plusieurs-articles.json');
    const facts = f.recording.output.facts as Array<Record<string, unknown>>;
    Object.assign(facts[0], { valueType: 'string', normalizedValue: 'Draisienne bois', canonicalUnit: null, rawValue: 'DRAISIENNE BOIS' });
    const { analysis, ctx } = prepare(f);
    const p = projectDocumentFacts(analysis, ctx);
    expect(p.facts.some((x) => x.canonicalKey === 'acquisitionPrice')).toBe(false);
    expect(p.appliedRules).toContain(PROJECTION_RULES.ACQUISITION_PRICE_NOT_ATTRIBUTABLE);
  });
});

describe('Échéance non postérieure à ce que le document constate (T1-06, U16)', () => {
  it('« DPE du 12/03/2026 » annoncé en dpeExpiryDate, égal à la date du document : retiré', () => {
    const f = loadT1Fixture('p-t1-05-dpe-realise.json');
    const facts = f.recording.output.facts as Array<Record<string, unknown>>;
    facts.splice(0, 2, { ...facts[1], evidence: { excerpt: 'DPE du 12/03/2026' } });
    const { analysis, ctx } = prepare(f);
    const p = projectDocumentFacts(analysis, ctx);
    expect(p.facts.some((x) => x.canonicalKey === 'dpeExpiryDate')).toBe(false);
    expect(p.facts.find((x) => x.canonicalKey === 'dpeDate')?.value).toBe('2026-03-12');
    expect(p.appliedRules).toContain(PROJECTION_RULES.DPE_DATE_NOT_EXPIRY);
  });

  it('« DPE du … » en dpeExpiryDate retiré même si la date du document diffère', () => {
    const f = loadT1Fixture('p-t1-05-dpe-realise.json');
    (f.recording.output.document as Record<string, { value: string }>).documentDate.value = '2026-04-02';
    const facts = f.recording.output.facts as Array<Record<string, unknown>>;
    for (const exc of ['DPE du 12/03/2026', 'Diagnostic réalisé le 12/03/2026', 'Établi le 12/03/2026']) {
      facts[1] = { ...facts[1], evidence: { excerpt: exc } };
      const { analysis, ctx } = prepare(f);
      const p = projectDocumentFacts(analysis, ctx);
      expect(p.facts.some((x) => x.canonicalKey === 'dpeExpiryDate'), exc).toBe(false);
    }
  });

  it('avis d’échéance daté du jour de l’échéance : l’échéance reste', () => {
    const f = loadT1Fixture('t1-03-montant-749.json');
    (f.recording.output.document as Record<string, { value: string }>).documentDate.value = '2026-12-31';
    (f.recording.output.facts as unknown[]).push({
      canonicalKey: 'insuranceExpiry', rawValue: '31/12/2026', normalizedValue: '2026-12-31', target: { type: 'ASSET', entityId: 184 },
      provenance: 'TEXT_EXTRACTION', confidence: 'certain', evidence: { excerpt: 'Échéance : 31/12/2026' },
    });
    const { analysis, ctx } = prepare(f);
    const p = projectDocumentFacts(analysis, ctx);
    expect(p.facts.find((x) => x.canonicalKey === 'insuranceExpiry')?.value).toBe('2026-12-31');
  });

  it('« Dernier entretien : 15/11/2026 — prochain dans 1 an » en maintenanceDueDate 15/11/2026 : dernier entretien', () => {
    const f = loadT1Fixture('t1-06-dernier-entretien-seul.json');
    const facts = f.recording.output.facts as Array<Record<string, unknown>>;
    facts[0] = { ...facts[0], evidence: { excerpt: 'Dernier entretien : 15/11/2026 — prochain dans 1 an' }, recurrence: null };
    const { analysis, ctx } = prepare(f);
    const p = projectDocumentFacts(analysis, ctx);
    expect(p.facts.map((x) => [x.canonicalKey, x.value])).toEqual([['lastRevision', '2026-11-15']]);
    expect(agendaCandidatesFromFacts(p.facts, { documentAssetId: 12, multiAsset: false })).toEqual([]);
  });

  it('échéance antérieure à l’événement réalisé du même document : retirée', () => {
    const f = loadT1Fixture('t1-06-dernier-entretien-seul.json');
    const facts = f.recording.output.facts as Array<Record<string, unknown>>;
    facts[0] = { ...facts[0], normalizedValue: '2026-10-01', rawValue: '01/10/2026', evidence: { excerpt: 'Prochaine révision : 01/10/2026' }, recurrence: null };
    facts.push({ ...facts[0], canonicalKey: 'lastRevision', normalizedValue: '2026-11-15', rawValue: '15/11/2026', evidence: { excerpt: 'Révision effectuée le 15/11/2026' } });
    const { analysis, ctx } = prepare(f);
    const p = projectDocumentFacts(analysis, ctx);
    expect(p.facts.map((x) => x.canonicalKey)).toEqual(['lastRevision']);
  });

  it('une vraie échéance future reste', () => {
    const f = loadT1Fixture('t1-06-dernier-entretien-seul.json');
    const facts = f.recording.output.facts as Array<Record<string, unknown>>;
    facts[0] = { ...facts[0], normalizedValue: '2027-11-15', rawValue: '15/11/2027', evidence: { excerpt: 'Prochain entretien : 15/11/2027' }, recurrence: null };
    facts.push({ ...facts[0], canonicalKey: 'lastRevision', normalizedValue: '2026-11-15', rawValue: '15/11/2026', evidence: { excerpt: 'Dernier entretien : 15/11/2026' } });
    const { analysis, ctx } = prepare(f);
    const p = projectDocumentFacts(analysis, ctx);
    expect(p.facts.map((x) => x.canonicalKey).sort()).toEqual(['lastRevision', 'maintenanceDueDate']);
  });
});

describe('T1-02 — ticket dont le nombre de lignes n’est pas établi', () => {
  /** Ticket sans tableau ni fait d'achat par ligne. */
  const sansLignes = (transcription: string) => {
    const f = loadT1Fixture('p-t1-02-ticket-draisienne.json');
    f.recording.output.facts = [];
    f.recording.output.transcription = transcription;
    const { analysis, ctx } = prepare(f);
    return projectDocumentFacts(analysis, ctx);
  };

  it('P-T1-02 inchangé : un fait d’achat par ligne établit une seule ligne, prix certain', () => {
    const { byKey } = run('p-t1-02-ticket-draisienne.json');
    expect(byKey('acquisitionPrice')[0]).toMatchObject({ value: 129, confidence: 'certain' });
  });

  it('une ligne visible ou aucune : prix tiré du total gardé en probable, avertissement', () => {
    const p = sansLignes('TICKET\nDRAISIENNE BOIS 129,00\nTOTAL TTC 129,00 €\nCB 129,00');
    expect(p.facts.find((x) => x.canonicalKey === 'acquisitionPrice')).toMatchObject({ value: 129, confidence: 'probable' });
    expect(p.warnings).toContainEqual(expect.objectContaining({
      code: 'DERIVED_VALUE_UNCERTAIN', ruleCode: PROJECTION_RULES.ACQUISITION_PRICE_LINE_COUNT_UNKNOWN,
    }));
  });

  it('plusieurs lignes « libellé … montant » dans la transcription : aucun prix', () => {
    const p = sansLignes('TICKET\nDRAISIENNE BOIS 99,00\nCASQUE ENFANT 30,00 €\nTOTAL TTC 129,00 €');
    expect(p.facts.some((x) => x.canonicalKey === 'acquisitionPrice')).toBe(false);
    expect(p.appliedRules).toContain(PROJECTION_RULES.ACQUISITION_PRICE_NOT_ATTRIBUTABLE);
    // La date d'acquisition, elle, ne dépend pas du nombre d'articles.
    expect(p.facts.find((x) => x.canonicalKey === 'acquisitionDate')?.value).toBe('2026-04-24');
  });

  it('countArticleLines : lignes de synthèse et de paiement exclues', () => {
    expect(countArticleLines('PILES AA 1,00\nSous-total 2,00\nTVA 20% 0,33\nRendu 0,00\nPNEU 205 55,50 EUR')).toBe(2);
  });
});
