import * as React from 'react';
import Grid from '@mui/material/Grid';
import Slider from '@mui/material/Slider';
import { InputAdornment, Stack, TextField } from '@mui/material';
import { DEFAULT_TUZI_AMOUNT, TUZI_PER_ZEC } from './TuzisDialog';
import TuziIcon from './TuziIcon';
import ZcashIcon from './ZcashIcon';


export interface SliderProps {
    // min: number
    // max: number
    value: number
    setValue: React.Dispatch<React.SetStateAction<number>>
}

export default function AmountSlider(props: SliderProps) {

    const handleSliderChange = (event: Event, newValue: number | number[]) => {
        props.setValue(newValue as number);
    };

    const handleInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        props.setValue(Number(event.target.value));
    };

    const handleZECInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        props.setValue(Number(event.target.value) * TUZI_PER_ZEC);
    };

    const handleBlur = () => {
        if (props.value < 10) {
            props.setValue(DEFAULT_TUZI_AMOUNT);
        } else if (props.value > 1000000000) {
            props.setValue(DEFAULT_TUZI_AMOUNT);
        }
    };

    return (
        <Stack direction="row"
            style={{
                width: "100%",
                marginTop: "1em",
            }}
            alignContent={"center"}
            justifyContent={"center"}
            alignItems={"center"}
            justifyItems={"center"}
            spacing={2}
        >
            <TextField
                value={props.value / TUZI_PER_ZEC}
                size="small"
                // variant=
                fullWidth
                onChange={handleZECInputChange}
                onBlur={handleBlur}
                inputProps={{
                    step: 0.001,
                    min: 0.001,
                    max: 100,
                    type: 'number',
                    'aria-labelledby': 'input-slider',
                }}
                InputProps={{
                    startAdornment: (
                        <InputAdornment position="start">
                            <ZcashIcon />
                        </InputAdornment>
                    ),
                }}
                style={{
                    maxWidth: "140px",
                }}
            />
            <TextField
                value={props.value}
                size="small"
                // variant=
                fullWidth
                onChange={handleInputChange}
                onBlur={handleBlur}
                inputProps={{
                    step: 10,
                    min: 10,
                    max: 1000000,
                    type: 'number',
                    'aria-labelledby': 'input-slider',
                }}
                InputProps={{
                    endAdornment: (
                        <InputAdornment position="start">
                            <TuziIcon />
                        </InputAdornment>
                    ),
                }}
                style={{
                    maxWidth: "140px",
                }}
            />
        </Stack>
    );
}
