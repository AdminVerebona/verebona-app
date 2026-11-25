/**
 * Horloge décalée des tests — détection des « bombes à retardement ».
 *
 * Deux incidents du 25/11/2026 (l92-sessions-reauth, C838-E2E-A2) avaient la
 * même cause : un test fixait une date EN DUR (`T0 = 2026-10-26`, `t0 =
 * 2026-11-25T10:00Z`) pour préparer ses données, puis appelait un code qui lit
 * l'horloge RÉELLE (`Date.now()`, `new Date()`). Vert le jour de l'écriture,
 * rouge dès que l'écart dépasse une durée métier (expiration 30 j, délai de
 * réexamen…). La CI verte ne prouve donc rien : le test casse plus tard.
 *
 * Ce module, chargé par les deux `setupFiles` (unitaires et E2E), décale
 * `Date.now()` et `new Date()` sans argument de `TEST_CLOCK_OFFSET_DAYS` jours
 * lorsque la variable est posée (inactif sinon). Un test correct — tout relatif
 * à l'horloge réelle, ou tout sur une horloge explicite injectée — passe quel
 * que soit le décalage ; un test qui mélange les deux casse immédiatement.
 *
 *   npm run test:horloge-decalee              # unitaires, +400 jours
 *   TEST_CLOCK_OFFSET_DAYS=45 npx vitest --run <fichiers>
 *
 * Limites : `vi.useFakeTimers()` remplace `Date` pendant le test qui l'appelle
 * (comportement attendu) ; l'horloge de PostgreSQL (`now()`) n'est PAS décalée,
 * donc en E2E un décalage ne vaut que pour les scénarios qui n'opposent pas
 * `now()` SQL et l'horloge JS. Règle : docs/exploitation/tests-horloge.md.
 */
const MARQUE = Symbol.for('verebona.test.clockOffset');

export function installTestClockOffset(env: Record<string, string | undefined> = process.env): number {
  const brut = env.TEST_CLOCK_OFFSET_DAYS?.trim();
  if (!brut) return 0;
  const jours = Number(brut);
  if (!Number.isFinite(jours)) throw new Error(`TEST_CLOCK_OFFSET_DAYS invalide : « ${brut} »`);
  const g = globalThis as unknown as Record<symbol, unknown> & { Date: DateConstructor };
  if (g[MARQUE]) return g[MARQUE] as number; // déjà installé (un fichier de réglage par test)
  const decalage = Math.round(jours * 86_400_000);
  const Reelle = g.Date;
  class DateDecalee extends Reelle {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(Reelle.now() + decalage);
      else super(...(args as [string | number | Date]));
    }
    static now(): number { return Reelle.now() + decalage; }
  }
  g.Date = DateDecalee as unknown as DateConstructor;
  g[MARQUE] = decalage;
  return decalage;
}
