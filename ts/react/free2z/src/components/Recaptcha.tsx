import { Stack } from "@mui/system"
import { forwardRef, useState } from "react"
import ReCAPTCHA from "react-google-recaptcha"

import { useGlobalState } from "../state/global"
import { useInterval } from "../hooks/useInterval"


export interface IRecaptchaProps {
    asyncScriptOnLoad?: (() => void)
}

export const useRecaptchaClosed = (processing: boolean, callback: () => void) => {
    const [showed, setShowed] = useState(false) // condition that challenge has been shown

    useInterval(() => {
        const iframes = document.querySelectorAll('iframe[src*="recaptcha/api2/bframe"]')
        if (iframes.length === 0) return
        const recaptchaOverlay = iframes[0]?.parentNode?.parentNode
        if (processing && (recaptchaOverlay as any)?.style?.visibility === 'visible') setShowed(true)
        if (processing && (recaptchaOverlay as any)?.style?.visibility === 'hidden' && showed) {
            callback()
        }
    }, processing ? 100 : null) // detect if overlay visible every 100ms
}


export default forwardRef(function Recaptcha(props: IRecaptchaProps, ref) {
    const { asyncScriptOnLoad } = props
    const [loading, setLoading] = useGlobalState("loading")

    return (
        <Stack
            direction="row"
            alignItems="center"
            justifyContent="center"
            style={{ marginTop: "0.5em" }}
        >
            <ReCAPTCHA
                size="invisible"
                ref={ref as React.RefObject<ReCAPTCHA>}
                sitekey="6LckfE8pAAAAAO6LqS7OOYiuDjaL84H3tSKmHxJ4"
                theme="dark"
                asyncScriptOnLoad={asyncScriptOnLoad}
                onErrored={() => { setLoading(false) }}
                onExpired={() => { setLoading(false) }}
            />
        </Stack>
    )
})
