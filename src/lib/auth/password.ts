/**
 * Password validation according to OWASP ASVS standards
 * 
 * Requirements:
 * - Minimum 10 characters
 * - At least 1 letter (A-Z or a-z)
 * - At least 1 digit (0-9)
 * - At least 1 special character from the allowed set
 * - No spaces
 * 
 * Allowed special characters: ! @ # $ % ^ & * ( ) - _ = + [ ] { } ; : , . ?
 */

import { MIN_PASSWORD_LENGTH, checkPassword } from './password-rules';

export function validatePassword(pwd: string): boolean {
  const result = checkPassword(pwd);
  return result.isValid;
}

export interface PasswordValidationError {
  error: string;
  message: string;
  details: {
    rules: string[];
  };
}

export function getPasswordValidationError(): PasswordValidationError {
  return {
    error: "WEAK_PASSWORD",
    message: "Le mot de passe ne respecte pas les exigences de sécurité.",
    details: {
      rules: [
        `Minimum ${MIN_PASSWORD_LENGTH} caractères`,
        "Au moins 1 lettre",
        "Au moins 1 chiffre",
        "Au moins 1 caractère spécial",
        "Aucun espace"
      ]
    }
  };
}