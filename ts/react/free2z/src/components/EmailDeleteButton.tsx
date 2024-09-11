import { Delete } from "@mui/icons-material";
import { IconButton } from "@mui/material";
import axios from "axios";
import { useGlobalState } from "../state/global";


interface EmailDeleteButtonProps {
    onEmailStatusUpdate: () => void;
}

export default function EmailDeleteButton(props: EmailDeleteButtonProps) {
    const { onEmailStatusUpdate } = props;
    const [snackbar, setSnackbar] = useGlobalState("snackbar");

    const handleDelete = () => {
        axios.delete('/api/emails/delete').then(res => {
            onEmailStatusUpdate();
            setSnackbar({ open: true, message: "Email deleted successfully", severity: "success", duration: 6000 });
        }).catch(err => {
            setSnackbar({ open: true, message: "Error deleting email", severity: "error", duration: 6000 });
        })
    };

    return (
        <IconButton
            size="small"
            aria-label="delete"
            onClick={handleDelete}
        >
            <Delete />
        </IconButton>
    )
}