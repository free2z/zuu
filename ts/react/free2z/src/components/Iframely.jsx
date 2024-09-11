import React, { useEffect, useState } from "react";

import "./Iframely.css"
import { useGlobalState } from "../state/global";

const KEY = "c7c62b2d895d05ffeb410c4d535e6823";


export default function Iframely(props) {
    const [error, setError] = useState(null);
    const [isLoaded, setIsLoaded] = useState(false);
    const [loadingEmbed, setLoadingEmbed] = useGlobalState("loadingEmbed")
    const [html, setHtml] = useState({
        __html: "<div />"
    })

    useEffect(() => {
        setLoadingEmbed(true)
    }, [])

    useEffect(() => {
        if (props && props.url) {
            fetch(`https://cdn.iframe.ly/api/iframely?url=${encodeURIComponent(props.url)}&key=${KEY}&iframe=1&omit_script=1`)
                .then(res => res.json())
                .then(
                    (res) => {
                        setIsLoaded(true);
                        setLoadingEmbed(false)
                        if (res.html) {
                            setHtml({ __html: res.html });
                        } else if (res.error) {
                            setError({ code: res.error, message: res.message });
                        }
                    },
                    (error) => {
                        setIsLoaded(true);
                        setLoadingEmbed(false)
                        setError(error);
                    }
                )
        } else {
            setError({ code: 400, message: 'Provide url attribute for the element' })
        }
    }, []);

    useEffect((props) => {
        if (window.iframely) {
            window.iframely.extendOptions({ api_key: KEY })
            window.iframely.load();
        }
    });

    if (error) {
        return <div>Error: {error.code} - {error.message}</div>;
    } else if (!isLoaded) {
        return <div>Loading...</div>;
    } else {
        return (
            <div
                className="IframelyComponent"
                style={{
                    margin: "0.5em auto",
                }}
                dangerouslySetInnerHTML={html}
            />
        );
    }
}
