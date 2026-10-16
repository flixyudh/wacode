import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const envSchema = z.object({
  WHATSAPP_WHITELIST: z
    .string()
    .default("")
    .transform((s) =>
      s
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  WHATSAPP_LOGIN_MODE: z.enum(["pairing", "qr"]).default("pairing"),
  WHATSAPP_PHONE_NUMBER: z.string().optional().default(""),
  WHATSAPP_SHARED_SECRET: z.string().optional().default(""),
  /** Static LID→PN map (`lid:pn,lid:pn`); validated in lid-resolver at boot. */
  WHATSAPP_LID_MAP: z.string().optional().default(""),

  MCP_BIND: z.string().default("127.0.0.1"),
  MCP_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  MCP_TOKEN: z
    .string()
    .min(1, "MCP_TOKEN is required — set a long random secret. Server refuses to start without it."),

  AUTO_READ_SCOPE: z.enum(["whitelist", "all"]).default("whitelist"),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(6),
  SESSION_COMPACT_AFTER: z.coerce.number().int().positive().default(40),
  RATE_LIMIT_PER_SENDER_SECONDS: z.coerce.number().min(0).default(5),

  OPENCODE_HOST: z.string().default("127.0.0.1"),
  OPENCODE_PORT: z.coerce.number().int().min(1).max(65535).default(4096),
  OPENCODE_AGENT: z.string().min(1).default("whatsapp-bridge"),
  /** provider/model, e.g. `opencode/big-pickle` (free Zen model, no key). */
  OPENCODE_MODEL: z
    .string()
    .default("opencode/big-pickle")
    .refine((v) => v === "" || /^[^/\s]+\/.+$/.test(v), {
      message:
        "must be `provider/model` (e.g. opencode/big-pickle), or empty to use the server's default model",
    }),
  OPENCODE_PASSWORD: z.string().optional().default(""),
  OPENCODE_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),

  DATA_DIR: z.string().default("./data"),
  DB_PATH: z.string().default("./data/bridge.db"),
  AUTH_DIR: z.string().default("./data/auth_info"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
});

export type AppConfig = z.infer<typeof envSchema>;

let cached: AppConfig | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (cached) return cached;
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const cfg = parsed.data;

  // Cross-field validation: pairing mode needs a usable phone number.
  if (cfg.WHATSAPP_LOGIN_MODE === "pairing") {
    const digits = (cfg.WHATSAPP_PHONE_NUMBER ?? "").replace(/\D/g, "");
    if (!digits) {
      throw new Error(
        "Invalid configuration:\n  - WHATSAPP_PHONE_NUMBER: required when WHATSAPP_LOGIN_MODE=pairing (digits with country code, e.g. 6281234567890)",
      );
    }
    if (digits.startsWith("0") || digits.length < 7 || digits.length > 15) {
      throw new Error(
        `Invalid configuration:\n  - WHATSAPP_PHONE_NUMBER: use international digits without "+" or trunk zero (e.g. 0812… → 62812…). Got: ${cfg.WHATSAPP_PHONE_NUMBER}`,
      );
    }
  }

  // Refuse weak default token loudly.
  if (cfg.MCP_TOKEN === "change-me-to-a-long-random-secret") {
    throw new Error(
      "Invalid configuration:\n  - MCP_TOKEN: change the default placeholder to a long random secret",
    );
  }
  if (cfg.MCP_TOKEN.length < 16) {
    throw new Error(
      "Invalid configuration:\n  - MCP_TOKEN: must be at least 16 characters",
    );
  }

  cached = cfg;
  return cfg;
}

/** For tests: reset memoised config. */
export function __resetConfigCache(): void {
  cached = null;
}
