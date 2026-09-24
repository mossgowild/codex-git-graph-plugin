import { z } from 'zod';

export const columns = [
  { id: 'graph', label: '关系图', min: 20, initial: 20 },
  { id: 'message', label: '提交', min: 100, initial: 180 },
  { id: 'author', label: '作者', min: 56, initial: 100 },
  { id: 'date', label: '日期', min: 48, initial: 60 },
  { id: 'hash', label: 'SHA', min: 56, initial: 64 },
] as const;
export type ColumnId = typeof columns[number]['id'];
export const maxColumnWidth = 2400;
export const widthsSchema = z.strictObject(Object.fromEntries(columns.map(column =>
  [column.id, z.number().int().min(column.min).max(maxColumnWidth).optional()])) as Record<ColumnId, z.ZodOptional<z.ZodNumber>>);

export const panelsSchema = z.strictObject({
  detailHeight: z.number().int().min(160).max(10000).optional(),
  summaryHeight: z.number().int().min(64).max(10000).optional(),
  filesWidth: z.number().int().min(96).max(10000).optional(),
  detailMaximized: z.boolean().optional(),
});

// Read only supported layout fields; retired preferences must not hide current UI.
export const storedPanelsSchema = panelsSchema.strip();

export type ColumnWidths = z.infer<typeof widthsSchema>;
export type PanelLayout = z.infer<typeof panelsSchema>;
