import { Helmet } from "react-helmet-async";
import { useEffect, useState } from "react"

import {
    Box,
    Chip,
    Divider,
    Grid,
    Tab,
    Tabs,
    Tooltip,
} from "@mui/material"

import Find from "./components/Find"
import HeroBanner from "./components/profile/HeroBanner"
import { useGlobalState } from "./state/global"
import MySubscriptions from "./components/MySubscriptions"
import MySubscribers from "./components/MySubscribers"
import MyAttributes from "./components/MyAttributes"
import {
    AccountTree, Diversity1, Diversity3, ManageAccounts,
} from "@mui/icons-material"
import { dispatch, useStoreState } from "./state/persist"
import { TabPanel } from "./components/TabPanel";
import MyLinkedAccounts from "./components/MyLinkedAccounts";
import { ProfileBody } from "./components/profile/ProfileLayout";

const tabStyle = {
    minWidth: 64,
};

export default function Profile() {
    const [creator, setCreator] = useGlobalState("creator")
    const profileTab = useStoreState('profileTab')
    const [mql, setMQL] = useState(window.matchMedia('(max-width: 600px)'))
    const [authStatus, setAuthStatus] = useGlobalState("authStatus")
    const [loginModal, setLoginModal] = useGlobalState("loginModal")

    const handleChange = (event: React.ChangeEvent<{}>, newValue: 0 | 1 | 2) => {
        // setProfileTab(newValue)
        dispatch({
            type: 'setProfileTab',
            profileTab: newValue,
        })
    }

    useEffect(() => {
        // console.log("Profile useEffect authstatus", authStatus)
        setLoginModal(authStatus === false);
    }, [authStatus]);

    if (!authStatus) {
        return null
    }
    return (
        <Box
            component="div"
            style={{
                marginTop: '3em',
                marginBottom: "3em",
            }}
        >
            <Helmet>
                <title>Edit {creator.username} Profile - Free2Z</title>
            </Helmet>
            <HeroBanner {...creator} />
            <ProfileBody>
                <Grid item xs={12}
                    justifyContent="center"
                    alignItems="center"
                >
                    <div style={{ display: 'flex', justifyContent: 'center' }}>
                        <Tabs
                            value={profileTab}
                            onChange={handleChange}
                            sx={{
                                justifyContent: "center",
                                margin: "0 auto",
                            }}
                        >
                            <Tab
                                // label="Profile"
                                icon={<Tooltip title="Edit Profile">
                                    <ManageAccounts color="primary" />
                                </Tooltip>}
                                style={mql.matches ? tabStyle : {}} />
                            <Tab
                                // label="Subscribers"
                                icon={<Tooltip title="Your Subscribers">
                                    <Diversity3 color="info" />
                                </Tooltip>}
                                style={mql.matches ? tabStyle : {}} />
                            <Tab
                                // label="Subscriptions"
                                icon={<Tooltip title="Who you subscribe to">
                                    <Diversity1 color="secondary" />
                                </Tooltip>}
                                style={mql.matches ? tabStyle : {}} />
                            <Tab
                                icon={<Tooltip title="Linked Accounts">
                                    <AccountTree />
                                </Tooltip>}
                                style={mql.matches ? tabStyle : {}} />
                        </Tabs>
                    </div>
                </Grid>
                <Grid item xs={12}
                    style={{
                        minHeight: "200px"
                    }}
                >
                    <TabPanel
                        value={profileTab}
                        index={0}
                    >
                        <MyAttributes />
                    </TabPanel>
                    <TabPanel
                        value={profileTab} index={1}
                    >
                        <MySubscribers />
                    </TabPanel>
                    <TabPanel value={profileTab} index={2}>
                        <MySubscriptions />
                    </TabPanel>
                    <TabPanel value={profileTab} index={3}>
                        <MyLinkedAccounts />
                    </TabPanel>
                </Grid >
            </ProfileBody>

            {
                creator.zpages > 0 &&
                <>
                    <Grid item xs={12}>
                        <Divider style={{ margin: "1em" }}>
                            <Chip label="Your zPages" color="secondary" />
                        </Divider>
                    </Grid>
                    <ProfileBody>
                        <Find mine={true} />
                    </ProfileBody>
                </>
            }
        </Box>
    )
}
