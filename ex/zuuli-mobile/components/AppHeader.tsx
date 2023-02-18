import React, { useState } from 'react';
import { Appbar, Drawer } from 'react-native-paper';

interface AppHeaderProps {
    title: string;
}

const AppHeader: React.FC<AppHeaderProps> = ({ title }) => {
    const [drawerOpen, setDrawerOpen] = useState(false);

    const toggleDrawer = () => {
        setDrawerOpen(!drawerOpen);
    };

    return (
        <>
            <Appbar.Header>
                <Appbar.Action icon="menu" onPress={toggleDrawer} />
                <Appbar.Content title={title} />
            </Appbar.Header>
            <Drawer.Section title="Menu">
                <Drawer.Item
                    label="Item 1"
                    onPress={() => console.log('Item 1 pressed')}
                />
                <Drawer.Item
                    label="Item 2"
                    onPress={() => console.log('Item 2 pressed')}
                />
            </Drawer.Section>
            <Drawer
                visible={drawerOpen}
                onDismiss={() => setDrawerOpen(false)}
                drawerContent={() => (
                    <Drawer.Section title="Menu">
                        <Drawer.Item
                            label="Item 1"
                            onPress={() => console.log('Item 1 pressed')}
                        />
                        <Drawer.Item
                            label="Item 2"
                            onPress={() => console.log('Item 2 pressed')}
                        />
                    </Drawer.Section>
                )}
            />
        </>
    );
};

export default AppHeader;
