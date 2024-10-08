import React from 'react';
import { Box, Paper, Avatar, Tooltip } from '@mui/material';
import moment from 'moment';
import MathMarkdown from './MathMarkdown';

interface MessageBubbleProps {
    isCurrentUser: boolean;
    senderName: string;
    senderId: string;
    content: string;
    timestamp: Date;
    showAvatar: boolean;
}

const MessageBubble: React.FC<MessageBubbleProps> = ({
    isCurrentUser,
    senderName,
    senderId,
    content,
    timestamp,
    showAvatar,
}) => {
    return (
        <Box
            component="div"
            sx={{
                display: 'flex',
                // justifyContent: isCurrentUser ? 'flex-end' : 'flex-start',
                justifyContent: isCurrentUser ? 'space-between' : 'flex-start',
                mb: 1,
                ml: 1,
                mr: 1,
                alignItems: 'flex-end', // Aligns avatar with the bottom of the bubble
            }}
        >
            {!isCurrentUser && (
                <Box component="div" sx={{
                    mr: {
                        xs: 1, md: 2
                    },
                    display: 'flex',
                    alignItems: 'flex-end', // Aligns avatar with the bottom of the bubble
                }}>
                    <Tooltip title={`${senderName} - ${moment(timestamp).fromNow()}`}>
                        <Avatar
                            variant="rounded"
                            sx={{
                                width: 30,
                                height: 30,
                                backgroundColor: 'secondary.light',
                                color: 'secondary.contrastText',
                                opacity: showAvatar ? 0.65 : 0.15,
                            }}
                        >
                            {senderName.slice(0, 1)}
                        </Avatar>
                    </Tooltip>
                </Box>
            )}

            {isCurrentUser && (
                <Box component="div" sx={{
                    mr: {
                        xs: 1, md: 2
                    },
                    display: 'flex',
                    alignItems: 'flex-end', // Aligns avatar with the bottom of the bubble
                }}>
                    <Tooltip title={`${senderName} - ${moment(timestamp).fromNow()}`}>
                        <Avatar
                            variant="rounded"
                            sx={{
                                width: 30,
                                height: 30,
                                backgroundColor: 'primary.light',
                                color: 'primary.contrastText',
                                opacity: showAvatar ? 0.55 : 0.15,
                            }}
                        >
                        </Avatar>
                    </Tooltip>
                </Box>
            )}
            <Paper
                component="div"
                elevation={isCurrentUser ? 1 : 3}
                sx={{
                    maxWidth: {
                        xs: '75%',
                        sm: '70%',
                        md: '65%',
                        lg: '60%',
                        xl: '55%',
                    },
                    minWidth: {
                        xs: '0%',
                        // sm: '0%',
                        // md: '15%',
                        // lg: '10%',
                        // xl: '5%',
                    },
                    padding: {
                        xs: "0.125em 1em",
                        sm: "0.2em 1.1em",
                        md: "0.3em 1.2em",
                        // lg: "0.75em 1.5em",
                        // xl: "1em 1.5em",
                    },
                    borderRadius: 2,
                    // backgroundColor: isCurrentUser ? 'disabled.light' : 'paper.light',
                }}
            >
                <MathMarkdown content={content}></MathMarkdown>
            </Paper>


        </Box>
    );
};

export default MessageBubble;
