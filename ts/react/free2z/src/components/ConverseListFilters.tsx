import { ToggleButtonGroup, ToggleButton, Box, FormControl, Grid, Paper, Stack, TextField } from "@mui/material";
import TagFilterMultiSelect, { Tag } from "./TagFilterMultiSelect";
import { useRef, useEffect } from "react";

interface SortingSwitchProps {
    value: 'new' | 'hot';
    onChange: (newValue: 'new' | 'hot') => void;
}

export const SortingSwitch: React.FC<SortingSwitchProps> = ({ value, onChange }) => {
    return (
        <ToggleButtonGroup
            value={value}
            exclusive
            onChange={(_, newValue: 'new' | 'hot' | null) => {
                if (newValue) onChange(newValue);
            }}
            aria-label="sorting mode"
        >
            <ToggleButton value="new" aria-label="newest first">
                New
            </ToggleButton>
            <ToggleButton value="hot" aria-label="trending first">
                Hot
            </ToggleButton>
        </ToggleButtonGroup>
    );
}

interface SubscriptionToggleProps {
    value: 'all' | 'subscribed';
    onChange: (newValue: 'all' | 'subscribed') => void;
}

export const SubscriptionToggle: React.FC<SubscriptionToggleProps> = ({ value, onChange }) => {
    return (
        <ToggleButtonGroup
            value={value}
            exclusive
            onChange={(_, newValue: 'all' | 'subscribed' | null) => {
                if (newValue) onChange(newValue);
            }}
            aria-label="subscription mode"
        >
            <ToggleButton value="all" aria-label="all">
                All
            </ToggleButton>
            <ToggleButton value="subscribed" aria-label="subscribed to">
                Subs
            </ToggleButton>
        </ToggleButtonGroup>
    );
};

type ConverseListFiltersProps = {
    setFilterHeight: (newValue: number) => void;
    showFilters: boolean;
    // setShowFilters: (newValue: boolean) => void;
    searchTerm: string;
    setSearchTerm: (newValue: string) => void;
    tags: Tag[];
    setTags: (newValue: Tag[]) => void;
    sortMode: 'new' | 'hot';
    setSortMode: (newValue: 'new' | 'hot') => void;
    subscriptionMode: 'all' | 'subscribed';
    setSubscriptionMode: (newValue: 'all' | 'subscribed') => void;
}

export function ConverseListFilters(props: ConverseListFiltersProps) {
    // console.log("RENDERING FILTERS")
    const {
        setFilterHeight,
        showFilters,
        // setShowFilters,
        searchTerm, setSearchTerm,
        tags, setTags,
        sortMode, setSortMode,
        subscriptionMode, setSubscriptionMode,
    } = props;

    const containerRef = useRef<HTMLDivElement | null>(null); // Add this line

    useEffect(() => {
        const currentElement = containerRef.current;
        if (currentElement) {
            setFilterHeight(currentElement.offsetHeight);

            const resizeObserver = new ResizeObserver(entries => {
                for (let entry of entries) {
                    if (entry.target instanceof HTMLElement) {
                        setFilterHeight(entry.target.offsetHeight);
                    }
                }
            });

            resizeObserver.observe(currentElement);

            return () => {
                resizeObserver.disconnect();
            };
        }
    }, []);

    return (
        <Box
            component="div"
            ref={containerRef}
            sx={{
                width: {
                    xs: '100%',
                    sm: '95%',
                    md: '85%',
                    lg: '80%',
                    xl: '75%',
                },
                top: {
                    xs: '57px',
                    sm: '62px',
                    md: '65px',
                    // lg: '6',
                    // xl: '0',
                }
            }}
            style={{
                position: 'fixed',
                // padding: "0.1em",
                left: '50%',
                transform: `translateX(-50%) ${showFilters ? 'translateY(0)' : 'translateY(-77px)'}`,
                zIndex: showFilters ? 1000 : 100,
                opacity: showFilters ? 1 : 0,
                transition: 'opacity 0.77s, transform 0.77s',
                pointerEvents: showFilters ? 'auto' : 'none'  // <-- Add this line
            }}
        >
            <Paper elevation={3}>
                <Grid container spacing={1} style={{ padding: '10px' }}>

                    {/* Search and sort */}
                    <Grid item xs={12} md={6}>
                        <Stack
                            direction="row"
                            justifyContent="space-around"
                            alignItems="center"
                            spacing={1}
                        >
                            <SortingSwitch value={sortMode} onChange={setSortMode} />
                            <FormControl fullWidth>
                                <TextField
                                    type="search"
                                    variant="outlined"
                                    value={searchTerm}
                                    label="Search"
                                    size="medium"
                                    onChange={(ev) => setSearchTerm(ev.target.value)}
                                />
                            </FormControl>
                        </Stack>
                    </Grid>

                    {/* Filter by subbd or Tag */}
                    <Grid item xs={12} md={6}>
                        <Stack
                            direction="row"
                            justifyContent="space-around"
                            alignItems="center"
                            spacing={1}
                        >
                            <SubscriptionToggle value={subscriptionMode} onChange={setSubscriptionMode} />
                            <TagFilterMultiSelect
                                value={tags}
                                onChange={(ev, val) => {
                                    const newTags = Array.isArray(val) ? val : Array.from([val]);
                                    setTags(newTags);
                                }}
                                type='comment'
                                noExpand={true}
                                show={showFilters}
                            />
                        </Stack>
                    </Grid>
                </Grid>
            </Paper>
        </Box>
    )
}