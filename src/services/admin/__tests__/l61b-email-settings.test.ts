/**
 * Lot 61B — audit du ticket P0 e-mails : correction de l'expéditeur depuis
 * le BO sans SQL (MAIL-R-01). Validation pure, route et écran (même
 * composant ordinateur / mobile). Base réelle : l61b-mail-residuels.e2e.ts.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateEmailSettingsPatch } from '@/services/admin/transactional-email-logs.service';

const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('MAIL-R-01 — expéditeur corrigé depuis le BO', () => {
  it('valide et normalise ; refuse injection d’en-tête, adresse invalide, champ inconnu, corps vide', () => {
    expect(validateEmailSettingsPatch({ senderEmail: ' Bonjour@Verebona.FR ', senderName: 'Verebona' }))
      .toEqual({ ok: true, patch: { senderEmail: 'bonjour@verebona.fr', senderName: 'Verebona' } });
    expect(validateEmailSettingsPatch({ emailsEnabled: false })).toEqual({ ok: true, patch: { emailsEnabled: false } });
    expect(validateEmailSettingsPatch({ senderName: 'A\r\nBcc: x@y.z' })).toMatchObject({ ok: false, rejected: ['senderName'] });
    expect(validateEmailSettingsPatch({ replyToEmail: 'a@b' })).toMatchObject({ ok: false, rejected: ['replyToEmail'] });
    expect(validateEmailSettingsPatch({ logoUrl: 'x' })).toMatchObject({ ok: false, rejected: ['logoUrl'] });
    expect(validateEmailSettingsPatch({})).toMatchObject({ ok: false });
    expect(validateEmailSettingsPatch(null)).toMatchObject({ ok: false });
  });

  it('route réservée aux administrateurs, journalisée, sans secret', () => {
    const r = src('src/app/api/admin/communications/email-settings/route.ts');
    expect(r).toMatch(/await requireAdmin\(request\)/);
    expect(r).toMatch(/action: 'EMAIL_SETTINGS_UPDATE'/);
    expect(r).not.toMatch(/RESEND_API_KEY|RESEND_WEBHOOK_SECRET/);
  });

  it('écran BO : formulaire dans le bloc de configuration (un seul composant, retour à la ligne sur mobile)', () => {
    const ui = src('src/app/admin/communications/_components/TransactionalEmailsOps.tsx');
    expect(ui).toMatch(/apiClient\.patch<\{ config: Config \}>\('\/api\/admin\/communications\/email-settings'/);
    expect(ui).toMatch(/data-testid="email-sender-form"/);
    expect(ui).toMatch(/className="flex flex-wrap items-end gap-2" data-testid="email-sender-form"/);
  });
});
