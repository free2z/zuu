import { Button } from "@mui/material";
import axios from "axios";
import { useState } from "react";


export default function TwitterOAuthButton() {
    const [loading, setLoading] = useState(false);

    const handleClick = () => {
        setLoading(true)
        axios.post('/api/twitter/v1/request-token', {}).then((res) => {
            window.location.href = `https://api.twitter.com/oauth/authenticate?oauth_token=${res.data}`
        }).catch((res) => {
            console.error(res)
            setLoading(false)
        })
    };

    return (
        <Button
            variant="contained"
            color="primary"
            onClick={handleClick}
            disabled={loading}
        >
            Login with Twitter
        </Button>
    );
};
