import { useEffect } from "react"
import { useLocation } from "react-router-dom"
import axios from "axios"
import { useGlobalState } from "../state/global"
import { useTransitionNavigate } from "../hooks/useTransitionNavigate"


function RedirectUnauthed() {
    const navigate = useTransitionNavigate()
    const [creator, setCreator] = useGlobalState("creator")
    const [redirect, setRedirect] = useGlobalState('redirect')
    const location = useLocation()

    useEffect(() => {
        axios
            .get("/api/auth/user/")
            .then((res) => {
                // console.log("[get auth/user] REDIRECT unauthed!!")
                setCreator(res.data)
            })
            .catch((res) => {
                console.error("REDIRECT")
                setRedirect(location.pathname)
                navigate("/begin")
            })
    }, [])

    return (
        <></>
    )
}

export default RedirectUnauthed
