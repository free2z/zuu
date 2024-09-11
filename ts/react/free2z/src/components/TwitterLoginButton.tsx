import axios from 'axios';
import { Twitter } from "@mui/icons-material";
import { IconButton } from "@mui/material";
import { useGlobalState } from '../state/global';


const TWITTER_CLIENT_ID = "NDc4WlVCM0ZwRjljYU02bXpkcXA6MTpjaQ"
let CALLBACK_URL = `${window.location.protocol}//${window.location.host}/api/twitter/callback`
// console.log(window.location.protocol)
// if localhost in window.location.host
// if (window.location.protocol === "http:") {
if (window.location.host.includes("localhost")) {
    CALLBACK_URL = "http://127.0.0.1:8000/api/twitter/callback"
}


export default function TwitterLoginButton() {
    const [snackbar, setSnackBar] = useGlobalState("snackbar")

    function handleClick() {
        axios.get('/api/twitter/start')
            .then(response => {
                const state = response.data.state
                const code_challenge = response.data.code_challenge

                // Construct the authorize URL
                // https://developer.twitter.com/en/docs/authentication/oauth-2-0/authorization-code
                const authorizeUrl = `https://twitter.com/i/oauth2/authorize?response_type=code&client_id=${TWITTER_CLIENT_ID}&redirect_uri=${CALLBACK_URL}&scope=users.read%20follows.read%20tweet.read&state=${state}&code_challenge=${code_challenge}&code_challenge_method=plain&intent=authenticate`;
                // Redirect the user to the authorize URL
                window.location.href = authorizeUrl;
                // console.log(authorizeUrl)
            })
            .catch(error => {
                setSnackBar({
                    message: error.data,
                    open: true,
                    duration: undefined,
                    severity: "error",
                })
            });
    }

    return (
        <IconButton
            color="primary"
            onClick={handleClick}
            size="small"
        >
            <Twitter
                fontSize='small'
            />
        </IconButton>
    );
};
