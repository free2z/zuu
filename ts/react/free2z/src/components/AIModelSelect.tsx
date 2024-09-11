import { useEffect, useState } from "react";
import {
    FormControl,
    InputLabel, Select, MenuItem, SelectChangeEvent,
} from "@mui/material";
import axios from "axios";
import { AIAction, AIModel } from "../AI2";


interface AIModelSelectProps {
    dispatch: React.Dispatch<AIAction>
    selectedModel: string;
}


export default function AIModelSelect(props: AIModelSelectProps) {
    const [models, setModels] = useState<AIModel[]>([])

    const handleModelChange = (event: SelectChangeEvent) => {
        props.dispatch({
            type: 'setSelectedModel',
            selectedModel: event.target.value as string,
        })
    }

    useEffect(() => {
        axios.get('/api/ai/models/')
            .then(res => {
                setModels(res.data.results);
                if (!props.selectedModel) {
                    props.dispatch({
                        type: 'setSelectedModel',
                        selectedModel: res.data.results[0]?.id,
                    })
                }
            })
            .catch(err => {
                console.error(err);
            });
    }, []);

    return (
        <FormControl fullWidth variant="outlined"
            sx={{ mr: 1 }}
        >
            <InputLabel id="model-select-label">Model</InputLabel>
            <Select
                labelId="model-select-label"
                id="model-select"
                value={(models.length > 0 && props.selectedModel) || ""}
                onChange={handleModelChange}
                label="Model"
            >
                {models.map((model) => (
                    <MenuItem key={model.id} value={model.id}>
                        {model.display_name}
                    </MenuItem>
                ))}
            </Select>
        </FormControl>
    )
}