/**
 * Lot 112H — saisie manuelle des conditions d'un prêt (fiche du bien › Coût total de possession › Financement).
 *
 *   L112H-U1  état par condition (serveur) : origine document + sources, saisie prioritaire + valeur du document conservée,
 *             contradiction, montant emprunté consolidé → justificatifs du prêt
 *   L112H-U2  corps envoyé : seuls les champs modifiés, formats français (€, %), durée en échéances → mois,
 *             saisie vidée → null (retour au document), champ documentaire vidé → non envoyé, différé
 *   L112H-U3  validations client alignées sur la route (parseLoanTermsBody) ; message 422 de la route → champ
 *   L112H-U4  rendu : libellés reliés, origine et erreur reliées (aria-describedby), clavier numérique, cibles 44 px,
 *             « Revenir à la valeur du document », lecture seule sans champ, aucun « Opération »
 *   L112H-U5  résumé du capital restant dû après enregistrement (établi / non établi : il manque …)
 *   L112H-U6  intégration fiche : bouton par prêt (Compléter / Modifier / Voir), feuille plein écran mobile, route 112D seule
 */
import * as React from 'react';
import { createElement as h } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { assembleLoanEvidence } from '@/services/business-operations/tco/loan-evidence';
import { resolveOutstandingPrincipal } from '@/services/business-operations/tco/outstanding-principal';
import { parseLoanTermsBody } from '@/services/business-operations/financing/loan-terms-decisions';
import {
  buildLoanTermsPatch, centsToInput, fieldOfServerMessage, loanFieldOrigin, outstandingSummary, textOf, type LoanFieldStates,
} from '../tco-loan-terms-model';

(globalThis as { React?: typeof React }).React = React;
const { TcoLoanTermsFields, TcoLoanOutstandingStatus } = await import('../TcoLoanTermsSheet');

const lire = (p: string) => readFileSync(resolve(__dirname, '..', '..', '..', '..', p), 'utf8');
const docs = new Map([[11, { title: 'Offre de prêt PRET-1', date: '2021-10-01' }], [12, { title: 'Tableau d’amortissement', date: '2021-11-20' }]]);
const fait = (fileId: number, label: string, valueText: string) => ({
  fileId, factKey: null, rawKey: null, label, subject: null, attribute: null, valueText, valueNumber: null, valueUnit: null,
  normalizedValue: null, valueType: null, periodStart: null, periodEnd: null, excerpt: `${label} : ${valueText}`, confidence: 'certain',
});

/** Prêt : capital consolidé, taux et durée lus sur l'offre ; taux SAISI à 3,10 % ; périodicité contradictoire. */
function etats(): LoanFieldStates {
  const ev = assembleLoanEvidence({
    principal: { cents: 20_000_000, currency: 'EUR' },
    facts: [fait(11, 'Taux nominal annuel fixe', '3,00 %'), fait(11, 'Durée du prêt', '240 mois'), fait(11, 'Périodicité', 'mensuelle'), fait(12, 'Périodicité', 'trimestrielle')],
    tables: [],
    manual: { values: { ratePct: '3.1' }, origins: { ratePct: { origin: 'USER', at: '2026-11-06T09:30:00.000Z', userId: 7 } }, events: [] },
  });
  const o = resolveOutstandingPrincipal({ evidence: ev, scheduleChanges: [], documents: docs, today: '2026-11-06' });
  return o.fields!;
}

