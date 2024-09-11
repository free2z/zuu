import React, { useEffect, useRef } from 'react';
import mermaid from 'mermaid';

interface MermaidProps {
    chart: string;
}

const Mermaid: React.FC<MermaidProps> = ({ chart }) => {
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (ref.current) {
            mermaid.contentLoaded();
            // console.log(chart)
        }
    }, [chart]);

    return <div ref={ref} className="mermaid">{chart}</div>;
};

export default Mermaid;
