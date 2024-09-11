import { useState } from 'react';
import { Button, TextField, InputAdornment, Stack, useMediaQuery } from '@mui/material';
import { PageInterface } from './PageRenderer';
import axios from 'axios';
import { useGlobalState } from '../state/global';
import { getRando, SUCCESS_MESSAGES } from './RandomSuccess';
import TuziIcon from './TuziIcon';
import TuzisMenuItem from './TuzisMenuItem';
import TuzisButton from './TuzisButton';
import PageScore from './PageScore';

interface BoostFormProps {
    page: PageInterface;
    setPage: React.Dispatch<React.SetStateAction<PageInterface>>;
    onClose: () => void;
}

const BoostForm: React.FC<BoostFormProps> = ({ page, setPage, onClose }) => {
    const setSnackbarState = useGlobalState("snackbar")[1]
    const [creator, setCreator] = useGlobalState("creator")
    const [loading, setLoading] = useGlobalState("loading")
    const [loginModal, setLoginModal] = useGlobalState("loginModal")

    // const [value, setValue] = React.useState(0)
    const [num2z, setNum2z] = useState(1 as number | null)
    const [error, setError] = useState(false)
    const isXS = useMediaQuery('(max-width:399px)')

    const refreshCreator = () => {
        setLoading(true)
        axios
            .get("/api/auth/user/")
            .then((res) => {
                // console.log("GET auth/user Edit fund page refresh creator")
                setCreator(res.data)
                setLoading(false)
            })
            .catch((res) => {
                setLoading(false)
                setLoginModal(true)
            })
    }

    const handleFund = () => {
        setLoading(true)

        axios.post("/api/zpage/fund/", {
            id: page.free2zaddr,
            amount: num2z,
        }).then((res) => {
            // console.log("SUCCESS")
            setSnackbarState({
                message: getRando(SUCCESS_MESSAGES),
                open: true,
                severity: "success",
                duration: null,
            })
            refreshCreator()
            setPage({
                ...page,
                f2z_score: res.data,
            })
            setLoading(false)
        }).catch((res) => {
            // console.log("FUX", res)
            setSnackbarState({
                message: JSON.stringify(res.data),
                open: true,
                severity: "error",
                duration: null,
            })
            setLoading(false)
        })
    }

    const handleInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        const tuzisInput = event.target.value;

        if (tuzisInput === "") {
            setError(true);
            setNum2z(null);  // Set num2z to null when the field is empty
            return;
        }

        const tuzis = Number(tuzisInput);
        if (isNaN(tuzis) || tuzis < 1 || tuzis > Number(creator.tuzis)) {
            setError(true);
        } else {
            setError(false);
            setNum2z(tuzis);
        }
    }

    return (
        <Stack
            direction="column"
            alignItems="center"
            justifyContent="center"
            spacing={3}
        >
            <TuzisButton {...creator} />
            <TextField
                // value={num2z}
                value={num2z !== null ? num2z : ''}
                size="small"
                onChange={handleInputChange}
                type="text"
                // helperText={error ? "Invalid amount" : "Number 2Zs"}
                InputProps={{
                    endAdornment: (
                        <InputAdornment position="start">
                            <TuziIcon />
                        </InputAdornment>
                    ),
                }}
                style={{
                    maxWidth: "150px",
                }}
            />
            <Button
                type="submit"
                variant="contained"
                sx={{ mt: 1, mb: 1 }}
                onClick={handleFund}
            >
                Boost Page
            </Button>
            <PageScore page={page} />
        </Stack>
    );
};

export default BoostForm;
