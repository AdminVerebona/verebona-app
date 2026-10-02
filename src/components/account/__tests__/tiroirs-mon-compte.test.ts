/**
 * Mon compte : tous les blocs en tiroirs, sur le modèle « Informations
 * légales » — un titre, une ligne, le chevron, aucun autre bouton tiroir fermé.
 * Seule exception : le lien « Renoncer au contrat ici » (obligation légale,
 * voir tiroirs-legaux.test.ts).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

const BLOCS = [
  'src/components/subscription/SubscriptionSummary.tsx',
  'src/components/account/StorageUsageCard.tsx',
  'src/app/(dashboard)/mon-compte/informations/InformationsTab.tsx',
  'src/components/account/AiHistoryBlock.tsx',
  'src/components/account/NotificationsCard.tsx',
  'src/components/account/WithdrawalCard.tsx',
  'src/app/(dashboard)/mon-compte/mes-donnees/MyDataCard.tsx',
  'src/components/account/LegalInformationCard.tsx',
];

describe('tiroirs de Mon compte', () => {
  it.each(BLOCS)('%s : tiroir avec une ligne de description, sans carte classique', (file) => {
    const src = read(file);
    expect(src).toContain('<CollapsibleCard');
    expect(src).toMatch(/description=/);
    expect(src).not.toMatch(/<CardHeader|<CardTitle/);
  });

  it('aucun contenu hors tiroir, sauf le lien légal de rétractation', () => {
    for (const file of BLOCS) {
      const src = read(file);
      if (file.endsWith('WithdrawalCard.tsx')) expect(src).toContain('headerExtra={lienRetractation}');
      else expect(src).not.toContain('headerExtra=');
    }
  });

  it('la description tient sur une ligne', () => {
    expect(read('src/components/ui/collapsible-card.tsx')).toContain('<div className="truncate text-sm text-muted-foreground">{description}</div>');
  });

  it('les liens profonds ouvrent leur tiroir (#mes-donnees, #sync-agenda)', () => {
    expect(read('src/components/ui/collapsible-card.tsx')).toMatch(/window\.location\.hash !== `#\$\{anchorId\}`/);
    expect(read('src/app/(dashboard)/mon-compte/mes-donnees/MyDataCard.tsx')).toContain('anchorId="mes-donnees"');
    expect(read('src/app/(dashboard)/mon-compte/informations/InformationsTab.tsx')).toContain('anchorId="sync-agenda"');
    // L'ancien lien passait par /mon-compte/informations, dont la redirection perdait l'ancre.
    expect(read('src/app/(dashboard)/agenda/page.tsx')).toContain("router.push('/mon-compte#sync-agenda')");
  });

  it('un impayé ou un compte restreint ouvre le tiroir « Mon abonnement »', () => {
    expect(read('src/components/subscription/SubscriptionSummary.tsx')).toContain('defaultOpen={isUnpaid(data) || Boolean(data.isRestricted)}');
  });
});

describe('accueil', () => {
  it('salue par le nom d’utilisateur, le prénom à défaut', () => {
    const src = read('src/app/(dashboard)/accueil/page.tsx');
    expect(src).toContain("const greetingName = user.username?.trim() || user.firstName || '';");
    expect(read('src/components/home/MascotSpeaks.tsx')).toContain('{greetingWord(now)}, {greetingName}');
  });
});
