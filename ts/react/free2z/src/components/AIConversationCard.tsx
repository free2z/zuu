import { Avatar, Card, CardContent, CardHeader, useTheme } from '@mui/material';
import { AIConversation } from './AIConversationListDrawer';
import { useTransitionNavigate } from '../hooks/useTransitionNavigate';
import moment from 'moment';

type AIConversationCardProps = {
    conversation: AIConversation;
};

export default function AIConversationCard(props: AIConversationCardProps) {
    const { conversation } = props;
    const transitionNavigate = useTransitionNavigate();

    // Navigate to AI conversation detail
    const handleCardClick = () => {
        transitionNavigate(`/ai/conversation/${conversation.id}`);
    };

    // Navigate to user profile
    const handleAvatarClick = (event: React.MouseEvent) => {
        event.stopPropagation(); // Prevent card click event from being triggered
        transitionNavigate(`/${conversation.user.username}`);
    };


    const theme = useTheme();
    const isDarkMode = theme.palette.mode === 'dark';

    const cardStyles = {
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        height: 'auto',
        width: '100%',
        p: 1,
        marginTop: 1,
        borderRadius: 1,
        boxShadow: '0px 2px 4px rgba(0, 0, 0, 0.15)',
        transition: 'all 0.2s ease-in-out',
        cursor: 'pointer',
        '&:hover': {
            boxShadow: isDarkMode
                ? '1px 2px 6px rgba(255, 255, 255, 0.5)'
                : '1px 2px 4px rgba(0, 0, 0, 0.5)',
            transform: 'scale(1.0033)'
        },
        backgroundColor: isDarkMode ? 'rgba(255, 255, 255, 0.1)' : 'default'
    };

    const avatarUrl = conversation.user.avatar_image?.thumbnail || "/docs/img/2Z-Logo.svg";
    const formattedDate = moment(conversation.updated_at).fromNow();


    return (
        <Card
            onClick={handleCardClick}
            sx={cardStyles}
        >
            <CardHeader
                avatar={
                    <Avatar
                        src={avatarUrl}
                        onClick={handleAvatarClick}
                        sx={{ cursor: 'pointer' }}
                    />
                }
                title={conversation.display_name}
                subheader={formattedDate}
            />
        </Card>
    )
}