describe('L112H-U1 — état de chaque condition (serveur)', () => {
  it('origine, sources, saisie prioritaire avec valeur du document conservée, contradiction', () => {
    const s = etats();
    expect(s.ratePct).toMatchObject({ value: '3.1', origin: 'USER', enteredAt: '2026-11-06T09:30:00.000Z', document: { value: '3', sources: [{ fileId: 11, title: 'Offre de prêt PRET-1' }] } });
    expect(s.durationMonths).toMatchObject({ value: 240, origin: 'DOCUMENT', document: { sources: [{ fileId: 11 }] } });
    // Capital consolidé (sans justificatif précis) : tous les justificatifs du prêt.
    expect(s.principalCents).toMatchObject({ value: 20_000_000, origin: 'DOCUMENT' });
    expect(s.principalCents!.document!.sources.map((x) => x.fileId)).toEqual([11, 12]);
    expect(s.periodicity).toMatchObject({ value: null, origin: null, documentConflict: ['mensuelle', 'trimestrielle'].map(() => expect.any(String)) });
    expect(s.firstInstallmentDate).toMatchObject({ value: null, origin: null, document: null, documentConflict: null });
    expect(Object.keys(s)).toHaveLength(8);
  });

  it('textes d’origine : lu sur « titre », saisi par vous le …, valeur du document, retour possible', () => {
    const s = etats();
    expect(loanFieldOrigin('durationMonths', s.durationMonths, 'MONTHLY')).toMatchObject({ kind: 'DOCUMENT', text: 'Lu sur « Offre de prêt PRET-1 ».', canRevertToDocument: false });
    const taux = loanFieldOrigin('ratePct', s.ratePct, null);
    expect(taux).toMatchObject({ kind: 'USER', canRevertToDocument: true, canClear: false });
    expect(taux.text).toBe('Saisi par vous le 06/11/2026 : votre saisie prime sur les documents.');
    expect(taux.documentText).toBe('Valeur du document : 3 % (lu sur « Offre de prêt PRET-1 »).');
    expect(loanFieldOrigin('periodicity', s.periodicity, null).kind).toBe('CONFLICT');
    expect(loanFieldOrigin('firstInstallmentDate', s.firstInstallmentDate, null)).toMatchObject({ kind: 'NONE', text: 'Non renseigné.' });
    // Saisie sans valeur documentaire : « Effacer ma saisie ».
    expect(loanFieldOrigin('insuranceCents', { value: 5_000, origin: 'USER', enteredAt: null, document: null, documentConflict: null }, null)).toMatchObject({ canClear: true, canRevertToDocument: false });
  });
});

describe('L112H-U2 — corps envoyé à la route', () => {
  it('seuls les champs modifiés ; formats français ; durée en échéances → mois', () => {
    const s = etats();
    expect(buildLoanTermsPatch(s, {})).toEqual({ ok: true, body: { terms: {} }, changed: [] });
    // Valeur identique à celle retenue (texte reformaté) : rien n'est envoyé.
    expect(buildLoanTermsPatch(s, { principalCents: '200 000,00 €', ratePct: '3,10' })).toMatchObject({ ok: true, changed: [] });
    const r = buildLoanTermsPatch(s, {
      periodicity: 'QUARTERLY', durationMonths: '100', firstInstallmentDate: '2021-12-05', installmentCents: '3 327,60', insuranceCents: '0', ratePct: '3,25 %',
    });
    expect(r).toEqual({ ok: true, changed: expect.any(Array), body: { terms: { periodicity: 'QUARTERLY', durationMonths: 300, firstInstallmentDate: '2021-12-05', installmentCents: 332_760, insuranceCents: 0, ratePct: '3.25' } } });
    // 80 échéances trimestrielles = 240 mois = durée déjà retenue : non envoyée.
    expect(buildLoanTermsPatch(s, { periodicity: 'QUARTERLY', durationMonths: '80' })).toMatchObject({ ok: true, body: { terms: { periodicity: 'QUARTERLY' } }, changed: ['periodicity'] });
    expect(centsToInput(110_920)).toBe('1 109,20');
    expect(textOf(s, {}, 'principalCents')).toBe('200 000,00');
    expect(textOf(s, {}, 'ratePct')).toBe('3,1');
    expect(textOf(s, { periodicity: 'MONTHLY' }, 'durationMonths')).toBe('240');
  });

  it('saisie vidée → null (retour au document) ; champ documentaire vidé → non envoyé ; différé', () => {
    const s = etats();
    expect(buildLoanTermsPatch(s, { ratePct: '' })).toMatchObject({ ok: true, body: { terms: { ratePct: null } } });
    expect(buildLoanTermsPatch(s, { principalCents: '' })).toMatchObject({ ok: true, body: { terms: {} }, changed: [] });
    expect(buildLoanTermsPatch(s, { deferralKind: 'PARTIAL', deferralMonths: '12' })).toMatchObject({ ok: true, body: { terms: { deferral: { months: 12, kind: 'PARTIAL' } } } });
    expect(buildLoanTermsPatch(s, { deferralKind: 'NONE' })).toMatchObject({ ok: true, body: { terms: { deferral: { months: 0, kind: 'NONE' } } } });
    // Chaque corps produit est accepté tel quel par la validation de la route.
    for (const d of [{ ratePct: '' }, { deferralKind: 'PARTIAL' as const, deferralMonths: '12' }, { periodicity: 'MONTHLY' as const, durationMonths: '240', installmentCents: '1 109,20' }]) {
      const b = buildLoanTermsPatch(s, d);
      expect(b.ok && parseLoanTermsBody(b.body).ok).toBe(true);
    }
  });
});

