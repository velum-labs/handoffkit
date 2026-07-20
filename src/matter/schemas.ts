import { z } from "zod";

export const MatterAuthorSchema = z
  .object({
    object: z.string().optional(),
    id: z.string(),
    name: z.string()
  })
  .passthrough();

export const MatterTagSchema = z
  .object({
    object: z.literal("tag").optional(),
    id: z.string(),
    name: z.string(),
    item_count: z.number().int().nonnegative().nullable().optional().default(0),
    created_at: z.string()
  })
  .passthrough();

export const MatterItemTagSchema = z
  .object({
    object: z.literal("tag").optional(),
    id: z.string(),
    name: z.string()
  })
  .passthrough();

export const MatterItemSchema = z
  .object({
    object: z.literal("item").optional(),
    id: z.string(),
    title: z.string().nullable(),
    url: z.string().nullable().optional(),
    site_name: z.string().nullable(),
    author: MatterAuthorSchema.nullable().optional(),
    status: z.enum(["inbox", "queue", "archive"]).nullable().optional(),
    is_favorite: z.boolean().optional().default(false),
    content_type: z.enum(["article", "video", "podcast", "pdf", "tweet", "newsletter"]).nullable(),
    word_count: z.number().int().nonnegative().nullable().optional(),
    reading_progress: z.number().nullable().optional(),
    image_url: z.string().nullable().optional(),
    excerpt: z.string().nullable().optional(),
    library_position: z.number().nullable().optional(),
    inbox_position: z.number().nullable().optional(),
    tags: z.array(MatterItemTagSchema).default([]),
    updated_at: z.string(),
    processing_status: z.string().nullable().optional(),
    markdown: z.string().nullable().optional()
  })
  .passthrough();

export const MatterAnnotationSchema = z
  .object({
    object: z.literal("annotation").optional(),
    id: z.string(),
    item_id: z.string(),
    text: z.string(),
    note: z.string().nullable().optional(),
    created_at: z.string(),
    updated_at: z.string()
  })
  .passthrough();

export const MatterAccountSchema = z
  .object({
    object: z.literal("account").optional(),
    id: z.string(),
    name: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
    rate_limit: z
      .object({
        read: z.number().optional(),
        write: z.number().optional(),
        save: z.number().optional(),
        search: z.number().optional(),
        markdown: z.number().optional(),
        burst: z.number().optional()
      })
      .passthrough()
      .optional(),
    created_at: z.string().optional()
  })
  .passthrough();

export function matterListSchema<T extends z.ZodType>(itemSchema: T) {
  return z
    .object({
      object: z.literal("list").optional(),
      results: z.array(itemSchema),
      has_more: z.boolean(),
      next_cursor: z.string().nullable().optional()
    })
    .passthrough();
}

export const MatterTagListSchema = matterListSchema(MatterTagSchema);
export const MatterItemListSchema = matterListSchema(MatterItemSchema);
export const MatterAnnotationListSchema = matterListSchema(MatterAnnotationSchema);

export const MatterSearchResponseSchema = z
  .object({
    object: z.literal("search_results").optional(),
    items: MatterItemListSchema
  })
  .passthrough();

export const MatterErrorBodySchema = z
  .object({
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        field: z.string().optional()
      })
      .passthrough()
  })
  .passthrough();

export type MatterAccount = z.infer<typeof MatterAccountSchema>;
export type MatterTag = z.infer<typeof MatterTagSchema>;
export type MatterItem = z.infer<typeof MatterItemSchema>;
export type MatterAnnotation = z.infer<typeof MatterAnnotationSchema>;
export type MatterItemTag = z.infer<typeof MatterItemTagSchema>;
export type MatterListResponse<T> = {
  object?: "list";
  results: T[];
  has_more: boolean;
  next_cursor?: string | null;
};
export type MatterSearchResponse = z.infer<typeof MatterSearchResponseSchema>;
export type MatterErrorBody = z.infer<typeof MatterErrorBodySchema>;
