"use client";

import { useState, type FormEvent } from "react";
import { FormError } from "@/components/ui";
import { Modal } from "@/components/ui/dialog";
import { ApiError, api } from "@/lib/api";
import type { FeedbackKey, FeedbackView } from "@/lib/types";

const MAX_COMMENT = 2000;
const SCALE = [1, 2, 3, 4, 5];

/** The five-question feedback asked once after a post-training assessment. */
export function FeedbackDialog({ attemptId, view, onClose, onSubmitted }: { attemptId: string; view: FeedbackView; onClose: () => void; onSubmitted: (view: FeedbackView) => void }) {
  const [ratings, setRatings] = useState<Partial<Record<FeedbackKey, number>>>({});
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const answered = view.questions.filter((q) => ratings[q.key]).length;
  const complete = answered === view.questions.length;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!complete) {
      setError("Please rate all five questions.");
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
    <Modal title="Training & assessment feedback" onClose={() => !busy && onClose()} wide>
      <form className="feedback-form" onSubmit={(e) => void submit(e)}>
        <p>
          Tell us about <strong>{view.training_title}</strong> and its assessment. Your answers help L&amp;D improve the training. Rate each statement from 1 (lowest) to 5 (highest).
        </p>
        <ol className="feedback-questions">
          {view.questions.map((q, index) => (
            <li key={q.key}>
              <fieldset>
                <legend>
                  <span className="feedback-number">{index + 1}</span>
                  {q.text}
                </legend>
                <div className="feedback-scale" role="radiogroup" aria-label={q.text}>
                  {SCALE.map((value) => (
                    <label key={value} className={ratings[q.key] === value ? "selected" : undefined}>
                      <input type="radio" name={q.key} value={value} checked={ratings[q.key] === value} onChange={() => setRatings((r) => ({ ...r, [q.key]: value }))} required />
                      <span>{value}</span>
                    </label>
                  ))}
                </div>
                <div className="feedback-scale-labels" aria-hidden="true">
                  <span>{q.low_label}</span>
                  <span>{q.high_label}</span>
                </div>
              </fieldset>
            </li>
          ))}
        </ol>
        <label className="field">
          Any other comments? (optional)
          <textarea name="comment" value={comment} maxLength={MAX_COMMENT} onChange={(e) => setComment(e.target.value)} placeholder="What worked well, and what could be better?" />
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
