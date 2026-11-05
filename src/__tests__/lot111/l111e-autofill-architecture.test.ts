/**
 * Lot 111E — remplissage automatique des mots de passe : test d'ARCHITECTURE
 * et inventaire des formulaires d'authentification.
 *
 * ARCH-01 tout champ de mot de passe de l'application (`<PasswordInput>`, ou
 *         `<Input|input|AutofillInput type="password">`) déclare `id`, `name`
 *         et un `autoComplete` valide (« current-password » / « new-password »)
 *         — un NOUVEAU champ sans ces attributs fait échouer ce test. Seule
 *         exception listée : la clé d'API fournisseur du BO (pas un
 *         identifiant de l'administrateur → « off » assumé).
 * ARCH-02 chaque fichier qui contient un champ de mot de passe le place dans
 *         un vrai <form> et lui associe un <Label htmlFor> (id littéral).
 * ARCH-03 aucun faux autoComplete="off" sur un identifiant ou un mot de passe
 *         d'un parcours d'authentification.
 * INV-*   inventaire : attributs attendus de CHAQUE formulaire (connexion,
 *         inscription, mot de passe oublié / réinitialisation / changement /
 *         ajout, activation, rattachement social, réauthentification, écrans
 *         MFA 110B — attributs seulement).
 * RENDU-* rendu serveur réel de la connexion et de l'inscription.
 */
import * as React from 'react';
import { createElement as h } from 'react';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { PASSWORD_AUTOCOMPLETE_VALUES } from '@/lib/auth/autofill';

(globalThis as { React?: typeof React }).React = React;
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/login',
}));

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (e === 'node_modules' || e === '__tests__' || e === 'fixtures') continue;
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (p.endsWith('.tsx') && !/\.test\.tsx$/.test(p)) out.push(p);
  }
  return out;
}

/** Extrait le texte d'une balise JSX ouvrante à partir de `start` (accolades et chaînes équilibrées). */
function tagAt(src: string, start: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === quote && src[i - 1] !== '\\') quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) return src.slice(start, i + 1);
  }
  return src.slice(start);
}

interface Field { file: string; tag: string }

function fieldsOf(file: string, src: string, pattern: RegExp, keep: (tag: string) => boolean): Field[] {
  const out: Field[] = [];
  for (const m of src.matchAll(pattern)) {
    const tag = tagAt(src, m.index!);
    if (keep(tag)) out.push({ file, tag });
  }
  return out;
}

