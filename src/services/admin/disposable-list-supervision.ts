/**
 * Supervision du référentiel des domaines d'e-mails jetables — lot 113H
 * (#707, écarts B et C), raccordée aux mécanismes EXISTANTS : balayage de
 * Supervision (`runSupervisionSweep` : tâche quotidienne
 * `daily-supervision-sweep` et ouverture de l'écran) → anomalies du domaine
 * « Autres traitements techniques » (`anomaly.service`). Aucun tableau de
 * bord parallèle ; l'état détaillé est affiché dans BO › Exploitation › Santé.
 *
 * Une anomalie par condition (résolue automatiquement quand elle disparaît) :
 *   · `unavailable` : référentiel embarqué illisible ou tronqué — repli du
 *     lot 109F (seules les listes DISPOSABLE_EMAIL_* s'appliquent) ;
 *   · `integrity`   : nombre / empreinte différents de `source.json` ;
 *   · `stale`       : date inconnue ou âge > DISPOSABLE_LIST_MAX_AGE_DAYS.
 * La cible MENSUELLE (`update_due`) n'ouvre pas d'anomalie : elle est
 * affichée comme « mise à jour à prévoir » dans BO › Exploitation.
 *
 * Détail : version, ref, date, âge, nombres, seuils, action — JAMAIS la liste
 * ni une adresse. Aucun téléchargement, aucun appel externe. Ne lève jamais.
 */
import { pgClient } from '@/db';
import { autoResolveAnomaly, buildFingerprint, reportAnomaly } from '@/services/admin/anomaly.service';
import type { DisposableListStatus } from '@/lib/auth/disposable-email';

export type DisposableListCondition = 'unavailable' | 'integrity' | 'stale';
export const DISPOSABLE_LIST_CONDITIONS: readonly DisposableListCondition[] = ['unavailable', 'integrity', 'stale'];
export const disposableListFingerprint = (c: DisposableListCondition) => buildFingerprint('other', 'disposable-email-list', c);

const DOC = 'docs/exploitation/emails-jetables.md';

/**
 * Pur : conditions d'alerte présentes. « périmé » est indépendant (il peut
 * coexister avec les deux autres) ; « incohérent » n'est signalé que pour un
 * référentiel disponible (sinon « indisponible » le couvre déjà).
 */
export function disposableListConditions(st: Pick<DisposableListStatus, 'available' | 'integrity' | 'stale'>): DisposableListCondition[] {
  const out: DisposableListCondition[] = [];
  if (!st.available) out.push('unavailable');
  // Liste indisponible : son nombre diffère forcément de source.json — une seule anomalie, la plus grave.
  else if (st.integrity !== 'ok') out.push('integrity');
  if (st.stale) out.push('stale');
  return out;
}

const TITLES: Record<DisposableListCondition, (st: DisposableListStatus) => string> = {
  unavailable: (st) => `E-mails jetables : référentiel indisponible ou tronqué (${st.loadedCount} domaines, version ${st.version})`,
  integrity: (st) => `E-mails jetables : référentiel incohérent avec source.json (version ${st.version})`,
  stale: (st) => st.ageDays == null
    ? `E-mails jetables : date du référentiel inconnue (version ${st.version})`
    : `E-mails jetables : référentiel périmé (${st.ageDays} jours > ${st.maxAgeDays}, version ${st.version})`,
};

const ACTIONS: Record<DisposableListCondition, string> = {
  unavailable: 'Inscriptions toujours possibles (repli : seules DISPOSABLE_EMAIL_EXTRA_BLOCKLIST / DISPOSABLE_EMAIL_ALLOWLIST s’appliquent). '
    + `Développeur : npm run disposable-domains:verify, restaurer la dernière version valide (git checkout -- src/lib/auth/disposable-email/data) puis redéployer — ${DOC}.`,
  integrity: `Développeur : npm run disposable-domains:verify (nombre / empreinte), restaurer la dernière version valide ou relancer la mise à jour, puis redéployer — ${DOC}.`,
  stale: `Développeur : npm run disposable-domains:update, npm run disposable-domains:verify, tests l109f, commit et livraison (cible mensuelle) — ${DOC}.`,
};

function detail(st: DisposableListStatus, c: DisposableListCondition): Record<string, unknown> {
  return {
    condition: c,
    version: st.version,
    ref: st.ref,
    fetchedAt: st.fetchedAt,
    ageDays: st.ageDays,
    maxAgeDays: st.maxAgeDays,
    updateTargetDays: st.updateTargetDays,
    count: st.count,
    loadedCount: st.loadedCount,
    expectedCount: st.expectedCount,
    available: st.available,
    integrity: st.integrity,
    action: ACTIONS[c],
    ecran: 'BO › Exploitation › Santé › Référentiel des e-mails jetables',
  };
}

async function isOpen(fingerprint: string): Promise<boolean> {
  const rows = await pgClient<{ one: number }[]>`
    SELECT 1 AS one FROM admin_anomalies WHERE fingerprint = ${fingerprint} AND status = 'open' LIMIT 1`;
  return rows.length > 0;
}

/**
 * Ouvre (une fois tant qu'elle reste ouverte) ou résout chaque anomalie du
 * référentiel. Renvoie les conditions signalées et résolues lors de ce passage.
 */
export async function syncDisposableListAnomalies(
  status?: DisposableListStatus,
): Promise<{ conditions: DisposableListCondition[]; reported: DisposableListCondition[]; resolved: DisposableListCondition[] }> {
  const reported: DisposableListCondition[] = [];
  const resolved: DisposableListCondition[] = [];
  let conditions: DisposableListCondition[] = [];
  try {
    const st = status ?? (await import('@/lib/auth/disposable-email')).disposableListStatus();
    conditions = disposableListConditions(st);
    for (const c of DISPOSABLE_LIST_CONDITIONS) {
      const fp = disposableListFingerprint(c);
      if (conditions.includes(c)) {
        // Condition persistante : pas de nouvelle occurrence à chaque balayage (SUP-010).
        if (await isOpen(fp)) continue;
        const id = await reportAnomaly({ domain: 'other', fingerprint: fp, title: TITLES[c](st), detail: detail(st, c) });
        if (id !== null) reported.push(c);
      } else if (await autoResolveAnomaly(fp, { origin: 'disposable_list_check', cause: `Référentiel ${st.version} (${st.state})` })) {
        resolved.push(c);
      }
    }
  } catch (e) {
    console.error('[disposable-email] supervision du référentiel impossible :', (e as Error).message);
  }
  return { conditions, reported, resolved };
}
