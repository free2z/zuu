import { useEffect, useRef, useState } from "react";
import { Formik } from "formik";
import { Cancel, Search, TravelExplore } from "@mui/icons-material";
import {
    FormControl, TextField,
    InputAdornment, IconButton, Stack, InputLabel, Select, Divider, Grid, MenuItem, InputBase, lighten, darken, Theme, Dialog, Backdrop, useMediaQuery, DialogTitle, DialogActions, Button, DialogContent, useTheme, Box, Chip, InputBaseProps, styled, MenuProps, Menu, alpha,
    // Sele
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close"
import ExpandMoreIcon from "@mui/icons-material/ExpandMore"
import AddIcon from "@mui/icons-material/Add"
import VerifiedIcon from '@mui/icons-material/Verified';
import VideoLibraryIcon from '@mui/icons-material/VideoLibrary';

import FindSwitches from "./FindSwitches";
import TagFilterMultiSelect from "./TagFilterMultiSelect";
import { elevateColor } from "../utils";
import useIsInViewport from "../hooks/useIsInViewport";
import ChipFilterSelect from "./ChipFilterSelect";

type SearchFieldProps = {
    search: string;
    setSearch: (newValue: string) => void;
    setParams: (newValue: any) => void;
    pageQuery: any;
};


const FindSearch = ({ value, clearSearch, ...props }: InputBaseProps & { clearSearch: () => void }) => {
    return (
        <InputBase
            type="search"
            value={value}
            startAdornment={
                <InputAdornment
                    position={"start"}
                    sx={{
                        paddingLeft: "12px",
                        "& svg": {
                            color: (theme) => theme.palette.mode === "dark" ? "rgba(255,255,255,0.6)" : "rgba(0,0,0,0.38)",
                        },
                    }}
                >
                    <Search />
                </InputAdornment>
            }
            endAdornment={
                String(value).length > 0 && (
                    <InputAdornment position="end">
                        <IconButton
                            size="large"
                            onClick={clearSearch}
                        >
                            <Cancel color="primary" />
                        </IconButton>
                    </InputAdornment>
                )}
            placeholder={"Search Messenger"}
            sx={{
                backgroundColor: (theme) => elevateColor(theme, theme.palette.background.paper),
                py: '8px',
                borderRadius: "40px",
                width: "100%",
                "& .MuiInputBase-input": {
                    boxSizing: "border-box",
                    minHeight: 36,
                },
                "& .MuiInputBase-input::-webkit-search-cancel-button": {
                    position: "relative",
                    right: "20px",
                    "-webkit-appearance": "none",
                    // height: "20px",
                    // width: "20px",
                    // borderRadius: "10px",
                    // color: "red",
                },
            }}
            {...props}
        />
    );
};


export const SearchField: React.FC<SearchFieldProps> = ({ search, setSearch, setParams, pageQuery }) => (
    <FormControl fullWidth>
        <FindSearch
            // variant="filled"
            fullWidth
            value={search}
            // label="Search"
            placeholder="Search"
            size="medium"
            clearSearch={() => {
                setSearch("");
                setParams({
                    ...pageQuery,
                    search: "",
                    page: 1,
                });
            }}
            onChange={(ev: any) => setSearch(ev.target.value)}
            onKeyDown={(v: any) => {
                if (v.keyCode === 13) {
                    setParams({
                        ...pageQuery,
                        search: search,
                        page: 1,
                    });
                }
            }}
        />
    </FormControl>
);

type AdvancedOptionsProps = {
    pageQuery: any;
    setParams: (newValue: any) => void;
    handleSortChange: (newValue: any) => void;
    username?: string;
};

const BackdropComponent = ({ ownerState, ...props }: any) => {
    const isSmallHeight = useMediaQuery('(max-height:560px)');

    return (
        <Backdrop {...props}>
            <div onClick={ownerState?.onClose} style={{ position: 'absolute', width: '100%', height: '100%' }}>
                {!isSmallHeight && (
                    <div style={{ position: 'absolute', top: '16px', right: '16px' }}>
                        <CloseIcon sx={{ fontSize: 48 }} onClick={ownerState?.onClose} />
                    </div>
                )}
            </div>
        </Backdrop>
    );
}

const isActiveSearchFilter = (id: string, pageQuery: any) => {
    return {
        sort_by: true,
        video: Boolean(pageQuery.tags.some((tag: { name: string }) => tag.name === 'video')),
        verified: Boolean(pageQuery.noShowUnverified),
        free2z_score: Boolean(pageQuery.sort === '-f2z_score'),
        tags: true, // For outline
        // tags: Boolean(pageQuery.tags.length > 0),
    }[id] || false
}

const StyledMenu = styled((props: MenuProps) => (
    <Menu
        elevation={0}
        anchorOrigin={{
            vertical: 'bottom',
            horizontal: 'right',
        }}
        transformOrigin={{
            vertical: 'top',
            horizontal: 'right',
        }}
        {...props}
    />
))(({ theme }) => ({
    '& .MuiPaper-root': {
        // borderRadius: 6,
        marginTop: theme.spacing(1),
        minWidth: 180,
        color:
            theme.palette.mode === 'light' ? 'rgb(55, 65, 81)' : theme.palette.grey[200],
        backgroundColor:
            theme.palette.mode === 'light' ? theme.palette.common.white : theme.palette.grey[900],
        // border: theme.palette.mode === 'dark' ? '1px solid white' : undefined,
        boxShadow:
            'rgb(255, 255, 255) 0px 0px 0px 0px, rgba(0, 0, 0, 0.05) 0px 0px 0px 1px, rgba(0, 0, 0, 0.1) 0px 10px 15px -3px, rgba(0, 0, 0, 0.05) 0px 4px 6px -2px',
        '& .MuiMenu-list': {
            padding: '0px 0',
        },
        '& .MuiMenuItem-root': {
            '& .MuiSvgIcon-root': {
                fontSize: 18,
                color: theme.palette.text.secondary,
                marginRight: theme.spacing(1.5),
            },
            '&:active': {
                backgroundColor: alpha(
                    theme.palette.primary.main,
                    theme.palette.action.selectedOpacity,
                ),
            },
        },
    },
}));

const sortByLabel = {
    '-updated_at': 'Recent',
    '-created_at': 'Created At',
    '-f2z_score': 'Boosted',
};
type KeysOfType<T> = keyof T;

export const SuggestedSearchFiltersRow = ({
    defaultFilters = [{ id: 'sort_by', label: 'Sort By' }, { id: 'video', label: 'Video' }, { id: 'verified', label: 'Verified' }],
    setIsShowingAdvancedFilter,
    pageQuery,
    setParams,
}: {
    defaultFilters?: { id: string, label: string, value?: string, name?: string }[], pageQuery: any, setParams: (_: any) => void, setIsShowingAdvancedFilter: (_: any) => void,
}) => {
    const theme = useTheme();
    const isXS = useMediaQuery('(max-width:399px)');
    const isDarkMode = theme.palette.mode === 'dark';
    const [searchNewTag, setSearchNewTag] = useState([]);
    const [isAddTagOpen, setIsAddTagOpen] = useState(false);

    const [sortByAnchorEl, setSortByAnchorEl] = useState<null | HTMLElement>(null);
    const sortByIsOpen = Boolean(sortByAnchorEl);
    const handleSortByClick = (event: React.MouseEvent<HTMLElement>) => {
        setSortByAnchorEl(event.currentTarget);
        setIsShowingAdvancedFilter(true);
    };
    const handleSortByClose = () => {
        setSortByAnchorEl(null);
        setIsShowingAdvancedFilter(false);
    };

    const [addTagAnchorEl, setAddTagAnchorEl] = useState<null | HTMLElement>(null);
    const addTagIsOpen = Boolean(addTagAnchorEl);
    // const handleAddTagClick = (event: React.MouseEvent<HTMLElement>) => {
    //     setAddTagAnchorEl(event.currentTarget);
    //     setIsShowingAdvancedFilter(true);
    // };
    const handleAddTagClose = () => {
        setAddTagAnchorEl(null);
        setIsShowingAdvancedFilter(false);
    };

    return (
        <Stack sx={{
            overflow: 'hidden', position: 'relative', pb: '6px', pt: ['0px', '6px'],
            "& .MuiStack-root::-webkit-scrollbar": { display: 'none' }
        }}>
            <Stack direction="row" sx={{ flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
                {defaultFilters
                    .filter(({ id }) => id === 'verified' && pageQuery.username ? false : true)
                    .concat(pageQuery.tags.filter(({ name }: { name: string }) => !['video'].includes(name)))
                    .concat({ id: 'tags', label: 'Add Tags' })
                    .map(({ id, label, ...chip }, i) => (
                        <>
                            {id === 'tags' && isAddTagOpen ? (
                                <Stack direction="row" sx={{ height: '32px', minWidth: '128px', borderRadius: '16px', border: '1px solid white', px: '12px' }}>
                                    <ChipFilterSelect
                                        value={searchNewTag}
                                        allTags={pageQuery.tags}
                                        username={pageQuery.username}
                                        // show
                                        show
                                        placeholder="Add Tag"
                                        label={null}
                                        onChange={(ev, val) => {
                                            const newTags = Array.isArray(val) ? val : Array.from([val]);
                                            setParams({
                                                ...pageQuery,
                                                tags: pageQuery.tags.concat(newTags)
                                            });
                                            setIsAddTagOpen(false);
                                        }}
                                        autoFocus
                                        inputSx={{
                                            '& .MuiInput-root': { marginTop: '0px' },
                                            '& .MuiInput-input': {
                                                fontSize: '0.9285714285714285rem', color: theme.palette.mode === 'dark' ? 'white' : 'black',
                                                "&::placeholder": {
                                                    opacity: 0.75,
                                                },
                                            },
                                        }}
                                        // username={username}
                                        noExpand={false}
                                        handleClose={() => {
                                            setIsShowingAdvancedFilter(false);
                                            setIsAddTagOpen(false);
                                        }}
                                    />
                                </Stack>
                            ) : (
                                <Chip
                                    key={`id-${id}`}
                                    // ref={i === defaultFilters.length - 1 ? lastChipRef : undefined}
                                    label={(isXS && ['video', 'verified', 'tags'].includes(id))
                                        ? undefined
                                        : (id === 'sort_by'
                                            ? sortByLabel[pageQuery.sort as KeysOfType<typeof sortByLabel> || '-updated_at'] || label
                                            : label || (chip.name ? chip.name : undefined))}
                                    icon={{
                                        sort_by: <ExpandMoreIcon />,
                                        tags: <AddIcon />,
                                        verified: <VerifiedIcon color="primary" fontSize="small" />,
                                        video: <VideoLibraryIcon color="primary" fontSize="small" sx={{ pl: '4px' }} />,
                                    }[id] || undefined}
                                    // onDelete={id === 'latest' ? () => { } : undefined}
                                    color={
                                        isActiveSearchFilter(id, pageQuery)
                                            ? "primary"
                                            : chip.name ? "secondary" : undefined}
                                    variant={id === 'tags' ? 'outlined' : undefined}
                                    sx={{
                                        ml: '0px', cursor: 'pointer',
                                        ...(!['verified', 'video'].includes(id) && {
                                            "& .MuiChip-icon": {
                                                order: 1,
                                                mr: '5px',
                                                ml: '-6px',
                                            }
                                        }),
                                        ...((isXS && ['video', 'verified', 'tags'].includes(id)) && {
                                            width: '32px',
                                            "& .MuiChip-icon": {
                                                mr: '-18px',
                                            }
                                        })
                                    }}
                                    onDelete={chip.name ? () => {
                                        setParams({
                                            ...pageQuery,
                                            tags: pageQuery.tags.filter((tag: { name: string }) => tag.name !== chip.name)
                                        });
                                    } : undefined}
                                    onClick={(e) => {
                                        switch (id) {
                                            case 'sort_by': {
                                                // setParams({ ...pageQuery, page: 1, sort: '-created_at' })
                                                handleSortByClick(e);
                                                break
                                            }
                                            case 'tags': {
                                                // handleAddTagClick(e);
                                                setIsShowingAdvancedFilter(true);
                                                setIsAddTagOpen(true);
                                                break
                                            }
                                            case 'video': {
                                                setParams({
                                                    ...pageQuery,
                                                    tags: !isActiveSearchFilter(id, pageQuery)
                                                        ? pageQuery.tags.concat({ name: 'video' })
                                                        : pageQuery.tags.filter((tag: { name: string }) => tag.name !== 'video')
                                                })
                                                break
                                            }
                                            case 'verified': {
                                                // if (!isActiveSearchFilter(id, pageQuery)) {
                                                setParams({ ...pageQuery, noShowUnverified: !isActiveSearchFilter(id, pageQuery) })
                                                break
                                            }
                                            case 'free2z_score': {
                                                setParams({ ...pageQuery, page: 1, sort: '-f2z_score' })
                                                break
                                            }
                                        }
                                    }}
                                />
                            )}
                            {id === 'sort_by' && (
                                <StyledMenu
                                    id="sort-by-customized-menu"
                                    MenuListProps={{
                                        'aria-labelledby': 'sort-by-customized-button',
                                    }}
                                    anchorEl={sortByAnchorEl}
                                    open={sortByIsOpen}
                                    onClose={handleSortByClose}
                                >
                                    {['-updated_at', '-created_at', '-f2z_score'].map((id) => (
                                        <MenuItem
                                            key={id}
                                            onClick={() => {
                                                setParams({ ...pageQuery, page: 1, sort: id })
                                                handleSortByClose()
                                            }}
                                            sx={{
                                                ...((pageQuery.sort || '-updated_at') === id && { backgroundColor: theme.palette.primary.main, color: theme.palette.primary.contrastText, '&:hover': { opacity: 0.7, backgroundColor: theme.palette.primary.main } })
                                            }}
                                            disableRipple
                                        >
                                            {/* <CustomIcon /> */}
                                            {sortByLabel[id as KeysOfType<typeof sortByLabel>]}
                                        </MenuItem>
                                    ))}
                                </StyledMenu>
                            )}
                            {id === 'tags' && (
                                <StyledMenu
                                    id="tags-customized-menu"
                                    MenuListProps={{
                                        'aria-labelledby': 'tags-customized-button',
                                    }}
                                    anchorEl={addTagAnchorEl}
                                    open={addTagIsOpen}
                                    onClose={handleAddTagClose}
                                // sx={{
                                //     '& .MuiPaper-root': {
                                //         minWidth: '200px',
                                //     }
                                // }}
                                >
                                    <Stack direction="column"
                                        // take up the full vertical space with the three elements
                                        justifyContent="center"
                                        alignItems="space-between"
                                        spacing={2}
                                        sx={{
                                            height: "100%",
                                            mt: '8px',
                                            mb: '16px',
                                            px: '16px',
                                        }}
                                    >
                                        <TagFilterMultiSelect
                                            value={pageQuery.tags}
                                            show
                                            label="Tags"
                                            type="zpage"
                                            onChange={(ev, val) => {
                                                const newTags = Array.isArray(val) ? val : Array.from([val]);
                                                setParams({
                                                    ...pageQuery,
                                                    tags: newTags
                                                });
                                            }}
                                            // username={username}
                                            noExpand={false}
                                        />
                                    </Stack>
                                    {/* {[{ label: 'Recently Posted', value: '-created_at' }, { label: 'Recently Updated', value: '-updated_at' }, { label: 'F2Z Score', value: '-f2z_score' }, { label: 'Total Donated', value: '-total' }].map(({ label, value }, i) => ( */}
                                    {/* <> */}
                                    {/* {i === 0 && <TextField id="standard-basic" label="Standard" variant="standard" />} */}
                                    {/* <CustomIcon /> */}
                                    {/* {i > 0 ? label : undefined} */}
                                    {/* </> */}
                                    {/* ))} */}
                                </StyledMenu>
                            )}
                        </>
                    ))}
            </Stack>
        </Stack>
    )
}

export const SearchFilterModal = ({ initialValues = { tags: [] }, open, handleExit, pageQuery, setParams }: any) => {
    const isXS = useMediaQuery('(max-width:330px)');
    const isSmallHeight = useMediaQuery('(max-height:560px)');

    return (
        <Dialog
            sx={{
                '& .MuiBackdrop-root': {
                    backdropFilter: 'blur(16px)',
                },
            }}
            open={open}
            onClose={handleExit}
            slots={{ backdrop: BackdropComponent }}
            fullScreen={isXS}
            fullWidth={true}
            maxWidth="sm"
        >
            {Boolean(isXS || isSmallHeight) && (
                <div style={{ position: 'absolute', top: '16px', right: '16px' }}>
                    <CloseIcon sx={{ fontSize: 40 }} onClick={handleExit} />
                </div>
            )}
            <Formik
                initialValues={initialValues}
                onSubmit={(values, actions) => {
                    const { tags: newTags, sort } = values

                    setParams({
                        ...pageQuery,
                        sort,
                        page: 1,
                        tags: newTags,
                    });
                    handleExit()
                    // handleCreate(values.username, values.password, actions.setFieldError);
                }}
            // validationSchema={toFormikValidationSchema(Schema)}
            >
                {({ errors, touched, values, isValid, handleChange, handleBlur, handleSubmit, setFieldValue, setFieldTouched }) => (
                    <form>
                        <DialogTitle>Search filters</DialogTitle>
                        <DialogContent>
                            <Stack direction="column"
                                // take up the full vertical space with the three elements
                                justifyContent="center"
                                alignItems="space-between"
                                spacing={2}
                                sx={{
                                    height: "100%",
                                    mt: '8px',
                                    mb: '16px',
                                }}
                            >
                                <TagFilterMultiSelect
                                    value={values.tags}
                                    type="zpage"
                                    label="Tags"
                                    onChange={(ev, val) => {
                                        const newTags = Array.isArray(val) ? val : Array.from([val]);

                                        setFieldValue('tags', newTags)
                                        setFieldTouched('tags')
                                    }}
                                    // username={username}
                                    noExpand={false}
                                />
                            </Stack>
                            <Stack direction="row">
                                <FormControl fullWidth sx={{ textAlign: "left" }}>
                                    <InputLabel id="select-sort">Sort</InputLabel>
                                    <Select
                                        labelId="select-sort"
                                        id="select-sort"
                                        value={values.sort}
                                        label="Sort"
                                        onChange={(ev) => {
                                            setFieldValue('sort', ev.target.value)
                                            setFieldTouched('sort')
                                        }}
                                    >
                                        <MenuItem value="-f2z_score">
                                            F2Z Score
                                        </MenuItem>
                                        <MenuItem value="-total">
                                            Total Donated
                                        </MenuItem>
                                        <MenuItem value="-created_at">
                                            Recently Created
                                        </MenuItem>
                                        <MenuItem value="-updated_at">
                                            Recently Updated
                                        </MenuItem>
                                    </Select>
                                </FormControl>
                                <Stack direction="column" alignItems="center" justifyContent="center">
                                    <FindSwitches pageQuery={pageQuery} setParams={setParams} />
                                </Stack>
                            </Stack>
                        </DialogContent>
                        <DialogActions
                            sx={{
                                mb: isXS ? 10 : 0,
                                p: '24px',
                                pt: '0px',
                            }}
                        >
                            <Button
                                color="primary"
                                onClick={(e) => {
                                    e.preventDefault();
                                    handleSubmit();
                                }}
                                variant="contained"
                                fullWidth
                                // disabled={!isValid || !recaptchaLoaded}
                                type="submit"
                            >
                                Apply Filters
                            </Button>
                        </DialogActions>
                    </form>
                )}
            </Formik>
        </Dialog>
    );
}

export const AdvancedOptions: React.FC<AdvancedOptionsProps> = ({ pageQuery, setParams, handleSortChange, username }) => (
    <Grid container spacing={1}
        style={{
            marginTop: "2px",
        }}
    >
        <Grid item xs={12} md={6}>
            <TagFilterMultiSelect
                type="zpage"
                value={pageQuery.tags}
                onChange={(ev, val) => {
                    const newTags = Array.isArray(val) ? val : Array.from([val]);
                    setParams({
                        ...pageQuery,
                        page: 1,
                        tags: newTags,
                    });
                }}
                username={username}
                noExpand={false}
            />
        </Grid>
        <Grid item xs={12} md={6}>
            <Stack direction="row">
                <FormControl fullWidth sx={{ textAlign: "left" }}>
                    <InputLabel id="select-sort">Sort</InputLabel>
                    <Select
                        labelId="select-sort"
                        id="select-sort"
                        value={pageQuery.sort}
                        label="Sort"
                        onChange={(ev) => handleSortChange(ev.target.value)}
                    >
                        <MenuItem value="-f2z_score">
                            F2Z Score
                        </MenuItem>
                        <MenuItem value="-total">
                            Total Donated
                        </MenuItem>
                        <MenuItem value="-created_at">
                            Recently Created
                        </MenuItem>
                        <MenuItem value="-updated_at">
                            Recently Updated
                        </MenuItem>
                    </Select>
                </FormControl>
                <Stack direction="column" alignItems="center" justifyContent="center">
                    <FindSwitches pageQuery={pageQuery} setParams={setParams} />
                </Stack>
            </Stack>
        </Grid>
        <Grid item xs={12}>
            <Divider variant="fullWidth" />
        </Grid>
    </Grid>
);
