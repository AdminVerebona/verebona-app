/**
 * Information et choix sur les relances commerciales, À L'INSCRIPTION — lot
 * 102C (ticket conformité légale, P2 « Prospection post-essai » ; réponses
 * PO 3, E / E2 : « contrôle du consentement / de la base légale et
 * désinscription simple »). Moteur unique : la séquence de fin d'essai du
 * lot 100G (aucun second moteur) ; ce module ne fait que recueillir et
 * prouver ce qu'elle exige.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * SELON LA BASE LÉGALE RETENUE AU BO (BO › Communications › Fin d'essai)
 *
 *   consent      case d'acceptation NON pré-cochée ; cochée → consentement
 *                (`news_consents`, source `signup`) ;
 *   soft_opt_in  information + opposition simple et gratuite :
 *                · `opt_out_checkbox` : case « Je ne souhaite pas… » ;
 *                  cochée → opposition (`marketing_oppositions`) ;
 *                · `mention` : mention seule, opposition par le lien de
 *                  chaque e-mail ou Mon compte.
 *   Réglage désactivé (défaut) : rien n'est affiché ni enregistré.
 *
 * PREUVE (`marketing_collection_proofs`) : base, mécanisme, choix, version
 * et SHA-256 des libellés exacts présentés, lien Confidentialité affiché,
 * contexte (inscription locale / Google-Apple), date.
 *
 * Aucun texte juridique : libellés d'interface factuels ; renvoi au lien
 * public « Confidentialité » (base d'URL NEXT_PUBLIC_PUBLIC_SITE_URL,
 * chemin PUBLIC_PRIVACY_PATH, ou URL complète PUBLIC_PRIVACY_URL).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'node:crypto';
import { publicSiteUrl } from '@/lib/external-urls';
import { legalPublicUrl } from '@/lib/legal/public-legal';
import type { LegalBasis, SoftOptInMechanism, TrialLifecycleSettings } from './milestones';

export type CollectionMechanism = 'consent_checkbox' | 'opt_out_checkbox' | 'mention';
export type CollectionChoice = 'consented' | 'not_consented' | 'opposed' | 'not_opposed' | 'informed';

/** Bloc présenté sous le formulaire d'inscription (données, pas de JSX). */
export interface SignupNotice {
  legalBasis: LegalBasis;
  mechanism: CollectionMechanism;
  /** Phrase d'information (toujours affichée). */
  information: string;
  /** Libellé de la case, absent pour une mention seule. */
  checkboxLabel: string | null;
  /** Précision sous la case / la mention. */
  help: string;
  privacyLabel: string;
  privacyUrl: string;
  /** Version des libellés (change si un libellé change). */
  version: string;
  /** SHA-256 des libellés exacts présentés (preuve). */
  sha256: string;
}

/**
 * Lien public « Confidentialité ». Raccord 102B : sans argument, c'est la
 * configuration unique des liens légaux (`lib/legal/public-legal`, variable
 * `NEXT_PUBLIC_LEGAL_PRIVACY_URL`, adresses actuelles du site tant qu'il n'a
 * pas livré). Avec un `env` explicite : ancien calcul (tests, outils).
 */
export function privacyPolicyUrl(env?: Record<string, string | undefined>): string {
  if (!env) return legalPublicUrl('confidentialite');
  const full = (env.PUBLIC_PRIVACY_URL ?? '').trim();
  if (/^https:\/\//i.test(full)) return full;
  return publicSiteUrl((env.PUBLIC_PRIVACY_PATH ?? '').trim() || '/confidentialite');
}

const TEXTS: Record<CollectionMechanism, { information: string; checkboxLabel: string | null; help: string }> = {
  consent_checkbox: {
    information: 'Après votre essai gratuit, Verebona peut vous envoyer par e-mail des informations sur ses abonnements.',
    checkboxLabel: 'J’accepte de recevoir ces e-mails.',
    help: 'Facultatif. Vous pourrez retirer votre accord à tout moment, gratuitement, par le lien présent dans chaque e-mail ou depuis Mon compte.',
  },
  opt_out_checkbox: {
    information: 'Après votre essai gratuit, Verebona pourra vous envoyer par e-mail des informations sur ses abonnements.',
    checkboxLabel: 'Je ne souhaite pas recevoir ces e-mails.',
    help: 'Gratuit. Vous pourrez aussi vous y opposer à tout moment par le lien présent dans chaque e-mail ou depuis Mon compte.',
  },
  mention: {
    information: 'Après votre essai gratuit, Verebona pourra vous envoyer par e-mail des informations sur ses abonnements.',
    checkboxLabel: null,
    help: 'Vous pouvez vous y opposer à tout moment, gratuitement, par le lien présent dans chaque e-mail ou depuis Mon compte.',
  },
};

const NOTICE_VERSION = 'l102c-v1';
const PRIVACY_LABEL = 'Politique de confidentialité';

export function mechanismFor(basis: LegalBasis, softOptIn: SoftOptInMechanism): CollectionMechanism {
  return basis === 'consent' ? 'consent_checkbox' : softOptIn;
}

/** Bloc à présenter, ou null si le réglage est désactivé (défaut). Pur. */
export function signupNoticeFor(
  settings: Pick<TrialLifecycleSettings, 'legalBasis' | 'signupCollection'>,
  privacyUrl: string = privacyPolicyUrl(),
): SignupNotice | null {
  if (!settings.signupCollection?.enabled) return null;
  const mechanism = mechanismFor(settings.legalBasis, settings.signupCollection.softOptInMechanism);
  const t = TEXTS[mechanism];
  const sha256 = createHash('sha256')
    .update(JSON.stringify({ mechanism, ...t, privacyLabel: PRIVACY_LABEL, privacyUrl }), 'utf8')
    .digest('hex');
  return {
    legalBasis: settings.legalBasis, mechanism, ...t, privacyLabel: PRIVACY_LABEL, privacyUrl,
    version: `${NOTICE_VERSION}:${mechanism}`, sha256,
  };
}

/**
 * Choix à enregistrer à partir de la valeur de la case envoyée par le
 * formulaire (`checked`, booléen ou absent). Pur.
 *   consent_checkbox : coché → consented ; sinon not_consented ;
 *   opt_out_checkbox : coché → opposed ; sinon not_opposed ;
 *   mention          : informed.
 */
export function choiceFor(mechanism: CollectionMechanism, checked: unknown): CollectionChoice {
  if (mechanism === 'consent_checkbox') return checked === true ? 'consented' : 'not_consented';
  if (mechanism === 'opt_out_checkbox') return checked === true ? 'opposed' : 'not_opposed';
  return 'informed';
}

/** Valeur transmise par le formulaire : `{ marketing: { checked, noticeSha256 } }`. */
export interface SignupMarketingInput {
  checked?: unknown;
  /** Empreinte du bloc affiché (chargé au début du parcours). */
  noticeSha256?: unknown;
}

export function readSignupMarketingInput(raw: unknown): SignupMarketingInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  return { checked: r.checked, noticeSha256: typeof r.noticeSha256 === 'string' ? r.noticeSha256.slice(0, 64) : undefined };
}

