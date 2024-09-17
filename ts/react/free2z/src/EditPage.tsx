import { Helmet } from "react-helmet-async";
import { useEffect, useState } from "react"
import {
    Button,
    Checkbox,
    Chip,
    Divider,
    FormControl,
    FormControlLabel,
    Grid,
    InputAdornment,
    Link,
    Stack,
    TextField,
} from "@mui/material"
import { useLocation, useParams } from "react-router-dom"

import axios, { AxiosResponse } from "axios"
import {
    Fingerprint,
    Launch,
    Psychology,
    QrCode2,
    Save,
} from "@mui/icons-material"
import slugify from "slugify"

import RedirectUnauthed from "./components/RedirectUnauthed"

import { PageInterface } from "./components/PageRenderer"
import MarkdownEditor from "./components/MarkdownEditor"
import { defaultCreator, useGlobalState } from "./state/global"
import TagFilterMultiSelect, { Tag } from "./components/TagFilterMultiSelect"
import UploadOrSelect from "./components/UploadOrSelect"
import { FileMetadata } from "./components/DragDropFiles"
import F2ZDateTimePicker from "./components/DateTimePicker"
import moment from "moment"
import { useTransitionNavigate } from "./hooks/useTransitionNavigate"
import EditSelectSeries from "./components/EditSelectSeries"
import { PublicCreator } from "./CreatorDetail";
import BoostPageButton from "./components/BoostPageButton";

export const saplingRE = /^zs[a-z0-9]{76}$/g

