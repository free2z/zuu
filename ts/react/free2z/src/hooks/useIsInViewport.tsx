import { MutableRefObject, RefObject, useEffect, useMemo, useState } from "react"

export default function useIsInViewport<T extends HTMLElement>(ref: MutableRefObject<T> | RefObject<T>) {
  const [isIntersecting, setIsIntersecting] = useState(false);

  const observer = useMemo(
    () =>
      new IntersectionObserver(([entry]) =>
        setIsIntersecting(entry.isIntersecting),
      ),
    [],
  );

  useEffect(() => {
    if (!ref.current) {
      return;
    }
    observer.observe(ref.current);

    return () => {
      observer.disconnect();
    };
  }, [ref, observer]);

  return isIntersecting;
}
