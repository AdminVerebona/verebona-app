/**
 * Lot 107D — guide du PO, étape 14 (T1 `t1-receipt-lines-v1`, FACULTATIVE) :
 * le bloc est collé dans le texte T1 LIVRÉ comme le ferait le PO, puis vérifié
 * contre le code réel (contrôles d'activation du BO, schéma des faits T1,
 * projection déterministe). Le code est sûr sans ce bloc (L107D-U-PROJECTION).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inspectMasterTemplate } from '@/services/ai/prompts/prompt-loader';
import { checkMasterPromptContent } from '@/services/ai/master-prompts/master-prompt-checks';
import { guideBlock } from '@/services/ai/prompt-conformity/guide-blocks';
import { T1AnalyzeDocumentOutput, t1Fact, type T1Fact } from '../../master/t1-contract';
import { checkFactEvidence } from '../../master/fact-evidence';
import { projectDocumentFacts } from '../document-projection';
import { PROJECTION_RULES } from '../rules';
import { loadT1Fixture } from '../../__fixtures__/t1/load';
import { toAssetFamily, type AssetFamily } from '@/services/canonical/registry';

const T1_LIVRE = readFileSync(join(process.cwd(), 'src', 'services', 'ai', 'prompts', 'source-analysis', 't1_master_v1.txt'), 'utf-8');
const occurrences = (t: string, m: string) => t.split(m).length - 1;

function premierJson(texte: string): { facts: unknown[] } {
  const debut = texte.split('\n').findIndex((l) => l.startsWith('{'));
  const reste = texte.split('\n').slice(debut).join('\n');
  let prof = 0; let chaine = false; let echap = false;
  for (let c = 0; c < reste.length; c++) {
    const ch = reste[c];
    if (chaine) { if (echap) echap = false; else if (ch === '\\') echap = true; else if (ch === '"') chaine = false; continue; }
    if (ch === '"') chaine = true; else if (ch === '{') prof += 1; else if (ch === '}') { prof -= 1; if (prof === 0) return JSON.parse(reste.slice(0, c + 1)); }
  }
  throw new Error('JSON non fermé');
}

describe('L107D-U-GUIDE-14 — étape 14 : bloc T1 `t1-receipt-lines-v1`', () => {
  const b = guideBlock('t1-receipt-lines-v1')!;

  it('bloc balisé, ligne repère unique dans le texte livré ; collé, aucun bloquant BO, aucun emplacement ni branche ajoutés', () => {
    expect(b).toMatchObject({ prompt: 't1', action: 'insert-before', anchor: 'Réponds uniquement par le JSON de la branche TASK demandée, sans texte autour.' });
    expect(occurrences(T1_LIVRE, b.anchor!)).toBe(1);
    const apres = T1_LIVRE.replace(b.anchor!, `${b.text}\n\n${b.anchor}`);
    expect(apres).toContain('t1-receipt-lines-v1');
    expect(checkMasterPromptContent('T1', apres).blocking).toEqual(checkMasterPromptContent('T1', T1_LIVRE).blocking);
    expect(inspectMasterTemplate(b.text).placeholders).toEqual([]);
    expect(inspectMasterTemplate(apres).branches).toEqual(inspectMasterTemplate(T1_LIVRE).branches);
  });

  it('exemple : faits valides (schéma T1 réel) ; projection réelle → prix du bien = SA ligne (69,99 €), jamais le total', () => {
    const { facts } = premierJson(b.text);
    for (const f of facts) expect(t1Fact.safeParse(f).success).toBe(true);
    const fx = loadT1Fixture('p-t1-02-ticket-draisienne.json');
    const out = fx.recording.output as Record<string, any>;
    out.facts = facts;
    out.transcription = 'DRAISIENNE BOIS 12P 69,99\nCASQUE ENFANT 34,95\nSONNETTE 22,99\nTOTAL TTC 127,93';
    out.document.amountCents = { value: 12793, confidence: 'certain', evidence: { excerpt: 'TOTAL TTC 127,93', page: 1 } };
    const parsed = T1AnalyzeDocumentOutput.parse(out);
    const ok = parsed.facts.map(checkFactEvidence).filter((c) => c.ok).map((c) => (c as { fact: T1Fact }).fact);
    expect(ok).toHaveLength(4);
    const p = projectDocumentFacts({ ...parsed, facts: ok }, {
      knownAssetId: 184, documentAssetId: 184, assetFamilies: new Map<number, AssetFamily | undefined>([[184, toAssetFamily('OBJECT')]]),
      verifiedIds: { ASSET: new Set([184]), EQUIPMENT: new Set(), ROOM: new Set(), SUPPLIER: new Set() },
    });
    const prix = p.facts.filter((x) => x.canonicalKey === 'acquisitionPrice');
    expect(prix.map((x) => [x.value, x.ruleCode])).toEqual([[69.99, PROJECTION_RULES.PURCHASE_LINE_ACQUISITION_PRICE]]);
  });
});
