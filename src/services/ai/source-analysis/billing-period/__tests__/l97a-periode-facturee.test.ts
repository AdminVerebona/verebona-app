/**
 * Lot 97A (demande `87D-mois-principal-factures`) — période facturée et mois
 * principal décidés par T1 (`document.billingPeriod`, contrat
 * `t1-billing-period-v1`), du guide du PO jusqu'au titre du document.
 *
 *  L97A-B01  schéma de sortie T1 v7 : bloc facultatif, additif (une sortie v6 reste valide), schéma fournisseur dérivé ;
 *  L97A-B02  lecture tolérante : bloc mal formé retiré SEUL (document valide, original conservé) ;
 *  L97A-B03  activation prudente : conservé seulement si le prompt T1 effectif porte le marqueur (même version) ;
 *  L97A-B04  persistance → nommage : mois « certain » lu par `principalMonthFromAnalysis`, titre « Facture … — Février 2026 » ;
 *  L97A-B05  guide du PO : un seul bloc T1 (91D + 97A), applicable au prompt livré, contrôles BO sans bloquant,
 *            application en deux temps identique, exemple JSON passé au validateur réel ;
 *  L97A-B06  lots de pages : la première période lue est conservée.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: {} }));

const { T1AnalyzeDocumentOutput, T1_ANALYZE_DOCUMENT_CONTRACT_VERSION } = await import('../../master/t1-contract');
const { T1AnalyzeDocumentTolerantOutput, splitNormalisation } = await import('../../master/tolerant-output');
const bp = await import('../contract');
const { promptCarriesValueDecisions } = await import('../../value-decisions/contract');
const { principalMonthFromAnalysis } = await import('@/lib/documents/document-title-convention');
const { planBusinessTitle } = await import('@/services/ai/source-analysis/document-title');
const { billingBasisFrom } = await import('@/services/documents/document-title.service');
const { inspectMasterTemplate } = await import('@/services/ai/prompts/prompt-loader');
const { checkMasterPromptContent } = await import('@/services/ai/master-prompts/master-prompt-checks');
const { outputSchemaRef } = await import('@/services/ai/gateway/output-resolution/contracts');

const RACINE = process.cwd();
const GUIDE = readFileSync(join(RACINE, 'docs', 'exploitation', 'prompts-a-appliquer-par-le-po.md'), 'utf-8');
const T1_LIVRE = readFileSync(join(RACINE, 'src', 'services', 'ai', 'prompts', 'source-analysis', 't1_master_v1.txt'), 'utf-8');

const blocT1 = (() => {
  const m = /<!-- l89c:bloc ([^>]*?id="t1-value-decisions-v1"[^>]*?) -->\s*\n```text\n([\s\S]*?)\n```/.exec(GUIDE);
  if (!m) throw new Error('bloc T1 absent du guide');
  const attrs = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((a) => [a[1], a[2]]));
  return { attrs, text: m[2] };
})();
const inserer = (texte: string, bloc: string) => {
  expect(texte.split(blocT1.attrs.anchor).length - 1).toBe(1);
  return texte.replace(blocT1.attrs.anchor, `${bloc}\n\n${blocT1.attrs.anchor}`);
};
const DEBUT_97A = 'PÉRIODE FACTURÉE ET MOIS PRINCIPAL (contrat t1-billing-period-v1)';

/** Objets JSON du bloc : ligne qui COMMENCE par « { » jusqu'à l'accolade fermante équilibrée. */
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

const BP = { start: '2026-02-05', end: '2026-03-04', principalMonth: '2026-02', principalMonthBasis: 'STATED_ON_DOCUMENT', confidence: 'certain', evidence: { excerpt: 'Abonnement février 2026', page: 1 } };
const sortie = (billingPeriod?: unknown) => ({ task: 'ANALYZE_DOCUMENT', document: { title: { value: 'Facture Homiris', confidence: 'certain' }, ...(billingPeriod !== undefined ? { billingPeriod } : {}) }, facts: [] });

