import type { Request, RequestHandler, Response } from "express";
import { parse } from "@babel/parser";
import type {
  JSXAttribute,
  JSXElement,
  JSXIdentifier,
  JSXSpreadAttribute,
  Node as BabelNode
} from "@babel/types";
import path from "node:path";
import { promises as fs } from "node:fs";
import vm from "node:vm";

type MaybePromise<T> = T | Promise<T>;

export type InertiaProps = Record<string, unknown>;

export interface SharedPropsContext {
  req: Request;
  res: Response;
}

export type SharedPropsResolver =
  | InertiaProps
  | ((context: SharedPropsContext) => MaybePromise<InertiaProps>);

export interface ViteOptions {
  adapter?: "react" | "vue";
  isDev?: boolean;
  devServerUrl?: string;
  entry?: string;
  manifestPath?: string;
  assetsBase?: string;
}

export interface InertiaPage {
  component: string;
  props: InertiaProps;
  url: string;
  version?: string;
}

export interface HeadContext {
  page: InertiaPage;
  req: Request;
  res: Response;
}

export interface TitleContext {
  title: string | undefined;
  page: InertiaPage;
  req: Request;
  res: Response;
}

export type HeadResolver =
  | string
  | string[]
  | ((context: HeadContext) => MaybePromise<string | string[] | undefined>);

export type TitleResolver =
  | string
  | ((context: TitleContext) => MaybePromise<string | undefined>);

export interface HeadStrategyContext {
  page: InertiaPage;
  req: Request;
  res: Response;
}

export type HeadStrategy = "auto" | "head" | "headFromPage";

export type HeadStrategyResolver =
  | HeadStrategy
  | ((context: HeadStrategyContext) => MaybePromise<HeadStrategy>);

export interface HeadFromPageOptions {
  pagesPath?: string;
}

export interface HtmlTemplateContext {
  page: InertiaPage;
  rootId: string;
  viteTags: string;
  ssrHead: string;
  ssrBody: string;
}

export interface SsrOptions {
  url?: string;
}

export interface InertiaExpressOptions {
  rootId?: string;
  version?: string | (() => MaybePromise<string>);
  sharedProps?: SharedPropsResolver;
  head?: HeadResolver;
  headStrategy?: HeadStrategyResolver;
  title?: TitleResolver;
  headFromPage?: boolean | HeadFromPageOptions;
  vite?: ViteOptions;
  ssr?: SsrOptions;
  templatePath?: string;
  template?: (context: HtmlTemplateContext) => MaybePromise<string>;
}

declare global {
  namespace Express {
    interface Response {
      SharedProps?: InertiaProps;
      inertia: (component: string, props?: InertiaProps) => Promise<void>;
      inertiaLocation: (location: string) => void;
    }
  }
}

interface ManifestCacheEntry {
  manifest: Record<string, ViteManifestEntry>;
  mtimeMs: number;
}

interface HeadTemplate {
  staticTitle: string | undefined;
  titlePropName: string | undefined;
  titleExpression: string | undefined;
  bodyTemplate: string | undefined;
}

interface HeadTemplateCacheEntry {
  template: HeadTemplate;
  mtimeMs: number;
}

type AppTitleFormatter = (baseTitle: string | undefined) => string | undefined;

interface AppTitleFormatterCacheEntry {
  formatter: AppTitleFormatter | undefined;
  mtimeMs: number;
}

const manifestCache = new Map<string, ManifestCacheEntry>();
const htmlTemplateCache = new Map<string, string>();
const headTemplateCache = new Map<string, HeadTemplateCacheEntry>();
const appTitleFormatterCache = new Map<string, AppTitleFormatterCacheEntry>();

interface ViteManifestEntry {
  file: string;
  css?: string[];
  imports?: string[];
  isEntry?: boolean;
}

function isInertiaRequest(req: Request): boolean {
  return req.header("X-Inertia") === "true";
}

async function resolveVersion(
  version?: string | (() => MaybePromise<string>)
): Promise<string | undefined> {
  if (!version) {
    return undefined;
  }

  return typeof version === "function" ? await version() : version;
}

async function resolveSharedProps(
  resolver: SharedPropsResolver | undefined,
  req: Request,
  res: Response
): Promise<InertiaProps> {
  const responseSharedProps =
    typeof res.SharedProps === "object" &&
    res.SharedProps !== null
      ? res.SharedProps
      : {};

  if (!resolver) {
    return responseSharedProps;
  }

  if (typeof resolver === "function") {
    const resolved = (await resolver({ req, res })) ?? {};
    return { ...responseSharedProps, ...resolved };
  }

  return { ...responseSharedProps, ...resolver };
}

