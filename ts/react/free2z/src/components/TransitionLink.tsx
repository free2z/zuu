import { SyntheticEvent, startTransition } from 'react';
import { Link as RouterLink, LinkProps } from 'react-router-dom';
import { useTransitionNavigate } from '../hooks/useTransitionNavigate';
import React from 'react';

interface CustomLinkProps extends LinkProps {
    to: string;
    children: React.ReactNode;
    onBeforeNavigate?: () => void;
}

const Link = React.forwardRef<HTMLAnchorElement, CustomLinkProps>(({ to, children, onBeforeNavigate, ...props }, ref) => {
    const navigate = useTransitionNavigate();

    const handleClick = (e: SyntheticEvent) => {
        e.preventDefault();
        onBeforeNavigate?.(); // call this before navigate

        startTransition(() => {
            navigate(to);
        });

        // This is a hack to wait until we navigate to the new page
        // before scrolling to the top.
        setTimeout(() => {
            window.scrollTo(0, 0);
        }, 100);
    };

    return (
        <RouterLink to={to} ref={ref} {...props} onClick={handleClick}>
            {children}
        </RouterLink>
    );
});

export default Link;
