"use client";

import { useState, type FormEvent } from "react";
import { Star } from "lucide-react";
import { FormError } from "@/components/ui";
import { Modal } from "@/components/ui/dialog";
import { ApiError, api } from "@/lib/api";
import type { FeedbackKey, FeedbackView } from "@/lib/types";

const MAX_COMMENT = 2000;

/** The official ten-question training form, asked once after a post-training assessment. */
export function FeedbackDialog({ attemptId, view, onClose, onSubmitted }: { attemptId: string; view: FeedbackView; onClose: () => void; onSubmitted: (view: FeedbackView) => void }) {
  const [ratings, setRatings] = useState<Partial<Record<FeedbackKey, number>>>({});
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const answered = view.questions.filter((q) => ratings[q.key]).length;
  const complete = answered === view.questions.length;
  const sections = [...new Set(view.questions.map((q) => q.section))];

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!complete) {
      setError(`Please rate all ${view.questions.length} questions.`);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const saved = await api.post<FeedbackView>(`/attempts/${attemptId}/feedback`, { ratings, comment: comment.trim() || null });
      onSubmitted(saved);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Your feedback could not be sent. Please try again.");
      setBusy(false);
    }
  };

  return (
    <Modal title="Training Feedback Form" onClose={() => !busy && onClose()} wide>
      <form className="feedback-form" onSubmit={(e) => void submit(e)}>
        <p>
          Tell us about <strong>{view.training_title}</strong>. Your answers help L&amp;D improve the training. Please answer all {view.questions.length} rating questions. Comments are optional.
        </p>
        {sections.map((section, sectionIndex) => (
          <section className="feedback-section" key={section} aria-labelledby={`feedback-section-${sectionIndex}`}>
            <h3 id={`feedback-section-${sectionIndex}`}>{sectionIndex + 1}. {section}</h3>
            <ol className="feedback-questions">
              {view.questions.filter((q) => q.section === section).map((q) => (
                <li key={q.key}>
                  <fieldset disabled={busy}>
                    <legend>
                      <span className="feedback-number">{view.questions.indexOf(q) + 1}</span>
                      {q.text}
                    </legend>
                    <div className={`feedback-scale${q.stars ? " feedback-stars" : ""}`} role="radiogroup" aria-label={q.text}>
                      {q.options.map(({ value, label }) => (
                        <label key={value} className={ratings[q.key] === value ? "selected" : undefined}>
                          <input type="radio" name={q.key} value={value} aria-label={label} checked={ratings[q.key] === value} onChange={() => setRatings((r) => ({ ...r, [q.key]: value }))} required />
                          {q.stars ? <><Star aria-hidden="true" fill={(ratings[q.key] ?? 0) >= value ? "currentColor" : "none"} /><span>{label}</span></> : <span>{label}</span>}
                        </label>
                      ))}
                    </div>
                    {q.stars ? (
                      <div className="feedback-scale-labels" aria-hidden="true">
                        <span>{q.low_label}</span>
                        <span>{q.high_label}</span>
                      </div>
                    ) : null}
                  </fieldset>
                </li>
              ))}
            </ol>
          </section>
        ))}
        <label className="field">
          7. Additional Comments or Suggestions (optional)
          <textarea name="comment" value={comment} disabled={busy} maxLength={MAX_COMMENT} onChange={(e) => setComment(e.target.value)} placeholder="Share any additional comments or suggestions." />
          <small>
            {comment.length} / {MAX_COMMENT}
          </small>
        </label>
        <FormError message={error} />
        <div className="dialog-actions">
          <span className="small feedback-progress">
            {answered} of {view.questions.length} rated
          </span>
          <button type="submit" className="btn primary" disabled={busy || !complete}>
            {busy ? "Sending…" : "Submit feedback"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
