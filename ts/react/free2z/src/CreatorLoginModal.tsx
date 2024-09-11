import { useLocation } from "react-router"
import axios from "axios"
import Button from "@mui/material/Button"
import Dialog from "@mui/material/Dialog"
import DialogActions from "@mui/material/DialogActions"
import DialogContent from "@mui/material/DialogContent"
import DialogTitle from "@mui/material/DialogTitle"
import AccountCircle from "@mui/icons-material/AccountCircle"
import InputAdornment from "@mui/material/InputAdornment"
import LockIcon from "@mui/icons-material/Lock"
import CloseIcon from "@mui/icons-material/Close"
import { ExpandMore, Visibility } from "@mui/icons-material"
import ReCAPTCHA from "react-google-recaptcha"
import { z } from "zod"
import { Formik } from "formik"
import { toFormikValidationSchema } from "zod-formik-adapter";

import Recaptcha, { useRecaptchaClosed } from "./components/Recaptcha"
import { useGlobalState } from "./state/global"
import {
    Box, Stack, Typography, useMediaQuery,
} from "@mui/material"
import { useCallback, useEffect, useRef, useState } from "react"
import { useTransitionNavigate } from "./hooks/useTransitionNavigate"
import CreatorLoginOTPModal from "./components/CreatorLoginOTPModal"
import TextField from "./components/common/TextField"
import DialogBackdrop from "./components/common/DialogBackdrop"


axios.interceptors.response.use(
    (res: any) => {
        return res
    },
    (error: { response: any }) => {
        return Promise.reject(error.response)
    }
)

const Schema = z.object({
    username: z.string().min(1).max(128),
    password: z.string().min(8),
})


