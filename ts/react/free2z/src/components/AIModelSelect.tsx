import { CSSProperties, useEffect, useMemo, useState } from "react";
import {
    Chip,
    FormControl,
    InputLabel, ListSubheader, Select, MenuItem, SelectChangeEvent,
} from "@mui/material";
import axios from "axios";
import { AIAction, AIModel } from "../AI2";
import { AI_PROVIDER_ORDER, getProviderLabel, getProviderMeta, normalizeProvider } from "../utils/aiProviders";


interface AIModelSelectProps {
    dispatch: React.Dispatch<AIAction>
    selectedModel: string;
}


// Note: plain `<div style=...>` (rather than MUI's `Box`/`sx`) is used
// deliberately for the layout wrappers below — MUI's `Box` polymorphic props
// trip a known TS2590 ("union type too complex") issue in combination with
// the rest of this file under this project's TS 4.9 / es5-target config.
// Plain divs sidestep it without changing behavior or appearance.

/** Small outlined badge showing which provider a model belongs to. */
function ProviderChip({ provider }: { provider?: string }) {
    const meta = getProviderMeta(provider);
    return (
        <Chip
            size="small"
            variant="outlined"
            label={meta.label}
            style={{
                borderColor: meta.color,
                color: meta.color,
                height: 20,
                fontSize: '0.7rem',
            }}
        />
    );
}


const rowStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    gap: 8,
};

const valueStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
};


/** Row rendered for each model option: name + provider badge. */
function ModelOptionRow({ model }: { model: AIModel }) {
    return (
        <div style={rowStyle}>
            <span>{model.display_name}</span>
            <ProviderChip provider={model.provider} />
        </div>
    );
}


/** What's shown in the closed Select for the current selection. */
function SelectedModelValue({ model, value }: { model?: AIModel; value: string }) {
    if (!model) return <>{value}</>;
    return (
        <div style={valueStyle}>
            <span>{model.display_name}</span>
            <ProviderChip provider={model.provider} />
        </div>
    );
}


/** Group models by (normalized) provider, ordered per AI_PROVIDER_ORDER with
 * any unknown/"other" providers appended last. Models within a provider are
 * sorted by the backend `order` field when present, falling back to the
 * order returned by the API. */
function groupModelsByProvider(models: AIModel[]): Array<[string, AIModel[]]> {
    const groups = new Map<string, AIModel[]>();
    models.forEach((model) => {
        const key = normalizeProvider(model.provider);
        const group = groups.get(key);
        if (group) {
            group.push(model);
        } else {
            groups.set(key, [model]);
        }
    });

    groups.forEach((group) => {
        group.sort((a, b) => {
            if (a.order != null && b.order != null) {
                return a.order - b.order;
            }
            return 0;
        });
    });

    const orderedKeys = [
        ...AI_PROVIDER_ORDER.filter((key) => groups.has(key)),
        ...Array.from(groups.keys()).filter((key) => !AI_PROVIDER_ORDER.includes(key)),
    ];

    return orderedKeys.map((key) => [key, groups.get(key) as AIModel[]]);
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

    const groupedModels = useMemo(() => groupModelsByProvider(models), [models]);
    const modelsById = useMemo(() => new Map(models.map((model) => [model.id, model])), [models]);

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
                renderValue={(value) => (
                    <SelectedModelValue model={modelsById.get(value as string)} value={value as string} />
                )}
            >
                {groupedModels.flatMap(([providerKey, providerModels]) => [
                    <ListSubheader key={`header-${providerKey}`} sx={{ lineHeight: '2.2em' }}>
                        {getProviderLabel(providerKey)}
                    </ListSubheader>,
                    ...providerModels.map((model) => (
                        <MenuItem key={model.id} value={model.id}>
                            <ModelOptionRow model={model} />
                        </MenuItem>
                    )),
                ])}
            </Select>
        </FormControl>
    )
}