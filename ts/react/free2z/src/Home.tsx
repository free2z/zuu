import { Box, Grid, MenuItem, Select, Stack, Typography } from "@mui/material"
import CreatorCarousel from "./components/CreatorCarousel"
import Footer from "./components/Footer"
import ZPageCarousel from "./components/zPageCarousel"
import { useStoreState, dispatch } from "./state/persist"
import { Helmet } from "react-helmet-async"
// import FeatureSection from "./components/FeatureSection"

// import {
//     A2Z_HEADLINES, A2Z_TEXTS, A2Z_URLS,
// } from "./HomeConstants"


export default function Home() {

    const homeCreatorSort = useStoreState('homeCreatorSort')
    const homePageSort = useStoreState('homePageSort')

    return (
        <>
            <Helmet>
                <title>Free2Z</title>
                <link
                    rel="alternate"
                    type="application/rss+xml"
                    title="zPages Feed"
                    href="/feeds/zpages/recent.xml"
                />
                <link
                    rel="alternate"
                    type="application/rss+xml"
                    title="Converse Feed"
                    href="/feeds/converse/recent.xml"
                />
                <link
                    rel="alternate"
                    type="application/rss+xml"
                    title="Public AI Feed"
                    href="/feeds/ai/recent.xml"
                />
                <link
                    rel="alternate"
                    type="application/rss+xml"
                    title="Podcasts Feed"
                    href="/feeds/podcasts/recent.xml"
                />
            </Helmet>

            <Grid
                container
                spacing={0}
                direction="row"
                alignItems="center"
                textAlign="center"
                justifyContent="center"
                marginTop="3.5em"
            >
                {/* <FeatureSection
                    headlines={A2Z_HEADLINES}
                    texts={A2Z_TEXTS}
                    imageUrls={A2Z_URLS}
                /> */}
                <Grid item container xs={12}
                    style={{ minHeight: "350px" }}
                >
                    <Stack
                        direction="row"
                        style={{
                            width: "100%",
                            margin: "1em 0em",
                        }}
                        alignItems="center"
                        justifyContent="center"
                        spacing={2}
                    >

                        <Box
                            component="div"
                            style={{
                                flex: 1,
                                display: 'flex',
                                justifyContent: 'flex-end',
                                textAlign: "right",
                                // padding: "1em",
                            }}
                        >
                            <Typography
                                variant="h6"
                            >Creators
                            </Typography>
                        </Box>
                        <Box
                            component='div'
                            style={{ flex: 1, display: 'flex', justifyContent: 'flex-start' }}
                        >
                            <Select
                                value={homeCreatorSort}
                                onChange={(event) => {
                                    dispatch({
                                        type: 'setHomeCreatorSort',
                                        sort: event.target.value as "score" | "updated" | "random",
                                    })
                                }}
                                size="small"
                                style={{
                                    minWidth: "120px",
                                }}
                            >
                                <MenuItem value="score">Boosted</MenuItem>
                                <MenuItem value="updated">Recent</MenuItem>
                                <MenuItem value="random">Random</MenuItem>
                            </Select>
                        </Box>
                    </Stack>
                    <CreatorCarousel sort={homeCreatorSort} />
                </Grid>
                {/* <FeatureSection
                    headlines={A2Z_HEADLINES}
                    texts={A2Z_TEXTS}
                    imageUrls={A2Z_URLS}
                    imageOnLeft={true}
                /> */}
                <Grid item container xs={12}
                    // alignItems="center"
                    // textAlign="center"
                    // justifyContent="center"
                    style={{
                        minHeight: "350px",
                    }}
                >
                    <Stack
                        direction="row"
                        style={{
                            width: "100%",
                            margin: "1em 0em"
                        }}
                        alignItems="center"
                        textAlign="center"
                        justifyContent="center"
                        spacing={2}
                    >
                        <Box
                            component="div"
                            style={{
                                flex: 1,
                                display: 'flex',
                                justifyContent: 'flex-end',
                                textAlign: "right",
                                // padding: "1em",
                            }}
                        >
                            <Typography variant="h6">zPages</Typography>
                        </Box>
                        <Box
                            component='div'
                            style={{ flex: 1, display: 'flex', justifyContent: 'flex-start' }}
                        >
                            <Select
                                value={homePageSort}
                                onChange={(event) => {
                                    dispatch({
                                        type: 'setHomePageSort',
                                        sort: event.target.value as "score" | "updated" | "random",
                                    })
                                }}
                                size="small"
                                style={{
                                    minWidth: "120px",
                                    // margin: "1em",
                                    // width: "50%"
                                }}
                            >
                                <MenuItem value="score">Boosted</MenuItem>
                                <MenuItem value="updated">Recent</MenuItem>
                                <MenuItem value="random">Random</MenuItem>
                            </Select>
                        </Box>
                    </Stack>
                    <ZPageCarousel sort={homePageSort} />
                </Grid>

                {/* <FeatureSection
                    headline="Free2Z is P2P"
                    text={P2P_TEXT}
                    imageUrl={P2P_URL}
                />
                <FeatureSection
                    headline="Free2Z is Z2Z"
                    text={Z2Z_TEXT}
                    imageUrl={Z2Z_URL}
                    imageOnLeft={true}
                />
                <FeatureSection
                    headline="Free2Z is V4V"
                    text={V4V_TEXT}
                    imageUrl={V4V_URL}
                />
                <FeatureSection
                    headline="Free2Z is C2C"
                    text={C2C_TEXT}
                    imageUrl={C2C_URL}
                    imageOnLeft={true}
                />
                <FeatureSection
                    headline="Free2Z is B2C"
                    text={B2C_TEXT}
                    imageUrl={B2C_URL}
                />
                <FeatureSection
                    headline="Free2Z is B2B"
                    text={B2B_TEXT}
                    imageUrl={B2B_URL}
                    imageOnLeft={true}
                /> */}
                <Grid item xs={12}>
                    <Footer />
                </Grid>
            </Grid >
        </>
    )
}
