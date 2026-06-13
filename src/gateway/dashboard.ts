import { readFileSync } from "node:fs";

/**
 * The admin dashboard is a single self-contained HTML file (no build step, no
 * external assets) served at GET /admin. It reads the existing /admin/* JSON
 * endpoints, so it adds a view, not a new data path. Loaded once and cached.
 */
let cached: string | undefined;

export function dashboardHtml(): string {
  if (cached === undefined) {
    cached = readFileSync(new URL("./dashboard.html", import.meta.url), "utf8");
  }
  return cached;
}
