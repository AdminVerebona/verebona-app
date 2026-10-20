/**
 * Lot 73A (point 1, décision PO du 20/10) — rappel d'export dans les e-mails
 * de fin d'accès au Premium Duo.
 *
 * Parcours réel (lot 72D) : l'export des biens se fait depuis la fiche du bien
 * et n'est proposé qu'AVANT de quitter (« Quitter l'espace ») ; après la fin
 * de l'accès, le membre ne voit plus l'espace partagé. Le texte livré :
 *   · ENDED (retrait par le titulaire, fin d'offre…) : le membre ne peut plus
 *     exporter les biens partagés lui-même → s'adresser au titulaire ; ses
 *     données personnelles restent exportables (Mon compte › Mes données) ;
 *   · LEFT (départ volontaire) : l'export lui a été proposé avant de partir ;
 *     s'il ne l'a pas fait → s'adresser au titulaire ; même rappel « Mes données ».
 *
 * L73A-DUO-01 Texte livré ENDED : rappel adapté à l'absence d'accès, lien d'export.
 * L73A-DUO-02 Texte livré LEFT : rappel « avant votre départ », lien d'export.
 * L73A-DUO-03 Variable {{dataExportUrl}} déclarée (éditeur du BO) ; textes livrés
 *             valides ; lien résolu dans l'aperçu du BO.
 * L73A-DUO-04 Migration 0527 : textes = code ; garde 0483 respectée (aucun
 *             réglage d'éditeur, aucune écriture de la marque de personnalisation),
 *             rejouable ; version d'historique pour un gabarit non personnalisé.
 * L73A-DUO-05 Le service d'envoi fournit {{dataExportUrl}} (Mon compte › Mes données).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_EMAIL_TEMPLATES } from '@/lib/email-defaults';
import { templateFormat, validateDraft, variableSpecFor } from '@/lib/email/template-editor';
import { resolveTemplateVariables } from '@/services/admin/communications.service';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const MIG = 'src/db/migrations/0527_l73a_duo_rappel_export.sql';
const ENDED = DEFAULT_EMAIL_TEMPLATES.DUO_MEMBERSHIP_ENDED;
const LEFT = DEFAULT_EMAIL_TEMPLATES.DUO_MEMBERSHIP_LEFT;

describe('L73A-DUO-01 — DUO_MEMBERSHIP_ENDED : rappel d’export adapté à la perte d’accès', () => {
  it('rappel présent, sans promettre un export que le membre ne peut plus faire', () => {
    expect(ENDED.body).toMatch(/vous ne pouvez plus en exporter les biens vous-même/);
    expect(ENDED.body).toMatch(/adressez-vous, le cas échéant, à \{\{ownerFirstName\}\}, qui peut les exporter depuis la fiche de chaque bien/);
    expect(ENDED.body).toMatch(/Mon compte, rubrique « Mes données »/);
    expect(ENDED.body).toMatch(/^Exporter mes données : \{\{dataExportUrl\}\}$/m);
    // Liens existants conservés.
    expect(ENDED.body).toMatch(/^Accéder à mon compte : \{\{accountUrl\}\}$/m);
    expect(ENDED.body).toMatch(/^Voir mon offre : \{\{subscriptionUrl\}\}$/m);
    // Discrétion inchangée (aucun motif, aucune adresse du titulaire).
    expect(`${ENDED.subject}\n${ENDED.body}`).not.toMatch(/rétract|impay|paiement|supprim[ée] son compte|ownerEmail|ownerLastName/i);
    expect(JSON.parse(ENDED.placeholders)).toEqual(['firstName', 'ownerFirstName', 'accountUrl', 'subscriptionUrl', 'dataExportUrl']);
  });
});

describe('L73A-DUO-02 — DUO_MEMBERSHIP_LEFT : rappel « avant votre départ »', () => {
  it('rappel présent et adapté au départ volontaire', () => {
    expect(LEFT.body).toMatch(/si vous n'avez pas exporté avant votre départ les biens de l'espace partagé/);
    expect(LEFT.body).toMatch(/adressez-vous à \{\{ownerFirstName\}\}, qui peut les exporter depuis la fiche de chaque bien/);
    expect(LEFT.body).toMatch(/Mon compte, rubrique « Mes données »/);
    expect(LEFT.body).toMatch(/^Exporter mes données : \{\{dataExportUrl\}\}$/m);
    expect(LEFT.body).toMatch(/nouvelle invitation du titulaire/);
    expect(JSON.parse(LEFT.placeholders)).toEqual(['firstName', 'ownerFirstName', 'accountUrl', 'subscriptionUrl', 'dataExportUrl']);
  });
});

describe('L73A-DUO-03 — variable déclarée, textes valides, aperçu', () => {
  it.each([['DUO_MEMBERSHIP_ENDED', ENDED], ['DUO_MEMBERSHIP_LEFT', LEFT]])('%s', (type, t) => {
    const spec = variableSpecFor(type, { format: templateFormat(t.body) });
    expect(spec.variables.find((x) => x.name === 'dataExportUrl')?.kind).toBe('url');
    expect(validateDraft({ subject: t.subject, body: t.body, format: 'text', spec })).toEqual([]);
  });
  it('aperçu du BO : lien « Mes données » résolu, sans donnée manquante', () => {
    const r = resolveTemplateVariables([ENDED.subject, ENDED.body], { firstName: 'Ada', lastName: 'A', email: 'a@x.fr', accountName: null, planLabel: null }, 'https://app.verebona.fr/');
    expect(r.variables.dataExportUrl).toBe('https://app.verebona.fr/mon-compte#mes-donnees');
  });
});

describe('L73A-DUO-04 — migration 0527 (garde 0483)', () => {
  const mig = (() => { try { return read(MIG); } catch { return ''; } })();
  const dollar = (tag: string) => new RegExp(`\\$${tag}\\$([\\s\\S]*?)\\$${tag}\\$`).exec(mig)?.[1];
  it('textes livrés = textes du code', () => {
    expect(dollar('l73a_ended_subject')).toBe(ENDED.subject);
    expect(dollar('l73a_ended_body')).toBe(ENDED.body);
    expect(dollar('l73a_left_subject')).toBe(LEFT.subject);
    expect(dollar('l73a_left_body')).toBe(LEFT.body);
  });
  it('passe par la garde : jamais le réglage de l’éditeur ni la marque de personnalisation', () => {
    expect(mig).not.toMatch(/verebona\.email_template_edit/);
    expect(mig).not.toMatch(/is_customized\s*=/);
    expect(mig).not.toMatch(/shipped_(body|subject|updated_at)\s*=/);
    expect(mig).toMatch(/UPDATE email_templates/);
  });
  it('rejouable : ne réécrit que si le texte livré connu diffère', () => {
    expect(mig).toMatch(/coalesce\(t\.shipped_body, t\.body\) IS DISTINCT FROM l\.body/);
    expect(mig).toMatch(/SET LOCAL lock_timeout/);
    expect(mig).toMatch(/'shipped_update'/);
  });
});

describe('L73A-DUO-05 — variables fournies à l’envoi', () => {
  it('le constructeur de la file durable fournit dataExportUrl', () => {
    const src = read('src/services/email/transactional-email-jobs.service.ts');
    expect(src).toMatch(/dataExportUrl: `\$\{base\}\/mon-compte#mes-donnees`/);
  });
});
