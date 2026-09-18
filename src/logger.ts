import pino from "pino";
import type { AppConfig } from "./config.js";

let logger: pino.Logger | null = null;

export function createLogger(cfg: Pick<AppConfig, "LOG_LEVEL">): pino.Logger {
  if (logger) return logger;
  logger = pino({
    level: cfg.LOG_LEVEL,
    formatters: {
      level: (label) => ({ level: label }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
  return logger;
}

export function getLogger(): pino.Logger {
  if (!logger) {
    logger = pino({ level: "info" });
  }
  return logger;
}
