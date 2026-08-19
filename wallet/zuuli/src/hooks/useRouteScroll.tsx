import { createContext, useContext, type ReactNode } from "react";

export type RouteScrollContextValue = {
  registerViewport: (node: HTMLDivElement | null) => void;
  scrollToTop: () => void;
  viewport: HTMLDivElement | null;
};

const RouteScrollContext = createContext<RouteScrollContextValue | null>(null);

export function RouteScrollContextProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: RouteScrollContextValue;
}) {
  return (
    <RouteScrollContext.Provider value={value}>
      {children}
    </RouteScrollContext.Provider>
  );
}

export function useRouteScroll() {
  const value = useContext(RouteScrollContext);
  if (!value)
    throw new Error("useRouteScroll must be used inside RouteScrollProvider");
  return value;
}
