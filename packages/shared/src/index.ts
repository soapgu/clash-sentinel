import { z } from 'zod';
export const healthResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    service: z.literal('clash-sentinel'),
    status: z.literal('ok'),
  }),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;
