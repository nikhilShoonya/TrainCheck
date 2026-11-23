/* Signing out. The browser leaves the workspace only once the server has ended the session (or says it had already
   ended); a sign-out that fails leaves the person signed in, says so, and can be tried again.

   No path aliases here: the unit tests load this file directly with Node. */

import { ApiError } from "./api";

export type SignOutOutcome = "SIGNED_OUT" | "SESSION_ALREADY_ENDED";

export interface SignOutSteps {
  /** Stops every answer-saving queue first, so nothing can write answers back while signing out. */
  stopAnswerQueues: () => void;
  /** Asks the server to end the session. */
  logout: () => Promise<unknown>;
  /** Only after the session is confirmed ended: clears cached data and saved answers, and opens the sign-in page. */
  finish: () => void;
}

/** Resolves once the session is confirmed ended (and `finish` has run). Throws the server's or network's error
    otherwise, without running `finish`: the session may still be valid, so nothing is cleared and nothing redirects. */
export async function signOutFlow(steps: SignOutSteps): Promise<SignOutOutcome> {
  steps.stopAnswerQueues();
  let outcome: SignOutOutcome;
  try {
    await steps.logout();
    outcome = "SIGNED_OUT";
  } catch (error) {
    // 401: the session had already ended (expired, revoked, signed out elsewhere). That is a confirmed sign-out.
    if (error instanceof ApiError && error.status === 401 && error.code === "UNAUTHENTICATED") outcome = "SESSION_ALREADY_ENDED";
    else throw error;
  }
  steps.finish();
  return outcome;
}