function escapeJsonForHtml(json: string): string {
  return json
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizeBase(base: string): string {
  if (!base.startsWith("/")) {
    return `/${base.replace(/^\/+/, "")}`;
  }
  return base;
}

function toAssetUrl(base: string, assetFile: string): string {
  const normalizedBase = stripTrailingSlash(normalizeBase(base));
  const assetPath = assetFile.replace(/^\/+/, "");
  return `${normalizedBase}/${assetPath}`;
}

async function readManifest(manifestPath: string) {
  const { mtimeMs } = await fs.stat(manifestPath);
  const cached = manifestCache.get(manifestPath);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.manifest;
  }

  const manifestRaw = await fs.readFile(manifestPath, "utf8");
  const parsed = JSON.parse(manifestRaw) as Record<string, ViteManifestEntry>;
  manifestCache.set(manifestPath, {
    manifest: parsed,
    mtimeMs
  });
  return parsed;
}

function collectImports(
  manifest: Record<string, ViteManifestEntry>,
  entry: ViteManifestEntry
): string[] {
  const files = new Set<string>();
  const seen = new Set<string>();

  const walk = (current: ViteManifestEntry) => {
    for (const imported of current.imports ?? []) {
      if (seen.has(imported)) {
        continue;
      }
      seen.add(imported);
      const importedEntry = manifest[imported];
      if (!importedEntry) {
        continue;
      }
      files.add(importedEntry.file);
      walk(importedEntry);
    }
  };

  walk(entry);
  return [...files];
}

function collectCss(
  manifest: Record<string, ViteManifestEntry>,
  entry: ViteManifestEntry
): string[] {
  const cssFiles = new Set<string>();
  const seen = new Set<ViteManifestEntry>();

  const walk = (current: ViteManifestEntry) => {
    if (seen.has(current)) {
      return;
    }
    seen.add(current);

    for (const css of current.css ?? []) {
      cssFiles.add(css);
    }

    for (const imported of current.imports ?? []) {
      const importedEntry = manifest[imported];
      if (importedEntry) {
        walk(importedEntry);
      }
    }
  };

  walk(entry);
  return [...cssFiles];
}

async function buildViteTags(vite: ViteOptions | undefined): Promise<string> {
  if (!vite) {
    return "";
  }

  const entry = vite.entry ?? "resources/js/app.tsx";
  const adapter = vite.adapter ?? "react";
  const isDev =
    typeof vite.isDev === "boolean" ? vite.isDev : Boolean(vite.devServerUrl);

  if (isDev) {
    if (!vite.devServerUrl) {
      throw new Error(
        'vite.devServerUrl is required when vite.isDev is true.'
      );
    }

    const devServerUrl = stripTrailingSlash(vite.devServerUrl);
    const entryPath = entry.replace(/^\/+/, "");
    const tags = [
      `<script type="module" src="${devServerUrl}/@vite/client"></script>`,
      `<script type="module" src="${devServerUrl}/${entryPath}"></script>`
    ];

    if (adapter === "vue") {
      return tags.join("\n");
    }

    return [
      `<script type="module">
import RefreshRuntime from "${devServerUrl}/@react-refresh";
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => (type) => type;
window.__vite_plugin_react_preamble_installed__ = true;
</script>`,
      ...tags
    ].join("\n");
  }

  const manifestPath =
    vite.manifestPath ??
    path.resolve(process.cwd(), "public", ".vite", "manifest.json");
  const manifest = await readManifest(manifestPath);
  const manifestEntry =
    manifest[entry] ?? Object.values(manifest).find((item) => item.isEntry);

  if (!manifestEntry) {
    throw new Error(
      `Unable to find Vite entry "${entry}" in manifest "${manifestPath}".`
    );
  }

  const base = vite.assetsBase ?? "/";
  const importFiles = collectImports(manifest, manifestEntry);
  const cssFiles = collectCss(manifest, manifestEntry);

  const tags: string[] = [];
  for (const imported of importFiles) {
    tags.push(
      `<link rel="modulepreload" href="${toAssetUrl(base, imported)}" />`
    );
  }
  for (const css of cssFiles) {
    tags.push(`<link rel="stylesheet" href="${toAssetUrl(base, css)}" />`);
  }
  tags.push(
    `<script type="module" src="${toAssetUrl(base, manifestEntry.file)}"></script>`
  );

  return tags.join("\n");
}

