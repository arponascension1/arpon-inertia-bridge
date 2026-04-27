# arpon-inertia-bridge

`arpon-inertia-bridge` is an Express middleware for **Inertia.js + Vite** apps.

It gives you:
- `res.inertia(component, props?)`
- `res.inertiaLocation(url)`
- first-load HTML rendering with Vite tags
- optional SSR integration
- server-side `<Head />` / title support

It supports React by default and includes a Vue dev adapter mode.

---

## Install

```bash
npm install arpon-inertia-bridge
```

Peer dependency:
- `express` `^4.18.0 || ^5.0.0`

---

## Table of contents

1. [How it works](#how-it-works)
2. [Quick start](#quick-start)
3. [Client setup](#client-setup)
4. [Production Vite setup](#production-vite-setup)
5. [Shared props](#shared-props)
6. [Head and title strategies](#head-and-title-strategies)
7. [SSR support](#ssr-support)
8. [Template support](#template-support)
9. [API reference](#api-reference)
10. [Behavior details](#behavior-details)
11. [Limitations](#limitations)
12. [Troubleshooting](#troubleshooting)

---

## How it works

When you call `res.inertia("PageName", props)`:

1. Shared props are resolved (`res.SharedProps` + `sharedProps` option).
2. A standard Inertia page payload is built:
   - `component`
   - `props`
   - `url`
   - `version` (if provided)
3. If request has `X-Inertia: true`, middleware returns JSON + `X-Inertia: true`.
4. Otherwise, middleware returns HTML:
   - injects Vite tags (dev server or manifest assets)
   - optionally asks SSR server for `head` + `body`
   - resolves head/title from configured strategy
   - renders default template or your custom template

---

## Quick start

### Server (Express)

```js
import express from "express";
import inertiaExpress from "arpon-inertia-bridge";

const app = express();

app.use(
  inertiaExpress({
    version: "1",
    sharedProps: ({ req }) => ({
      appName: "My App",
      currentPath: req.path
    }),
    vite: {
      isDev: true,
      devServerUrl: "http://127.0.0.1:5173",
      entry: "resources/js/app.jsx"
    }
  })
);

app.get("/", async (_req, res) => {
  await res.inertia("Home", {
    title: "Home",
    description: "Welcome"
  });
});

app.listen(3000);
```

### TypeScript server usage

```ts
import express from "express";
import inertiaExpress from "arpon-inertia-bridge";

const app = express();

app.use(
  inertiaExpress({
    version: () => process.env.APP_VERSION ?? "dev",
    sharedProps: () => ({ appName: "My App" }),
    vite: {
      entry: "resources/js/app.tsx",
      manifestPath: "public/.vite/manifest.json",
      assetsBase: "/"
    }
  })
);
```

---

## Client setup

### React client entry

```jsx
import { createInertiaApp } from "@inertiajs/react";
import { createRoot } from "react-dom/client";

const APP_NAME = "My App";

createInertiaApp({
  title: (title) => (title ? `${title} | ${APP_NAME}` : APP_NAME),
  resolve: (name) => {
    const pages = import.meta.glob("./Pages/**/*.jsx", { eager: true });
    return pages[`./Pages/${name}.jsx`];
  },
  setup({ el, App, props }) {
    createRoot(el).render(<App {...props} />);
  }
});
```

### Vue client entry

```ts
import { createInertiaApp } from "@inertiajs/vue3";
import { createApp, h } from "vue";

createInertiaApp({
  resolve: (name) => {
    const pages = import.meta.glob("./Pages/**/*.vue", { eager: true });
    return pages[`./Pages/${name}.vue`];
  },
  setup({ el, App, props, plugin }) {
    createApp({ render: () => h(App, props) }).use(plugin).mount(el);
  }
});
```

Use Vue adapter mode on the server in dev:

```ts
inertiaExpress({
  vite: {
    adapter: "vue",
    isDev: true,
    devServerUrl: "http://127.0.0.1:5173",
    entry: "resources/js/app.ts"
  }
});
```

---

## Production Vite setup

When `vite.isDev` is `false` (or when `vite.isDev` is omitted and `vite.devServerUrl` is not set), middleware reads Vite manifest and injects:
- modulepreload links for imported chunks
- stylesheet links
- entry module script

```ts
inertiaExpress({
  vite: {
    isDev: false,
    entry: "resources/js/app.tsx",
    manifestPath: "public/.vite/manifest.json",
    assetsBase: "/"
  }
});
```

Defaults:
- `isDev`: `Boolean(vite.devServerUrl)` (automatic fallback for backward compatibility)
- `entry`: `"resources/js/app.tsx"`
- `manifestPath`: `path.resolve(process.cwd(), "public", ".vite", "manifest.json")`
- `assetsBase`: `"/"`

---

## Shared props

You can set shared props in two places.

### 1. `sharedProps` option

```ts
inertiaExpress({
  sharedProps: ({ req }) => ({ currentPath: req.path })
});
```

### 2. Express middleware via `res.SharedProps`

```js
app.use((req, res, next) => {
  res.SharedProps = {
    appName: "My App",
    currentPath: req.path
  };
  next();
});
```

Merge order:
1. `res.SharedProps`
2. `sharedProps` option output
3. page props from `res.inertia(...)`

Later entries override earlier ones on key conflicts.

---

## Head and title strategies

You have 3 ways to produce first-load `<head>` output.

### A) `head` option (manual resolver)

```ts
inertiaExpress({
  head: ({ page }) => {
    const title = typeof page.props.title === "string" ? page.props.title : "My App";
    const description =
      typeof page.props.description === "string" ? page.props.description : "";

    return [
      `<title>${title}</title>`,
      `<meta name="description" content="${description}" />`
    ];
  }
});
```

### B) `headFromPage` option (read page file)

```ts
import path from "node:path";

inertiaExpress({
  headFromPage: {
    pagesPath: path.join(process.cwd(), "resources", "js", "Pages")
  }
});
```

This parses `<Head />` from page files using an AST parser for JSX/TSX and a fallback parser for template-style files.

### C) SSR-provided head

If SSR is enabled and returns `head[]`, SSR head wins.

### Precedence

Head precedence is:
1. SSR head (if available)
2. `head` result
3. `headFromPage` result

If both `head` and `headFromPage` are set, `head` takes priority over `headFromPage`.

### Per-route / per-component head strategy

Use `headStrategy` to choose source dynamically:

```ts
inertiaExpress({
  head,
  headFromPage: { pagesPath: path.join(process.cwd(), "resources", "js", "Pages") },
  headStrategy: ({ req, page }) => {
    if (req.path.startsWith("/admin")) return "head"; // manual tags
    if (page.component.startsWith("Marketing/")) return "headFromPage"; // page-driven tags
    return "auto"; // default: head first, then headFromPage
  }
});
```

Allowed values:
- `"auto"` (default)
- `"head"`
- `"headFromPage"`

### Title resolver

Use `title` to normalize final page title:

```ts
inertiaExpress({
  title: ({ page, title }) => {
    const appName = typeof page.props.appName === "string" ? page.props.appName : "My App";
    return title ? `${title} | ${appName}` : appName;
  }
});
```

If `title` is not provided, middleware tries to infer title formatting from your Vite entry `createInertiaApp({ title: ... })` pattern.

---

## SSR support

```ts
inertiaExpress({
  ssr: {
    url: "http://127.0.0.1:13714"
  }
});
```

Behavior:
- Middleware POSTs page payload to `${url}/render`.
- If `url` does not end with `/render`, it is appended automatically.
- Expects JSON with:
  - `head: string[]`
  - `body: string`

Errors:
- non-2xx SSR responses throw an error
- malformed payload falls back to empty `head`/`body` fields (when possible)

Default SSR URL base:
- `http://127.0.0.1:13714`

---

## Template support

You can render using:
1. built-in default template
2. `templatePath` HTML file
3. `template(context)` callback

### `templatePath` example

```ts
import path from "node:path";

inertiaExpress({
  templatePath: path.join(process.cwd(), "index.html"),
  vite: {
    isDev: true,
    devServerUrl: "http://127.0.0.1:5173",
    entry: "resources/js/app.jsx"
  }
});
```

Supported placeholders in your HTML:
- `<!-- INERTIA_VITE_TAGS -->`
- `<!-- INERTIA_HEAD -->`
- `__INERTIA_APP__`
- `__INERTIA_ROOT_ID__`
- `__INERTIA_PAGE__`
- `__INERTIA_SSR_BODY__`

If SSR head includes a `<title>`, middleware replaces existing template title with SSR title.

---

## API reference

### `inertiaExpress(options?)`

| Option | Type | Default | Notes |
|---|---|---|---|
| `rootId` | `string` | `"app"` | Root element id for non-SSR app mount |
| `version` | `string \| () => string \| Promise<string>` | `undefined` | Used for Inertia version checks |
| `sharedProps` | `object \| ({ req, res }) => object \| Promise<object>` | `undefined` | Merged into all page props |
| `head` | `string \| string[] \| ({ page, req, res }) => ...` | `undefined` | Manual head resolver |
| `headStrategy` | `"auto" \| "head" \| "headFromPage" \| ({ page, req, res }) => ...` | `"auto"` | Select head source globally or per request |
| `title` | `string \| ({ title, page, req, res }) => ...` | `undefined` | Final title override/formatter |
| `headFromPage` | `boolean \| { pagesPath?: string }` | `undefined` | Parse `<Head />` from page file |
| `vite.adapter` | `"react" \| "vue"` | `"react"` | Dev adapter behavior (`react` injects refresh preamble, `vue` does not) |
| `vite.isDev` | `boolean` | `Boolean(vite.devServerUrl)` | Explicitly selects dev/manifest mode |
| `vite.devServerUrl` | `string` | `undefined` | Required when `vite.isDev` is `true`; used for dev tags |
| `vite.entry` | `string` | `"resources/js/app.tsx"` | Entry used for dev script / manifest lookup |
| `vite.manifestPath` | `string` | `public/.vite/manifest.json` | Used in production mode |
| `vite.assetsBase` | `string` | `"/"` | Prefix for manifest-generated asset URLs |
| `ssr.url` | `string` | `"http://127.0.0.1:13714"` | SSR base URL (`/render` auto-appended) |
| `templatePath` | `string` | `undefined` | File-based HTML template |
| `template` | `(context) => string \| Promise<string>` | `undefined` | Full custom HTML renderer |

### Response helpers added by middleware

- `await res.inertia(component, props?)`
- `res.inertiaLocation(location)`
- optional `res.SharedProps` object (for upstream middleware)

---

## Behavior details

### Inertia request detection

A request is treated as an Inertia navigation when:
- `X-Inertia: true`

### Version mismatch behavior

On Inertia requests, if both are present and mismatched:
- current `version`
- request `X-Inertia-Version`

Response:
- `409`
- header `X-Inertia-Location: <current_url>`

### Headers

Middleware always sets:
- `Vary: X-Inertia`

### Security note

Page JSON embedded into HTML is escaped to prevent unsafe HTML/script injection from raw JSON delimiters.

---

## Limitations

1. `headFromPage` supports AST extraction for JSX/TSX and fallback parsing for non-JSX templates (`.vue` included), but very complex runtime-only expressions can still require explicit `head` or `title` resolvers.
2. Client entry title inference evaluates `createInertiaApp({ title })` with local declarations plus constants imported from local relative modules; callbacks that depend on dynamic runtime values (network, browser globals, complex external modules) may still require an explicit `title` resolver.

---

## Troubleshooting

### `Unable to find Vite entry ... in manifest ...`

Check:
1. `vite.entry` matches manifest key.
2. `manifestPath` points to the correct file.
3. frontend build actually generated the manifest.

### Head tags not appearing in first HTML

Check:
1. you are testing first page load (not client-side navigation only)
2. `head` resolver returns strings
3. `headFromPage.pagesPath` points to real page files

### SSR errors

Check:
1. SSR server is running
2. SSR URL is reachable from app server
3. SSR endpoint returns `{ head: string[], body: string }`

# arpon-inertia-bridge
