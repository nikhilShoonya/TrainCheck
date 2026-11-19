/* The answer-save request, between the API client and the saving queue (answerSync).

   A reply counts as a confirmation only if it is the backend's acknowledgement of exactly the selection sent:
   PUT /attempts/{attempt}/questions/{question}/answer returns
     {"data": {"saved_at": "<ISO time>", "selected_option_ids": [...], "revision": <int>}}
   where the selection is the one sent with duplicates removed. Anything else, even with HTTP 200, is
   INVALID_RESPONSE: the choice stays queued and is never shown as saved. */

import { type RequestOptions, api, invalidResponse } from "@/lib/api";
import type { SendOptions } from "./answerSync";

/** The API client's limit for one save; the queue's own backstop (REQUEST_TIMEOUT_MS) is longer. */
export const SAVE_TIMEOUT_MS = 15_000;

export interface AnswerAck {
  selected: string[];
  /** The answer's revision after this save; null if the server did not report one. */
  revision: number | null;
}

/** Validates an answer-save acknowledgement against the selection that was sent. Throws INVALID_RESPONSE. */
export function parseAnswerAck(data: unknown, sent: readonly string[]): AnswerAck {
  const ack = data as { saved_at?: unknown; selected_option_ids?: unknown; revision?: unknown } | null;
  if (!ack || typeof ack !== "object" || Array.isArray(ack)) throw invalidResponse(200);
  if (typeof ack.saved_at !== "string" || !ack.saved_at) throw invalidResponse(200);
  const returned = ack.selected_option_ids;
  if (!Array.isArray(returned) || !returned.every((x) => typeof x === "string")) throw invalidResponse(200);
  const expected = [...new Set(sent)];
  const stored = [...new Set(returned as string[])];
  if (stored.length !== expected.length || !expected.every((x) => stored.includes(x))) throw invalidResponse(200); // A different selection.
  if (ack.revision !== undefined && !(typeof ack.revision === "number" && Number.isInteger(ack.revision) && ack.revision >= 0)) throw invalidResponse(200);
  return { selected: stored, revision: typeof ack.revision === "number" ? ack.revision : null };
}

type Put = (path: string, body: unknown, options?: RequestOptions) => Promise<unknown>;

/** The `send` the saving queue uses for one attempt. */
export function answerSender(attemptId: string, put: Put = api.put) {
  return async (questionId: string, selected: string[], { baseRevision, signal, opId }: SendOptions): Promise<AnswerAck> => {
    // op_id lets the server say, on a conflict, whether its answer came from this very save (its reply was lost).
    const body = baseRevision === null ? { selected_option_ids: selected, op_id: opId } : { selected_option_ids: selected, base_revision: baseRevision, op_id: opId };
    const data = await put(`/attempts/${attemptId}/questions/${questionId}/answer`, body, { signal: signal ?? undefined, timeoutMs: SAVE_TIMEOUT_MS });
    return parseAnswerAck(data, selected);
  };
}
