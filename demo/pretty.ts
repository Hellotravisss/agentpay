/**
 * Tiny zero-dependency ANSI helper for the demo. Colors are disabled
 * automatically when stdout is not a TTY or when NO_COLOR is set, so piped
 * output stays clean.
 */
const enabled = process.stdout.isTTY === true && !process.env.NO_COLOR;

const wrap = (code: number) => (s: string): string => (enabled ? `\x1b[${code}m${s}\x1b[0m` : s);

export const c = {
  bold: wrap(1),
  dim: wrap(2),
  red: wrap(31),
  green: wrap(32),
  cyan: wrap(36),
};

const WIDTH = 66;

/** A full-width horizontal rule. */
export function rule(): string {
  return c.dim("─".repeat(WIDTH));
}

/** A titled banner block printed at the top of the demo. */
export function banner(title: string, subtitle: string): string {
  return [
    "",
    rule(),
    `  ${c.bold(c.cyan(title))}  ${c.dim(subtitle)}`,
    rule(),
  ].join("\n");
}

/** A numbered scenario header with a one-line explanation. */
export function scene(n: number, title: string, detail: string): void {
  console.log(`\n${c.bold(c.cyan(`${n}.`))} ${c.bold(title)}  ${c.dim("— " + detail)}`);
}

/** An aligned "label: value (note)" line for the dashboard section. */
export function kv(label: string, value: string, note?: string): string {
  return `  ${c.dim((label + ":").padEnd(22))} ${value}${note ? "  " + c.dim(`(${note})`) : ""}`;
}
