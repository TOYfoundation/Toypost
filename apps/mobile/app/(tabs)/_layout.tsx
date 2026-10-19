import { useWindowDimensions } from 'react-native';
import { Tabs } from 'expo-router';
import { TabBar, type TabKey } from '../../src/components/TabBar.tsx';
import { WIDE_BREAKPOINT } from '../../src/theme.ts';

export default function TabsLayout() {
  const { width } = useWindowDimensions();
  const wide = width >= WIDE_BREAKPOINT;
  return (
    <Tabs
      screenOptions={{ headerShown: false, tabBarPosition: wide ? 'left' : 'bottom' }}
      tabBar={(props) => (
        <TabBar
          vertical={wide}
          active={props.state.routes[props.state.index].name as TabKey}
          onSelect={(key) => props.navigation.navigate(key)}
        />
      )}
    >
      <Tabs.Screen name="index" options={{ title: 'Heute' }} />
      <Tabs.Screen name="vorgaenge" options={{ title: 'Vorgänge' }} />
      <Tabs.Screen name="scannen" options={{ title: 'Erfassen' }} />
      <Tabs.Screen name="posteingang" options={{ title: 'Posteingang' }} />
      <Tabs.Screen name="konto" options={{ title: 'Konto' }} />
    </Tabs>
  );
}
