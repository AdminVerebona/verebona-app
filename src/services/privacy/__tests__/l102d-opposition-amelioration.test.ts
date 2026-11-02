/**
 * Lot 102D — opposition à l'utilisation secondaire des données pour
 * l'amélioration.
 *
 *   L102D-O01  qui peut changer le réglage (opposer : membre ; retirer :
 *              titulaire ou auteur)
 *   L102D-O02  une seule écriture SQL de la règle (compte, capture)
 *   L102D-O03  usages d'amélioration branchés : qualification (comptes et
 *              rejeu), exports d'exécutions IA
 *   L102D-O04  export : contenu d'un compte opposé jamais exporté
 *   L102D-O05  écrans : Mon compte (web + app), BO ; libellés factuels
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  IMPROVEMENT_OPT_OUT_TEXT, canChangeImprovementOptOut, improvementAccountAllowedSql, improvementCaptureUsableSql,
  improvementProofLabel, privacyPolicyUrl,
} from '../improvement-opt-out-rules';
import { exchangeOf } from '@/services/ai/business-execution/export';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('L102D-O01 — droits', () => {
  const cur = (optOut: boolean, by: number | null = 7) => ({ optOut, optedOutByUserId: by });
  it('opposer : tout membre actif', () => {
    expect(canChangeImprovementOptOut({ role: 'member', userId: 9, wantOptOut: true, current: cur(false) })).toBe(true);
    expect(canChangeImprovementOptOut({ role: null, userId: 9, wantOptOut: true, current: null })).toBe(false);
  });
  it('retirer : titulaire ou auteur seulement', () => {
    expect(canChangeImprovementOptOut({ role: 'owner', userId: 1, wantOptOut: false, current: cur(true) })).toBe(true);
    expect(canChangeImprovementOptOut({ role: 'member', userId: 7, wantOptOut: false, current: cur(true) })).toBe(true);
    expect(canChangeImprovementOptOut({ role: 'member', userId: 9, wantOptOut: false, current: cur(true) })).toBe(false);
  });
  it('preuve : libellé exact de l’action', () => {
    expect(improvementProofLabel(true)).toBe(`${IMPROVEMENT_OPT_OUT_TEXT.switchLabel} — activé`);
    expect(improvementProofLabel(false)).toBe(`${IMPROVEMENT_OPT_OUT_TEXT.switchLabel} — désactivé`);
  });
});

describe('L102D-O02 — prédicats SQL', () => {
  it('compte : opposition active ; capture : opposition active OU capture antérieure à la fin de l’opposition', () => {
    expect(improvementAccountAllowedSql('a.id')).toMatch(/account_data_use_preferences[\s\S]*a\.id[\s\S]*improvement_opt_out/);
    const c = improvementCaptureUsableSql('c');
    expect(c).toMatch(/^NOT EXISTS/);
    expect(c).toContain('c.captured_at < adup.excluded_before');
    expect(c).toContain('adup.account_id = c.account_id');
  });
});

describe('L102D-O03 — usages d’amélioration branchés', () => {
  it('qualification : comptes éligibles et rejeu des captures filtrés', () => {
    const repo = read('src/services/ai/qualification/repository.ts');
    expect(repo).toMatch(/eligibleAccountIds[\s\S]*improvementAccountAllowedSql\('a\.id'\)/);
    expect(repo).toMatch(/loadReplayCaptures[\s\S]*improvementCaptureUsableSql\('c'\)/);
  });
  it('exports d’exécutions IA : exclusion calculée par capture', () => {
    expect(read('src/services/ai/business-execution/export.ts')).toContain("improvementCaptureUsableSql('ai_call_captures')");
  });
});

describe('L102D-O04 — export : contenu exclu', () => {
  const capture = {
    capture_status: 'CAPTURED', prompt_status: 'CAPTURED', response_status: 'CAPTURED',
    prompt_text_len: 12, prompt_text_sha: 'aa', prompt_text: 'texte privé',
    response_raw_len: 5, response_raw_sha: 'bb', response_raw: 'privé',
  };
  it('compte non opposé, administrateur habilité : contenu présent', () => {
    expect(JSON.stringify(exchangeOf({ ...capture, improvement_excluded: false }, true))).toContain('texte privé');
  });
  it('compte opposé : contenu retiré même pour un administrateur habilité (longueur et empreinte seules)', () => {
    const out = exchangeOf({ ...capture, improvement_excluded: true }, true);
    const json = JSON.stringify(out);
    expect(json).not.toContain('privé');
    expect(json).toContain('"$etat":"exclu"');
    expect(out.exclusion).toMatch(/opposition/);
  });
});

describe('L102D-O05 — écrans et libellés', () => {
  it('Mon compte : carte Confidentialité (canal web / mobile) ; BO : fiche Compte', () => {
    expect(read('src/app/(dashboard)/mon-compte/page.tsx')).toContain('<PrivacyCard />');
    const card = read('src/components/account/PrivacyCard.tsx');
    expect(card).toContain("isNativeApp() ? 'mobile' : 'web'");
    expect(card).toContain('/api/users/me/data-use');
    expect(read('src/app/admin/accounts/[id]/page.tsx')).toContain('<AccountDataUse accountId={account.id} />');
  });
  it('libellés factuels, sans « Opération », avec la politique publique', () => {
    const all = Object.values(IMPROVEMENT_OPT_OUT_TEXT).filter((v) => typeof v === 'string').join(' ');
    expect(all).not.toMatch(/Opération/);
    expect(all).toMatch(/entraîner les modèles généraux/);
    expect(privacyPolicyUrl({ NEXT_PUBLIC_PUBLIC_SITE_URL: 'https://preprod.verebona.fr' })).toBe('https://preprod.verebona.fr/legal/confidentialite');
  });
});
