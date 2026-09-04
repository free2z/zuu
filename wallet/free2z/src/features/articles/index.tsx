import { Route, Routes, useLocation } from "react-router-dom";
import { Author } from "./pages/Author";
import { Feed } from "./pages/Feed";
import { Reader } from "./pages/Reader";

function AuthorRoute() {
  const location = useLocation();
  // Each local draft is its own editor identity. A history traversal or draft
  // switch remounts the composer so state from one draft cannot bleed into the
  // next one before storage hydration runs.
  return <Author key={location.search} />;
}

export default function ArticlesFeature() {
  return (
    <Routes>
      <Route index element={<Feed />} />
      {/* `new` must match before the `:slug` catch-all. */}
      <Route path="new" element={<AuthorRoute />} />
      <Route path=":slug" element={<Reader />} />
      <Route path="*" element={<Feed />} />
    </Routes>
  );
}
