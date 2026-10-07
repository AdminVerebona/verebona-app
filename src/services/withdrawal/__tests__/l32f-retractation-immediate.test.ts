/**
 * Lot 32 — rétractation (décisions PO du 07/10/2026, Q1 et Q2).
 *
 *   PO-Q1 : le délai court à partir du PAIEMENT (premier paiement réussi de
 *           l'abonnement payant), pas de la création du compte ; avertissement
 *           important et explicite avant confirmation : le compte sera
 *           supprimé immédiatement. Même règle pour la page publique par jeton.
 *   PO-Q2 : traitement immédiat (accès coupés, remboursement intégral, e-mail
 *           d'au revoir), plus de suivi ni d'examen manuel, suppression
 *           immédiate du compte ; plus de délai d'export de 30 jours.
 *
 * Le parcours complet sur PostgreSQL réel est dans
 * `src/test/e2e/scenarios/l32f-decisions-po.e2e.ts`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {} }));
import { shouldOfferWithdrawal, withdrawalWindowClosesAt, withdrawalWindowStart } from '../withdrawal-window';

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');
const JOUR = 24 * 3600 * 1000;

describe('PO-Q1 — le délai de rétractation commence au paiement', () => {
  it('premier abonnement payé à la souscription : départ = paiement', () => {
    const paye = new Date('2026-10-06T08:00:00Z');
    expect(withdrawalWindowStart({ firstBilledAt: paye, contractConcludedAt: paye })?.toISOString()).toBe(paye.toISOString());
  });

  it('abonnement démarré AVANT son premier paiement : départ = le paiement, pas la création', () => {
    const creation = new Date('2026-09-01T08:00:00Z');
    const paye = new Date('2026-10-06T08:00:00Z');
    expect(withdrawalWindowStart({ firstBilledAt: paye, contractConcludedAt: creation })?.toISOString()).toBe(paye.toISOString());
    // 14 jours après le PAIEMENT : encore ouvert, alors que 35 jours ont passé depuis la création.
    expect(shouldOfferWithdrawal({ verdict: 'eligible', subscribedAt: paye, now: new Date(paye.getTime() + 13 * JOUR) })).toBe(true);
    expect(withdrawalWindowClosesAt(paye)!.getTime()).toBeGreaterThan(paye.getTime() + 14 * JOUR - 1);
  });

  it('nouvel abonnement après résiliation : le nouveau contrat (payé à la souscription) ouvre un nouveau délai', () => {
    const premierPaiementDuCompte = new Date('2025-01-10T08:00:00Z');
    const nouveauContrat = new Date('2026-10-06T08:00:00Z');
    expect(withdrawalWindowStart({ firstBilledAt: premierPaiementDuCompte, contractConcludedAt: nouveauContrat })?.toISOString())
      .toBe(nouveauContrat.toISOString());
  });

  it('aucun paiement constaté : aucune date, donc aucun contrat payant à rétracter', () => {
    expect(withdrawalWindowStart({ firstBilledAt: null, contractConcludedAt: null })).toBeNull();
    const src = read('src/services/withdrawal/eligibility.service.ts');
    expect(src).toMatch(/if \(!windowStart\) \{\s*return \{ verdict: 'ineligible', reason: 'NO_PAID_CONTRACT'/);
  });

  it('une seule règle pour l’affichage (connecté), le refus et le parcours public par jeton', () => {
    expect(read('src/app/api/withdrawal/eligibility/route.ts')).toContain('subscribedAt: eligibility.contract?.paidAt ?? null');
    // Le parcours public (jeton) et le parcours connecté appellent le même évaluateur.
    expect(read('src/app/api/withdrawal/public/verify/route.ts')).toContain('evaluateEligibility(identity.userId, identity.accountId)');
    expect(read('src/app/api/withdrawal/confirm/route.ts')).toContain('evaluateEligibility(caller.userId, caller.accountId)');
  });

  it('avertissement important et explicite AVANT confirmation (page publique et connectée)', () => {
    const page = read('src/app/retractation/page.tsx');
    expect(page).toContain('Votre compte sera supprimé immédiatement');
    expect(page).toContain('role="alert"');
    // Sur la présentation ET juste au-dessus du bouton de confirmation.
    const review = page.slice(page.indexOf("{step === 'review' && summary && ("), page.indexOf("{step === 'blocked' && ("));
    expect(review.indexOf('<DeletionWarning />')).toBeGreaterThan(-1);
    expect(review.indexOf('<DeletionWarning />')).toBeLessThan(review.indexOf('Confirmer la rétractation'));
    const presentation = page.slice(page.indexOf("{step === 'presentation' && ("), page.indexOf("{step === 'identify' && ("));
    expect(presentation).toContain('<DeletionWarning />');
    // Mon compte : même avertissement dans la carte.
    expect(read('src/components/account/WithdrawalCard.tsx')).toContain('Votre compte sera supprimé immédiatement.');
  });
});

describe('PO-Q2 — traitement immédiat, plus de suivi ni d’examen manuel', () => {
  it('plus de délai d’export de 30 jours affiché ; texte cohérent avec la suppression immédiate', () => {
    const page = read('src/app/retractation/page.tsx');
    expect(page).not.toContain('<strong>30 jours</strong>');
    expect(page).not.toMatch(/exportables pendant/);
    expect(page).not.toContain('Données exportables jusqu’au');
    expect(page).toContain('Immédiate, dès la confirmation');
    expect(page).toContain('supprimés immédiatement');
    expect(read('src/services/withdrawal/summary.service.ts')).not.toContain('DATA_RECOVERY_DAYS');
  });

  it('plus d’écran ni de carte de suivi de demande', () => {
    expect(existsSync(join(process.cwd(), 'src/app/api/withdrawal/[reference]/route.ts'))).toBe(false);
    const carte = read('src/components/account/WithdrawalCard.tsx');
    expect(carte).not.toContain('Rétractation enregistrée');
    expect(carte).not.toContain('existingRequest');
    expect(read('src/app/api/withdrawal/eligibility/route.ts')).not.toContain('existingRequest');
    expect(read('src/services/withdrawal/receipt.service.ts')).not.toContain('/retractation/suivi/');
  });

  it('plus d’examen manuel : seule une déclaration éligible est enregistrée', async () => {
    const { initialStatus } = await import('../withdrawal.service');
    expect(initialStatus('eligible')).toBe('received');
    expect(initialStatus('undetermined')).toBeNull();
    expect(initialStatus('ineligible')).toBeNull();
    expect(shouldOfferWithdrawal({ verdict: 'undetermined', subscribedAt: new Date(), now: new Date() })).toBe(false);
    const confirm = read('src/app/api/withdrawal/confirm/route.ts');
    expect(confirm).toContain("code: 'WITHDRAWAL_TEMPORARILY_UNAVAILABLE'");
    expect(confirm.indexOf("code: 'WITHDRAWAL_TEMPORARILY_UNAVAILABLE'")).toBeLessThan(confirm.indexOf('await recordDeclaration('));
  });

  it('traitement immédiat à la confirmation : accusé (e-mail d’au revoir) puis traitement attendu', () => {
    const confirm = read('src/app/api/withdrawal/confirm/route.ts');
    expect(confirm.indexOf('await sendWithdrawalReceipt(')).toBeLessThan(confirm.indexOf('processWithdrawal(declaration.publicReference)'));
    expect(confirm).toContain('await Promise.race([');
    expect(confirm).not.toContain('void processWithdrawal');
  });

  it('suppression immédiate par le service existant (délai 0), qui conserve factures et preuves', () => {
    const proc = read('src/services/withdrawal/withdrawal-processor.service.ts');
    expect(proc).toMatch(/scheduleDeletion\(\{[\s\S]*reason: 'WITHDRAWAL',[\s\S]*delayDays: 0,/);
    expect(proc).toContain('await executeScheduledDeletion(schedule.id, { now })');
    const del = read('src/services/account/scheduled-deletion.service.ts');
    expect(del).toContain("'invoices',");          // factures conservées (SURVIVING_TABLES)
    expect(del).toContain("'withdrawal_requests'"); // preuve de la rétractation conservée
  });

  it('e-mail d’au revoir : modèle sans lien de suivi ni délai d’export, migré sans commande (0279)', () => {
    const seed = read('src/db/seeds/withdrawal/email_template_withdrawal.ts');
    const html = seed.slice(seed.indexOf('export const WITHDRAWAL_RECEIPT_HTML = `') + 'export const WITHDRAWAL_RECEIPT_HTML = `'.length);
    const corps = html.slice(0, html.indexOf('`;'));
    expect(corps).not.toContain('{{trackingUrl}}');
    expect(corps).not.toContain('{{dataExportDeadlineLabel}}');
    expect(corps).toContain('sont <strong>supprimés</strong>');
    expect(corps).toContain('Au revoir');
    const migration = read('src/db/migrations/0279_lot32_withdrawal_immediate.sql');
    expect(migration).toContain(`$tpl$${corps}$tpl$`);
    expect(migration).toContain('ON CONFLICT (type) DO UPDATE');
  });

  it('robustesse : un échec Stripe ou de suppression laisse la demande en reprise automatique', () => {
    const proc = read('src/services/withdrawal/withdrawal-processor.service.ts');
    expect(proc).toContain("'ACCOUNT_DELETION_FAILED'");
    const sweep = read('src/services/withdrawal/withdrawal-sweep.job.ts');
    expect(sweep).toContain("inArray(withdrawalRequests.status, ['received', 'failed', 'processing'])");
  });
});
