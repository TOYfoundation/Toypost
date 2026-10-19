import { ActivityIndicator, View } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import {
  useFonts,
  SchibstedGrotesk_400Regular,
  SchibstedGrotesk_500Medium,
  SchibstedGrotesk_700Bold,
} from '@expo-google-fonts/schibsted-grotesk';
import { SessionProvider, useSession } from '../src/session.tsx';
import { SignInScreen } from '../src/screens/SignInScreen.tsx';
import { usePalette } from '../src/theme.ts';

function Gate() {
  const { status } = useSession();
  const p = usePalette();
  if (status === 'loading') {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: p.paper }}>
        <ActivityIndicator color={p.stamp} />
      </View>
    );
  }
  if (status === 'signedOut') return <SignInScreen />;
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: p.paper } }} />;
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts({ SchibstedGrotesk_400Regular, SchibstedGrotesk_500Medium, SchibstedGrotesk_700Bold });
  if (!fontsLoaded) return null;
  return (
    <SafeAreaProvider>
      <SessionProvider>
        <StatusBar style="auto" />
        <Gate />
      </SessionProvider>
    </SafeAreaProvider>
  );
}
