/**
 * Sauvegarde quotidienne — fenêtre de nuit et câblage.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { dansLaFenetreDeNuit, heureDeParis } from '@/services/backup/database-backup-scheduler';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

describe('fenêtre de nuit (heure de Paris)', () => {
  it('lit l’heure de Paris, pas celle du serveur', () => {
    // 01:30 UTC en septembre = 03:30 à Paris (heure d'été).
    expect(heureDeParis(new Date('2026-09-17T01:30:00Z'))).toBe(3);
    // 00:30 UTC en janvier = 01:30 à Paris (heure d'hiver).
    expect(heureDeParis(new Date('2026-01-15T00:30:00Z'))).toBe(1);
  });

  it('ne lance la sauvegarde qu’entre 1 h et 5 h', () => {
    expect(dansLaFenetreDeNuit(new Date('2026-09-17T01:30:00Z'))).toBe(true); // 03:30
    expect(dansLaFenetreDeNuit(new Date('2026-09-17T12:00:00Z'))).toBe(false); // 14:00
    expect(dansLaFenetreDeNuit(new Date('2026-09-17T03:00:00Z'))).toBe(false); // 05:00
  });
});

describe('la sauvegarde est réellement branchée', () => {
  it('le planificateur est démarré au lancement du serveur', () => {
    expect(read('src/instrumentation.ts')).toMatch(/startDatabaseBackupScheduler\(\)/);
  });

  it('le manifeste, lu par le tableau de bord, est écrit en dernier sous backups/', () => {
    const src = read('src/services/backup/database-backup.service.ts');
    expect(src).toMatch(/Key: `\$\{BACKUP_PREFIX\}\$\{stamp\}\.json`/);
    expect(src.indexOf('envoi.terminer()')).toBeLessThan(src.indexOf('`${BACKUP_PREFIX}${stamp}.json`'));
    expect(read('src/app/api/admin/dashboard/route.ts')).toMatch(/Prefix: 'backups\/'/);
  });

  it('la page du menu d’administration existe', () => {
    expect(read('src/components/AdminSidebar.tsx')).toMatch(/href: '\/admin\/backups'/);
    expect(read('src/app/admin/backups/page.tsx')).toMatch(/\/api\/admin\/backups/);
  });

  it('les déclenchements manuels sont protégés', () => {
    expect(read('src/app/api/cron/backup/route.ts')).toMatch(/CRON_SECRET/);
    expect(read('src/app/api/admin/backups/route.ts')).toMatch(/requireAdmin\(request\)/);
  });
});
