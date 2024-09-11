import Fab from '@mui/material/Fab';
import AddIcon from '@mui/icons-material/Add';

import { useTransitionNavigate } from '../hooks/useTransitionNavigate';


export default function FABNewAI() {
    const navigate = useTransitionNavigate()

    return (
        <>
            <Fab
                color="primary"
                aria-label="add"
                onClick={() => navigate("/ai")}
                style={{
                    position: "fixed",
                    right: "7%",
                    // top: "8%",
                    bottom: "5%",
                    opacity: 0.9,
                }}

            >
                <AddIcon />
            </Fab>
        </>
    );
}
