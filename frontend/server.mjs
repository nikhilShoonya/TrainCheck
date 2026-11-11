/* TrainCheck web server: Next.js behind a thin Node.js HTTP server.
 *
 * Why it exists: Next.js rewrites forward a browser's own X-Forwarded-For header unchanged and add
 * nothing when it is absent, so FastAPI could neither see the real client address nor tell a forged
 * one apart. Here every request has the connection's real address appended, the way a reverse proxy
 * does. The browser cannot forge the socket address, and FastAPI reads the chain from the right,
 * trusting only the hops listed in its TRUSTED_PROXIES. See DECISIONS/ADR-0002-trusted-proxy-rate-limiting.md.
 *
 *   npm run dev     development (hot reload)
 *   npm run start   production, after npm run build
 */
import { createServer } from "node:http";

const production = process.argv.includes("--production");
if (production) process.env.NODE_ENV = "production";

/** Appends the address of whoever opened this TCP connection. Existing entries are kept for FastAPI to judge. */
export function appendClientAddress(req) {
  const peer = req.socket.remoteAddress;
  if (!peer) return;
  const existing = req.headers["x-forwarded-for"];
  req.headers["x-forwarded-for"] = existing ? `${existing}, ${peer}` : peer;
}

const { default: next } = await import("next");
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const hostname = process.env.HOST || undefined; // Unset: listen on all interfaces, as `next dev` does.
const app = next({ dev: !production, dir: import.meta.dirname, hostname, port });
const handle = app.getRequestHandler();
await app.prepare();

createServer((req, res) => {
  appendClientAddress(req);
  handle(req, res);
}).listen(port, hostname, () => {
  console.log(`> TrainCheck ready on http://${hostname ?? "localhost"}:${port} (${production ? "production" : "development"})`);
});
