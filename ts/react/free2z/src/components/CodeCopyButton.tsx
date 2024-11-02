import { Check, ContentCopy } from "@mui/icons-material";
import { IconButton, Theme } from "@mui/material";
import { useState, useEffect } from "react";

type CodeCopyProps = {
    code: string
}

export default function CodeCopyButton(props: CodeCopyProps) {
    const { code } = props
    const [copySuccess, setCopySuccess] = useState(false);

    const handleCopyClick = () => {
        navigator.clipboard.writeText(code);
        setCopySuccess(true);
    }

    useEffect(() => {
        if (copySuccess) {
            const timeout = setTimeout(() => {
                setCopySuccess(false);
            }, 5000);

            return () => {
                clearTimeout(timeout);
            };
        }
    }, [copySuccess]);

    return (
        <IconButton
            size="small"
            color="primary"
            onClick={handleCopyClick}
            sx={{
                position: 'absolute',
                top: '10px',
                right: '10px',
                zIndex: (theme: Theme) => theme.zIndex.mobileStepper - 1,
                borderColor: copySuccess ? 'success.main' : undefined,
                color: copySuccess ? 'success.main' : undefined,
            }}
        >
            {copySuccess ?
                <Check fontSize="small" style={{
                    color: '#00ff04'
                }} />
                :
                <ContentCopy fontSize="small" style={{
                    color: 'whitesmoke'
                }}/>
            }
        </IconButton>
    )
}