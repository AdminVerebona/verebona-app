/**
 * Lot 109F — classificateur des e-mails jetables (`isDisposableEmailDomain`),
 * référentiel versionné, garde serveur. Ticket §3, §6 (cas particuliers).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const sqlCalls: string[] = [];
vi.mock('@/db', () => ({
  pgClient: (strings: TemplateStringsArray) => { sqlCalls.push(strings.join('?')); return Promise.resolve([]); },
}));

import {
  classifyEmailDomain, disposableListStatus, domainCandidates, isDisposableEmailDomain, normalizeEmailDomain, setDisposableListForTests,
} from '@/lib/auth/disposable-email';
import { DISPOSABLE_EMAIL_MESSAGE, DISPOSABLE_EMAIL_NOT_ALLOWED, isDisposableEmailRefusal } from '@/lib/auth/disposable-email/messages';
import { LOCAL_ALLOWLIST, MIN_VALID_LIST_SIZE } from '@/lib/auth/disposable-email/policy';
import domains from '@/lib/auth/disposable-email/data/disposable-domains.json';
import source from '@/lib/auth/disposable-email/data/source.json';

const root = process.cwd();
const filler = Array.from({ length: MIN_VALID_LIST_SIZE }, (_, i) => `remplissage-${i}.test`);

afterEach(() => {
  delete process.env.DISPOSABLE_EMAIL_ALLOWLIST;
  delete process.env.DISPOSABLE_EMAIL_EXTRA_BLOCKLIST;
  setDisposableListForTests(undefined);
});

describe('L109F — message et code uniques', () => {
  it('message EXACT du ticket, code unique', () => {
    expect(DISPOSABLE_EMAIL_NOT_ALLOWED).toBe('DISPOSABLE_EMAIL_NOT_ALLOWED');
    expect(DISPOSABLE_EMAIL_MESSAGE).toBe('Les adresses e-mail temporaires ne sont pas acceptées. Utilisez une adresse e-mail que vous conservez.');
    expect(isDisposableEmailRefusal({ code: 'DISPOSABLE_EMAIL_NOT_ALLOWED' })).toBe(true);
    expect(isDisposableEmailRefusal({ code: 'DUPLICATE_EMAIL' })).toBe(false);
    expect(isDisposableEmailRefusal(null)).toBe(false);
  });
  it('message identique dans la confirmation de changement d’adresse', async () => {
    const { CONFIRM_MESSAGES } = await import('@/services/auth/email-change.service');
    expect(CONFIRM_MESSAGES.DISPOSABLE_EMAIL_NOT_ALLOWED).toBe(DISPOSABLE_EMAIL_MESSAGE);
  });
});

describe('L109F — classificateur', () => {
  it('domaines jetables connus refusés', () => {
    for (const e of ['a@mailinator.com', 'b@yopmail.com', 'c@yopmail.fr', 'd@guerrillamail.com', 'e@10minutemail.com', 'f@jetable.org', 'trashmail.com']) {
      expect(isDisposableEmailDomain(e), e).toBe(true);
    }
    expect(classifyEmailDomain('x@yopmail.com')).toMatchObject({ disposable: true, matched: 'yopmail.com', decidedBy: 'blocklist', listVersion: source.version, listAvailable: true });
  });

  it('normalisation : casse, espaces (insécables, invisibles), point final', () => {
    expect(normalizeEmailDomain('  Jean.Dupont@YopMail.COM  ')).toBe('yopmail.com');
    expect(normalizeEmailDomain('jean@ yopmail.com.​')).toBe('yopmail.com');
    expect(isDisposableEmailDomain('  Jean@YOPMAIL.COM ')).toBe(true);
    expect(isDisposableEmailDomain('jean@yopmail.com.')).toBe(true);
    expect(normalizeEmailDomain('')).toBeNull();
    expect(normalizeEmailDomain(42)).toBeNull();
    expect(isDisposableEmailDomain(undefined)).toBe(false);
  });

  it('forme internationale (IDN) : Unicode et punycode équivalents', () => {
    expect(normalizeEmailDomain('marie@exämple.de')).toBe('xn--exmple-cua.de');
    process.env.DISPOSABLE_EMAIL_EXTRA_BLOCKLIST = 'jetäble.example';
    expect(isDisposableEmailDomain('a@jetäble.example')).toBe(true);
    expect(isDisposableEmailDomain('a@JETÄBLE.example')).toBe(true);
    expect(isDisposableEmailDomain(`a@${normalizeEmailDomain('jetäble.example')}`)).toBe(true);
    expect(isDisposableEmailDomain('a@exämple.de')).toBe(false);
  });

  it('jamais sur un alias +, un domaine inconnu, personnalisé, professionnel ou un grand fournisseur', () => {
    for (const e of [
      'jean+verebona@gmail.com', 'jean@outlook.fr', 'jean@hotmail.com', 'jean@orange.fr', 'jean@free.fr', 'jean@laposte.net',
      'contact@cabinet-durand-avocats.fr', 'moi@famille-martin.eu', 'x@domaine-totalement-inconnu.example', 'jean@sous.domaine.entreprise.fr',
      'alias@mozmail.com', 'alias@duck.com', 'alias@simplelogin.com', 'jean@proton.me',
    ]) {
      expect(isDisposableEmailDomain(e), e).toBe(false);
    }
    // L'alias « + » n'intervient jamais : seul le domaine compte.
    expect(isDisposableEmailDomain('jean+test@yopmail.com')).toBe(true);
  });

  it('relais Apple « Masquer mon adresse e-mail » toujours autorisé (liste d’autorisation prioritaire)', () => {
    expect(classifyEmailDomain('abc123@privaterelay.appleid.com')).toMatchObject({ disposable: false, decidedBy: 'allowlist' });
    // Même si une liste (référentiel ou urgence) l'ajoutait par erreur.
    process.env.DISPOSABLE_EMAIL_EXTRA_BLOCKLIST = 'privaterelay.appleid.com, gmail.com';
    setDisposableListForTests([...filler, 'privaterelay.appleid.com', 'gmail.com']);
    expect(isDisposableEmailDomain('abc123@privaterelay.appleid.com')).toBe(false);
    expect(isDisposableEmailDomain('jean@gmail.com')).toBe(false);
  });

  it('sous-domaines : règle explicite (domaine ou parent listé tel quel, au moins deux niveaux), non agressive', () => {
    expect(domainCandidates('a.b.yopmail.com')).toEqual(['a.b.yopmail.com', 'b.yopmail.com', 'yopmail.com']);
    expect(domainCandidates('localhost')).toEqual([]);
    expect(isDisposableEmailDomain('x@mail.yopmail.com')).toBe(true);
    expect(isDisposableEmailDomain('x@a.b.mailinator.com')).toBe(true);
    // Jamais de « voisin » ni de suffixe partiel, jamais un domaine qui CONTIENT un nom listé.
    expect(isDisposableEmailDomain('x@notyopmail.com')).toBe(false);
    expect(isDisposableEmailDomain('x@yopmail.com.mon-entreprise.fr')).toBe(false);
    expect(isDisposableEmailDomain('x@yopmail')).toBe(false);
    // Une entrée de 3e niveau (suffixe public) ne bloque pas son parent.
    expect(isDisposableEmailDomain('x@co.uk')).toBe(false);
  });

  it('liste d’autorisation d’exploitation (faux positif) prioritaire, domaine par domaine', () => {
    expect(isDisposableEmailDomain('x@yopmail.fr')).toBe(true);
    process.env.DISPOSABLE_EMAIL_ALLOWLIST = ' YopMail.FR ;autre.test';
    expect(classifyEmailDomain('x@yopmail.fr')).toMatchObject({ disposable: false, decidedBy: 'allowlist', matched: 'yopmail.fr' });
    expect(isDisposableEmailDomain('x@yopmail.com')).toBe(true); // le contrôle n'est pas relâché globalement
    // Un suffixe d'un seul niveau est ignoré (jamais d'autorisation globale).
    process.env.DISPOSABLE_EMAIL_ALLOWLIST = 'com';
    expect(isDisposableEmailDomain('x@yopmail.com')).toBe(true);
  });

  it('blocage d’urgence par variable d’environnement, appliqué sans redéploiement du référentiel', () => {
    expect(isDisposableEmailDomain('x@nouveau-jetable.test')).toBe(false);
    process.env.DISPOSABLE_EMAIL_EXTRA_BLOCKLIST = 'nouveau-jetable.test com';
    expect(classifyEmailDomain('x@nouveau-jetable.test')).toMatchObject({ disposable: true, decidedBy: 'extra_blocklist' });
    expect(isDisposableEmailDomain('x@exemple.com')).toBe(false); // « com » seul ignoré
  });

  it('référentiel momentanément indisponible (tronqué / illisible) : aucun blocage injustifié, listes d’urgence toujours appliquées', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    setDisposableListForTests(null);
    expect(classifyEmailDomain('x@yopmail.com')).toMatchObject({ disposable: false, listAvailable: false });
    expect(isDisposableEmailDomain('x@gmail.com')).toBe(false);
    process.env.DISPOSABLE_EMAIL_EXTRA_BLOCKLIST = 'yopmail.com';
    expect(isDisposableEmailDomain('x@yopmail.com')).toBe(true);
    setDisposableListForTests(['yopmail.com']); // tronqué : sous le minimum
    delete process.env.DISPOSABLE_EMAIL_EXTRA_BLOCKLIST;
    expect(isDisposableEmailDomain('x@yopmail.com')).toBe(false);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    // Mise à jour sans interruption : le nouveau référentiel remplace l'ancien d'un bloc.
    setDisposableListForTests([...filler, 'tout-nouveau-jetable.test']);
    expect(isDisposableEmailDomain('x@tout-nouveau-jetable.test')).toBe(true);
    expect(isDisposableEmailDomain('x@yopmail.com')).toBe(false);
  });

  it('état du référentiel : source, licence, version, âge — jamais la liste', () => {
    const st = disposableListStatus(new Date(source.fetchedAt));
    expect(st).toMatchObject({ license: 'CC0-1.0', version: source.version, count: source.count, available: true, ageDays: 0, stale: false });
    expect(JSON.stringify(st)).not.toContain('yopmail');
  });
});

describe('L109F — référentiel versionné (intégrité)', () => {
  const list = domains as string[];
  it('métadonnées cohérentes : nombre, empreinte, ordre, forme normalisée, licence CC0', async () => {
    expect(source).toMatchObject({ name: 'disposable-email-domains', license: 'CC0-1.0', count: list.length });
    expect(source.ref).toMatch(/^[0-9a-f]{40}$/);
    expect(source.version).toBe(`dea-${source.ref.slice(0, 7)}`);
    expect(createHash('sha256').update(list.join('\n')).digest('hex')).toBe(source.sha256);
    expect(list.length).toBeGreaterThanOrEqual(MIN_VALID_LIST_SIZE);
    expect([...list].sort()).toEqual(list);
    expect(new Set(list).size).toBe(list.length);
    const { normalizeDomain } = await import('../../../../../scripts/update-disposable-domains.mjs');
    for (const d of list) {
      expect(normalizeEmailDomain(d)).toBe(d);
      expect(normalizeDomain(d)).toBe(d);
      expect(d.split('.').length).toBeGreaterThanOrEqual(2);
    }
    for (const sample of ['  A@B.Fr. ', 'x@exämple.de', 'X@YOPMAIL.COM']) {
      expect(normalizeDomain(sample.split('@').pop()!)).toBe(normalizeEmailDomain(sample));
    }
    expect(readFileSync(join(root, 'src/lib/auth/disposable-email/data', source.licenseFile), 'utf8')).toMatch(/CC0 1\.0/);
  });

  it('aucun domaine de la liste d’autorisation locale dans le référentiel ; sentinelles du script = liste locale', () => {
    const set = new Set(list);
    expect(LOCAL_ALLOWLIST.filter((d) => set.has(d))).toEqual([]);
    const script = readFileSync(join(root, 'scripts/update-disposable-domains.mjs'), 'utf8');
    const block = script.slice(script.indexOf('const SENTINELS = ['), script.indexOf('];', script.indexOf('const SENTINELS = [')));
    const sentinels = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect([...sentinels].sort()).toEqual([...LOCAL_ALLOWLIST].sort());
  });
});

describe('L109F — garde serveur', () => {
  it('refus : code + message uniques, métrique agrégée (domaine de liste, jamais l’adresse) ; adresse acceptée : rien', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { checkDisposableEmail } = await import('@/services/auth/disposable-email-guard');
    const { settleDetachedAuthTasks } = await import('@/lib/auth/anti-enumeration');
    sqlCalls.length = 0;
    expect(checkDisposableEmail('jean.dupont+x@gmail.com', 'signup')).toBeNull();
    expect(checkDisposableEmail('jean.dupont@mail.yopmail.com', 'signup')).toEqual({ code: DISPOSABLE_EMAIL_NOT_ALLOWED, message: DISPOSABLE_EMAIL_MESSAGE });
    await settleDetachedAuthTasks();
    expect(sqlCalls.some((s) => s.includes('INSERT INTO disposable_email_refusals'))).toBe(true);
    const logged = info.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('domaine=yopmail.com');
    expect(logged).not.toContain('jean.dupont');
    info.mockRestore();
  });
});
