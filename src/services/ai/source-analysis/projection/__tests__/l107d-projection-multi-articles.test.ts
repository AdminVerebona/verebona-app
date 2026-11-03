/**
 * Lot 107D — projection T1 d'un ticket à plusieurs articles (fonction pure).
 * Chiffres synthétiques (ticket §6) ; aucune règle sur un montant ou un objet.
 */
import { describe, expect, it } from 'vitest';
import { T1AnalyzeDocumentOutput, type T1Fact } from '../../master/t1-contract';
import { checkFactEvidence } from '../../master/fact-evidence';
import { projectDocumentFacts, type ProjectionContext } from '../document-projection';
import { PROJECTION_RULES } from '../rules';
import { loadT1Fixture } from '../../__fixtures__/t1/load';
import { toAssetFamily, type AssetFamily } from '@/services/canonical/registry';

const TICKET = 'MAGASIN DEMO\n24/04/2026 15:42\nDRAISIENNE BOIS 12P 69,99\nCASQUE ENFANT 34,95\nSONNETTE 22,99\nTOTAL TTC 127,93 €\nCB 127,93';

function projeter(o: { transcription?: string | null; amountCents?: number; facts?: Array<Record<string, unknown>>; descriptors?: boolean }) {
  const f = loadT1Fixture('p-t1-02-ticket-draisienne.json');
  const out = f.recording.output as Record<string, any>;
  if (o.transcription === null) delete out.transcription; else if (o.transcription !== undefined) out.transcription = o.transcription;
  if (o.amountCents !== undefined) out.document.amountCents = { value: o.amountCents, confidence: 'certain', evidence: { excerpt: `TOTAL TTC ${(o.amountCents / 100).toFixed(2).replace('.', ',')} €`, page: 1 } };
  if (o.facts) out.facts = [...out.facts, ...o.facts];
  const parsed = T1AnalyzeDocumentOutput.parse(out);
  const facts = parsed.facts.map(checkFactEvidence).filter((c) => c.ok).map((c) => (c as { fact: T1Fact }).fact);
  const ctx: ProjectionContext = {
    knownAssetId: 184, documentAssetId: 184,
    assetFamilies: new Map<number, AssetFamily | undefined>([[184, toAssetFamily('OBJECT')]]),
    verifiedIds: { ASSET: new Set([184]), EQUIPMENT: new Set(), ROOM: new Set(), SUPPLIER: new Set() },
    ...(o.descriptors ? { targetDescriptors: { assets: new Map([[184, { name: 'Draisienne' }]]) } } : {}),
  };
  return projectDocumentFacts({ ...parsed, facts }, ctx);
}

const prix = (p: ReturnType<typeof projeter>) => p.facts.filter((x) => x.canonicalKey === 'acquisitionPrice');

describe('L107D-U-PROJECTION — ticket à plusieurs articles', () => {
  it('L107D-U-PROJECTION-01 — désignation connue : prix = la ligne de l’objet (69,99), jamais le total (127,93) ; preuve = la ligne', () => {
    const p = projeter({ transcription: TICKET, amountCents: 12793, descriptors: true });
    expect(prix(p)).toHaveLength(1);
    expect(prix(p)[0]).toMatchObject({ value: 69.99, ruleCode: PROJECTION_RULES.PURCHASE_LINE_ATTRIBUTED, confidence: 'certain' });
    expect(prix(p)[0].evidence.excerpt).toContain('DRAISIENNE');
    expect(p.appliedRules).toContain(PROJECTION_RULES.PURCHASE_LINE_ATTRIBUTED);
  });

  it('L107D-U-PROJECTION-02 — sans désignation exploitable : abstention motivée (aucun prix, jamais le total)', () => {
    const p = projeter({ transcription: TICKET, amountCents: 12793 });
    expect(prix(p)).toEqual([]);
    expect(p.appliedRules).toContain(PROJECTION_RULES.ACQUISITION_PRICE_NOT_ATTRIBUTABLE);
  });

  it('L107D-U-PROJECTION-03 — fait acquisitionPrice du MODÈLE égal au total : requalifié en connaissance générique (ACQUISITION_PRICE_BASKET_TOTAL)', () => {
    const p = projeter({
      transcription: TICKET, amountCents: 12793,
      facts: [{ canonicalKey: 'acquisitionPrice', rawKey: 'prixAchat', label: 'Prix', rawValue: '127,93 €', normalizedValue: '127.93', valueType: 'money_eur',
        target: { type: 'ASSET', entityId: 184, rawLabel: 'Draisienne', confidence: 'certain', evidenceSignals: [] }, provenance: 'TEXT_EXTRACTION', confidence: 'certain',
        evidence: { excerpt: 'TOTAL TTC 127,93 €', page: 1 } }],
    });
    expect(prix(p)).toEqual([]);
    const g = p.facts.find((x) => x.ruleCode === PROJECTION_RULES.ACQUISITION_PRICE_BASKET_TOTAL);
    expect(g).toMatchObject({ canonicalKey: null, origin: 'GENERIC' });
  });

  it('L107D-U-PROJECTION-03b — même fait du modèle, désignation connue : total écarté PUIS ligne de l’objet attribuée', () => {
    const p = projeter({
      transcription: TICKET, amountCents: 12793, descriptors: true,
      facts: [{ canonicalKey: 'acquisitionPrice', rawKey: 'prixAchat', label: 'Prix', rawValue: '127,93 €', normalizedValue: '127.93', valueType: 'money_eur',
        target: { type: 'ASSET', entityId: 184, rawLabel: 'Draisienne', confidence: 'certain', evidenceSignals: [] }, provenance: 'TEXT_EXTRACTION', confidence: 'certain',
        evidence: { excerpt: 'TOTAL TTC 127,93 €', page: 1 } }],
    });
    expect(prix(p).map((x) => x.value)).toEqual([69.99]);
  });

  it('L107D-U-PROJECTION-04 — un fait d’achat (désignation) mais transcription absente : le total reste une PROPOSITION (probable), jamais certain', () => {
    const p = projeter({ transcription: null, amountCents: 12793 });
    expect(prix(p)[0]).toMatchObject({ value: 127.93, confidence: 'probable' });
  });

  it('L107D-U-PROJECTION-05 — non-régression P-T1-02 : ticket à UN article, prix certain = total', () => {
    const p = projeter({});
    expect(prix(p)[0]).toMatchObject({ value: 129, confidence: 'certain', ruleCode: PROJECTION_RULES.PURCHASE_RECEIPT_ACQUISITION_PRICE });
  });
});