describe('L112H-U3 — validations alignées sur la route', () => {
  it('erreurs client par champ (aucun envoi)', () => {
    const s = etats();
    const r = buildLoanTermsPatch(s, { ratePct: '150', principalCents: '0', installmentCents: '12,345', firstInstallmentDate: '2021-02-30', durationMonths: '12', deferralKind: 'TOTAL', deferralMonths: '' });
    expect(r.ok).toBe(false);
    const e = (r as { errors: Record<string, string> }).errors;
    expect(Object.keys(e).sort()).toEqual(['deferral', 'durationMonths', 'firstInstallmentDate', 'installmentCents', 'principalCents', 'ratePct']);
    expect(e.durationMonths).toBe('Choisissez d’abord la périodicité des échéances.');
    expect(e.installmentCents).toBe('2 décimales maximum.');
    expect(parseLoanTermsBody({ terms: { ratePct: '150' } }).ok).toBe(false);
    // Durée au-delà de la borne de la route (600 mois).
    expect(buildLoanTermsPatch(s, { periodicity: 'ANNUAL', durationMonths: '51' })).toMatchObject({ ok: false, errors: { durationMonths: expect.stringContaining('600 mois au plus') } });
    // Périodicité changée sans retoucher une durée qui n'en fait pas un nombre entier d'échéances.
    expect(buildLoanTermsPatch({ ...s, durationMonths: { ...s.durationMonths!, value: 250 } }, { periodicity: 'QUARTERLY' })).toMatchObject({ ok: false, errors: { durationMonths: expect.stringContaining('250 mois') } });
  });

  it('chaque message 422 de la route est rattaché à son champ', () => {
    const cas: Array<[Record<string, unknown>, string]> = [
      [{ principalCents: 0 }, 'principalCents'], [{ installmentCents: -1 }, 'installmentCents'], [{ insuranceCents: -1 }, 'insuranceCents'],
      [{ ratePct: 'x' }, 'ratePct'], [{ periodicity: 'WEEKLY' }, 'periodicity'], [{ durationMonths: 0 }, 'durationMonths'],
      [{ firstInstallmentDate: '2021-02-30' }, 'firstInstallmentDate'], [{ deferral: { months: 3, kind: 'NONE' } }, 'deferral'],
    ];
    for (const [terms, champ] of cas) {
      const r = parseLoanTermsBody({ terms });
      expect(r.ok).toBe(false);
      expect(fieldOfServerMessage((r as { message: string }).message), champ).toBe(champ);
    }
    expect(fieldOfServerMessage('Prêt introuvable pour ce bien.')).toBeNull();
  });
});

