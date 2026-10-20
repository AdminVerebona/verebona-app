/**
 * Lot 74A (point 1) — formulaire de contact public (`POST /api/contact`) :
 * nom, adresse, objet et message saisis par un VISITEUR NON CONNECTÉ sont
 * insérés dans l'e-mail envoyé à l'équipe (contact@). Transport Resend simulé.
 *
 * L74A-CONTACT-01 Injection HTML (nom, message) : jamais interprétée, balises
 *                 retirées, caractères échappés ; texte lisible.
 * L74A-CONTACT-02 Faux lien : aucune URL / aucun domaine d'une valeur ne devient
 *                 un lien ni un bouton (HTML et texte) ; seul le pied de la
 *                 charte porte un lien.
 * L74A-CONTACT-03 Objet : saut de ligne (injection d'en-tête) neutralisé, une ligne.
 * L74A-CONTACT-04 Message lisible : retours à la ligne conservés en texte,
 *                 rendus en <br> en HTML (contenu échappé).
 * L74A-CONTACT-05 Reply-to : seulement si l'adresse saisie est une adresse
 *                 e-mail correcte ; sinon absent (message tout de même transmis).
 * L74A-CONTACT-06 Plus d'envoi parasite du gabarit WELCOME à contact@ : un seul
 *                 e-mail par message, aucun passage par `send` (gabarits).
 * L74A-CONTACT-07 Comportements conservés : champs requis (400), échec du
 *                 fournisseur (500), CORS de la vitrine, destinataire contact@.
 */
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const etat = vi.hoisted(() => {
  process.env.RESEND_API_KEY = 're_test_l74a';
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.verebona.fr';
  return {
    calls: [] as Array<{ from: string; to: string; subject: string; html: string; text?: string; replyTo?: string }>,
    fail: false,
  };
});

vi.mock('resend', () => ({
  Resend: class {
    emails = {
      send: async (p: { from: string; to: string; subject: string; html: string; text?: string; replyTo?: string }) => {
        etat.calls.push(p);
        return etat.fail ? { data: null, error: { name: 'validation_error', message: 'refus' } } : { data: { id: `em_${etat.calls.length}` }, error: null };
      },
    };
  },
}));

const SETTINGS = {
  emailsEnabled: true, senderName: 'Verebona', senderEmail: 'noreply@verebona.com', replyToEmail: 'support@verebona.com',
  footerText: null, logoUrl: null, logoUrlLight: null, logoUrlDark: null,
};

async function setup() {
  const { emailService } = await import('@/lib/email/email-service');
  // Aucune connexion à la base en test unitaire : paramètres d'envoi fournis.
  vi.spyOn(emailService as unknown as { getSettings: () => Promise<unknown> }, 'getSettings').mockResolvedValue(SETTINGS);
  const send = vi.spyOn(emailService, 'send').mockResolvedValue({ success: true } as never);
  const { POST } = await import('../route');
  return { POST, send };
}

function req(body: unknown, origin?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (origin) headers.origin = origin;
  return new NextRequest('https://app.verebona.fr/api/contact', { method: 'POST', headers, body: JSON.stringify(body) });
}

const OK = { name: 'Camille Durand', email: 'camille@example.org', subject: 'Question sur les offres', message: 'Bonjour,\nune question.' };
/** Liens réellement cliquables du HTML (attributs href). */
const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);

