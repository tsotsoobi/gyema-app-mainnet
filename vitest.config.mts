import { defineConfig } from "vitest/config"
import { fileURLToPath } from "node:url"

// Test harness for the API routes.
//
// The routes are plain async functions over Request and Response, so they run
// under Node without a server: a test builds a Request, calls the exported
// POST or GET, and reads the Response. Nothing here starts Next.
//
// There is no Supabase in the loop. Every route reaches the database through
// lib/supabase-admin, and each test file replaces that module with the mock in
// tests/helpers/admin-mock.ts. No test opens a socket, so no test can touch
// Testnet or Mainnet data. That is a property of the harness, not of the
// discipline of whoever writes the next test: there is no connection string
// anywhere in this directory to point at a project by accident.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // The dispatch reader tests spawn a node process each. 20s is generous
    // for that and still short enough that a hang fails rather than sits.
    testTimeout: 20000,
  },
})
