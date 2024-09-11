import {
    Button, Dialog, DialogActions, DialogContent, DialogTitle, TextField,
} from "@mui/material"
import axios from "axios"
import { useEffect, useState } from "react"
import { useGlobalState } from "../state/global"


type OTPModalProps = {
    username: string,
    password: string,
    handleSuccess: () => void
    handleCancel: () => void
    captcha_result: string | null | undefined
}


export default function CreatorLoginOTPModal(props: OTPModalProps) {
    const { username, password, captcha_result } = props
    const [otpCode, setOtpCode] = useState("")
    const [dialogOpen, setDialogOpen] = useState(true)
    const [snackbar, setSnackbar] = useGlobalState("snackbar")
    const [isSubmitting, setIsSubmitting] = useState(false)

    const submit = () => {
        setIsSubmitting(true)
        const data = {
            username: username,
            password: password,
            otp_token: otpCode,
            captcha_result: captcha_result,
        }
        axios.post("/api/auth/login/", data)
            .then((res) => {
                props.handleSuccess()
                setDialogOpen(false)
            })
            .catch((err) => {
                console.log(err)
                setSnackbar({
                    open: true,
                    message: "Error logging in",
                    severity: "error",
                    duration: 5000,
                })
                setIsSubmitting(false)
            })
    }

    useEffect(() => {
        if (otpCode.length === 6) {
            submit();
        }
    }, [otpCode]);

    return <Dialog open={dialogOpen}>
        <DialogTitle>Multifactor Authentication</DialogTitle>
        <DialogContent>
            <TextField
                label="OTP Code"
                value={otpCode}
                onChange={(e) => {
                    setOtpCode(e.target.value)
                }}
                fullWidth
                autoFocus
                sx={{ mt: 1 }}
            />
        </DialogContent>
        <DialogActions>
            <Button onClick={() => {
                setDialogOpen(false)
                props.handleCancel()
            }}
                color="warning"
            >
                Cancel
            </Button>
            <Button onClick={submit}
                disabled={isSubmitting}
            >
                Login
            </Button>
        </DialogActions>
    </Dialog>
}