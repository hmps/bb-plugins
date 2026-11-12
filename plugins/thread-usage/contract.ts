import { defineRpcContract } from "@get-bb/plugin-sdk";
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
export type ThreadUsage = z.infer<typeof threadUsageSchema>;
export type DailyUsage = z.infer<typeof dailyUsageSchema>;
export const usageRpcContract = defineRpcContract({
  getThreadUsage: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: threadUsageSchema.nullable(),
  },
  getDailyUsage: {
    input: z.object({ days: z.number().int().min(1).max(3660).default(7) }).strict(),
    output: dailyUsageSchema,
  },
});
