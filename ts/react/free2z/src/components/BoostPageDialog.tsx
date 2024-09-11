import React, { useState } from 'react';
import { Dialog, Tabs, Tab, DialogTitle, DialogContent, DialogActions, Button, useMediaQuery } from '@mui/material';
import { PageInterface } from './PageRenderer';
import BoostForm from './BoostForm'; // Component for handling the POST boost
import QRAddress from './QRAddress';
import { getURI, current_f2z_address } from '../Constants';
import TuziIcon from './TuziIcon';
import ZcashIcon from './ZcashIcon';
import { TabPanel } from './TabPanel';

interface BoostPageDialogProps {
    page: PageInterface;
    setPage: React.Dispatch<React.SetStateAction<PageInterface>>;
    open: boolean;
    onClose: () => void;
}

const BoostPageDialog: React.FC<BoostPageDialogProps> = ({ page, setPage, open, onClose }) => {
    const [tabIndex, setTabIndex] = useState(0);
    const isXS = useMediaQuery('(max-width: 399px)')

    const handleChangeTab = (event: React.SyntheticEvent, newValue: number) => {
        setTabIndex(newValue);
    };

    return (
        <Dialog
            open={open} onClose={onClose} maxWidth="xs" fullWidth
            fullScreen={isXS}
        >
            <DialogTitle>Boost page with 2Zs or Zcash!</DialogTitle>

            <DialogContent
                style={{
                    minHeight: 395,
                }}
            >
                <Tabs value={tabIndex} onChange={handleChangeTab} centered>
                    <Tab
                        label={<TuziIcon />}
                    />
                    <Tab label={<ZcashIcon />} />
                </Tabs>

                <TabPanel value={tabIndex} index={0} p={3}>
                    <BoostForm
                        page={page}
                        setPage={setPage}
                        onClose={onClose}
                    />
                </TabPanel>

                <TabPanel value={tabIndex} index={1} p={3}>
                    <QRAddress
                        showHelp={false}
                        // docs="/docs/creators/creating-a-zpage#boosting-your-zpage"
                        addr={getURI(
                            current_f2z_address,
                            "0.001",
                            JSON.stringify({
                                act: "page_fund",
                                id: page.free2zaddr,
                            })
                        )}
                        size={200}

                    />
                </TabPanel>
            </DialogContent>
            <DialogActions>
                <Button onClick={onClose}>Close</Button>
            </DialogActions>
        </Dialog>
    );
};

export default BoostPageDialog;
