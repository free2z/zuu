import { Routes, Route } from "react-router-dom";
import { Discovery } from "./Discovery";
import { Room } from "./Room";

export default function LiveFeature() {
  return (
    <Routes>
      <Route index element={<Discovery />} />
      <Route path=":username" element={<Room />} />
    </Routes>
  );
}