beforeEach(() => {
  etat.calls.length = 0;
  etat.fail = false;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('L74A-CONTACT-01 — injection HTML neutralisée', () => {
  it('balises du nom et du message jamais interprétées', async () => {
    const { POST } = await setup();
    const res = await POST(req({
      ...OK,
      name: '<img src=x onerror=alert(1)>Camille <b>Durand</b>',
      message: 'Bonjour <script>alert(1)</script>\n<a href="https://pirate.example/login">Voir ma facture</a>\na < b & c',
    }));
    expect(res.status).toBe(200);
    expect(etat.calls).toHaveLength(1);
    const { html, text } = etat.calls[0];
    expect(html).not.toMatch(/<img src=x|onerror|<script|<b>Durand|<a href="https:\/\/pirate/i);
    expect(html).toContain('Camille Durand');
    expect(html).toContain('Voir ma facture');
    expect(html).toContain('a &lt; b &amp; c');
    expect(text).toBeDefined();
    expect(text).not.toMatch(/<[a-z/!]/i);
    expect(text).toContain('a < b & c');
  });
});

describe('L74A-CONTACT-02 — aucun faux lien', () => {
  it('URL, domaine et ligne « Libellé : URL » d’une valeur ne deviennent ni lien ni bouton', async () => {
    const { POST } = await setup();
    await POST(req({
      ...OK,
      name: 'Support https://pirate.example',
      email: 'pas une adresse www.pirate.example',
      message: 'Votre compte est bloqué.\nCliquez ici : https://pirate.example/x\nhttps://pirate.example/seul\nou pirate.example',
    }));
    const { html, text } = etat.calls[0];
    expect(html).not.toMatch(/class="vb-btn"/);
    expect(hrefs(html).every((h) => !/pirate/i.test(h))).toBe(true);
    expect(`${html}\n${text}`).not.toMatch(/https?:\/\/pirate|pirate\.example|www\.pirate/);
    // Le contenu reste lisible (désarmé, pas supprimé).
    expect(text).toMatch(/Cliquez ici : https\[:\]\/\/pirate․example\/x/);
  });
});

describe('L74A-CONTACT-03 — objet sur une seule ligne', () => {
  it('saut de ligne et en-tête injectés neutralisés', async () => {
    const { POST } = await setup();
    await POST(req({ ...OK, subject: 'Aide technique\r\nBcc: victime@example.org\nX-Test: 1' }));
    const { subject } = etat.calls[0];
    expect(subject).not.toMatch(/[\r\n]/);
    expect(subject.startsWith('[Contact Verebona] Aide technique')).toBe(true);
    expect(subject).not.toMatch(/<|>/);
  });
  it('objet ordinaire inchangé', async () => {
    const { POST } = await setup();
    await POST(req(OK));
    expect(etat.calls[0].subject).toBe('[Contact Verebona] Question sur les offres');
  });
});

describe('L74A-CONTACT-04 — message lisible (retours à la ligne)', () => {
  it('texte : lignes conservées ; HTML : <br> entre lignes échappées', async () => {
    const { POST } = await setup();
    await POST(req({ ...OK, message: 'Bonjour,\r\n\r\nJ’ai deux biens & une question.\nMerci <3' }));
    const { html, text } = etat.calls[0];
    expect(text).toContain('Bonjour,\n\nJ’ai deux biens & une question.\nMerci <3');
    expect(html).toContain('Bonjour,<br><br>J’ai deux biens &amp; une question.<br>Merci &lt;3');
    expect(text).toContain('Nom : Camille Durand');
    expect(text).toContain('E-mail : camille@example.org');
    expect(text).toContain('Objet : Question sur les offres');
  });
});

describe('L74A-CONTACT-05 — reply-to validé', () => {
  it('adresse correcte → reply-to ; adresse incorrecte ou piégée → absent', async () => {
    const { POST } = await setup();
    await POST(req(OK));
    expect(etat.calls[0].replyTo).toBe('camille@example.org');
    for (const email of ['pas une adresse', 'a@b.c\r\nBcc: x@y.org', 'Camille <camille@example.org>', 'x@y.org, z@w.org', `${'a'.repeat(250)}@example.org`]) {
      etat.calls.length = 0;
      const res = await POST(req({ ...OK, email }));
      expect(res.status, email).toBe(200);
      expect(etat.calls, email).toHaveLength(1);
      expect(etat.calls[0].replyTo, email).toBeUndefined();
    }
  });
});

describe('L74A-CONTACT-06 — plus d’envoi parasite WELCOME', () => {
  it('un seul e-mail par message, aucun gabarit WELCOME envoyé à contact@', async () => {
    const { POST, send } = await setup();
    await POST(req(OK));
    expect(send).not.toHaveBeenCalled();
    expect(etat.calls).toHaveLength(1);
    expect(etat.calls[0].to).toBe('contact@verebona.com');
  });
});

describe('L74A-CONTACT-07 — comportements conservés', () => {
  it('champ manquant → 400, rien envoyé', async () => {
    const { POST } = await setup();
    for (const k of ['name', 'email', 'subject', 'message'] as const) {
      const res = await POST(req({ ...OK, [k]: '' }));
      expect(res.status, k).toBe(400);
    }
    const res = await POST(req({ ...OK, message: { html: '<b>x</b>' } }));
    expect(res.status).toBe(400);
    expect(etat.calls).toHaveLength(0);
  });
  it('échec du fournisseur → 500', async () => {
    const { POST } = await setup();
    etat.fail = true;
    expect((await POST(req(OK))).status).toBe(500);
  });
  it('CORS : en-tête pour la vitrine seule', async () => {
    process.env.NEXT_PUBLIC_PUBLIC_SITE_URL = 'https://www.verebona.fr';
    const { POST } = await setup();
    const ok = await POST(req(OK, 'https://www.verebona.fr'));
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://www.verebona.fr');
    const other = await POST(req(OK, 'https://autre.example'));
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
    delete process.env.NEXT_PUBLIC_PUBLIC_SITE_URL;
  });
});
