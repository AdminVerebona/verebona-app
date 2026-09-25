/**
 * Utilitaires communs aux actions administrateur sur un utilisateur
 * (CDC Back-Office V1 §6.3). Fichier non routé (préfixe `_`).
 */
import { NextResponse } from 'next/server';
import { UserAdminError } from '@/services/admin/user-admin.service';

/** Identifiant d'utilisateur de l'URL, strictement entier positif. */
export function parseUserId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function invalidUserId(): NextResponse {
  return NextResponse.json({ error: 'INVALID_ID', code: 'INVALID_ID', message: 'Identifiant utilisateur invalide.' }, { status: 400 });
}

/** Réponse d'un refus métier (`USER_NOT_FOUND` 404, `LAST_ADMIN` 409). */
export function userAdminErrorResponse(error: UserAdminError): NextResponse {
  const status = error.code === 'USER_NOT_FOUND' ? 404 : 409;
  return NextResponse.json({ error: error.code, code: error.code, message: error.message }, { status });
}
