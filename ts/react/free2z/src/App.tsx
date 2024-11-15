import * as React from "react"
import { Routes, Route } from "react-router-dom"

import CssBaseline from "@mui/material/CssBaseline"
import {
    ThemeProvider, styled,
} from "@mui/material"

import axios from "axios"
import Cookies from "js-cookie"
import { MaterialDesignContent, SnackbarProvider } from "notistack"

import { useStoreState } from "./state/persist"
import GlobalCreator from "./state/GlobalCreator"

import getTheme from "./Theme"
import LoadingBackdrop from "./components/LoadingBackdrop"
import SimpleSnackbar from "./components/SimpleSnackbar"
import { QueryClient, QueryClientProvider } from 'react-query'
import CreatorSnackSocket from "./components/CreatorSnackSocket"
import { WebSocketProvider } from "./hooks/useWebSocket"
import Converse from "./components/Converse"
import EventFeed from "./components/EventFeed"
import SimpleNav from "./components/SimpleNav"
import CreatorLoginModal from "./CreatorLoginModal"
import { Helmet, HelmetProvider } from "react-helmet-async"

const FABNewConverse = React.lazy(() => import('./components/FABNewConverse'))
const Home = React.lazy(() => import('./Home'))
const NormalPage = React.lazy(() => import('./components/NormalPage'))
const EditPage = React.lazy(() => import('./EditPage'));
const Begin = React.lazy(() => import('./Begin'));
const BeginAlt = React.lazy(() => import('./BeginAlt'));
const PageDetail = React.lazy(() => import('./PageDetail'));
const Profile = React.lazy(() => import('./Profile'));
const FindPage = React.lazy(() => import('./components/FindPage'));
const RootSplitter = React.lazy(() => import('./RootSplitter'));
const Global404 = React.lazy(() => import('./Global404'));
const ProfileUploads = React.lazy(() => import('./ProfileUploads'));
const StoryTime = React.lazy(() => import('./StoryTime'));
const StoryTimeEdit = React.lazy(() => import('./components/StoryTimeEdit'));
const StoryTimeDisplay = React.lazy(() => import('./components/StoryTimeDisplay'));
// const VideoPlayerTest = React.lazy(() => import('./components/VideoPlayerTest'));
const CreatorLive = React.lazy(() => import('./CreatorLive'));
const CreatorLivePrivate = React.lazy(() => import('./CreatorLivePrivate'));
const AI2 = React.lazy(() => import('./AI2'))
const AIShare = React.lazy(() => import('./AIShare'))
const ConverseList = React.lazy(() => import('./ConverseList'))
const AIList = React.lazy(() => import('./AIList'))
const AudioMicrophoneVisualizer = React.lazy(() => import('./components/AudioMicrophoneVisualizer'))
const ResetPassword = React.lazy(() => import('./components/ResetPassword'))
const KYCPage = React.lazy(() => import('./components/KYCPage'))
// const DKGSetup = React.lazy(() => import('./components/DKGSetup'))
const EFMStart = React.lazy(() => import('./components/EFMStart'))
const EFMMainSession = React.lazy(() => import('./components/EFMMainSession'))
// const EFMSession = React.lazy(() => import('./components/EFMSession'))


axios.defaults.withCredentials = true;
axios.interceptors.request.use((config) => {
    const csrf = Cookies.get('csrftoken');
    if (csrf && config && config.headers) {
        config.headers['X-CSRFToken'] = csrf;
    }
    return config;
});

const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            refetchOnWindowFocus: false,
        },
    },
});

const StyledMaterialDesignContent = styled(MaterialDesignContent)(({ theme }) => ({
    color: theme.palette.mode === 'dark' ? 'black' : 'white',
    '&.notistack-MuiContent-success': {
        backgroundColor: theme.palette.success.main,
    },
    '&.notistack-MuiContent-error': {
        backgroundColor: theme.palette.error.main,
    },
    '&.notistack-MuiContent-warning': {
        backgroundColor: theme.palette.warning.main,
    },
    '&.notistack-MuiContent-info': {
        backgroundColor: theme.palette.info.main,
    },
    '&.notistack-MuiContent-default': {
        backgroundColor: theme.palette.primary.main,
    },
}));

