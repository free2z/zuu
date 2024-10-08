import React, { useLayoutEffect, useRef, useState } from 'react';
import { Box, List, Fab, Badge } from '@mui/material';
import MessageBubble from './DKGMessageBubble';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import { State } from '../lib/webrtc-state';

interface DKGMessagesProps {
    state: State;
}

const DKGMessages: React.FC<DKGMessagesProps> = ({ state }) => {
    const [newMessagesCount, setNewMessagesCount] = useState(0);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const secondLastMessageRef = useRef<HTMLDivElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    const scrollToBottom = () => {
        if (messagesEndRef.current) {
            messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
            setNewMessagesCount(0); // Clear new messages count after scrolling
        }
    };

    const handleScroll = () => {
        if (containerRef.current) {
            const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
            const isAtBottom = scrollHeight - scrollTop <= clientHeight + 30;
            if (isAtBottom) {
                setNewMessagesCount(0); // User is at the bottom, clear new messages count
            }
        }
    };

    useLayoutEffect(() => {
        if (containerRef.current && secondLastMessageRef.current) {
            const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
            const secondLastMessageTop = secondLastMessageRef.current.offsetTop;
            const isSecondLastMessageVisible = secondLastMessageTop - scrollTop < clientHeight;

            if (isSecondLastMessageVisible) {
                // Automatically scroll to bottom if the second-to-last message is in view
                scrollToBottom();
            } else {
                setNewMessagesCount((prev) => prev + 1); // Increment new messages count
            }
        }
    }, [state.messages]);

    return (
        <Box
            ref={containerRef}
            component="div"
            sx={{
                overflowY: 'auto',
                height: '100%',
                position: 'relative',
                // padding: 2,
                // Hide scroll bar while allowing scrolling
                '&::-webkit-scrollbar': { display: 'none' },
                msOverflowStyle: 'none',
                scrollbarWidth: 'none',
            }}
            onScroll={handleScroll}
        >
            <List>
                {state.messages.map((message, index) => (
                    <React.Fragment key={index}>
                        {index === state.messages.length - 2 && (
                            <div ref={secondLastMessageRef} />
                        )}
                        <MessageBubble
                            isCurrentUser={message.sender.uuid === state.participant_uuid}
                            senderName={message.sender.name}
                            senderId={message.sender.uuid}
                            content={message.content}
                            timestamp={message.timestamp}
                            // showAvatar={index === 0 || message.sender.number !== state.messages[index - 1].sender.number}
                            // show the avatar if the next message is not from the same sender
                            showAvatar={index === state.messages.length - 1 || message.sender.uuid !== state.messages[index + 1].sender.uuid}
                        />
                    </React.Fragment>
                ))}
                <div ref={messagesEndRef} />
            </List>
            {newMessagesCount > 0 && (
                <Fab
                    color="primary"
                    size="small"
                    sx={{
                        position: 'fixed',
                        bottom: 90,  // Distance from the bottom of the screen
                        left: '50%',  // Position it at the center horizontally
                        transform: 'translateX(-50%)',  // Adjust for the button's own width
                        margin: 1,
                    }}
                    onClick={scrollToBottom}
                >
                    <Badge badgeContent={newMessagesCount} color="error">
                        <ArrowDownwardIcon />
                    </Badge>
                </Fab>
            )}
        </Box>
    );
};

export default DKGMessages;
