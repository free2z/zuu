import * as React from 'react';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import Typography from '@mui/material/Typography';
import Box from '@mui/material/Box';
import { Account } from '../db/db';
import QRDisplay from './QRDisplay';

interface TabPanelProps {
    children?: React.ReactNode;
    index: number;
    value: number;
}

function TabPanel(props: TabPanelProps) {
    const { children, value, index, ...other } = props;

    return (
        <div
            role="tabpanel"
            hidden={value !== index}
            id={`simple-tabpanel-${index}`}
            aria-labelledby={`simple-tab-${index}`}
            {...other}
        >
            {value === index && (
                <Box sx={{ p: 3 }}>
                    {children}
                </Box>
            )}
        </div>
    );
}

function a11yProps(index: number) {
    return {
        id: `simple-tab-${index}`,
        'aria-controls': `simple-tabpanel-${index}`,
    };
}

interface AddressTabsProps {
    account: Account,
}

export default function AddressTabs(props: AddressTabsProps) {
    const { account } = props;
    const [value, setValue] = React.useState(0);

    const handleChange = (event: React.SyntheticEvent, newValue: number) => {
        setValue(newValue);
    };

    return (
        <Box
            sx={{ width: '100%' }}
        >
            <Box
                sx={{
                    borderBottom: 1,
                    borderColor: 'divider',
                    // textAlign: "center",
                    // margin: "0 auto",
                }}
            >
                <Tabs
                    centered
                    value={value}
                    onChange={handleChange}
                    aria-label="basic tabs example"
                    style={{
                        // margin: "0 auto",
                        // paddingLeft: "10em"
                        // width: "80%",
                    }}
                >
                    <Tab label="Z" {...a11yProps(0)} />
                    <Tab label="T" {...a11yProps(1)} />
                    <Tab label="U" {...a11yProps(2)} />
                </Tabs>
            </Box>
            <TabPanel value={value} index={0}>
                <QRDisplay addr={account.address} />

            </TabPanel>
            <TabPanel value={value} index={1}>
                <QRDisplay addr={account.taddress} />
            </TabPanel>
            <TabPanel value={value} index={2}>
                <Typography
                    style={{ textAlign: "center" }}
                >
                    Unified Addresses Coming Soon!
                </Typography>
            </TabPanel>
        </Box>
    );
}
