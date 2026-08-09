import { Stack, Typography, useTheme } from "@mui/material";
import { getURI } from "../Constants";
import SimpleZcashAddress from "./SimpleZcashAddress";
import { SimpleCreator } from "./MySubscribers";
import { useState } from "react";
import { TabPanel } from "./TabPanel";
import { truncateZcashAddress } from "../utils/zcashAddress";


type DonateZcashPanelProps = {
    value: number,
    creator: SimpleCreator,
    addr?: string,
    // handleChangeIndex: (index: number) => void,
}


export default function DonateZcashPanel(props: DonateZcashPanelProps) {
    const { value, creator, addr } = props;
    const [zamount, ___] = useState(0.5)
    const [zemo, __] = useState("")
    const theme = useTheme()
    const isDarkMode = theme.palette.mode === "dark"

    // TODO: support memo and amount in UI?

    return (
        <TabPanel value={value} index={1}>
            <Stack
                direction="column" spacing={1}
                alignItems="center"
            >
                <Typography
                    variant="caption"
                    title={creator.p2paddr}
                    sx={{ overflowWrap: "anywhere", wordBreak: "break-all" }}
                >
                    {truncateZcashAddress(creator.p2paddr)}
                </Typography>
                {!!(addr || creator.p2paddr) &&
                    <SimpleZcashAddress
                        addr={getURI(
                            addr || creator.p2paddr,
                            zamount.toFixed(3),
                            zemo,
                        )}
                        // addr={`zcash:${props.p2paddr}`}
                        size={175}
                        bgColor={isDarkMode ? theme.palette.primary.light : theme.palette.success.main}
                        fgColor={isDarkMode ? "#121212" : "white"}
                    />
                }
                {!(addr || creator.p2paddr) &&
                    <Typography>
                        Creator has not configured a peer-to-peer address!
                    </Typography>
                }
            </Stack>
        </TabPanel>
    )
}