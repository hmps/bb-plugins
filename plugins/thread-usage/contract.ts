import type { defineRpcContract as sdkDefineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const fields = [
  "totalTokens", "inputTokens", "cachedInputTokens", "cacheReadInputTokens",
  "cacheWriteInputTokens", "outputTokens", "reasoningOutputTokens",
] as const;
export type Totals = Record<(typeof fields)[number], number>;
export const totalsSchema = z.object({
  totalTokens: z.number(), inputTokens: z.number(), cachedInputTokens: z.number(),
  cacheReadInputTokens: z.number(), cacheWriteInputTokens: z.number(),
  outputTokens: z.number(), reasoningOutputTokens: z.number(),
});
export const threadUsageSchema = z.object({
  threadId: z.string(), projectId: z.string(), providerId: z.string(), model: z.string(),
  title: z.string().nullable(), firstSeenAt: z.number(), updatedAt: z.number(),
  archivedAt: z.number().nullable(), baseline: z.boolean(), totals: totalsSchema,
});
export const dailyRowSchema = z.object({
  day: z.string(), projectId: z.string(), model: z.string(), totals: totalsSchema,
});
export const dailyUsageSchema = z.object({ days: z.number(), rows: z.array(dailyRowSchema) });
export const threadRowSchema = z.object({
  threadId: z.string(), projectId: z.string(), model: z.string(), title: z.string().nullable(), totals: totalsSchema,
});
export const threadsUsageSchema = z.object({
  since: z.number(), retentionStart: z.number(), truncated: z.boolean(), rows: z.array(threadRowSchema),
});
export type ThreadUsage = z.infer<typeof threadUsageSchema>;
export type DailyUsage = z.infer<typeof dailyUsageSchema>;
export type ThreadsUsage = z.infer<typeof threadsUsageSchema>;
/** Read tags. The server invalidates `thread:<id>` and `totals` when stored usage changes. */
export const threadTag = (threadId: string) => `thread:${threadId}`;
export const TOTALS_TAG = "totals";
const defineRpcContract: typeof sdkDefineRpcContract = (contract) => contract as never;

export const usageRpcContract = defineRpcContract({
  getThreadUsage: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: threadUsageSchema.nullable(),
    tags: (input) => [threadTag(input.threadId)],
  },
  getDailyUsage: {
    input: z.object({ days: z.number().int().min(1).max(3660).default(7) }).strict(),
    output: dailyUsageSchema,
    tags: () => [TOTALS_TAG],
  },
  getThreads: {
    input: z.object({
      since: z.number().int().nonnegative().optional(),
      hours: z.number().int().min(1).max(24 * 3660).optional(),
      project: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(1000).default(20),
    }).strict().refine((input) => input.since === undefined || input.hours === undefined, {
      message: "Use either since or hours.",
    }),
    output: threadsUsageSchema,
    tags: () => [TOTALS_TAG],
  },
});