/**
 * Enregistre la preuve et applique le choix (consentement ou opposition)
 * pour un utilisateur qui vient d'être créé. Le bloc retenu est celui du
 * réglage COURANT ; si le formulaire a affiché une version différente
 * (empreinte transmise différente), la preuve porte le bloc courant et le
 * choix n'est appliqué que s'il est sans ambiguïté (opposition toujours
 * appliquée ; consentement seulement si l'empreinte correspond).
 * Ne lève jamais (journalisé) : la création du compte n'en dépend pas.
 */
/**
 * Lien « Confidentialité » résolu par le serveur (raccord 102B : bascule sur
 * /legal/confidentialite dès que le manifeste du site a été lu). Même valeur
 * pour l'affichage du bloc et la vérification à la création (empreinte).
 */
export async function currentPrivacyPolicyUrl(): Promise<string> {
  try {
    const { serverLegalUrl } = await import('@/services/legal/cguv-referential.service');
    return await serverLegalUrl('confidentialite');
  } catch {
    return privacyPolicyUrl();
  }
}

export async function recordSignupMarketingChoice(input: {
  userId: number;
  context: 'signup' | 'social_signup';
  marketing: SignupMarketingInput | null;
  now?: Date;
}): Promise<{ recorded: boolean; choice: CollectionChoice | null }> {
  try {
    const { loadTrialLifecycleSettings } = await import('./settings.service');
    const { settings } = await loadTrialLifecycleSettings();
    const notice = signupNoticeFor(settings, await currentPrivacyPolicyUrl());
    if (!notice) return { recorded: false, choice: null };
    const now = input.now ?? new Date();
    const sameNotice = input.marketing?.noticeSha256 === notice.sha256;
    const raw = choiceFor(notice.mechanism, input.marketing?.checked);
    // Une opposition est toujours appliquée. Sinon, sans le bloc COURANT
    // affiché (page en cache, réglage changé pendant le parcours) : jamais de
    // consentement déduit, et aucune preuve d'information (donc aucune
    // relance « client existant » pour cet utilisateur).
    const choice: CollectionChoice | null = raw === 'opposed' || sameNotice
      ? raw
      : (notice.mechanism === 'consent_checkbox' ? 'not_consented' : null);
    if (!choice) return { recorded: false, choice: null };
    const { pgClient } = await import('@/db');
    await pgClient`
      INSERT INTO marketing_collection_proofs (user_id, context, legal_basis, mechanism, choice, notice_version, notice_sha256, privacy_url, created_at)
      VALUES (${input.userId}, ${input.context}, ${notice.legalBasis}, ${notice.mechanism}, ${choice}, ${notice.version}, ${notice.sha256},
              ${notice.privacyUrl}, ${now.toISOString()})`;
    if (choice === 'consented') {
      const { setNewsConsent } = await import('@/lib/notifications/news-consent');
      await setNewsConsent(input.userId, true, input.context === 'signup' ? 'signup' : 'social-signup');
    } else if (choice === 'opposed') {
      const { recordOpposition } = await import('./opposition.service');
      await recordOpposition(input.userId, 'account', now);
    }
    return { recorded: true, choice };
  } catch (e) {
    console.error(`[signup-collection] preuve non enregistrée (utilisateur ${input.userId}) :`, (e as Error).message);
    return { recorded: false, choice: null };
  }
}
