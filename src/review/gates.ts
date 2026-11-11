import type { Severity } from "./types.js";

export function validateFailOn(value: unknown, name = "failOn"): Severity | "none" {
  if (value !== "error" && value !== "warn" && value !== "info" && value !== "none") {
    throw new Error(`${name} must be one of error, warn, info, none (got "${String(value)}")`);
  }
  return value;
}

export function validateMinScore(value: unknown, name = "minScore", raw: unknown = value): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`${name} must be a finite number between 0 and 100 (got "${String(raw)}")`);
  }
  return value;
}
