/**
 * Lot 58A — BUG P1 « troncature des montants » : logique de saisie (Node).
 *
 * Le champ est contrôlé et TEXTUEL : chaque frappe, collage ou correction
 * produit un texte transmis tel quel (aucune conversion pendant la saisie) ;
 * la conversion se fait à la validation par `parseNumberInput`. La saisie
 * réelle au clavier (Chromium) est couverte par
 * `src/components/ui/__tests__/l58a-montants-navigateur.test.ts`, la chaîne
 * API → BDD par `src/test/e2e/scenarios/l58a-montants.e2e.ts`.
 */
import * as React from 'react';
import { createElement as h } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  MONEY_INPUT, QUANTITY_INPUT, formatNumberForInput, parseMoneyInputToCents, parseNumberInput, stepNumberInput,
} from '@/lib/number-input';

(globalThis as { React?: typeof React }).React = React;
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const ROOT = resolve(__dirname, '../../..');
const lire = (p: string) => readFileSync(resolve(ROOT, p), 'utf8').replace(/\r\n?/g, '\n');

/** Valeurs du ticket : texte saisi → euros attendus. */
const CAS: [string, string, number][] = [
  ['MONTANT-01', '20', 20],
  ['MONTANT-02', '200', 200],
  ['MONTANT-03', '1250', 1250],
  ['MONTANT-04', '12500', 12500],
  ['MONTANT-05', '125000', 125000],
  ['MONTANT-06', '12500,50', 12500.5],
  ['MONTANT-07', '12 500,50', 12500.5],
  ['MONTANT-08', '0', 0],
];

/**
 * Modèle du champ contrôlé : l'état est le texte affiché, chaque événement
 * le remplace par le nouveau texte du navigateur (identité, aucune mise en
 * forme). Retourne les états successifs.
 */
function frappe(initial: string, actions: (string | { backspace: number } | { paste: string } | { clear: true })[]): string[] {
  const etats: string[] = [];
  let t = initial;
  for (const a of actions) {
    if (typeof a === 'string') { for (const c of a) { t += c; etats.push(t); } }
    else if ('backspace' in a) { for (let i = 0; i < a.backspace; i++) { t = t.slice(0, -1); etats.push(t); } }
    else if ('paste' in a) { t += a.paste; etats.push(t); }
    else { t = ''; etats.push(t); }
  }
  return etats;
}

