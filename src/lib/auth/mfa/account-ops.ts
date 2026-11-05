/**
 * Mon compte › Sécurité — opérations sur les facteurs depuis une session
 * COMPLÈTE (lot 110B, ticket §6, §7). Toutes exigent la réauthentification
 * fraîche de CETTE session (`requireFreshReauth`, 5 min) — de niveau FORT dès
 * que la MFA est obligatoire pour le compte (`getReauthState`). Premier
 * facteur ajouté volontairement (avant l'activation globale) : la preuve
 * primaire fraîche + le facteur prouvé élèvent la session courante au niveau 2.
 */
import type { NextRequest, NextResponse } from 'next/server';
import { requireFreshReauth } from '../reauth';
import { issueSession } from '../session-issuance';
import { sessionSubjectFor } from '../session-tokens';
import { strongAssurance } from './assurance';
import { sql } from './db';
import type { SessionPayload } from '@/lib/session-service';

export async function requireSecurityStepUp(request: NextRequest, action: string) {
  return requireFreshReauth(request, { action });
}

/** Session de niveau 1 qui vient de prouver un facteur : réémise au niveau 2 (même `sid`). */
export async function promoteCurrentSession(
  request: NextRequest, response: NextResponse, session: SessionPayload & { sid: string }, factor: 'passkey' | 'otp',
): Promise<boolean> {
  if (session.aal === 2) return false;
  const db = await sql();
  const [user] = await db<{ id: number; email: string; role: string; plan_type: string; status: string }[]>`
    SELECT id, email, role, plan_type, status FROM users WHERE id = ${session.userId}`;
  if (!user) return false;
  const subject = await sessionSubjectFor({ id: user.id, email: user.email, role: user.role, planType: user.plan_type, status: user.status });
  if (session.currentAccountId) subject.currentAccountId = session.currentAccountId;
  await issueSession(request, response, { kind: 'reissue', sid: session.sid, subject, assurance: strongAssurance(null, factor) });
  return true;
}
