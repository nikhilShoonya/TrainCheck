"use client";

import { useState, type FormEvent } from "react";
import { Star } from "lucide-react";
import { FormError } from "@/components/ui";
import { Modal } from "@/components/ui/dialog";
import { ApiError, api } from "@/lib/api";
import type { FeedbackView } from "@/lib/types";

const MAX_COMMENT = 2000;

/** What the dialog renders: the official training form, or the common induction form (same controls and layout). */
export interface FeedbackFormView {
  training_title: string;
  questions: { key: string; text: string; section: string; options: { value: number; label: string }[]; stars: boolean; low_label: string; high_label: string }[];
}

interface FeedbackDialogProps<V> {
  attemptId: string;
  view: FeedbackFormView;
  onClose: () => void;
  onSubmitted: (view: V) => void;
  /** The induction module posts to its own endpoint; Training's is used otherwise. */
  submitPath?: string;
  title?: string;
  /** Replaces the opening sentence (the induction form speaks about the induction experience). */
  intro?: string;
  /** The optional comment box: Training always shows it; the induction form's configuration decides. */
  comment?: { enabled: boolean; label: string | null };
  /** Shows the form without sending anything (L&D preview of the configured form). */
  preview?: boolean;
}

/** The official ten-question training form, asked once after a post-training assessment. The same dialog shows the
    common induction feedback form. */
export function FeedbackDialog<V = FeedbackView>({ attemptId, view, onClose, onSubmitted, submitPath, title = "Training Feedback Form", intro, comment: commentBox, preview }: FeedbackDialogProps<V>) {
  const [ratings, setRatings] = useState<Record<string, number>>({});
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const answered = view.questions.filter((q) => ratings[q.key]).length;
  const complete = answered === view.questions.length;
  const sections = [...new Set(view.questions.map((q) => q.section))];
  const showComment = commentBox ? commentBox.enabled : true;
  const commentLabel = commentBox ? `${commentBox.label?.trim() || "Additional comments or suggestions"} (optional)` : "7. Additional Comments or Suggestions (optional)";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (preview) {
      onClose();
      return;
    }
    if (!complete) {
      setError(`Please rate all ${view.questions.length} questions.`);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const saved = await api.post<V>(submitPath ?? `/attempts/${attemptId}/feedback`, { ratings, comment: comment.trim() || null });
      onSubmitted(saved);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Your feedback could not be sent. Please try again.");
      setBusy(false);
    }
  };

  return (
    <Modal title={preview ? `${title} (preview)` : title} onClose={() => !busy && onClose()} wide>
      <form className="feedback-form" onSubmit={(e) => void submit(e)}>
        <p>
          {intro ?? (
            <>
              Tell us about <strong>{view.training_title}</strong>. Your answers help L&amp;D improve the training.
            </>
          )}{" "}
          Please answer all {view.questions.length} rating questions.{showComment ? " Comments are optional." : ""}
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
        {showComment ? (
        <label className="field">
          {commentLabel}
          <textarea name="comment" value={comment} disabled={busy} maxLength={MAX_COMMENT} onChange={(e) => setComment(e.target.value)} placeholder="Share any additional comments or suggestions." />
          <small>
            {comment.length} / {MAX_COMMENT}
          </small>
        </label>
        ) : null}
        <FormError message={error} />
        <div className="dialog-actions">
          <span className="small feedback-progress">
            {answered} of {view.questions.length} rated
          </span>
          <button type="submit" className="btn primary" disabled={busy || (!complete && !preview)}>
            {preview ? "Close preview" : busy ? "Sending…" : "Submit feedback"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
