/**
 * Transmission d'un bien — acceptation et e-mails.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * « DUPLICATION_FAILED » À CHAQUE ACCEPTATION
 *
 * La copie du bien écrivait l'ID de la transmission dans
 * `assets.copy_source_request_id`, colonne qui référence
 * `asset_move_requests` (clé étrangère, migration 0055) : l'insertion
 * échouait systématiquement. Ces tests figent la correction et l'unicité de
 * l'e-mail d'invitation.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { NOTIFICATION_CATALOG } from '@/lib/notifications/catalog';

const root = process.cwd();
const accept = readFileSync(join(root, 'src/app/api/transmission/[token]/route.ts'), 'utf-8');
const initiate = readFileSync(join(root, 'src/app/api/assets/[id]/transmission/route.ts'), 'utf-8');

describe('acceptation', () => {
  it('n’écrit jamais l’ID de la transmission dans une colonne qui référence asset_move_requests', () => {
    expect(accept).not.toMatch(/copySourceRequestId:\s*row\.id/);
    expect(accept).toMatch(/copySourceRequestId:\s*null/);
  });

  it('réserve la transmission avant de copier, et la libère si la copie échoue', () => {
    expect(accept).toMatch(/ACCEPT_IN_PROGRESS/);
    expect(accept).toMatch(/isNull\(assetTransmissions\.acceptedAt\)/);
    expect(accept).toMatch(/releaseClaim\(\)/);
  });

  it('renvoie un message lisible, pas seulement un code', () => {
    const bloc = accept.slice(accept.indexOf("error: 'DUPLICATION_FAILED'"), accept.indexOf("error: 'DUPLICATION_FAILED'") + 300);
    expect(bloc).toMatch(/message: 'Le bien n’a pas pu être ajouté/);
  });

  it('crée la colonne archived_reason qu’elle écrit (migration idempotente)', () => {
    const sql = readFileSync(join(root, 'src/db/migrations/0164_assets_archived_reason.sql'), 'utf-8');
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS archived_reason/);
  });
});

describe('un seul e-mail par transmission', () => {
  it('la notification TRANSMISSION_RECEIVED n’envoie plus d’e-mail (cloche et push seulement)', () => {
    const entry = NOTIFICATION_CATALOG.TRANSMISSION_RECEIVED!;
    expect(entry.defaults.email).toBe(false);
    const rendered = entry.render({ senderName: 'Jean Martin', assetName: 'Polo', transmissionToken: 't' } as never);
    expect(rendered.emailTemplateCode).toBeUndefined();
  });

  it('l’invitation garde l’objet « Prénom Nom vous transmet un bien — Verebona », même avec un modèle en base', () => {
    expect(initiate).toMatch(/const subject = `\$\{opts\.senderName\} vous transmet un bien — Verebona`;/);
    expect(initiate).not.toMatch(/subject = tpl\.subject/);
  });
});

describe('acceptation robuste (revue)', () => {
  const src = readFileSync(join(process.cwd(), 'src/app/api/transmission/[token]/route.ts'), 'utf-8');
  it('une copie interrompue retire le bien copié et libère la réservation', () => {
    expect(src).toMatch(/const rollback = async/);
    expect(src).toMatch(/COPY_FAILED/);
  });
  it('une réservation abandonnée se reprend', () => {
    expect(src).toMatch(/lt\(assetTransmissions\.acceptedAt, new Date\(now\.getTime\(\) - CLAIM_TTL_MS\)\)/);
  });
  it('refus impossible pendant une acceptation ; acceptation écrite seulement si encore en attente', () => {
    expect(src).toMatch(/status: 'refused'[\s\S]*isNull\(assetTransmissions\.acceptedAt\)/);
    expect(src).toMatch(/status: 'accepted'[\s\S]*eq\(assetTransmissions\.status, 'pending'\)\)\)\s*\.returning/);
  });
  it('le bien source n’est archivé qu’après l’acceptation enregistrée', () => {
    expect(src.indexOf("status: 'accepted'")).toBeLessThan(src.indexOf("status: 'TRANSMIS'"));
  });
});


describe('identité du destinataire : la session, jamais le client', () => {
  const src = readFileSync(join(process.cwd(), 'src/app/api/transmission/[token]/route.ts'), 'utf-8');
  const post = src.slice(src.indexOf('export async function POST'));

  it('n’accepte plus de recipientUserId venant du corps de la requête', () => {
    expect(post).not.toMatch(/const \{[^}]*recipientUserId[^}]*\} = body/);
    expect(post).not.toMatch(/eq\(users\.id, recipientUserId\)/);
  });

  it('n’attribue plus le bien au compte de l’adresse invitée sans session', () => {
    // Sans session : on oriente (connexion / inscription), on ne copie rien.
    expect(post).toMatch(/if \(!session\) \{[\s\S]*?requiresLogin: true[\s\S]*?status: 401/);
    expect(post).toMatch(/requiresSignup: true/);
    const noSession = post.slice(post.indexOf('if (!session) {'), post.indexOf('const [sessionUser]'));
    expect(noSession).not.toMatch(/insert\(assets\)/);
  });

  it('refuse une session dont l’adresse n’est pas l’adresse invitée, avant toute copie', () => {
    expect(post).toMatch(/isInvitedRecipient\(row\.recipientEmail, sessionUser\.email\)/);
    expect(post).toMatch(/RECIPIENT_EMAIL_MISMATCH[\s\S]*?status: 403/);
    expect(post.indexOf('RECIPIENT_EMAIL_MISMATCH')).toBeLessThan(post.indexOf('.insert(assets)'));
    // L'adresse est relue en base, pas dans le jeton de session.
    expect(post).toMatch(/\.where\(eq\(users\.id, session\.userId\)\)/);
  });

  it('les pages suivent : connexion puis retour sur la transmission ; accueil signale un refus', () => {
    const page = readFileSync(join(process.cwd(), 'src/app/transmission/[token]/page.tsx'), 'utf-8');
    expect(page).toMatch(/data\.requiresLogin/);
    expect(page).toMatch(/returnUrl=\$\{encodeURIComponent\(`\/transmission\//);
    expect(page).not.toMatch(/recipientUserId/);
    const accueil = readFileSync(join(process.cwd(), 'src/app/(dashboard)/accueil/page.tsx'), 'utf-8');
    expect(accueil).toMatch(/RECIPIENT_EMAIL_MISMATCH/);
  });
});
