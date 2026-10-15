import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { unresolvedPlaceholders } from '../email-service';

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');

/**
 * Lot 49 — e-mail d'invitation Duo : le bouton « Accepter » affichait
 * « {{actionUrl}} » (gabarit en base 0125 : {{actionUrl}} ; appelants :
 * `inviteUrl` seulement).
 */
describe('L49-DUO-MAIL — invitation Duo', () => {
  // Lot 57A : les variables de l'e-mail sont construites par la demande
  // durable (`transactional-email-jobs.service`), commune à la route et au BO.
  const JOBS = 'src/services/email/transactional-email-jobs.service.ts';

  it('DUO-MAIL-01 : l’e-mail d’invitation fournit actionUrl ET inviteUrl', () => {
    const src = read(JOBS);
    expect(src).toMatch(/templateCode:\s*'DUO_INVITATION'/);
    expect(src).toMatch(/actionUrl:\s*inviteUrl/);
    expect(src).toMatch(/\binviteUrl,/);
    expect(read('src/app/api/duo/invitation/route.ts')).toMatch(/enqueueDuoInvitationEmail\(/);
  });

  it('DUO-MAIL-02 : le renvoi depuis le BO passe par la même construction', () => {
    const src = read('src/services/admin/user-detail.service.ts');
    expect(src).toMatch(/enqueueDuoInvitationEmail\(/);
    expect(src).not.toMatch(/emailService\.send\(\{\s*templateCode: 'DUO_INVITATION'/);
  });

  it('DUO-MAIL-03 : le lien utilise l’adresse publique de l’application, jamais l’en-tête Origin', () => {
    const src = read('src/app/api/duo/invitation/route.ts');
    expect(src).toMatch(/getAppBaseUrl\(request\)/);
    expect(src).not.toMatch(/headers\.get\('origin'\)/);
  });

  it('DUO-MAIL-04 : toutes les variables du gabarit DUO_INVITATION en base sont fournies', () => {
    const sql = read('src/db/migrations/0125_missing_email_templates.sql');
    const start = sql.indexOf("('DUO_INVITATION'");
    const body = sql.slice(start, sql.indexOf('NOW()', start));
    const textPart = body.slice(0, body.lastIndexOf("'["));
    const expected = unresolvedPlaceholders(textPart);
    expect(expected).toContain('actionUrl');
    const route = read(JOBS);
    for (const name of expected) expect(route).toMatch(new RegExp(`\\b${name}\\b`));
  });

  it('DUO-MAIL-05 : un emplacement non remplacé est détecté', () => {
    expect(unresolvedPlaceholders('Accepter : {{actionUrl}} {{ year }}')).toEqual(['actionUrl', 'year']);
    expect(unresolvedPlaceholders('Accepter : https://app.verebona.fr/duo/join/abc')).toEqual([]);
  });

  it('DUO-MAIL-06 : « Libellé : URL » devient un bouton portant le libellé', () => {
    const src = read('src/lib/email/email-service.ts');
    expect(src).toContain('const labelled = ');
    expect(src).toContain('${label}');
  });
});
