import axios from "axios"
import { lazy, useEffect, useState } from "react"
import { useParams } from "react-router"
import CreatorDetail from "./CreatorDetail"
import PageDetail from "./PageDetail"
// https://reactjs.org/docs/code-splitting.html
// import Global404 from "./Global404"
const Global404 = lazy(() => import('./Global404'))

export default function RootSplitter() {
    const [_404, set404] = useState(false)
    const params = useParams()

    const [type, setType] = useState("" as "" | "zpage" | "creator")

    useEffect(() => {
        axios.get(`/api/get-type/${params.id}`).then((res) => {
            // console.log(res)
            setType(res.data)
            // TODO: maybe not global? yeah, probably not
            set404(false)
        }).catch(() => {
            set404(true)
        })
    }, [params.id])

    if (_404) {
        return <Global404 />
        // return null
    }
    if (!type) {
        return null
    }

    if (type == "zpage") {
        return <PageDetail />
    }

    if (type == "creator") {
        return <CreatorDetail />
    }

    return null
}
