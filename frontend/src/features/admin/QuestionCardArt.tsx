/* Question Bank card artwork: the document icon in the card's tile and the two question sheets beside the count.
   Decorative only (aria-hidden); colours come from the theme (styles/traincheck.css, .question-card). */

/** A document with a bulleted list. */
export function QuestionDocIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M14 2.5H7a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7.5z" />
      <path d="M14 2.5v5h5" />
      <path d="M11 12h5M11 16h5" />
      <circle cx="8.2" cy="12" r=".6" fill="currentColor" />
      <circle cx="8.2" cy="16" r=".6" fill="currentColor" />
    </svg>
  );
}

/** Two tilted question sheets (a green one behind a white one) with a small burst. */
export function QuestionSheetsArt() {
  return (
    <svg className="question-card-art" viewBox="0 0 170 150" fill="none" aria-hidden="true" focusable="false">
      {/* Back sheet */}
      <g transform="rotate(-10 55 85)">
        <rect x="18" y="34" width="70" height="92" rx="9" className="art-back" strokeWidth="2.5" />
        <text x="32" y="64" className="art-mark">?</text>
        <rect x="31" y="74" width="16" height="6" rx="3" className="art-green" />
        <rect x="31" y="86" width="34" height="6" rx="3" className="art-green-soft" />
        <circle cx="36" cy="104" r="5" className="art-ring-green" strokeWidth="2" />
      </g>
      {/* Front sheet */}
      <g transform="rotate(8 105 85)">
        <rect x="62" y="26" width="82" height="104" rx="10" className="art-front" strokeWidth="3" />
        <text x="76" y="56" className="art-mark">?</text>
        <rect x="76" y="66" width="54" height="7" rx="3.5" className="art-grey" />
        <rect x="76" y="80" width="54" height="7" rx="3.5" className="art-grey" />
        <circle cx="82" cy="108" r="6" className="art-ring" strokeWidth="2.4" />
        <circle cx="102" cy="108" r="6" className="art-ring" strokeWidth="2.4" />
        <circle cx="122" cy="108" r="6" className="art-ring-dark" strokeWidth="2.6" />
      </g>
      {/* Burst */}
      <g className="art-burst" strokeWidth="3.2" strokeLinecap="round">
        <path d="M134 8l4 12" />
        <path d="M150 4l-1 13" />
        <path d="M165 18l-10 7" />
      </g>
    </svg>
  );
}