describe('L97A-B01 — schéma de sortie T1 v7', () => {
  it('version incrémentée ; bloc facultatif : une sortie sans lui reste valide, avec lui il est conservé tel quel', () => {
    expect(T1_ANALYZE_DOCUMENT_CONTRACT_VERSION).toBe(7);
    expect(outputSchemaRef('T1AnalyzeDocumentOutput', T1AnalyzeDocumentOutput, 't1_analyze_document').version).toBe('t1_analyze_document@v7');
    expect(T1AnalyzeDocumentOutput.parse(sortie()).document.billingPeriod).toBeUndefined();
    expect(T1AnalyzeDocumentOutput.parse(sortie(BP)).document.billingPeriod).toEqual(BP);
    expect(T1AnalyzeDocumentOutput.parse(sortie({ ...BP, principalMonth: null, principalMonthBasis: null, confidence: 'probable' })).document.billingPeriod?.principalMonth).toBeNull();
  });
  it('vocabulaire fermé (fondement, confiance), formats stricts (mois AAAA-MM, dates AAAA-MM-JJ)', () => {
    for (const faux of [{ principalMonth: '2026-13' }, { principalMonth: '02/2026' }, { principalMonthBasis: 'ISSUE_MONTH' }, { start: '05/02/2026' }, { confidence: 'sure' }]) {
      expect(T1AnalyzeDocumentOutput.safeParse(sortie({ ...BP, ...faux })).success, JSON.stringify(faux)).toBe(false);
    }
  });
  it('schéma fournisseur (structured output) dérivé du contrat : le bloc y figure, facultatif', async () => {
    const { providerJsonSchema } = await import('@/services/ai/gateway/output-resolution/provider-schema');
    const js = JSON.stringify(providerJsonSchema(T1AnalyzeDocumentOutput));
    expect(js).toContain('billingPeriod');
    expect(js).toContain('principalMonthBasis');
  });
});

describe('L97A-B02 — lecture tolérante : un bloc mal formé est retiré seul', () => {
  it('confiance « uncertain » lue « probable », fondement en minuscules normalisé, date française normalisée', () => {
    const r = splitNormalisation(T1AnalyzeDocumentTolerantOutput.parse(sortie({ ...BP, start: '05/02/2026', principalMonthBasis: 'stated on document', confidence: 'Uncertain' })));
    expect(r.output.document.billingPeriod).toMatchObject({ start: '2026-02-05', principalMonthBasis: 'STATED_ON_DOCUMENT', confidence: 'probable' });
  });
  it('mois impossible : bloc retiré, document valide, original conservé dans le rapport', () => {
    const r = splitNormalisation(T1AnalyzeDocumentTolerantOutput.parse(sortie({ ...BP, principalMonth: '2026-13' })));
    expect(r.output.document.billingPeriod).toBeUndefined();
    expect(r.output.document.title?.value).toBe('Facture Homiris');
    expect(JSON.stringify(r.report)).toContain('document.billingPeriod');
  });
});

describe('L97A-B03 — activation prudente (marqueur du prompt T1 effectif)', () => {
  const parse = T1AnalyzeDocumentOutput.parse(sortie(BP)).document.billingPeriod!;
  it('contrat porté par la version qui a répondu : bloc persisté (preuve « quote » lue par le nommage)', () => {
    expect(bp.persistedBillingPeriod(parse, { carried: true, version: 'v12' }, 'v12')).toEqual({
      start: '2026-02-05', end: '2026-03-04', principalMonth: '2026-02', principalMonthBasis: 'STATED_ON_DOCUMENT', confidence: 'certain',
      evidence: { quote: 'Abonnement février 2026', page: 1 },
    });
  });
  it('marqueur absent, autre version du prompt, bloc absent : rien n’est conservé (comportement d’avant)', () => {
    expect(bp.persistedBillingPeriod(parse, { carried: false, version: 'v12' }, 'v12')).toBeNull();
    expect(bp.persistedBillingPeriod(parse, { carried: true, version: 'v13' }, 'v12')).toBeNull();
    expect(bp.persistedBillingPeriod(undefined, { carried: true, version: 'v12' }, 'v12')).toBeNull();
  });
  it('le prompt livré ne porte pas le contrat ; coupure d’urgence', () => {
    expect(bp.promptCarriesBillingPeriod(T1_LIVRE)).toBe(false);
    expect(bp.billingPeriodEnabled({ T1_BILLING_PERIOD_ENABLED: '0' })).toBe(false);
    expect(bp.billingPeriodEnabled({})).toBe(true);
  });
});

