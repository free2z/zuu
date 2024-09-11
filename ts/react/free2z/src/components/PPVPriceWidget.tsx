import React, { useState, useEffect } from 'react';
import { TextField, Grid, InputAdornment, Typography, Stack } from '@mui/material';

type PPVPriceWidgetProps = {
    onChange: (pricePerMinute: number) => void;
};

const PPVPriceWidget: React.FC<PPVPriceWidgetProps> = ({ onChange }) => {
    const [pricePerMinute, setPricePerMinute] = useState<number>(0);

    // When the per-minute rate changes, call the parent onChange
    useEffect(() => {
        onChange(pricePerMinute);
    }, [pricePerMinute, onChange]);

    const handlePricePerMinuteChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        const newPrice = parseFloat(event.target.value);
        setPricePerMinute(newPrice);
    }
    const pricePerHour = (pricePerMinute * 60).toFixed(0);

    return (
        <Grid container spacing={2}>
            <Grid item xs={6}>
                <TextField
                    type="number"
                    label="Price Per Minute"
                    variant="outlined"
                    value={pricePerMinute}
                    onChange={handlePricePerMinuteChange}
                    fullWidth
                    InputProps={{
                        endAdornment: <InputAdornment position="end">2Z/min</InputAdornment>,
                    }}
                    // on up arrow, increase by 0.01
                    // on down arrow, decrease by 0.01
                    onKeyUp={(event) => {
                        if (event.key === 'ArrowUp') {
                            setPricePerMinute(pricePerMinute + 0.01);
                        } else if (event.key === 'ArrowDown') {
                            setPricePerMinute(pricePerMinute - 0.01);
                        }
                        // event.stopPropagation();
                        // event.preventDefault();
                        // // return
                    }}
                />
                {/* <NumberInput min={0} step={0.01}
                    value={pricePerMinute}
                    onChange={handlePricePerMinuteChange}
                /> */}

            </Grid>
            <Grid item xs={6}>
                {!isNaN(pricePerMinute) && (
                    <Stack spacing={1}>
                        <Typography variant="caption">
                            ${(pricePerMinute / 100).toFixed(4)} per minute
                        </Typography>
                        <Typography variant="caption">
                            ${(parseFloat(pricePerHour) / 100).toFixed(2)} per hour
                        </Typography>
                    </Stack>
                )}
            </Grid>
        </Grid >
    );
};

export default PPVPriceWidget;
