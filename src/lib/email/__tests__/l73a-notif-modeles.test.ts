/**
 * Lot 73A (point 2, décision PO du 20/10) — modèles d'e-mails des
 * NOTIFICATIONS (`notif_*`) dans l'éditeur du BO, règles PURES.
 *
 * Audit : les e-mails des notifications du catalogue multicanal
 * (`lib/notifications/catalog.ts`) passent par des gabarits `email_templates`
 * de type `notif_*` (0077, 0174, 0206, 0279), remplis par l'EmailChannel avec
 * {{title}}, {{body}} (titre et message de la cloche, composés par le code) et
 * {{actionUrl}} (lien profond). Push et in-app n'ont PAS de gabarit en base :
 * leur texte reste dans le code (COM-013 maintenu pour ces canaux).
 *
 * L73A-NOTIF-01 Inventaire : chaque gabarit `notif_*` du catalogue est décrit
 *               (libellé, événements qui l'utilisent) ; événements existants.
 * L73A-NOTIF-02 Variables déclarées : title / body / actionUrl ; obligatoires :
 *               message et lien ; textes livrés (0077…) valides tels quels.
 * L73A-NOTIF-03 Refus : message retiré, lien retiré, variable non fournie
 *               ({{firstName}}), script, injection d'en-tête.
 * L73A-NOTIF-04 Actualités (NOTIF_NEWS) : mention de désinscription obligatoire.
 * L73A-NOTIF-05 Écran Communications : lien « Modifier le texte de l’e-mail »
 *               pour les notifications ; aucun éditeur push / in-app.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  NOTIFICATION_EMAIL_TEMPLATES,
  isNotificationTemplate,
  limitedEditReason,
  notificationTemplateLabel,
  templateFormat,
  validateDraft,
  variableSpecFor,
} from '../template-editor';
import { NOTIFICATION_CATALOG } from '../../notifications/catalog';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const SHIPPED_0077 = { subject: 'Votre abonnement Verebona', body: '{{body}}\n\nAccéder à Verebona : {{actionUrl}}' };
const check = (code: string, subject: string, body: string) =>
  validateDraft({ code, subject, body, format: templateFormat(body), spec: variableSpecFor(code, { format: templateFormat(body) }) });
const codes = (issues: Array<{ code: string }>) => issues.map((i) => i.code);

describe('L73A-NOTIF-01 — inventaire des gabarits notif_*', () => {
  it('chaque gabarit référencé par le catalogue est décrit', () => {
    const used = [...new Set([...read('src/lib/notifications/catalog.ts').matchAll(/'(notif_[a-z0-9_]+)'/g)].map((m) => m[1].toUpperCase()))];
    expect(used.length).toBeGreaterThan(15);
    for (const c of used) expect(NOTIFICATION_EMAIL_TEMPLATES[c], c).toBeTruthy();
  });
  it('les événements déclarés existent au catalogue', () => {
    for (const [code, d] of Object.entries(NOTIFICATION_EMAIL_TEMPLATES)) {
      for (const e of d.events) expect(NOTIFICATION_CATALOG[e as keyof typeof NOTIFICATION_CATALOG], `${code} › ${e}`).toBeTruthy();
    }
  });
  it('rendu sans contexte : le gabarit produit est celui déclaré pour l’événement', () => {
    for (const [type, entry] of Object.entries(NOTIFICATION_CATALOG)) {
      let tpl: string | undefined;
      try { tpl = entry?.render({} as never)?.emailTemplateCode; } catch { continue; }
      if (!tpl) continue;
      expect(NOTIFICATION_EMAIL_TEMPLATES[tpl.toUpperCase()]?.events, `${type} → ${tpl}`).toContain(type);
    }
  });
  it('préfixe et libellés', () => {
    expect(isNotificationTemplate('notif_subscription')).toBe(true);
    expect(isNotificationTemplate('DUO_INVITATION')).toBe(false);
    expect(notificationTemplateLabel('notif_subscription')).toMatch(/abonnement/i);
    expect(notificationTemplateLabel('notif_inconnu')).toMatch(/NOTIF_INCONNU|notif_inconnu/);
  });
});

describe('L73A-NOTIF-02 — variables déclarées et textes livrés', () => {
  it('title / body / actionUrl, message et lien obligatoires', () => {
    const spec = variableSpecFor('NOTIF_SUBSCRIPTION', { format: 'text' });
    expect(spec.declared).toBe(true);
    expect(spec.variables.map((x) => x.name)).toEqual(expect.arrayContaining(['title', 'body', 'actionUrl']));
    expect(spec.variables.find((x) => x.name === 'actionUrl')?.kind).toBe('url');
    expect(spec.required.map((g) => g.anyOf)).toEqual(expect.arrayContaining([['body', 'title'], ['actionUrl']]));
  });
  it('textes livrés des migrations 0077 / 0174 / 0206 / 0279 acceptés tels quels', () => {
    const sql = ['0077_notification_email_templates', '0174_gdpr_requests_exports', '0206_account_voluntary_deletion', '0279_lot32_withdrawal_immediate']
      .map((f) => read(`src/db/migrations/${f}.sql`)).join('\n');
    const rows = [...sql.matchAll(/\('(notif_[a-z0-9_]+)',\s*'((?:[^']|'')*)',\s*E'((?:[^']|'')*)'/g)];
    expect(rows.length).toBeGreaterThan(15);
    for (const [, type, subject, body] of rows) {
      const s = subject.replace(/''/g, "'");
      const b = body.replace(/''/g, "'").replace(/\\n/g, '\n');
      expect(check(type.toUpperCase(), s, b), type).toEqual([]);
    }
  });
});

describe('L73A-NOTIF-03 — refus', () => {
  it.each([
    [{ body: 'Accéder à Verebona : {{actionUrl}}' }, 'REQUIRED_VARIABLE_MISSING'],
    [{ body: '{{body}}' }, 'REQUIRED_VARIABLE_MISSING'],
    [{ body: 'Bonjour {{firstName}},\n\n{{body}}\n\nVoir : {{actionUrl}}' }, 'UNKNOWN_VARIABLE'],
    [{ body: `${SHIPPED_0077.body}\n<script>x</script>` }, 'SCRIPT'],
    [{ subject: 'Objet\r\nBcc: x@y.z' }, 'SUBJECT_HEADER_INJECTION'],
    [{ subject: 'Voir {{actionUrl}}' }, 'VARIABLE_NOT_ALLOWED_IN_SUBJECT'],
  ])('%j → %s', (patch, code) => {
    const d = { ...SHIPPED_0077, ...patch };
    expect(codes(check('NOTIF_SUBSCRIPTION', d.subject, d.body))).toContain(code);
  });
  it('titre dans l’objet admis (texte)', () => {
    expect(check('NOTIF_SUBSCRIPTION', '{{title}} — Verebona', SHIPPED_0077.body)).toEqual([]);
  });
});

describe('L73A-NOTIF-04 — actualités : mention de désinscription obligatoire', () => {
  const NEWS = '{{body}}\n\nAccéder à Verebona : {{actionUrl}}\n\nPour ne plus recevoir ces actualités, gérez vos préférences dans Mon compte > Notifications.';
  it('texte livré accepté ; mention retirée refusée ; édition limitée signalée', () => {
    expect(check('NOTIF_NEWS', 'Actualités Verebona', NEWS)).toEqual([]);
    expect(codes(check('NOTIF_NEWS', 'Actualités Verebona', '{{body}}\n\nAccéder à Verebona : {{actionUrl}}'))).toContain('REQUIRED_MENTION_MISSING');
    expect(limitedEditReason('NOTIF_NEWS')).toMatch(/ne plus recevoir|désinscri|préférences/i);
  });
});

describe('L73A-NOTIF-05 — écran Communications', () => {
  it('lien vers l’éditeur pour l’e-mail d’une notification (desktop et mobile : même rangée de boutons)', () => {
    const page = read('src/app/admin/communications/page.tsx');
    expect(page).toMatch(/event\.kind === 'notification' && event\.emailTemplateCode/);
    expect(page).toMatch(/Modifier le texte de l’e-mail/);
  });
});
