// @ts-check
import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

// Static content site for audivane.app. The browser app is served by its own
// build under /demo/ (see INTEGRATION.md) and is deliberately not an Astro
// route: heavy client assets load only there, and this site's sitemap and
// SEO surface exclude it.
export default defineConfig({
  site: "https://audivane.app/",
  output: "static",
  trailingSlash: "always",
  integrations: [sitemap()],
});
