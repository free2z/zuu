import { Box, Container } from '@mui/material';
import { ReactNode } from 'react';

export const ProfileContainer = ({ children, ...props }: { children: ReactNode }) => (
  <Container
    sx={{
      position: 'relative',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      px: 0,
      gap: { xs: 3, sm: 6 },
    }}
  >
    {children}
  </Container>
);

export const ProfileContainerInner = ({ children, sx, ...props }: { children: ReactNode, sx?: any }) => (
  <Box
    component="div"
    sx={{
      width: '100%',
      maxWidth: { sm: 840, lg: 1040 },
      px: { xs: '16px', sm: '0px' },
      textAlign: { sm: 'left' },
      ...sx,
    }}
    {...props}
  >
    {children}
  </Box>
);

export const ProfileBody = ({ children, ...props }: { children: ReactNode, sx?: any }) => (
  <ProfileContainer>
    <ProfileContainerInner {...props}>
      {children}
    </ProfileContainerInner>
  </ProfileContainer>
);
