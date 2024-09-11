import { Helmet } from "react-helmet-async";
import Find from "./Find";

export default function FindPage() {
    return (
        <>
            <Helmet>
                <title>Free2Z Find</title>
                <link
                    rel="alternate"
                    type="application/rss+xml"
                    title="zPages Feed"
                    href="/feeds/zpages/recent.xml"
                />
            </Helmet>
            <Find mine={false} />
        </>
    )
}