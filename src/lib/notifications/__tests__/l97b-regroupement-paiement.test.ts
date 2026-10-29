/**
 * Lot 97B — test L79C-E2E-08 instable : regroupement « échec de paiement +
 * demande d'authentification » de la MÊME facture.
 *
 * Cause : quand les deux événements étaient réclamés dans le même lot du
 * dispatcher, l'échec était déjà « en cours » (`processing`) sans avoir décidé
 * s'il porterait l'action ; si la demande passait en premier, elle partait,
 * puis l'échec la voyait et ajoutait l'action → deux messages. L'ordre dans le
 * lot dépendait de la place physique des lignes (`UPDATE … RETURNING`), pas de
 * l'heure.
 *
 * Ce test rejoue, horloge FIGÉE à des instants limites (minuit à Paris,
 * changements d'heure d'octobre et de mars, nuit), TOUS les entrelacements
 * possibles (arrivée, réclamation, décision) des deux événements avec les
 * fonctions de décision réelles, et vérifie :
 *   · l'action est toujours communiquée au moins une fois ;
 *   · si les deux existent avant que l'un ou l'autre ne décide → UN message ;
 *   · le résultat ne dépend ni de l'instant ni du fuseau.
 * Le moteur réel sur PostgreSQL : `l79c-notifications.e2e.ts` › L79C-E2E-08b.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ pgClient: {}, db: {} }));

const { actionRequiredCoveredBy, paymentFailedCarriesAction } = await import('../incident-grouping');
const { parisNow } = await import('../time-paris');

type Step = 'insPF' | 'insPAR' | 'claimPF' | 'claimPAR' | 'decPF' | 'decPAR';
interface Row { status: string; createdAt: number; auth: boolean | null }

/** Tous les ordres valides : arrivée < réclamation < décision pour chaque événement. */
function interleavings(): Step[][] {
  const all: Step[] = ['insPF', 'insPAR', 'claimPF', 'claimPAR', 'decPF', 'decPAR'];
  const out: Step[][] = [];
  const before: Array<[Step, Step]> = [['insPF', 'claimPF'], ['claimPF', 'decPF'], ['insPAR', 'claimPAR'], ['claimPAR', 'decPAR']];
  const rec = (acc: Step[], rest: Step[]) => {
    if (!rest.length) {
      if (before.every(([a, b]) => acc.indexOf(a) < acc.indexOf(b))) out.push(acc);
      return;
    }
    rest.forEach((s, i) => rec([...acc, s], [...rest.slice(0, i), ...rest.slice(i + 1)]));
  };
  rec([], all);
  return out;
}

/** Rejoue un entrelacement avec les décisions réelles (verrou = étape atomique). */
function replay(order: Step[]) {
  const rows: { PF?: Row; PAR?: Row } = {};
  for (const step of order) {
    vi.advanceTimersByTime(1000); // une seconde par étape : franchit les bornes figées
    switch (step) {
      case 'insPF': rows.PF = { status: 'pending', createdAt: Date.now(), auth: null }; break;
      case 'insPAR': rows.PAR = { status: 'pending', createdAt: Date.now(), auth: null }; break;
      case 'claimPF': rows.PF!.status = 'processing'; break;
      case 'claimPAR': rows.PAR!.status = 'processing'; break;
      case 'decPF': {
        const carries = paymentFailedCarriesAction({ producerFlag: undefined, actionRequestExists: !!rows.PAR && rows.PAR.status !== 'cancelled' });
        rows.PF!.auth = carries; // décision TOUJOURS enregistrée (lot 97B)
        rows.PF!.status = 'sent';
        break;
      }
      case 'decPAR': {
        const covered = actionRequiredCoveredBy(rows.PF ? { status: rows.PF.status, authenticationRequired: rows.PF.auth } : null);
        rows.PAR!.status = covered ? 'grouped' : 'sent';
        break;
      }
    }
  }
  const messages = (rows.PF!.status === 'sent' ? 1 : 0) + (rows.PAR!.status === 'sent' ? 1 : 0);
  const actionCommunicated = rows.PF!.auth === true || rows.PAR!.status === 'sent';
  const bothBeforeAnyDecision = order.indexOf('insPAR') < order.indexOf('decPF') && order.indexOf('insPF') < order.indexOf('decPAR');
  return { messages, actionCommunicated, bothBeforeAnyDecision, signature: `${rows.PF!.status}/${rows.PF!.auth}|${rows.PAR!.status}` };
}

