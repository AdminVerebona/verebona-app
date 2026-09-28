/**
 * COM-008 : contexte de prévisualisation choisi dans le compte de
 * l'administrateur ; COM-007 / SEC-005 : jamais d'objet d'un autre compte.
 */
import { describe, it, expect } from 'vitest';
import {
  communicationTypeLabel,
  contextPayload,
  contextVariables,
  relevantPreviewContexts,
  resolveTemplateVariables,
  selectPreviewContext,
  type PreviewContextOptions,
} from '@/services/admin/communications.service';

const options: PreviewContextOptions = {
  accountId: 7,
  assets: [{ id: 1, name: 'Maison de Lyon' }],
  documents: [{ id: 10, title: 'Facture chaudière', assetName: 'Maison de Lyon' }],
  deadlines: [{ id: 20, title: 'Entretien chaudière', date: '2026-10-15' }],
  subscription: { planCode: 'premium', status: 'active', currentPeriodEndAt: '2027-04-07T00:00:00.000Z' },
  payments: [
    { id: 30, amount: 9990, currency: 'eur', status: 'paid', date: '2026-09-01T10:00:00.000Z', planCode: 'premium', billingPeriod: 'yearly' },
  ],
  withdrawals: [
    {
      id: 40,
      publicReference: 'RET-20260905-ABC123',
      status: 'processing',
      requestedAt: '2026-09-05T08:30:00.000Z',
      amountExpected: 9990,
      currency: 'eur',
      planCode: 'premium',
      billingPeriod: 'yearly',
      dataExportDeadlineAt: '2026-10-05T00:00:00.000Z',
    },
  ],
};

describe('selectPreviewContext', () => {
  it('retient les objets du compte de l’administrateur', () => {
    const ctx = selectPreviewContext(options, { assetId: 1, documentId: 10, deadlineId: 20 });
    expect(ctx.asset?.name).toBe('Maison de Lyon');
    expect(ctx.document?.title).toBe('Facture chaudière');
    expect(ctx.deadline?.title).toBe('Entretien chaudière');
    expect(ctx.rejected).toEqual([]);
  });

  it('refuse un identifiant hors de son compte, sans l’utiliser', () => {
    const ctx = selectPreviewContext(options, { assetId: 999, documentId: 888 });
    expect(ctx.asset).toBeNull();
    expect(ctx.document).toBeNull();
    expect(ctx.rejected).toEqual(['document', 'bien']);
  });
});

describe('variables et payload issus du contexte', () => {
  const ctx = selectPreviewContext(options, { assetId: 1, documentId: 10, deadlineId: 20 });

  it('alimente les variables des gabarits e-mail', () => {
    const v = contextVariables(ctx);
    expect(v).toMatchObject({ assetName: 'Maison de Lyon', documentTitle: 'Facture chaudière', deadlineLabel: 'Entretien chaudière' });
    expect(v.deadlineDate).toMatch(/15 octobre 2026/);
    expect(v.nextBillingDate).toMatch(/2027/);
    const { variables, missingCount } = resolveTemplateVariables(
      ['{{assetName}} {{deadlineDate}} {{unknownVar}}'],
      { firstName: 'A', lastName: 'B', email: 'a@b.fr', accountName: null, planLabel: null, extra: v },
      'https://app.test',
    );
    expect(variables.assetName).toBe('Maison de Lyon');
    expect(missingCount).toBe(1);
  });

  it('construit le payload des notifications push / in-app', () => {
    const p = contextPayload(ctx, 7);
    expect(p).toMatchObject({
      accountId: 7,
      assetId: 1,
      assetFileId: 10,
      documents: [{ assetFileId: 10, title: 'Facture chaudière' }],
      count: 1,
      agendaItemIds: [20],
      date: '2026-10-15',
    });
  });
});

describe('COM-008 : contexte « Paiement » et « Rétractation »', () => {
  it('ne propose les sélecteurs que pour les modèles concernés', () => {
    expect(relevantPreviewContexts('email:WITHDRAWAL_RECEIPT', 'WITHDRAWAL_RECEIPT')).toEqual({ payment: true, withdrawal: true });
    expect(relevantPreviewContexts('PAYMENT_FAILED', 'notif_payment_incident')).toEqual({ payment: true, withdrawal: false });
    expect(relevantPreviewContexts('email:PREMIUM_CONFIRMATION', 'PREMIUM_CONFIRMATION').payment).toBe(true);
    expect(relevantPreviewContexts('DEADLINE_DUE_IN_7_DAYS', null)).toEqual({ payment: false, withdrawal: false });
  });

  it('refuse un paiement ou une rétractation hors du compte de l’administrateur', () => {
    const ctx = selectPreviewContext(options, { paymentId: 999, withdrawalId: 998 });
    expect(ctx.payment).toBeNull();
    expect(ctx.withdrawal).toBeNull();
    expect(ctx.rejected).toEqual(['paiement', 'rétractation']);
  });

  it('alimente {{amountLabel}}, la date et le statut depuis le paiement choisi', () => {
    const ctx = selectPreviewContext(options, { paymentId: 30 });
    const v = contextVariables(ctx, 'https://app.test');
    expect(v.amountLabel).toMatch(/99,90\s€/);
    expect(v.paymentDate).toMatch(/1 septembre 2026/);
    expect(v.paymentStatus).toBe('Payé');
    expect(v.contractLabel).toBe('Verebona Premium — facturation annuelle');
    expect(contextPayload(ctx, 7)).toMatchObject({ invoiceId: 30, amount: 9990, currency: 'eur', planCode: 'premium' });
  });

  it('remplit toutes les variables de l’accusé de rétractation sans « donnée indisponible »', () => {
    const ctx = selectPreviewContext(options, { withdrawalId: 40 });
    const v = contextVariables(ctx, 'https://app.test/');
    expect(v.publicReference).toBe('RET-20260905-ABC123');
    expect(v.trackingUrl).toBe('https://app.test/retractation/suivi/RET-20260905-ABC123');
    expect(v.requestedAtLabel).toMatch(/5 septembre 2026/);
    const template =
      '{{firstName}} {{lastName}} {{publicReference}} {{requestedAtLabel}} {{contractLabel}} {{amountLabel}} ' +
      '{{dataExportDeadlineLabel}} {{trackingUrl}} {{legalPermalinkUrl}}';
    const { missingCount } = resolveTemplateVariables(
      [template],
      { firstName: 'A', lastName: 'B', email: 'a@b.fr', accountName: null, planLabel: null, extra: v },
      'https://app.test',
    );
    expect(missingCount).toBe(0);
  });

  it('annonce « à déterminer » quand le remboursement prévu est inconnu', () => {
    const opts = { ...options, withdrawals: [{ ...options.withdrawals[0], amountExpected: null }] };
    expect(contextVariables(selectPreviewContext(opts, { withdrawalId: 40 })).amountLabel).toBe('à déterminer');
  });
});

describe('libellés de l’historique des communications (COM-014)', () => {
  it('traduit les codes connus, sinon garde le code', () => {
    expect(communicationTypeLabel('PASSWORD_RESET')).toBe('Réinitialisation du mot de passe');
    expect(communicationTypeLabel('password_reset')).toBe('Réinitialisation du mot de passe');
    expect(communicationTypeLabel('XYZ')).toBe('XYZ');
  });
});
