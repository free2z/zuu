import React from 'react';
import { Link, LinkProps } from '@mui/material';

type MLinkProps = Omit<LinkProps, 'color'> & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'color'>;

const MLink: React.FC<MLinkProps> = ({ href, ...props }) => {
    const isInternalLink = href?.startsWith('#');

    return (
        <Link
            href={href}
            target={isInternalLink ? undefined : '_blank'}
            rel={isInternalLink ? undefined : 'noopener noreferrer'}
            {...props}
        />
    );
};

export default MLink;
