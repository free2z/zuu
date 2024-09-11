import { AddComment } from "@mui/icons-material";
import { Tooltip } from "@mui/material";

export default function ScrolltoComments() {
    // TODO: this has to be better, like with a ref or something
    // the scroll doesn't work anymore until the page is loaded.

    // console.log("rendering ScrolltoComments")
    return (
        <Tooltip title="Make Comment" placement="left">
            <AddComment
                onClick={() => {
                    const element = document.getElementById("make-comment")
                    if (element) {
                        element.scrollIntoView({ behavior: 'smooth' })
                    }
                }}
                color="success"
            />
        </Tooltip>
    )
}
