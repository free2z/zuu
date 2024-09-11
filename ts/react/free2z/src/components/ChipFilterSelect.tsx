import {
    AutocompleteChangeDetails, Autocomplete, TextField,
    AutocompleteInputChangeReason,
    AutocompleteChangeReason,
    Stack,
} from "@mui/material";
import axios from "axios";
import { SyntheticEvent, useEffect, useState } from "react";


export type Tag = {
    name: string,
    count?: number,
}

type TagFilterMultiSelectProps = {
    // onTagChange: (tags: Tag[]) => void;
    // https://mui.com/material-ui/api/autocomplete/
    onChange: (
        event: SyntheticEvent<Element, Event>,
        value: readonly Tag[],
        reason: AutocompleteChangeReason,
        details?: AutocompleteChangeDetails<Tag> | undefined
    ) => void
    value: Tag[],
    label?: string | null,
    username?: string,
    type?: string,
    noExpand?: boolean,
    show?: boolean,
    inputSx?: any,
    placeholder: any,
    handleClose?: () => void,
    autoFocus?: boolean,
    allTags?: Tag[],
}


export default function ChipFilterSelect(props: TagFilterMultiSelectProps) {
    const [options, setOptions] = useState<Tag[]>([]);
    const [isOpen, setIsOpen] = useState(props.show || false);
    var blank = (props.show !== undefined && !props.show);

    function getOptions(value?: string) {
        const selectedTags = props.allTags?.map(tag => tag.name).join(',');
        const params = new URLSearchParams({
            query: value || '',
            username: props.username || "",
            type: props.type || "zpage",
            selected_tags: selectedTags || "",
        });

        axios.get("/api/tagging/autocomplete", { params })
            .then((response) => {
                const results = response.data.filter((option: Tag) => !props.allTags?.map(tag => tag.name).includes(option.name))
                setOptions(results);
            });
    }


    const handleInputChange = (
        event: React.SyntheticEvent<Element, Event>,
        value: string,
        reason: AutocompleteInputChangeReason,
    ) => {
        if (reason === 'input') {
            getOptions(value)
        }
    };

    useEffect(() => {
        if (props.show === false) {
            setIsOpen(false);
        }
    }, [props.show]);

    return (
        <Autocomplete
            fullWidth
            blurOnSelect
            value={props.value}
            multiple
            // open={props.show === undefined || props.show === true}
            // multi
            limitTags={props.noExpand ? 1 : undefined}
            filterSelectedOptions
            options={options}
            getOptionLabel={(option) => `${option.name}`}
            componentsProps={{
                popper: {
                    style: { width: 'fit-content', maxWidth: '60vw' },
                    popperOptions: {
                        placement: 'bottom',
                        modifiers: [{
                            name: 'arrow',
                            enabled: true,
                        }],
                    },
                }
            }}
            renderOption={(props, option, state) => (
                <li {...props}>
                    <Stack sx={{ minWidth: ['200px', undefined], maxWidth: '100vw' }}>
                        {option.name} ({option.count})
                    </Stack>
                </li>
            )}
            renderInput={(params) =>
                // TODO: this is the hardest problem in computer science
                <TextField
                    {...params} label={props.label || props.label !== null ? "Filter" : undefined}
                    placeholder={props.placeholder}
                    variant="standard"
                    InputProps={{
                        disableUnderline: true,
                        ...params.InputProps,
                    }}
                    autoFocus={props.autoFocus}
                    sx={props.noExpand ? {
                        '.MuiChip-root': {
                            maxWidth: "110px",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            ...props.inputSx,
                        }
                    } : { ...props.inputSx }}
                />
            }
            // clearIcon={null}
            onInputChange={handleInputChange}
            onFocus={() => getOptions()}
            onChange={props.onChange}
            isOptionEqualToValue={(option, value) => {
                return option.name === value.name
            }}
            open={blank ? false : isOpen}
            onOpen={() => {
                if (!blank) {
                    setIsOpen(true);
                }
            }}
            onClose={() => {
                setIsOpen(false)
                if (props.handleClose) {
                    props.handleClose()
                }
            }}

        />
    );
}
