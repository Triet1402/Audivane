import { defineCollection } from "astro:content";
import { z } from "astro/zod";
import { glob } from "astro/loaders";
import { checkSourceProvenance } from "./provenance.mjs";

// Only curated, user-facing pages live in content/. Repository docs under
// ../docs remain the engineering source of truth; developer notes are never
// published automatically. This gate runs on every sync/dev/build/check:
// docs pages record which repository document their claims come from
// (`source`) plus a fingerprint of that document (`source_sha256`). Any
// source change fails the build until the public summary is re-reviewed.
checkSourceProvenance();

const pageSchema = z.object({
  title: z.string(),
  description: z.string(),
  order: z.number().int(),
  updated: z.coerce.date(),
  source: z.string(),
  source_sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});

const docs = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./content/docs" }),
  schema: pageSchema,
});

const guides = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./content/guides" }),
  schema: pageSchema,
});

export const collections = { docs, guides };
