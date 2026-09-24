import { z } from 'zod';

export const panelsSchema = z.strictObject({
  detailHeight: z.number().int().min(160).max(10000).optional(),
  summaryHeight: z.number().int().min(64).max(10000).optional(),
  filesWidth: z.number().int().min(96).max(10000).optional(),
  detailMaximized: z.boolean().optional(),
});

// Read only supported layout fields; retired preferences must not hide current UI.
export const storedPanelsSchema = panelsSchema.strip();

export type PanelLayout = z.infer<typeof panelsSchema>;
