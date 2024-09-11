import { useRef, useLayoutEffect, useState } from 'react';

const useScroll = (): number => {
    const [scrollY, setScrollY] = useState<number>(0);

    const onScroll = () => {
        // console.log("onscroll?")
        setScrollY(window.scrollY);
    };

    useLayoutEffect(() => {
        window.addEventListener('scroll', onScroll);
        return () => window.removeEventListener('scroll', onScroll);
    }, []);

    return scrollY;
};

export default useScroll
