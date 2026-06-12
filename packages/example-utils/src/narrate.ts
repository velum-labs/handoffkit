/** Narration helpers for the demo series: readable in a terminal or piped. */

const useColor = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;

function paint(code: string, text: string): string {
  return useColor ? `\u001b[${code}m${text}\u001b[0m` : text;
}

export const bold = (text: string): string => paint("1", text);
export const dim = (text: string): string => paint("2", text);
const cyan = (text: string): string => paint("36", text);
const green = (text: string): string => paint("32", text);
const yellow = (text: string): string => paint("33", text);

export function banner(id: string, title: string, summary: string): void {
  console.log("");
  console.log(bold(`━━━ demo ${id}: ${title} `.padEnd(72, "━")));
  console.log(dim(summary));
  console.log("");
}

export function step(text: string): void {
  console.log(`${cyan("▸")} ${text}`);
}

export function detail(text: string): void {
  for (const line of text.split("\n")) {
    console.log(`  ${line}`);
  }
}

export function ok(text: string): void {
  console.log(`${green("✓")} ${text}`);
}

export function expectedFailure(text: string): void {
  console.log(`${yellow("⛔")} ${text} ${dim("(expected: this is the policy working)")}`);
}

export function finale(text: string): void {
  console.log("");
  console.log(green(bold(`■ ${text}`)));
}
