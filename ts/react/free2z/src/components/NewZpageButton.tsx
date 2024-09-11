import { Button } from "@mui/material"
import AddCircle from "@mui/icons-material/AddCircle"
import { useTransitionNavigate } from "../hooks/useTransitionNavigate"

interface Props {
    text?: boolean
    variant?: "text" | "outlined" | "contained" | undefined
}

function NewZpageButton(props: Props) {
    const navigate = useTransitionNavigate()

    const onClick = () => {
        navigate("/edit/new")
    }

    return (
        <>
            {/* hrm, we could show an error here? nah */}
            <Button
                variant={props.variant}
                color="success"
                onClick={onClick}
                // style={{ margin: "1em" }}
                endIcon={<AddCircle />}
            >
                {props.text && "New zPage"}
            </Button>
        </>
    )
}

export default NewZpageButton
