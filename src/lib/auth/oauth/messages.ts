/**
 * Codes et messages du parcours Google / Apple (lot 93, CDC 18 §28, §30).
 * PUR : partagé par les routes (codes stables) et les écrans (français simple).
 * Aucun message ne dit si une adresse quelconque a un compte, sauf le cas
 * prévu par le CDC (§8.1) où la personne a PROUVÉ, auprès du fournisseur, le
 * contrôle de cette adresse.
 */
export type SocialErrorCode =
  | 'OAUTH_STATE_INVALID'
  | 'OAUTH_CANCELLED'
  | 'OAUTH_PROVIDER_ERROR'
  | 'OAUTH_IDENTITY_ALREADY_LINKED'
  | 'PROVIDER_ALREADY_LINKED'
  | 'ACCOUNT_ALREADY_EXISTS'
  | 'ACCOUNT_SUSPENDED'
  | 'ACCOUNT_DELETED'
  | 'EMAIL_NOT_VERIFIED'
  | 'LAST_LOGIN_METHOD'
  | 'REAUTH_REQUIRED'
  | 'REAUTH_EXPIRED'
  | 'REAUTH_SUBJECT_MISMATCH'
  | 'REAUTH_NOT_RECENT'
  | 'RATE_LIMIT_EXCEEDED'
  | 'SIGNUP_CLOSED'
  | 'INVITATION_INVALID'
  | 'SESSION_EXPIRED';

export const SOCIAL_ERROR_MESSAGES: Readonly<Record<SocialErrorCode, string>> = {
  OAUTH_STATE_INVALID: 'La connexion a expiré ou a déjà été utilisée. Recommencez, s’il vous plaît.',
  OAUTH_CANCELLED: 'La connexion a été annulée. Aucun compte n’a été créé ni modifié.',
  OAUTH_PROVIDER_ERROR: 'La connexion n’a pas pu aboutir. Réessayez dans quelques instants.',
  OAUTH_IDENTITY_ALREADY_LINKED: 'Ce compte Google ou Apple est déjà associé à un autre compte Verebona. Rien n’a été modifié.',
  PROVIDER_ALREADY_LINKED: 'Un autre compte de ce fournisseur est déjà associé à votre compte Verebona. Déconnectez-le d’abord.',
  ACCOUNT_ALREADY_EXISTS: 'Un compte Verebona utilise déjà cette adresse. Connectez-vous à ce compte pour associer Google/Apple.',
  ACCOUNT_SUSPENDED: 'Ce compte est suspendu. Contactez l’administration de Verebona.',
  ACCOUNT_DELETED: 'Ce compte n’est plus disponible.',
  EMAIL_NOT_VERIFIED: 'Votre adresse e-mail n’est pas encore confirmée. Ouvrez le lien reçu par e-mail pour activer votre compte.',
  LAST_LOGIN_METHOD: 'Vous devez conserver au moins une méthode de connexion.',
  REAUTH_REQUIRED: 'Pour votre sécurité, confirmez d’abord votre identité.',
  REAUTH_EXPIRED: 'Votre confirmation d’identité a expiré. Confirmez-la à nouveau.',
  REAUTH_SUBJECT_MISMATCH: 'Utilisez le même compte Google ou Apple que celui associé à Verebona.',
  REAUTH_NOT_RECENT: 'Google ou Apple n’a pas redemandé votre identification. Réessayez et identifiez-vous à nouveau, ou utilisez votre mot de passe Verebona.',
  RATE_LIMIT_EXCEEDED: 'Trop de tentatives. Réessayez dans quelques minutes.',
  SIGNUP_CLOSED: 'Les inscriptions ne sont pas encore ouvertes.',
  INVITATION_INVALID: 'Ce lien d’invitation n’est plus valable, ou il est destiné à une autre adresse e-mail.',
  SESSION_EXPIRED: 'Votre session a expiré pendant l’opération. Recommencez, s’il vous plaît.',
};

export function socialErrorMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  return (SOCIAL_ERROR_MESSAGES as Record<string, string>)[code] ?? SOCIAL_ERROR_MESSAGES.OAUTH_PROVIDER_ERROR;
}

/** Messages de réussite affichés dans Mon compte › Sécurité après un retour fournisseur. */
export const SECURITY_RETURN_MESSAGES: Readonly<Record<string, string>> = {
  linked: 'C’est fait : vous pouvez désormais vous connecter avec ce compte.',
  reauth: 'Identité confirmée. Vous pouvez poursuivre.',
};
