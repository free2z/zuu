import type {
  CommentAuthor as ApiCommentAuthor,
  CommentList,
  ThreadAccessEnum,
} from "$lib/api/f2z.schemas";

export type CommentAuthor = ApiCommentAuthor;

export type CommentThreadAccess = ThreadAccessEnum;

export type CommentData = Omit<
  CommentList,
  "content_url" | "num_children" | "tuzis"
> & {
  content_url: CommentList["content_url"] | null;
  num_children: CommentList["num_children"];
  tuzis: NonNullable<CommentList["tuzis"]>;
};
