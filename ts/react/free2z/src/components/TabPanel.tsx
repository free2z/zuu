import { Box } from "@mui/material";

export interface TabPanelProps {
    p?: number;
    children?: React.ReactNode;
    index: number;
    value: number;
}

export const TabPanel: React.FC<TabPanelProps> = ({ children, value, index, p }) => {
    return (
        <div role="tabpanel" hidden={value !== index}>
            {value === index && (
                <Box component="div" p={p}>
                    {children}
                </Box>
            )}
        </div>
    );
};