describe('L112H-U4 — rendu du formulaire', () => {
  const rendre = (canEdit: boolean, errors = {}) => renderToStaticMarkup(h(TcoLoanTermsFields, { states: etats(), draft: {}, errors, canEdit, idPrefix: 'p' }));

  it('édition : libellés reliés, clavier numérique, cibles 44 px, origine et erreur reliées, retour au document', () => {
    const html = rendre(true, { ratePct: 'Taux nominal invalide (pourcentage, ex. « 3,25 »).' });
    for (const f of ['principalCents', 'ratePct', 'durationMonths', 'installmentCents', 'insuranceCents']) {
      expect(html).toContain(`for="p-${f}"`);
      expect(html).toMatch(new RegExp(`id="p-${f}"[^>]*inputMode="(decimal|numeric)"|inputMode="(decimal|numeric)"[^>]*id="p-${f}"`));
    }
    expect(html).toMatch(/id="p-ratePct"[^>]*aria-describedby="p-ratePct-error p-ratePct-origin"|aria-describedby="p-ratePct-error p-ratePct-origin"[^>]*id="p-ratePct"/);
    expect(html).toContain('id="p-ratePct-error"');
    expect(html).toMatch(/aria-invalid="true"/);
    expect(html).toContain('id="p-durationMonths-hint"');
    expect(html).toContain('min-h-[44px]');
    expect(html).toContain('value="200 000,00"');
    expect(html).toContain('value="3,1"');
    expect(html).toContain('data-loan-revert="ratePct"');
    expect(html).toContain('Revenir à la valeur du document');
    expect(html).toContain('Lu sur « Offre de prêt PRET-1 ».');
    expect(html).toContain('Les documents se contredisent');
    expect(html).not.toMatch(/Opération/);
  });

  it('lecture seule : valeurs et origines, aucun champ ni geste', () => {
    const html = rendre(false);
    expect(html).not.toContain('<input');
    expect(html).not.toContain('data-loan-revert');
    expect(html).toMatch(/200\s000,00\s€/);
    expect(html).toContain('3,1 %');
    expect(html).toContain('Les documents se contredisent (Mensuelle / Trimestrielle)');
    expect(html).toContain('Saisi par vous le 06/11/2026');
    expect(html).not.toMatch(/Opération/);
  });
});

describe('L112H-U5 — capital restant dû après enregistrement', () => {
  it('établi (valeur datée) ou non établi (ce qui manque)', () => {
    const ok = outstandingSummary({ status: 'ESTABLISHED', cents: 16_061_234, asOf: '2026-11-05', label: 'Calculé selon les conditions du prêt.' });
    expect(ok).toMatchObject({ established: true, detail: 'Calculé selon les conditions du prêt.' });
    expect(ok!.title).toMatch(/^Capital restant dû : 160\s612,34\s€ au 05\/11\/2026$/);
    const label = 'Capital restant dû non établi : il manque la date de la première échéance. Ajoutez le tableau d’amortissement ou une attestation de capital restant dû.';
    expect(outstandingSummary({ status: 'NOT_ESTABLISHED', cents: null, asOf: null, label })).toEqual({ established: false, title: 'Capital restant dû : non établi', detail: label });
    const html = renderToStaticMarkup(h(TcoLoanOutstandingStatus, { loan: { key: 'op:1', operationId: 1, label: 'Prêt', lender: null, reference: null, outstanding: { status: 'NOT_ESTABLISHED', cents: null, asOf: null, label } } as never }));
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('il manque la date de la première échéance');
  });
});

describe('L112H-U6 — intégration fiche du bien', () => {
  const section = lire('src/components/assets/TcoSection.tsx');
  const feuille = lire('src/components/assets/TcoLoanTermsSheet.tsx');
  it('bouton par prêt, feuille plein écran mobile, route 112D seule, TCO recalculé appliqué', () => {
    expect(section).toContain("'Compléter les conditions du prêt'");
    expect(section).toContain("'Modifier les conditions du prêt'");
    expect(section).toContain("'Voir les conditions du prêt'");
    expect(section).toMatch(/<TcoLoanTermsSheet[\s\S]*onSaved=\{\(tco\) => \{ coordinator\.current\?\.supersede\(\); setData\(tco\)/);
    expect(feuille).toContain('className="w-full sm:max-w-md flex flex-col gap-0 p-0"');
    expect(feuille).toContain('`/api/assets/${assetId}/tco/financing/${loan.operationId}`');
    expect(feuille.match(/apiClient\.(put|post|patch|delete)\b/g)).toEqual(['apiClient.put']);
    expect(feuille).toContain('<FooterPrimaryAction');
    // Aucun texte affiché « Opération » (commentaires exclus).
    const code = feuille.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/Opération/);
  });
});
