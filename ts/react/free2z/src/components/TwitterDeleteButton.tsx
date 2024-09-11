import { Delete } from "@mui/icons-material";
import { IconButton } from "@mui/material";
import axios from "axios";
import { useGlobalState } from "../state/global";
import { useQuery } from "react-query";


export default function DeleteTwitterButton() {
    const [snackbar, setSnackbar] = useGlobalState("snackbar");

    const { data: passwordIsSetData, isLoading, error } = useQuery('passwordIsSet', () =>
        axios.get('/api/emails/password-is-set')
    );
    const passwordIsSet = passwordIsSetData?.data?.password_set;

    const handleClick = () => {
        console.log("Delete Twitter")
        axios.delete('/api/twitter/delete').then(res => {
            // setSnackbar({ open: true, message: "Twitter account deleted", severity: "success", duration: 6000 })
            // TODO: HRM. Rather gracefully update the UI to reflect the change.
            window.location.reload()
        }).catch(err => {
            setSnackbar({ open: true, message: "Error deleting Twitter account", severity: "error", duration: 6000 })
        })
    }
    return (
        <IconButton
            size="small"
            aria-label="delete"
            onClick={handleClick}
            disabled={!passwordIsSet}
        >
            <Delete />
        </IconButton>
    )
}
