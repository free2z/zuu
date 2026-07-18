import { Route, Routes } from "react-router-dom";
import { Author } from "./pages/Author";
import { Feed } from "./pages/Feed";
import { Reader } from "./pages/Reader";

export default function ArticlesFeature() {
  return (
    <Routes>
      <Route index element={<Feed />} />
      {/* `new` must match before the `:slug` catch-all. */}
      <Route path="new" element={<Author />} />
      <Route path=":slug" element={<Reader />} />
      <Route path="*" element={<Feed />} />
    </Routes>
  );
}
