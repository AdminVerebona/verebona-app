/**
 * Lot 112D — conditions d'un prêt SAISIES par l'utilisateur (ou le support) : décision utilisateur du domaine
 * financement (route PUT /api/assets/[id]/tco/financing/[operationId]).
 *
 * SEUL écrivain des colonnes de saisie 1415 de `business_operation_financing_details` : conditions manquantes
 * (montant, taux nominal, périodicité, durée, 1re échéance, échéance hors assurance, assurance, différé) et
 * événements saisis (capital restant dû à une date, remboursement anticipé). Origine PAR CHAMP (USER / ADMIN,
 * date, auteur), journalisée dans `business_operation_history` (avant / après, corrélation), sous le verrou
 * d'écriture standard des Opérations du compte (`withBusinessOperationWrite`) — comme les décisions
 * utilisateur 109A (`relations/operation-suppliers.ts`).
 *
 * Le TCO reste consommateur (INV-FINAL-009 / INV-FINAL-013) : il RELIT ces colonnes (`tco/loan-terms.service.ts`)
 * et calcule le capital restant dû, qui n'est jamais un coût. Une lecture documentaire n'est jamais recopiée
 * ici : une saisie n'est donc jamais remplacée par un document. Droits vérifiés par la route (Premium /
 * Premium Duo / essai, bien modifiable) ; ici : Opération FINANCING active du COMPTE, liée au bien.
 */
import { sql, type SQL } from 'drizzle-orm';
import { withBusinessOperationWrite } from '../write';
import { isCivilDate, LOAN_MAX_DURATION_MONTHS, LOAN_PERIODICITIES, parseRatePct, type LoanPeriodicity } from '../tco/loan-amortization';
import { LOAN_TERM_FIELDS, type LoanManualEvent, type LoanTermField, type LoanTermValues } from '../tco/loan-evidence';
import { manualFromRow } from '../tco/loan-terms.service';

type Row = Record<string, unknown>;
interface Runner { execute: (q: SQL) => Promise<unknown> }
const rows = async <T = Row>(r: Runner, q: SQL): Promise<T[]> => (await r.execute(q)) as unknown as T[];

export class LoanTermsError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) { super(message); this.name = 'LoanTermsError'; }
}

export interface LoanTermsPatch {
  /** Champs à fixer (valeur) ou à effacer (null) ; absents : inchangés. */
  terms: Partial<{ [K in LoanTermField]: LoanTermValues[K] | null }>;
  /** Liste complète des événements saisis (remplace la précédente) ; absente : inchangée. */
  events?: Array<Omit<LoanManualEvent, 'origin' | 'at' | 'userId'> & { origin?: never }>;
}


const montant = (v: unknown, min: number): number | null | undefined =>
  (v === null ? null : typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= 10_000_000_000 ? v : undefined);