// Instants FIGÉS (UTC) et heure locale de Paris attendue.
const INSTANTS: Array<{ nom: string; at: string; paris: string }> = [
  { nom: 'veille de minuit (heure d’été)', at: '2026-10-24T21:59:57Z', paris: '2026-10-24 23:59' },
  { nom: 'minuit pile', at: '2026-10-24T22:00:00Z', paris: '2026-10-25 00:00' },
  { nom: 'heure répétée du 25/10 (CEST)', at: '2026-10-25T00:59:57Z', paris: '2026-10-25 02:59' },
  { nom: 'heure répétée du 25/10 (CET)', at: '2026-10-25T01:00:00Z', paris: '2026-10-25 02:00' },
  { nom: 'passage à l’heure d’été 29/03', at: '2026-03-29T00:59:57Z', paris: '2026-03-29 01:59' },
  { nom: 'minuit en hiver', at: '2026-12-31T22:59:57Z', paris: '2026-12-31 23:59' },
  { nom: 'nuit (heures calmes)', at: '2026-10-26T21:30:00Z', paris: '2026-10-26 22:30' },
  { nom: 'journée', at: '2026-10-26T10:00:00Z', paris: '2026-10-26 11:00' },
];

afterEach(() => { vi.useRealTimers(); });

describe('L97B — échec de paiement + authentification (même facture) : décision indépendante de l’heure et de l’ordre', () => {
  const orders = interleavings();

  it('les entrelacements énumérés couvrent la réclamation dans un même lot, dans les deux ordres', () => {
    expect(orders.length).toBe(20); // C(6,3) : deux chaînes de trois étapes
    // Cas du défaut : les deux réclamés, la demande décide pendant que l'échec est « en cours ».
    expect(orders.some((o) => o.join() === 'insPF,insPAR,claimPF,claimPAR,decPAR,decPF')).toBe(true);
  });

  for (const k of INSTANTS) {
    it(`${k.nom} (${k.at}) : un seul message dès que les deux existent, l’action jamais perdue`, () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(k.at));
      const p = parisNow();
      expect(`${p.dateStr} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`).toBe(k.paris);

      const signatures: string[] = [];
      for (const order of orders) {
        vi.setSystemTime(new Date(k.at));
        const r = replay(order);
        expect(r.actionCommunicated, order.join()).toBe(true);
        if (r.bothBeforeAnyDecision) expect(r.messages, order.join()).toBe(1);
        else expect(r.messages, order.join()).toBe(2); // évolution tardive : envoyée
        signatures.push(r.signature);
      }
      // Résultat identique à chaque instant (aucune dépendance à l'heure).
      vi.setSystemTime(new Date('2026-06-15T12:00:00Z'));
      expect(orders.map((o) => replay(o).signature)).toEqual(signatures);
    });
  }

  it('règle par statut du porteur (décision enregistrée true / false / pas encore décidée)', () => {
    expect(actionRequiredCoveredBy(null)).toBe(false);
    expect(actionRequiredCoveredBy({ status: 'pending', authenticationRequired: null })).toBe(true);
    // Réclamé dans le même lot, pas encore décidé : il verra la demande et la portera.
    expect(actionRequiredCoveredBy({ status: 'processing', authenticationRequired: null })).toBe(true);
    expect(actionRequiredCoveredBy({ status: 'processing', authenticationRequired: true })).toBe(true);
    // A décidé « sans action » (demande arrivée après) : la demande part.
    expect(actionRequiredCoveredBy({ status: 'processing', authenticationRequired: false })).toBe(false);
    expect(actionRequiredCoveredBy({ status: 'sent', authenticationRequired: true })).toBe(true);
    // Ligne historique envoyée sans décision enregistrée : traitée comme « sans action ».
    expect(actionRequiredCoveredBy({ status: 'sent', authenticationRequired: null })).toBe(false);
    expect(actionRequiredCoveredBy({ status: 'partial', authenticationRequired: false })).toBe(false);
    for (const status of ['failed', 'skipped', 'grouped', 'cancelled']) {
      expect(actionRequiredCoveredBy({ status, authenticationRequired: true })).toBe(false);
    }
    expect(paymentFailedCarriesAction({ producerFlag: true, actionRequestExists: false })).toBe(true);
    expect(paymentFailedCarriesAction({ producerFlag: undefined, actionRequestExists: true })).toBe(true);
    expect(paymentFailedCarriesAction({ producerFlag: undefined, actionRequestExists: false })).toBe(false);
  });

  it('le dispatcher traite un lot réclamé dans l’ordre de création (UPDATE … RETURNING ne garantit aucun ordre)', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(process.cwd(), 'src/lib/notifications/outbox.ts'), 'utf8');
    expect(src.match(/SELECT \* FROM claimed ORDER BY created_at, id/g)).toHaveLength(2);
  });
});
