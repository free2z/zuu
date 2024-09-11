import {
    AutocompleteChangeDetails, Autocomplete, TextField,
    AutocompleteInputChangeReason,
    AutocompleteChangeReason,
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
    label?: string,
    username?: string,
    // TODO: more types?
    type?: "zpage" | "comment",
    noExpand?: boolean,
    show?: boolean,
}


export default function TagFilterMultiSelect(props: TagFilterMultiSelectProps) {
    const [options, setOptions] = useState<Tag[]>([]);
    const [isOpen, setIsOpen] = useState(false);
    var blank = (props.show !== undefined && !props.show);

    function getOptions(value?: string) {
        // console.log("props.value", props.value)
        const selectedTags = props.value.map(tag => tag.name).join(',');
        const params = new URLSearchParams({
            query: value || '',
            username: props.username || "",
            type: props.type || "",
            selected_tags: selectedTags,
        });

        axios.get("/api/tagging/autocomplete", { params })
            .then((response) => {
                setOptions(response.data);
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
            renderOption={(props, option, state) => (
                <li {...props}>
                    {option.name} ({option.count})
                </li>
            )}
            renderInput={(params) =>
                // TODO: this is the hardest problem in computer science
                <TextField
                    {...params} label={props.label || "Filter"}
                    sx={props.noExpand ? {
                        '.MuiChip-root': {
                            maxWidth: "110px",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                        }
                    } : undefined}
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
            onClose={() => setIsOpen(false)}

        />
    );
}
