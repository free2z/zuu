import 'react-native-gesture-handler';
import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createStackNavigator, StackHeaderProps } from '@react-navigation/stack';

import { View, Text, Button, StyleSheet } from 'react-native';
import { Appbar, Menu, Provider as PaperProvider } from 'react-native-paper';


function HomeScreen({ navigation }) {
  return (
    <View style={style.container}>
      <Text>Home Screen</Text>
      <Button
        title="Go to details"
        onPress={() => navigation.navigate('Details')}
      />
    </View>
  );
}

function DetailsScreen() {
  return (
    <View style={style.container}>
      <Text>Details ScreenF</Text>
    </View>
  );
}

const style = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

function CustomNavigationBar(props: StackHeaderProps) {
  const { back, navigation } = props
  const [visible, setVisible] = React.useState(false);
  const openMenu = () => setVisible(true);
  const closeMenu = () => setVisible(false);

  return (
    <Appbar.Header>
      {/* {back ? <Appbar.BackAction onPress={navigation.goBack} /> : null} */}
      <Appbar.Content title="ZUULI" />
      <Menu
        visible={visible}
        onDismiss={closeMenu}
        anchor={
          <Appbar.Action icon="menu" color="black" onPress={openMenu} />
        }>
        <Menu.Item onPress={() => { console.log('Option 1 was pressed') }} title="Option 1" />
        <Menu.Item onPress={() => { console.log('Option 2 was pressed') }} title="Option 2" />
        <Menu.Item onPress={() => { console.log('Option 3 was pressed') }} title="Option 3" disabled />
      </Menu>
    </Appbar.Header>
  );
}


const Stack = createStackNavigator();

export default function App() {
  return (
    <PaperProvider>
      <NavigationContainer>
        <Stack.Navigator
          initialRouteName="Home"
          screenOptions={{
            header: (props) => <CustomNavigationBar {...props} />,
          }}>
          <Stack.Screen name="Home" component={HomeScreen} />
          <Stack.Screen name="Details" component={DetailsScreen} />
        </Stack.Navigator>
      </NavigationContainer>
    </PaperProvider>
  );
}