export default function EditPage() {
    const { id } = useParams()
    const [current] = useGlobalState("creator")
    const [selectedImage, setSelectedImage] = useState<FileMetadata | null>(null)

    const newPage = {
        title: "",
        content: "",
        free2zaddr: id,
        p2paddr: "",
        description: "",
        featured_image: null,
        get_url: "",
        vanity: "",
        is_published: false,
        is_subscriber_only: false,
        // category: "",
        tags: [] as Tag[],
        f2z_score: "0",
        creator: defaultCreator as PublicCreator,
    } as PageInterface

    const noErrors = {
        vanity: "",
        title: "",
    }

    const [errors, setErrors] = useState(noErrors)

    const setSnackbarState = useGlobalState("snackbar")[1]
    const [, setLoading] = useGlobalState("loading")
    const [focus] = useState(false)
    const [page, setPage] = useState(newPage)
    const navigate = useTransitionNavigate()
    const location = useLocation()

    const handleSave = () => {
        setErrors(noErrors)
        // setLoading(true)
        const update = (f2zaddr: string): Promise<AxiosResponse<any, any>> => {
            // console.log(`update ${f2zaddr}`)
            return axios
                .put(`/api/zpage/${f2zaddr}/`, {
                    ...page,
                    tags: page.tags.map((t) => t.name),
                    featured_image: selectedImage?.id || null,
                    publish_at: page.publish_at?.toISOString() || null,
                })
                .then((res) => {
                    // console.log("UPDATE THEN", res)
                    setSnackbarState({
                        message: "Saved",
                        open: true,
                        severity: "success",
                        duration: 1000,
                    })
                    const currentPath = location.pathname;
                    const newPath = currentPath.replace(/\/edit\/[^/]+$/, `/edit/${page.vanity}`);
                    // navigate(newPath, { replace: true });
                    window.history.replaceState(null, '', newPath);
                    // setLoading(false)
                    return res
                })
                .catch((res) => {
                    // console.log("UPDATE CATCH", res)
                    setSnackbarState({
                        message: JSON.stringify(res.data),
                        open: true,
                        severity: "error",
                        duration: null,
                    })
                    setErrors({
                        ...errors,
                        vanity: res.data.vanity || "",
                        title: res.data.title || "",
                    })
                    // how do you pass a reject along?
                    // console.log("catch update RES", res)
                    // setLoading(false)
                    res.data = page
                    return res
                    // throw "No Save"
                })
        }
        // console.log(page.free2zaddr)
        if (page.free2zaddr === "new") {
            // console.log("save NEW")
            // Disabled buttons
            // // TODO: wtf - probably split flow of new page from editing
            // // existing to simplify
            // if (!page.title || !page.content) {
            //     setSnackbarState({
            //         message: "Please add a title and some content!",
            //         open: true,
            //         severity: "error",
            //         duration: null,
            //     })
            //     setLoading(false)
            //     return new Promise()
            // }
            // setLoading(true)
            return axios.post('/api/zpage/', {
                ...page,
                tags: page.tags.map((t) => t.name),
                featured_image: selectedImage?.id || null,
                publish_at: page.publish_at?.toISOString() || null,
            }).then((res) => {
                // console.log(`NEW POST THEN, ${res.data.free2zaddr}`, page)
                setPage({
                    ...page,
                    ...res.data,
                    tags: res.data.tags.map((t: string) => {
                        return { name: t }
                    })
                })
                // console.log("calling update")
                const newAddr = res.data.free2zaddr
                return update(res.data.free2zaddr).then((res) => {
                    // console.log("updated new page THEN", res)
                    setPage({
                        ...res.data,
                        tags: res.data.tags.map((t: string) => {
                            return { name: t }
                        })
                    })
                    // replaceState is weird?
                    // window.history.pushState(
                    // window.history.replaceState(
                    //     {}, '', `/edit/${newAddr}`);
                    navigate(`/edit/${newAddr}`, { replace: true });

                    // setLoading(false)
                    return res
                }).catch(res => {
                    // console.log("error updating", res)
                    setSnackbarState({
                        message: JSON.stringify(res.data),
                        open: true,
                        severity: "error",
                        duration: null,
                    })
                    // setLoading(false)
                    return res
                    // throw "No Save"
                })
            }).catch((res) => {
                // console.log("ERROR CREATING", res)
                setSnackbarState({
                    message: JSON.stringify(res.data),
                    open: true,
                    severity: "error",
                    duration: null,
                })
                // console.log(res.data)
                setErrors({
                    ...errors,
                    vanity: res.data.vanity || "",
                    title: res.data.title || "",
                })
                // setLoading(false)
                // how do you pass a reject along?
                // throw "No Save"
            })
        }
        return update(page.free2zaddr)
    }

    const refreshPage = (id: string) => {
        // console.log("REFRESH CALLED")
        setErrors(noErrors)
        setLoading(true)
        // Get the data into the dom here for the page we are goinng to edit
        return axios
            .get(`/api/zpage/${id}/`)
            .then((res) => {
                // not really a security concern but it looks bad
                if (res.data.creator.username !== current.username) {
                    setSnackbarState({
                        message: `You are not ${res.data.creator.username}`,
                        severity: "warning",
                        duration: undefined,
                        open: true,
                    })
                    navigate("/profile")
                }
                setPage({
                    ...res.data,
                    publish_at: res.data.publish_at ? moment(res.data.publish_at) : null,
                    tags: res.data.tags.map((t: string) => {
                        return { name: t }
                    })
                })
                setSelectedImage(res.data.featured_image)
                setLoading(false)
            })
            .catch((res) => {
                // console.log("failed to get page", res)
                setSnackbarState({
                    message: JSON.stringify(res.data),
                    open: true,
                    severity: "error",
                    duration: null,
                })
                setLoading(false)
            })
    }

    // if it's the same address as creator address, just set blank
    useEffect(() => {
        if (page.p2paddr && page.creator && page.p2paddr === page.creator.p2paddr) {
            setPage(prevPage => ({
                ...prevPage,
                p2paddr: "",
            }));
        }
    }, [page.p2paddr, page.creator?.p2paddr]);

    useEffect(() => {
        if (!current.username) {
            return
        }
        // setLoading(true)
        // console.log("USE EFFECTG PARAMS", id)
        if (id === "new") {
            // console.log("PARAMS NEW SETTING BLANK")
            // // wtf??
            // setPage({
            //     ...newPage,
            //     // featured_imagee: null,
            // })
            setPage(newPage)
            setSelectedImage(null)
            setErrors(noErrors)
            // setLoading(false)
            return
        }
        // console.log("call refreshPage fun useEffect")
        id && refreshPage(id)
    }, [id, current.username])

    if (page.title === undefined) {
        return null
    }

    if (!current.username) return <RedirectUnauthed />

    return (
        <>
            <Helmet>
                <title>{`Edit ${page.title}`} - Free2Z</title>
            </Helmet>
            <Grid container item xs={12}
                direction="row"
                alignItems="center"
                textAlign="center"
                justifyContent="center"
                spacing={2}
                style={{
                    // marginTop: "1em",
                    // padding: "0.2em 0.2em 3em 0.2em",
                    padding: "0.25em",
                    marginBottom: "2em",
                }}
            >
                {/* QRCode */}
                {page.free2zaddr !== "new" &&
                    <Grid item xs={12}
                        style={{
                            margin: "0.75em 0 -1.5em 0",
                        }}
                    >
                        <BoostPageButton
                            page={page}
                            setPage={setPage}
                        />
                    </Grid>
                }

                {/* Title and featured image */}
                <Grid item xs={12} md={10}>
                    <TextField
                        id="title"
                        label="Title"
                        type="text"
                        // autoFocus={true}
                        margin="normal"
                        error={Boolean(errors.title) || page.title.length < 1}
                        // margin="dense"
                        // color={page.title ? "primary" : "error"}
                        color="primary"
                        fullWidth
                        variant="standard"
                        placeholder="Title of Page"
                        value={page.title}
                        onKeyDown={(v: any) => {
                            if (v.keyCode === 13) {
                                handleSave();
                            }
                        }}
                        onChange={(v) => {
                            const np: PageInterface = {
                                ...page,
                                title: v.target.value,
                            };
                            if (!page.is_published) {
                                np.vanity = slugify(v.target.value, {
                                    lower: true,
                                    strict: true,
                                });
                            }
                            setPage(np);
                        }}
                        InputProps={{
                            endAdornment: !focus && (
                                <InputAdornment position="start">
                                    <Link
                                        target="_blank"
                                        href="/docs/for-creators/creating-a-zpage"
                                    >
                                        <Psychology color="primary" />
                                    </Link>
                                </InputAdornment>
                            ),
                        }}
                        required={true} />
                </Grid>

                {/* CHIP - Feature Image */}
                <Grid item sm={10} md={8}>
                    <Divider>
                        <Chip
                            label="Featured Image"
                            color="primary" />
                    </Divider>
                </Grid>
                <Grid item sm={12} md={10}>
                    <UploadOrSelect
                        selectedImage={selectedImage}
                        setSelectedImage={setSelectedImage} />
                </Grid>

                {/* Save and View */}
                <Grid item xs={12}
                    alignItems="center"
                    justifyContent="center"
                    textAlign="center"
                    style={{ width: "100%" }}
                >
                    <Stack
                        direction="row" spacing={1}
                        style={{
                            margin: "0.5em auto",
                        }}
                        alignItems="center"
                        justifyContent="center"
                        width="100%"
                    >

                        <Button
                            color="success"
                            variant="contained"
                            onClick={handleSave}
                            endIcon={<Save />}
                            disabled={!(page.title && page.content)}
                        >
                            Save
                        </Button>

                        <Button
                            variant="contained"
                            color="primary"
                            disabled={!page.get_url}
                            onClick={() => {
                                // still should do some fancy preview probably
                                // but, let's check the real page, eh?
                                handleSave().then((res) => {
                                    // fragiley
                                    if (res.status === 200) {
                                        navigate(`/${current.username}/zpage/${page.vanity || page.free2zaddr}`);
                                    }
                                });
                            }}
                            endIcon={<Launch />}
                        >
                            View
                        </Button>
                        <FormControlLabel
                            control={<Checkbox
                                // helpT
                                // helperText=""
                                value={page.is_published}
                                checked={page.is_published}
                                onClick={(ev: any) => {
                                    setPage({
                                        ...page,
                                        is_published: !page.is_published,
                                    });
                                }} />}
                            label="Publish" />
                    </Stack>
                </Grid>

                {/* Markdown area */}
                <Grid
                    item
                    xs={12}
                >
                    <MarkdownEditor
                        page={page}
                        setPage={setPage}
                        handleSave={handleSave}
                    />
                </Grid>

                <Grid item xs={12} md={11} lg={10}>
                    <Divider><Chip label="Advanced Options" /></Divider>
                </Grid>


                <Grid item xs={12} md={11} lg={10}>
                    <TextField
                        id="description"
                        label="Description"
                        type="text"
                        // margin="normal"
                        margin="dense"
                        color="primary"
                        fullWidth
                        variant="standard"
                        multiline={true}
                        // rows={2}
                        // maxRows={2}
                        value={page.description}
                        helperText={
                            page.description.length > 250 ?
                                "TOO LONG" :
                                "Optional description (leave blank for AI description)"
                        }
                        onChange={(v) => {
                            setPage({
                                ...page,
                                description: v.target.value,
                            });
                        }}
                        error={page.description.length > 250}
                    />
                </Grid>

                {/* Categories */}
                <Grid item xs={12} md={11} lg={10}>
                    <FormControl
                        fullWidth
                        style={{ textAlign: "left", marginTop: "0.5em" }}
                    >
                        <TagFilterMultiSelect
                            value={page.tags}
                            label="Categories"
                            onChange={(ev, val) => {
                                const newTags = Array.isArray(val) ? val : Array.from([val]);
                                setPage({
                                    ...page,
                                    tags: newTags,
                                });
                            }}
                            noExpand={false}
                        />
                    </FormControl>
                </Grid>

                {page.free2zaddr !== "new" &&
                    <Grid item xs={12} md={11} lg={10}>
                        <EditSelectSeries page={page} />
                    </Grid>}

                {/* Vanity etc */}
                <Grid item xs={12} md={11} lg={10}>
                    <Stack direction="column" spacing={2}>
                        <TextField
                            id="vanity"
                            label="Vanity URL"
                            type="text"
                            // margin="normal"
                            margin="dense"
                            color="secondary"
                            fullWidth
                            variant="standard"
                            error={Boolean(errors.vanity)}
                            value={page.vanity}
                            helperText={`free2z.cash/${current.username}/zpage/${page.vanity} - If this is blank, your page will not be publicized on your profile or in search!`}
                            onKeyDown={(v: { keyCode: number; }) => {
                                if (v.keyCode === 13) {
                                    handleSave();
                                }
                            }}
                            onChange={(v) => {
                                setPage({
                                    ...page,
                                    vanity: v.target.value,
                                });
                                setErrors({
                                    ...errors,
                                    vanity: "",
                                });
                            }}
                            InputProps={{
                                endAdornment: !focus && (
                                    <InputAdornment position="start">
                                        <Link
                                            target="_blank"
                                            href="/docs/for-creators/creating-a-zpage"
                                        >
                                            <Fingerprint color="info" />
                                        </Link>
                                    </InputAdornment>
                                ),
                            }} />
                        {/* <HorizontalRule /> */}
                        <TextField
                            id="p2paddr"
                            label="Peer-to-Peer Address"
                            type="text"
                            // error={Boolean(page.p2paddr) && !page.p2paddr.match(/^zs[a-z0-9]{76}$/)}
                            margin="dense"
                            color="info"
                            fullWidth
                            variant="standard"
                            value={page.p2paddr}
                            placeholder={current.p2paddr || "u..."}
                            helperText={
                                // TODO: better link?
                                <Link href="/docs/for-creators/creating-a-zpage">
                                    Optional address override.
                                    Use if different from profile address. Commonly Zcash.
                                </Link>}
                            onKeyDown={(v: { keyCode: number; }) => {
                                if (v.keyCode === 13) {
                                    handleSave();
                                }
                            }}
                            onChange={(v) => {
                                setPage({
                                    ...page,
                                    p2paddr: v.target.value,
                                });
                                setErrors({
                                    ...errors,
                                    vanity: "",
                                    title: "",
                                });
                            }}
                            InputProps={{
                                endAdornment: !focus && (
                                    <InputAdornment position="start">
                                        <Link
                                            target="_blank"
                                            href="https://z.cash/"
                                        >
                                            <QrCode2 color="secondary" />
                                        </Link>
                                    </InputAdornment>
                                ),
                            }} />

                        <FormControlLabel
                            control={<Checkbox
                                // helperText="Subscriber only content"
                                value={page.is_subscriber_only}
                                checked={page.is_subscriber_only}
                                onClick={(ev: React.MouseEvent<HTMLButtonElement>) => {
                                    setPage({
                                        ...page,
                                        is_subscriber_only: !page.is_subscriber_only,
                                    });
                                }} />}
                            label="Subscribers Only"
                        />

                        <F2ZDateTimePicker
                            value={page.publish_at || null}
                            setValue={(value) => {
                                setPage({
                                    ...page,
                                    publish_at: value,
                                });
                            }} />
                    </Stack>
                </Grid>

            </Grid>
        </>
    )
}
