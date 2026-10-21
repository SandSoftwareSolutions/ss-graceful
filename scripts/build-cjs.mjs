#!/usr/bin/env node
// Makes a CommonJS copy of this package so `require("@sandsoftwaresolutions/<name>")` works next to `import`.
//
//   node scripts/build-cjs.mjs            writes dist/*.cjs and dist/*.d.cts from src/
//   node scripts/build-cjs.mjs --check    builds into a temp folder and runs test.js against that build
//
// No dependencies. It only understands the plain forms these packages use (one line per import or export):
//   import { a, b as c } from "x";   export function f / export async function f / export class C / export const x = ...
//   export { a, b as c };
// Anything else at the start of a line (`import x from`, `export default`, `export * from`, ...) stops the build
// with an error instead of producing a wrong file.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const cjsSpecifier = (specifier) => (specifier.startsWith("./") || specifier.startsWith("../") ? specifier.replace(/\.js$/, ".cjs") : specifier);

export function toCommonJs(source, file = "source") {
  const lines = source.split("\n");
  const exported = []; // [exportedName, localName]
  const out = [];
  let inBlockComment = false;
  lines.forEach((line, index) => {
    const where = `${file}:${index + 1}`;
    if (inBlockComment) {
      out.push(line);
      if (line.includes("*/")) inBlockComment = false;
      return;
    }
    if (/^\s*\/\*/.test(line) && !line.includes("*/")) {
      inBlockComment = true;
      out.push(line);
      return;
    }
    const importMatch = /^import \{([^}]*)\} from "([^"]+)";\s*$/.exec(line);
    if (importMatch) {
      const names = importMatch[1]
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
          const alias = /^(\S+)\s+as\s+(\S+)$/.exec(part);
          return alias ? `${alias[1]}: ${alias[2]}` : part;
        });
      out.push(`const { ${names.join(", ")} } = require("${cjsSpecifier(importMatch[2])}");`);
      return;
    }
    const declaration = /^export (async function\*?|function\*?|class|const) ([A-Za-z_$][\w$]*)/.exec(line);
    if (declaration) {
      exported.push([declaration[2], declaration[2]]);
      out.push(line.slice("export ".length));
      return;
    }
    const list = /^export \{([^}]*)\};?\s*$/.exec(line);
    if (list) {
      for (const part of list[1].split(",").map((p) => p.trim()).filter(Boolean)) {
        const alias = /^(\S+)\s+as\s+(\S+)$/.exec(part);
        exported.push(alias ? [alias[2], alias[1]] : [part, part]);
      }
      return;
    }
    if (/^(import|export)\b/.test(line)) throw new Error(`${where}: not a form this converter understands: ${line.trim()}`);
    if (/\b(import\.meta|__dirname|__filename)\b/.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line)) throw new Error(`${where}: uses ${line.match(/import\.meta|__dirname|__filename/)[0]}, which differs between ESM and CommonJS`);
    if (/^await\b/.test(line)) throw new Error(`${where}: top-level await cannot be converted`);
    out.push(line);
  });
  const names = new Set();
  for (const [name] of exported) {
    if (names.has(name)) throw new Error(`${file}: ${name} is exported twice`);
    names.add(name);
  }
  const tail = exported.map(([name, local]) => `exports.${name} = ${local};`);
  return `"use strict";\n${out.join("\n").replace(/\s*$/, "\n")}\n${tail.join("\n")}\n`;
}

export function toDeclarationCts(source) {
  return source.replace(/(from\s+["'])(\.{1,2}\/[^"']*?)\.js(["'])/g, "$1$2.cjs$3");
}

export function build(outDir, srcDir = join(root, "src")) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const built = [];
  for (const name of readdirSync(srcDir)) {
    const from = join(srcDir, name);
    if (name.endsWith(".js")) {
      writeFileSync(join(outDir, name.replace(/\.js$/, ".cjs")), toCommonJs(readFileSync(from, "utf8"), `src/${name}`));
      built.push(name.replace(/\.js$/, ".cjs"));
    } else if (name.endsWith(".d.ts")) {
      writeFileSync(join(outDir, name.replace(/\.d\.ts$/, ".d.cts")), toDeclarationCts(readFileSync(from, "utf8")));
      built.push(name.replace(/\.d\.ts$/, ".d.cts"));
    }
  }
  return built;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--check")) {
    // Copy the package to a temp folder, build there, point test.js at the CommonJS build and run it.
    const temp = mkdtempSync(join(tmpdir(), "cjs-check-"));
    try {
      cpSync(root, temp, { recursive: true, filter: (p) => !/(^|\/)(node_modules|\.git|dist)(\/|$)/.test(p.slice(root.length)) });
      build(join(temp, "dist"), join(temp, "src"));
      const testFile = join(temp, "test.js");
      const original = readFileSync(testFile, "utf8");
      if (!original.includes('"./src/index.js"')) throw new Error('test.js does not import "./src/index.js"');
      writeFileSync(testFile, original.replaceAll('"./src/index.js"', '"./dist/index.cjs"'));
      const result = spawnSync(process.execPath, ["--test"], { cwd: temp, stdio: "inherit" });
      if (result.status !== 0) process.exit(result.status ?? 1);
      // The CommonJS build must offer exactly the names the ES module offers.
      const esm = Object.keys(await import(join(root, "src/index.js"))).sort();
      const { createRequire } = await import("node:module");
      const cjs = Object.keys(createRequire(join(temp, "x.js"))("./dist/index.cjs")).sort();
      if (JSON.stringify(esm) !== JSON.stringify(cjs)) {
        console.error(`export names differ\n esm: ${esm.join(", ")}\n cjs: ${cjs.join(", ")}`);
        process.exit(1);
      }
      console.log(`cjs ok: ${cjs.length} exports, test.js passes against dist/index.cjs`);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  } else {
    const built = build(join(root, "dist"));
    console.log(`dist/: ${built.join(", ")}`);
  }
}
