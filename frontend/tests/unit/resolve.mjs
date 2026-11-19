/* Lets the unit tests load application modules the way the Next.js bundler does: "@/..." means src/, and an
   import without an extension finds the .ts or .tsx file. Node strips the TypeScript types itself.
   Loaded with `node --import ./tests/unit/resolve.mjs` (see the test:unit script). */
import { registerHooks } from "node:module";

const SRC = new URL("../../src/", import.meta.url);
const HAS_EXTENSION = /\.[cm]?[jt]sx?$|\.json$/;

registerHooks({
  resolve(specifier, context, nextResolve) {
    const target = specifier.startsWith("@/") ? new URL(specifier.slice(2), SRC).href : specifier;
    const local = target !== specifier || /^(\.{1,2}\/|file:)/.test(specifier);
    if (local && !HAS_EXTENSION.test(target)) {
      for (const extension of [".ts", ".tsx"]) {
        try {
          return nextResolve(target + extension, context);
        } catch {
          /* Try the next extension. */
        }
      }
    }
    return nextResolve(target, context);
  },
});
