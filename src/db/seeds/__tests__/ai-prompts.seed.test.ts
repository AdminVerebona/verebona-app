/**
 * CDC §4.5.3 — « aucune modification de prompt ne s'applique sans deux
 * validations humaines distinctes ».
 *
 * La règle protégée ici est celle de non-écrasement. Un seed qui écraserait une
 * version active rendrait la gouvernance décorative : il suffirait de modifier
 * un `.txt` et de redéployer pour contourner le circuit. C'est la seule chose
 * de ce fichier qu'il ne faut jamais casser.
 */
import { describe, it, expect } from 'vitest';
import {
  parsePromptFileName, hashContent, decideSeedAction, collectPromptFiles,
  type PromptFile,
} from '../ai-prompts.seed';

function file(over: Partial<PromptFile> = {}): PromptFile {
  return {
    promptCode: 'reconcile_links_v1',
    version: 'v1',
    content: 'Texte du prompt',
    contentHash: hashContent('Texte du prompt'),
    relativePath: 'reconciliation/reconcile_links_v1.txt',
    ...over,
  };
}

describe('nommage', () => {
  it('le code est le nom du fichier, suffixe de version compris', () => {
    expect(parsePromptFileName('reconcile_links_v1.txt'))
      .toEqual({ promptCode: 'reconcile_links_v1', version: 'v1' });
    expect(parsePromptFileName('extract_source_v2.txt'))
      .toEqual({ promptCode: 'extract_source_v2', version: 'v2' });
  });

  it('retombe sur v1 sans suffixe', () => {
    expect(parsePromptFileName('prompt_libre.txt').version).toBe('v1');
  });
});

describe('empreinte', () => {
  it('est stable', () => {
    expect(hashContent('abc')).toBe(hashContent('abc'));
    expect(hashContent('abc')).not.toBe(hashContent('abd'));
  });

  it('ignore les fins de ligne Windows — sinon chaque aller-retour crée une candidate', () => {
    expect(hashContent('a\r\nb')).toBe(hashContent('a\nb'));
  });
});

describe('règle de non-écrasement', () => {
  it('active un prompt absent de la base', () => {
    const d = decideSeedAction(file(), null);
    expect(d.action).toBe('created');
  });

  it('ne fait rien si le contenu est identique', () => {
    const f = file();
    const d = decideSeedAction(f, { contentHash: f.contentHash, version: 'v1' });
    expect(d.action).toBe('unchanged');
  });

  it('N\'ÉCRASE JAMAIS une version active divergente', () => {
    const d = decideSeedAction(file(), { contentHash: 'empreinte-différente', version: 'v1' });

    expect(d.action).toBe('candidate');
    expect(d.detail).toContain('gouvernance');
  });

  it('signale la divergence plutôt que de la taire', () => {
    const d = decideSeedAction(file(), { contentHash: 'autre', version: 'v3' });
    expect(d.detail).toContain('v3');
  });
});

describe('inventaire du dépôt', () => {
  it('trouve les prompts et les trie', async () => {
    const files = await collectPromptFiles();
    const codes = files.map(f => f.promptCode);

    expect(codes.length).toBeGreaterThanOrEqual(12);
    expect(codes).toContain('reconcile_links_v1');
    expect(codes).toEqual([...codes].sort());
  });

  it('calcule une empreinte pour chacun', async () => {
    const files = await collectPromptFiles();
    for (const f of files) expect(f.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
