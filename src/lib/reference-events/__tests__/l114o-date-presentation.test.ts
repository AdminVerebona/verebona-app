/**
 * Carte #744, point F (CDC « Opérations / Agenda V2.0 » §11 ; AC32, AC33,
 * AC35) — DATE DE PRÉSENTATION d'un événement de référence : règle pure.
 * Aucune base, aucune date du jour.
 *
 *   L114OF-U01  AC32 : intervention — premier devis faute de réalisation ; réalisation attestée ensuite ; date prévue en dernier
 *   L114OF-U02  AC33 : contrat — début initial fiable ; à défaut première couverture connue (repère) ; jamais une autre date
 *   L114OF-U03  acquisition : date réelle de l'achat seulement
 *   L114OF-U04  autres types et type non qualifié : réalisation, sinon début, sinon date prévue
 *   L114OF-U05  AC35 : sans fait daté — « sans date » ; valeur illisible ou jour inexistant : jamais une date fabriquée
 *   L114OF-U06  expression SQL engendrée depuis la MÊME table de règles
 *   L114OF-U07  une seule règle : Timeline, page et recherche la lisent ; plus aucun repli sur un élément d'agenda
 *   L114OF-U08  textes : fondement nommé seulement quand il ne vient pas d'une date propre ; jamais « Opération »
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PRESENTATION_BASIS_LABELS, PRESENTATION_DATE_BASES, PRESENTATION_DATE_RULES, UNDATED_PRESENTATION,
  presentationBasisOf, presentationDateOf, presentationDateSql, presentationDay, presentationRuleOf,
  type PresentationDateBasis, type PresentationDateFacts,
} from '../presentation-date';

const src = (rel: string) => readFileSync(join(process.cwd(), 'src', rel), 'utf8');
const faits = (over: Partial<PresentationDateFacts>): PresentationDateFacts => ({
  typeCode: null, realizedDate: null, firstQuoteDate: null, startDate: null, firstCoverageStart: null, plannedDate: null, ...over,
});

describe('#744 point F — date de présentation d’un événement de référence (CDC §11)', () => {
  it('L114OF-U01 — intervention : premier devis faute de réalisation, réalisation attestée ensuite (AC32)', () => {
    // Devis du 10 mars ; une visite prévue le 20 mars ne déplace pas le repère.
    expect(presentationDateOf(faits({ typeCode: 'INTERVENTION', firstQuoteDate: '2025-03-10', plannedDate: '2025-03-20' })))
      .toEqual({ date: '2025-03-10', basis: 'FIRST_QUOTE' });
    // Réalisation attestée le 15 avril : elle devient le repère ; le devis garde sa date ailleurs.
    expect(presentationDateOf(faits({ typeCode: 'INTERVENTION', firstQuoteDate: '2025-03-10', plannedDate: '2025-03-20', realizedDate: '2025-04-15' })))
      .toEqual({ date: '2025-04-15', basis: 'REALIZED' });
    // Ni réalisation ni devis : la date prévue de l'intervention.
    expect(presentationDateOf(faits({ typeCode: 'INTERVENTION', plannedDate: '2031-09-01' }))).toEqual({ date: '2031-09-01', basis: 'PLANNED' });
    // Un début ou une couverture ne sont pas des faits d'intervention.
    expect(presentationDateOf(faits({ typeCode: 'INTERVENTION', startDate: '2025-01-01', firstCoverageStart: '2025-01-01' }))).toEqual(UNDATED_PRESENTATION);
  });

  it('L114OF-U02 — contrat : début initial ; à défaut première couverture connue, comme repère (AC33)', () => {
    expect(presentationDateOf(faits({ typeCode: 'CONTRACT', startDate: '2019-06-01', firstCoverageStart: '2024-01-01' })))
      .toEqual({ date: '2019-06-01', basis: 'START' });
    expect(presentationDateOf(faits({ typeCode: 'CONTRACT', firstCoverageStart: '2024-01-01' })))
      .toEqual({ date: '2024-01-01', basis: 'FIRST_COVERAGE' });
    // Une échéance future (date prévue), un devis ou une réalisation ne datent jamais un contrat.
    expect(presentationDateOf(faits({ typeCode: 'CONTRACT', plannedDate: '2030-01-01', firstQuoteDate: '2018-01-01', realizedDate: '2018-02-01' })))
      .toEqual(UNDATED_PRESENTATION);
    // Le repère « couverture » ne produit rien d'autre qu'un repère : la fonction ne rend aucun début.
    expect(Object.keys(presentationDateOf(faits({ typeCode: 'CONTRACT', firstCoverageStart: '2024-01-01' }))).sort()).toEqual(['basis', 'date']);
  });

  it('L114OF-U03 — acquisition : date réelle de l’achat seulement', () => {
    expect(presentationDateOf(faits({ typeCode: 'ACQUISITION', realizedDate: '2020-01-02', plannedDate: '2019-12-01' }))).toEqual({ date: '2020-01-02', basis: 'REALIZED' });
    expect(presentationDateOf(faits({ typeCode: 'ACQUISITION', plannedDate: '2019-12-01', firstQuoteDate: '2019-11-01', startDate: '2019-10-01' }))).toEqual(UNDATED_PRESENTATION);
  });

  it('L114OF-U04 — autres types et type non qualifié : réalisation, sinon début, sinon date prévue', () => {
    for (const typeCode of ['FINANCING', 'CLAIM', 'DISPOSAL', 'OTHER', null, 'INCONNU']) {
      expect(presentationRuleOf(typeCode)).toBe(PRESENTATION_DATE_RULES.DEFAULT);
      expect(presentationDateOf(faits({ typeCode, realizedDate: '2022-05-05', startDate: '2022-01-01', plannedDate: '2021-01-01' }))).toEqual({ date: '2022-05-05', basis: 'REALIZED' });
      expect(presentationDateOf(faits({ typeCode, startDate: '2022-01-01', plannedDate: '2021-01-01' }))).toEqual({ date: '2022-01-01', basis: 'START' });
      expect(presentationDateOf(faits({ typeCode, plannedDate: '2021-01-01' }))).toEqual({ date: '2021-01-01', basis: 'PLANNED' });
      // Un devis ou une couverture ne datent pas ces types.
      expect(presentationDateOf(faits({ typeCode, firstQuoteDate: '2020-01-01', firstCoverageStart: '2020-01-01' }))).toEqual(UNDATED_PRESENTATION);
    }
  });

  it('L114OF-U05 — sans fait daté : « sans date » ; jamais une date fabriquée (AC35)', () => {
    for (const typeCode of ['INTERVENTION', 'CONTRACT', 'ACQUISITION', 'FINANCING', 'CLAIM', 'DISPOSAL', 'OTHER', null]) {
      expect(presentationDateOf(faits({ typeCode }))).toEqual({ date: null, basis: null });
    }
    expect(presentationDay('2024-02-29T10:00:00Z')).toBe('2024-02-29');
    for (const v of ['2024-02-31', '2023-02-29', '2024-13-01', '2024', '2024-05', 'demain', '', null, undefined, 20240101, new Date(0)]) {
      expect(presentationDay(v), String(v)).toBeNull();
    }
    // Une valeur illisible n'est pas retenue : on passe au fait suivant, sinon « sans date ».
    expect(presentationDateOf(faits({ typeCode: 'INTERVENTION', realizedDate: '2024-02-31', firstQuoteDate: '2024-02-10' }))).toEqual({ date: '2024-02-10', basis: 'FIRST_QUOTE' });
    expect(presentationDateOf(faits({ typeCode: 'ACQUISITION', realizedDate: 'inconnue' }))).toEqual(UNDATED_PRESENTATION);
    expect(presentationBasisOf('FIRST_QUOTE')).toBe('FIRST_QUOTE');
    for (const v of ['FIRST_EVENT', 'REFERENCE_EVENT', '', null, 3]) expect(presentationBasisOf(v)).toBeNull();
    // La règle ne lit ni l'horloge ni un horodatage système.
    const code = src('lib/reference-events/presentation-date.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/Date\.now|new Date\(\)|created_at|updated_at|agenda/i);
  });

  it('L114OF-U06 — l’expression SQL est engendrée depuis la même table de règles', () => {
    const cols = Object.fromEntries(PRESENTATION_DATE_BASES.map((b) => [b, `f.${b.toLowerCase()}`])) as Record<PresentationDateBasis, string>;
    const e = presentationDateSql('f.type', cols);
    const liste = (r: readonly PresentationDateBasis[]) => r.map((b) => cols[b]).join(', ');
    expect(e.date).toBe(
      `CASE WHEN f.type = 'INTERVENTION' THEN COALESCE(${liste(PRESENTATION_DATE_RULES.INTERVENTION)}) `
      + `WHEN f.type = 'CONTRACT' THEN COALESCE(${liste(PRESENTATION_DATE_RULES.CONTRACT)}) `
      // Règle remplacée (carte #813) : ACQUISITION = réalisation, sinon date de commande (deux faits → COALESCE).
      + `WHEN f.type = 'ACQUISITION' THEN COALESCE(${liste(PRESENTATION_DATE_RULES.ACQUISITION)}) `
      + `ELSE COALESCE(${liste(PRESENTATION_DATE_RULES.DEFAULT)}) END`);
    expect(e.basis).toContain(`WHEN f.type = 'CONTRACT' THEN CASE WHEN f.start IS NOT NULL THEN 'START' WHEN f.first_coverage IS NOT NULL THEN 'FIRST_COVERAGE' END`);
    expect(e.basis).toContain(`ELSE CASE WHEN f.realized IS NOT NULL THEN 'REALIZED' WHEN f.start IS NOT NULL THEN 'START' WHEN f.planned IS NOT NULL THEN 'PLANNED' END END`);
    // Chaque fondement cité par une règle existe ; chaque règle est une liste sans doublon.
    for (const r of Object.values(PRESENTATION_DATE_RULES)) {
      expect(r.length).toBeGreaterThan(0);
      expect(new Set(r).size).toBe(r.length);
      for (const b of r) expect(PRESENTATION_DATE_BASES).toContain(b);
    }
  });

  it('L114OF-U07 — une seule règle pour la Timeline, la page et la recherche ; aucun repli sur un élément d’agenda', () => {
    const timeline = src('services/agenda/timeline/read.ts');
    expect(timeline).toContain("${presentationScalarSql('x.op')}");
    // Règle remplacée (carte #744) : plus de « date propre, sinon plus ancien élément d'agenda lié ».
    expect(timeline).not.toMatch(/own_d|event_d|FIRST_EVENT|COALESCE\(bo\.realized_date/);
    const lecture = src('services/business-operations/graph/presentation-date.ts');
    expect(lecture).toContain('presentationDateSql(');
    expect(lecture).toContain('presentationDateOf(');
    // Faits bornés au compte, jamais une date d'élément d'agenda ni un horodatage.
    expect(lecture.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/agenda_items|created_at|updated_at|now\(\)/i);
    for (const table of ['business_operation_sources pds', 'asset_files pdf', 'business_operation_documents pdd', 'document_business_periods pdp']) {
      expect(lecture).toContain(table);
    }
    expect(lecture.match(/account_id = \$\{acc\}/g)!.length).toBeGreaterThanOrEqual(4);
    const page = src('services/business-operations/graph/reference-event-page.ts');
    expect(page).toContain('ownDate: presentation.date');
    expect(page).not.toContain('day(r.realized_date) ?? day(r.start_date) ?? day(r.planned_date)');
    expect(page).toContain('presentationFactColumnsSql(\'o\')');
    expect(src('services/search/global-search.service.ts')).toContain('${REFERENCE_EVENT_SEARCH_SQL.presentationFacts}');
  });

  it('L114OF-U08 — textes : fondement nommé seulement hors date propre ; jamais « Opération »', () => {
    // Règle remplacée (carte #813) : nouveau fondement « Date de commande » (bon de commande d'un achat).
    expect(PRESENTATION_BASIS_LABELS).toEqual({ REALIZED: null, START: null, PLANNED: null, FIRST_QUOTE: 'Premier devis', FIRST_COVERAGE: 'Première couverture connue', FIRST_ORDER: 'Date de commande' });
    expect(Object.values(PRESENTATION_BASIS_LABELS).join(' ')).not.toMatch(/op[ée]ration/i);
  });
});