export default function CreatorLoginModal() {
    const setSnackbarState = useGlobalState("snackbar")[1]
    const [loading, setLoading] = useGlobalState("loading")
    const [redirect, setRedirect] = useGlobalState("redirect")
    const [creator, setCreator] = useGlobalState("creator")
    const [loginModal, setLoginModal] = useGlobalState("loginModal")
    const [authStatus, setAuthStatus] = useGlobalState("authStatus")

    const isXS = useMediaQuery('(max-width:330px)');
    const isSmallHeight = useMediaQuery('(max-height:560px)');

    const navigate = useTransitionNavigate()
    const location = useLocation()

    const [_name, setName] = useState("")
    const [_password, setPassword] = useState("")
    const [passwordVisible, setPasswordVisible] = useState(false)

    const [needOTP, setNeedOTP] = useState(false)

    const recaptchaRef = useRef<ReCAPTCHA>()
    const [recaptchaLoaded, setRecaptchaLoaded] = useState(false);
    const [waitingForRecaptcha, setWaitingForRecaptcha] = useState(false);
    const [token, setToken] = useState(null as string | null | undefined);

    const asyncScriptOnLoad = useCallback(() => {
        setRecaptchaLoaded(true);
    }, []);

    useRecaptchaClosed(waitingForRecaptcha, () => {
        setLoading(false)
        setWaitingForRecaptcha(false)
    })

    const handleExit = () => {
        setLoginModal(false)
        setNeedOTP(false)
        if (location.pathname.includes('/subs')) {
            navigate(`${location.pathname.split('/subs')[0]}`)
        } else if (location.pathname.includes('/ppv')) {
            navigate(`${location.pathname.split('/ppv')[0]}`)
        }
        if (location.pathname === "/begin") {
            // console.log("RRRRRR", redirect)
            // setRedirect("")
            // Better to use the modal directly without /begin
            navigate("/")
        }
    }

    useEffect(() => {
        // This is a workaround in case the user is using a public computer
        if (creator.username === "") {
            setName("")
            setPassword("")
        }
    }, [creator.username])

    const handleSuccess = () => {
        setLoading(true)
        setLoginModal(false)
        setNeedOTP(false)
        axios
            .get("/api/auth/user/")
            .then((res) => {
                // console.log("get auth/user MODAL authstatus true")
                setLoading(false)
                setCreator(res.data)
                setAuthStatus(true)
                // Modal in some other page
                if (location.pathname !== "/begin") {
                    return
                }
                // Modal in /begin
                if (redirect) {
                    navigate(redirect)
                } else {
                    navigate("/profile")
                }
            })
            .catch((res) => {
                setLoading(false)
                // console.log("Modal authstatus false")
                setAuthStatus(false)
            })
    }

    const handleCreate = async (username: string, password: string, setFieldError?: (field: string, message: string | undefined) => void) => {
        setLoading(true)
        setWaitingForRecaptcha(true)
        const token = await recaptchaRef?.current?.executeAsync()
        setToken(token)
        const exst = "A user with that username already exists"
        const data = {
            username,
            password: password,
            captcha_result: token,
        }

        let resp;
        try {
            const startRes = await axios
                // Try to create a new account
                .post("/api/start/", data)
            if (!startRes) {
                return;
            }

            const res: { data: { key: string } } = await axios.post("/api/auth/login/", data)

            if (res) {
                handleSuccess()
            }
        } catch (error: any) {
            // recaptchaRef.current && recaptchaRef.current.reset()
            // setCaptchaResult(null)
            // console.log("catch then", resp)
            // console.log("CATCHRESP", resp);
            if (!error) {
                return
            }
            // console.log(resp.data.username);
            if (!error.data) {
                setSnackbarState({
                    message: JSON.stringify(error.data),
                    open: true,
                    severity: "error",
                    duration: null,
                })
                setLoading(false)
                throw "She's dead, jim"
            }
            resp = error;
        }
        try {
            // Try to login with existing account
            if (resp.data.username && resp.data.username[0].startsWith(exst)) {
                // console.log("EXISTS")
                const res = await axios.post("/api/auth/login/", data)

                if (res) {
                    handleSuccess();
                }
            } else {
                // Problem with username or password with new user
                setSnackbarState({
                    message: JSON.stringify(resp.data),
                    open: true,
                    severity: "error",
                    duration: null,
                })
                setLoading(false)
            }
        } catch (res: any) { // { data: { non_field_errors: any } }
            if (res.data.non_field_errors && res.data.non_field_errors[0] == "Invalid OTP token") {
                setName(username)
                setPassword(password)
                setNeedOTP(true)
                setLoading(false)
                return
            }

            recaptchaRef.current?.reset()
            setSnackbarState({
                message: JSON.stringify(res.data),
                open: true,
                severity: "error",
                duration: null,
            })
            setLoading(false)

            if (res.data.non_field_errors) {
                // console.log("non_field_errors")
                recaptchaRef.current?.reset()

                setSnackbarState({
                    open: true,
                    severity: "error",
                    duration: null,
                    message: JSON.stringify(
                        res.data.non_field_errors
                    ),
                })
                setLoading(false)
            }
        }
    }

    useEffect(() => {
        window.addEventListener('popstate', handlePopstate);
        // TODO?
        // Remove event listener on cleanup
        // return () => {
        //     console.log("UNSET")
        //     return window.removeEventListener('popstate', handlePopstate);
        // }
    }, []);

    const handlePopstate = () => {
        // Set global state variable to false when back button is pressed
        setLoginModal(false)
    };

    if (needOTP) {
        return <CreatorLoginOTPModal
            password={_password}
            username={_name}
            handleSuccess={handleSuccess}
            handleCancel={handleExit}
            captcha_result={token}
        />
    }

    return (
        <Dialog
            sx={{
                '& .MuiBackdrop-root': {
                    backdropFilter: 'blur(16px)',
                },
            }}
            open={loginModal}
            onClose={handleExit}
            slots={{ backdrop: DialogBackdrop }}
            fullScreen={isXS}
            fullWidth={true}
            maxWidth="sm"
        >
            {Boolean(isXS || isSmallHeight) && (
                <div style={{ position: 'absolute', top: '16px', right: '16px' }}>
                    <CloseIcon sx={{ fontSize: 40 }} onClick={handleExit} />
                </div>
            )}
            <Formik
                initialValues={{
                    username: '',
                    password: '',
                }}
                onSubmit={(values, actions) => {
                    handleCreate(values.username, values.password, actions.setFieldError);
                }}
                validationSchema={toFormikValidationSchema(Schema)}
            >
                {({ errors, touched, values, isValid, handleChange, handleBlur, handleSubmit }) => (
                    <form>
                        <DialogTitle color="primary">Begin</DialogTitle>
                        <DialogContent>
                            <Stack direction="column"
                                // take up the full vertical space with the three elements
                                justifyContent="center"
                                alignItems="space-between"
                                spacing={2}
                                style={{
                                    height: "100%",
                                }}
                            >
                                <Typography variant="caption">
                                    Create a new username and password or use an existing pair
                                </Typography>
                                <TextField
                                    autoFocus={true}
                                    margin="dense"
                                    color={Boolean(touched.username && touched.password && errors.username) ? "error" : "primary"}
                                    id="name"
                                    label="Username"
                                    type="text"
                                    error={Boolean(touched.username && touched.password && errors.username)}
                                    helperText={touched.username && touched.password && errors.username || 'This will be public'}
                                    fullWidth
                                    variant="standard"
                                    value={values.username}
                                    onChange={handleChange('username')}
                                    onBlur={handleBlur('username')}
                                    InputProps={{
                                        endAdornment: (
                                            <InputAdornment position="start">
                                                <AccountCircle color="primary" />
                                            </InputAdornment>
                                        ),
                                    }}
                                />
                                <TextField
                                    sx={{
                                        "&.MuiFormControl-root": {
                                            marginTop: '8px',
                                        }
                                    }}
                                    margin="dense"
                                    id="password"
                                    label="Password"
                                    type={!passwordVisible ? "password" : "text"}
                                    fullWidth
                                    variant="standard"
                                    color={Boolean(touched.password && errors.password) ? "error" : "primary"}
                                    value={values.password}
                                    error={Boolean(touched.password && errors.password)}
                                    helperText={touched.password && errors.password || 'Keep your password secure!'}
                                    onChange={handleChange('password')}
                                    onBlur={handleBlur('password')}
                                    InputProps={{
                                        endAdornment: (
                                            <InputAdornment position="start">
                                                {passwordVisible ? (
                                                    <LockIcon
                                                        sx={{ cursor: 'pointer' }}
                                                        onClick={() => {
                                                            setPasswordVisible(
                                                                !passwordVisible
                                                            )
                                                        }}
                                                        color="primary"
                                                    />
                                                ) : (
                                                    <Visibility
                                                        sx={{ cursor: 'pointer' }}
                                                        onClick={() => {
                                                            setPasswordVisible(
                                                                !passwordVisible
                                                            )
                                                        }}
                                                        color="warning"
                                                    />
                                                )}
                                            </InputAdornment>
                                        ),
                                    }}
                                />
                                <Box component="div">
                                    <Recaptcha
                                        // setCaptchaResult={setCaptchaResult}
                                        ref={recaptchaRef}
                                        asyncScriptOnLoad={asyncScriptOnLoad}
                                    />
                                </Box>
                            </Stack>
                            <Button
                                href="/begin/alt"
                                // textAlign="right"
                                sx={{
                                    textAlign: "center",
                                    // fontSize: "50%",
                                }}
                            >
                                <Typography variant="caption">More Login Options</Typography>
                                <ExpandMore fontSize="small" />
                            </Button>
                        </DialogContent>
                        <DialogActions
                            sx={{
                                mb: isXS ? 10 : 0,
                                p: '24px',
                                pt: '0px',
                            }}
                        >
                            <Button
                                color="primary"
                                onClick={(e) => {
                                    e.preventDefault();
                                    handleSubmit();
                                }}
                                variant="contained"
                                fullWidth
                                disabled={!isValid || !recaptchaLoaded}
                                type="submit"
                            >
                                Enter
                            </Button>
                        </DialogActions>
                    </form>
                )}
            </Formik>
        </Dialog>
    )
}
