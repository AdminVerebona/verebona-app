/**
 * Messages publics des parcours d'authentification — lot 37 (C3), CDC 18 §28.
 *
 * Une seule source pour les routes et leurs tests : un message qui différerait
 * selon l'existence du compte suffirait à l'énumérer.
 */

/** Refus de connexion, sans dire si l'adresse ou le mot de passe est en cause. */
export const INVALID_CREDENTIALS_MESSAGE = 'Identifiants incorrects. Veuillez réessayer.';

/** CDC 18 §9.4 / §30 : affiché seulement APRÈS la preuve du mot de passe. */
export const EMAIL_NOT_VERIFIED_MESSAGE =
  'Veuillez vérifier votre email avant de vous connecter. Consultez votre boîte de réception ou demandez un nouveau lien.';

/** CDC 18 §10.4 : réponse neutre du « mot de passe oublié ». */
export const FORGOT_PASSWORD_NEUTRAL_MESSAGE =
  'Si un compte correspondant existe, vous recevrez les instructions par email.';

/** CDC 18 §11.2 : réponse neutre du renvoi de l'e-mail de vérification. */
export const RESEND_VERIFICATION_NEUTRAL_MESSAGE =
  'Si un compte non vérifié correspond à cette adresse, un nouveau lien de vérification vient d’être envoyé.';
