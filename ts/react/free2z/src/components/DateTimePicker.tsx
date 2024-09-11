import { Moment } from 'moment';
import { AdapterMoment } from '@mui/x-date-pickers/AdapterMoment'
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { DateTimePicker } from '@mui/x-date-pickers/DateTimePicker';
import { IconButton, InputAdornment } from '@mui/material';
import { Clear } from '@mui/icons-material';


type DTProps = {
    value: Moment | null,
    setValue: (value: Moment | null) => void,
}

export default function F2ZDateTimePicker(props: DTProps) {
    const { value, setValue } = props

    return (
        <LocalizationProvider
            dateAdapter={AdapterMoment}
        >
            <DateTimePicker
                value={value}
                onChange={setValue}
                // TODO: parameters if we want to resuse this
                label="Publish in the future"
                slotProps={{
                    textField: {
                        helperText: 'Choose a time to publish',
                        fullWidth: true,
                        InputProps: {
                            startAdornment: value && (
                                <InputAdornment position="start"
                                    style={{
                                        marginRight: "1em",
                                    }}
                                >
                                    <IconButton
                                        edge="end"
                                        color="inherit"
                                        onClick={() => setValue(null)}
                                        aria-label="clear date time picker"
                                    >
                                        <Clear />
                                    </IconButton>
                                </InputAdornment>
                            )
                        }
                    },
                }}
                disablePast
                minutesStep={5}
                // onError={ }
                formatDensity='spacious'
            />
        </LocalizationProvider>
    );
}
