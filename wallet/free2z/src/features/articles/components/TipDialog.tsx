import { useLocation } from "react-router-dom";
import { usePaidIntent } from "@/hooks/usePaidIntent";
import { useAsync } from "@/hooks/useAsync";
import { discover } from "@/lib/api/free2z";
import type { SimpleCreator } from "@/lib/api/types";
import { TipButton } from "@/features/creator/TipButton";

/** Articles carry no payment destination. Resolve the exact author through the
 * existing public profile API; never infer an address from the article slug.
 * The shared dialog freezes this result when opened, so a late lookup requires
 * a new review rather than silently substituting the destination.
 */
export function TipDialog({ author }: { author: SimpleCreator }) {
  return <AuthorTip key={author.username} author={author} />;
}
function AuthorTip({ author }: { author: SimpleCreator }) {
  const location = useLocation();
  const restored = usePaidIntent(location.pathname, "article-tip");
  const { data, loading, error } = useAsync(
    () => discover.creator(author.username),
    [author.username],
  );
  const matching = data?.username === author.username;
  return (
    <TipButton
      creator={{
        username: author.username,
        display_name: author.display_name || author.username,
        p2paddr: matching ? data.p2paddr : null,
      }}
      restored={restored}
      intentKind="article-tip"
      triggerText="Tip the author"
      variant="default"
      destinationStatus={
        loading ? "loading" : error || !matching ? "failed" : undefined
      }
    />
  );
}
