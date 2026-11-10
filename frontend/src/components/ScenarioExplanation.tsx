import type { BookRationale } from '../types/game';

interface ScenarioExplanationProps {
  rationale: BookRationale;
}

/**
 * The book column's body: which rule the scenario encodes, why this hand
 * satisfies it, and where the rule comes from.
 *
 * All of this text comes from Rust (`src/rationale.rs`); this component only
 * lays it out. Rules the book does not argue for (an absent justification) are
 * listed without quotes or citations so the column never fabricates one.
 */
export function ScenarioExplanation({ rationale }: ScenarioExplanationProps) {
  const absent = rationale.absent ?? [];
  const caveats = rationale.caveats ?? [];

  return (
    <div className="book-rationale">
      <p className="book-rationale-summary">{rationale.summary}</p>

      <ul className="book-rule-list">
        {rationale.rules.map((rule) => (
          <li key={rule.id} className="book-rule">
            <p className="book-rule-text">{rule.rule}</p>
            <p className="book-rule-applies">{rule.applies}</p>
            <p className="book-rule-quote">“{rule.quote}”</p>
            <a
              className="book-rule-citation"
              href={`#${rule.citation.source_file}`}
              title={`${rule.citation.source_file}, line ${rule.citation.source_line}`}
              aria-label={`Source: ${rule.citation.book}, chapter ${rule.citation.chapter}, ${rule.citation.chapter_title}`}
              onClick={(event) => event.preventDefault()}
            >
              ch{rule.citation.chapter} · {rule.citation.section}
            </a>
          </li>
        ))}
      </ul>

      {absent.length > 0 && (
        <div className="book-absent">
          <span className="book-absent-title">Not this hand</span>
          <ul>
            {absent.map((entry) => (
              <li key={entry.id}>{entry.note}</li>
            ))}
          </ul>
        </div>
      )}

      {caveats.length > 0 && (
        <details className="book-caveats">
          <summary>Book caveats</summary>
          <ul>
            {caveats.map((caveat) => (
              <li key={caveat}>{caveat}</li>
            ))}
          </ul>
        </details>
      )}

      <p className="book-source">
        {rationale.source.book} · ch{rationale.source.chapter}{' '}
        {rationale.source.chapter_title}
      </p>
    </div>
  );
}
