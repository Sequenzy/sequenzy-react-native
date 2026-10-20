import {
  InAppCard,
  Sequenzy,
  SequenzyInAppHost,
  useInAppCards,
} from "@sequenzy/react-native";
import * as Application from "expo-application";
import * as Notifications from "expo-notifications";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

const API_URL =
  process.env.EXPO_PUBLIC_SEQUENZY_API_URL ?? "https://api.sequenzy.com";
// Your backend: POST { email } returns { identityToken } minted with your
// secret API key (POST /api/v1/web-tracking-identities). Never ship the
// secret key in the app.
// A published Sequenzy form: its lists and opt-in settings apply.
const NEWSLETTER_FORM_ID =
  process.env.EXPO_PUBLIC_SEQUENZY_NEWSLETTER_FORM_ID ?? "replace-me";
const TOKEN_URL =
  process.env.EXPO_PUBLIC_IDENTITY_TOKEN_URL ??
  "http://localhost:8787/identity-token";

Sequenzy.configure({
  publicKey: process.env.EXPO_PUBLIC_SEQUENZY_PUBLIC_KEY ?? "seq_pk_replace_me",
  companyId: process.env.EXPO_PUBLIC_SEQUENZY_COMPANY_ID ?? "replace-me",
  appId: Application.applicationId ?? "com.sequenzy.example",
  platform:
    Platform.OS === "ios" || Platform.OS === "android" ? Platform.OS : "web",
  apiBaseUrl: API_URL,
  logLevel: "debug",
  identityTokenProvider: async (email) => {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const { identityToken } = (await response.json()) as {
      identityToken: string;
    };
    return identityToken;
  },
});

async function registerForPush() {
  if (Platform.OS === "web") return;
  const { status } = await Notifications.requestPermissionsAsync();
  if (status !== "granted") return;
  // The native APNs/FCM token, not the Expo push token.
  const { data } = await Notifications.getDevicePushTokenAsync();
  await Sequenzy.setPushToken(String(data));
}

export default function App() {
  const [email, setEmail] = useState("");
  const [signedIn, setSignedIn] = useState<string | null>(null);
  const [status, setStatus] = useState("Not signed in");

  useEffect(() => {
    void registerForPush();
    if (Platform.OS === "web") return;
    const tap = Notifications.addNotificationResponseReceivedListener(
      (response) => {
        void Sequenzy.handleNotificationResponse(
          response.notification.request.content.data
        );
      }
    );
    const received = Notifications.addNotificationReceivedListener(
      (notification) => {
        void Sequenzy.handleNotificationReceived(
          notification.request.content.data
        );
      }
    );
    return () => {
      tap.remove();
      received.remove();
    };
  }, []);

  return (
    <View style={styles.app}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={styles.screen}>
        <Text style={styles.heading}>Sequenzy example</Text>
        {signedIn ? (
          <>
            <Text style={styles.muted}>Signed in as {signedIn}</Text>
            <Button
              label="Log a workout"
              onPress={async () => {
                await Sequenzy.track("workout_completed", {
                  count: 3,
                  source: "react-native-example",
                });
                setStatus("Tracked workout_completed");
              }}
            />
            <Button
              label="Open pricing"
              secondary
              onPress={async () => {
                await Sequenzy.screen("Pricing", { from: "home" });
                await Sequenzy.viewedProduct({
                  providerProductId: "plan-annual",
                  title: "Annual plan",
                  price: 99,
                  currency: "USD",
                });
                setStatus("Sent a screen view and a product view");
              }}
            />
            <Button
              label="Set goal: strength"
              secondary
              onPress={async () => {
                await Sequenzy.setProfile({
                  firstName: "Jane",
                  attributes: { goal: "strength" },
                });
                setStatus("Updated the profile");
              }}
            />
            <Button
              label="Sign out"
              secondary
              onPress={async () => {
                await Sequenzy.reset();
                setSignedIn(null);
                setStatus("Signed out");
              }}
            />
            <Cards />
          </>
        ) : (
          <>
            <TextInput
              accessibilityLabel="Email"
              autoCapitalize="none"
              keyboardType="email-address"
              placeholder="you@example.com"
              value={email}
              onChangeText={setEmail}
              style={styles.input}
            />
            <Button
              label="Sign in"
              onPress={async () => {
                const identified = await Sequenzy.identify(email);
                setSignedIn(identified ? email.trim().toLowerCase() : null);
                setStatus(identified ? "Signed in" : "Enter a valid email");
              }}
            />
            <Button
              label="Join the newsletter"
              secondary
              onPress={async () => {
                const result = await Sequenzy.subscribe({
                  formId: NEWSLETTER_FORM_ID,
                  email,
                });
                setStatus(result.ok ? "Subscribed" : result.error);
              }}
            />
          </>
        )}
        <Text style={styles.muted}>{status}</Text>
      </ScrollView>
      <SequenzyInAppHost />
    </View>
  );
}

function Cards() {
  const { cards, loading, error, dismiss, markRead } = useInAppCards();
  useEffect(() => {
    cards.forEach(markRead);
  }, [cards, markRead]);
  if (loading) return <Text style={styles.muted}>Loading cards…</Text>;
  if (error)
    return (
      <Text style={styles.muted}>Could not load cards: {error.message}</Text>
    );
  return (
    <View style={styles.cards}>
      <Text style={styles.subheading}>Inbox</Text>
      {cards.length === 0 ? (
        <Text style={styles.muted}>No cards yet</Text>
      ) : null}
      {cards.map((card) => (
        <InAppCard key={card.id} card={card} onDismiss={dismiss} />
      ))}
    </View>
  );
}

function Button({
  label,
  onPress,
  secondary,
}: {
  label: string;
  onPress: () => void;
  secondary?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={[styles.button, secondary ? styles.buttonSecondary : null]}
    >
      <Text
        style={[
          styles.buttonLabel,
          secondary ? styles.buttonLabelSecondary : null,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  app: { flex: 1, backgroundColor: "#f8fafc" },
  screen: {
    padding: 24,
    gap: 12,
    maxWidth: 520,
    width: "100%",
    alignSelf: "center",
  },
  heading: { fontSize: 26, fontWeight: "700", color: "#0f172a", marginTop: 24 },
  subheading: { fontSize: 18, fontWeight: "600", color: "#0f172a" },
  muted: { color: "#64748b" },
  input: {
    borderWidth: 1,
    borderColor: "#cbd5e1",
    borderRadius: 10,
    padding: 12,
    backgroundColor: "#fff",
  },
  button: {
    backgroundColor: "#0f172a",
    borderRadius: 10,
    padding: 14,
    alignItems: "center",
  },
  buttonSecondary: {
    backgroundColor: "transparent",
    borderWidth: 1,
    borderColor: "#cbd5e1",
  },
  buttonLabel: { color: "#fff", fontWeight: "600" },
  buttonLabelSecondary: { color: "#0f172a" },
  cards: { gap: 12, marginTop: 12 },
});
