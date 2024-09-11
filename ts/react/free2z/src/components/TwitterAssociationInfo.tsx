import { HelpOutline } from "@mui/icons-material";
import { Box, IconButton, Popover, Typography } from "@mui/material";
import { useState } from "react";

export default function TwitterAssociationInfo() {
    const [anchorEl, setAnchorEl] = useState<HTMLButtonElement | null>(null);
    const [open, setOpen] = useState(false)

    const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
        setAnchorEl(event.currentTarget);
        setOpen(true)
    };

    const handleClose = () => {
        setAnchorEl(null);
        setOpen(false)
    };
    const id = open ? 'simple-popover' : undefined;

    return (
        <>
            <IconButton
                aria-describedby={id}
                onClick={handleClick}
                size="small"
            >
                <HelpOutline
                    fontSize="small"
                />
            </IconButton>
            <Popover
                id={id}
                open={open}
                onClose={handleClose}
                anchorEl={anchorEl}
                anchorOrigin={{
                    vertical: 'bottom',
                    horizontal: 'center',
                }}
                transformOrigin={{
                    vertical: 'top',
                    horizontal: 'center',
                }}
            >
                <Box component="div"
                    sx={{
                        maxWidth: "300px",
                        padding: "1em",
                    }}
                >
                    <Typography>
                        If you want to associate an existing Free2Z
                        account to your Twitter account,
                        please log in to your Free2Z account first.
                    </Typography>
                </Box>
            </Popover>
        </>
    );
}
