/**
 * « Prochaines échéances » (prototype Direction D v2, décision produit) :
 * ordre, couleur, bornes, état vide.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { MAX_UPCOMING, deriveUpcoming, relativeDue, type UpcomingRow } from '../home-blocks';

const TODAY = '2026-09-21';
const row = (id: number, date: string, extra: Partial<UpcomingRow> = {}): UpcomingRow =>
  ({ id, title: `E${id}`, date, assetName: 'Ferrari', forecast: false, action: true, ...extra });

describe('dérivation', () => {
  it('en retard d’abord, puis à venir, par date croissante', () => {
    const r = deriveUpcoming([row(1, '2026-12-15'), row(2, '2026-10-12'), row(3, '2026-09-19'), row(4, '2027-08-28')], TODAY);
    expect(r.map((x) => x.id)).toEqual([3, 2, 1, 4]);
  });

  it('couleur : rouge en retard, amber à moins de 30 jours, vert plus tard', () => {
    const r = deriveUpcoming([row(1, '2026-09-19'), row(2, TODAY), row(3, '2026-10-21'), row(4, '2026-10-22')], TODAY);
    expect(r.map((x) => x.tone)).toEqual(['red', 'amber', 'amber', 'green']);
    expect(r[0]).toMatchObject({ rel: 'En retard (2 j)', day: '19', month: 'sept.' });
    expect(r[1].rel).toBe('Aujourd’hui');
  });

  it('une information passée ou une prévision passée n’est pas « en retard » ; au-delà de 60 jours, non plus', () => {
    const r = deriveUpcoming([
      row(1, '2026-09-10', { action: false }),
      row(2, '2026-09-10', { forecast: true }),
      row(3, '2026-07-01'),
      row(4, '2026-09-20'),
    ], TODAY);
    expect(r.map((x) => x.id)).toEqual([4]);
  });

  it('une prévision à venir est dite estimée', () => {
    expect(deriveUpcoming([row(1, '2026-12-21', { forecast: true })], TODAY)[0].rel).toBe('Dans 3 mois (estimée)');
  });

  it('bornée à 5, vide sans échéance', () => {
    const many = Array.from({ length: 9 }, (_, i) => row(i + 1, `2026-10-${String(10 + i).padStart(2, '0')}`));
    expect(deriveUpcoming(many, TODAY)).toHaveLength(MAX_UPCOMING);
    expect(deriveUpcoming([], TODAY)).toEqual([]);
  });

  it('délais lisibles', () => {
    expect(relativeDue(1)).toBe('Demain');
    expect(relativeDue(5)).toBe('Dans 5 jours');
    expect(relativeDue(21)).toBe('Dans 3 semaines');
    expect(relativeDue(340)).toBe('Dans 11 mois');
    expect(relativeDue(400)).toBe('Dans 1 an');
  });

  it('le résumé expose le bloc, sur les échéances actives du compte', () => {
    const svc = readFileSync(join(process.cwd(), 'src/services/home/HomeSummaryService.ts'), 'utf8');
    expect(svc).toMatch(/upcoming: \{ items: upcoming \}/);
    expect(svc).toMatch(/eq\(agendaItems\.accountId, accountId\),\s*or\(isNull\(agendaItems\.manualStatus\)/);
  });

  // Lot 36 (maquette 2a/2b « Fil encadré ») : plus de paire côte à côte ni
  // d'ordre CSS qui diffère selon la largeur — une seule colonne, le même
  // ordre partout (remplace l'assertion du lot 8c sur `@container`).
  it('accueil (lot 36) : Mes biens, Prochaines échéances, Ce que j’ai fait, Documents récents — une colonne, même ordre desktop et mobile', () => {
    const page = readFileSync(join(process.cwd(), 'src/app/(dashboard)/accueil/page.tsx'), 'utf8');
    const i = (s: string) => page.indexOf(s);
    expect(i('<HomeAssets')).toBeGreaterThan(-1);
    expect(i('<HomeAssets')).toBeLessThan(i('<UpcomingEvents'));
    expect(i('<UpcomingEvents')).toBeLessThan(i('<VerebonaWork'));
    expect(i('<VerebonaWork')).toBeLessThan(i('<RecentDocuments'));
    expect(page).not.toMatch(/@container|@min-\[1040px\]|order-1|order-2/);
  });
});
