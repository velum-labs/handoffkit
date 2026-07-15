import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("..", import.meta.url));
const outFile = `${root}/docs/generated/code-api.md`;
const check = process.argv.includes("--check");

function read(path) {
  return readFileSync(path, "utf8");
}

function cleanComment(text) {
  return text
    .replace(/^#![^\n]*\n/, "")
    .replace(/^\/\*\*?/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, "").trimEnd())
    .join("\n")
    .trim();
}

function leadingBlockComment(source) {
  const match = source.match(/^(?:#![^\n]*\n)?\s*\/\*\*[\s\S]*?\*\//);
  return match ? cleanComment(match[0]) : "";
}

function docBefore(source, index) {
  const before = source.slice(0, index);
  let last = "";
  for (const match of before.matchAll(/\/\*\*[\s\S]*?\*\//g)) {
    const suffix = before.slice((match.index ?? 0) + match[0].length);
    if (/^\s*$/.test(suffix)) last = match[0];
  }
  return last ? cleanComment(last) : "";
}

function codeStart(source) {
  const match = source.match(/^(?:#![^\n]*\n)?\s*\/\*\*[\s\S]*?\*\//);
  return match ? match[0].length : 0;
}

function summarizeExport(statement) {
  const oneLine = statement.trim().replace(/\s+/g, " ");
  if (oneLine.includes(" from ")) return oneLine.endsWith(";") ? oneLine : `${oneLine};`;
  const boundary = oneLine.search(/\s[={]/);
  if (boundary !== -1) return `${oneLine.slice(0, boundary)} ...`;
  const brace = oneLine.indexOf("{");
  if (brace !== -1) return `${oneLine.slice(0, brace).trim()} ...`;
  return oneLine;
}

function tsEntryDocs() {
  const files = readdirSync(`${root}/packages`, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `packages/${entry.name}/src/index.ts`)
    .filter((file) => existsSync(`${root}/${file}`))
    .sort();
  const sections = [];
  for (const file of files) {
    const source = read(`${root}/${file}`);
    const moduleDoc = leadingBlockComment(source);
    const firstCode = codeStart(source);
    const exports = [];
    const exportPattern = /(?:^|\n)(export\s+(?:type\s+)?\{[\s\S]*?\}\s+from\s+["'][^"']+["'];|export\s+(?:const|class|function|type|interface|enum)\s+[^\n]+)/g;
    for (const match of source.matchAll(exportPattern)) {
      const index = match.index ?? 0;
      const statement = summarizeExport(match[1]);
      const doc = index > firstCode + 2 ? docBefore(source, index) : "";
      exports.push({ statement, doc });
    }
    sections.push({ file, moduleDoc, exports });
  }
  return sections;
}

function pythonEntryDocs() {
  const files = [
    "python/fusionkit-core/src/fusionkit_core/__init__.py",
    "python/fusionkit-server/src/fusionkit_server/__init__.py",
    "python/fusionkit-cli/src/fusionkit_cli/__init__.py",
    "python/fusionkit-evals/src/fusionkit_evals/__init__.py",
    "python/fusionkit-mlx/src/fusionkit_mlx/__init__.py",
    "python/uniroute/src/uniroute/__init__.py",
    "python/uniroute-mlx/src/uniroute_mlx/__init__.py"
  ].filter((file) => existsSync(`${root}/${file}`));
  const script = `
import ast, json, pathlib, sys
payload = []
for file in sys.argv[1:]:
    path = pathlib.Path(file)
    tree = ast.parse(path.read_text(), filename=str(path))
    module_doc = ast.get_docstring(tree) or ""
    names = []
    all_names = []
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id == "__all__":
                    try:
                        value = ast.literal_eval(node.value)
                        if isinstance(value, (list, tuple)):
                            all_names = [str(item) for item in value]
                    except Exception:
                        pass
        if isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            names.append({
                "name": node.name,
                "kind": "class" if isinstance(node, ast.ClassDef) else "function",
                "doc": ast.get_docstring(node) or ""
            })
    payload.append({"file": str(path), "moduleDoc": module_doc, "all": all_names, "symbols": names})
print(json.dumps(payload))
`;
  const py = spawnSync("python3", ["-c", script, ...files.map((file) => `${root}/${file}`)], {
    cwd: root,
    encoding: "utf8"
  });
  if (py.status !== 0) throw new Error(py.stderr || "failed to inspect Python docs");
  return JSON.parse(py.stdout).map((entry) => ({
    ...entry,
    file: relative(root, entry.file)
  }));
}

function render() {
  const lines = [];
  lines.push("# Generated code API reference");
  lines.push("");
  lines.push("This file is generated from source comments by `pnpm docs:generate-code`. Do not edit it by hand. Update JSDoc or Python docstrings in the source files, then regenerate this file.");
  lines.push("");
  lines.push("The generated reference intentionally covers package entry points and Python public package modules. It is the bridge between code annotations and maintained prose documentation.");
  lines.push("");
  lines.push("## TypeScript package entry points");
  lines.push("");
  for (const section of tsEntryDocs()) {
    lines.push(`### \`${section.file}\``);
    lines.push("");
    lines.push(section.moduleDoc || "No module JSDoc was found.");
    lines.push("");
    if (section.exports.length === 0) {
      lines.push("No exports found.");
    } else {
      for (const exp of section.exports) {
        lines.push(`- \`${exp.statement}\``);
        if (exp.doc) lines.push(`  ${exp.doc.replace(/\n/g, " ")}`);
      }
    }
    lines.push("");
  }
  lines.push("## Python public package modules");
  lines.push("");
  for (const section of pythonEntryDocs()) {
    lines.push(`### \`${section.file}\``);
    lines.push("");
    lines.push(section.moduleDoc || "No module docstring was found.");
    lines.push("");
    if (section.all.length > 0) {
      lines.push("Public exports:");
      lines.push("");
      for (const name of section.all) lines.push(`- \`${name}\``);
      lines.push("");
    }
    if (section.symbols.length > 0) {
      lines.push("Documented local symbols:");
      lines.push("");
      for (const symbol of section.symbols) {
        lines.push(`- \`${symbol.name}\` (${symbol.kind})${symbol.doc ? `: ${symbol.doc.replace(/\n/g, " ")}` : ""}`);
      }
      lines.push("");
    }
  }
  return `${lines.join("\n")}\n`;
}

const output = render();
if (check) {
  const current = existsSync(outFile) ? read(outFile) : "";
  if (current !== output) {
    console.error(`${relative(root, outFile)} is stale; run pnpm docs:generate-code`);
    process.exit(1);
  }
} else {
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, output);
  console.log(`generated ${relative(root, outFile)}`);
}
