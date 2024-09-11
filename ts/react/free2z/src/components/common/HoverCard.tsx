import { styled } from '@mui/material/styles';
import { Card, CardProps } from '@mui/material';

const StyledCard = styled(Card)(({ theme }) => ({
    transition: 'background-color 0.3s',
    '&:hover': {
        backgroundColor: theme.palette.action.hover,
    },
}));

const HoverCard: React.FC<CardProps> = (props) => {
    return <StyledCard {...props}
        style={{
            width: '90%',
            maxWidth: '400px',
            minHeight: 220,
            position: 'relative',
            marginLeft: 'auto',
            marginRight: 'auto',
            cursor: 'pointer',
            marginBottom: '0.5em',
        }}

    />;
};

export default HoverCard;
