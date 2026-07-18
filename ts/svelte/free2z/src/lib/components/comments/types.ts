export type CommentAuthor = {
    username: string;
    avatar_image?: {
        url?: string;
        thumbnail?: string;
    };
};

export type CommentData = {
    uuid: string;
    author: CommentAuthor;
    parent: string | null;
    headline: string;
    content: string;
    tuzis: number;
    created_at: string;
    updated_at: string;
    num_children: number;
    content_url: string | null;
};
