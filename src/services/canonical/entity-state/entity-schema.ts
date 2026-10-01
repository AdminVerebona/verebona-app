/**
 * Présence des colonnes de la migration 0227 (fiche canonique d'équipement et
 * de pièce, cible du journal 0216) — CDC 15 T1-04, lot 18.
 *
 * Colonnes NON déclarées dans Drizzle (en-tête de la 0227) : lues et écrites
 * en SQL, seulement si ce contrôle confirme leur présence. Absentes : la
 * primitive refuse (`SCHEMA_NOT_READY`), T3 n'applique rien aux entités, et
 * l'absence est signalée une fois par processus. Ne lève jamais.
 */
const RECONTROLE_MS = 5 * 60_000;
let etat: { ready: boolean; checkedAt: number } | null = null;
let signale = false;

const ATTENDUES: ReadonlyArray<[string, string]> = [
  ['equipments', 'key_characteristics'],
  ['rooms', 'key_characteristics'],
  ['canonical_field_writes', 'target_type'],
  ['canonical_field_writes', 'target_id'],
];

export async function entityCanonicalColumnsReady(): Promise<boolean> {
  if (etat && (etat.ready || Date.now() - etat.checkedAt < RECONTROLE_MS)) return etat.ready;
  let ready = false;
  try {
    const { pgClient } = await import('@/db');
    const rows = (await pgClient.unsafe(
      `SELECT table_name AS t, column_name AS c FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name IN ('equipments', 'rooms', 'canonical_field_writes')
          AND column_name IN ('key_characteristics', 'target_type', 'target_id')`,
    )) as unknown as Array<{ t: string; c: string }>;
    const vues = new Set(rows.map((r) => `${r.t}.${r.c}`));
    ready = ATTENDUES.every(([t, c]) => vues.has(`${t}.${c}`));
  } catch {
    ready = false;
  }
  etat = { ready, checkedAt: Date.now() };
  if (!ready && !signale) {
    signale = true;
    console.error(
      '[canonical] ⚠️ MIGRATION 0227 NON APPLIQUÉE : fiche canonique des équipements et pièces absente. '
      + 'Aucune valeur lue pour un équipement ou une pièce n’est appliquée. Voir /api/health.',
    );
  }
  return ready;
}

/** Réservé aux tests. */
export function __resetEntityColumnsForTests(ready: boolean | null = null): void {
  etat = ready === null ? null : { ready, checkedAt: Date.now() };
  signale = false;
}