const FILES = walk(join(ROOT, 'src')).map((abs) => ({ rel: relative(ROOT, abs), src: readFileSync(abs, 'utf8') }));
const PASSWORD_FIELDS: Field[] = FILES.flatMap(({ rel, src }) => [
  ...fieldsOf(rel, src, /<PasswordInput\b/g, () => !/password-input\.tsx$/.test(rel)),
  ...fieldsOf(rel, src, /<(?:Input|input|AutofillInput)\b/g, (t) => /\btype=["']password["']/.test(t)),
]);

/** Valeur d'autoComplete : littéral, ou constante AUTOFILL.* résolue. */
function autoCompleteOf(tag: string): string | null {
  const lit = /\bautoComplete=["']([^"']+)["']/.exec(tag);
  if (lit) return lit[1];
  const cst = /\bautoComplete=\{AUTOFILL\.(\w+)\}/.exec(tag);
  if (cst) return ({ username: 'username', currentPassword: 'current-password', newPassword: 'new-password', oneTimeCode: 'one-time-code' } as Record<string, string>)[cst[1]] ?? null;
  return null;
}
const attr = (tag: string, name: string) => new RegExp(`\\b${name}=["']([^"']+)["']`).exec(tag)?.[1] ?? null;

/** Exceptions JUSTIFIÉES (fichier → autoComplete admis). */
const EXCEPTIONS: Record<string, string> = {
  // Clé d'API du fournisseur IA (BO) : secret technique, pas l'identifiant de l'administrateur.
  'src/app/admin/ai-provider/page.tsx': 'off',
};

describe('L111E — architecture des champs de mot de passe', () => {
  it('ARCH-00 — l’inventaire automatique trouve bien les champs connus', () => {
    const files = new Set(PASSWORD_FIELDS.map((f) => f.file));
    for (const f of [
      'src/app/(auth)/login/page.tsx', 'src/app/(auth)/signup/SignupForm.tsx', 'src/app/(auth)/reset-password/page.tsx',
      'src/app/(auth)/verify-email/activer/page.tsx', 'src/app/(auth)/connexion-sociale/page.tsx',
      'src/components/account/security/ReauthProvider.tsx', 'src/components/account/security/SecurityCard.tsx',
      'src/components/account/security/SignInMethodsBlock.tsx',
    ]) expect(files, f).toContain(f);
    expect(PASSWORD_FIELDS.length).toBeGreaterThanOrEqual(12);
  });

  it('ARCH-01 — chaque champ de mot de passe a id, name et un autoComplete valide', () => {
    const bad = PASSWORD_FIELDS.filter(({ file, tag }) => {
      const ac = autoCompleteOf(tag);
      const allowed = EXCEPTIONS[file] ? [EXCEPTIONS[file]] : PASSWORD_AUTOCOMPLETE_VALUES;
      const needsId = !EXCEPTIONS[file];
      return !ac || !allowed.includes(ac) || !/\bname=/.test(tag) || (needsId && !/\bid=/.test(tag));
    }).map(({ file, tag }) => `${file} : ${tag.replace(/\s+/g, ' ').slice(0, 160)}`);
    expect(bad).toEqual([]);
  });

  it('ARCH-02 — champ de mot de passe dans un vrai <form>, libellé associé', () => {
    const problems: string[] = [];
    for (const { file, tag } of PASSWORD_FIELDS) {
      if (EXCEPTIONS[file]) continue;
      const src = read(file);
      if (!/<form\b/.test(src)) problems.push(`${file} : aucun <form>`);
      const id = attr(tag, 'id');
      if (id && !src.includes(`htmlFor="${id}"`)) problems.push(`${file} : pas de <Label htmlFor="${id}">`);
    }
    expect(problems).toEqual([]);
  });

  it('ARCH-03 — aucun autoComplete="off" sur un identifiant ou un mot de passe des parcours d’authentification', () => {
    const AUTH = FILES.filter(({ rel }) => rel.startsWith('src/app/(auth)/') || rel.startsWith('src/components/account/security/') || rel.startsWith('src/components/auth/'));
    const bad = AUTH.flatMap(({ rel, src }) => fieldsOf(rel, src, /<(?:Input|input|AutofillInput|PasswordInput)\b/g, (t) =>
      /autoComplete=["']off["']/.test(t) && (/type=["'](password|email)["']/.test(t) || /<PasswordInput/.test(t)),
    )).map((f) => f.file);
    expect(bad).toEqual([]);
  });
});

/** Inventaire : chaque formulaire et les attributs attendus (sous-chaînes du source). */
const INVENTORY: Array<{ id: string; file: string; expect: string[]; not?: string[] }> = [
  { id: 'INV-01 connexion', file: 'src/app/(auth)/login/page.tsx', expect: ['name="username"', 'type="email"', 'inputMode="email"', 'autoComplete={AUTOFILL.username}', 'name="password"', 'autoComplete={AUTOFILL.currentPassword}', 'htmlFor="email"', 'htmlFor="password"', "formFieldValue(e.currentTarget, 'username'", "formFieldValue(e.currentTarget, 'password'"] },
  { id: 'INV-02 inscription', file: 'src/app/(auth)/signup/SignupForm.tsx', expect: ['id="displayName"', 'name="displayName"', 'autoComplete="nickname"', 'name="username"', 'autoComplete={AUTOFILL.username}', 'name="new-password"', 'name="confirm-password"', 'autoComplete={AUTOFILL.newPassword}'], not: ['id="username"', 'autoComplete="email"'] },
  { id: 'INV-03 mot de passe oublié', file: 'src/app/(auth)/forgot-password/page.tsx', expect: ['name="username"', 'type="email"', 'inputMode="email"', 'autoComplete={AUTOFILL.username}'] },
  { id: 'INV-04 réinitialisation', file: 'src/app/(auth)/reset-password/page.tsx', expect: ['<PasswordInput', 'name="new-password"', 'name="confirm-password"', 'autoComplete={AUTOFILL.newPassword}', "formFieldValue(e.currentTarget, 'new-password'"] },
  { id: 'INV-05 activation (mot de passe initial)', file: 'src/app/(auth)/verify-email/activer/page.tsx', expect: ['name="password"', 'autoComplete={AUTOFILL.currentPassword}', "formFieldValue(e.currentTarget, 'password'"], not: ['disabled={busy || !password}'] },
  { id: 'INV-06 rattachement social', file: 'src/app/(auth)/connexion-sociale/page.tsx', expect: ['id="link-email" name="username" type="email" inputMode="email" autoComplete={AUTOFILL.username}', 'name="password" autoComplete={AUTOFILL.currentPassword}', 'name="one-time-code" inputMode="numeric" autoComplete="one-time-code"'] },
  { id: 'INV-07 réauthentification', file: 'src/components/account/security/ReauthProvider.tsx', expect: ['name="password"', 'autoComplete="current-password"', 'name="one-time-code" inputMode="numeric" autoComplete="one-time-code"'] },
  { id: 'INV-08 changement', file: 'src/components/account/security/SecurityCard.tsx', expect: ['<HiddenUsernameField value={accountEmail} />', 'name="new-password"', 'name="confirm-password"', 'setForm((f) => ({ ...f, newPassword: v }))', 'setForm((f) => ({ ...f, confirmPassword: v }))'], not: ['setForm({ ...form,'] },
  { id: 'INV-09 ajout de mot de passe', file: 'src/components/account/security/SignInMethodsBlock.tsx', expect: ['<HiddenUsernameField value={summary.email} />', 'name="new-password"', 'name="confirm-password"', 'autoComplete={AUTOFILL.newPassword}'] },
  { id: 'INV-10 MFA seconde étape', file: 'src/app/(auth)/verification/page.tsx', expect: ['name="one-time-code" inputMode="numeric" autoComplete="one-time-code"'] },
  { id: 'INV-11 MFA activation TOTP', file: 'src/components/auth/mfa/TotpSetup.tsx', expect: ['name="one-time-code" inputMode="numeric" autoComplete="one-time-code"'] },
  { id: 'INV-12 récupération MFA', file: 'src/app/(auth)/recuperation/page.tsx', expect: ['name="username" type="email" inputMode="email" autoComplete="username"', 'name="one-time-code" inputMode="numeric" autoComplete="one-time-code"'] },
];

describe('L111E — inventaire des formulaires d’authentification', () => {
  for (const f of INVENTORY) {
    it(`${f.id} — ${f.file}`, () => {
      const src = read(f.file);
      expect(src).toMatch(/<form\b/);
      for (const s of f.expect) expect(src, s).toContain(s);
      for (const s of f.not ?? []) expect(src, s).not.toContain(s);
    });
  }

  it('INV-13 — composants : PasswordInput et AutofillInput resynchronisent l’état ; PasswordInput remasque à l’envoi', () => {
    const pi = read('src/components/ui/password-input.tsx');
    expect(pi).toContain('useAutofillSync(inner, props.value, props.onChange)');
    expect(pi).toMatch(/form\.addEventListener\("submit", hide, true\)/);
    expect(pi).toContain('aria-pressed={visible}');
    expect(read('src/components/ui/autofill-input.tsx')).toContain('useAutofillSync(inner, props.value, props.onChange)');
    const hook = read('src/components/ui/use-autofill-sync.ts');
    expect(hook).toContain('addEventListener("input"');
    expect(hook).toContain('addEventListener("change"');
    expect(hook).not.toMatch(/console\./); // aucune valeur journalisée
  });

  it('INV-14 — identifiant invisible des formulaires de nouveau mot de passe : lecture seule, hors tabulation, autocomplete=username', () => {
    const src = read('src/components/auth/HiddenUsernameField.tsx');
    for (const s of ['name="username"', 'autoComplete="username"', 'readOnly', 'tabIndex={-1}', 'aria-hidden="true"']) expect(src).toContain(s);
  });
});

describe('L111E — rendu réel', () => {
  it('RENDU-01 — connexion : attributs rendus (identifiant + mot de passe actuel, libellés, vrai formulaire POST)', async () => {
    const { default: LoginPage } = await import('@/app/(auth)/login/page');
    const out = renderToStaticMarkup(h(LoginPage));
    expect(out).toMatch(/<form[^>]*method="post"/);
    expect(out).toMatch(/<input[^>]*id="email"[^>]*>/);
    const email = /<input[^>]*id="email"[^>]*>/.exec(out)![0];
    for (const s of ['name="username"', 'type="email"', 'inputMode="email"', 'autoComplete="username"']) expect(email).toContain(s);
    const pwd = /<input[^>]*id="password"[^>]*>/.exec(out)![0];
    for (const s of ['name="password"', 'type="password"', 'autoComplete="current-password"']) expect(pwd).toContain(s);
    expect(out).toContain('for="email"');
    expect(out).toContain('for="password"');
    expect(out).not.toMatch(/autoComplete="off"/i);
  });

  it('RENDU-02 — inscription : nom affiché distinct de l’identifiant ; e-mail = username ; deux new-password', async () => {
    const { SignupForm } = await import('@/app/(auth)/signup/SignupForm');
    const out = renderToStaticMarkup(h(SignupForm, {}));
    const inputs = out.match(/<input[^>]*>/g) ?? [];
    const byName = (n: string) => inputs.find((i) => i.includes(`name="${n}"`)) ?? '';
    expect(byName('displayName')).toContain('autoComplete="nickname"');
    expect(byName('username')).toContain('autoComplete="username"');
    expect(byName('username')).toContain('type="email"');
    expect(byName('new-password')).toContain('autoComplete="new-password"');
    expect(byName('confirm-password')).toContain('autoComplete="new-password"');
    expect(inputs.filter((i) => i.includes('autoComplete="username"'))).toHaveLength(1);
  });
});
