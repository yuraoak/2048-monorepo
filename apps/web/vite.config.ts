import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// Renders /.well-known/farcaster.json by substituting __PUBLIC_URL__ in the
// template with VITE_PUBLIC_URL. Served via dev middleware and emitted into
// the build output — keeps the manifest URL in lockstep with whatever
// domain the deploy is using, without any prebuild scripts or generated
// files in the working tree.
function farcasterManifest(): Plugin {
  const render = () => {
    const url = process.env.VITE_PUBLIC_URL ?? "http://localhost:5173";
    const tpl = readFileSync(resolve(here, "farcaster.template.json"), "utf8");
    return tpl.replaceAll("__PUBLIC_URL__", url);
  };

  return {
    name: "farcaster-manifest",
    configureServer(server) {
      server.middlewares.use("/.well-known/farcaster.json", (_req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(render());
      });
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: ".well-known/farcaster.json",
        source: render(),
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), farcasterManifest()],
  server: { port: 5173 },
  preview: { port: Number(process.env.PORT ?? 4173), host: true, allowedHosts: true },
});