/** Validation du corps de la saisie (pure, testée L112D-API-*). */
export function parseLoanTermsBody(body: unknown): { ok: true; value: LoanTermsPatch } | { ok: false; message: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, message: 'Corps invalide.' };
  const b = body as Record<string, unknown>;
  const t = (b.terms ?? {}) as Record<string, unknown>;
  if (typeof t !== 'object' || Array.isArray(t)) return { ok: false, message: 'Conditions invalides.' };
  const terms: LoanTermsPatch['terms'] = {};
  for (const k of Object.keys(t)) {
    if (!(LOAN_TERM_FIELDS as readonly string[]).includes(k)) return { ok: false, message: `Champ inconnu : ${k}.` };
  }
  if ('principalCents' in t) { const v = montant(t.principalCents, 1); if (v === undefined) return { ok: false, message: 'Montant emprunté invalide (centimes, > 0).' }; terms.principalCents = v; }
  if ('installmentCents' in t) { const v = montant(t.installmentCents, 1); if (v === undefined) return { ok: false, message: 'Échéance hors assurance invalide (centimes, > 0).' }; terms.installmentCents = v; }
  if ('insuranceCents' in t) { const v = montant(t.insuranceCents, 0); if (v === undefined) return { ok: false, message: 'Assurance par échéance invalide (centimes, ≥ 0).' }; terms.insuranceCents = v; }
  if ('ratePct' in t) {
    if (t.ratePct === null) terms.ratePct = null;
    else { const r = parseRatePct(typeof t.ratePct === 'number' ? String(t.ratePct) : (t.ratePct as string)); if (!r) return { ok: false, message: 'Taux nominal invalide (pourcentage, ex. « 3,25 »).' }; terms.ratePct = r.text; }
  }
  if ('periodicity' in t) {
    if (t.periodicity !== null && !LOAN_PERIODICITIES.includes(t.periodicity as LoanPeriodicity)) return { ok: false, message: 'Périodicité invalide.' };
    terms.periodicity = t.periodicity as LoanPeriodicity | null;
  }
  if ('durationMonths' in t) {
    const v = t.durationMonths;
    if (v !== null && !(typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= LOAN_MAX_DURATION_MONTHS)) return { ok: false, message: `Durée invalide (1 à ${LOAN_MAX_DURATION_MONTHS} mois).` };
    terms.durationMonths = v as number | null;
  }
  if ('firstInstallmentDate' in t) {
    if (t.firstInstallmentDate !== null && !isCivilDate(t.firstInstallmentDate)) return { ok: false, message: 'Date de première échéance invalide (AAAA-MM-JJ).' };
    terms.firstInstallmentDate = t.firstInstallmentDate as string | null;
  }
  if ('deferral' in t) {
    const d = t.deferral as { months?: unknown; kind?: unknown } | null;
    if (d === null) terms.deferral = null;
    else if (!d || typeof d !== 'object' || !Number.isSafeInteger(d.months) || (d.months as number) < 0 || (d.months as number) > LOAN_MAX_DURATION_MONTHS
      || !['NONE', 'PARTIAL', 'TOTAL'].includes(d.kind as string) || ((d.kind === 'NONE') !== (d.months === 0))) {
      return { ok: false, message: 'Différé invalide (mois et nature : aucun, partiel ou total).' };
    } else terms.deferral = { months: d.months as number, kind: d.kind as LoanTermValues['deferral']['kind'] };
  }
  let events: LoanTermsPatch['events'];
  if (b.events !== undefined) {
    if (!Array.isArray(b.events) || b.events.length > 50) return { ok: false, message: 'Événements invalides (au plus 50).' };
    events = [];
    for (const [i, e0] of (b.events as unknown[]).entries()) {
      const e = (e0 ?? {}) as Record<string, unknown>;
      if (!['BALANCE', 'EARLY_REPAYMENT'].includes(e.kind as string) || !isCivilDate(e.date)) return { ok: false, message: `Événement ${i + 1} invalide (nature, date).` };
      const a = montant(e.amountCents, e.kind === 'BALANCE' ? 0 : 1);
      if (a == null) return { ok: false, message: `Événement ${i + 1} : montant invalide.` };
      const mode = e.kind === 'EARLY_REPAYMENT' ? (e.mode ?? null) : null;
      if (mode !== null && !['REDUCED_DURATION', 'NEW_INSTALLMENT'].includes(mode as string)) return { ok: false, message: `Événement ${i + 1} : mode invalide.` };
      const ni = e.newInstallmentCents == null ? null : montant(e.newInstallmentCents, 1);
      if (ni === undefined || (mode === 'NEW_INSTALLMENT' && ni == null)) return { ok: false, message: `Événement ${i + 1} : nouvelle échéance invalide.` };
      events.push({ id: typeof e.id === 'string' && /^[\w-]{1,40}$/.test(e.id) ? e.id : `e${i + 1}`, kind: e.kind as LoanManualEvent['kind'], date: e.date as string, amountCents: a, mode: mode as LoanManualEvent['mode'], newInstallmentCents: ni ?? null });
    }
  }
  if (!Object.keys(terms).length && events === undefined) return { ok: false, message: 'Aucune condition à enregistrer.' };
  return { ok: true, value: { terms, events } };
}

/**
 * Enregistre les conditions saisies d'un prêt (origine PAR CHAMP), journalisées.
 * Rend les champs effectivement modifiés.
 */
