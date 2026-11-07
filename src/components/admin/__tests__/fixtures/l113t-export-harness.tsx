/**
 * Lot 113T — harnais NAVIGATEUR (Chromium réel) du test
 * `l113t-export-json-navigateur.test.ts` : monte le VRAI bouton d'export du
 * BO (`ExportFileButton`) dans une page « BO » minimale. Le réseau est servi
 * par Playwright (vraies réponses HTTP, en-têtes compris). Construit à la
 * volée par esbuild ; jamais importé par l'application.
 */
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ExportFileButton } from '@/components/admin/ExportFileButton';

declare global {
  interface Window {
    __mountExport: (url: string) => void;
  }
}

let root: Root | null = null;
window.__mountExport = (url: string) => {
  root?.unmount();
  root = createRoot(document.getElementById('root')!);
  flushSync(() => {
    root!.render(
      <main style={{ padding: 16 }}>
        <h1 data-testid="bo-ecran">Exécution T1:ef883f80-e565-4bd3-a524-340c324205f8</h1>
        <ExportFileButton appearance="link" url={url} fallbackName="verebona-execution-repli.json" label="Export JSON" testId="unit-export" />
      </main>,
    );
  });
};
