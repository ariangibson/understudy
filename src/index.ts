import "./load-env.js"; // must run before config.js reads process.env
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { config, configuredProviders } from "./config.js";

const app = createApp();

const providers = configuredProviders();
if (providers.length === 0) {
  console.warn(
    "⚠️  No provider API keys found. Set at least one of ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY, XAI_API_KEY, GROQ_API_KEY, DEEPSEEK_API_KEY, MISTRAL_API_KEY (or OLLAMA_ENABLED=true).",
  );
}
if (config.gatewayKeys.length === 0) {
  console.warn(
    "⚠️  GATEWAY_API_KEYS is not set — the gateway is open to anyone who can reach it. Fine for localhost, not for anything exposed.",
  );
}

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`🎭 understudy is in the wings — http://localhost:${info.port}`);
  console.log(`   cast: ${providers.map((p) => p.name).join(", ") || "(none — set a provider API key)"}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    // Force-exit if in-flight streams keep the server open too long.
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
