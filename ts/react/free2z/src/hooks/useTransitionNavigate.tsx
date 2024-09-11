import { useNavigate, NavigateOptions, To, NavigateFunction } from 'react-router-dom';
import { startTransition } from 'react';

export function useTransitionNavigate(): NavigateFunction {
    const navigate = useNavigate();

    const transitionNavigate: NavigateFunction = ((to: To | number, options?: NavigateOptions | undefined) => {
        startTransition(() => {
            if (typeof to === "number") {
                navigate(to);
            } else {
                navigate(to, options);
            }
        });
    }) as NavigateFunction;

    return transitionNavigate;
}