function App() {
    const darkMode = useStoreState("darkmode")

    const theme = React.useMemo(() => {
        return getTheme(darkMode)
    }, [darkMode])

    // TODO:
    // https://mui.com/material-ui/customization/typography/#responsive-font-sizes
    // more work on typography is needed
    theme.typography.h3 = {
        fontSize: '2.0rem',
        [theme.breakpoints.up('sm')]: {
            fontSize: '2.2rem',
        },
        [theme.breakpoints.up('md')]: {
            fontSize: '2.4rem',
        },
        [theme.breakpoints.up('lg')]: {
            fontSize: '2.6rem',
        },
        [theme.breakpoints.up('xl')]: {
            fontSize: '2.8rem',
        },
    };

    let wsProtocol = window.location.protocol === 'https:' ? 'wss' : 'ws';

    let wsUrl
    if (wsProtocol === 'wss') {
        wsUrl = `${wsProtocol}://${window.location.host}/ws/profile`;
    } else {
        wsUrl = `${wsProtocol}://127.0.0.1:8000/ws/profile`;
    }

    return (
        <React.Suspense fallback={<LoadingBackdrop />}>
            <QueryClientProvider client={queryClient}>
                <WebSocketProvider wsUrl={wsUrl}>
                    <ThemeProvider theme={theme}>
                        <SnackbarProvider
                            maxSnack={3}
                            Components={{
                                success: StyledMaterialDesignContent,
                                error: StyledMaterialDesignContent,
                                warning: StyledMaterialDesignContent,
                                info: StyledMaterialDesignContent,
                                default: StyledMaterialDesignContent,
                            }}
                        >
                            <HelmetProvider>
                                <Helmet>
                                    <title>Free2Z</title>
                                    {/* <meta name="description" content="Free2Z. Support Creators. Build Community. Use Tools. Monetize" /> */}
                                    {/* <meta name="keywords" content="Free2Z */}
                                </Helmet>
                                <CreatorSnackSocket />
                                <GlobalCreator />
                                <CssBaseline />
                                <CreatorLoginModal />
                                <LoadingBackdrop />
                                <Routes>
                                    <Route path="/tools/p2pe2e" element={
                                        <React.Suspense fallback={<LoadingBackdrop />}>
                                            <EFMStart />
                                        </React.Suspense>
                                    } />
                                    <Route path="/tools/p2pe2e/:UUID" element={
                                        <React.Suspense fallback={<LoadingBackdrop />}>
                                            <EFMMainSession />
                                        </React.Suspense>
                                    } />
                                    <Route path="/reset-password"
                                        element={
                                            <React.Suspense fallback={<LoadingBackdrop />}>
                                                <ResetPassword />
                                            </React.Suspense>
                                        }
                                    />
                                    <Route path="/events"
                                        element={
                                            <>
                                                <SimpleNav />
                                                <React.Suspense fallback={<LoadingBackdrop />}>
                                                    <NormalPage>
                                                        <EventFeed />
                                                    </NormalPage>
                                                </React.Suspense>
                                            </>
                                        }
                                    />
                                    <Route path="/converse"
                                        element={
                                            <>
                                                <SimpleNav />
                                                <React.Suspense fallback={<LoadingBackdrop />}>
                                                    <NormalPage>
                                                        <>
                                                            <ConverseList />
                                                            <FABNewConverse />
                                                        </>
                                                    </NormalPage>
                                                </React.Suspense>
                                            </>
                                        }
                                    />
                                    <Route path="/converse/:commentUUID"
                                        element={
                                            <>
                                                <SimpleNav />
                                                <React.Suspense fallback={<LoadingBackdrop />}>
                                                    <NormalPage>
                                                        <>
                                                            <Converse />
                                                            <FABNewConverse />
                                                        </>
                                                    </NormalPage>
                                                </React.Suspense>
                                            </>
                                        }
                                    />
                                    <Route path="/ai/public"
                                        element={
                                            <>
                                                <SimpleNav />
                                                <React.Suspense fallback={<LoadingBackdrop />}>
                                                    <NormalPage>
                                                        <AIList />
                                                    </NormalPage>
                                                </React.Suspense>
                                            </>
                                        }
                                    />
                                    <Route path="/ai/conversation/:conversationId"
                                        element={
                                            <>
                                                <SimpleNav />
                                                <React.Suspense fallback={<LoadingBackdrop />}>
                                                    <NormalPage>
                                                        <AIShare />
                                                    </NormalPage>
                                                </React.Suspense>
                                            </>
                                        }
                                    />
                                    <Route path="/ai"
                                        element={
                                            <React.Suspense fallback={<LoadingBackdrop />}>
                                                <AI2 />
                                            </React.Suspense>
                                        }
                                    />
                                    <Route
                                        path="/ai/:conversationId"
                                        element={
                                            <React.Suspense fallback={<LoadingBackdrop />}>
                                                <AI2 />
                                            </React.Suspense>
                                        }
                                    />
                                    <Route path="/micvizz"
                                        element={
                                            <AudioMicrophoneVisualizer />
                                        }
                                    />
                                    <Route path="/storytime"
                                        element={
                                            <>
                                                <SimpleNav />
                                                <NormalPage>
                                                    <React.Suspense fallback={<LoadingBackdrop />}>
                                                        <StoryTime />
                                                    </React.Suspense>
                                                </NormalPage>
                                            </>
                                        }
                                    />
                                    <Route path="/storytime/:creator/:slug"
                                        element={
                                            <>
                                                <SimpleNav />
                                                <NormalPage>
                                                    <React.Suspense fallback={<LoadingBackdrop />}>
                                                        <StoryTimeDisplay />
                                                    </React.Suspense>
                                                </NormalPage>
                                            </>
                                        }
                                    />
                                    <Route path="/storytime/edit/:creator/:slug"
                                        element={
                                            <>
                                                <SimpleNav />
                                                <NormalPage>
                                                    <React.Suspense fallback={<LoadingBackdrop />}>
                                                        <StoryTimeEdit />
                                                    </React.Suspense>
                                                </NormalPage>
                                            </>
                                        }
                                    />
                                    <Route path="/secretbackdrop"
                                        element={
                                            <LoadingBackdrop />
                                        }
                                    />
                                    <Route
                                        path="/"
                                        element={
                                            <>
                                                <SimpleNav />
                                                <React.Suspense fallback={<LoadingBackdrop />}>
                                                    <Home />
                                                </React.Suspense>
                                            </>
                                        }
                                    />
                                    <Route
                                        path="/find"
                                        element={
                                            <>
                                                <SimpleNav />
                                                <React.Suspense fallback={<></>}>
                                                    <FindPage />
                                                </React.Suspense>
                                            </>
                                        }
                                    />
                                    <Route
                                        path="/profile"
                                        element={
                                            <>
                                                <SimpleNav />
                                                <React.Suspense fallback={<></>}>
                                                    <Profile />
                                                </React.Suspense>
                                            </>
                                        }
                                    />
                                    <Route
                                        path="/profile/kyc"
                                        element={
                                            <>
                                                <SimpleNav />
                                                <NormalPage>
                                                    <KYCPage />
                                                </NormalPage>
                                            </>
                                        }
                                    />
                                    <Route
                                        path="/profile/uploads"
                                        element={
                                            <>
                                                <SimpleNav />
                                                <NormalPage>
                                                    <ProfileUploads />
                                                </NormalPage>
                                            </>
                                        }
                                    />
                                    <Route path="/begin/alt" element={
                                        <BeginAlt />
                                    }
                                    />
                                    <Route path="/begin" element={
                                        <Begin />
                                    }
                                    />
                                    <Route
                                        path="/edit/:id"
                                        element={
                                            <>
                                                <SimpleNav />
                                                <NormalPage>
                                                    <EditPage />
                                                </NormalPage>
                                            </>
                                        }
                                    />
                                    <Route
                                        path="/:username/zpage/:id"
                                        element={
                                            <>
                                                <SimpleNav />
                                                <NormalPage>
                                                    <RootSplitter />
                                                </NormalPage>
                                            </>
                                        }
                                    />
                                    <Route
                                        path="/:id/:type"
                                        element={
                                            <CreatorLive />
                                        }
                                    />
                                    <Route
                                        path="/:owner/private/:uuid"
                                        element={
                                            <CreatorLivePrivate />
                                        }
                                    />
                                    <Route
                                        path="/:id"
                                        element={
                                            <>
                                                <SimpleNav />
                                                <React.Suspense fallback={<></>}>
                                                    <RootSplitter />
                                                </React.Suspense>
                                            </>
                                        }
                                    />

                                    {/* https://www.makeuseof.com/react-router-404-page-create */}
                                    <Route
                                        path='*'
                                        element={
                                            <>
                                                <SimpleNav />
                                                <NormalPage>
                                                    <Global404 />
                                                </NormalPage>
                                            </>
                                        }
                                    />
                                </Routes>
                                <SimpleSnackbar />
                            </HelmetProvider>
                        </SnackbarProvider>
                    </ThemeProvider>
                </WebSocketProvider>
            </QueryClientProvider>
        </React.Suspense >
    )
}
export default App
