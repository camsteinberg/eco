#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT_DIRS = ["apps", "packages", "tests"];
const PACKAGE_JSON = "package.json";
const SKIP_DIRS = new Set(["node_modules", "dist", ".next", "coverage", "target", ".turbo"]);
const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
]);

const repoRoot = process.cwd();
const packageFiles = [];
const sourceFiles = [];

for (const root of ROOT_DIRS) {
  const rootPath = path.join(repoRoot, root);
  if (fs.existsSync(rootPath)) {
    walk(rootPath);
  }
}

const packages = packageFiles
  .map((file) => {
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!manifest.name) {
      return null;
    }

    const deps = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.peerDependencies,
      ...manifest.optionalDependencies,
    };

    return {
      dir: path.dirname(file),
      file,
      name: manifest.name,
      deps: Object.keys(deps ?? {}),
    };
  })
  .filter(Boolean);

const packageNames = new Set(packages.map((pkg) => pkg.name));
const packageGraph = new Map(
  packages.map((pkg) => [pkg.name, pkg.deps.filter((dep) => packageNames.has(dep))]),
);

const packageCycles = findStronglyConnectedComponents(packageGraph);

const fileGraph = new Map();
const runtimeGraph = new Map();
const selfImports = [];
const packageByDir = [...packages].sort((a, b) => b.dir.length - a.dir.length);

for (const file of sourceFiles) {
  const packageInfo = packageByDir.find((pkg) => file.startsWith(`${pkg.dir}${path.sep}`));
  const sourceText = fs.readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
  const allEdges = new Set();
  const runtimeEdges = new Set();

  sourceFile.forEachChild((node) => {
    if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) {
      return;
    }

    const specifierNode = node.moduleSpecifier;
    if (!specifierNode || !ts.isStringLiteral(specifierNode)) {
      return;
    }

    const specifier = specifierNode.text;
    if (specifier.startsWith(".")) {
      const resolved = resolveRelativeSpecifier(file, specifier);
      if (!resolved) {
        return;
      }

      allEdges.add(resolved);

      const isTypeOnly = ts.isImportDeclaration(node)
        ? node.importClause?.isTypeOnly ?? false
        : node.isTypeOnly ?? false;

      if (!isTypeOnly) {
        runtimeEdges.add(resolved);
      }
      return;
    }

    if (!packageInfo) {
      return;
    }

    if (specifier === packageInfo.name || specifier.startsWith(`${packageInfo.name}/`)) {
      selfImports.push({
        file: relativePath(file),
        specifier,
      });
    }
  });

  fileGraph.set(file, [...allEdges]);
  runtimeGraph.set(file, [...runtimeEdges]);
}

const typeAndRuntimeCycles = findStronglyConnectedComponents(fileGraph);
const runtimeOnlyCycles = findStronglyConnectedComponents(runtimeGraph);

const hasFailures =
  packageCycles.length > 0 ||
  typeAndRuntimeCycles.length > 0 ||
  runtimeOnlyCycles.length > 0 ||
  selfImports.length > 0;

if (!hasFailures) {
  console.log("No circular workspace-package dependencies, file import cycles, or package self-imports found.");
  process.exit(0);
}

if (packageCycles.length > 0) {
  console.error("Workspace package cycles:");
  printGroups(packageCycles);
}

if (runtimeOnlyCycles.length > 0) {
  console.error("Runtime file import cycles:");
  printGroups(runtimeOnlyCycles.map((group) => group.map(relativePath)));
}

if (typeAndRuntimeCycles.length > 0) {
  console.error("File import cycles including type-only edges:");
  printGroups(typeAndRuntimeCycles.map((group) => group.map(relativePath)));
}

if (selfImports.length > 0) {
  console.error("Package self-imports:");
  for (const entry of selfImports) {
    console.error(`  - ${entry.file} -> ${entry.specifier}`);
  }
}

process.exit(1);

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) {
      continue;
    }

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath);
      continue;
    }

    if (entry.isFile() && entry.name === PACKAGE_JSON) {
      packageFiles.push(fullPath);
      continue;
    }

    if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      sourceFiles.push(fullPath);
    }
  }
}

function resolveRelativeSpecifier(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [];

  if (path.extname(base)) {
    candidates.push(base);
  } else {
    for (const extension of SOURCE_EXTENSIONS) {
      candidates.push(`${base}${extension}`);
      candidates.push(path.join(base, `index${extension}`));
    }
  }

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function findStronglyConnectedComponents(graph) {
  const index = new Map();
  const lowLink = new Map();
  const stack = [];
  const onStack = new Set();
  const groups = [];
  let currentIndex = 0;

  for (const node of graph.keys()) {
    if (!index.has(node)) {
      visit(node);
    }
  }

  return groups.sort((left, right) => right.length - left.length);

  function visit(node) {
    index.set(node, currentIndex);
    lowLink.set(node, currentIndex);
    currentIndex += 1;
    stack.push(node);
    onStack.add(node);

    for (const neighbor of graph.get(node) ?? []) {
      if (!graph.has(neighbor)) {
        continue;
      }

      if (!index.has(neighbor)) {
        visit(neighbor);
        lowLink.set(node, Math.min(lowLink.get(node), lowLink.get(neighbor)));
      } else if (onStack.has(neighbor)) {
        lowLink.set(node, Math.min(lowLink.get(node), index.get(neighbor)));
      }
    }

    if (lowLink.get(node) !== index.get(node)) {
      return;
    }

    const component = [];
    let popped = null;
    do {
      popped = stack.pop();
      onStack.delete(popped);
      component.push(popped);
    } while (popped !== node);

    if (component.length > 1) {
      groups.push(component);
    }
  }
}

function printGroups(groups) {
  for (const group of groups) {
    console.error(`  - ${group.join(" -> ")} -> ${group[0]}`);
  }
}

function relativePath(filePath) {
  return path.relative(repoRoot, filePath);
}
