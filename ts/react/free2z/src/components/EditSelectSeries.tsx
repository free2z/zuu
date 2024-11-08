import { useMutation, useInfiniteQuery } from 'react-query';
import { DragDropContext, Droppable, Draggable, DropResult } from 'react-beautiful-dnd';
import axios from 'axios';
import React, { useState, useEffect, useRef } from 'react';
import {
    TextField, IconButton, Dialog, DialogTitle, DialogContent,
    DialogActions, Button, Box, List, ListItem, ListItemText,
    Theme, Stack, useMediaQuery,
    CircularProgress,
} from '@mui/material';
import Autocomplete, { AutocompleteInputChangeReason } from '@mui/material/Autocomplete';
import AddIcon from '@mui/icons-material/Add';
import SaveIcon from '@mui/icons-material/Save';
import { PageInterface } from './PageRenderer';
import { DragIndicator } from '@mui/icons-material';

interface PageOrder {
    order: number;
    page: {
        title: string;
        free2zaddr: string;
    }
}

interface Series {
    id: string;
    name: string;
    pageorder_set: PageOrder[];
}

type Props = {
    page: PageInterface
}


const EditSelectSeries: React.FC<Props> = ({ page }) => {
    const [selectedSeries, setSelectedSeries] = useState<Series | null>(null);
    const [seriesPages, setSeriesPages] = useState<PageOrder[]>([]);
    const [open, setOpen] = useState(false);
    const [seriesName, setSeriesName] = useState('');

    const fullScreen = useMediaQuery((theme: Theme) => theme.breakpoints.down('sm'));

    // At the start of your component, create a ref to hold the previous value
    const prevSelectedSeriesRef = useRef<Series | null>();

    const fetchSeries = ({ pageParam = 1 }) =>  axios.get(`/api/g12f/series/mine?page=${pageParam}`).then((res) => res.data)

        const {
          data: seriesList,
          fetchNextPage,
          isFetchingNextPage,
          isLoading,
          hasNextPage,
          refetch,
          status,
        } = useInfiniteQuery(
          'seriesList',
          fetchSeries,
          {
            getNextPageParam: (lastPage, pages) => {
              return lastPage.length >= 10 ? pages.length + 1 : undefined;
            },
          }
        );
    // Update the ref with the current value in a useEffect
    useEffect(() => {
        prevSelectedSeriesRef.current = selectedSeries;
    }, [selectedSeries]);

    const mutation = useMutation(
        (newSeries: Series) => {
            // console.log("useMutation", newSeries)
            if (newSeries.id) {
                return axios.put(`/api/g12f/series/mine/${newSeries.id}/`, newSeries)
            } else {
                return axios.post('/api/g12f/series/mine/', newSeries)
            }
        },
        {
            onSuccess: (res) => {
                // console.log("useMutation success", res)
                refetch();
                // setSelectedSeries(res.data.results);
            },
        });

    // When selectedSeries changes,
    // update the series name and the order of the pages
    useEffect(() => {
        if (selectedSeries?.id) {
            setSeriesName(selectedSeries.name);
            setSeriesPages(selectedSeries.pageorder_set);
            if (prevSelectedSeriesRef.current?.id !== selectedSeries.id) {
                setOpen(true);
            }
        }
    }, [selectedSeries]);

    const handleDragEnd = (result: DropResult) => {
        if (!result.destination) return;
        const { source, destination } = result;

        const reorderedPages = Array.from(seriesPages);
        const [removed] = reorderedPages.splice(source.index, 1);
        reorderedPages.splice(destination.index, 0, removed);

        setSeriesPages(reorderedPages);
    };

    const handleClose = () => {
        setOpen(false);
        setSeriesName('');
        // setSelectedSeries(null);
        // setSeriesPages([]);
    };

    // Save the name and the order of the series
    const handleSave = () => {
        // console.log("handleSave", selectedSeries)
        // Check if a series is selected or new series is being created
        const isExistingSeries = selectedSeries !== null;

        // Prepare series data
        const updatedSeries: Series = {
            id: isExistingSeries ? selectedSeries!.id : '',
            name: seriesName,
            pageorder_set: seriesPages.map((p, i) => ({
                page: { ...p.page },
                order: i + 1,
            })),
        };

        // If a new series is being created, add the current page to it
        if (!isExistingSeries) {
            updatedSeries.pageorder_set.push({
                page: {
                    title: page.title,
                    free2zaddr: page.free2zaddr,
                },
                order: updatedSeries.pageorder_set.length + 1,
            });
        }

        // if the series is already selected
        // then we don't need to update the selected series
        if (!isExistingSeries) {
            setSelectedSeries(updatedSeries)
        }

        mutation.mutate(updatedSeries, {
            onSuccess: (res) => {
                // console.log("handleSave success", res, isExistingSeries)
                // After the series is updated, refresh the series list
                refetch();
                setOpen(false);
            },
        });
    };

    const handleAddSeries = () => {
        setSelectedSeries(null);
        setSeriesPages([]);
        setSeriesName('');
        setOpen(true);
    };

    const addPageMutation = useMutation(
        (series: Series) => {
            // console.log("addPageMutation", series)
            const pageExistsInSeries = series.pageorder_set.some(
                (po) => po.page.free2zaddr === page.free2zaddr
            );
            let updatedPageOrderSet = [...series.pageorder_set];
            if (!pageExistsInSeries) {
                updatedPageOrderSet.push({
                    page: {
                        title: page.title,
                        free2zaddr: page.free2zaddr,
                    },
                    order: series.pageorder_set.length + 1
                });
            }
            return axios.put(`/api/g12f/series/mine/${series.id}/`, {
                ...series,
                pageorder_set: updatedPageOrderSet,
            })
        },
        {
            onSuccess: (res) => {
                // console.log("addPageMutation success", res)
                refetch();
                setSelectedSeries(res.data);
                setOpen(true);
            },
        }
    );

    const handleSelectSeries = (_: React.SyntheticEvent<Element, Event>, value: Series | null) => {
        // console.log("Handle select series", value)
        // setSelectedSeries(value);
        if (value) {
            addPageMutation.mutate(value);
        }
    };

    function handleInputChange(
        event: React.SyntheticEvent<Element, Event>,
        value: string,
        reason: AutocompleteInputChangeReason,
    ) {
        if (reason === 'clear') {
            axios.delete(
                `/api/g12f/series/clear-zpage/?free2zaddr=${page.free2zaddr}`
            ).then(resp => {
                // console.log("clear-zpage", resp)
                if (resp.data.status === 'success') {
                    setSelectedSeries(null); // Reset the state of selectedSeries
                }
            });
            // return
        }
        // setInputValue(value);
        // axios.get('/api/g12f/series/mine/', {
        //     params: {
        //         search: value,
        //     }
        // }).then((res) => setSer res.data.results)

    }

    // set the current series as the selected series
    useEffect(() => {
        // I'm assuming your API has an endpoint to fetch the current series for a page
        axios.get(`/api/g12f/zpage/${page.free2zaddr}/series/`)
            .then((res) => {
                // Set the fetched series as the selected series
                setSelectedSeries(res.data);
            })
            .catch((error) => {
                // Handle the error here
                console.error(error);
            });
    }, []);

    return (
        <Box component="div" display="flex" width="100%" justifyContent="space-between">
            <Autocomplete
                id="series-select"
                sx={{ width: '90%' }}
                options={seriesList?.pages.flat() || []}
                getOptionLabel={(option) => option.name}
                value={selectedSeries}
                onChange={handleSelectSeries}
                onInputChange={handleInputChange}
                loading={isLoading}
                // https://stackoverflow.com/questions/61947941/material-ui-autocomplete-warning-the-value-provided-to-autocomplete-is-invalid
                freeSolo
                forcePopupIcon
                ListboxProps={{
                  sx: { maxHeight: '300px' },
                  onScroll: async(event: React.SyntheticEvent) => {
                    if(hasNextPage === false) return;
                    const listboxNode = event.currentTarget as HTMLElement;
                    if (
                        Number(listboxNode.scrollTop.toFixed(0)) + listboxNode.clientHeight >=
                        listboxNode.scrollHeight
                    ) {
                        await fetchNextPage();    
                    }
                  },
                }}
                renderOption={(props, option) => {
                    return (
                      <li {...props} key={option.id}>
                        {option.name}
                      </li>
                    );
                  }}
                renderInput={(params) => (
                    <TextField
                    {...params}
                     label="Select Series"
                    variant="outlined"
                    key={params.inputProps.id}
                    InputProps={{
                      ...params.InputProps,
                      endAdornment: (
                        <React.Fragment>
                            {isFetchingNextPage ? (
                            <span>Charging more options{'  '}<CircularProgress color="inherit" size={20} /></span>
                            ) : null}
                            {params.InputProps.endAdornment}
                        </React.Fragment>
                      ),
                    }}
                  />
                )}
            />
            <IconButton onClick={handleAddSeries}>
                <AddIcon fontSize="large" color="primary" />
            </IconButton>

            <Dialog open={open} onClose={handleClose}
                fullWidth
                maxWidth="sm"
                fullScreen={fullScreen}
            >
                <DialogTitle>{selectedSeries ? 'Edit Series' : 'New Series'}</DialogTitle>
                <DialogContent>
                    <TextField
                        // autoFocus
                        margin="dense"
                        label="Series Name"
                        type="text"
                        fullWidth
                        value={seriesName}
                        onChange={(e) => setSeriesName(e.target.value)}
                    />
                    {selectedSeries && (
                        <DragDropContext onDragEnd={handleDragEnd}>
                            <Droppable droppableId="droppable">
                                {(provided) => (
                                    <List ref={provided.innerRef} {...provided.droppableProps}>
                                        {seriesPages.map((item, index) => (
                                            <Draggable
                                                key={item.page.free2zaddr}
                                                draggableId={item.page.free2zaddr}
                                                index={index}
                                            >
                                                {(provided, snapshot) => (
                                                    <ListItem
                                                        ref={provided.innerRef}
                                                        {...provided.draggableProps}
                                                        {...provided.dragHandleProps}
                                                        sx={{
                                                            cursor: snapshot.isDragging ? 'grabbing' : 'grab',
                                                            '&:hover': {
                                                                bgcolor: 'action.hover', // change background color on hover
                                                            },
                                                        }}
                                                    >
                                                        <Stack direction="row" spacing={2}
                                                            // textAlign="center"
                                                            justifyContent={'center'}
                                                            alignItems={'center'}
                                                        >
                                                            <DragIndicator
                                                                fontSize='small'
                                                                sx={{ opacity: 0.5 }}
                                                            />
                                                            <ListItemText primary={item.page.title} />
                                                        </Stack>
                                                    </ListItem>
                                                )}
                                            </Draggable>
                                        ))}
                                        {provided.placeholder}
                                    </List>
                                )}
                            </Droppable>
                        </DragDropContext>

                    )}
                </DialogContent>
                <DialogActions>
                    <Button onClick={handleClose}>Cancel</Button>
                    <Button
                        onClick={handleSave}
                        startIcon={<SaveIcon />}
                        disabled={mutation.isLoading}
                    >
                        {mutation.isLoading ? 'Saving...' : 'Save'}
                    </Button>
                </DialogActions>
            </Dialog>
        </Box>
    );
};

export default EditSelectSeries;
