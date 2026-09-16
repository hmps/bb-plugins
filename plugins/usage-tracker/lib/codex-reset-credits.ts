import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

const REQUEST_TIMEOUT_MS = 8_000;
const MAX_STDOUT_BYTES = 256 * 1024;

interface JsonRpcMessage {
  id?: number;
  result?: unknown;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Read the available reset-credit count from an app-server JSON-RPC result. */
export function parseResetCreditCount(result: unknown): number | null {
  const summary = record(record(result)?.rateLimitResetCredits);
  const count = summary?.availableCount;
  const parsed =
    typeof count === "number"
      ? count
      : typeof count === "string" && /^\d+$/u.test(count)
        ? Number(count)
        : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

async function firstExecutable(candidates: readonly string[]): Promise<string> {
  for (const candidate of candidates) {
    if (!candidate.includes("/")) continue;
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next known location.
    }
  }
  return "codex";
}

async function resolveCodexCommand(): Promise<string> {
  const pathCandidates = (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => join(directory, "codex"));
  return firstExecutable([
    ...pathCandidates,
    join(homedir(), ".local", "bin", "codex"),
    join(homedir(), ".codex", "packages", "standalone", "current", "bin", "codex"),
  ]);
}

/**
 * Read Codex reset credits through the read-only app-server method. This never
 * calls `account/rateLimitResetCredit/consume`.
 */
export async function loadCodexResetCredits(): Promise<number | null> {
  const command = await resolveCodexCommand();
  return new Promise((resolve) => {
    const child = spawn(command, ["app-server", "--stdio"], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    let settled = false;
    let stdout = "";

    const finish = (count: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill();
      resolve(count);
    };
    const send = (message: unknown): void => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const timeout = setTimeout(() => finish(null), REQUEST_TIMEOUT_MS);

    child.once("error", () => finish(null));
    child.stdin.once("error", () => finish(null));
    child.once("close", () => finish(null));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MAX_STDOUT_BYTES) {
        finish(null);
        return;
      }

      let lineEnd = stdout.indexOf("\n");
      while (lineEnd >= 0) {
        const line = stdout.slice(0, lineEnd);
        stdout = stdout.slice(lineEnd + 1);
        let message: JsonRpcMessage;
        try {
          message = JSON.parse(line) as JsonRpcMessage;
        } catch {
          lineEnd = stdout.indexOf("\n");
          continue;
        }

        if (message.id === 1) {
          send({ method: "initialized" });
          send({ method: "account/rateLimits/read", id: 2 });
        } else if (message.id === 2) {
          finish(parseResetCreditCount(message.result));
          return;
        }
        lineEnd = stdout.indexOf("\n");
      }
    });

    send({
      method: "initialize",
      id: 1,
      params: {
        clientInfo: {
          name: "bb-usage-tracker",
          title: "BB Usage Tracker",
          version: "1.1.0",
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      },
    });
  });
}
