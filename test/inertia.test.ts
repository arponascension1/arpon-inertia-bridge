import express from "express";
import { promises as fs } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { inertiaExpress } from "../src/index";

async function startMockSsrServer(payload: { head: string[]; body: string }) {
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/render") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "NOT_FOUND" }));
      return;
    }

    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      JSON.parse(raw);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      })
  };
}

describe("inertiaExpress", () => {
  it("returns html payload for first load", async () => {
    const app = express();
    app.use(
      inertiaExpress({
        vite: { devServerUrl: "http://localhost:5173", entry: "resources/js/app.tsx" }
      })
    );
    app.get("/", async (_req, res) => {
      await res.inertia("Home", { message: "hello" });
    });

    const response = await request(app).get("/");

    expect(response.status).toBe(200);
    expect(response.text).toContain("data-page='");
    expect(response.text).toContain('"component":"Home"');
    expect(response.text).toContain("http://localhost:5173/@vite/client");
  });

  it("supports vue adapter in dev mode without react refresh preamble", async () => {
    const app = express();
    app.use(
      inertiaExpress({
        vite: {
          adapter: "vue",
          devServerUrl: "http://localhost:5173",
          entry: "resources/js/app.ts"
        }
      })
    );
    app.get("/", async (_req, res) => {
      await res.inertia("Home", { message: "hello" });
    });

    const response = await request(app).get("/");

    expect(response.status).toBe(200);
    expect(response.text).toContain('src="http://localhost:5173/@vite/client"');
    expect(response.text).toContain('src="http://localhost:5173/resources/js/app.ts"');
    expect(response.text).not.toContain("@react-refresh");
  });

  it("uses res.SharedProps without explicit sharedProps option", async () => {
    const app = express();
    app.use((req, res, next) => {
      res.SharedProps = {
        appName: "Middleware App",
        currentPath: req.path
      };
      next();
    });
    app.use(
      inertiaExpress({
        vite: { devServerUrl: "http://localhost:5173", entry: "resources/js/app.tsx" }
      })
    );
    app.get("/", async (_req, res) => {
      await res.inertia("Home", { message: "hello" });
    });

    const response = await request(app).get("/");

    expect(response.status).toBe(200);
    expect(response.text).toContain('"appName":"Middleware App"');
    expect(response.text).toContain('"currentPath":"/"');
  });

  it("renders head tags from head resolver without ssr", async () => {
    const app = express();
    app.use(
      inertiaExpress({
        head: ({ page }) => {
          const title =
            typeof page.props.title === "string" ? page.props.title : "Fallback";
          const description =
            typeof page.props.description === "string" ? page.props.description : "";

          return [`<title>${title}</title>`, `<meta name="description" content="${description}" />`];
        },
        vite: { devServerUrl: "http://localhost:5173", entry: "resources/js/app.tsx" }
      })
    );
    app.get("/", async (_req, res) => {
      await res.inertia("Home", { title: "Home Title", description: "Home Description" });
    });

    const response = await request(app).get("/");

    expect(response.status).toBe(200);
    expect(response.text).toContain("<title inertia>Home Title</title>");
    expect(response.text).toContain(
      `<meta name="description" content="Home Description" />`
    );
  });

  it("supports per-route head strategy", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "inertia-head-strategy-"));
    const pagesPath = path.join(tempDir, "Pages");
    await fs.mkdir(pagesPath, { recursive: true });
    await fs.writeFile(
      path.join(pagesPath, "Home.jsx"),
      `import { Head } from "@inertiajs/react";
export default function Home({ title }) {
  return (
    <main>
      <Head title={title} />
    </main>
  );
}
`,
      "utf8"
    );

    const app = express();
    app.use(
      inertiaExpress({
        head: ({ req }) => `<title>${req.path === "/manual" ? "Manual Title" : "Fallback Manual"}</title>`,
        headFromPage: { pagesPath },
        headStrategy: ({ req }) => (req.path === "/from-page" ? "headFromPage" : "head"),
        vite: { devServerUrl: "http://localhost:5173", entry: "resources/js/app.tsx" }
      })
    );
    app.get("/manual", async (_req, res) => {
      await res.inertia("Home", { title: "Ignored Page Title" });
    });
    app.get("/from-page", async (_req, res) => {
      await res.inertia("Home", { title: "From Page Title" });
    });

    const manualResponse = await request(app).get("/manual");
    expect(manualResponse.status).toBe(200);
    expect(manualResponse.text).toContain("<title inertia>Manual Title</title>");

    const fromPageResponse = await request(app).get("/from-page");
    expect(fromPageResponse.status).toBe(200);
    expect(fromPageResponse.text).toContain("<title inertia>From Page Title</title>");
    expect(fromPageResponse.text).not.toContain("Fallback Manual");
  });

  it("renders head tags from page Head component without ssr", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "inertia-pages-"));
    const pagesPath = path.join(tempDir, "Pages");
    await fs.mkdir(pagesPath, { recursive: true });
    await fs.writeFile(
      path.join(pagesPath, "Home.jsx"),
      `import { Head } from "@inertiajs/react";
export default function Home({ title, description, canonicalPath, ogTitle }) {
  return (
    <main>
      <Head title={title}>
        <meta name="description" content={description} />
        <meta property="og:title" content={ogTitle} />
        <meta name="robots" content="index,follow" />
        <link rel="canonical" href={\`https://example.com\${canonicalPath}\`} />
      </Head>
    </main>
  );
}
`,
      "utf8"
    );

    const app = express();
    app.use(
      inertiaExpress({
        headFromPage: { pagesPath },
        vite: { devServerUrl: "http://localhost:5173", entry: "resources/js/app.tsx" }
      })
    );
    app.get("/", async (_req, res) => {
      await res.inertia("Home", {
        title: "Page Component Title",
        description: "Page Component Description",
        canonicalPath: "/home",
        ogTitle: "OG Home Title"
      });
    });

    const response = await request(app).get("/");

    expect(response.status).toBe(200);
    expect(response.text).toContain("<title inertia>Page Component Title</title>");
    expect(response.text).toContain(
      `<meta name="description" content="Page Component Description" >`
    );
    expect(response.text).toContain(
      `<meta property="og:title" content="OG Home Title" >`
    );
    expect(response.text).toContain(
      `<meta name="robots" content="index,follow" >`
    );
    expect(response.text).toContain(
      `<link rel="canonical" href="https://example.com/home" >`
    );
    expect(response.text).not.toContain("head-key=");
  });

  it("renders title from self-closing page Head component without ssr", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "inertia-pages-"));
    const pagesPath = path.join(tempDir, "Pages");
    await fs.mkdir(pagesPath, { recursive: true });
    await fs.writeFile(
      path.join(pagesPath, "Home.jsx"),
      `import { Head } from "@inertiajs/react";
export default function Home() {
  return (
    <main>
      <Head title="Self Closing Title" />
    </main>
  );
}
`,
      "utf8"
    );

    const app = express();
    app.use(
      inertiaExpress({
        headFromPage: { pagesPath },
        vite: { devServerUrl: "http://localhost:5173", entry: "resources/js/app.tsx" }
      })
    );
    app.get("/", async (_req, res) => {
      await res.inertia("Home");
    });

    const response = await request(app).get("/");

    expect(response.status).toBe(200);
    expect(response.text).toContain("<title inertia>Self Closing Title</title>");
  });

  it("applies title resolver to page Head title without ssr", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "inertia-pages-"));
    const pagesPath = path.join(tempDir, "Pages");
    await fs.mkdir(pagesPath, { recursive: true });
    await fs.writeFile(
      path.join(pagesPath, "Home.jsx"),
      `import { Head } from "@inertiajs/react";
export default function Home({ title, description }) {
  return (
    <main>
      <Head title={title}>
        <meta name="description" content={description} />
      </Head>
    </main>
  );
}
`,
      "utf8"
    );

    const app = express();
    app.use(
      inertiaExpress({
        headFromPage: { pagesPath },
        title: ({ page, title }) => {
          const appName =
            typeof page.props.appName === "string" ? page.props.appName : "App";
          return title ? `${appName}-${title}` : appName;
        },
        vite: { devServerUrl: "http://localhost:5173", entry: "resources/js/app.tsx" }
      })
    );
    app.get("/", async (_req, res) => {
      await res.inertia("Home", {
        title: "Page Component Title",
        appName: "Demo App",
        description: "Description"
      });
    });

    const response = await request(app).get("/");

    expect(response.status).toBe(200);
    expect(response.text).toContain("<title inertia>Demo App-Page Component Title</title>");
    expect(response.text).toContain(`<meta name="description" content="Description" >`);
  });

  it("infers title format from app entry when title resolver is omitted", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "inertia-app-entry-"));
    const pagesPath = path.join(tempDir, "resources", "js", "Pages");
    const appEntryPath = path.join(tempDir, "resources", "js", "app.jsx");
    await fs.mkdir(pagesPath, { recursive: true });
    await fs.writeFile(
      path.join(pagesPath, "Home.jsx"),
      `import { Head } from "@inertiajs/react";
export default function Home({ title, description }) {
  return (
    <main>
      <Head title={title}>
        <meta name="description" content={description} />
      </Head>
    </main>
  );
}
`,
      "utf8"
    );
    await fs.writeFile(
      appEntryPath,
      `import { createInertiaApp } from "@inertiajs/react";

const appName = "Demo App";

createInertiaApp({
  title: (pageName) => (pageName ? \`\${appName}-\${pageName}\` : appName)
});
`,
      "utf8"
    );

    const originalCwd = process.cwd();
    process.chdir(tempDir);

    try {
      const app = express();
      app.use(
        inertiaExpress({
          headFromPage: { pagesPath },
          vite: { devServerUrl: "http://localhost:5173", entry: "resources/js/app.jsx" }
        })
      );
      app.get("/", async (_req, res) => {
        await res.inertia("Home", {
          title: "Page Component Title",
          description: "Description"
        });
      });

      const response = await request(app).get("/");

      expect(response.status).toBe(200);
      expect(response.text).toContain(
        "<title inertia>Demo App-Page Component Title</title>"
      );
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("infers suffix title format from app entry with uppercase app constant", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "inertia-app-entry-suffix-"));
    const pagesPath = path.join(tempDir, "resources", "js", "Pages");
    const appEntryPath = path.join(tempDir, "resources", "js", "app.jsx");
    await fs.mkdir(pagesPath, { recursive: true });
    await fs.writeFile(
      path.join(pagesPath, "Home.jsx"),
      `import { Head } from "@inertiajs/react";
export default function Home({ title }) {
  return (
    <main>
      <Head title={title} />
    </main>
  );
}
`,
      "utf8"
    );
    await fs.writeFile(
      appEntryPath,
      `import { createInertiaApp } from "@inertiajs/react";

const APP_NAME = "Arpon's Sites";

createInertiaApp({
  title: (title) => (title ? \`\${title} | \${APP_NAME}\` : APP_NAME)
});
`,
      "utf8"
    );

    const originalCwd = process.cwd();
    process.chdir(tempDir);

    try {
      const app = express();
      app.use(
        inertiaExpress({
          headFromPage: { pagesPath },
          vite: { devServerUrl: "http://localhost:5173", entry: "resources/js/app.jsx" }
        })
      );
      app.get("/", async (_req, res) => {
        await res.inertia("Home", { title: "Page Component Title" });
      });

      const response = await request(app).get("/");

      expect(response.status).toBe(200);
      expect(response.text).toContain(
        "<title inertia>Page Component Title | Arpon&#39;s Sites</title>"
      );
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("infers title from custom createInertiaApp title callback shape", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "inertia-app-entry-custom-title-"));
    const pagesPath = path.join(tempDir, "resources", "js", "Pages");
    const appEntryPath = path.join(tempDir, "resources", "js", "app.ts");
    await fs.mkdir(pagesPath, { recursive: true });
    await fs.writeFile(
      path.join(pagesPath, "Home.jsx"),
      `import { Head } from "@inertiajs/react";
export default function Home({ title }) {
  return <Head title={title} />;
}
`,
      "utf8"
    );
    await fs.writeFile(
      appEntryPath,
      `const APP_NAME = "Bridge App";
const addBrand = (value) => (value ? \`[\${APP_NAME}] \${value.toUpperCase()}\` : APP_NAME);
createInertiaApp({
  title: (pageName) => addBrand(pageName)
});
`,
      "utf8"
    );

    const originalCwd = process.cwd();
    process.chdir(tempDir);

    try {
      const app = express();
      app.use(
        inertiaExpress({
          headFromPage: { pagesPath },
          vite: { devServerUrl: "http://localhost:5173", entry: "resources/js/app.ts" }
        })
      );
      app.get("/", async (_req, res) => {
        await res.inertia("Home", { title: "welcome" });
      });

      const response = await request(app).get("/");

      expect(response.status).toBe(200);
      expect(response.text).toContain("<title inertia>[Bridge App] WELCOME</title>");
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("infers title when app entry depends on imported local constants", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "inertia-app-entry-imported-title-"));
    const pagesPath = path.join(tempDir, "resources", "js", "Pages");
    const appEntryPath = path.join(tempDir, "resources", "js", "app.ts");
    const constantsPath = path.join(tempDir, "resources", "js", "constants.ts");
    await fs.mkdir(pagesPath, { recursive: true });
    await fs.writeFile(
      path.join(pagesPath, "Home.jsx"),
      `import { Head } from "@inertiajs/react";
export default function Home({ title }) {
  return <Head title={title} />;
}
`,
      "utf8"
    );
    await fs.writeFile(
      constantsPath,
      `export const APP_NAME = "Imported App";`,
      "utf8"
    );
    await fs.writeFile(
      appEntryPath,
      `import { APP_NAME } from "./constants";
createInertiaApp({
  title: (title) => (title ? \`\${title} | \${APP_NAME}\` : APP_NAME)
});
`,
      "utf8"
    );

    const originalCwd = process.cwd();
    process.chdir(tempDir);

    try {
      const app = express();
      app.use(
        inertiaExpress({
          headFromPage: { pagesPath },
          vite: { devServerUrl: "http://localhost:5173", entry: "resources/js/app.ts" }
        })
      );
      app.get("/", async (_req, res) => {
        await res.inertia("Home", { title: "Docs" });
      });

      const response = await request(app).get("/");

      expect(response.status).toBe(200);
      expect(response.text).toContain("<title inertia>Docs | Imported App</title>");
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("resolves dynamic Head title expressions from page props", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "inertia-dynamic-head-title-"));
    const pagesPath = path.join(tempDir, "Pages");
    await fs.mkdir(pagesPath, { recursive: true });
    await fs.writeFile(
      path.join(pagesPath, "Home.jsx"),
      `import { Head } from "@inertiajs/react";
export default function Home({ title, section }) {
  return (
    <main>
      <Head title={title ? \`\${title} / \${section}\` : section} />
    </main>
  );
}
`,
      "utf8"
    );

    const app = express();
    app.use(
      inertiaExpress({
        headFromPage: { pagesPath },
        vite: { devServerUrl: "http://localhost:5173", entry: "resources/js/app.tsx" }
      })
    );
    app.get("/", async (_req, res) => {
      await res.inertia("Home", { title: "Docs", section: "Guide" });
    });

    const response = await request(app).get("/");

    expect(response.status).toBe(200);
    expect(response.text).toContain("<title inertia>Docs / Guide</title>");
  });

  it("reads Head from vue page and infers app title format", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "inertia-vue-pages-"));
    const pagesPath = path.join(tempDir, "resources", "js", "Pages");
    const appEntryPath = path.join(tempDir, "resources", "js", "app.ts");
    await fs.mkdir(pagesPath, { recursive: true });
    await fs.writeFile(
      path.join(pagesPath, "Home.vue"),
      `<template>
  <Head title="Home">
    <meta name="description" :content="description" />
  </Head>
</template>
`,
      "utf8"
    );
    await fs.writeFile(
      appEntryPath,
      `const APP_NAME = "Arpon's Vue Demo";
createInertiaApp({
  title: (title) => (title ? \`\${title} | \${APP_NAME}\` : APP_NAME)
});
`,
      "utf8"
    );

    const originalCwd = process.cwd();
    process.chdir(tempDir);

    try {
      const app = express();
      app.use(
        inertiaExpress({
          headFromPage: { pagesPath },
          vite: { devServerUrl: "http://localhost:5173", entry: "resources/js/app.ts" }
        })
      );
      app.get("/", async (_req, res) => {
        await res.inertia("Home", {
          description: "Vue description"
        });
      });

      const response = await request(app).get("/");

      expect(response.status).toBe(200);
      expect(response.text).toContain("<title inertia>Home | Arpon&#39;s Vue Demo</title>");
      expect(response.text).toContain(`<meta name="description" content="Vue description" >`);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("returns inertia json for xhr request", async () => {
    const app = express();
    app.use(inertiaExpress());
    app.get("/dashboard", async (_req, res) => {
      await res.inertia("Dashboard", { user: { id: 1 } });
    });

    const response = await request(app)
      .get("/dashboard")
      .set("X-Inertia", "true");

    expect(response.status).toBe(200);
    expect(response.headers["x-inertia"]).toBe("true");
    expect(response.body.component).toBe("Dashboard");
    expect(response.body.props.user.id).toBe(1);
  });

  it("returns 409 when version mismatches", async () => {
    const app = express();
    app.use(
      inertiaExpress({
        version: "1"
      })
    );
    app.get("/settings", async (_req, res) => {
      await res.inertia("Settings");
    });

    const response = await request(app)
      .get("/settings")
      .set("X-Inertia", "true")
      .set("X-Inertia-Version", "old");

    expect(response.status).toBe(409);
    expect(response.headers["x-inertia-location"]).toBe("/settings");
  });

  it("renders html from templatePath", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "inertia-template-"));
    const templatePath = path.join(tempDir, "index.html");
    await fs.writeFile(
      templatePath,
      `<!doctype html><html><head><title>Default Title</title><!-- INERTIA_HEAD --><!-- INERTIA_VITE_TAGS --></head><body><main id="__INERTIA_ROOT_ID__" data-page='__INERTIA_PAGE__'>__INERTIA_SSR_BODY__</main></body></html>`,
      "utf8"
    );

    const ssrServer = await startMockSsrServer({
      head: [
        `<title inertia>SSR Title</title>`,
        `<meta name="description" content="SSR description" />`
      ],
      body: `<article>SSR body</article>`
    });

    try {
      const app = express();
      app.use(
        inertiaExpress({
          templatePath,
          vite: { devServerUrl: "http://127.0.0.1:5173", entry: "resources/js/app.jsx" },
          ssr: { url: ssrServer.url }
        })
      );
      app.get("/", async (_req, res) => {
        await res.inertia("Home", { hello: "world" });
      });

      const response = await request(app).get("/");

      expect(response.status).toBe(200);
      expect(response.text).toContain('<main id="app"');
      expect(response.text).toContain('"component":"Home"');
      expect(response.text).toContain("http://127.0.0.1:5173/@vite/client");
      expect(response.text).toContain(`<title inertia>SSR Title</title>`);
      expect(response.text).not.toContain(`<title>Default Title</title>`);
      expect(response.text).toContain(`<meta name="description" content="SSR description" />`);
      expect(response.text).toContain("<article>SSR body</article>");
    } finally {
      await ssrServer.close();
    }
  });

  it("renders ssr head and body with default template", async () => {
    const ssrServer = await startMockSsrServer({
      head: [`<meta name="robots" content="index,follow" />`],
      body: "<section>hello</section>"
    });

    try {
      const app = express();
      app.use(
        inertiaExpress({
          ssr: { url: ssrServer.url }
        })
      );
      app.get("/", async (_req, res) => {
        await res.inertia("Home");
      });

      const response = await request(app).get("/");

      expect(response.status).toBe(200);
      expect(response.text).toContain(`<meta name="robots" content="index,follow" />`);
      expect(response.text).toContain("<section>hello</section>");
    } finally {
      await ssrServer.close();
    }
  });

  it("uses manifest mode when vite.isDev is false even with devServerUrl set", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "inertia-isdev-false-"));
    const manifestPath = path.join(tempDir, "manifest.json");
    await fs.writeFile(
      manifestPath,
      JSON.stringify(
        {
          "resources/js/app.jsx": {
            file: "assets/app-prod.js",
            isEntry: true
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const app = express();
    app.use(
      inertiaExpress({
        vite: {
          isDev: false,
          devServerUrl: "http://127.0.0.1:5173",
          entry: "resources/js/app.jsx",
          manifestPath,
          assetsBase: "/"
        }
      })
    );
    app.get("/", async (_req, res) => {
      await res.inertia("Home");
    });

    const response = await request(app).get("/");
    expect(response.status).toBe(200);
    expect(response.text).toContain('/assets/app-prod.js');
    expect(response.text).not.toContain("@vite/client");
  });

  it("throws when vite.isDev is true without vite.devServerUrl", async () => {
    const app = express();
    app.use(
      inertiaExpress({
        vite: {
          isDev: true,
          entry: "resources/js/app.tsx"
        }
      })
    );
    app.get("/", async (_req, res) => {
      await res.inertia("Home");
    });
    app.use((error, _req, res, _next) => {
      res.status(500).send(error.message);
    });

    const response = await request(app).get("/");
    expect(response.status).toBe(500);
    expect(response.text).toContain("vite.devServerUrl is required when vite.isDev is true.");
  });

  it("reloads vite manifest when it changes", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "inertia-manifest-"));
    const manifestPath = path.join(tempDir, "manifest.json");
    await fs.writeFile(
      manifestPath,
      JSON.stringify(
        {
          "resources/js/app.jsx": {
            file: "assets/app-one.js",
            isEntry: true
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const app = express();
    app.use(
      inertiaExpress({
        vite: {
          entry: "resources/js/app.jsx",
          manifestPath,
          assetsBase: "/"
        }
      })
    );
    app.get("/", async (_req, res) => {
      await res.inertia("Home");
    });

    const firstResponse = await request(app).get("/");
    expect(firstResponse.status).toBe(200);
    expect(firstResponse.text).toContain('/assets/app-one.js');

    await fs.writeFile(
      manifestPath,
      JSON.stringify(
        {
          "resources/js/app.jsx": {
            file: "assets/app-two.js",
            isEntry: true
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const secondResponse = await request(app).get("/");
    expect(secondResponse.status).toBe(200);
    expect(secondResponse.text).toContain('/assets/app-two.js');
  });
});

