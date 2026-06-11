import { existsSync } from "node:fs";

// Node 20.12+ ships a native .env loader — no dotenv dependency needed.
// Existing environment variables take precedence over file values.
if (existsSync(".env")) process.loadEnvFile(".env");