describe('L58A — lecture des montants saisis', () => {
  for (const [id, texte, attendu] of CAS) {
    it(`${id} — « ${texte} » : frappe (chaque état intermédiaire conservé), collage, validation`, () => {
      // Frappe : le texte final est exactement le texte tapé, aucun chiffre perdu.
      const etats = frappe('', [texte]);
      expect(etats.at(-1)).toBe(texte);
      expect(etats.map((e) => e.length)).toEqual([...texte].map((_, i) => i + 1));
      // Collage : un seul événement, même texte.
      expect(frappe('', [{ paste: texte }]).at(-1)).toBe(texte);
      // Validation.
      expect(parseNumberInput(texte, MONEY_INPUT)).toEqual({ ok: true, value: attendu });
      expect(parseMoneyInputToCents(texte)).toEqual({ ok: true, cents: Math.round(attendu * 100) });
      // Relecture : la valeur enregistrée réaffichée se relit à l'identique.
      expect(parseNumberInput(formatNumberForInput(attendu), MONEY_INPUT)).toEqual({ ok: true, value: attendu });
    });
  }

  it('MONTANT-07 — espaces insécables (U+00A0, U+202F de toLocaleString fr-FR) comme séparateurs de milliers', () => {
    expect(parseNumberInput('12 500,50', MONEY_INPUT)).toEqual({ ok: true, value: 12500.5 });
    expect(parseNumberInput('125 000', MONEY_INPUT)).toEqual({ ok: true, value: 125000 });
    expect(parseNumberInput((1250000.5).toLocaleString('fr-FR'), MONEY_INPUT)).toEqual({ ok: true, value: 1250000.5 });
    expect(parseNumberInput('12 500,50 €', MONEY_INPUT)).toEqual({ ok: true, value: 12500.5 });
  });

  it('MONTANT-09 — effacement puis nouvelle saisie ; correction de chiffres', () => {
    const efface = frappe('20', [{ clear: true }, '12500']);
    expect(efface[0]).toBe('');
    expect(parseNumberInput(efface[0], MONEY_INPUT)).toEqual({ ok: true, value: null });
    expect(parseNumberInput(efface.at(-1)!, MONEY_INPUT)).toEqual({ ok: true, value: 12500 });
    const corrige = frappe('', ['12600', { backspace: 3 }, '500,5']);
    expect(corrige.at(-1)).toBe('12500,5');
    expect(parseNumberInput(corrige.at(-1)!, MONEY_INPUT)).toEqual({ ok: true, value: 12500.5 });
    // Cas signalé : valeur « 2 » existante complétée → 20 000 (et non 20).
    expect(parseNumberInput(frappe('2', ['0000']).at(-1)!, MONEY_INPUT)).toEqual({ ok: true, value: 20000 });
  });

  it('MONTANT-10 — invalide ou ambigu : refus explicite, aucune valeur partielle', () => {
    for (const t of ['20.000', '12 50', '1 2500', '12a', '1.234,56', '1,234,567', '12500,', ',5', '-5', '12,345', '12..5', '++3', '12  500', '1e5']) {
      const r = parseNumberInput(t, MONEY_INPUT);
      expect(r.ok, t).toBe(false);
      expect((r as { error: string }).error.length, t).toBeGreaterThan(10);
    }
    expect(parseNumberInput('20.000', MONEY_INPUT)).toMatchObject({ ok: false, error: expect.stringContaining('ambigu') });
    expect(parseNumberInput('12,345', MONEY_INPUT)).toEqual({ ok: false, error: '2 décimales maximum.' });
    expect(parseMoneyInputToCents('20.000')).toMatchObject({ ok: false });
    // Le point décimal sans ambiguïté reste lu (valeurs déjà au format « 12500.5 »).
    expect(parseNumberInput('12500.5', MONEY_INPUT)).toEqual({ ok: true, value: 12500.5 });
  });

  it('MONTANT-11 — champs non monétaires du même composant (décimales libres, positives)', () => {
    expect(parseNumberInput('78,45', QUANTITY_INPUT)).toEqual({ ok: true, value: 78.45 });
    expect(parseNumberInput('1,125', QUANTITY_INPUT)).toEqual({ ok: true, value: 1.125 });
    expect(parseNumberInput('125 000', QUANTITY_INPUT)).toEqual({ ok: true, value: 125000 });
    expect(parseNumberInput('-1', QUANTITY_INPUT).ok).toBe(false);
    expect(parseNumberInput('-1,5', { allowNegative: true })).toEqual({ ok: true, value: -1.5 });
    expect(formatNumberForInput(78.45)).toBe('78,45');
    expect(formatNumberForInput('12500.50')).toBe('12500,5');
    expect(formatNumberForInput('illisible')).toBe('illisible');
    expect(formatNumberForInput(null)).toBe('');
    expect(stepNumberInput('12,5', 1)).toBe('13,5');
    expect(stepNumberInput('0', -1, { min: 0 })).toBe('0');
  });
});

