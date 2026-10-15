/**
 * Lot 58A — harnais NAVIGATEUR (Chromium réel) du test
 * `l58a-montants-navigateur.test.ts` : monte les VRAIS composants
 * (`AssetDetailSection` de la fiche, `NumberInput` partagé) dans une page.
 * Construit à la volée par esbuild ; jamais importé par l'application.
 */
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { AssetDetailSection, type FieldDef } from '@/components/assets/AssetDetailSection';
import { NumberInput } from '@/components/ui/number-input';
import { MONEY_INPUT, parseMoneyInputToCents } from '@/lib/number-input';

const FIELDS: FieldDef[] = [
  { key: 'acquisitionPrice', label: 'Prix d\'achat (€)', type: 'number' },
  { key: 'mileage', label: 'Kilométrage', type: 'number' },
];

/** Formulaire « texte » (création d'un bien, documents, forfait, valorisation). */
function TextForm() {
  const [v, setV] = React.useState('');
  const [sent, setSent] = React.useState('');
  return (
    <form onSubmit={(e) => { e.preventDefault(); setSent(JSON.stringify(parseMoneyInputToCents(v))); }}>
      <NumberInput data-testid="texte" value={v} onValueChange={setV} parseOptions={MONEY_INPUT} />
      <button type="submit">Valider</button>
      <output data-testid="envoye">{sent}</output>
    </form>
  );
}

let root: Root | null = null;
declare global {
  interface Window { __mount: (kind: 'fiche' | 'texte', data?: Record<string, unknown>) => void }
}
window.__mount = (kind, data = {}) => {
  root?.unmount();
  root = createRoot(document.getElementById('root')!);
  flushSync(() => {
    root!.render(kind === 'fiche'
      ? <AssetDetailSection title="Informations générales" sectionKey="common" assetId={7} data={data} fields={FIELDS} onRefresh={() => undefined} forceEdit />
      : <TextForm />);
  });
};
