/**
 * Lot 114V (Trello #742) — « À traiter », écriture, accueil, Assistant et
 * migration : règles pures (aucune base, aucune date du jour).
 *
 *   R  admissibilité DATA-AGENDA-DATE : jamais de carte au seul motif d'une
 *      date nulle pour un événement QUALIFIÉ ; élément hérité ambigu : carte
 *      de qualification NEUTRE ; fait établi : question de date conservée ;
 *   E  valeurs écrites (chemin manuel seulement, parité sans situation) ;
 *   H  groupe « À prévoir » de l'accueil (borné, total) et échéances datées ;
 *   A  Assistant : formulations sans date et question de réalisation ;
 *   M  migration 1730 : additive, idempotente, aucune date écrite ;
 *   N  rappels : « A eu lieu » exclu des rappels d'échéance.
 * Le parcours sur PostgreSQL réel est couvert par
 * `src/test/e2e/scenarios/l114v-evenements-a-prevoir.e2e.ts`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: {} }));

const prod = await import('../producers.service');
const { agendaItemValues } = await import('@/services/agenda/agenda-write-primitive');
const { manualUpsertInput } = await import('@/services/agenda/AgendaWriteService');
const { deriveToPlan, deriveUpcoming, MAX_TO_PLAN } = await import('@/services/home/home-blocks');
const { agendaTargetAnswer } = await import('@/services/verebona-assistant/core/target-answer');
const { isUpcomingDeadlineCandidate } = await import('@/services/agenda/AgendaQueryService');
const { SITUATION_QUESTION } = await import('@/lib/agenda/situation');

const lire = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n?/g, '\n');

const evt = (p: Partial<import('../producers.service').AgendaDateFacts>) => ({
  homeCategory: null, originType: 'manual', isAutomatic: false, isAutomaticModified: false, requiresQualification: false,
  createdAt: '2026-01-01T00:00:00Z', sourceDate: null, ...p,
});

describe('L114V-R — « À traiter » : qualification seulement quand elle est utile', () => {
  it('L114V-R1 — « À prévoir » sans date : AUCUNE carte (motif SITUATION_QUALIFIED), même catégorie « action », même événement principal', () => {
    const d = prod.agendaDateAdmissibility(evt({ situation: 'A_PREVOIR' }));
    expect(d).toMatchObject({ outcome: 'NO_ACTION', decisive: 'neededForUse', reason: 'SITUATION_QUALIFIED' });
    expect(prod.SITUATION_QUALIFIED_REASON).toBe('SITUATION_QUALIFIED');
    expect(prod.agendaDateAdmissibility(evt({ situation: 'A_PREVOIR', homeCategory: 'action' })).outcome).toBe('NO_ACTION');
    expect(prod.agendaDateAdmissibility(evt({ situation: 'A_PREVOIR', operationPrincipal: true })).outcome).toBe('NO_ACTION');
  });

  it('L114V-R2 — « A eu lieu » sans date : AUCUNE carte de complétion (date inconnue acceptée)', () => {
    expect(prod.agendaDateAdmissibility(evt({ situation: 'A_EU_LIEU' }))).toMatchObject({ outcome: 'NO_ACTION', reason: 'SITUATION_QUALIFIED' });
    expect(prod.agendaDateAdmissibility(evt({ situation: 'A_EU_LIEU', homeCategory: 'action', originType: 'qualified_document', isAutomatic: true, isAutomaticModified: true })).outcome).toBe('NO_ACTION');
  });

  it('L114V-R3 — qualification T4 récente d’un élément qualifié : NO_ACTION (jamais DEFER qui maintiendrait une carte)', () => {
    expect(prod.agendaDateAdmissibility(evt({ situation: 'A_PREVOIR', requiresQualification: true, createdAt: '2026-11-13T00:00:00Z' }), new Date('2026-11-14T10:00:00Z')).outcome).toBe('NO_ACTION');
  });

  it('L114V-R4 — élément HÉRITÉ non qualifié : conditions antérieures inchangées (décision 72C, catégorie, différé) ; une valeur inconnue ne qualifie rien', () => {
    expect(prod.agendaDateAdmissibility(evt({ situation: null })).outcome).toBe('CREATE_ACTION');
    expect(prod.agendaDateAdmissibility(evt({})).outcome).toBe('CREATE_ACTION');
    expect(prod.agendaDateAdmissibility(evt({ situation: 'realise' })).outcome).toBe('CREATE_ACTION');
    expect(prod.agendaDateAdmissibility(evt({ originType: 'qualified_document', isAutomatic: true })).outcome).toBe('DEFER');
    expect(prod.agendaDateAdmissibility(evt({ originType: 'qualified_document', isAutomatic: true, homeCategory: 'information' })).outcome).toBe('NO_ACTION');
  });

  it('L114V-R5 — « Sans échéance » (lot 77A) garde son motif propre', () => {
    expect(prod.agendaDateAdmissibility(evt({ noDeadline: true, situation: 'A_PREVOIR' })).reason).toBe('NO_DEADLINE_BY_USER');
  });

  it('L114V-R6 — question : NEUTRE pour un élément ambigu (texte exact, sans titre ni présupposé) ; question de date conservée pour un fait établi', () => {
    expect(prod.agendaDateQuestion({ title: 'Entretien pompe à chaleur' })).toBe('Cet événement est-il à prévoir ou a-t-il déjà eu lieu ?');
    expect(prod.agendaDateQuestion({ title: 'Entretien pompe à chaleur', eventNature: 'DEADLINE' })).toBe(SITUATION_QUESTION);
    expect(prod.agendaDateQuestion({ title: 'Entretien pompe à chaleur' })).not.toMatch(/quelle date/i);
    // Fait établi par les données (achat, événement principal d'un événement de référence) : seule la date manque.
    expect(prod.agendaDateQuestion({ title: 'Achat Clio', eventNature: 'HISTORICAL' })).toBe('À quelle date « Achat Clio » a-t-il lieu ?');
    expect(prod.agendaDateQuestion({ title: 'Achat Clio', operationPrincipal: true })).toBe('À quelle date « Achat Clio » a-t-il lieu ?');
  });

  it('L114V-R7 — pertinence : une carte de date n’a plus d’intérêt dès que la situation est qualifiée (création, conservation, campagne) ; la date retrouvée à la source n’est jamais écrite sur un élément qualifié', () => {
    expect(lire('src/services/to-process/publishability.ts')).toContain('i.start_date IS NOT NULL OR i.no_deadline = true OR i.situation IS NOT NULL');
    expect(lire('src/services/to-process/producers.service.ts')).toContain('AND no_deadline = false AND situation IS NULL');
  });
});

describe('L114V-E — valeurs écrites (chemin manuel seulement)', () => {
  it('L114V-E1 — création : situation, provenance et date de décision écrites ; sans situation, parité des valeurs antérieures', () => {
    const avec = agendaItemValues(manualUpsertInput({ title: 'Entretien pompe à chaleur', situation: 'A_PREVOIR', situationSource: 'DEFAULT' }, 1, 2, null));
    expect(avec).toMatchObject({ situation: 'A_PREVOIR', situationSource: 'DEFAULT', startDate: null });
    expect(avec.situationDecidedAt).toBeInstanceOf(Date);
    const sans = agendaItemValues(manualUpsertInput({ title: 'Entretien pompe à chaleur' }, 1, 2, null));
    for (const k of ['situation', 'situationSource', 'situationDecidedAt']) expect(sans).not.toHaveProperty(k);
  });

  it('L114V-E2 — modification : écrite par le chemin MANUEL ; un traitement automatique (T4, projection) ne la pose ni ne l’efface jamais', () => {
    const manuel = agendaItemValues({ itemId: 9, accountId: 1, assetId: null, origin: 'MANUAL', details: { situation: 'A_EU_LIEU', situationSource: 'USER' } });
    expect(manuel).toMatchObject({ situation: 'A_EU_LIEU', situationSource: 'USER' });
    const auto = agendaItemValues({ itemId: 9, accountId: 1, assetId: null, origin: 'AUTOMATIC', title: 'Entretien', date: '2027-01-01', details: { situation: 'A_EU_LIEU' } });
    for (const k of ['situation', 'situationSource', 'situationDecidedAt']) expect(auto).not.toHaveProperty(k);
    const creationAuto = agendaItemValues({ accountId: 1, assetId: 3, origin: 'AUTOMATIC', title: 'Entretien', date: null, details: { situation: 'A_PREVOIR' } });
    expect(creationAuto).not.toHaveProperty('situation');
  });

  it('L114V-E3 — routes : la situation passe par le service ; la provenance n’est jamais lue du client ; modification sans qualifier → non transmise', () => {
    expect(lire('src/app/api/agenda/route.ts')).toMatch(/equipmentIds, noDeadline, situation \},\s*accountId/);
    expect(lire('src/app/api/agenda/[id]/route.ts')).toContain("delete (body as Record<string, unknown>).situationSource;");
    expect(lire('src/components/agenda/AgendaItemDrawer.tsx')).toContain('...(editSituation ? { situation: editSituation } : {}),');
  });
});

describe('L114V-H — accueil « Prochaines échéances »', () => {
  const lignes = Array.from({ length: 5 }, (_, i) => ({ id: i + 1, title: `Événement ${i + 1}`, assetName: i === 0 ? 'Maison' : null }));

  it('L114V-H1 — groupe « À prévoir » borné, total jamais tronqué (accès à la liste complète)', () => {
    const g = deriveToPlan(lignes, 12);
    expect(g.items).toHaveLength(MAX_TO_PLAN);
    expect(g.items[0]).toEqual({ id: 1, title: 'Événement 1', assetName: 'Maison' });
    expect(g.total).toBe(12);
    expect(deriveToPlan([], 0)).toEqual({ items: [], total: 0 });
    expect(deriveToPlan(lignes.slice(0, 2), 0).total).toBe(2);
    // Aucune date, aucun délai, aucun ton d'urgence sur ces lignes.
    for (const k of ['date', 'rel', 'tone', 'day', 'month']) expect(g.items[0]).not.toHaveProperty(k);
  });

  it('L114V-H2 — les échéances datées gardent leur dérivation ; un événement sans date n’y entre jamais (ni « Aujourd’hui », ni « Demain »)', () => {
    const datees = deriveUpcoming([{ id: 7, title: 'Contrôle technique', date: '2026-11-20', assetName: 'Clio', forecast: false, action: true }], '2026-11-14');
    expect(datees).toEqual([expect.objectContaining({ id: 7, rel: 'Dans 6 jours' })]);
    const svc = lire('src/services/home/HomeSummaryService.ts');
    expect(svc).toContain("isNull(agendaItems.startDate), eq(agendaItems.situation, 'A_PREVOIR')");
    expect(svc).toContain('.filter((i) => !!i.startDate && isUpcomingBySituation(i))');
    expect(svc).toMatch(/const conditionAPrevoir = and\(eq\(agendaItems\.accountId, accountId\)/);
  });

  it('L114V-H3 — un événement « A eu lieu » n’est jamais une échéance à venir (accueil, Assistant) ; non qualifié : inchangé', () => {
    expect(isUpcomingDeadlineCandidate({ eventNature: 'DEADLINE', situation: 'A_EU_LIEU' })).toBe(false);
    expect(isUpcomingDeadlineCandidate({ eventNature: 'DEADLINE', situation: 'A_PREVOIR' })).toBe(true);
    expect(isUpcomingDeadlineCandidate({ eventNature: null })).toBe(true);
    expect(isUpcomingDeadlineCandidate({ eventNature: 'HISTORICAL' })).toBe(false);
  });
});

describe('L114V-A — Assistant : « À prévoir » / « A eu lieu », y compris sans date', () => {
  const TODAY = '2026-11-14';
  const item = (p: Partial<import('@/services/verebona-assistant/canonical/agenda').CanonicalAgendaItem>) => ({
    id: 5, title: 'Entretien pompe à chaleur', date: null, nature: 'DEADLINE' as const, businessType: null, forecast: false,
    category: 'action', isAutomatic: false, userModified: false, assets: [{ assetId: 1, name: 'Maison' }], sources: [], ...p,
  });

  it('L114V-A1 — sans date : « à prévoir » ou « a eu lieu, date inconnue » — aucune date inventée, jamais « a-t-il eu lieu ? »', () => {
    const aPrevoir = agendaTargetAnswer(item({ situation: 'A_PREVOIR' }), 'date', TODAY).text;
    expect(aPrevoir).toBe('« Entretien pompe à chaleur » est à prévoir : aucune date n’est encore fixée.');
    const eu = agendaTargetAnswer(item({ situation: 'A_EU_LIEU' }), 'date', TODAY).text;
    expect(eu).toBe('« Entretien pompe à chaleur » a eu lieu ; sa date n’est pas connue.');
    for (const t of [aPrevoir, eu]) { expect(t).not.toMatch(/\d{4}/); expect(t).not.toContain('?'); }
    expect(agendaTargetAnswer(item({ situation: 'A_PREVOIR' }), 'status', TODAY).text).toBe(aPrevoir);
  });

  it('L114V-A2 — question de réalisation : le CHOIX de l’utilisateur est rapporté ; une date passée ne prouve rien pour « À prévoir »', () => {
    expect(agendaTargetAnswer(item({ situation: 'A_EU_LIEU', date: '2026-03-02' }), 'status', TODAY).text).toMatch(/Vous avez indiqué que cet événement a eu lieu\.$/);
    const passe = agendaTargetAnswer(item({ situation: 'A_PREVOIR', date: '2026-03-02' }), 'status', TODAY).text;
    expect(passe).toMatch(/Vous avez indiqué que cet événement reste à prévoir\.$/);
    expect(passe).not.toMatch(/a eu lieu|réalisé/);
  });

  it('L114V-A3 — non qualifié : formulations du lot 113P inchangées', () => {
    expect(agendaTargetAnswer(item({}), 'date', TODAY).text).toBe('Aucune date n’est enregistrée pour « Entretien pompe à chaleur ».');
    expect(agendaTargetAnswer(item({ date: '2026-11-20' }), 'status', TODAY).text).toMatch(/L’agenda situe l’événement dans le temps, sans indiquer s’il a été réalisé\.$/);
  });

  it('L114V-A4 — création sans date depuis l’Assistant : annoncée « À prévoir » (plus « Sans date »), sans texte de prompt modifié', () => {
    const plan = lire('src/services/verebona-assistant/commands/plan.service.ts');
    expect(plan).toContain('undatedLabel({ noDeadline: draft.noDeadline, situation: DEFAULT_NEW_SITUATION })');
  });
});

describe('L114V-M — migration 1730 (reprise prudente, rejouable)', () => {
  const sqlMigration = lire('src/db/migrations/1730_l114v_agenda_situation.sql');
  const instructions = sqlMigration.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

  it('L114V-M1 — additive et idempotente : colonnes IF NOT EXISTS, contraintes créées si absentes, aucune suppression', () => {
    expect(instructions.match(/ADD COLUMN IF NOT EXISTS/g)).toHaveLength(3);
    expect(instructions).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_constraint WHERE conname = 'agenda_items_situation_check'\)/);
    expect(instructions).not.toMatch(/\bDROP\b|\bDELETE\b|\bTRUNCATE\b/i);
    expect(instructions).toContain("situation IN ('A_PREVOIR', 'A_EU_LIEU')");
  });

  it('L114V-M2 — seuls les éléments NON qualifiés sont repris ; aucune date n’est écrite ni modifiée', () => {
    const maj = instructions.match(/UPDATE agenda_items[\s\S]*?;/g) ?? [];
    expect(maj).toHaveLength(2);
    for (const u of maj) {
      expect(u).toMatch(/WHERE i\.situation IS NULL/);
      expect(u).toMatch(/situation_source = 'MIGRATION'/);
      const set = u.slice(u.indexOf('SET'), u.indexOf('WHERE'));
      expect(set).not.toMatch(/start_date|end_date|manual_status|no_deadline/);
    }
  });

  it('L114V-M3 — réalisé CONNU (geste de l’utilisateur archivé) → « A eu lieu » ; ouvert CONNU (« Sans échéance », date future) → « À prévoir » ; ni « annulé », ni sans-date ordinaire', () => {
    expect(instructions).toContain("e.detail_json ->> 'manualStatus' = 'realise'");
    expect(instructions).toContain("e.detail_json ->> 'userGesture' = 'true'");
    expect(instructions).toContain('i.no_deadline = true OR i.start_date > CURRENT_DATE');
    expect(instructions).not.toContain("'annule'");
    // Jamais « tout date NULL → À prévoir ».
    expect(instructions).not.toMatch(/start_date IS NULL\s*;/);
    expect(instructions).not.toMatch(/SET situation = 'A_PREVOIR'[\s\S]*WHERE i\.situation IS NULL\s+AND i\.start_date IS NULL/);
  });
});

describe('L114V-N — rappels d’échéance (#732) : « A eu lieu » jamais rappelé', () => {
  it('L114V-N1 — candidats, couverture en file et contrôle à l’envoi excluent « A eu lieu » ; sans date : hors plage par construction', () => {
    const d = lire('src/lib/notifications/scheduled/deadlines.ts');
    expect(d.match(/i\.situation IS DISTINCT FROM 'A_EU_LIEU'/g)).toHaveLength(2);
    expect(d).toContain('AND i.start_date BETWEEN ${today}::date AND ${last}::date');
    expect(lire('src/lib/notifications/scheduled/deadline-dispatch.ts')).toContain("AND situation IS DISTINCT FROM 'A_EU_LIEU'");
  });
});