describe('L58A — composant et formulaires', () => {
  it('MONTANT-14 — NumberInput : plus aucune mutation de input.value ni Object.defineProperty', () => {
    const src = lire('src/components/ui/number-input.tsx');
    expect(src).not.toMatch(/Object\.defineProperty/);
    expect(src).not.toMatch(/\.value\s*=[^=]/);
    expect(src).not.toMatch(/dispatchEvent|useEffect/);
  });

  it('MONTANT-15 — rendu : texte affiché tel quel, erreur explicite (desktop et mobile : même composant)', async () => {
    const { NumberInput } = await import('@/components/ui/number-input');
    const html = renderToStaticMarkup(h(NumberInput, { value: '12 500,50', onValueChange: () => undefined, parseOptions: MONEY_INPUT }));
    expect(html).toContain('value="12 500,50"');
    expect(html).toContain('inputMode="decimal"');
    expect(html).not.toContain('role="alert"');
    const ko = renderToStaticMarkup(h(NumberInput, { value: '20.000', onValueChange: () => undefined, parseOptions: MONEY_INPUT, showError: true }));
    expect(ko).toContain('role="alert"');
    expect(ko).toContain('aria-invalid="true"');
    expect(ko).toContain('ambigu');
  });

  it('MONTANT-16 — inventaire : tous les appels de NumberInput passent par onValueChange + conversion à la validation', () => {
    const appelants = [
      'src/components/assets/AssetDetailSection.tsx',
      'src/components/AssetFormDialog.tsx',
      'src/components/assets/ValuationHistoryDrawer.tsx',
      'src/components/assets/SaleDetailsDialog.tsx',
      'src/components/assets/TcoDrawer.tsx',
      'src/components/assets/DocumentDrawer.tsx',
      'src/components/documents/unified-document-dialog.tsx',
    ];
    for (const f of appelants) {
      const src = lire(f);
      const usages = src.match(/<NumberInput[\s\S]*?\/>/g) ?? [];
      expect(usages.length, f).toBeGreaterThan(0);
      for (const u of usages) {
        expect(u, f).toMatch(/onValueChange=/);
        expect(u, f).not.toMatch(/onChange=|Number\(e\.target\.value\)/);
      }
      expect(src, f).not.toMatch(/parseFloat\((editAmount|amount|formData\.purchasePriceCents)/);
    }
  });

  it('MONTANT-17 — fiche : textes résolus à l’enregistrement, invalide → aucun champ envoyé', async () => {
    const { resolveNumberTexts, numberParseOptionsFor } = await import('@/components/assets/AssetDetailSection');
    const fields = [
      { key: 'acquisitionPrice', label: 'Prix d\'achat (€)', type: 'number' as const },
      { key: 'mileage', label: 'Kilométrage', type: 'number' as const },
      { key: 'constructionYear', label: 'Année', type: 'number' as const },
    ];
    expect(numberParseOptionsFor(fields[0])).toBe(MONEY_INPUT);
    expect(numberParseOptionsFor(fields[1])).toBe(QUANTITY_INPUT);
    const form = { acquisitionPrice: 2, mileage: 10, constructionYear: 2001 };
    expect(resolveNumberTexts(fields, form, { acquisitionPrice: '12 500,50', mileage: '' })).toEqual({
      ok: true, form: { acquisitionPrice: 12500.5, mileage: null, constructionYear: 2001 },
    });
    const ko = resolveNumberTexts(fields, form, { acquisitionPrice: '20.000', mileage: '15' });
    expect(ko).toMatchObject({ ok: false, field: { key: 'acquisitionPrice' } });
    // Champ non touché : valeur d'origine (aucun envoi, lot 20).
    expect(resolveNumberTexts(fields, form, {})).toEqual({ ok: true, form });
  });

  it('MONTANT-18 — vente réalisée : même lecture, refus explicite', async () => {
    const { saleDetailsPatch } = await import('@/lib/assets/sale-fields');
    expect(saleDetailsPatch({ askPrice: true }, { date: '', price: '12 500,50' })).toEqual({ fields: { salePrice: 12500.5 } });
    expect(saleDetailsPatch({ askPrice: true }, { date: '', price: '20.000' })).toMatchObject({ error: expect.stringContaining('ambigu') });
    expect(saleDetailsPatch({ askPrice: true }, { date: '', price: '0' })).toEqual({ fields: { salePrice: 0 } });
  });
});
