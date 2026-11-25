"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Btn, ErrorPanel, FormError, Loading, TextField, fieldErrors, useToast } from "@/components/ui";
import { Modal } from "@/components/ui/dialog";
import { ApiError, api } from "@/lib/api";
import { ALREADY_DELETED, codeMatches, deletionLines, keptSentence, type DeletionPreview } from "./trainingDeletionView";

/** Permanent deletion of a training. Shows the records it removes (counted now by the server) and what stays, and
    asks for the training code. The server checks the code and the role again and deletes everything or nothing;
    success is shown only after it answers. A training already deleted (by someone else or a repeated click) closes
    the dialog and refreshes the list. */
export function DeleteTrainingDialog({ training, onClose, onDeleted }: { training: { id: string; title: string; training_code: string }; onClose: () => void; onDeleted: () => void }) {
  const toast = useToast();
  const [preview, setPreview] = useState<DeletionPreview | null>(null);
  const [loadError, setLoadError] = useState<ApiError | Error | null>(null);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [attempt, setAttempt] = useState(0);

  const gone = () => {
    toast(ALREADY_DELETED);
    onDeleted();
    onClose();
  };

  useEffect(() => {
    let live = true;
    // Always asked fresh (not from the page cache): the counts must describe the training as it is now.
    api
      .get<DeletionPreview>(`/admin/trainings/${training.id}/deletion-preview`)
      .then((data) => live && setPreview(data))
      .catch((e: unknown) => {
        if (!live) return;
        if (e instanceof ApiError && e.status === 404) gone();
        else setLoadError(e instanceof Error ? e : new Error(String(e)));
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loaded once per training (and per Retry).
  }, [training.id, attempt]);

  const code = preview?.training.code ?? training.training_code;
  const confirmed = codeMatches(typed, code);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (running.current || !confirmed || !preview) return; // One request at a time: a double click sends nothing more.
    running.current = true;
    setBusy(true);
    setError("");
    try {
      await api.del(`/admin/trainings/${training.id}`, undefined, { confirmation_code: typed.trim() });
      toast(`${preview.training.title} was permanently deleted.`);
      onDeleted();
      onClose();
    } catch (e) {
      running.current = false;
      setBusy(false);
      if (e instanceof ApiError && e.status === 404) gone();
      else setError(fieldErrors(e));
    }
  };

  const lines = preview ? deletionLines(preview.counts) : [];
  return (
    <Modal title="Permanently delete training?" onClose={busy ? () => undefined : onClose}>
      {!preview ? (
        loadError ? (
          <ErrorPanel error={loadError} retry={() => { setLoadError(null); setAttempt((n) => n + 1); }} />
        ) : (
          <Loading label="Counting the records of this training…" />
        )
      ) : (
        <form onSubmit={(e) => void submit(e)}>
          <p>
            <strong>{preview.training.title}</strong> ({preview.training.code})
          </p>
          <div className="notice danger" role="alert">
            <div>
              This permanently deletes the training with its assignments, completion records, scores and assessment history. It cannot be undone, and archiving is not used instead.
            </div>
          </div>
          <p>
            <strong>Will be deleted</strong>
          </p>
          {lines.length ? (
            <ul>
              <li>The training, its assessment settings and its setup</li>
              {lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : (
            <p className="small">The training and its setup. It has no assignments, assessments or other records yet.</p>
          )}
          <p>
            <strong>Will remain</strong>
          </p>
          <p className="small">{keptSentence(preview.counts)}</p>
          <TextField
            label={
              <>
                Type the training code <strong>{code}</strong> to confirm
              </>
            }
            name="confirmation_code"
            autoComplete="off"
            spellCheck={false}
            value={typed}
            disabled={busy}
            onChange={(e) => setTyped(e.target.value)}
          />
          <FormError message={error} />
          <div className="dialog-actions">
            <Btn onClick={onClose} disabled={busy}>
              Cancel
            </Btn>
            <button className="btn primary tone-danger" type="submit" disabled={busy || !confirmed} aria-describedby={confirmed ? undefined : "delete-training-hint"}>
              {busy ? "Deleting…" : "Permanently delete training"}
            </button>
          </div>
          {!confirmed ? (
            <p className="small" id="delete-training-hint">
              The button is enabled once the training code is typed.
            </p>
          ) : null}
        </form>
      )}
    </Modal>
  );
}
