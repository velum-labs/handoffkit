import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import typescript from "typescript";

const root = fileURLToPath(new URL("..", import.meta.url));
const outFile = `${root}/docs/generated/code-api.md`;
const symbolIndexFile = `${root}/docs/source-symbol-index.md`;
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

function walkSourceFiles(directory, extension) {
  if (!existsSync(directory)) return [];
  const output = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name !== "test" && entry.name !== "tests" && entry.name !== "__pycache__") {
        output.push(...walkSourceFiles(path, extension));
      }
    } else if (
      entry.isFile() &&
      entry.name.endsWith(extension) &&
      !entry.name.endsWith(`.test${extension}`)
    ) {
      output.push(path);
    }
  }
  return output;
}

function packageSourceRoots(base) {
  if (!existsSync(`${root}/${base}`)) return [];
  return readdirSync(`${root}/${base}`, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(`${root}/${base}/${entry.name}/src`))
    .map((entry) => `${base}/${entry.name}/src`)
    .sort();
}

function declarationNames(statement) {
  if (
    typescript.isClassDeclaration(statement) ||
    typescript.isFunctionDeclaration(statement) ||
    typescript.isInterfaceDeclaration(statement) ||
    typescript.isTypeAliasDeclaration(statement) ||
    typescript.isEnumDeclaration(statement)
  ) {
    return statement.name === undefined ? [] : [statement.name.text];
  }
  if (typescript.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) =>
      typescript.isIdentifier(declaration.name) ? [declaration.name.text] : []
    );
  }
  return [];
}

function declarationKind(statement) {
  if (typescript.isClassDeclaration(statement)) return "class";
  if (typescript.isFunctionDeclaration(statement)) return "function";
  if (typescript.isInterfaceDeclaration(statement)) return "interface";
  if (typescript.isTypeAliasDeclaration(statement)) return "type";
  if (typescript.isEnumDeclaration(statement)) return "enum";
  if (typescript.isVariableStatement(statement)) {
    return (statement.declarationList.flags & typescript.NodeFlags.Const) !== 0
      ? "const"
      : "variable";
  }
  return "declaration";
}

function hasExportModifier(statement) {
  return statement.modifiers?.some(
    (modifier) =>
      modifier.kind === typescript.SyntaxKind.ExportKeyword ||
      modifier.kind === typescript.SyntaxKind.DefaultKeyword
  ) ?? false;
}

function tsSymbolSections() {
  const sourceRoots = [
    ...packageSourceRoots("packages"),
    ...packageSourceRoots("legacy/packages")
  ];
  const sections = [];
  for (const sourceRoot of sourceRoots) {
    const modules = [];
    for (const absoluteFile of walkSourceFiles(`${root}/${sourceRoot}`, ".ts").sort()) {
      if (absoluteFile.endsWith(".d.ts")) continue;
      const source = read(absoluteFile);
      const sourceFile = typescript.createSourceFile(
        absoluteFile,
        source,
        typescript.ScriptTarget.Latest,
        true,
        typescript.ScriptKind.TS
      );
      const locallyExported = new Set();
      for (const statement of sourceFile.statements) {
        if (typescript.isExportDeclaration(statement) && statement.moduleSpecifier === undefined) {
          for (const element of statement.exportClause?.elements ?? []) {
            locallyExported.add(element.propertyName?.text ?? element.name.text);
          }
        }
      }
      const symbols = [];
      for (const statement of sourceFile.statements) {
        const names = declarationNames(statement);
        if (names.length === 0) continue;
        for (const name of names) {
          if (hasExportModifier(statement) || locallyExported.has(name)) {
            symbols.push({ name, kind: declarationKind(statement) });
          }
        }
      }
      if (symbols.length > 0) {
        modules.push({ file: relative(root, absoluteFile), symbols });
      }
    }
    if (modules.length > 0) {
      sections.push({ name: sourceRoot.replace(/\/src$/, ""), modules });
    }
  }
  return sections;
}

function pythonSymbolSections() {
  const script = `
import ast
import json
from pathlib import Path
import sys

root = Path(sys.argv[1])
source_roots = sorted((root / "python").glob("*/src"))
generated = root / "packages/protocol/generated/python"
if generated.exists():
    source_roots.append(generated)

sections = []
for source_root in source_roots:
    modules = []
    for path in sorted(source_root.rglob("*.py")):
        if "__pycache__" in path.parts or "tests" in path.parts:
            continue
        tree = ast.parse(path.read_text(), filename=str(path))
        symbols = []
        for node in tree.body:
            if isinstance(node, ast.ClassDef):
                symbols.append({"name": node.name, "kind": "class"})
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                symbols.append({"name": node.name, "kind": "function"})
        if symbols:
            modules.append({"file": str(path.relative_to(root)), "symbols": symbols})
    if modules:
        sections.append({
            "name": str(source_root.relative_to(root)).removesuffix("/src"),
            "modules": modules,
        })
print(json.dumps(sections))
`;
  const py = spawnSync("python3", ["-c", script, root], {
    cwd: root,
    encoding: "utf8"
  });
  if (py.status !== 0) throw new Error(py.stderr || "failed to inspect Python symbols");
  return JSON.parse(py.stdout);
}

function renderCodeApi() {
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

function renderSymbolIndex() {
  const lines = [
    "# Source symbol index",
    "",
    "This index is generated from current source by `pnpm docs:generate-code`. Do not edit it by hand. It lists exported top-level TypeScript declarations and top-level Python classes/functions; tests are intentionally excluded.",
    "",
    "Use it with the narrative references when you need to find the module that owns a symbol. For comment-derived package entry-point documentation, see [Generated code API reference](generated/code-api.md).",
    "",
    "## TypeScript exported declarations",
    ""
  ];
  for (const section of tsSymbolSections()) {
    lines.push(`### \`${section.name}\``, "");
    for (const module of section.modules) {
      const symbols = module.symbols
        .map((symbol) => `${symbol.name} (${symbol.kind})`)
        .join(", ");
      lines.push(`- \`${module.file}\`: ${symbols}`);
    }
    lines.push("");
  }
  lines.push("## Python top-level symbols", "");
  for (const section of pythonSymbolSections()) {
    lines.push(`### \`${section.name}\``, "");
    for (const module of section.modules) {
      const symbols = module.symbols
        .map((symbol) => {
          const visibility = symbol.name.startsWith("_") ? "internal" : "public";
          return `${symbol.name} (${symbol.kind}, ${visibility})`;
        })
        .join(", ");
      lines.push(`- \`${module.file}\`: ${symbols}`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

const generatedFiles = [
  { path: outFile, output: renderCodeApi() },
  { path: symbolIndexFile, output: renderSymbolIndex() }
];
let stale = false;
for (const generated of generatedFiles) {
  if (check) {
    const current = existsSync(generated.path) ? read(generated.path) : "";
    if (current !== generated.output) {
      console.error(`${relative(root, generated.path)} is stale; run pnpm docs:generate-code`);
      stale = true;
    }
  } else {
    mkdirSync(dirname(generated.path), { recursive: true });
    writeFileSync(generated.path, generated.output);
    console.log(`generated ${relative(root, generated.path)}`);
  }
}
if (stale) process.exit(1);