function defaultTemplate(context: HtmlTemplateContext): string {
  const serializedPage = escapeJsonForHtml(JSON.stringify(context.page));
  const ssrHead = context.ssrHead ? `${context.ssrHead}\n` : "";
  const appHtml =
    context.ssrBody ||
    `<div id="${context.rootId}" data-page='${serializedPage}'></div>`;

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
${ssrHead}
${context.viteTags}
  </head>
  <body>
    ${appHtml}
  </body>
</html>`;
}

async function loadTemplateFile(templatePath: string): Promise<string> {
  const shouldCache = process.env.NODE_ENV !== "development";
  if (shouldCache) {
    const cached = htmlTemplateCache.get(templatePath);
    if (cached) {
      return cached;
    }
  }

  const html = await fs.readFile(templatePath, "utf8");
  if (shouldCache) {
    htmlTemplateCache.set(templatePath, html);
  }

  return html;
}

function renderTemplateFile(
  templateHtml: string,
  context: HtmlTemplateContext
): string {
  const serializedPage = escapeJsonForHtml(JSON.stringify(context.page));
  const appHtml =
    context.ssrBody ||
    `<div id="${context.rootId}" data-page='${serializedPage}'></div>`;
  const titleMatch = context.ssrHead.match(/<title\b[^>]*>[\s\S]*?<\/title>/i);
  const ssrHeadWithoutTitle = titleMatch
    ? context.ssrHead.replace(titleMatch[0], "").trim()
    : context.ssrHead;

  let htmlWithTitle = templateHtml;
  if (titleMatch) {
    const existingTitlePattern = /<title\b[^>]*>[\s\S]*?<\/title>/i;
    if (existingTitlePattern.test(htmlWithTitle)) {
      htmlWithTitle = htmlWithTitle.replace(existingTitlePattern, titleMatch[0]);
    } else if (htmlWithTitle.includes("</head>")) {
      htmlWithTitle = htmlWithTitle.replace("</head>", `  ${titleMatch[0]}\n</head>`);
    } else {
      htmlWithTitle = `${titleMatch[0]}\n${htmlWithTitle}`;
    }
  }

  return htmlWithTitle
    .replace("<!-- INERTIA_VITE_TAGS -->", context.viteTags)
    .replace("<!-- INERTIA_HEAD -->", ssrHeadWithoutTitle)
    .split("__INERTIA_APP__")
    .join(appHtml)
    .split("__INERTIA_ROOT_ID__")
    .join(context.rootId)
    .split("__INERTIA_PAGE__")
    .join(serializedPage)
    .split("__INERTIA_SSR_BODY__")
    .join(context.ssrBody);
}

function normalizeSsrHead(head: string | string[] | undefined): string {
  if (!head) {
    return "";
  }

  return Array.isArray(head) ? head.join("\n") : head;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function ensureInertiaTitleTag(head: string): string {
  return head.replace(/<title(?![^>]*\binertia\b)([^>]*)>/gi, "<title inertia$1>");
}

function extractTitle(head: string): string | undefined {
  const match = head.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) {
    return undefined;
  }
  return match[1].trim();
}

function upsertTitle(head: string, title: string): string {
  const titleTag = `<title inertia>${escapeHtml(title)}</title>`;
  if (/<title\b[^>]*>[\s\S]*?<\/title>/i.test(head)) {
    return head.replace(/<title\b[^>]*>[\s\S]*?<\/title>/i, titleTag);
  }

  if (!head.trim()) {
    return titleTag;
  }

  return `${titleTag}\n${head}`;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

function resolveHeadFromPageOptions(
  options: boolean | HeadFromPageOptions | undefined
): HeadFromPageOptions | undefined {
  if (!options) {
    return undefined;
  }
  if (options === true) {
    return {};
  }
  return options;
}

function resolveEntryPathFromVite(vite: ViteOptions | undefined): string {
  return path.resolve(process.cwd(), vite?.entry ?? "resources/js/app.tsx");
}

function extractSourceByRange(source: string, node: BabelNode): string | undefined {
  if (typeof node.start !== "number" || typeof node.end !== "number") {
    return undefined;
  }
  return source.slice(node.start, node.end);
}

interface ImportBinding {
  localName: string;
  importName: string;
  source: string;
}

interface ModuleExportValues {
  named: Map<string, string>;
  defaultValue?: string;
}

const sourceModuleExtensions = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts"
];

function collectTopLevelVariableInitializers(source: string): Map<string, string> {
  const values = new Map<string, string>();

  try {
    const ast = parse(source, {
      sourceType: "module",
      plugins: ["jsx", "typescript"]
    });

    for (const statement of ast.program.body) {
      if (statement.type !== "VariableDeclaration") {
        continue;
      }

      for (const declaration of statement.declarations) {
        if (declaration.id.type !== "Identifier" || !declaration.init) {
          continue;
        }

        const valueSource = extractSourceByRange(source, declaration.init);
        if (!valueSource) {
          continue;
        }

        values.set(declaration.id.name, valueSource);
      }
    }
  } catch {
    return values;
  }

  return values;
}

function collectImportedBindings(source: string): ImportBinding[] {
  const bindings: ImportBinding[] = [];

  try {
    const ast = parse(source, {
      sourceType: "module",
      plugins: ["jsx", "typescript"]
    });

    for (const statement of ast.program.body) {
      if (statement.type !== "ImportDeclaration") {
        continue;
      }

      const importSource = statement.source.value;
      if (typeof importSource !== "string" || !importSource.startsWith(".")) {
        continue;
      }

      for (const specifier of statement.specifiers) {
        if (specifier.type === "ImportDefaultSpecifier") {
          bindings.push({
            localName: specifier.local.name,
            importName: "default",
            source: importSource
          });
          continue;
        }

        if (specifier.type === "ImportSpecifier") {
          bindings.push({
            localName: specifier.local.name,
            importName:
              specifier.imported.type === "Identifier"
                ? specifier.imported.name
                : specifier.imported.value,
            source: importSource
          });
        }
      }
    }
  } catch {
    return [];
  }

  return bindings;
}

async function resolveLocalImportFile(
  entryPath: string,
  importSource: string
): Promise<string | undefined> {
  const entryDir = path.dirname(entryPath);
  const rawTarget = path.resolve(entryDir, importSource);
  const candidates = new Set<string>();

  candidates.add(rawTarget);
  for (const extension of sourceModuleExtensions) {
    candidates.add(`${rawTarget}${extension}`);
    candidates.add(path.join(rawTarget, `index${extension}`));
  }

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  return undefined;
}

function parseModuleExports(source: string): ModuleExportValues {
  const named = new Map<string, string>();
  const topLevelInitializers = collectTopLevelVariableInitializers(source);

  try {
    const ast = parse(source, {
      sourceType: "module",
      plugins: ["jsx", "typescript"]
    });

    let defaultValue: string | undefined;

    for (const statement of ast.program.body) {
      if (statement.type === "ExportNamedDeclaration") {
        if (statement.declaration?.type === "VariableDeclaration") {
          for (const declaration of statement.declaration.declarations) {
            if (declaration.id.type !== "Identifier" || !declaration.init) {
              continue;
            }

            const valueSource = extractSourceByRange(source, declaration.init);
            if (!valueSource) {
              continue;
            }

            named.set(declaration.id.name, valueSource);
          }
        }

        for (const specifier of statement.specifiers) {
          if (specifier.type !== "ExportSpecifier") {
            continue;
          }

          const exportedName =
            specifier.exported.type === "Identifier"
              ? specifier.exported.name
              : specifier.exported.value;
          const localName = specifier.local.name;
          const initializer = topLevelInitializers.get(localName);
          if (initializer) {
            named.set(exportedName, initializer);
          }
        }
      }

      if (statement.type === "ExportDefaultDeclaration") {
        if (statement.declaration.type === "FunctionDeclaration") {
          if (statement.declaration.id) {
            defaultValue = statement.declaration.id.name;
          }
          continue;
        }

        if (statement.declaration.type === "ClassDeclaration") {
          if (statement.declaration.id) {
            defaultValue = statement.declaration.id.name;
          }
          continue;
        }

        defaultValue = extractSourceByRange(source, statement.declaration);
      }
    }

    return { named, defaultValue };
  } catch {
    return { named };
  }
}

async function resolveImportedRuntimePrelude(
  source: string,
  entryPath: string
): Promise<string> {
  const bindings = collectImportedBindings(source);
  if (bindings.length === 0) {
    return "";
  }

  const lines: string[] = [];
  const resolvedModules = new Map<string, ModuleExportValues>();
  const assignedNames = new Set<string>();

  for (const binding of bindings) {
    if (assignedNames.has(binding.localName)) {
      continue;
    }

    const modulePath = await resolveLocalImportFile(entryPath, binding.source);
    if (!modulePath) {
      continue;
    }

    let exports = resolvedModules.get(modulePath);
    if (!exports) {
      try {
        const moduleSource = await fs.readFile(modulePath, "utf8");
        exports = parseModuleExports(moduleSource);
      } catch {
        continue;
      }
      resolvedModules.set(modulePath, exports);
    }

    const valueSource =
      binding.importName === "default"
        ? exports.defaultValue
        : exports.named.get(binding.importName);
    if (!valueSource) {
      continue;
    }

    lines.push(`const ${binding.localName} = (${valueSource});`);
    assignedNames.add(binding.localName);
  }

  return lines.join("\n");
}

function collectRuntimePrelude(source: string): string {
  try {
    const ast = parse(source, {
      sourceType: "module",
      plugins: ["jsx", "typescript"]
    });

    const statements = ast.program.body
      .filter((node) => {
        if (node.type === "ImportDeclaration" || node.type === "ExportDefaultDeclaration") {
          return false;
        }

        return (
          node.type === "VariableDeclaration" ||
          node.type === "FunctionDeclaration" ||
          node.type === "ClassDeclaration" ||
          node.type === "TSTypeAliasDeclaration" ||
          node.type === "TSInterfaceDeclaration" ||
          node.type === "TSDeclareFunction"
        )
          ? node.type !== "TSTypeAliasDeclaration" &&
              node.type !== "TSInterfaceDeclaration" &&
              node.type !== "TSDeclareFunction"
          : false;
      })
      .map((node) => extractSourceByRange(source, node))
      .filter((item): item is string => Boolean(item));

    return statements.join("\n");
  } catch {
    return "";
  }
}

function findCreateInertiaAppTitleExpression(source: string): string | undefined {
  try {
    const ast = parse(source, {
      sourceType: "module",
      plugins: ["jsx", "typescript"]
    });

    for (const statement of ast.program.body) {
      if (statement.type !== "ExpressionStatement") {
        continue;
      }
      const { expression } = statement;
      if (expression.type !== "CallExpression") {
        continue;
      }
      if (expression.callee.type !== "Identifier" || expression.callee.name !== "createInertiaApp") {
        continue;
      }
      const config = expression.arguments[0];
      if (!config || config.type !== "ObjectExpression") {
        continue;
      }

      for (const property of config.properties) {
        if (property.type !== "ObjectProperty" || property.computed) {
          continue;
        }
        const keyName =
          property.key.type === "Identifier"
            ? property.key.name
            : property.key.type === "StringLiteral"
              ? property.key.value
              : undefined;

        if (keyName !== "title") {
          continue;
        }

        return extractSourceByRange(source, property.value);
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
}

async function buildAppTitleFormatter(
  source: string,
  entryPath: string
): Promise<AppTitleFormatter | undefined> {
  const titleExpression = findCreateInertiaAppTitleExpression(source);
  if (!titleExpression) {
    return undefined;
  }

  const importedRuntimePrelude = await resolveImportedRuntimePrelude(
    source,
    entryPath
  );
  const runtimePrelude = collectRuntimePrelude(source);

  try {
    const context = vm.createContext({});
    const script = new vm.Script(
      `
${importedRuntimePrelude}
${runtimePrelude}
globalThis.__inertia_title_resolver = (${titleExpression});
`
    );
    script.runInContext(context, { timeout: 100 });
    const resolver = (context as { __inertia_title_resolver?: unknown }).__inertia_title_resolver;

    if (typeof resolver !== "function") {
      return undefined;
    }

    return (baseTitle: string | undefined) => {
      try {
        const resolved = (resolver as (value: string | undefined) => unknown)(baseTitle);
        return typeof resolved === "string" ? resolved : undefined;
      } catch {
        return undefined;
      }
    };
  } catch {
    return undefined;
  }
}

async function readAppTitleFormatter(entryPath: string): Promise<AppTitleFormatter | undefined> {
  try {
    const { mtimeMs } = await fs.stat(entryPath);
    const cached = appTitleFormatterCache.get(entryPath);
    if (cached && cached.mtimeMs === mtimeMs) {
      return cached.formatter;
    }

    const source = await fs.readFile(entryPath, "utf8");
    const formatter = await buildAppTitleFormatter(source, entryPath);
    appTitleFormatterCache.set(entryPath, {
      formatter,
      mtimeMs
    });
    return formatter;
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function resolveTitleFromClientEntry(
  vite: ViteOptions | undefined,
  baseTitle: string | undefined
): Promise<string | undefined> {
  const formatter = await readAppTitleFormatter(resolveEntryPathFromVite(vite));
  if (!formatter) {
    return undefined;
  }

  return formatter(baseTitle);
}

function parseHeadTemplate(source: string): HeadTemplate {
  const astTemplate = parseHeadTemplateFromAst(source);
  if (astTemplate) {
    return astTemplate;
  }

  return parseHeadTemplateFromRegex(source);
}

function parseHeadTemplateFromRegex(source: string): HeadTemplate {
  const blockHeadMatch = source.match(/<Head\b([^>]*)>([\s\S]*?)<\/Head>/i);
  const selfClosingHeadMatch = source.match(/<Head\b([^>]*)\/>/i);
  const headAttributes = blockHeadMatch?.[1] ?? selfClosingHeadMatch?.[1] ?? "";
  const headBody = blockHeadMatch?.[2]?.trim();

  return {
    staticTitle: headAttributes.match(/\btitle\s*=\s*"([^"]*)"/i)?.[1],
    titlePropName:
      headAttributes.match(/\btitle\s*=\s*\{\s*([A-Za-z_$][\w$]*)\s*\}/i)?.[1] ??
      headAttributes.match(/\b:title\s*=\s*"([A-Za-z_$][\w$]*)"/i)?.[1],
    titleExpression: undefined,
    bodyTemplate: headBody
  };
}

function isBabelNode(value: unknown): value is BabelNode {
  return typeof value === "object" && value !== null && "type" in value;
}

function isHeadJsxName(name: JSXIdentifier | BabelNode): boolean {
  return name.type === "JSXIdentifier" && name.name === "Head";
}

function findHeadJsxElement(node: BabelNode): JSXElement | undefined {
  if (node.type === "JSXElement" && isHeadJsxName(node.openingElement.name)) {
    return node;
  }

  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isBabelNode(item)) {
          const found = findHeadJsxElement(item);
          if (found) {
            return found;
          }
        }
      }
      continue;
    }

    if (isBabelNode(value)) {
      const found = findHeadJsxElement(value);
      if (found) {
        return found;
      }
    }
  }

  return undefined;
}

function parseHeadTitleAttribute(
  source: string,
  attributes: (JSXAttribute | JSXSpreadAttribute)[]
): { staticTitle?: string; titlePropName?: string; titleExpression?: string } {
  for (const attribute of attributes) {
    if (attribute.type !== "JSXAttribute") {
      continue;
    }
    if (attribute.name.type !== "JSXIdentifier" || attribute.name.name !== "title") {
      continue;
    }

    if (attribute.value?.type === "StringLiteral") {
      return { staticTitle: attribute.value.value };
    }

    if (attribute.value?.type === "JSXExpressionContainer") {
      const { expression } = attribute.value;
      if (expression.type === "Identifier") {
        return { titlePropName: expression.name };
      }

      const expressionSource = extractSourceByRange(source, expression);
      if (expressionSource) {
        return { titleExpression: expressionSource };
      }
    }
  }

  return {};
}

function parseHeadTemplateFromAst(source: string): HeadTemplate | undefined {
  try {
    const ast = parse(source, {
      sourceType: "module",
      plugins: ["jsx", "typescript"]
    });
    const headElement = findHeadJsxElement(ast.program);
    if (!headElement) {
      return undefined;
    }

    const { staticTitle, titlePropName, titleExpression } = parseHeadTitleAttribute(
      source,
      headElement.openingElement.attributes
    );

    const openingEnd = headElement.openingElement.end;
    const closingStart = headElement.closingElement?.start;
    const bodyTemplate =
      openingEnd !== null &&
      openingEnd !== undefined &&
      closingStart !== null &&
      closingStart !== undefined
        ? source.slice(openingEnd, closingStart).trim()
        : undefined;

    return {
      staticTitle,
      titlePropName,
      titleExpression,
      bodyTemplate
    };
  } catch {
    return undefined;
  }
}

function getStringPropValue(props: InertiaProps, key: string | undefined): string | undefined {
  if (!key) {
    return undefined;
  }
  const value = props[key];
  return typeof value === "string" ? value : undefined;
}

function evaluateExpressionWithProps(
  expression: string | undefined,
  props: InertiaProps
): string | undefined {
  if (!expression) {
    return undefined;
  }

  try {
    const sandbox = vm.createContext({
      ...props
    });
    const script = new vm.Script(`(${expression})`);
    const result = script.runInContext(sandbox, { timeout: 50 });

    if (typeof result === "string") {
      return result;
    }
    if (typeof result === "number" || typeof result === "boolean") {
      return String(result);
    }

    return undefined;
  } catch {
    return undefined;
  }
}

function renderHeadBodyTemplate(
  bodyTemplate: string | undefined,
  props: InertiaProps
): string {
  if (!bodyTemplate) {
    return "";
  }

  const rendered = bodyTemplate
    .replace(/=\{\s*"([^"]*)"\s*\}/g, '="$1"')
    .replace(/=\{\s*'([^']*)'\s*\}/g, '="$1"')
    .replace(
      /\b([A-Za-z_:][\w:.-]*)\s*=\s*\{\s*`([^`]*)`\s*\}/g,
      (_match, attributeName: string, templateValue: string) => {
        const interpolated = templateValue.replace(
          /\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g,
          (_innerMatch, propName: string) => getStringPropValue(props, propName) ?? ""
        );
        return `${attributeName}="${escapeHtml(interpolated)}"`;
      }
    )
    .replace(
      /\b([A-Za-z_:][\w:.-]*)\s*=\s*\{\s*([A-Za-z_$][\w$]*)\s*\}/g,
      (_match, attributeName: string, propName: string) => {
        const value = getStringPropValue(props, propName);
        if (value === undefined) {
          return "";
        }
        return `${attributeName}="${escapeHtml(value)}"`;
      }
    )
    .replace(
      /\B:([A-Za-z_:][\w:.-]*)\s*=\s*"([A-Za-z_$][\w$]*)"/g,
      (_match, attributeName: string, propName: string) => {
        const value = getStringPropValue(props, propName);
        if (value === undefined) {
          return "";
        }
        return `${attributeName}="${escapeHtml(value)}"`;
      }
    )
    .replace(/\{\s*([A-Za-z_$][\w$]*)\s*\}/g, (_match, propName: string) => {
      const value = getStringPropValue(props, propName);
      return value === undefined ? "" : escapeHtml(value);
    })
    .replace(/\shead-key\s*=\s*("([^"]*)"|'([^']*)'|\{[^}]*\})/gi, "")
    .replace(/\/>/g, ">");

  return rendered
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

async function resolvePageComponentFile(
  pagesPath: string,
  component: string
): Promise<string | undefined> {
  const componentPath = path.join(...component.split("/"));
  const extensions = [".vue", ".jsx", ".tsx", ".js", ".ts"];

  for (const extension of extensions) {
    const candidate = path.resolve(pagesPath, `${componentPath}${extension}`);
    try {
      await fs.access(candidate);
      return candidate;
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  return undefined;
}

async function readHeadTemplate(pageFilePath: string): Promise<HeadTemplate> {
  const { mtimeMs } = await fs.stat(pageFilePath);
  const cached = headTemplateCache.get(pageFilePath);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.template;
  }

  const source = await fs.readFile(pageFilePath, "utf8");
  const template = parseHeadTemplate(source);
  headTemplateCache.set(pageFilePath, {
    template,
    mtimeMs
  });
  return template;
}

async function resolveHeadFromPage(
  options: HeadFromPageOptions | undefined,
  page: InertiaPage
): Promise<string> {
  if (!options) {
    return "";
  }

  const pagesPath = path.resolve(
    process.cwd(),
    options.pagesPath ?? path.join("resources", "js", "Pages")
  );
  const pageFilePath = await resolvePageComponentFile(pagesPath, page.component);
  if (!pageFilePath) {
    return "";
  }

  const template = await readHeadTemplate(pageFilePath);
  const title =
    template.staticTitle ??
    getStringPropValue(page.props, template.titlePropName) ??
    evaluateExpressionWithProps(template.titleExpression, page.props);
  const body = renderHeadBodyTemplate(template.bodyTemplate, page.props);

  const tags: string[] = [];
  if (title) {
    tags.push(`<title inertia>${escapeHtml(title)}</title>`);
  }
  if (body) {
    tags.push(body);
  }

  return tags.join("\n");
}

async function resolveHead(
  resolver: HeadResolver | undefined,
  context: HeadContext
): Promise<string> {
  if (!resolver) {
    return "";
  }

  const resolved =
    typeof resolver === "function"
      ? await resolver(context)
      : resolver;

  if (!resolved) {
    return "";
  }

  return Array.isArray(resolved) ? resolved.join("\n") : resolved;
}

async function resolveTitle(
  resolver: TitleResolver | undefined,
  context: TitleContext
): Promise<string | undefined> {
  if (!resolver) {
    return undefined;
  }

  if (typeof resolver === "function") {
    return await resolver(context);
  }

  return resolver;
}

async function resolveHeadStrategy(
  resolver: HeadStrategyResolver | undefined,
  context: HeadStrategyContext
): Promise<HeadStrategy> {
  if (!resolver) {
    return "auto";
  }

  const strategy =
    typeof resolver === "function"
      ? await resolver(context)
      : resolver;

  if (strategy === "head" || strategy === "headFromPage" || strategy === "auto") {
    return strategy;
  }

  throw new Error(
    `Invalid headStrategy "${String(strategy)}". Use "auto", "head", or "headFromPage".`
  );
}

interface InertiaSsrResponse {
  head: string[];
  body: string;
}

function resolveSsrRenderUrl(ssr: SsrOptions): string {
  const base = stripTrailingSlash(ssr.url ?? "http://127.0.0.1:13714");
  return base.toLowerCase().endsWith("/render") ? base : `${base}/render`;
}

async function renderWithInertiaSsr(
  page: InertiaPage,
  ssr: SsrOptions | undefined
): Promise<InertiaSsrResponse | undefined> {
  if (!ssr) {
    return undefined;
  }

  const renderUrl = resolveSsrRenderUrl(ssr);
  const response = await fetch(renderUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(page)
  });

  if (!response.ok) {
    throw new Error(`Inertia SSR request failed (${response.status}) at "${renderUrl}".`);
  }

  const payload = (await response.json()) as Partial<InertiaSsrResponse> | null;
  if (!payload) {
    return undefined;
  }

  return {
    head: Array.isArray(payload.head)
      ? payload.head.filter((item): item is string => typeof item === "string")
      : [],
    body: typeof payload.body === "string" ? payload.body : ""
  };
}

function buildPage(
  component: string,
  props: InertiaProps,
  req: Request,
  version?: string
): InertiaPage {
  return {
    component,
    props,
    url: req.originalUrl || req.url,
    version
  };
}

export function inertiaExpress(options: InertiaExpressOptions = {}): RequestHandler {
  const rootId = options.rootId ?? "app";
  const templatePath = options.templatePath
    ? path.resolve(process.cwd(), options.templatePath)
    : undefined;
  const headFromPageOptions = resolveHeadFromPageOptions(options.headFromPage);

  return async (req, res, next) => {
    res.vary("X-Inertia");

    res.inertiaLocation = (location: string) => {
      res.status(409).set("X-Inertia-Location", location).end();
    };

    res.inertia = async (component: string, pageProps: InertiaProps = {}) => {
      const [sharedProps, version] = await Promise.all([
        resolveSharedProps(options.sharedProps, req, res),
        resolveVersion(options.version)
      ]);

      const mergedProps = { ...sharedProps, ...pageProps };
      const page = buildPage(component, mergedProps, req, version);

      if (isInertiaRequest(req)) {
        const requestedVersion = req.header("X-Inertia-Version");
        if (version && requestedVersion && requestedVersion !== version) {
          res.inertiaLocation(req.originalUrl || req.url);
          return;
        }

        res.set("X-Inertia", "true").json(page);
        return;
      }

      const headStrategy = await resolveHeadStrategy(options.headStrategy, { page, req, res });

      const [viteTags, ssrResult, resolvedHead, pageHead] = await Promise.all([
        buildViteTags(options.vite),
        renderWithInertiaSsr(page, options.ssr),
        headStrategy === "headFromPage"
          ? Promise.resolve("")
          : resolveHead(options.head, { page, req, res }),
        headStrategy === "head"
          ? Promise.resolve("")
          : resolveHeadFromPage(headFromPageOptions, page)
      ]);
      const ssrHead = ensureInertiaTitleTag(normalizeSsrHead(ssrResult?.head ?? []));
      const strategySelectedHead =
        headStrategy === "head"
          ? resolvedHead
          : headStrategy === "headFromPage"
            ? pageHead
            : (resolvedHead || pageHead);
      const resolvedHeadWithInertiaTitle = ensureInertiaTitleTag(
        strategySelectedHead
      );
      const baseHead = ssrHead || resolvedHeadWithInertiaTitle;
      const resolvedTitle = await resolveTitle(options.title, {
        title: extractTitle(baseHead),
        page,
        req,
        res
      });
      const inferredTitle =
        resolvedTitle ??
        (await resolveTitleFromClientEntry(options.vite, extractTitle(baseHead)));
      const finalHead = ensureInertiaTitleTag(
        inferredTitle ? upsertTitle(baseHead, inferredTitle) : baseHead
      );
      const templateContext: HtmlTemplateContext = {
        page,
        rootId,
        viteTags,
        ssrHead: finalHead,
        ssrBody: ssrResult?.body ?? ""
      };

      const html = options.template
        ? await options.template(templateContext)
        : templatePath
          ? renderTemplateFile(await loadTemplateFile(templatePath), templateContext)
          : defaultTemplate(templateContext);

      res.send(html);
    };

    next();
  };
}

export default inertiaExpress;

