import React, { useEffect } from 'react';
import {
    Button, Box, ToggleButton, ToggleButtonGroup,
    Typography, Container, Stack, CircularProgress
} from '@mui/material';
import { styled } from '@mui/material/styles';
import axios from 'axios';
import { useQuery, useMutation, useQueryClient } from 'react-query';
import { KYCAction, KYCState } from './KYCPage';
import KYCCircularProgress from './KYCCircularProgress';

const CustomToggleButton = styled(ToggleButton)(({ theme }) => ({
    width: '100%',
    '&.Mui-selected, &.Mui-selected:hover': {
        color: theme.palette.getContrastText(theme.palette.primary.main),
        backgroundColor: theme.palette.primary.main,
    },
}));

type KYCBasicInfoStepProps = {
    state: KYCState;
    dispatch: React.Dispatch<KYCAction>;
};

const KYCBasicInfoStep = ({ state, dispatch }: KYCBasicInfoStepProps) => {
    const [isSubmitting, setIsSubmitting] = React.useState(false);

    const queryClient = useQueryClient();

    const { data: userData, isLoading, isError } = useQuery(
        'userInfo', () => axios.get('/api/kyc/user-profile'), {
        staleTime: 0,
        cacheTime: 0,
    });

    useEffect(() => {
        if (userData && userData.data) {
            dispatch({ type: 'SET_IS_US', payload: userData.data.is_us });
            dispatch({ type: 'SET_IS_INDIVIDUAL', payload: userData.data.is_individual });
        }
    }, [userData, dispatch]);

    const handleIsUSChange = (_event: React.MouseEvent<HTMLElement>, newIsUs: string) => {
        dispatch({ type: 'SET_IS_US', payload: newIsUs === 'US' });
    };

    const handleIsIndividualChange = (_event: React.MouseEvent<HTMLElement>, newIsIndividual: string) => {
        dispatch({ type: 'SET_IS_INDIVIDUAL', payload: newIsIndividual === 'individual' });
    };

    const handleSubmit = () => {
        setIsSubmitting(true);
        const newUserInfo = {
            is_us: state.is_us,
            is_individual: state.is_individual,
        };
        mutation.mutate(newUserInfo, {
            onSuccess: () => {
                dispatch({ type: 'NEXT_STEP' });
                setIsSubmitting(false);
                // HRM.
                queryClient.invalidateQueries('initialTaxForm');
                // dispatch({ type: 'SET_TAX_FORM_FILE_URL', payload: null });
            },
        });
    };

    const mutation = useMutation((newUserInfo: any) => {
        return axios.post('/api/kyc/user-profile', newUserInfo);
    });

    if (isLoading) {
        return <KYCCircularProgress />
    }

    if (isError) {
        return <div>Error</div>;
    }

    return (
        <Container>
            <Box component="div" sx={{ display: 'flex', justifyContent: 'center', mt: 2, mb: 5 }}>
                <Stack spacing={3}>
                    <Box component="div" sx={{ m: 2 }}>
                        <Typography>Are you a US citizen?</Typography>
                        <ToggleButtonGroup
                            color="primary"
                            // value={state.is_us ? 'US' : 'non-US'}
                            value={state.is_us === null ? '' : (state.is_us ? 'US' : 'non-US')}
                            exclusive
                            onChange={handleIsUSChange}
                            fullWidth
                            sx={{ mt: 1 }}
                        >
                            <CustomToggleButton value="US">US</CustomToggleButton>
                            <CustomToggleButton value="non-US">Non-US</CustomToggleButton>
                        </ToggleButtonGroup>
                    </Box>

                    <Box component="div" sx={{ m: 2 }}>
                        <Typography>Are you an individual or an entity?</Typography>
                        <ToggleButtonGroup
                            color="primary"
                            // value={state.is_individual ? 'individual' : 'entity'}
                            value={state.is_individual === null ? '' : (state.is_individual ? 'individual' : 'entity')}
                            exclusive
                            onChange={handleIsIndividualChange}
                            fullWidth
                            sx={{ mt: 1 }}
                        >
                            <CustomToggleButton value="individual">Individual</CustomToggleButton>
                            <CustomToggleButton value="entity">Entity</CustomToggleButton>
                        </ToggleButtonGroup>
                    </Box>
                </Stack>
            </Box>
            <Box component="div" sx={{ display: 'flex', justifyContent: 'space-between', mt: 3 }}>
                <Button variant="outlined" color="inherit"
                    onClick={() => {
                        dispatch({ type: 'PREVIOUS_STEP' })
                    }}
                >
                    Back
                </Button>
                <Button
                    variant="contained" color="primary" onClick={handleSubmit}
                    disabled={isSubmitting}
                    sx={{
                        minWidth: '80px',
                    }}
                >
                    {isSubmitting ? <CircularProgress size={24} /> : 'Next'}
                </Button>
            </Box>
        </Container>
    );
};

export default KYCBasicInfoStep;
