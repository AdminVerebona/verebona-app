/**
 * Matrice des événements métier (CDC 15 §13, MAT-01 à MAT-12), T4-02, T4-04
 * et corpus P-T4-01 à P-T4-03 (§30, fixtures synthétiques D-08).
 *
 * Côté T1 (ce dépôt de code) : les CANDIDATS — nature, type métier,
 * catégorie du registre, autorité de la source. Côté T4 (règles de A, lues
 * sans modification) : autorisation de création, classification et
 * décision de réalisation appliquées à ces candidats.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { buildAgendaCandidatesT4, type T4CandidateContext } from '../build-agenda-candidates.step';
import type { ExtractedField } from '../../types';
import { creationAuthorization } from '@/services/ai/agenda/agenda-intelligence.service';
import { classifyByRules } from '@/services/ai/agenda/rules/deterministic-classification';
import { decideCompletion } from '@/services/ai/agenda/status-reconciler';
import { translateVerifyCompletion } from '@/services/ai/agenda/master/verify-completion';
import { T4VerifyCompletionOutput } from '@/services/ai/agenda/master/t4-contract';

const CTX: T4CandidateContext = {
  sourceFileId: 1, documentAssetId: 7, multiAsset: false, documentTitle: 'Doc', documentDate: '2026-06-02', documentType: 'FACTURE',
};
const lu = (key: string, value: string, extra: Partial<ExtractedField> = {}): ExtractedField =>
  ({ fieldKey: key, canonicalKey: key, value, confidence: 'certain', excerpt: `${key} : ${value}`, provenance: 'TEXT_EXTRACTION', ...extra });
const evenement = (type: string, nature: 'HISTORICAL' | 'DEADLINE' = 'HISTORICAL'): ExtractedField =>
  ({ fieldKey: 'prestation', canonicalKey: null, value: 'x', confidence: 'certain', excerpt: 'x', provenance: 'TEXT_EXTRACTION', semanticEvent: { type, nature } });
const un = (fields: ExtractedField[], ctx: Partial<T4CandidateContext> = {}) => buildAgendaCandidatesT4(fields, { ...CTX, ...ctx });

describe('matrice §13 — MAT-01 à MAT-12', () => {
  const cas: Array<[string, ExtractedField[], Partial<T4CandidateContext>, Array<[string, string, string | undefined]>]> = [
    // [id, faits, contexte, [businessType, nature, suggestedCategory]]
    ['MAT-01 Achat du bien', [lu('acquisitionDate', '2026-04-24')], {}, [['purchase', 'HISTORICAL', 'information']]],
    ['MAT-02 Entretien réalisé', [lu('lastRevision', '2026-05-01')], {}, [['maintenance', 'HISTORICAL', 'information']]],
    ['MAT-03 Prochain entretien (date explicite)', [lu('maintenanceDueDate', '2027-05-01')], {}, [['maintenance', 'DEADLINE', 'action']]],
    ['MAT-04 Réparation (aucun effet prix)', [evenement('repair')], {}, [['repair', 'HISTORICAL', 'information']]],
    ['MAT-05 Contrôle réalisé', [lu('lastInspectionDate', '2026-05-02')], { documentType: 'CONTROLE_TECHNIQUE' }, [['inspection', 'HISTORICAL', 'information']]],
    ['MAT-06 Prochain contrôle', [lu('nextInspection', '2028-05-01')], { documentType: 'CONTROLE_TECHNIQUE' }, [['inspection', 'DEADLINE', 'action']]],
    // Assurance : « information ou action selon l'événement réel » → laissé à T4.
    ['MAT-07 Assurance', [lu('insuranceExpiry', '2027-01-01')], { documentType: 'CONTRAT_ASSURANCE' }, [['insurance', 'DEADLINE', undefined]]],
    ['MAT-08 Garantie', [lu('warrantyEndDate', '2028-04-24')], { documentType: 'CERTIFICAT_GARANTIE' }, [['warranty', 'DEADLINE', 'information']]],
    ['MAT-09 DPE réalisé', [lu('dpeDate', '2026-03-12')], { documentType: 'DPE' }, [['dpe', 'HISTORICAL', 'information']]],
    ['MAT-10 Expiration DPE explicite', [lu('dpeExpiryDate', '2036-03-11')], { documentType: 'DPE' }, [['dpe', 'DEADLINE', undefined]]],
    ['MAT-11 Sinistre', [evenement('claim')], { documentType: 'CONSTAT_SINISTRE' }, [['claim', 'HISTORICAL', 'information']]],
    ['MAT-12 Vente / transmission', [evenement('sale')], { documentType: 'ACTE_AUTHENTIQUE' }, [['sale', 'HISTORICAL', 'information']]],
  ];
  it.each(cas)('%s', (_id, faits, ctx, attendu) => {
    expect(un(faits, ctx).map((c) => [c.businessType, c.nature, c.suggestedCategory])).toEqual(attendu);
  });

  it('prochaine échéance jamais inventée : « Dernier entretien » + récurrence énoncée → HISTORICAL qui porte la récurrence, aucune DEADLINE', () => {
    const c = un([lu('lastRevision', '2026-05-01', { excerpt: 'Entretien annuel — dernier le 01/05/2026', recurrence: { frequency: 'yearly', interval: 1, excerpt: 'Entretien annuel' } })]);
    expect(c.map((x) => x.nature)).toEqual(['HISTORICAL']);
    expect(c[0].recurrence).toMatchObject({ mode: 'EXPLICIT_SOURCE', frequency: 'yearly' });
  });

  it('chaque candidat porte ses sources (document, preuve) pour la clé fonctionnelle', () => {
    expect(un([lu('nextInspection', '2028-05-01')])[0]).toMatchObject({
      sources: [{ fileId: 1, role: 'SOURCE' }], target: { type: 'ASSET', id: 7 }, occurrence: 'single', originFieldKey: 'nextInspection',
    });
  });
});

describe('T4-02 — un champ de bien FUTUR est une action', () => {
  it('contrôle technique futur et entretien futur : action (candidat ET règles de T4)', () => {
    for (const [key, date] of [['nextInspection', '2028-05-01'], ['maintenanceDueDate', '2027-05-01']]) {
      const [c] = un([lu(key, date)]);
      expect(c.suggestedCategory, key).toBe('action');
      expect(classifyByRules({ title: c.title, originType: 'asset_field', originFieldKey: c.originFieldKey, businessType: c.businessType, nature: c.nature }), key)
        .toBe('action');
      // Lot 16b-2 : plus de moteur historique « champ de bien ⇒ information ».
      expect(classifyByRules({ title: c.title, originType: 'asset_field', originFieldKey: c.originFieldKey }), key).not.toBe('information');
    }
  });
});

describe('T4-04 — autorité de la source', () => {
  it('source autoritaire (PV) : création autorisée ; devis ou type inconnu : proposition seulement', () => {
    const [pv] = un([lu('nextInspection', '2028-05-01')], { documentType: 'CONTROLE_TECHNIQUE' });
    expect(pv).toMatchObject({ documentType: 'CONTROLE_TECHNIQUE', authority: 'AUTHORITATIVE', mayCreateAgenda: true });
    expect(creationAuthorization(pv).allowed).toBe(true);

    const [devis] = un([lu('maintenanceDueDate', '2027-05-01')], { documentType: 'DEVIS' });
    expect(devis).toMatchObject({ authority: 'WEAK', mayCreateAgenda: false });
    expect(creationAuthorization(devis)).toMatchObject({ allowed: false, reasonCode: 'SOURCE_TYPE_NOT_AUTHORIZED' });

    const [inconnu] = un([lu('maintenanceDueDate', '2027-05-01')], { documentType: 'BROCHURE' });
    expect(inconnu).toMatchObject({ authority: null, mayCreateAgenda: null });
    expect(creationAuthorization(inconnu).allowed).toBe(false);
  });
});

const FIX = join(__dirname, '..', '..', '__fixtures__', 't4');
const fixture = <T>(f: string): T => JSON.parse(readFileSync(join(FIX, f), 'utf8')) as T;
type Completion = {
  item: Parameters<typeof decideCompletion>[0];
  evidence: { excerpt: string; confidence: 'certain'; documentType: string; documentDate: string; occurrenceDate?: string; proofCode?: string };
  recording: { output: unknown };
  expected: Record<string, string>;
};
const evidenceOf = (e: Completion['evidence']) => ({
  ...e, documentDate: new Date(`${e.documentDate}T00:00:00Z`), occurrenceDate: e.occurrenceDate ? new Date(`${e.occurrenceDate}T00:00:00Z`) : null,
});

describe('corpus P-T4 (§30)', () => {
  it('P-T4-01 : contrôle technique futur → DEADLINE, action, source autoritaire', () => {
    const f = fixture<{ context: T4CandidateContext; fields: ExtractedField[]; expected: { deadline: object; historical: object } }>('p-t4-01-controle-technique-futur.json');
    const c = buildAgendaCandidatesT4(f.fields, { ...f.context, multiAsset: false });
    expect(c.find((x) => x.nature === 'DEADLINE')).toMatchObject(f.expected.deadline);
    expect(c.find((x) => x.nature === 'HISTORICAL')).toMatchObject(f.expected.historical);
  });

  it('P-T4-02 : facture ambiguë → jamais « non réalisé » (unknown puis not_proven)', () => {
    const f = fixture<Completion>('p-t4-02-facture-ambigue.json');
    const ev = evidenceOf(f.evidence);
    const det = decideCompletion(f.item, ev);
    expect(det.status).toBe(f.expected.deterministic);
    const apres = translateVerifyCompletion(f.item, ev, det, T4VerifyCompletionOutput.parse(f.recording.output));
    expect(apres.status).toBe(f.expected.afterModel);
    expect([det.status, apres.status]).not.toContain(f.expected.never);
  });

  it('P-T4-03 : preuve d’une autre occurrence → aucune clôture', () => {
    const f = fixture<Completion>('p-t4-03-autre-occurrence.json');
    const ev = evidenceOf(f.evidence);
    const det = decideCompletion(f.item, ev);
    const apres = det.needsModel
      ? translateVerifyCompletion(f.item, ev, det, T4VerifyCompletionOutput.parse(f.recording.output))
      : det;
    expect(apres).toMatchObject(f.expected);
  });
});
