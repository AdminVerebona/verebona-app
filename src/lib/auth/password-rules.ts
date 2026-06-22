// src/lib/auth/password-rules.ts
export const MIN_PASSWORD_LENGTH = 10;

const SPECIAL_CHARS = "!@#$%^&*()-_=+[]{};:,.?";

export type PasswordCheckResult = {
  hasMinLength: boolean;
  hasLetter: boolean;
  hasDigit: boolean;
  hasSpecial: boolean;
  hasNoSpace: boolean;
  isValid: boolean;
};

export function checkPassword(password: string): PasswordCheckResult {
  const hasMinLength = password.length >= MIN_PASSWORD_LENGTH;
  const hasLetter = /[A-Za-z]/.test(password);
  const hasDigit = /\d/.test(password);
  const hasSpecial = new RegExp("[" + SPECIAL_CHARS.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&") + "]").test(password);
  const hasNoSpace = !/\s/.test(password);

  const isValid =
    hasMinLength &&
    hasLetter &&
    hasDigit &&
    hasSpecial &&
    hasNoSpace;

  return {
    hasMinLength,
    hasLetter,
    hasDigit,
    hasSpecial,
    hasNoSpace,
    isValid,
  };
}