describe('L97A-B04 — persistance jusqu’au nommage', () => {
  it('résultat persisté → mois principal → titre « Facture Homiris — Février 2026 »', () => {
    const persiste = { document: { billingPeriod: bp.persistedBillingPeriod(T1AnalyzeDocumentOutput.parse(sortie(BP)).document.billingPeriod, { carried: true, version: null }, 'v1') } };
    expect(principalMonthFromAnalysis(persiste)).toEqual({ value: '2026-02', basis: 'STATED_ON_DOCUMENT', source: 'T1_BILLING_PERIOD', quote: 'Abonnement février 2026' });
    const basis = billingBasisFrom({ candidatePayloads: [], factPeriods: [], analysisResult: persiste, issueDate: '2026-02-06' });
    const plan = planBusinessTitle('Facture Homiris Alarme n° 94741358', { typeCode: 'FACTURE', supplier: 'HOMIRIS', documentDate: '2026-02-06', billing: basis, selfId: 1 });
    expect(plan.title).toBe('Facture Homiris — Février 2026');
  });
  it('mois « probable » : jamais utilisé pour nommer (aucun mois déduit)', () => {
    const persiste = { document: { billingPeriod: { ...bp.persistedBillingPeriod(T1AnalyzeDocumentOutput.parse(sortie(BP)).document.billingPeriod, { carried: true, version: null }, 'v1')!, confidence: 'probable' } } };
    expect(principalMonthFromAnalysis(persiste)).toBeNull();
  });
});

describe('L97A-B05 — guide du PO : un seul bloc T1', () => {
  const T1_ETAPE4 = inserer(T1_LIVRE, blocT1.text);
  it('le bloc porte les deux marqueurs ; le texte livré aucun ; aucune branche ni aucun emplacement ajouté', () => {
    expect(promptCarriesValueDecisions(T1_ETAPE4) && bp.promptCarriesBillingPeriod(T1_ETAPE4)).toBe(true);
    expect(bp.promptCarriesBillingPeriod(T1_LIVRE) || promptCarriesValueDecisions(T1_LIVRE)).toBe(false);
    expect(inspectMasterTemplate(blocT1.text).placeholders).toEqual([]);
    expect(inspectMasterTemplate(T1_ETAPE4).branches).toEqual(inspectMasterTemplate(T1_LIVRE).branches);
  });
  it('contrôles d’activation du BO : aucun bloquant, aucun avertissement nouveau', () => {
    expect(checkMasterPromptContent('T1', T1_ETAPE4).blocking).toEqual([]);
    expect(checkMasterPromptContent('T1', T1_ETAPE4).warnings.map((w) => w.code)).toEqual(checkMasterPromptContent('T1', T1_LIVRE).warnings.map((w) => w.code));
  });
  it('bloc 4 déjà actif (version 91D) : coller la seule partie 97A au même endroit donne exactement le même texte', () => {
    const i = blocT1.text.indexOf(DEBUT_97A);
    expect(i).toBeGreaterThan(0);
    const partie91d = blocT1.text.slice(0, i).replace(/\n+$/, '');
    const partie97a = blocT1.text.slice(i);
    expect(bp.promptCarriesBillingPeriod(partie91d)).toBe(false);
    expect(inserer(inserer(T1_LIVRE, partie91d), partie97a)).toBe(T1_ETAPE4);
  });
  it('exemple JSON de la partie 97A : schéma strict v7, bloc conservé, mois principal lu par le nommage', () => {
    const exemples = jsonsDe(blocT1.text.slice(blocT1.text.indexOf(DEBUT_97A)));
    expect(exemples).toHaveLength(1);
    const v = T1AnalyzeDocumentOutput.parse(exemples[0]);
    const persiste = bp.persistedBillingPeriod(v.document.billingPeriod, { carried: true, version: null }, 'v1');
    expect(principalMonthFromAnalysis({ document: { billingPeriod: persiste } })?.value).toBe('2026-02');
  });
  it('le guide cite le marqueur, la demande, la coupure d’urgence, et ne liste plus 87D parmi les demandes non réglables', () => {
    for (const m of [bp.T1_BILLING_PERIOD_CONTRACT, bp.T1_BILLING_PERIOD_PENDING_CONTRACT, 'T1_BILLING_PERIOD_ENABLED', 't1_analyze_document@v7']) expect(GUIDE, m).toContain(m);
    expect(GUIDE).not.toMatch(/^\| `87D-mois-principal-factures`/m);
  });
});

describe('L97A-B06 — lots de pages', () => {
  it('la première période lue est conservée (jamais remplacée par celle d’un lot suivant) ; un lot qui seul la porte la fournit', async () => {
    const { mergeChunkOutput } = await import('../../source-units/merge');
    const avec = T1AnalyzeDocumentOutput.parse(sortie(BP));
    const autre = T1AnalyzeDocumentOutput.parse(sortie({ ...BP, principalMonth: '2026-03' }));
    const sans = T1AnalyzeDocumentOutput.parse(sortie());
    expect(mergeChunkOutput(avec, autre).output.document.billingPeriod?.principalMonth).toBe('2026-02');
    expect(mergeChunkOutput(sans, avec).output.document.billingPeriod?.principalMonth).toBe('2026-02');
    expect(mergeChunkOutput(sans, sans).output.document.billingPeriod).toBeUndefined();
  });
});
