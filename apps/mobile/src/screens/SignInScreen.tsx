import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Button, Card, Field, Notice, Screen } from '../components/base.tsx';
import { DeadlineStamp } from '../components/case.tsx';
import { API_URL, useSession } from '../session.tsx';
import { space, type, useStyles, type Palette } from '../theme.ts';
import { addDays, todayIso } from '@toypost/shared';

const styles = (p: Palette) =>
  StyleSheet.create({
    hero: { flexDirection: 'row', alignItems: 'center', gap: space.lg, marginTop: space.xxl, marginBottom: space.xl },
    brand: { ...type.display, color: p.ink },
    claim: { ...type.body, color: p.inkSoft },
    or: { ...type.small, color: p.inkMuted, textAlign: 'center', marginVertical: space.lg },
    server: { ...type.caption, color: p.inkMuted, marginTop: space.lg },
  });

export function SignInScreen() {
  const s = useStyles(styles);
  const { signIn, register, startDemo } = useSession();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const today = todayIso();

  const submit = async () => {
    if (!email.includes('@')) return setError('Bitte gib deine E-Mail-Adresse ein.');
    if (mode === 'register' && name.trim().length < 2) return setError('Bitte gib deinen Namen ein.');
    if (password.length < (mode === 'register' ? 10 : 1)) return setError(mode === 'register' ? 'Das Passwort braucht mindestens 10 Zeichen.' : 'Bitte gib dein Passwort ein.');
    setBusy(true);
    setError(null);
    try {
      if (mode === 'login') await signIn(email.trim(), password);
      else await register(name.trim(), email.trim(), password);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <View style={s.hero}>
        <DeadlineStamp deadline={{ date: addDays(today, 3), kind: 'zahlung', phrase: '', explanation: '' }} today={today} size={72} />
        <View style={{ flex: 1 }}>
          <Text accessibilityRole="header" style={s.brand}>
            ToyPost
          </Text>
          <Text style={s.claim}>Deine Post, sortiert, mit Frist und fertiger Antwort.</Text>
        </View>
      </View>
      <Card>
        <View style={{ gap: space.md }}>
          {mode === 'register' ? <Field label="Name" value={name} onChangeText={setName} autoComplete="name" /> : null}
          <Field label="E-Mail" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" autoComplete="email" />
          <Field
            label="Passwort"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            hint={mode === 'register' ? 'Mindestens 10 Zeichen.' : undefined}
            onSubmitEditing={submit}
          />
          {error ? <Notice tone="error">{error}</Notice> : null}
          <Button label={mode === 'login' ? 'Anmelden' : 'Konto anlegen'} busy={busy} onPress={submit} />
          <Button
            variant="quiet"
            label={mode === 'login' ? 'Neu hier? Konto anlegen' : 'Schon ein Konto? Anmelden'}
            onPress={() => {
              setMode(mode === 'login' ? 'register' : 'login');
              setError(null);
            }}
          />
        </View>
      </Card>
      <Text style={s.or}>oder</Text>
      <Button variant="secondary" icon="eye" label="Mit Beispiel-Post ausprobieren" onPress={startDemo} />
      <Text style={s.server}>Server: {API_URL}</Text>
    </Screen>
  );
}
