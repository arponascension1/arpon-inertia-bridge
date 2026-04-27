import express from "express";
import inertiaExpress from "arpon-inertia-bridge";
import path from "node:path";

const app = express();
const devServerUrl = process.env.VITE_DEV_SERVER_URL;
const isDev = typeof devServerUrl === "string" && devServerUrl.length > 0;

if (!isDev) {
  app.use(express.static(path.resolve(process.cwd(), "public")));
}

app.use(
  inertiaExpress({
    version: "demo-vue-v1",
    sharedProps: ({ req }) => ({
      appName: "Inertia Vue Demo",
      currentPath: req.path
    }),
    headFromPage: {
      pagesPath: path.join(process.cwd(), "resources", "js", "Pages")
    },
    vite: {
      adapter: "vue",
      isDev,
      devServerUrl,
      entry: "resources/js/app.ts",
      manifestPath: path.resolve(process.cwd(), "public", ".vite", "manifest.json"),
      assetsBase: "/"
    }
  })
);

app.get("/", async (_req, res) => {
  await res.inertia("Home", {
    title: "Home",
    description: "Vue + Inertia demo powered by arpon-inertia-bridge.",
    message: "This is a Vue Inertia demo using the new adapter mode."
  });
});

app.get("/about", async (_req, res) => {
  await res.inertia("About", {
    title: "About",
    description: "About page for the Vue adapter demo."
  });
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).send("Internal server error");
});

const port = Number(process.env.PORT ?? 3001);
app.listen(port, "127.0.0.1", () => {
  console.log(`Vue demo server running at http://127.0.0.1:${port}`);
});