export async function saveLoanTerms(
  accountId: number, assetId: number, operationId: number,
  actor: { userId: number | null; origin: 'USER' | 'ADMIN' }, patch: LoanTermsPatch, now: Date = new Date(),
): Promise<{ changed: LoanTermField[]; eventsChanged: boolean }> {
  // Verrou d'écriture standard des Opérations du compte (même sérialisation que T3 et les décisions 109A).
  return withBusinessOperationWrite(accountId, async (_repo, session) => {
    const tx = session.tx as unknown as Runner;
    const [op] = await rows<{ id: string; type_code: string | null }>(tx, sql`
      SELECT o.id, o.type_code FROM business_operations o
       WHERE o.id = ${operationId} AND o.account_id = ${accountId} AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
         AND (EXISTS (SELECT 1 FROM business_operation_asset_links l WHERE l.operation_id = o.id AND l.account_id = o.account_id AND l.active AND l.asset_id = ${assetId})
              OR EXISTS (SELECT 1 FROM business_operation_equipment_links e WHERE e.operation_id = o.id AND e.account_id = o.account_id AND e.active AND e.asset_id = ${assetId}))
       FOR UPDATE`);
    if (!op) throw new LoanTermsError('NOT_FOUND', 'Prêt introuvable pour ce bien.', 404);
    if (op.type_code !== 'FINANCING') throw new LoanTermsError('NOT_A_LOAN', 'Cet élément n’est pas un prêt.', 422);
    await tx.execute(sql`INSERT INTO business_operation_financing_details (operation_id) VALUES (${operationId}) ON CONFLICT (operation_id) DO NOTHING`);
    const [cur] = await rows<Row>(tx, sql`
      SELECT loan_principal_minor, loan_nominal_rate_pct::text AS loan_nominal_rate_pct, loan_periodicity, loan_duration_months,
             loan_first_installment_date::text AS loan_first_installment_date, loan_installment_minor, loan_insurance_minor,
             loan_deferral_months, loan_deferral_kind, loan_terms_origin, loan_events
        FROM business_operation_financing_details WHERE operation_id = ${operationId} FOR UPDATE`);
    const avant = manualFromRow(cur)?.values ?? {};
    const origins = { ...((cur.loan_terms_origin ?? {}) as Record<string, unknown>) };
    const at = now.toISOString();
    const changed: LoanTermField[] = [];
    const before: Record<string, unknown> = {}; const after: Record<string, unknown> = {};
    for (const f of LOAN_TERM_FIELDS) {
      if (!(f in patch.terms)) continue;
      const v = patch.terms[f] ?? null;
      if (JSON.stringify(avant[f] ?? null) === JSON.stringify(v)) continue;
      changed.push(f); before[f] = avant[f] ?? null; after[f] = v;
      if (v === null) delete origins[f]; else origins[f] = { origin: actor.origin, at, userId: actor.userId };
    }
    const ancienEvts = Array.isArray(cur.loan_events) ? (cur.loan_events as LoanManualEvent[]) : [];
    const nouveauxEvts: LoanManualEvent[] | null = patch.events === undefined ? null : patch.events.map((e) => {
      const prev = ancienEvts.find((x) => x.id === e.id && x.kind === e.kind && x.date === e.date && x.amountCents === e.amountCents && (x.mode ?? null) === (e.mode ?? null) && (x.newInstallmentCents ?? null) === (e.newInstallmentCents ?? null));
      return prev ?? { ...e, origin: actor.origin, at, userId: actor.userId };
    });
    const eventsChanged = nouveauxEvts !== null && JSON.stringify(nouveauxEvts) !== JSON.stringify(ancienEvts);
    if (eventsChanged) { before.events = ancienEvts; after.events = nouveauxEvts; }
    if (!changed.length && !eventsChanged) return { changed, eventsChanged };
    const val = (f: LoanTermField) => (f in patch.terms ? patch.terms[f] ?? null : avant[f] ?? null);
    const deferral = val('deferral') as LoanTermValues['deferral'] | null;
    await tx.execute(sql`
      UPDATE business_operation_financing_details SET
        loan_principal_minor = ${val('principalCents')}, loan_nominal_rate_pct = ${val('ratePct')}::numeric, loan_periodicity = ${val('periodicity')},
        loan_duration_months = ${val('durationMonths')}, loan_first_installment_date = ${val('firstInstallmentDate')}::date,
        loan_installment_minor = ${val('installmentCents')}, loan_insurance_minor = ${val('insuranceCents')},
        loan_deferral_months = ${deferral?.months ?? null}, loan_deferral_kind = ${deferral?.kind ?? null},
        loan_terms_origin = ${JSON.stringify(origins)}::jsonb,
        loan_events = ${JSON.stringify(nouveauxEvts ?? ancienEvts)}::jsonb, updated_at = now()
      WHERE operation_id = ${operationId}`);
    await tx.execute(sql`UPDATE business_operations SET version = version + 1, updated_at = now() WHERE id = ${operationId} AND account_id = ${accountId}`);
    await tx.execute(sql`
      INSERT INTO business_operation_history (account_id, operation_id, event_type, reason_code, actor_user_id, before_json, after_json, correlation_id)
      VALUES (${accountId}, ${operationId}, 'UPDATED', ${actor.origin === 'ADMIN' ? 'LOAN_TERMS_ADMIN' : 'LOAN_TERMS_USER'}, ${actor.userId},
              ${JSON.stringify(before)}::jsonb, ${JSON.stringify(after)}::jsonb, ${session.correlationId})`);
    return { changed, eventsChanged };
  }, { actorUserId: actor.userId });
}
