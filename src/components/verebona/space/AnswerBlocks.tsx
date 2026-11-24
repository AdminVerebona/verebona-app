'use client';
/**
 * Réponse de l'Assistant en blocs — Trello #753, CDC T2 §8.1, §8.3, §8.5 (M11).
 *
 * Rendu sémantique du texte VALIDÉ de la réponse (`lib/verebona/answer-blocks`) : les paragraphes restent des
 * paragraphes, une énumération est une liste, des étapes une liste numérotée ; le lecteur d'écran les lit dans
 * l'ordre. Le gras sert aux montants et aux passages marqués, jamais à toute la réponse. Aucun HTML libre : seuls
 * du texte et `<strong>` sortent d'ici. Mêmes jetons de la charte que le reste de l'espace de réponse ; les tailles
 * sont celles du paragraphe unique qu'il remplace (ordinateur et mobile).
 */
import { ETIQUETTE_CHIFFRE_CLE, type AnswerBlock, type AnswerSpan } from '@/lib/verebona/answer-blocks';

function Spans({ spans }: { spans: AnswerSpan[] }) {
  return (
    <>
      {spans.map((s, i) => (s.strong
        ? <strong key={i} className="font-semibold text-[color:var(--text-primary)]">{s.text}</strong>
        : <span key={i}>{s.text}</span>))}
    </>
  );
}

const texteDe = (spans: AnswerSpan[]) => spans.map((s) => s.text).join('');

/**
 * Carte 790 (relance du 21/11/2026) — nom d'une liste pour un lecteur d'écran : l'annonce qui la précède
 * (« Ventilation : », « Limites : »), sans sa ponctuation. Le texte affiché ne change pas ; sans annonce, pas de nom.
 */
function nomDeListe(blocks: AnswerBlock[], i: number): string | undefined {
  const avant = blocks[i - 1];
  if (!avant || avant.kind !== 'paragraph') return undefined;
  const t = texteDe(avant.spans).trim();
  return /[:：]$/.test(t) ? t.replace(/\s*[:：]$/, '') : undefined;
}

export function AnswerBlocks({ blocks, variant, onCopy }: { blocks: AnswerBlock[]; variant: 'desktop' | 'mobile'; onCopy?: () => void }) {
  const taille = variant === 'mobile' ? 'text-[15px]' : 'text-[14.5px]';
  return (
    <div className={`flex min-w-0 flex-col gap-2 break-words leading-normal text-[color:var(--text-primary)] ${taille}`} onCopy={onCopy} data-answer-blocks>
      {blocks.map((b, i) => {
        if (b.kind === 'paragraph') return <p key={i} className="m-0"><Spans spans={b.spans} /></p>;
        // Trello 753 (CDC T2 §8.1) : titre de section de PETITE taille — un repère, jamais un titre de page.
        if (b.kind === 'heading') {
          return (
            <h4 key={i} className="m-0 mt-1 text-[13px] font-semibold text-[color:var(--text-muted)] first:mt-0">
              <Spans spans={b.spans} />
            </h4>
          );
        }
        // Trello 753 (CDC T2 §8.1), passage 114AA : CHIFFRE CLÉ. L'étiquette donne le sens de la forme (elle
        // fait partie de la ligne du texte validé), la valeur est mise en avant, la légende la précise. Jetons
        // de la charte seulement ; même rendu sur ordinateur et sur mobile, la valeur revient à la ligne.
        if (b.kind === 'metric') {
          return (
            // Carte 790 (relance) : le chiffre clé est UN groupe nommé (étiquette, valeur, légende lues ensemble).
            <div
              key={i}
              role="group"
              aria-label={`${ETIQUETTE_CHIFFRE_CLE} : ${texteDe(b.value)}${b.caption ? ` — ${texteDe(b.caption)}` : ''}`}
              data-answer-block="metric"
              className="my-0.5 flex min-w-0 flex-col gap-0.5 rounded-lg border border-[color:var(--border)] bg-[color:var(--bg-subtle)] px-3 py-2"
            >
              {/* Charte Sérénité : casse naturelle, pas de petites capitales, pas d'espacement large. */}
              <span className="text-[12px] font-semibold text-[color:var(--text-muted)]">{ETIQUETTE_CHIFFRE_CLE}</span>
              <strong className={`font-semibold text-[color:var(--text-primary)] ${variant === 'mobile' ? 'text-[20px]' : 'text-[18px]'}`}>
                <Spans spans={b.value} />
              </strong>
              {b.caption && <span className="text-[12.5px] text-[color:var(--text-muted)]"><Spans spans={b.caption} /></span>}
            </div>
          );
        }
        // Trello 753 (CDC T2 §8.1) : tableau de comparaison. Sur mobile, il défile horizontalement DANS la
        // réponse (jamais la page) ; les cellules reviennent à la ligne, la première colonne reste lisible.
        if (b.kind === 'table') {
          const cellule = `border-b border-[color:var(--border)] px-2 py-1 align-top ${variant === 'mobile' ? 'text-[14px]' : 'text-[13.5px]'}`;
          return (
            <div key={i} data-answer-block="table" className="-mx-1 max-w-full overflow-x-auto px-1">
              <table className="w-max min-w-full border-collapse text-left">
                {b.header && (
                  <thead>
                    <tr>
                      {b.header.map((c, j) => (
                        <th key={j} scope="col" className={`${cellule} font-semibold text-[color:var(--text-muted)]`}><Spans spans={c} /></th>
                      ))}
                    </tr>
                  </thead>
                )}
                <tbody>
                  {b.rows.map((r, j) => (
                    <tr key={j}>
                      {r.map((c, k) => (
                        k === 0 && b.header
                          ? <th key={k} scope="row" className={`${cellule} font-normal`}><Spans spans={c} /></th>
                          : <td key={k} className={cellule}><Spans spans={c} /></td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        const List = b.ordered ? 'ol' : 'ul';
        return (
          <List
            key={i}
            className={`m-0 flex flex-col gap-1 pl-5 ${b.ordered ? 'list-decimal' : 'list-disc'} marker:text-[color:var(--text-muted)]`}
            data-answer-block="list"
            aria-label={nomDeListe(blocks, i)}
          >
            {b.items.map((it, j) => <li key={j} className="pl-0.5"><Spans spans={it} /></li>)}
          </List>
        );
      })}
    </div>
  );
}
