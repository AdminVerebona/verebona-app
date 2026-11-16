/**
 * « Prochaines échéances » (prototype Direction D v2, décision produit) :
 * ordre, couleur, bornes, état vide.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { MAX_UPCOMING, deriveUpcoming, relativeDue, upcomingAccessibleName, type UpcomingRow } from '../home-blocks';

const TODAY = '2026-09-21';
const row = (id: number, date: string, extra: Partial<UpcomingRow> = {}): UpcomingRow =>
  ({ id, title: `E${id}`, date, assetName: 'Ferrari', forecast: false, action: true, ...extra });

describe('dérivation', () => {
  // #715 : plus de statut d'événement — une date passée n'est plus « en retard » : à venir seulement.
  it('à venir seulement, par date croissante (une date passée n’apparaît pas)', () => {
    const r = deriveUpcoming([row(1, '2026-12-15'), row(2, '2026-10-12'), row(3, '2026-09-19'), row(4, '2027-08-28')], TODAY);
    expect(r.map((x) => x.id)).toEqual([2, 1, 4]);
  });

  it('couleur : amber à moins de 30 jours, vert plus tard ; jamais rouge « en retard » (#715)', () => {
    const r = deriveUpcoming([row(1, '2026-09-19'), row(2, TODAY), row(3, '2026-10-21'), row(4, '2026-10-22')], TODAY);
    expect(r.map((x) => x.tone)).toEqual(['amber', 'amber', 'green']);
    expect(r[0]).toMatchObject({ rel: 'Aujourd’hui', day: '21', month: 'sept.' });
    expect(JSON.stringify(r)).not.toMatch(/En retard/);
  });

  it('une information, une prévision ou une action passées ne sont jamais « en retard » (#715)', () => {
    const r = deriveUpcoming([
      row(1, '2026-09-10', { action: false }),
      row(2, '2026-09-10', { forecast: true }),
      row(3, '2026-07-01'),
      row(4, '2026-09-20'),
    ], TODAY);
    expect(r.map((x) => x.id)).toEqual([]);
  });

  it('une prévision à venir est dite estimée', () => {
    expect(deriveUpcoming([row(1, '2026-12-21', { forecast: true })], TODAY)[0].rel).toBe('Dans 3 mois (estimée)');
  });

  it('bornée à 5, vide sans échéance', () => {
    const many = Array.from({ length: 9 }, (_, i) => row(i + 1, `2026-10-${String(10 + i).padStart(2, '0')}`));
    expect(deriveUpcoming(many, TODAY)).toHaveLength(MAX_UPCOMING);
    expect(deriveUpcoming([], TODAY)).toEqual([]);
  });

  // Règle remplacée (carte #752) : `relativeDue` ne prend plus un nombre de
  // jours arrondi (30 jours = 1 mois, 12 à 17 mois = « Dans 1 an »,
  // 18 mois et plus = « Dans N ans »), mais DEUX jours civils, et calcule un
  // écart calendaire. L'ancien `relativeDue(400) === 'Dans 1 an'` était faux :
  // 400 jours depuis le 21/09/2026 font 1 an et 1 mois.
  it('délais lisibles, calculés sur le calendrier', () => {
    expect(relativeDue(TODAY, '2026-09-22')).toBe('Demain');
    expect(relativeDue(TODAY, '2026-09-26')).toBe('Dans 5 jours');
    expect(relativeDue(TODAY, '2026-10-12')).toBe('Dans 3 semaines');
    expect(relativeDue(TODAY, '2027-08-21')).toBe('Dans 11 mois');
    expect(relativeDue(TODAY, '2027-09-21')).toBe('Dans 1 an');
    expect(relativeDue(TODAY, '2027-10-26')).toBe('Dans 1 an et 1 mois'); // 400 jours
  });

  // ── Carte #752 — l'accueil : délai juste, année visible, nom accessible ──

  it('#752 — l’événement de la capture iOS : « Dans 1 an et 5 mois », jamais « Dans 1 an » ni « Dans 2 ans »', () => {
    const r = deriveUpcoming([
      row(1, '2028-04-18', { title: 'Prochain contrôle technique', assetName: 'CUPRA LEON E-HYBRID180' }),
      row(2, '2028-04-20', { title: 'Prochain contrôle technique (voisin)' }),
    ], '2026-11-12');
    expect(r.map((x) => x.rel)).toEqual(['Dans 1 an et 5 mois', 'Dans 1 an et 5 mois']);
    expect(JSON.stringify(r)).not.toMatch(/Dans 1 an"|Dans 2 ans/);
  });

  it('#752 — la pastille n’a pas l’année, mais la ligne la porte quand elle est nécessaire, et le nom accessible toujours', () => {
    const [loin, proche] = deriveUpcoming([
      row(1, '2028-04-18', { title: 'Contrôle technique', assetName: 'Cupra' }),
      row(2, '2026-10-12', { title: 'Révision', assetName: 'Ferrari' }),
    ], '2026-09-21');
    // Autre année civile : l'année est écrite à côté de la pastille.
    expect(loin).toMatchObject({ day: '12', month: 'oct.', dateWithYear: null, dateFull: '12 octobre 2026' });
    expect(proche).toMatchObject({ day: '18', month: 'avr.', dateWithYear: '18 avr. 2028', dateFull: '18 avril 2028' });
    // Nom accessible : événement, bien, date complète AVEC l'année, délai.
    expect(upcomingAccessibleName(proche)).toBe('Contrôle technique — Cupra — 18 avril 2028 — Dans 1 an et 7 mois');
    expect(upcomingAccessibleName(loin)).toBe('Révision — Ferrari — 12 octobre 2026 — Dans 3 semaines');
  });

  it('#752 — sans bien : le nom accessible garde l’événement, la date complète et le délai', () => {
    const [e] = deriveUpcoming([row(1, '2027-01-04', { title: 'Fin de garantie', assetName: null })], '2026-12-31');
    expect(e).toMatchObject({ dateWithYear: '4 janv. 2027', dateFull: '4 janvier 2027', rel: 'Dans 4 jours' });
    expect(upcomingAccessibleName(e)).toBe('Fin de garantie — 4 janvier 2027 — Dans 4 jours');
  });

  it('#752 — une prévision lointaine garde « (estimée) » après un délai à plusieurs termes', () => {
    expect(deriveUpcoming([row(1, '2028-04-18', { forecast: true })], '2026-11-12')[0].rel)
      .toBe('Dans 1 an et 5 mois (estimée)');
  });

  it('#752 — aucune date inventée : une date illisible n’apparaît pas sur l’accueil', () => {
    expect(deriveUpcoming([row(1, 'bientôt'), row(2, '2027-02-30')], TODAY)).toEqual([]);
  });

  it('#752 — le jour de référence de l’accueil est le jour civil de l’utilisateur, pas le jour UTC', () => {
    const svc = readFileSync(join(process.cwd(), 'src/services/home/HomeSummaryService.ts'), 'utf8');
    // Règle remplacée (carte #752) : plus de `new Date().toISOString()` pour dater l'accueil.
    expect(svc).toMatch(/function todayStr\(\): string \{\s*return todayIn\(\);/);
    expect(svc).not.toMatch(/new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/);
  });

  it('#752 — l’interface : délai non forcé sur une ligne, largeur bornée, nom accessible sur le bouton', () => {
    const ui = readFileSync(join(process.cwd(), 'src/components/home/HomeBlocks.tsx'), 'utf8');
    // Règle remplacée (carte #752) : le délai n'est plus `whitespace-nowrap` (« Dans 1 an et 5 mois » déborderait).
    expect(ui).toMatch(/max-w-\[6\.5rem\] flex-shrink-0 text-right text-\[12px\] font-bold md:max-w-\[9\.5rem\]/);
    expect(ui).toContain('aria-label={upcomingAccessibleName(e)}');
    expect(ui).toContain("{[e.assetName, e.dateWithYear].filter(Boolean).join(' · ')}");
    // La pastille partagée n'est ni agrandie ni changée pour les autres écrans.
    expect(ui).toContain('<DateChip day={e.day} month={e.month} tone={tone} />');
  });

  it('le résumé expose le bloc, sur les échéances actives du compte', () => {
    const svc = readFileSync(join(process.cwd(), 'src/services/home/HomeSummaryService.ts'), 'utf8');
    // Règle remplacée (carte #742) : le bloc porte aussi le groupe « À prévoir » (événements ouverts sans date).
    expect(svc).toMatch(/upcoming: \{ items: upcoming, toPlan \}/);
    // #715 : plus de filtre sur un statut d'événement.
    expect(svc).toMatch(/eq\(agendaItems\.accountId, accountId\)/);
    expect(svc).not.toMatch(/agendaItems\.manualStatus/);
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
